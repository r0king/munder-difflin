/**
 * The ticket an agent is on, for the sidebar row's key chip and its hover
 * card — read from the task ledger (hive/tasks.json) as useHiveTasks hands it
 * over: RAW cards, every field hand-written by the orchestrator and therefore
 * untrusted in type. Nothing here assumes a field is the type its name
 * suggests.
 *
 * Pure and import-free so node:test can load it.
 */

/** A raw ledger card — only `id` is guaranteed (useHiveTasks filters on it). */
export interface LedgerCard {
  id: string;
  [key: string]: unknown;
}

export type TicketStatus = 'todo' | 'doing' | 'blocked' | 'done';

const STATUSES: readonly TicketStatus[] = ['todo', 'doing', 'blocked', 'done'];

/** The card's column, defaulting like parseTasks does (unknown → todo). */
export function ticketStatus(card: LedgerCard): TicketStatus {
  return STATUSES.includes(card.status as TicketStatus) ? (card.status as TicketStatus) : 'todo';
}

function ms(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    // Seconds-since-epoch slipped in by hand: anything before 2001 in ms is
    // almost certainly seconds.
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value !== 'string' || !value) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

/** Fields the orchestrator (or a webhook) has been seen to stamp on a card
 *  when it changes. All optional; the newest one present wins. */
const STAMP_FIELDS = [
  'updatedAt', 'updated_at', 'updated', 'movedAt', 'statusChangedAt',
  'startedAt', 'doneAt', 'completedAt', 'blockedAt', 'createdAt', 'created_at'
];

/**
 * When the card last changed, as best the ledger can say: the newest of its
 * timestamp fields and of every question/answer on it. Null when it carries
 * no usable time at all.
 */
export function ticketLastUpdate(card: LedgerCard): number | null {
  let best: number | null = null;
  const consider = (v: unknown) => {
    const t = ms(v);
    if (t !== null && (best === null || t > best)) best = t;
  };
  for (const f of STAMP_FIELDS) consider(card[f]);
  if (Array.isArray(card.humanQA)) {
    for (const e of card.humanQA) {
      if (!e || typeof e !== 'object') continue;
      const qa = e as Record<string, unknown>;
      consider(qa.askedAt);
      consider(qa.answeredAt);
      consider(qa.dismissedAt);
    }
  }
  return best;
}

/** The card's title as one clean line, or '' when it has none. */
export function ticketTitle(card: LedgerCard): string {
  return typeof card.title === 'string' ? card.title.replace(/\s+/g, ' ').trim() : '';
}

/** Who the card is assigned to (an agent id), or null. */
export function ticketAssignee(card: LedgerCard): string | null {
  return typeof card.assignee === 'string' && card.assignee.trim() ? card.assignee.trim() : null;
}

/**
 * A description short enough for a hover card: markdown markers stripped,
 * whitespace collapsed, cut on a word boundary with an ellipsis.
 */
export function descriptionExcerpt(text: unknown, max = 220): string {
  if (typeof text !== 'string') return '';
  const flat = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(?:#{1,6}\s+|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+|>\s?)/gm, '')
    .replace(/[`*_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** Status preference for "the ticket this agent is on": what it is doing now,
 *  then what it is stuck on. To-do and done cards are not "on". */
const ON_RANK: Partial<Record<TicketStatus, number>> = { doing: 0, blocked: 1 };

/**
 * One pass over the ledger: each agent's current ticket. Doing beats blocked;
 * within a status the most recently updated card wins, and with no times at
 * all the LATER card in the ledger (the orchestrator appends) wins.
 */
export function currentTicketsByAgent<C extends LedgerCard>(cards: readonly C[]): Map<string, C> {
  const best = new Map<string, { card: C; rank: number; at: number; index: number }>();
  cards.forEach((card, index) => {
    const who = ticketAssignee(card);
    if (!who) return;
    const rank = ON_RANK[ticketStatus(card)];
    if (rank === undefined) return;
    const at = ticketLastUpdate(card) ?? -1;
    const prev = best.get(who);
    if (
      !prev
      || rank < prev.rank
      || (rank === prev.rank && (at > prev.at || (at === prev.at && index > prev.index)))
    ) {
      best.set(who, { card, rank, at, index });
    }
  });
  const out = new Map<string, C>();
  for (const [who, v] of best) out.set(who, v.card);
  return out;
}

/** How many cards are in Doing — the Tasks nav item's count. */
export function countDoing(cards: readonly LedgerCard[]): number {
  return cards.reduce((n, c) => n + (ticketStatus(c) === 'doing' ? 1 : 0), 0);
}
