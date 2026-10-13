/**
 * Inbox — the message half (owned by the `wsInbox` unit).
 *
 * The hive's mail is a folder of JSON files per agent (agents/<id>/inbox,
 * inbox/.done, outbox/.sent). Main reads them for the Inbox screen
 * (`feat:inbox:messages`) and hands the renderer this module's `InboxMessage`;
 * everything the screen derives from that list — which agent a message
 * belongs to, what is unread, what still waits on your reply, what a search
 * matches — is decided here.
 *
 * Pure and import-free so node:test can load it through test/load-ts.cjs, and
 * so main and the renderer agree on one definition of "to you".
 *
 * WHO "YOU" ARE ON THE FLOOR. The hive has no human mailbox: a message an
 * agent addresses `to: "human"` is routed to the orchestrator's inbox (the
 * human's proxy, hive.ts routeMessage), and everything the human sends from
 * the app goes out with `from: "human"`. So "to you" is read off the ADDRESS,
 * not off whose folder a file sits in:
 *
 *   to you     `to === "human"`, or `needs_human` set by the sender (a message
 *              aimed at the orchestrator but flagged for the human: "about you").
 *   from you   `from === "human"` — Ask me answers, thread replies, dispatches.
 */

export type InboxAct = 'request' | 'inform' | 'propose' | 'query' | 'agree' | 'refuse' | 'done';

export const INBOX_ACTS: readonly InboxAct[] = ['request', 'inform', 'propose', 'query', 'agree', 'refuse', 'done'];

/** The pseudo-party the app sends as, and the address that routes to it. */
export const HUMAN = 'human';
/** The orchestrator's role address; hive.ts resolves it to the real god id. */
export const GOD_ALIAS = 'god';
export const BROADCAST = 'broadcast';
/** Harness-authored mail (bounce notices, closing time). Nobody's row. */
export const SYSTEM = 'system';

/** One routed hive message, as the Inbox sees it. Subject and body are already
 *  REDACTED in main (redactSecrets) before they cross IPC. */
export interface InboxMessage {
  id: string;
  conversation: string;
  inReplyTo: string | null;
  from: string;
  to: string;
  act: InboxAct;
  subject: string;
  body: string;
  requiresReply: boolean;
  needsHuman: boolean;
  /** ISO-8601. */
  createdAt: string;
  /** The body was longer than the wire cap and was cut there. */
  clipped?: boolean;
}

// ─── Normalising files off disk ─────────────────────────────────────────────

export const MAX_ID = 200;
export const MAX_PARTY = 128;
export const MAX_SUBJECT = 500;
/** Per-message body cap on the wire. An agent that pastes a 2MB log into a
 *  message should not make the whole floor's list a 2MB IPC payload. */
export const MAX_BODY = 20_000;

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const nonEmpty = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** `v` as an ISO string when it parses as a date, else undefined. */
function isoOrUndefined(v: unknown): string | undefined {
  if (typeof v !== 'string' || !v) return undefined;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

export interface NormalizeFallback {
  /** Used when the file carries no `id` (a raw outbox/.sent copy). */
  id?: string;
  /** Used when the file carries no `from` — the owning directory. */
  from?: string;
  /** Used when the file carries no parseable `created_at` — its mtime. */
  createdAt?: string;
  /** Body cap; MAX_BODY by default. */
  maxBody?: number;
}

/**
 * A hive message file (whatever JSON it holds) as an InboxMessage, or null when
 * it cannot be one. Mirrors hive.ts `normalize()` for the defaults (`to` →
 * god, act → inform, requires_reply from the act), because an outbox/.sent
 * copy is the RAW file an agent wrote, before the router normalised it.
 * Never throws: a hand-edited mailbox must not be able to take the screen down.
 */
export function normalizeHiveMessage(raw: unknown, fallback: NormalizeFallback = {}): InboxMessage | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const id = (nonEmpty(r.id) ?? nonEmpty(fallback.id))?.slice(0, MAX_ID);
  if (!id) return null;
  const createdAt = isoOrUndefined(r.created_at) ?? isoOrUndefined(fallback.createdAt);
  if (!createdAt) return null;
  const act = (INBOX_ACTS as readonly string[]).includes(r.act as string) ? (r.act as InboxAct) : 'inform';
  const maxBody = typeof fallback.maxBody === 'number' && fallback.maxBody > 0 ? fallback.maxBody : MAX_BODY;
  const fullBody = str(r.body) ?? '';
  const clipped = fullBody.length > maxBody;
  const msg: InboxMessage = {
    id,
    conversation: (nonEmpty(r.conversation) ?? `conv-${id}`).slice(0, MAX_ID),
    inReplyTo: nonEmpty(r.in_reply_to)?.slice(0, MAX_ID) ?? null,
    from: (nonEmpty(r.from) ?? nonEmpty(fallback.from) ?? SYSTEM).slice(0, MAX_PARTY),
    to: (nonEmpty(r.to) ?? GOD_ALIAS).slice(0, MAX_PARTY),
    act,
    subject: (str(r.subject) ?? '').slice(0, MAX_SUBJECT),
    body: clipped ? fullBody.slice(0, maxBody) : fullBody,
    requiresReply: typeof r.requires_reply === 'boolean'
      ? r.requires_reply
      : act === 'request' || act === 'query' || act === 'propose',
    needsHuman: r.needs_human === true,
    createdAt
  };
  if (clipped) msg.clipped = true;
  return msg;
}

