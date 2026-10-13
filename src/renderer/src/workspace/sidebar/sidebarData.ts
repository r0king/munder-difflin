/**
 * The sidebar's data hooks — everything it reads that is not already a
 * foundation hook (useHiveTasks, useStaplerState) or the hive store.
 *
 * Each source is shared module-level state with one subscription per window,
 * the same pattern as useHiveTasks: the sidebar mounts once, but React's
 * StrictMode double-mount and a collapse/expand must not stack timers or
 * repeat git lookups.
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { Agent } from '@/store/store';
import type { HarnessConfig } from '@/store/config';
import { modelsForProvider } from '@/store/config';
import { inferAgentProvider, providerPreset } from '@shared/agentProvider';
import { DEFAULT_CONTEXT_TRIGGER } from '@shared/triggers';
import { assembleAutomations, countOn, type MissionRecord } from '@shared/workspace/automations';
import type { HouseRule } from '@shared/workspace/automationsRules';
import { nextSettleAt, settleRanks, type RankState } from '@shared/workspace/sidebarOrder';
import type { FloorInfo } from '@shared/workspace/sidebarNotes';

// ─── Repository roots ───────────────────────────────────────────────────────

/** cwd → the repo root `git:mainRepo` resolved (null: not a repo, or the
 *  lookup failed). Shared with nothing else on purpose: FullscreenTerminal
 *  keeps its own, identical cache, and each costs one `git rev-parse` per
 *  distinct folder for the life of the window. */
const repoRoots = new Map<string, string | null>();
const inFlight = new Set<string>();

/**
 * Resolve every distinct cwd once, ever. A null answer is cached as an answer:
 * the store replaces `agents` on every chunk of terminal output, and re-asking
 * for a folder outside any repo on each pass is how a roster once spawned git
 * continuously (see FullscreenTerminal.useResolvedRepoNames).
 */
export function useRepoRoots(agents: readonly Pick<Agent, 'cwd'>[]): (cwd: string | undefined) => string | null | undefined {
  const [, setVersion] = useState(0);
  const cwdKey = [...new Set(agents.map((a) => a.cwd).filter(Boolean))].sort().join('\n');
  useEffect(() => {
    let alive = true;
    const pending = cwdKey.split('\n').filter((cwd) => cwd && !repoRoots.has(cwd) && !inFlight.has(cwd));
    if (!pending.length) return;
    pending.forEach((cwd) => inFlight.add(cwd));
    void Promise.all(pending.map(async (cwd) => {
      try {
        repoRoots.set(cwd, (await window.cth.gitMainRepo(cwd)) || null);
      } catch {
        repoRoots.set(cwd, null);
      } finally {
        inFlight.delete(cwd);
      }
    })).then(() => { if (alive) setVersion((v) => v + 1); });
    return () => { alive = false; };
  }, [cwdKey]);
  return (cwd) => (cwd && repoRoots.has(cwd) ? repoRoots.get(cwd) : undefined);
}

// ─── Live workers (Temps) ───────────────────────────────────────────────────

export type WorkersData = Awaited<ReturnType<typeof window.cth.listWorkers>>;
export type WorkerSnapshot = WorkersData['live'][number];

const WORKERS_POLL_MS = 4000;
let workers: { live: WorkerSnapshot[]; loaded: boolean } = { live: [], loaded: false };
let workersTimer: ReturnType<typeof setInterval> | null = null;
const workerListeners = new Set<() => void>();

async function pollWorkers(): Promise<void> {
  try {
    const data = await window.cth.listWorkers();
    const live = Array.isArray(data?.live) ? data.live : [];
    if (!workers.loaded || JSON.stringify(live) !== JSON.stringify(workers.live)) {
      workers = { live, loaded: true };
      for (const l of [...workerListeners]) l();
    }
  } catch { /* main not ready — keep the last answer */ }
}

function subscribeWorkers(l: () => void): () => void {
  workerListeners.add(l);
  if (!workersTimer) {
    void pollWorkers();
    workersTimer = setInterval(() => { void pollWorkers(); }, WORKERS_POLL_MS);
  }
  return () => {
    workerListeners.delete(l);
    if (!workerListeners.size && workersTimer) { clearInterval(workersTimer); workersTimer = null; }
  };
}

/** One-job workers running right now (temps and Slack-hired workers alike —
 *  both are ephemeral workers in main's `liveWorkers`). */
