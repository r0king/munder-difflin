/**
 * The Memory screen's contract — what crosses `feat:memory:*` between main and
 * the renderer.
 *
 * Two searches run side by side over the same floor:
 *
 *   exact   — the literal words, scanned in main over every agent's memory.md,
 *             the task ledger, the board, the user's notes and (when it is on)
 *             the knowledge graph.
 *   meaning — MemPalace's semantic search over the palace the mine loop builds
 *             from those same memory.md files.
 *
 * Both lanes answer in the same three shapes — the tickets, the agents who
 * worked on them, and their notes — so the screen renders one component for
 * either, and "send these to an agent" builds its context block from either.
 *
 * Plain JSON throughout: everything here is structured-cloned over IPC.
 */

export type MemoryLane = 'exact' | 'meaning';
export type MemoryShape = 'ticket' | 'agent' | 'note';

/** A short excerpt plus the [start, end) ranges inside it that matched the
 *  query, so the renderer can emphasise them without ever parsing markup. */
export interface MemorySnippet {
  text: string;
  marks: Array<[number, number]>;
}

/** Where a note came from — decides its label, its author line and how it opens. */
export type MemoryNoteSource = 'memory' | 'board' | 'notes' | 'knowledge' | 'palace';

/** How to fetch a note's full text again (`feat:memory:readNote`). Every field
 *  is validated in main; none of them is ever used as a path on its own. */
export type MemoryNoteRef =
  | { kind: 'memory'; agentId: string; section: number; heading?: string }
  | { kind: 'board'; section: number; heading?: string }
  | { kind: 'notes'; file: string }
  | { kind: 'knowledge'; docId: string }
  | { kind: 'palace'; wing: string; room: string; source: string };

/** One ticket from the ledger. */
export interface TicketHit {
  kind: 'ticket';
  id: string;
  title: string;
  status?: string;
  /** Agent ids that worked on it, resolved from the card's own people fields
   *  (assignee first). Note authors are added during grouping. */
  agentIds: string[];
  /** ISO timestamp of the card's last known change. */
  at?: string;
  score: number;
  snippet?: MemorySnippet;
}

/** One note — a dated section of an agent's memory.md, a board section, a
 *  user note, a knowledge-graph document, or a MemPalace drawer. */
export interface NoteHit {
  kind: 'note';
  /** Stable key, unique within a lane's answer (selection survives a re-run). */
  key: string;
  source: MemoryNoteSource;
  title: string;
  /** The agent who wrote it; undefined for the user's own notes and documents. */
  authorId?: string;
  /** ISO date/time of the entry (a dated heading, or the file's mtime). */
  at?: string;
  /** Absolute path of the file it lives in, when there is one. Listed in the
   *  context block so the receiving agent can read the whole thing. */
  path?: string;
  ref: MemoryNoteRef;
  /** Ticket ids from the ledger that this note mentions. */
  ticketRefs: string[];
  score: number;
  snippet: MemorySnippet;
}

/** An agent matched directly, by name, id or role. */
export interface AgentHit {
  kind: 'agent';
  id: string;
  score: number;
  snippet?: MemorySnippet;
}

/** The people side of the floor, keyed by agent id, as main knows it from the
 *  hive registry. The renderer prefers its own live names when it has them. */
export interface MemoryAgentInfo {
  id: string;
  name: string;
  role?: string;
  isGod?: boolean;
  archived?: boolean;
}

/** A ticket in an answer. `mentioned` = not matched itself, but a matching
 *  note names it — the edge that makes the answer a graph rather than a list. */
export interface AnswerTicket extends TicketHit {
  mentioned: boolean;
}

/** An agent in an answer, with why they are in it. */
export interface AnswerAgent {
  kind: 'agent';
  id: string;
  /** Matched by name, id or role. */
  direct: boolean;
  /** How many of the answer's tickets / notes involve them. */
  tickets: number;
  notes: number;
  score: number;
  snippet?: MemorySnippet;
}