/** Identity of a message's CONTENT, for matching a raw outbox/.sent copy that
 *  has no id to the routed copy the router minted one for. */
export function contentKey(m: Pick<InboxMessage, 'from' | 'to' | 'subject' | 'body'>): string {
  return `${m.from}\u0000${m.to}\u0000${m.subject}\u0000${m.body}`;
}

/** Newest first; an unparseable time sorts last. Stable for equal times. */
export function compareNewestFirst(a: Pick<InboxMessage, 'createdAt'>, b: Pick<InboxMessage, 'createdAt'>): number {
  const ax = Date.parse(a.createdAt);
  const bx = Date.parse(b.createdAt);
  const an = Number.isNaN(ax);
  const bn = Number.isNaN(bx);
  if (an || bn) return an === bn ? 0 : an ? 1 : -1;
  return bx - ax;
}

/**
 * Merge what was read off disk into one list, each message once, newest first.
 *
 * `delivered` are the copies in recipients' inboxes (inbox/ and inbox/.done):
 * normalised by the router, so they carry the real id. A broadcast sits in
 * several inboxes under ONE id, and a bounce reuses the id too, so dedupe by
 * id and keep the first seen.
 *
 * `sent` are senders' outbox/.sent copies — the raw files as written. They
 * matter only for mail that never reached an inbox (a terminal handoff to an
 * engine with no hive inbox). One the router delivered is already in
 * `delivered`, by id when the agent wrote one and by content when it did not
 * (the router minted the id), so it is skipped either way.
 */
export function mergeMailboxes(delivered: InboxMessage[], sent: InboxMessage[], limit = Infinity): InboxMessage[] {
  const byId = new Map<string, InboxMessage>();
  const content = new Set<string>();
  for (const m of delivered) {
    if (byId.has(m.id)) continue;
    byId.set(m.id, m);
    content.add(contentKey(m));
  }
  for (const m of sent) {
    if (byId.has(m.id) || content.has(contentKey(m))) continue;
    byId.set(m.id, m);
    content.add(contentKey(m));
  }
  const out = [...byId.values()].sort(compareNewestFirst);
  return Number.isFinite(limit) && limit >= 0 ? out.slice(0, limit) : out;
}

// ─── Who a message is for ───────────────────────────────────────────────────

/** The orchestrator answers to his role alias and his real id; fold both onto
 *  the real id (when known) so his row is one row. */
export function canonicalParty(id: string, godId: string | null | undefined): string {
  if (godId && id === GOD_ALIAS) return godId;
  return id;
}

export function isFromHuman(m: Pick<InboxMessage, 'from'>): boolean {
  return m.from === HUMAN;
}

/** Addressed to the human, or flagged for them by the sender. */
export function isToHuman(m: Pick<InboxMessage, 'from' | 'to' | 'needsHuman'>): boolean {
  if (m.from === HUMAN) return false;
  return m.to === HUMAN || m.needsHuman;
}

/**
 * The agent whose Inbox row a message belongs to, or null when it is not
 * between the human and one agent (agent↔agent traffic, a human broadcast,
 * harness notices). Those still show under Everyone.
 */
export function agentOf(m: Pick<InboxMessage, 'from' | 'to' | 'needsHuman'>, godId?: string | null): string | null {
  if (isFromHuman(m)) {
    const to = canonicalParty(m.to, godId);
    return to === HUMAN || to === BROADCAST || to === SYSTEM || !to ? null : to;
  }
  if (isToHuman(m)) {
    const from = canonicalParty(m.from, godId);
    return from === SYSTEM || from === HUMAN || !from ? null : from;
  }
  return null;
}

