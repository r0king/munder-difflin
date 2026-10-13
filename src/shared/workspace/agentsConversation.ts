/**
 * An agent room's conversation: everything said to and by one agent, in time
 * order, from the five places it is actually written down.
 *
 *   sends       what you sent from the room (Send / Steer). Main keeps a small
 *               log of them (featureDataDir('agents')/sends), because a steer
 *               never appears in a transcript and a queued send only does once
 *               it is delivered.
 *   history     what you typed straight into its terminal (the SQLite command
 *               history, `history:list`).
 *   transcript  its Claude Code session: the prompts it received and the
 *               replies it wrote (see agentsTranscript.ts). Claude only.
 *   hive        its mailbox: messages it sent (outbox, outbox/.sent) and
 *               received (inbox, inbox/.done), from you, the orchestrator and
 *               the other agents.
 *   asks        ASK ME questions on the task cards assigned to it, and your
 *               answers (`humanQA` on hive/tasks.json).
 *
 * The same words often arrive twice — a send is logged when you press Send and
 * shows up again in the transcript when the drain types it in; a line you typed
 * in the terminal is both in the history and in the transcript — so the merge
 * DEDUPES by content within a time window and keeps the richer copy.
 *
 * Pure and import-free (test/ws-agents-conversation.test.cjs).
 */
import type { TranscriptEvent } from './agentsTranscript';

// ─── Source shapes (main → renderer over `feat:agents:conversation`) ────────

export interface SendRecord {
  id: string;
  /** Epoch ms when you pressed Send/Steer. */
  ts: number;
  /** Exactly what was handed to the agent (attachment block included). */
  text: string;
  mode: 'send' | 'steer';
}

export interface HistoryRecord {
  text: string;
  ts: number;
}

export interface HiveMailRecord {
  id: string;
  from: string;
  to: string;
  act: string;
  subject: string;
  body: string;
  /** Epoch ms (from the message's created_at). */
  ts: number;
  /** Which of THIS agent's folders it was found in. */
  direction: 'inbox' | 'outbox';
  conversation?: string;
  requiresReply?: boolean;
}

export interface AskRecord {
  taskId: string;
  taskTitle: string;
  q: string;
  a?: string;
  askedAt?: number;
  answeredAt?: number;
  dismissed?: boolean;
}

export interface ConversationSources {
  sends: SendRecord[];
  transcript: TranscriptEvent[];
  hive: HiveMailRecord[];
  asks: AskRecord[];
  /** Filled in by the renderer (the history lives behind its own IPC). */
  history?: HistoryRecord[];
  /** Why the transcript is missing, when it is: 'engine' (not a Claude agent),
   *  'none' (no session recorded yet). Lets the room say so instead of
   *  showing a conversation that silently lacks the agent's replies. */
  transcriptMissing?: 'engine' | 'none';
}

// ─── The merged item ────────────────────────────────────────────────────────

export type ConversationKind =
  /** You, from this room's composer. */
  | 'send'
  /** You, as a steer note for its next turn. */
  | 'steer'
  /** A prompt typed into its terminal (by you, or by the floor). */
  | 'prompt'
  /** The agent's own reply. */
  | 'reply'
  /** A hive message to or from it. */
  | 'mail'
  /** An ASK ME question on one of its cards. */
  | 'ask'
  /** Your answer to one. */
  | 'answer'
  /** A terminal event worth a quiet line: a slash command, a compaction, an
   *  interruption. */
  | 'event';

export type ConversationAuthor = 'you' | 'agent' | 'other' | 'system';

export interface ConversationItem {
  /** Stable across polls (React key). */
  id: string;
  ts: number;
  kind: ConversationKind;
  author: ConversationAuthor;
  /** Markdown (agent-written text is rendered through the safe renderer). */
  text: string;
  /** mail: sender / recipient ids. */
  from?: string;
  to?: string;
  /** mail: subject and speech act. */
  subject?: string;
  act?: string;
  /** mail: it asks for a reply. */
  requiresReply?: boolean;
  /** ask/answer: the card. */
  taskId?: string;
  taskTitle?: string;
  /** ask: still waiting on you. */
  open?: boolean;
  /** send: seen arriving in its terminal (transcript). */
  delivered?: boolean;
  /** prompt: typed by you in the terminal (matched in the history). */
  byYou?: boolean;
  /** event: what happened ('command' | 'compact' | 'interrupt'). */
  event?: 'command' | 'compact' | 'interrupt';
  /** reply: the shorter notes it wrote earlier in the same turn, oldest first
   *  ("Let me look at the tests."). Folded under the turn's final reply. */
  notes?: string[];
}

// ─── Matching ───────────────────────────────────────────────────────────────

