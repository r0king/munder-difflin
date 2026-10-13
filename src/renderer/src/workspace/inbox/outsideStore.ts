/**
 * The trigger-history ledger (webhooks and peer offices) for the Inbox's
 * OUTSIDE section, read through the IPC the Classic TriggerHistoryTab uses:
 * `listTriggerHistory` on mount and on every `onTriggerHistoryUpdated` push,
 * `decideTriggerHistory` for Approve / Reject on a held message.
 *
 * Shared, ref-counted, like mailStore: the Inbox list shows the held count
 * while any section is open, and only one subscription should exist.
 */
import { useSyncExternalStore } from 'react';
import type { TriggerHistoryEntry } from '@shared/triggers';

export interface OutsideSnapshot {
  loaded: boolean;
  /** Newest first, both directions, both sources. */
  entries: TriggerHistoryEntry[];
  error: boolean;
}

let snapshot: OutsideSnapshot = { loaded: false, entries: [], error: false };
const listeners = new Set<() => void>();
let off: (() => void) | null = null;
let inFlight: Promise<void> | null = null;

function emit(next: OutsideSnapshot): void {
  snapshot = next;
  for (const l of [...listeners]) l();
}

export function refreshOutside(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const rows = await window.cth.listTriggerHistory();
      emit({ loaded: true, entries: Array.isArray(rows) ? rows : [], error: false });
    } catch {
      emit({ ...snapshot, loaded: true, error: true });
    }
  })().finally(() => { inFlight = null; });
  return inFlight;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    void refreshOutside();
    try { off = window.cth.onTriggerHistoryUpdated(() => { void refreshOutside(); }); } catch { off = null; }
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) { off?.(); off = null; }
  };
}

const getSnapshot = (): OutsideSnapshot => snapshot;

export function useOutside(): OutsideSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export type DecideOutcome = 'ok' | 'gone' | 'not-released' | 'failed';

/**
 * Approve (release into the hive) or reject a held message. The verdict shows
 * at once; the ledger push that follows main's write reconciles it either way.
 * 'not-released' is main leaving an approved message pending because the
 * hive could not take the card — it can be approved again.
 */
export async function decideHeld(id: string, decision: 'approved' | 'rejected'): Promise<DecideOutcome> {
  const before = snapshot.entries;
  emit({ ...snapshot, entries: before.map((r) => (r.id === id ? { ...r, decision } : r)) });
  try {
    const row = await window.cth.decideTriggerHistory({ id, decision });
    if (!row) { void refreshOutside(); return 'gone'; }
    if (decision === 'approved' && row.decision === 'pending') { void refreshOutside(); return 'not-released'; }
    return 'ok';
  } catch {
    void refreshOutside();
    return 'failed';
  }
}