/** Every human-involving message, grouped under its agent, oldest first within
 *  an agent (a conversation reads downward). */
export function groupByAgent(messages: InboxMessage[], godId?: string | null): Map<string, InboxMessage[]> {
  const out = new Map<string, InboxMessage[]>();
  for (const m of messages) {
    const agent = agentOf(m, godId);
    if (!agent) continue;
    const list = out.get(agent);
    if (list) list.push(m);
    else out.set(agent, [m]);
  }
  for (const list of out.values()) list.sort((a, b) => compareNewestFirst(b, a));
  return out;
}

const ms = (iso: string | undefined | null): number => {
  if (!iso) return Number.NaN;
  return Date.parse(iso);
};

/**
 * Ids of the messages that still wait on the human's reply: a request,
 * query or proposal addressed `to: "human"` (the "→ You · needs a reply"
 * state), with no answer from the human yet. An answer is any message from the
 * human that names it in `in_reply_to`, or that comes later in the same
 * conversation — replying to the newest message in a thread answers the
 * thread.
 *
 * A message only FLAGGED for the human (`needs_human` on mail to the
 * orchestrator) is "about you", not a request to you: the orchestrator owns
 * the answer, so it never needs YOUR reply.
 */
export function pendingReplyIds(messages: InboxMessage[]): Set<string> {
  const answeredIds = new Set<string>();
  // Latest human message time per conversation.
  const humanLatest = new Map<string, number>();
  for (const m of messages) {
    if (!isFromHuman(m)) continue;
    if (m.inReplyTo) answeredIds.add(m.inReplyTo);
    const t = ms(m.createdAt);
    if (Number.isNaN(t)) continue;
    const prev = humanLatest.get(m.conversation);
    if (prev === undefined || t > prev) humanLatest.set(m.conversation, t);
  }
  const out = new Set<string>();
  for (const m of messages) {
    if (m.to !== HUMAN || isFromHuman(m) || !m.requiresReply) continue;
    if (answeredIds.has(m.id)) continue;
    const last = humanLatest.get(m.conversation);
    const t = ms(m.createdAt);
    if (last !== undefined && !Number.isNaN(t) && last >= t) continue;
    out.add(m.id);
  }
  return out;
}

// ─── Unread ─────────────────────────────────────────────────────────────────

/** Read-state key for the global baseline: the moment this hive's Inbox was
 *  first opened. Mail older than that was never "new" to this screen, so a
 *  first visit does not light up months of history as unread. */
export const BASELINE_MARK = '*';

/** Read watermarks (ISO times) by section key, plus BASELINE_MARK. */
export type ReadMarks = Record<string, string>;

/** The time at or before which everything in `key` counts as read. */
export function watermark(marks: ReadMarks | null | undefined, key: string): number {
  const own = ms(marks?.[key]);
  const base = ms(marks?.[BASELINE_MARK]);
  const vals = [own, base].filter((v) => !Number.isNaN(v));
  return vals.length ? Math.max(...vals) : Number.NEGATIVE_INFINITY;
}

/** Unread = mail TO the human that arrived after the section was last read.
 *  Your own messages are never unread, and neither is agent↔agent chatter. */
export function isUnread(m: InboxMessage, mark: number): boolean {
  if (!isToHuman(m)) return false;
  const t = ms(m.createdAt);
  return !Number.isNaN(t) && t > mark;
}

/** The newest createdAt in a list, as an ISO string — what opening a section
 *  moves its watermark to. Null for an empty list. */
export function newestAt(messages: InboxMessage[]): string | null {
  let best = Number.NEGATIVE_INFINITY;
  let iso: string | null = null;
  for (const m of messages) {
    const t = ms(m.createdAt);
    if (!Number.isNaN(t) && t > best) { best = t; iso = m.createdAt; }
  }
  return iso;
}

// ─── Agent rows ─────────────────────────────────────────────────────────────

export interface AgentInboxSummary {
  agentId: string;
  /** Messages between this agent and the human. */
  count: number;
  unread: number;
  /** Requests from this agent still waiting on the human's reply. */
  needsReply: number;
  /** The newest message either way, for the row's preview line. */
  latest: InboxMessage | null;
}

/**
 * One summary per agent that has exchanged mail with the human. Rows with a
 * pending reply come first, then unread, then newest activity — the order the
 * eye should travel down the list.
 */
