/**
 * AUTOMATIONS — the pure half of the Workspace's Automations screen: schedules,
 * context rules and webhooks folded into ONE list.
 *
 * Nothing here owns storage. Every row is a view over a record the Classic UI
 * already reads and writes, so the two interfaces can never drift:
 *
 *   schedule  → config.missions            (main/config.ts ScheduledMission)
 *   context   → config.contextTrigger      (the auto-compact / auto-clear rules)
 *             + house rules                (./automationsRules.ts, the texts every
 *                                           agent reads before it starts)
 *   webhook   → config.webhookTriggers     (shared/triggers.ts WebhookTrigger)
 *             + the trigger-history ledger (deliveries, and the held ones)
 *
 * The screen's three pieces of non-trivial logic live here so node:test can
 * cover them without a DOM: the words for "when" (weekdays / a time / an
 * interval), the assembly and ordering of the list, and the blur-save decision.
 * Words themselves are NOT produced here — every phrase is a structured value
 * the renderer translates, so Chinese and Arabic get real sentences rather than
 * English fragments glued together.
 */
import { normalizeWeekly, formatMinute, nextWeeklyFireMs } from '../weeklySchedule';
import type { ContextTriggerConfig, TriggerHistoryEntry, TriggerMode, WebhookTrigger } from '../triggers';
import type { HouseRule } from './automationsRules';

/* ───────────────────────────────── records ──────────────────────────────── */

/** Mirrors `ScheduledMission` in src/main/config.ts (preload's copy predates
 *  `weekly`, so this module declares its own rather than importing either). */
export interface MissionRecord {
  id: string;
  label: string;
  intervalMs: number;
  weekly?: { days: number[]; minute: number };
  to: string;
  body: string;
  enabled: boolean;
  autoCompact?: boolean;
  lastFiredAt?: number;
  kind?: 'dispatch' | 'heartbeat' | 'compact';
  quietThresholdMs?: number;
}

export type AutomationKind = 'schedule' | 'context' | 'webhook';

/** What a row is a view of. */
export type AutomationRef =
  | { type: 'mission'; id: string }
  | { type: 'maintenance'; which: 'compact' | 'clear' }
  | { type: 'houseRule'; id: string }
  | { type: 'webhook'; id: string };

export interface AutomationItem {
  /** Stable identity across renders and saves (`schedule:<id>` …). */
  key: string;
  kind: AutomationKind;
  ref: AutomationRef;
  name: string;
  enabled: boolean;
  /** 0 for built-ins and records whose age is unknown — they sort first. */
  createdAt: number;
  /** Seeded by the app (ops standup, heartbeat, compact/clear) — can be
   *  switched and edited but not deleted, matching Classic. */
  builtIn: boolean;
  /** Webhooks: deliveries held for the operator's yes. 0 otherwise. */
  held: number;
}

/* ──────────────────────────────── the "when" ────────────────────────────── */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

export type IntervalUnit = 'minute' | 'hour' | 'day' | 'week';

export interface IntervalPhrase {
  unit: IntervalUnit;
  count: number;
}

/**
 * A structured "when", for the renderer to put into words.
 *
 *   weekly/everyDay  "Every day at 09:00"
 *   weekly/weekdays  "Weekdays at 09:00"
 *   weekly/weekends  "Weekends at 10:30"
 *   weekly/days      "Fridays at 17:00" (one day) · "Mon, Wed and Fri at 09:00"
 *   interval         "Every 2 hours"
 *   heartbeat        "When the floor goes quiet" (checked on `every`)
 *   unset            a schedule that can never fire (no days, no interval)
 */
export type WhenPhrase =
  | { kind: 'weekly'; set: 'everyDay' | 'weekdays' | 'weekends'; time: string }
  | { kind: 'weekly'; set: 'days'; days: number[]; time: string }
  | { kind: 'interval'; every: IntervalPhrase }
  | { kind: 'heartbeat'; every: IntervalPhrase }
  | { kind: 'unset' };

/** The largest whole unit that divides `ms` exactly, so a stored 90-minute
 *  interval reads "every 90 minutes", never a rounded "every 2 hours". Anything
 *  below a minute (a hand-edited config) rounds up to one minute. */
export function intervalPhrase(ms: number): IntervalPhrase | null {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  if (ms % WEEK === 0) return { unit: 'week', count: ms / WEEK };
  if (ms % DAY === 0) return { unit: 'day', count: ms / DAY };
  if (ms % HOUR === 0) return { unit: 'hour', count: ms / HOUR };
  return { unit: 'minute', count: Math.max(1, Math.round(ms / MINUTE)) };
}

