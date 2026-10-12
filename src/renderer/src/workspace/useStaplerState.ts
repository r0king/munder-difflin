/**
 * The Stapler's state for app-window UI (the titlebar toggle, the Workspace
 * sidebar row). One subscription per window, shared by every component that
 * asks, seeded from `getState()` and kept current by `feat:stapler:state`.
 *
 * `setEnabled` renders what MAIN settled on, not what was asked for: main may
 * refuse (no permission, no display), and a toggle that shows the request
 * rather than the result is a toggle that lies.
 */
import { useSyncExternalStore } from 'react';
import { DEFAULT_STAPLER_STATE, type StaplerState } from '@shared/features/stapler';

let current: StaplerState = { ...DEFAULT_STAPLER_STATE };
let started = false;
const listeners = new Set<() => void>();

function set(next: StaplerState | null | undefined): void {
  if (!next || typeof next !== 'object') return;
  current = { ...DEFAULT_STAPLER_STATE, ...next };
  for (const l of [...listeners]) l();
}

function start(): void {
  if (started) return;
  started = true;
  try {
    const api = window.cth?.features?.stapler;
    if (!api) return;
    api.onState(set);
    void api.getState().then(set, () => { /* main not ready — keep the default */ });
  } catch { /* no bridge (tests, a stripped preload) */ }
}

function subscribe(listener: () => void): () => void {
  start();
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

const snapshot = (): StaplerState => current;

export function useStaplerState(): StaplerState {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** Ask main to show/hide the puck; resolves with the state it settled on. */
export async function setStaplerEnabled(on: boolean): Promise<StaplerState> {
  try {
    const next = await window.cth.features.stapler.setEnabled(on);
    set(next);
    return current;
  } catch {
    return current;
  }
}
