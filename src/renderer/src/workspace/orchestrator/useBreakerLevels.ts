/**
 * Every agent's circuit-breaker level, live.
 *
 * Main pushes a BreakerState per agent on each breaker beat
 * (`control:breakerState`), but a screen that mounts between beats would show
 * nothing for up to half a minute, so the first subscriber also reads the
 * levels main holds right now from the agent directory, and re-reads them on
 * a slow timer (the push carries no "agent gone" event; the directory does).
 */
import { useSyncExternalStore } from 'react';

export type BreakerLevel = 'healthy' | 'steering' | 'constrained' | 'stopped';

export interface BreakerEntry {
  level: BreakerLevel;
  /** Why it tripped; empty for a directory read (main does not expose it). */
  reason: string;
  ts: number;
}

const POLL_MS = 15_000;
const LEVELS: readonly BreakerLevel[] = ['healthy', 'steering', 'constrained', 'stopped'];
const isLevel = (v: unknown): v is BreakerLevel => typeof v === 'string' && (LEVELS as readonly string[]).includes(v);

let levels: Record<string, BreakerEntry> = {};
const listeners = new Set<() => void>();
let offPush: (() => void) | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

function emit(): void { for (const l of [...listeners]) l(); }

async function readDirectory(): Promise<void> {
  try {
    const dir = await window.cth.hiveAgentDirectory();
    const next: Record<string, BreakerEntry> = {};
    for (const a of dir.agents ?? []) {
      if (a.archived || !isLevel(a.breaker)) continue;
      const prev = levels[a.id];
      // Keep a pushed reason while the level it explains still holds.
      next[a.id] = prev && prev.level === a.breaker ? prev : { level: a.breaker, reason: '', ts: Date.now() };
    }
    if (JSON.stringify(next) !== JSON.stringify(levels)) { levels = next; emit(); }
  } catch { /* hive not open — keep what we have */ }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    offPush = window.cth.onBreakerState?.((s) => {
      if (!s || typeof s.agentId !== 'string' || !isLevel(s.level)) return;
      const prev = levels[s.agentId];
      if (prev && prev.level === s.level && prev.reason === s.reason) return;
      levels = { ...levels, [s.agentId]: { level: s.level, reason: s.reason ?? '', ts: s.ts } };
      emit();
    }) ?? null;
    void readDirectory();
    timer = setInterval(() => { void readDirectory(); }, POLL_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      offPush?.(); offPush = null;
      if (timer) clearInterval(timer);
      timer = null;
    }
  };
}

const getSnapshot = (): Record<string, BreakerEntry> => levels;

export function useBreakerLevels(): Record<string, BreakerEntry> {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** The floor's breaker in one word. `ids` limits it to the live roster, so an
 *  agent that has left cannot hold the floor "tripped". */
export function floorBreaker(
  enabled: boolean,
  all: Record<string, BreakerEntry>,
  ids: readonly string[]
): { state: 'off' | 'armed' | 'tripped'; tripped: string[] } {
  if (!enabled) return { state: 'off', tripped: [] };
  const tripped = ids.filter((id) => (all[id]?.level ?? 'healthy') !== 'healthy');
  return { state: tripped.length ? 'tripped' : 'armed', tripped };
}