export function summarizeAgents(
  messages: InboxMessage[],
  godId: string | null | undefined,
  marks: ReadMarks | null | undefined,
  sectionKey: (agentId: string) => string
): AgentInboxSummary[] {
  const groups = groupByAgent(messages, godId);
  const pending = pendingReplyIds(messages);
  const rows: AgentInboxSummary[] = [];
  for (const [agentId, list] of groups) {
    const mark = watermark(marks, sectionKey(agentId));
    let unread = 0;
    let needsReply = 0;
    for (const m of list) {
      if (isUnread(m, mark)) unread += 1;
      if (pending.has(m.id)) needsReply += 1;
    }
    rows.push({ agentId, count: list.length, unread, needsReply, latest: list[list.length - 1] ?? null });
  }
  return rows.sort((a, b) => {
    if ((a.needsReply > 0) !== (b.needsReply > 0)) return a.needsReply > 0 ? -1 : 1;
    if ((a.unread > 0) !== (b.unread > 0)) return a.unread > 0 ? -1 : 1;
    return compareNewestFirst(a.latest ?? { createdAt: '' }, b.latest ?? { createdAt: '' });
  });
}

// ─── Threads ────────────────────────────────────────────────────────────────

export interface InboxThread {
  conversation: string;
  /** The first message's subject (replies are "Re: …"). */
  subject: string;
  /** Oldest first. */
  messages: InboxMessage[];
  latestAt: string;
}

/** Fold messages into conversations, newest activity first. */
export function groupThreads(messages: InboxMessage[]): InboxThread[] {
  const by = new Map<string, InboxMessage[]>();
  for (const m of messages) {
    const list = by.get(m.conversation);
    if (list) list.push(m);
    else by.set(m.conversation, [m]);
  }
  const threads: InboxThread[] = [];
  for (const [conversation, list] of by) {
    const sorted = [...list].sort((a, b) => compareNewestFirst(b, a));
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    threads.push({
      conversation,
      subject: sorted.find((m) => m.subject.trim())?.subject ?? first.subject,
      messages: sorted,
      latestAt: last.createdAt
    });
  }
  return threads.sort((a, b) => compareNewestFirst({ createdAt: a.latestAt }, { createdAt: b.latestAt }));
}

/** The subject a reply goes out with: one "Re: " however deep the thread is. */
export function replySubject(subject: string): string {
  const base = subject.replace(/^(?:\s*re:\s*)+/i, '').trim();
  return base ? `Re: ${base}` : 'Re:';
}

// ─── Search ─────────────────────────────────────────────────────────────────

export interface InboxSearch {
  /** Free-text terms (lower-cased); every one must match. Quoted phrases stay whole. */
  terms: string[];
  /** `from:x` — sender id or name contains x. Any of them may match. */
  from: string[];
  /** `to:x` — recipient id or name contains x. */
  to: string[];
  /** `is:request` / `act:query` — the message act. */
  acts: InboxAct[];
}

/** Split a query into terms and `from:` / `to:` / `is:` filters. A filter with
 *  an empty value (`from:`) is kept as plain text, so typing never hides
 *  everything mid-word. */
export function parseSearch(query: string): InboxSearch {
  const out: InboxSearch = { terms: [], from: [], to: [], acts: [] };
  const re = /"([^"]*)"|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(query)) !== null) {
    if (match[1] !== undefined) {
      const phrase = match[1].trim().toLowerCase();
      if (phrase) out.terms.push(phrase);
      continue;
    }
    const token = match[2];
    const filter = /^(from|to|is|act):(.+)$/i.exec(token);
    if (filter) {
      const key = filter[1].toLowerCase();
      const value = filter[2].replace(/^"|"$/g, '').toLowerCase();
      if (key === 'from') { out.from.push(value); continue; }
      if (key === 'to') { out.to.push(value); continue; }
      if ((INBOX_ACTS as readonly string[]).includes(value)) { out.acts.push(value as InboxAct); continue; }
    }
    out.terms.push(token.toLowerCase());
  }
  return out;
}

export function isEmptySearch(q: InboxSearch): boolean {
  return !q.terms.length && !q.from.length && !q.to.length && !q.acts.length;
}

/** Display name for a party id; the identity when unknown. */
export type NameOf = (id: string) => string;

function partyMatches(id: string, wanted: string[], nameOf: NameOf): boolean {
  if (!wanted.length) return true;
  const hay = `${id}\u0000${nameOf(id)}`.toLowerCase();
  return wanted.some((w) => hay.includes(w));
}

