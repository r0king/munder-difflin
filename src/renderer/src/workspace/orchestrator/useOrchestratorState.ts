/**
 * The orchestrator feature's live state — today's spend against the daily cap,
 * the default token cap, and the floor-wide delivery hold — shared by every
 * component that shows a piece of it (the header switch, the banner, the stat
 * strip, the Budget tab).
 *
 * One subscription for all of them: main pushes `feat:orchestrator:state`
 * whenever anything changes (a pause, a cap, a spend tick), the first
 * subscriber also fetches once so the screen never waits a beat, and a slow
 * backstop poll covers a push lost to a reload.
 */
import { useSyncExternalStore } from 'react';
import type { OrchestratorState } from '@shared/workspace/orchestratorTypes';

const BACKSTOP_MS = 60_000;

let state: OrchestratorState | null = null;
let error: string | null = null;
const listeners = new Set<() => void>();
let off: (() => void) | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

function api() {
  return window.cth?.features?.orchestrator;
}

function emit(): void {
  for (const l of [...listeners]) l();
}

/** Adopt a state that came back from main (a push or a setter's reply). */
export function adoptOrchestratorState(next: OrchestratorState): void {
  state = next;
  error = null;
  emit();
}

export async function refreshOrchestratorState(): Promise<void> {
  const a = api();
  if (!a) return;
  try {
    adoptOrchestratorState(await a.getState());
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
    emit();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    off = api()?.onState((s) => adoptOrchestratorState(s)) ?? null;
    void refreshOrchestratorState();
    timer = setInterval(() => { void refreshOrchestratorState(); }, BACKSTOP_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      off?.(); off = null;
      if (timer) clearInterval(timer);
      timer = null;
    }
  };
}

interface Snapshot { state: OrchestratorState | null; error: string | null }
let snap: Snapshot = { state, error };
function getSnapshot(): Snapshot {
  if (snap.state !== state || snap.error !== error) snap = { state, error };
  return snap;
}

/** `state` is null until main first answers; `error` is the last failure. */
export function useOrchestratorState(): Snapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Hold or release every agent's queue. Resolves with the new state. */
export async function setDeliveriesPaused(paused: boolean): Promise<void> {
  const a = api();
  if (!a) return;
  adoptOrchestratorState(await a.setDeliveriesPaused(paused));
}