export interface MemoryAnswer {
  tickets: AnswerTicket[];
  agents: AnswerAgent[];
  notes: NoteHit[];
  /** Everyone the answer names, so the renderer can label an id it does not
   *  have on its roster (an archived agent, a renamed one). */
  people: MemoryAgentInfo[];
  /** Totals before the per-shape caps. */
  totals: { tickets: number; agents: number; notes: number };
}

// ─── IPC payloads ───────────────────────────────────────────────────────────

/** Why a lane has nothing to show, when it is not simply "no matches". */
export type MemoryLaneState =
  | 'ok'
  | 'no-hive'          // no hive open yet (before onboarding)
  | 'not-installed'    // meaning: the mempalace CLI is not on this machine
  | 'disabled'         // meaning: semantic memory is switched off in settings
  | 'not-ready'        // meaning: the palace has not been built yet
  | 'superseded'       // meaning: a newer query replaced this one
  | 'error';

export interface MemorySearchResult {
  ok: boolean;
  lane: MemoryLane;
  query: string;
  state: MemoryLaneState;
  answer: MemoryAnswer;
  /** The scan stopped early (time, byte or file budget); results are partial. */
  partial?: boolean;
  /** Free text from MemPalace worth showing (e.g. its "vector search
   *  disabled, run mempalace repair" notice). */
  notice?: string;
  /** MemPalace printed something this build cannot parse: its text, capped,
   *  shown as is rather than dropped. */
  raw?: string;
  error?: string;
  tookMs: number;
}

export interface MemoryStats {
  ok: boolean;
  state: 'ok' | 'no-hive';
  /** Distinct headings and key terms across agents' memory, the board and notes. */
  topics: number;
  tickets: number;
  /** Agents whose memory holds more than the seeded header. */
  agentsWithMemory: number;
  /** Dated entries across every memory.md. */
  entries: number;
  /** The user's own note files. */
  notes: number;
  /** Knowledge-graph documents, when the graph is on (else 0). */
  documents: number;
  partial?: boolean;
}

export interface MemoryNoteText {
  ok: boolean;
  title: string;
  text: string;
  path?: string;
  /** The text was cut at the read cap. */
  truncated?: boolean;
  error?: string;
}

/** `feat:memory:<action>` — declared once, used by main and the preload. */
export const MEMORY_CHANNELS = {
  search: 'feat:memory:search',
  meaning: 'feat:memory:meaning',
  stats: 'feat:memory:stats',
  readNote: 'feat:memory:readNote'
} as const;

/** Hard caps shared by both sides of the bridge. */
export const MEMORY_QUERY_MAX = 200;
export const MEMORY_ID_MAX = 200;
export const MEMORY_NOTE_FILE_MAX = 255;

export function emptyAnswer(): MemoryAnswer {
  return { tickets: [], agents: [], notes: [], people: [], totals: { tickets: 0, agents: 0, notes: 0 } };
}

const isStr = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const isIdx = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 100_000;
const optHeading = (v: unknown): boolean => v === undefined || (typeof v === 'string' && v.length <= 500);

/** Validate an untrusted value (it arrives from the renderer) as a note ref. */
export function isMemoryNoteRef(value: unknown): value is MemoryNoteRef {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  switch (r.kind) {
    case 'memory':
      return isStr(r.agentId, MEMORY_ID_MAX) && isIdx(r.section) && optHeading(r.heading);
    case 'board':
      return isIdx(r.section) && optHeading(r.heading);
    case 'notes':
      return isStr(r.file, MEMORY_NOTE_FILE_MAX);
    case 'knowledge':
      return isStr(r.docId, MEMORY_ID_MAX);
    case 'palace':
      return typeof r.wing === 'string' && typeof r.room === 'string' && typeof r.source === 'string';
    default:
      return false;
  }
}