export function matchesSearch(m: InboxMessage, q: InboxSearch, nameOf: NameOf = (id) => id): boolean {
  if (q.acts.length && !q.acts.includes(m.act)) return false;
  if (!partyMatches(m.from, q.from, nameOf)) return false;
  if (!partyMatches(m.to, q.to, nameOf)) return false;
  if (!q.terms.length) return true;
  const hay = [m.subject, m.body, m.from, nameOf(m.from), m.to, nameOf(m.to), m.act].join('\n').toLowerCase();
  return q.terms.every((t) => hay.includes(t));
}

/** Filter, keeping the caller's order. An empty query returns the list as is. */
export function searchMessages(messages: InboxMessage[], query: string, nameOf?: NameOf): InboxMessage[] {
  const q = parseSearch(query);
  if (isEmptySearch(q)) return messages;
  return messages.filter((m) => matchesSearch(m, q, nameOf));
}

// ─── What goes over the wire ────────────────────────────────────────────────

/**
 * The slice of the floor's mail main sends: the newest `limit` messages, plus
 * every message between the human and an agent (newest `humanLimit` of them)
 * even when it is older than that window — an agent's row and the "needs a
 * reply" state must not depend on how chatty the rest of the floor has been.
 * Input and output are newest first.
 */
export function selectForWire(all: InboxMessage[], limit: number, humanLimit: number): InboxMessage[] {
  const head = all.slice(0, Math.max(0, limit));
  if (all.length <= head.length) return head;
  const ids = new Set(head.map((m) => m.id));
  const extra: InboxMessage[] = [];
  let human = head.filter((m) => isFromHuman(m) || isToHuman(m)).length;
  for (let i = head.length; i < all.length && human < humanLimit; i++) {
    const m = all[i];
    if (ids.has(m.id) || !(isFromHuman(m) || isToHuman(m))) continue;
    extra.push(m);
    human += 1;
  }
  return extra.length ? [...head, ...extra] : head;
}

// ─── The agent rows of the left list ────────────────────────────────────────

export interface AgentRow {
  agentId: string;
  summary: AgentInboxSummary | null;
  /** Open Ask me questions on cards this agent owns. */
  asks: number;
  /** Something here waits on the human: an open ask or a request to answer. */
  needsYou: boolean;
  /** Newest activity (epoch ms), mail or ask; -Infinity when none. */
  latestAt: number;
}

/**
 * One row per agent: everyone on the roster (in roster order, the
 * orchestrator first as the roster already has him) plus anyone else who has
 * mail with the human (an archived agent, a finished worker).
 *
 * Order: rows that need you, then rows with unread mail, then any activity,
 * newest first; then the quiet roster in roster order. The eye reads down
 * from what is waiting to who is merely present.
 */
export function buildAgentRows(
  roster: string[],
  summaries: AgentInboxSummary[],
  asks: ReadonlyMap<string, { count: number; latestAt: number }>
): AgentRow[] {
  const bySummary = new Map(summaries.map((s) => [s.agentId, s]));
  const ids: string[] = [];
  const seen = new Set<string>();
  const push = (id: string) => { if (!seen.has(id)) { seen.add(id); ids.push(id); } };
  roster.forEach(push);
  summaries.forEach((s) => push(s.agentId));
  asks.forEach((_v, id) => push(id));

  const rows = ids.map<AgentRow & { rosterIndex: number }>((agentId) => {
    const summary = bySummary.get(agentId) ?? null;
    const ask = asks.get(agentId);
    const mailAt = summary?.latest ? Date.parse(summary.latest.createdAt) : Number.NaN;
    const latestAt = Math.max(
      Number.isNaN(mailAt) ? Number.NEGATIVE_INFINITY : mailAt,
      ask && Number.isFinite(ask.latestAt) ? ask.latestAt : Number.NEGATIVE_INFINITY
    );
    return {
      agentId,
      summary,
      asks: ask?.count ?? 0,
      needsYou: (ask?.count ?? 0) > 0 || (summary?.needsReply ?? 0) > 0,
      latestAt,
      rosterIndex: roster.indexOf(agentId)
    };
  });

  const tier = (r: AgentRow): number => {
    if (r.needsYou) return 0;
    if ((r.summary?.unread ?? 0) > 0) return 1;
    if (r.summary || r.asks) return 2;
    return 3;
  };
  rows.sort((a, b) => {
    const ta = tier(a);
    const tb = tier(b);
    if (ta !== tb) return ta - tb;
    if (ta === 3) return a.rosterIndex - b.rosterIndex;
    if (a.latestAt !== b.latestAt) return b.latestAt - a.latestAt;
    return a.rosterIndex - b.rosterIndex;
  });
  return rows.map(({ rosterIndex: _rosterIndex, ...row }) => row);
}
