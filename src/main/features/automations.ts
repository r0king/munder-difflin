/**
 * Automations — main-process side (owned by the `wsAutomations` unit).
 *
 * The Automations screen is a view over storage that already exists, and most
 * of it needs nothing new here: schedules are config.missions (missions:list /
 * missions:save, re-armed by syncMissions), the auto-compact / auto-clear
 * context rules are config.contextTrigger (triggers:getContext / :setContext),
 * webhooks are config.webhookTriggers (webhooks:*) with their deliveries in the
 * trigger-history ledger (triggerHistory:*). The screen calls those directly so
 * Classic and Workspace read and write the very same records.
 *
 * What this module adds is the one thing Classic never had: HOUSE RULES, the
 * texts every agent reads before it starts (shared/workspace/automationsRules).
 * They live in this unit's settings file (`<userData>/features/automations/
 * settings.json`), and reach the agents through `withContextRules`, which
 * index.ts wraps around the standing-goal reader it hands the hook server.
 *
 * Channels (invoke):  feat:automations:listRules → HouseRule[]
 *                     feat:automations:saveRule  (HouseRule) → RulesResult
 *                     feat:automations:deleteRule (id) → RulesResult
 * Channel (push):     feat:automations:rules (HouseRule[]) to every app window
 */
import { ipcMain } from 'electron';
import type { FeatureContext, FeatureModule } from './types';
import {
  HOUSE_RULES_MAX,
  isHouseRuleId,
  sanitizeHouseRule,
  sanitizeHouseRules,
  withHouseRules,
  type HouseRule
} from '../../shared/workspace/automationsRules';

const NAME = 'automations';

export const AUTOMATIONS_CHANNELS = {
  listRules: 'feat:automations:listRules',
  saveRule: 'feat:automations:saveRule',
  deleteRule: 'feat:automations:deleteRule',
  rules: 'feat:automations:rules'
} as const;

interface AutomationsSettings {
  houseRules: HouseRule[];
}

const DEFAULTS: AutomationsSettings = { houseRules: [] };

export type RulesResult =
  | { ok: true; rules: HouseRule[] }
  | { ok: false; error: 'invalid' | 'full' | 'notFound' | 'writeFailed'; rules: HouseRule[] };

/**
 * The rules as last read or written. The hook server asks for them on every
 * SessionStart and UserPromptSubmit of every agent, so they are served from
 * memory rather than re-read from disk per prompt. This module is the file's
 * only writer, so the cache cannot go stale behind its back.
 */
let cache: HouseRule[] | null = null;
/** Set by register(). Held here rather than read through features/index.ts's
 *  featureContext(), which would make this module and that one import each other. */
let ctxRef: FeatureContext | null = null;

function load(ctx: FeatureContext): HouseRule[] {
  if (cache) return cache;
  const raw = ctx.readFeatureSettings<AutomationsSettings>(NAME, DEFAULTS);
  cache = sanitizeHouseRules(raw.houseRules, Date.now());
  return cache;
}

function persist(ctx: FeatureContext, rules: HouseRule[]): void {
  ctx.writeFeatureSettings<AutomationsSettings>(NAME, DEFAULTS, { houseRules: rules });
  cache = rules;
  // Every app window: a second floor's Automations screen repaints too.
  ctx.broadcast(AUTOMATIONS_CHANNELS.rules, rules);
}

/**
 * Upsert one rule. Per-rule rather than whole-list so two windows editing
 * DIFFERENT rules cannot overwrite each other with a stale copy. The stored
 * `createdAt` always wins (it orders the list and the injected text), and
 * `updatedAt` moves only when something the agents read actually changed.
 */
function saveRule(ctx: FeatureContext, raw: unknown): RulesResult {
  const current = load(ctx);
  const now = Date.now();
  const incoming = sanitizeHouseRule(raw, now);
  if (!incoming) return { ok: false, error: 'invalid', rules: current };
  const i = current.findIndex((r) => r.id === incoming.id);
  let next: HouseRule[];
  if (i >= 0) {
    const prev = current[i];
    const changed = prev.name !== incoming.name || prev.text !== incoming.text || prev.enabled !== incoming.enabled;
    if (!changed) return { ok: true, rules: current };
    next = current.slice();
    next[i] = { ...incoming, createdAt: prev.createdAt, updatedAt: now };
  } else {
    if (current.length >= HOUSE_RULES_MAX) return { ok: false, error: 'full', rules: current };
    next = [...current, { ...incoming, updatedAt: now }];
  }
  try {
    persist(ctx, next);
  } catch (e) {
    console.error('[automations] could not save house rules:', e instanceof Error ? e.message : e);
    return { ok: false, error: 'writeFailed', rules: current };
  }
  return { ok: true, rules: next };
}

function deleteRule(ctx: FeatureContext, id: unknown): RulesResult {
  const current = load(ctx);
  if (!isHouseRuleId(id)) return { ok: false, error: 'invalid', rules: current };
  if (!current.some((r) => r.id === id)) return { ok: false, error: 'notFound', rules: current };
  const next = current.filter((r) => r.id !== id);
  try {
    persist(ctx, next);
  } catch (e) {
    console.error('[automations] could not delete a house rule:', e instanceof Error ? e.message : e);
    return { ok: false, error: 'writeFailed', rules: current };
  }
  return { ok: true, rules: next };
}

/**
 * Fold the enabled house rules into an agent's standing goal. index.ts wraps
 * the hook server's goal reader with this, so the rules ride the exact channel
 * the goal does: delivered at SessionStart, and again on the agent's next prompt
 * whenever the combined text changes — which is what makes a rule "start the
 * moment you switch it on" for an agent that is already running, and what tells
 * it to stop when every rule is switched off.
 *
 * Before the feature layer registers (no context yet) the goal passes through
 * untouched; no agent session can start that early anyway.
 */
export function withContextRules(goal: string | null): string | null {
  const ctx = ctxRef;
  if (!ctx) return goal;
  try {
    return withHouseRules(goal, load(ctx));
  } catch (e) {
    // A broken settings file must never cost an agent its standing goal.
    console.error('[automations] house rules unavailable:', e instanceof Error ? e.message : e);
    return goal;
  }
}

export const automationsFeature: FeatureModule = {
  name: NAME,
  register(ctx) {
    ctxRef = ctx;
    load(ctx);
    ipcMain.handle(AUTOMATIONS_CHANNELS.listRules, () => load(ctx));
    ipcMain.handle(AUTOMATIONS_CHANNELS.saveRule, (_evt, rule: unknown) => saveRule(ctx, rule));
    ipcMain.handle(AUTOMATIONS_CHANNELS.deleteRule, (_evt, id: unknown) => deleteRule(ctx, id));
  },
  dispose() {
    // Hooks can still fire while the app tears down; with no context they fall
    // back to the bare goal instead of touching a disposed feature layer.
    ctxRef = null;
    cache = null;
  }
};