/** The "when" of a schedule. A valid `weekly` replaces the interval, exactly
 *  as the scheduler in main reads it (heartbeats are never weekly there). */
export function describeWhen(m: Pick<MissionRecord, 'intervalMs' | 'weekly' | 'kind'>): WhenPhrase {
  if (m.kind === 'heartbeat') {
    const every = intervalPhrase(m.intervalMs);
    return every ? { kind: 'heartbeat', every } : { kind: 'unset' };
  }
  const w = normalizeWeekly(m.weekly);
  if (w) {
    const time = formatMinute(w.minute);
    const key = w.days.join(',');
    if (key === '0,1,2,3,4,5,6') return { kind: 'weekly', set: 'everyDay', time };
    if (key === '1,2,3,4,5') return { kind: 'weekly', set: 'weekdays', time };
    if (key === '0,6') return { kind: 'weekly', set: 'weekends', time };
    return { kind: 'weekly', set: 'days', days: w.days, time };
  }
  const every = intervalPhrase(m.intervalMs);
  return every ? { kind: 'interval', every } : { kind: 'unset' };
}

/**
 * When an ENABLED schedule will next run, or null when that is not knowable.
 *
 * Mirrors syncMissions in main: a weekly schedule runs on its next calendar slot;
 * an interval one `intervalMs` after it last ran — and as soon as it is armed
 * when it never has (main arms it with `lastFiredAt ?? 0`), which `now` stands
 * for here. The heartbeat's cadence adapts to the floor, so it has no single
 * next time to promise.
 */
export function nextRunAt(m: MissionRecord, now: number): number | null {
  if (!m.enabled || m.kind === 'heartbeat') return null;
  const w = normalizeWeekly(m.weekly);
  if (w) return nextWeeklyFireMs(w, now);
  if (!(m.intervalMs > 0)) return null;
  if (!m.lastFiredAt) return now;
  return Math.max(now, m.lastFiredAt + m.intervalMs);
}

