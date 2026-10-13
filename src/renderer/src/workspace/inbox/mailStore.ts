/**
 * The floor's mail and this hive's read marks, for the Inbox and its bell.
 *
 * One poller for the whole Workspace, on the useHiveTasks pattern: the first
 * subscriber starts it, the last stops it, every hook reads one snapshot. Mail
 * changes when the router routes something, and the router announces every
 * routed message on `hive:message` (onHiveMessage), so a refresh is driven by
 * that event (coalesced) and the timer is only a safety net for anything that
 * lands on disk without passing the router.
 *
 * Read marks come back from main on every change, from this window or another
 * floor's (`onReadMarks`), so a section read in one window is read in all.
 */
import { useSyncExternalStore } from 'react';
import {
  normalizeHiveMessage,
  type InboxMessage,
  type ReadMarks
} from '@shared/workspace/inboxMessages';
import { applyReadMark } from '@shared/workspace/inboxSection';
import type { ReadMarkEntry } from '@shared/workspace/inboxChannels';

const POLL_MS = 15_000;
/** Routed messages arrive in bursts (a broadcast, a router pass); one re-read
 *  per burst is plenty. */
const EVENT_DEBOUNCE_MS = 400;

export interface MailSnapshot {
  /** False until the first read lands. */
  loaded: boolean;
  /** False before onboarding: there is no hive folder to read. */
  hive: boolean;
  /** Newest first. */
  messages: InboxMessage[];
  total: number;
  truncated: boolean;
  /** The last read failed (the previous messages are kept). */
  error: boolean;
  marks: ReadMarks;
}

let snapshot: MailSnapshot = {
  loaded: false, hive: true, messages: [], total: 0, truncated: false, error: false, marks: {}
};
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let debounce: ReturnType<typeof setTimeout> | null = null;
let offMessage: (() => void) | null = null;
let offMarks: (() => void) | null = null;
let inFlight: Promise<void> | null = null;
/** Messages this window sent that the next read may not include yet. */
let pendingLocal: InboxMessage[] = [];

function emit(next: MailSnapshot): void {
  snapshot = next;
  for (const l of [...listeners]) l();
}

function api() {
  return window.cth?.features?.inbox;
}

/** Cheap identity for a mail list: files never change once written, so the
 *  count and the newest/oldest ids are enough to know whether it moved. */
function signature(list: InboxMessage[], total: number): string {
  return `${total}|${list.length}|${list[0]?.id ?? ''}|${list[list.length - 1]?.id ?? ''}`;
}

/** Re-read the mail now. Concurrent calls share one read. */
export function refreshInboxMail(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const inbox = api();
    if (!inbox) return;
    try {
      const [reply, marks] = await Promise.all([
        inbox.messages(),
        snapshot.loaded ? Promise.resolve(null) : inbox.readMarks().catch(() => null)
      ]);
      const ids = new Set(reply.messages.map((m) => m.id));
      // A message we sent shows until the read that includes it.
      pendingLocal = pendingLocal.filter((m) => !ids.has(m.id));
      const messages = pendingLocal.length ? [...pendingLocal, ...reply.messages] : reply.messages;
      const same = snapshot.loaded
        && signature(messages, reply.total) === signature(snapshot.messages, snapshot.total)
        && snapshot.hive === reply.hive
        && snapshot.error === !!reply.error;
      if (same && !marks) return;
      emit({
        ...snapshot,
        loaded: true,
        hive: reply.hive,
        messages: same ? snapshot.messages : messages,
        total: reply.total,
        truncated: reply.truncated,
        error: !!reply.error,
        marks: marks?.marks ?? snapshot.marks
      });
    } catch {
      if (!snapshot.loaded || !snapshot.error) emit({ ...snapshot, loaded: true, error: true });
    }
  })().finally(() => { inFlight = null; });
  return inFlight;
}

function onRouted(): void {
  if (debounce) clearTimeout(debounce);
  debounce = setTimeout(() => { debounce = null; void refreshInboxMail(); }, EVENT_DEBOUNCE_MS);
}

function start(): void {
  void refreshInboxMail();
  timer = setInterval(() => { void refreshInboxMail(); }, POLL_MS);
  try { offMessage = window.cth.onHiveMessage(onRouted); } catch { offMessage = null; }
  try {
    offMarks = api()?.onReadMarks((reply) => {
      if (reply && reply.marks && typeof reply.marks === 'object') emit({ ...snapshot, marks: reply.marks });
    }) ?? null;
  } catch { offMarks = null; }
}

function stop(): void {
  if (timer) { clearInterval(timer); timer = null; }
  if (debounce) { clearTimeout(debounce); debounce = null; }
  offMessage?.(); offMessage = null;
  offMarks?.(); offMarks = null;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) start();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) stop();
  };
}

const getSnapshot = (): MailSnapshot => snapshot;

/** The floor's mail + read marks, polled while anything is subscribed. */
export function useInboxMail(): MailSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Move read watermarks forward. Applied locally at once (the same pure rule
 * main applies) so the badge clears on the click, then reconciled with what
 * main saved.
 */
export function markInboxRead(entries: ReadMarkEntry[]): void {
  const now = new Date().toISOString();
  let marks = snapshot.marks;
  for (const e of entries) marks = applyReadMark(marks, e.key, e.at, now) ?? marks;
  if (marks === snapshot.marks) return;
  emit({ ...snapshot, marks });
  void api()?.markRead(entries)
    .then((reply) => { if (reply?.ok && reply.marks) emit({ ...snapshot, marks: reply.marks }); })
    .catch(() => { /* the local mark stands until the next read */ });
}

/**
 * Show a message this window just sent before the next read picks it up off
 * disk — the reply that answered "needs a reply" must clear that state now,
 * not in fifteen seconds. `raw` is what `hiveSend` returned.
 */
export function addSentMessage(raw: unknown): void {
  const msg = normalizeHiveMessage(raw);
  if (!msg || snapshot.messages.some((m) => m.id === msg.id)) return;
  pendingLocal = [msg, ...pendingLocal.filter((m) => m.id !== msg.id)].slice(0, 50);
  emit({ ...snapshot, messages: [msg, ...snapshot.messages] });
  onRouted();
}