/** Comparable form of a message: whitespace collapsed, the composer's
 *  "Attached files:" block dropped (the transcript may render it differently),
 *  case folded. */
export function comparableText(text: string): string {
  const withoutFiles = text.replace(/\n*Attached files:\n(?:- .*(?:\n|$))*/g, ' ');
  return withoutFiles.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Same message? Exact comparable text, or — for long messages a TUI may have
 *  wrapped or a hook may have prefixed — the same first 160 characters. */
export function sameMessage(a: string, b: string): boolean {
  const x = comparableText(a);
  const y = comparableText(b);
  if (!x || !y) return false;
  if (x === y) return true;
  if (x.length >= 160 && y.length >= 160) return x.slice(0, 160) === y.slice(0, 160);
  // A prompt can arrive with the send as its tail (a hook prepended context).
  return (x.length >= 24 && y.endsWith(x)) || (y.length >= 24 && x.endsWith(y));
}

/** How long after you press Send its arrival in the transcript still counts
 *  as the same message. A queued send can wait hours behind a long turn. */
export const SEND_MATCH_WINDOW_MS = 12 * 60 * 60 * 1000;
/** Clock slack between the renderer's Date.now() and the CLI's timestamps. */
const CLOCK_SLACK_MS = 2 * 60 * 1000;
/** A history row and the transcript prompt it produced land within seconds. */
const HISTORY_MATCH_WINDOW_MS = 5 * 60 * 1000;

const NUDGE_HEAD = 'You have new hive inbox message(s)';

/** Floor plumbing that is not conversation: the inbox-wake nudge. */
function isPlumbing(text: string): boolean {
  return text.trim().startsWith(NUDGE_HEAD);
}

// ─── The merge ──────────────────────────────────────────────────────────────

export interface BuildOptions {
  /** The room's agent id: decides whether a mail is "the agent" or "other". */
  agentId: string;
  /** Keep only the newest N items (default 200). */
  limit?: number;
}

/**
 * Merge the sources into one conversation, oldest first.
 *
 * Dedupe rules, in order:
 *  1. A transcript prompt that matches one of your sends (after it, within
 *     SEND_MATCH_WINDOW_MS) is dropped and the send is marked delivered.
 *  2. A transcript prompt that matches a history row (within 5 minutes) is
 *     kept once, marked `byYou`; the history row is dropped.
 *  3. Hive mail is deduped by message id.
 *  4. Inbox-wake nudges are dropped (they are plumbing, and the mail they point
 *     at is already in the conversation).
 * Replies: within one turn (between two prompts) only the LAST reply is an
 * item; earlier replies of that turn ride along as its `notes`.
 */
export function buildConversation(src: ConversationSources, opts: BuildOptions): ConversationItem[] {
  const limit = Math.max(1, Math.min(1000, opts.limit ?? 200));
  const items: ConversationItem[] = [];

  // 1) Your sends.
  const sends = (src.sends ?? [])
    .filter((s): s is SendRecord => !!s && typeof s.id === 'string' && typeof s.ts === 'number')
    .sort((a, b) => a.ts - b.ts);
  const sendItems = new Map<string, ConversationItem>();
  for (const s of sends) {
    if (!s || typeof s.text !== 'string' || !s.text.trim()) continue;
    const item: ConversationItem = {
      id: `send-${s.id}`,
      ts: s.ts,
      kind: s.mode === 'steer' ? 'steer' : 'send',
      author: 'you',
      text: s.text
    };
    sendItems.set(s.id, item);
    items.push(item);
  }
  // Steers are matched too: an IDLE agent gets a steer at the front of its
  // queue (workspace/deliver.ts), so it does arrive as a typed prompt.
  const unmatchedSends = [...sends];

  // 2) Terminal history (typed by you).
  const history = [...(src.history ?? [])]
    .filter((h) => !!h && typeof h.text === 'string' && !!h.text.trim() && typeof h.ts === 'number')
    .sort((a, b) => a.ts - b.ts);
  const historyUsed = new Set<number>();

  // 3) The transcript, turn by turn.
  let turnReplies: ConversationItem[] = [];
  const flushTurn = (): void => {
    if (!turnReplies.length) return;
    const last = turnReplies[turnReplies.length - 1];
    const notes = turnReplies.slice(0, -1).map((r) => r.text);
    items.push(notes.length ? { ...last, notes } : last);
    turnReplies = [];
  };
  for (const ev of src.transcript ?? []) {
    if (!ev) continue;
    if (ev.kind === 'prompt') {
      flushTurn();
      if (isPlumbing(ev.text)) continue;
      const sendIdx = unmatchedSends.findIndex((s) =>
        ev.ts >= s.ts - CLOCK_SLACK_MS && ev.ts - s.ts <= SEND_MATCH_WINDOW_MS && sameMessage(s.text, ev.text)
      );
      if (sendIdx >= 0) {
        const [s] = unmatchedSends.splice(sendIdx, 1);
        const item = sendItems.get(s.id);
        if (item) item.delivered = true;
        continue;
      }
      const hIdx = history.findIndex((h, i) =>
        !historyUsed.has(i) && Math.abs(h.ts - ev.ts) <= HISTORY_MATCH_WINDOW_MS && sameMessage(h.text, ev.text)
      );
      if (hIdx >= 0) historyUsed.add(hIdx);
      items.push({
        id: `tx-${ev.id}`,
        ts: ev.ts,
        kind: 'prompt',
        author: hIdx >= 0 ? 'you' : 'other',
        text: ev.text,
        ...(hIdx >= 0 ? { byYou: true } : {})
      });
    } else if (ev.kind === 'reply') {
      turnReplies.push({ id: `tx-${ev.id}`, ts: ev.ts, kind: 'reply', author: 'agent', text: ev.text });
    } else if (ev.kind === 'command' || ev.kind === 'compact' || ev.kind === 'interrupt') {
      flushTurn();
      // A /compact you queued from the room is already your send.
      if (ev.kind === 'command') {
        const sendIdx = unmatchedSends.findIndex((s) =>
          ev.ts >= s.ts - CLOCK_SLACK_MS && ev.ts - s.ts <= SEND_MATCH_WINDOW_MS && sameMessage(s.text, ev.text)
        );
        if (sendIdx >= 0) {
          const [s] = unmatchedSends.splice(sendIdx, 1);
          const item = sendItems.get(s.id);
          if (item) item.delivered = true;
          continue;
        }
      }
      items.push({ id: `tx-${ev.id}`, ts: ev.ts, kind: 'event', author: 'system', text: ev.text, event: ev.kind });
    }
  }
  flushTurn();

  // History rows that never showed up in a transcript (non-Claude engines, or
  // older than the transcript tail) are still things you said.
  history.forEach((h, i) => {
    if (historyUsed.has(i)) return;
    if (items.some((it) => it.author === 'you' && Math.abs(it.ts - h.ts) <= HISTORY_MATCH_WINDOW_MS && sameMessage(it.text, h.text))) return;
    items.push({ id: `hist-${h.ts}-${i}`, ts: h.ts, kind: 'prompt', author: 'you', text: h.text, byYou: true });
  });

  // 4) Hive mail.
  const seenMail = new Set<string>();
  for (const m of src.hive ?? []) {
    if (!m || typeof m.id !== 'string' || seenMail.has(m.id)) continue;
    seenMail.add(m.id);
    const fromAgent = m.from === opts.agentId;
    const fromYou = m.from === 'human';
    items.push({
      id: `mail-${m.id}`,
      ts: m.ts,
      kind: 'mail',
      author: fromAgent ? 'agent' : fromYou ? 'you' : 'other',
      text: m.body,
      from: m.from,
      to: m.to,
      subject: m.subject,
      act: m.act,
      ...(m.requiresReply ? { requiresReply: true } : {})
    });
  }

  // 5) ASK ME.
  for (const a of src.asks ?? []) {
    if (!a || typeof a.q !== 'string' || !a.q.trim()) continue;
    const askedAt = a.askedAt ?? 0;
    const key = `${a.taskId}-${askedAt}-${a.q.length}`;
    items.push({
      id: `ask-${key}`,
      ts: askedAt,
      kind: 'ask',
      author: 'agent',
      text: a.q,
      taskId: a.taskId,
      taskTitle: a.taskTitle,
      open: !a.a && !a.dismissed
    });
    if (a.a && a.a.trim()) {
      items.push({
        id: `answer-${key}`,
        ts: a.answeredAt ?? askedAt,
        kind: 'answer',
        author: 'you',
        text: a.a,
        taskId: a.taskId,
        taskTitle: a.taskTitle
      });
    }
  }

  // Stable time order: ts, then the order the sources were merged in (so an
  // ask stays above its answer when both carry the same timestamp).
  const ordered = items
    .map((item, i) => ({ item, i }))
    .sort((a, b) => (a.item.ts - b.item.ts) || (a.i - b.i))
    .map((x) => x.item);
  return ordered.slice(-limit);
}

/** Has anything new arrived (for "scroll to bottom unless the reader scrolled
 *  up")? Compares the newest item. */
export function lastItemKey(items: readonly ConversationItem[]): string {
  const last = items[items.length - 1];
  return last ? `${last.id}:${last.text.length}:${last.delivered ? 1 : 0}` : '';
}
