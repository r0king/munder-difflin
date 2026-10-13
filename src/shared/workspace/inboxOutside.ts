/**
 * Inbox — OUTSIDE: what came in from beyond the floor (owned by `wsInbox`).
 *
 * Two real sources, read through IPC that already exists:
 *
 *   Webhooks (and peer offices) — the trigger-history ledger
 *     (`triggerHistory:list`, src/main/triggerHistory.ts). One row per message;
 *     an inbound row a `strict` / `communication-only` endpoint held back has
 *     `decision: 'pending'` and is approved or rejected with
 *     `triggerHistory:decide`. Rows are folded into EXCHANGES by
 *     `correlationId` — the same reading as the Classic TriggerHistoryTab —
 *     so "what did they ask, and what did we answer" is one card.
 *
 *   Slack threads — Slack has no hold: a verified message goes straight into
 *     the orchestrator's queue (useHive), is promoted to a task card carrying
 *     `slack: { channel, thread_ts }` once dispatched, and the card's `result`
 *     is what gets posted back in-thread. So a thread is read off the task
 *     ledger (plus anything still waiting in his queue), grouped by thread.
 *
 * Pure and import-free (node:test loads it via test/load-ts.cjs). The ledger
 * row is typed structurally so this file does not import src/shared/triggers.
 */

export type OutsideSource = 'webhook' | 'org';

/** Structural mirror of `TriggerHistoryEntry` (src/shared/triggers.ts). */
export interface OutsideEntry {
  id: string;
  source: OutsideSource;
  sourceId: string;
  sourceName: string;
  direction: 'inbound' | 'outbound';
  peer: string;
  title?: string;
  body: string;
  kind: 'directive' | 'communication';
  decision?: 'auto-allowed' | 'pending' | 'approved' | 'rejected';
  correlationId?: string;
  taskId?: string;
  at: number;
}

export interface Exchange {
  key: string;
  /** Oldest first — an exchange reads downward. */
  msgs: OutsideEntry[];
  /** The inbound that started it, else the lone outbound. */
  head: OutsideEntry;
  /** The inbound still held for the operator, if any. */
  pending: OutsideEntry | null;
  answered: boolean;
  latestAt: number;
}

/** Fold the flat ledger into exchanges: held ones first, then newest first.
 *  A row without a correlationId is its own one-sided exchange. */