export function useLiveWorkers(): { live: WorkerSnapshot[]; loaded: boolean } {
  return useSyncExternalStore(subscribeWorkers, () => workers, () => workers);
}

// ─── Automations "N on" ─────────────────────────────────────────────────────

/**
 * The Automations nav item's count, computed by the Automations unit's OWN
 * assembly (assembleAutomations + countOn) so the badge and that screen's
 * header can never disagree. Schedules, the compact/clear rules and webhooks
 * come from config (App's live copy); house rules from that unit's preload
 * API, kept current by its push.
 */
export function useAutomationsOn(config: HarnessConfig): number {
  const [rules, setRules] = useState<HouseRule[]>([]);
  useEffect(() => {
    const api = window.cth?.features?.automations as
      | { listRules?: () => Promise<HouseRule[]>; onRules?: (cb: (r: HouseRule[]) => void) => () => void }
      | undefined;
    if (!api?.listRules) return;
    let alive = true;
    void api.listRules().then((r) => { if (alive && Array.isArray(r)) setRules(r); }, () => { /* not ready */ });
    const off = api.onRules?.((r) => { if (alive && Array.isArray(r)) setRules(r); });
    return () => { alive = false; off?.(); };
  }, []);
  return useMemo(() => countOn(assembleAutomations({
    missions: Array.isArray(config.missions) ? (config.missions as MissionRecord[]) : [],
    contextTrigger: config.contextTrigger ?? DEFAULT_CONTEXT_TRIGGER,
    houseRules: rules,
    webhooks: Array.isArray(config.webhookTriggers) ? config.webhookTriggers : [],
    history: []
  })), [config.missions, config.contextTrigger, config.webhookTriggers, rules]);
}

// ─── Floor number ───────────────────────────────────────────────────────────

/** This window's office number and how many are open. */
export function useFloorInfo(): FloorInfo {
  const [info, setInfo] = useState<FloorInfo>({ number: 1, count: 1 });
  useEffect(() => {
    const api = window.cth?.features?.sidebar;
    if (!api?.floorInfo) return;
    let alive = true;
    void api.floorInfo().then((i) => { if (alive && i) setInfo(i); }, () => { /* main not ready */ });
    const off = api.onFloorInfo((i) => { if (alive && i) setInfo(i); });
    return () => { alive = false; off(); };
  }, []);
  return info;
}

// ─── Automatic order hysteresis ─────────────────────────────────────────────

/** How long a row holds its place after its agent becomes less urgent. */
export const AUTO_ORDER_HOLD_MS = 8000;

/**
 * Settled urgency ranks for the automatic order (see settleRanks): promotions
 * at once, demotions after AUTO_ORDER_HOLD_MS. Re-renders itself when a held
 * demotion matures, so the order catches up without any other change.
 */
export function useSettledRanks(current: Record<string, number>): Record<string, number> {
  const state = useRef<Record<string, RankState>>({});
  const [tick, setTick] = useState(0);
  const key = JSON.stringify(current);
  const settled = useMemo(() => {
    state.current = settleRanks(state.current, current, Date.now(), AUTO_ORDER_HOLD_MS);
    const out: Record<string, number> = {};
    for (const [id, s] of Object.entries(state.current)) out[id] = s.rank;
    return out;
    // `tick` re-runs the fold when a hold expires; `key` when ranks change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, tick]);
  useEffect(() => {
    const at = nextSettleAt(state.current, AUTO_ORDER_HOLD_MS);
    if (at === null) return;
    const timer = setTimeout(() => setTick((t) => t + 1), Math.max(50, at - Date.now() + 20));
    return () => clearTimeout(timer);
  }, [settled]);
  return settled;
}

// ─── Model label ────────────────────────────────────────────────────────────

/** "Opus 5.5" rather than `claude-opus-5-5`: the picker's label for the
 *  agent's model on its own engine, the raw id when the catalog does not know
 *  it, and the engine's name when no model is pinned (the CLI's default). */
export function modelLabel(agent: Pick<Agent, 'model' | 'command' | 'provider'>): string {
  const provider = inferAgentProvider(agent.command, agent.provider);
  const model = agent.model?.trim();
  if (!model) return providerPreset(provider).label;
  const known = modelsForProvider(provider).find((m) => m.id === model);
  return (known?.label ?? model).replace(/\s*·\s*default$/i, '');
}