/** The first non-empty line of a prompt, for a one-line row description. */
export function firstLine(text: string, max = 140): string {
  const line = text.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? '';
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/* ─────────────────────────────── list assembly ──────────────────────────── */

/** Missions minted by either UI are `m_<base36 ms>` (optionally `_<suffix>`),
 *  so their age is in the id. Anything else — the seeded ops standup and
 *  heartbeat — reads as 0 and sorts with the built-ins. */
export function missionCreatedAt(id: string, now: number = Date.now()): number {
  const m = /^m_([0-9a-z]+)(?:_[0-9a-z]+)?$/.exec(id);
  if (!m) return 0;
  const t = parseInt(m[1], 36);
  // 2020-01-01 … a day from now: outside that it is not a timestamp.
  return Number.isFinite(t) && t >= 1_577_836_800_000 && t <= now + DAY ? t : 0;
}

/** Built-in schedules the app seeds. Matches main/config.ts. */
const BUILT_IN_MISSIONS = new Set(['ops-standup', 'heartbeat']);

const KIND_ORDER: Record<AutomationKind, number> = { schedule: 0, context: 1, webhook: 2 };

export interface AutomationSources {
  missions: readonly MissionRecord[];
  contextTrigger: ContextTriggerConfig;
  houseRules: readonly HouseRule[];
  webhooks: readonly WebhookTrigger[];
  history: readonly TriggerHistoryEntry[];
}

/**
 * Fold every source into one list.
 *
 * ORDER IS STABLE BY AGE, never by state: built-ins first, then everything in the
 * order it was made, so a new automation lands at the bottom where the "New
 * automation" menu just put it. Sorting by on/off or by held deliveries would
 * move a row out from under the pointer the moment its switch is flipped or a
 * delivery arrives — held deliveries are surfaced in the screen header instead.
 * Ties break by kind; built-ins then keep their gathered order, anything else
 * goes by name.
 *
 * `compact-maintenance` (kind 'compact') is retired into the context trigger by
 * main on boot; if one survives in an old config it is not listed twice.
 */
export function assembleAutomations(src: AutomationSources, now: number = Date.now()): AutomationItem[] {
  const held = heldCountByWebhook(src.history);
  const items: AutomationItem[] = [];

  for (const m of src.missions) {
    if (!m || typeof m.id !== 'string' || m.kind === 'compact') continue;
    items.push({
      key: `schedule:${m.id}`,
      kind: 'schedule',
      ref: { type: 'mission', id: m.id },
      name: m.label,
      enabled: !!m.enabled,
      createdAt: missionCreatedAt(m.id, now),
      builtIn: BUILT_IN_MISSIONS.has(m.id),
      held: 0
    });
  }

  for (const which of ['compact', 'clear'] as const) {
    items.push({
      key: `context:${which}`,
      kind: 'context',
      ref: { type: 'maintenance', which },
      // Built-in rows are named by the renderer (translated); the key stands in.
      name: which,
      enabled: !!src.contextTrigger[which]?.enabled,
      createdAt: 0,
      builtIn: true,
      held: 0
    });
  }

  for (const r of src.houseRules) {
    items.push({
      key: `rule:${r.id}`,
      kind: 'context',
      ref: { type: 'houseRule', id: r.id },
      name: r.name,
      enabled: !!r.enabled,
      createdAt: r.createdAt || 0,
      builtIn: false,
      held: 0
    });
  }

  for (const w of src.webhooks) {
    items.push({
      key: `webhook:${w.id}`,
      kind: 'webhook',
      ref: { type: 'webhook', id: w.id },
      name: w.name,
      enabled: !!w.enabled,
      createdAt: w.createdAt || 0,
      builtIn: false,
      held: held.get(w.id) ?? 0
    });
  }

  // Built-ins (age 0) keep the order they were gathered in — config order for
  // the seeded schedules, then compact before clear — rather than an alphabet
  // that would put the off-by-default, destructive auto-clear first.
  const seq = new Map(items.map((item, i) => [item.key, i] as const));
  return items.sort((a, b) =>
    a.createdAt - b.createdAt
    || KIND_ORDER[a.kind] - KIND_ORDER[b.kind]
    || (a.createdAt === 0 ? (seq.get(a.key) ?? 0) - (seq.get(b.key) ?? 0) : 0)
    || a.name.localeCompare(b.name)
    || a.key.localeCompare(b.key));
}

export type AutomationFilter = 'all' | AutomationKind;

export function filterAutomations(items: readonly AutomationItem[], filter: AutomationFilter): AutomationItem[] {
  return filter === 'all' ? items.slice() : items.filter((i) => i.kind === filter);
}

/** The header's "N on". */
export function countOn(items: readonly AutomationItem[]): number {
  return items.reduce((n, i) => n + (i.enabled ? 1 : 0), 0);
}

export function countByKind(items: readonly AutomationItem[]): Record<AutomationKind, number> {
  const out: Record<AutomationKind, number> = { schedule: 0, context: 0, webhook: 0 };
  for (const i of items) out[i.kind] += 1;
  return out;
}

/* ──────────────────────────────── webhooks ──────────────────────────────── */

/** Held deliveries per webhook id. Only inbound rows can be held. */
export function heldCountByWebhook(history: readonly TriggerHistoryEntry[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of history) {
    if (e.source !== 'webhook' || e.direction !== 'inbound' || e.decision !== 'pending') continue;
    out.set(e.sourceId, (out.get(e.sourceId) ?? 0) + 1);
  }
  return out;
}

export interface WebhookDeliveries {
  /** Waiting for a yes — oldest first, because the oldest has waited longest. */
  held: TriggerHistoryEntry[];
  /** Everything else that came in, newest first, at most `limit`. */
  recent: TriggerHistoryEntry[];
  /** Total inbound for this endpoint, held included (for "N more"). */
  total: number;
}

/** What came in on one endpoint. Outbound rows (our replies) are not
 *  deliveries; the Inbox shows the conversation. */
export function webhookDeliveries(
  history: readonly TriggerHistoryEntry[],
  webhookId: string,
  limit = 5
): WebhookDeliveries {
  const inbound = history.filter((e) => e.source === 'webhook' && e.sourceId === webhookId && e.direction === 'inbound');
  const held = inbound.filter((e) => e.decision === 'pending').sort((a, b) => a.at - b.at);
  const recent = inbound.filter((e) => e.decision !== 'pending').sort((a, b) => b.at - a.at).slice(0, Math.max(0, limit));
  return { held, recent, total: inbound.length };
}

/** How much a webhook lets through without a human, as a phrase key. */
export function webhookGate(mode: TriggerMode): 'holdAll' | 'passAll' | 'holdWork' {
  return mode === 'allow-all' ? 'passAll' : mode === 'communication-only' ? 'holdWork' : 'holdAll';
}

/* ──────────────────────────────── schedules ─────────────────────────────── */

/** Replace one mission's fields, leaving every other mission untouched. An
 *  explicit `weekly: undefined` is kept as a key so the backend's spread-merge
 *  really clears a weekly schedule (switching back to an interval). */
export function patchMission(list: readonly MissionRecord[], id: string, fields: Partial<MissionRecord>): MissionRecord[] {
  return list.map((m) => (m.id === id ? { ...m, ...fields } : m));
}

export function removeMission(list: readonly MissionRecord[], id: string): MissionRecord[] {
  return list.filter((m) => m.id !== id);
}

/**
 * A new schedule, OFF. The row opens expanded for the operator to write the
 * prompt; switching it on is what arms it. An enabled mission with an empty
 * prompt would otherwise dispatch an empty request on the very next tick (main
 * arms a never-run interval mission immediately).
 *
 * The id is the shape Classic mints (`m_<base36 ms>`), suffixed only on a
 * same-millisecond collision.
 */
export function newMission(
  init: { label: string; to: string; body?: string; intervalMs?: number; weekly?: { days: number[]; minute: number } },
  existing: readonly MissionRecord[],
  now: number
): MissionRecord {
  const base = `m_${Math.max(0, Math.floor(now)).toString(36)}`;
  const ids = new Set(existing.map((m) => m.id));
  let id = base;
  for (let n = 2; ids.has(id); n++) id = `${base}_${n.toString(36)}`;
  return {
    id,
    label: init.label,
    intervalMs: init.intervalMs && init.intervalMs > 0 ? init.intervalMs : HOUR,
    ...(init.weekly ? { weekly: { days: [...init.weekly.days], minute: init.weekly.minute } } : {}),
    to: init.to,
    body: init.body ?? '',
    enabled: false
  };
}

/** Can this schedule be switched on? Names what is missing, for the inline
 *  message beside the switch. Heartbeats carry their own built-in prompt. */
export function missionBlocker(m: MissionRecord): 'noPrompt' | 'noWhen' | 'noTarget' | null {
  if (m.kind === 'heartbeat') return null;
  if (!m.body.trim()) return 'noPrompt';
  if (!m.to.trim()) return 'noTarget';
  const weekly = m.weekly !== undefined;
  if (weekly ? !normalizeWeekly(m.weekly) : !(m.intervalMs > 0)) return 'noWhen';
  return null;
}

/* ───────────────────────────── blur-save diffing ────────────────────────── */

export interface TextFieldRule {
  /** Empty after trimming is refused, and the stored value comes back. */
  required?: boolean;
  maxLength?: number;
  /** Single-line fields lose newlines (a paste into a name). */
  singleLine?: boolean;
}

export type BlurDecision =
  | { action: 'none' }
  | { action: 'save'; value: string }
  | { action: 'reject'; reason: 'required' | 'tooLong'; restore: string };

/** The value a field would store: trimmed, line endings unified, and on one
 *  line for single-line fields. */
export function normalizeFieldText(text: string, rule: TextFieldRule = {}): string {
  let v = text.replace(/\r\n?/g, '\n');
  if (rule.singleLine) v = v.replace(/[\n\t]+/g, ' ').replace(/ {2,}/g, ' ');
  return v.trim();
}

/**
 * What leaving a field should do.
 *
 * The point is to write ONLY when the meaning changed: tabbing through a row
 * must not fire a save per field (each mission save re-arms the scheduler), and
 * a trailing space is not an edit. A refused value never reaches disk — the
 * field snaps back to what is stored and says why, rather than persisting a
 * blank name the row would then have to render.
 */
export function blurDecision(stored: string, draft: string, rule: TextFieldRule = {}): BlurDecision {
  const value = normalizeFieldText(draft, rule);
  if (value === normalizeFieldText(stored, rule)) return { action: 'none' };
  if (rule.required && !value) return { action: 'reject', reason: 'required', restore: stored };
  if (rule.maxLength !== undefined && value.length > rule.maxLength) {
    return { action: 'reject', reason: 'tooLong', restore: stored };
  }
  return { action: 'save', value };
}

/** Field-level diff of two records: the keys whose values differ (deep for
 *  plain arrays/objects, via JSON — every value here is JSON data). */
export function changedKeys<T extends object>(before: T, after: T): (keyof T)[] {
  const keys = new Set<keyof T>([...Object.keys(before), ...Object.keys(after)] as (keyof T)[]);
  const out: (keyof T)[] = [];
  for (const k of keys) {
    if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) out.push(k);
  }
  return out;
}