export function buildExchanges(rows: OutsideEntry[]): Exchange[] {
  const buckets = new Map<string, OutsideEntry[]>();
  const order: string[] = [];
  for (const e of rows) {
    if (!e || typeof e.id !== 'string') continue;
    const key = e.correlationId ? `c:${e.correlationId}` : `e:${e.id}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(e);
    else { buckets.set(key, [e]); order.push(key); }
  }
  const list = order.map<Exchange>((key) => {
    const msgs = (buckets.get(key) ?? []).slice().sort((a, b) => a.at - b.at);
    const inbound = msgs.find((m) => m.direction === 'inbound');
    return {
      key,
      msgs,
      head: inbound ?? msgs[0],
      pending: msgs.find((m) => m.direction === 'inbound' && m.decision === 'pending') ?? null,
      answered: msgs.some((m) => m.direction === 'outbound'),
      latestAt: msgs.reduce((max, m) => Math.max(max, Number.isFinite(m.at) ? m.at : 0), 0)
    };
  });
  return list.sort((a, b) => {
    if (!!a.pending !== !!b.pending) return a.pending ? -1 : 1;
    return b.latestAt - a.latestAt;
  });
}

/** Inbound rows still waiting for the operator, per source. */
export function heldCounts(rows: OutsideEntry[]): Record<OutsideSource, number> {
  const out: Record<OutsideSource, number> = { webhook: 0, org: 0 };
  for (const e of rows) {
    if (e?.direction === 'inbound' && e.decision === 'pending' && (e.source === 'webhook' || e.source === 'org')) {
      out[e.source] += 1;
    }
  }
  return out;
}

/** Exchange filter for the Outside list. */
export type ExchangeFilter = 'all' | 'held' | 'allowed' | 'rejected';

export function filterExchanges(list: Exchange[], filter: ExchangeFilter): Exchange[] {
  if (filter === 'all') return list;
  return list.filter((ex) => {
    const d = ex.head.direction === 'inbound' ? ex.head.decision : undefined;
    if (filter === 'held') return !!ex.pending;
    if (filter === 'rejected') return d === 'rejected';
    return d === 'auto-allowed' || d === 'approved';
  });
}

// ─── Slack ──────────────────────────────────────────────────────────────────

export type SlackItemState = 'queued' | 'todo' | 'doing' | 'blocked' | 'done';

export interface SlackItem {
  /** Task id once promoted to a card; the queue entry id while still queued. */
  id: string;
  text: string;
  state: SlackItemState;
  /** What was (or will be) posted back in the thread, once the card is done. */
  result?: string;
  /** Epoch ms. */
  at: number;
  /** True while it is a task card (openable in the task detail). */
  isTask: boolean;
}

export interface SlackThread {
  key: string;
  channel: string;
  threadTs: string;
  /** Oldest first. */
  items: SlackItem[];
  latestAt: number;
  /** Something in the thread is not done yet. */
  open: boolean;
}

/** Slack's `ts` ("1700000000.000200") as epoch ms; NaN when it is not one. */
export function slackTsMs(ts: string): number {
  if (!/^\d{1,12}(?:\.\d{1,9})?$/.test(ts)) return Number.NaN;
  return Math.round(Number(ts) * 1000);
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => !!v && typeof v === 'object' && !Array.isArray(v);
const s = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

function slackOf(v: unknown): { channel: string; thread_ts: string } | null {
  if (!isRec(v)) return null;
  const channel = s(v.channel);
  const thread = s(v.thread_ts);
  return channel && thread ? { channel, thread_ts: thread } : null;
}

/** A queued message as the store holds it (only what this reads). */
export interface QueuedLike {
  id: string;
  text: string;
  ts: number;
  slack?: { channel: string; thread_ts: string };
}

/**
 * Slack threads from the raw task ledger (`hive:tasks`) and the
 * orchestrator's queue. Newest activity first; within a thread oldest first.
 */
export function slackThreads(ledger: unknown, queued: QueuedLike[] = []): SlackThread[] {
  const tasks = isRec(ledger) && Array.isArray(ledger.tasks) ? ledger.tasks : [];
  const threads = new Map<string, SlackThread>();
  const add = (slack: { channel: string; thread_ts: string }, item: SlackItem) => {
    const key = `${slack.channel}:${slack.thread_ts}`;
    let th = threads.get(key);
    if (!th) {
      th = { key, channel: slack.channel, threadTs: slack.thread_ts, items: [], latestAt: 0, open: false };
      threads.set(key, th);
    }
    th.items.push(item);
  };
  for (const raw of tasks) {
    if (!isRec(raw)) continue;
    const slack = slackOf(raw.slack);
    const id = s(raw.id);
    if (!slack || !id) continue;
    const status = s(raw.status);
    const state: SlackItemState = status === 'doing' || status === 'blocked' || status === 'done' ? status : 'todo';
    const created = Date.parse(s(raw.createdAt) ?? '');
    const at = Number.isNaN(created) ? slackTsMs(slack.thread_ts) : created;
    const result = s(raw.result)?.trim();
    add(slack, {
      id,
      text: (s(raw.description) ?? s(raw.title) ?? '').trim(),
      state,
      ...(result ? { result } : {}),
      at: Number.isNaN(at) ? 0 : at,
      isTask: true
    });
  }
  for (const q of queued) {
    const slack = slackOf(q?.slack);
    if (!slack || typeof q.id !== 'string') continue;
    add(slack, { id: q.id, text: (q.text ?? '').trim(), state: 'queued', at: Number.isFinite(q.ts) ? q.ts : 0, isTask: false });
  }
  for (const th of threads.values()) {
    th.items.sort((a, b) => a.at - b.at);
    th.latestAt = th.items.reduce((m, i) => Math.max(m, i.at), 0);
    th.open = th.items.some((i) => i.state !== 'done');
  }
  return [...threads.values()].sort((a, b) => b.latestAt - a.latestAt);
}
