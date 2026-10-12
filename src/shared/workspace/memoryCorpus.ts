/**
 * Turning the floor's files into searchable units — pure, so main's scanner and
 * the tests share it.
 *
 *   memory.md / board.md / a note → one unit per markdown section (agents
 *     append dated `## 2026-10-06 — title` entries, so a section IS a note)
 *   tasks.json                    → one unit per ticket
 *
 * Plus the small graph helpers the grouping needs: which tickets a note names,
 * which agent a free-text assignee means, and the topic count in the header.
 */
import type { MemoryAgentInfo } from './memoryTypes';

// ─── Markdown sections ──────────────────────────────────────────────────────

export interface MdSection {
  /** Position among the file's sections, counting the preamble as 0 when it
   *  has content. Stable for an unchanged file — a note ref stores it. */
  index: number;
  /** Heading text without the hashes ('' for the preamble). */
  heading: string;
  /** 0 for the preamble. */
  level: number;
  body: string;
}

/** The line ensureAgent seeds every memory.md with — boilerplate, not a note. */
const SEED_LINE = /^_?append durable facts, decisions, and context below\._?$/i;
const FENCE = /^\s{0,3}(```|~~~)/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;

/**
 * Split markdown into sections at headings of level >= `minLevel` (so a
 * memory file's single `# Memory — Jim` title does not swallow everything).
 * Headings inside fenced code blocks are text, not structure. Sections that
 * hold nothing but the seeded boilerplate are dropped.
 */
export function splitSections(md: string, opts: { minLevel?: number; maxSections?: number } = {}): MdSection[] {
  const minLevel = opts.minLevel ?? 2;
  const maxSections = opts.maxSections ?? 2000;
  const lines = md.split(/\r?\n/);
  const raw: Array<{ heading: string; level: number; lines: string[] }> = [{ heading: '', level: 0, lines: [] }];
  let inFence = false;
  for (const line of lines) {
    if (FENCE.test(line)) inFence = !inFence;
    const m = !inFence ? HEADING.exec(line) : null;
    if (m && m[1].length >= minLevel && raw.length < maxSections) {
      raw.push({ heading: m[2].trim(), level: m[1].length, lines: [] });
      continue;
    }
    // A level-1 title above the split level is the file's name, not content.
    if (m && m[1].length < minLevel && raw.length === 1 && !raw[0].lines.some((l) => l.trim())) continue;
    raw[raw.length - 1].lines.push(line);
  }
  const out: MdSection[] = [];
  raw.forEach((s, i) => {
    const body = s.lines.filter((l) => !SEED_LINE.test(l.trim())).join('\n').trim();
    if (!body && (i === 0 || !s.heading)) return;
    out.push({ index: i, heading: s.heading, level: s.level, body });
  });
  return out;
}

const DATE_IN_HEADING = /(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?/;

/** A date written in a heading ('2026-10-06', '2026-10-06 14:30'), as ISO
 *  ('2026-10-06' or '2026-10-06T14:30'). Undefined when there is none or it
 *  is not a real calendar date. */
export function headingDate(heading: string): string | undefined {
  const m = DATE_IN_HEADING.exec(heading);
  if (!m) return undefined;
  const [, y, mo, d, h, mi] = m;
  const month = Number(mo);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  const probe = new Date(Date.UTC(Number(y), month - 1, day));
  if (probe.getUTCMonth() !== month - 1) return undefined; // 2026-02-31
  if (h !== undefined && mi !== undefined && Number(h) < 24 && Number(mi) < 60) {
    return `${y}-${mo}-${d}T${h.padStart(2, '0')}:${mi}`;
  }
  return `${y}-${mo}-${d}`;
}

/** Strip markdown emphasis, links and code ticks to plain text. */
export function plainInline(s: string): string {
  return s
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** What a section is called on screen: its heading without the leading date
 *  and separators, or — for an untitled section — its first line. */
export function sectionTitle(section: Pick<MdSection, 'heading' | 'body'>, max = 120): string {
  let title = plainInline(section.heading.replace(DATE_IN_HEADING, '')).replace(/^[\s—–\-:·|,]+|[\s—–\-:·|,]+$/g, '');
  if (!title) {
    const first = section.body.split(/\r?\n/).map((l) => plainInline(l.replace(/^\s*([#>]+|[-*+]|\d+[.)])\s+/, ''))).find(Boolean) ?? '';
    title = first;
  }
  if (title.length > max) title = `${title.slice(0, max - 1).trimEnd()}…`;
  return title;
}

// ─── Topics ─────────────────────────────────────────────────────────────────

/** Headings and bold phrases too generic to count as a topic of their own. */
const TOPIC_STOP = new Set([
  'update', 'updates', 'done', 'note', 'notes', 'next', 'open', 'todo', 'todos', 'fixed', 'resolved',
  'wip', 'status', 'context', 'memory', 'summary', 'decision', 'decisions', 'plan', 'plans', 'task',
  'tasks', 'phase', 'why', 'how', 'what', 'gap', 'gaps', 'needed', 'important', 'fact', 'facts',
  'learned', 'learnings', 'lessons', 'log', 'misc', 'other', 'notes to self', 'next steps', 'hive board'
]);

function normaliseTopic(raw: string): string {
  return plainInline(raw.replace(DATE_IN_HEADING, ''))
    .replace(/\(.*?\)/g, '')
    .replace(/^[\s—–\-:·|,#]+|[\s—–\-:·|,.;!?#]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function usableTopic(norm: string): boolean {
  if (norm.length < 3 || norm.length > 60) return false;
  if (TOPIC_STOP.has(norm)) return false;
  if (/^[\d\s\-—.:/]+$/.test(norm)) return false;
  return /[\p{L}]/u.test(norm);
}

/**
 * Add a document's topics — its section headings and **bold** key terms,
 * normalised — to `into`. The header's "N topics" is the size of that set
 * across every memory file, the board and the user's notes: what the floor
 * has written down as a subject, counted once however many agents wrote it.
 */
export function collectTopics(md: string, into: Set<string>, cap = 50_000): void {
  let inFence = false;
  for (const line of md.split(/\r?\n/)) {
    if (into.size >= cap) return;
    if (FENCE.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const h = HEADING.exec(line);
    if (h && h[1].length >= 2) {
      const n = normaliseTopic(h[2]);
      if (usableTopic(n)) into.add(n);
    }
    for (const m of line.matchAll(/\*\*([^*]{2,80})\*\*/g)) {
      const n = normaliseTopic(m[1]);
      if (usableTopic(n)) into.add(n);
    }
  }
}

// ─── The task ledger ────────────────────────────────────────────────────────

export interface TicketUnit {
  id: string;
  title: string;
  status?: string;
  /** Raw people values from the card (assignee first), unresolved. */
  people: string[];
  at?: string;
  /** Every searchable text field on the card, one per paragraph. */
  body: string;
}

/** Text fields the god writes on a card that are worth searching. An
 *  allowlist, not "every string": a card can also carry a webhook token hash
 *  and Slack thread ids, which are nobody's search result. */
const TICKET_TEXT_FIELDS = [
  'description', 'result', 'summary', 'outcome', 'notes', 'blockedOn', 'scope', 'deliverable',
  'repo', 'origin', 'commit', 'branch', 'pr'
];
const TICKET_PEOPLE_FIELDS = ['assignee', 'owner', 'createdBy', 'reviewer', 'from', 'by'];
const TICKET_TIME_FIELDS = ['updatedAt', 'completedAt', 'doneAt', 'createdAt'];
const MAX_FIELD_CHARS = 20_000;

/** The renderer's fallback id for a card that has none (TasksKanban's
 *  `stableId`): djb2 over `title|createdAt|index`, base36. Reproduced
 *  exactly so a search result opens the same card the board shows. */
export function stableTaskId(seed: string): string {
  let h = 5381;
  for (let i = 0; i < seed.length; i++) h = (((h << 5) + h) ^ seed.charCodeAt(i)) | 0;
  return `t-${(h >>> 0).toString(36)}`;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);

/** Every card in a parsed tasks.json, as a searchable unit. Never throws. */
export function ticketUnits(ledger: unknown, maxTickets = 5000): TicketUnit[] {
  const list = ledger && typeof ledger === 'object' && Array.isArray((ledger as { tasks?: unknown }).tasks)
    ? (ledger as { tasks: unknown[] }).tasks
    : [];
  const out: TicketUnit[] = [];
  list.slice(0, maxTickets).forEach((raw, i) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
    const t = raw as Record<string, unknown>;
    const title = str(t.title) ?? '(untitled)';
    const createdAt = typeof t.createdAt === 'string' ? t.createdAt : '';
    const id = str(t.id) ?? stableTaskId(`${typeof t.title === 'string' ? t.title : ''}|${createdAt}|${i}`);
    const parts: string[] = [];
    for (const f of TICKET_TEXT_FIELDS) {
      const v = str(t[f]);
      if (v) parts.push(v.slice(0, MAX_FIELD_CHARS));
    }
    if (Array.isArray(t.humanQA)) {
      for (const qa of t.humanQA.slice(0, 50)) {
        if (!qa || typeof qa !== 'object') continue;
        const q = str((qa as Record<string, unknown>).q);
        const a = str((qa as Record<string, unknown>).a);
        if (q) parts.push(q.slice(0, MAX_FIELD_CHARS));
        if (a) parts.push(a.slice(0, MAX_FIELD_CHARS));
      }
    }
    const people: string[] = [];
    for (const f of TICKET_PEOPLE_FIELDS) {
      const v = str(t[f]);
      if (v && !people.includes(v.trim())) people.push(v.trim());
    }
    let at: string | undefined;
    for (const f of TICKET_TIME_FIELDS) {
      const v = str(t[f]);
      if (v && !Number.isNaN(Date.parse(v))) { at = v; break; }
    }
    out.push({ id, title, status: str(t.status), people, at, body: parts.join('\n\n') });
  });
  return out;
}

// ─── Graph edges ────────────────────────────────────────────────────────────

const ID_CHAR = /[\p{L}\p{N}_-]/u;

/**
 * Ticket ids from `ids` that `text` names, as whole tokens and in the order
 * given. Case-insensitive. Ids shorter than three characters are ignored —
 * they would match everywhere.
 */
export function findTicketRefs(text: string, ids: readonly string[], max = 12): string[] {
  if (!text || !ids.length) return [];
  const hay = text.toLowerCase();
  const out: string[] = [];
  for (const id of ids) {
    if (out.length >= max) break;
    if (id.length < 3) continue;
    const needle = id.toLowerCase();
    let from = 0;
    for (;;) {
      const i = hay.indexOf(needle, from);
      if (i < 0) break;
      const before = i > 0 ? hay[i - 1] : '';
      const after = hay[i + needle.length] ?? '';
      if ((!before || !ID_CHAR.test(before)) && (!after || !ID_CHAR.test(after))) {
        out.push(id);
        break;
      }
      from = i + 1;
    }
  }
  return out;
}

/** Normalise an id or a palace wing name for comparison: MemPalace may store
 *  a wing with underscores where the agent id had hyphens. */
export function wingKey(s: string): string {
  return s.trim().toLowerCase().replace(/[\s-]+/g, '_');
}

/**
 * Which agent a free-text people field means: an exact id, then a
 * case-insensitive name, then a wing-normalised id. Undefined for "human",
 * "you" and anyone not on the floor.
 */
export function resolveAgent(value: string, agents: readonly MemoryAgentInfo[]): string | undefined {
  const v = value.trim().replace(/^@/, '');
  if (!v) return undefined;
  const byId = agents.find((a) => a.id === v);
  if (byId) return byId.id;
  const lower = v.toLowerCase();
  const byName = agents.find((a) => a.name.toLowerCase() === lower);
  if (byName) return byName.id;
  const key = wingKey(v);
  return agents.find((a) => wingKey(a.id) === key)?.id;
}
