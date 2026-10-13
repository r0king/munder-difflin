/**
 * Answers in three shapes: the tickets, the agents who worked on them, and
 * their notes.
 *
 * A search lane produces flat hits — tickets that matched, notes that matched,
 * agents matched by name or role. This folds them into the answer the screen
 * shows, following the edges between them:
 *
 *   note  → ticket   a matching note that names a ticket id pulls that ticket
 *                    in (marked `mentioned`), and its author onto the ticket;
 *   ticket → agent   everyone on a matching ticket is an agent of the answer;
 *   note  → agent    so is every matching note's author.
 *
 * An agent's rank is what they matched directly plus a diminishing share of
 * every ticket and note they are part of, so the agent who wrote most of what
 * matched comes first — not merely the one whose name contains the word.
 */
import type {
  AgentHit,
  AnswerAgent,
  AnswerTicket,
  MemoryAgentInfo,
  MemoryAnswer,
  NoteHit,
  TicketHit
} from './memoryTypes';

/** What the grouping needs to know about a ticket it only found by mention. */
export interface LedgerTicket {
  id: string;
  title: string;
  status?: string;
  agentIds: string[];
  at?: string;
}

export interface GroupInput {
  tickets: readonly TicketHit[];
  notes: readonly NoteHit[];
  agents: readonly AgentHit[];
  /** The whole ledger by id, to resolve tickets that notes mention. */
  ledger: ReadonlyMap<string, LedgerTicket>;
  /** The floor's agents (registry), to label and to filter unknown ids. */
  people: readonly MemoryAgentInfo[];
  caps?: { tickets?: number; agents?: number; notes?: number };
}

export const DEFAULT_CAPS = { tickets: 30, agents: 20, notes: 60 } as const;

/** Share of a ticket's / note's score credited to each agent on it. */
const AGENT_SHARE = 0.6;
/** A ticket found only because a matching note names it ranks below the note. */
const MENTION_SHARE = 0.5;

const byTime = (a?: string, b?: string): number => {
  const ta = a ? Date.parse(a) : NaN;
  const tb = b ? Date.parse(b) : NaN;
  return (Number.isNaN(tb) ? 0 : tb) - (Number.isNaN(ta) ? 0 : ta);
};

const round = (n: number): number => Math.round(n * 1000) / 1000;

export function groupAnswer(input: GroupInput): MemoryAnswer {
  const caps = { ...DEFAULT_CAPS, ...(input.caps ?? {}) };
  const known = new Map(input.people.map((p) => [p.id, p] as const));
  const isKnown = (id: string | undefined): id is string => !!id && known.has(id);

  // Notes: best first, then newest.
  const notes = [...input.notes].sort((a, b) => b.score - a.score || byTime(a.at, b.at) || a.title.localeCompare(b.title));

  // Tickets: the direct hits, then whatever the notes point at.
  const tickets = new Map<string, AnswerTicket>();
  for (const t of input.tickets) {
    const prev = tickets.get(t.id);
    if (prev && prev.score >= t.score) continue;
    tickets.set(t.id, { ...t, agentIds: t.agentIds.filter(isKnown), mentioned: false });
  }
  const addAgent = (ticket: AnswerTicket, id: string | undefined): void => {
    if (isKnown(id) && !ticket.agentIds.includes(id)) ticket.agentIds.push(id);
  };
  for (const n of notes) {
    for (const ref of n.ticketRefs) {
      let t = tickets.get(ref);
      if (!t) {
        const l = input.ledger.get(ref);
        if (!l) continue;
        t = {
          kind: 'ticket', id: l.id, title: l.title, status: l.status, at: l.at,
          agentIds: l.agentIds.filter(isKnown), score: 0, mentioned: true
        };
        tickets.set(ref, t);
      }
      if (t.mentioned) t.score = round(Math.max(t.score, n.score * MENTION_SHARE));
      addAgent(t, n.authorId);
    }
  }
  const ticketList = [...tickets.values()].sort(
    (a, b) => b.score - a.score || Number(a.mentioned) - Number(b.mentioned) || byTime(a.at, b.at) || a.id.localeCompare(b.id)
  );

  // Agents: direct matches plus a share of everything they are part of.
  interface Acc { direct: boolean; tickets: Set<string>; notes: number; parts: number[]; snippet?: AgentHit['snippet'] }
  const agents = new Map<string, Acc>();
  const acc = (id: string): Acc => {
    let a = agents.get(id);
    if (!a) { a = { direct: false, tickets: new Set(), notes: 0, parts: [] }; agents.set(id, a); }
    return a;
  };
  for (const h of input.agents) {
    if (!isKnown(h.id)) continue;
    const a = acc(h.id);
    a.direct = true;
    a.parts.push(h.score);
    if (h.snippet && !a.snippet) a.snippet = h.snippet;
  }
  for (const t of ticketList) {
    for (const id of t.agentIds) {
      const a = acc(id);
      if (!a.tickets.has(t.id)) { a.tickets.add(t.id); a.parts.push(t.score * AGENT_SHARE); }
    }
  }
  for (const n of notes) {
    if (!isKnown(n.authorId)) continue;
    const a = acc(n.authorId);
    a.notes += 1;
    a.parts.push(n.score * AGENT_SHARE);
  }
  const agentList: AnswerAgent[] = [...agents.entries()].map(([id, a]) => {
    // Diminishing returns: the 1st contribution counts in full, the 2nd half,
    // the 3rd a third… so ten weak mentions do not outrank one strong match.
    const parts = a.parts.sort((x, y) => y - x);
    const score = parts.reduce((s, p, i) => s + p / (i + 1), 0);
    const out: AnswerAgent = { kind: 'agent', id, direct: a.direct, tickets: a.tickets.size, notes: a.notes, score: round(score) };
    if (a.snippet) out.snippet = a.snippet;
    return out;
  });
  agentList.sort((a, b) => b.score - a.score || (known.get(a.id)?.name ?? a.id).localeCompare(known.get(b.id)?.name ?? b.id));

  const result: MemoryAnswer = {
    tickets: ticketList.slice(0, caps.tickets),
    agents: agentList.slice(0, caps.agents),
    notes: notes.slice(0, caps.notes),
    people: [],
    totals: { tickets: ticketList.length, agents: agentList.length, notes: notes.length }
  };
  const named = new Set<string>();
  for (const t of result.tickets) for (const id of t.agentIds) named.add(id);
  for (const a of result.agents) named.add(a.id);
  for (const n of result.notes) if (n.authorId) named.add(n.authorId);
  result.people = [...named].map((id) => known.get(id)).filter((p): p is MemoryAgentInfo => !!p);
  return result;
}
