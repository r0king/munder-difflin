/**
 * The dictation state main pushes to every window (`feat:dictate:state`), as
 * a hook. The Stapler's ring and DictateSettings render from it; it is one
 * subscription per window however many components read it.
 */
import { useSyncExternalStore } from 'react';
import { DEFAULT_DICTATE_STATE, type DictateState } from '@shared/features/dictate';

let current: DictateState = DEFAULT_DICTATE_STATE;
let started = false;
const listeners = new Set<() => void>();

function emit(next: DictateState): void {
  current = next;
  for (const l of listeners) l();
}

function ensureSubscribed(): void {
  if (started) return;
  const api = window.cth?.features?.dictate;
  if (!api) return;
  started = true;
  // Subscribe first, then read; a push that arrives before the read returns
  // is newer than it, so the read is then dropped.
  let pushed = false;
  api.onState((s) => { pushed = true; emit(s); });
  void api.getState().then((s) => { if (!pushed) emit(s); }, () => { /* the next push fills it in */ });
}

function subscribe(cb: () => void): () => void {
  ensureSubscribed();
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

export function useDictateState(): DictateState {
  return useSyncExternalStore(subscribe, () => current, () => current);
}

/** Start, or stop and type (the ring's Dictate button). */
export function toggleDictation(): Promise<DictateState> {
  return window.cth.features.dictate.toggle();
}
