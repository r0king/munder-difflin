/**
 * The two lanes, the header stats and note reads — built on FloorCorpus.
 *
 * Kept free of Electron so the module reads as plain Node: the caller (the
 * feature module) supplies the hive root, the knowledge graph and MemPalace.
 */
import { join } from 'node:path';
import { findTicketRefs, headingDate, resolveAgent, sectionTitle, splitSections, wingKey } from '../../../shared/workspace/memoryCorpus';
import { groupAnswer } from '../../../shared/workspace/memoryGroup';
import { parsePalaceOutput } from '../../../shared/workspace/memoryPalace';
import {
  leadSnippet,
  makeSnippet,
  needlesOf,
  parseQuery,
  prepare,
  scoreUnit,
  type ParsedQuery
} from '../../../shared/workspace/memoryQuery';
import {
  emptyAnswer,
  type AgentHit,
  type MemoryNoteRef,
  type MemoryNoteText,
  type MemorySearchResult,
  type MemoryStats,
  type NoteHit,
  type TicketHit
} from '../../../shared/workspace/memoryTypes';
import { FloorCorpus, MAX_MD_BYTES, NOTE_EXTS, ScanBudget, findSection, readCapped, regularFile, type FloorSnapshot } from './corpus';

/** How long one exact scan may take before it answers with what it has. */
export const EXACT_DEADLINE_MS = 4000;
/** Raw notes kept before grouping (grouping caps again per shape). */
const RAW_NOTE_CAP = 300;
/** Knowledge-graph documents read back for a note view. */
const MAX_DOC_CHARS = 200_000;
/** MemPalace results asked for per query. */
export const PALACE_RESULTS = 12;

/** The slice of KnowledgeManager this file uses (src/main/knowledge.ts). */
export interface KnowledgeLike {
  active(): boolean;
  search(query: string, limit?: number): Array<{ docId: string; title: string; source: string; chunkIdx: number; score: number; snippet: string }>;
  get(docId: string): { meta: { title: string }; text: string } | null;
  status(): { enabled: boolean; docCount: number };
}

const SNIPPET = { radius: 90, max: 260 };

function laneResult(lane: 'exact' | 'meaning', query: string, t0: number, patch: Partial<MemorySearchResult>): MemorySearchResult {
  return { ok: false, lane, query, state: 'ok', answer: emptyAnswer(), tookMs: Date.now() - t0, ...patch };
}

// ─── Exact ──────────────────────────────────────────────────────────────────

export async function exactSearch(
  corpus: FloorCorpus,
  root: string | null,
  rawQuery: string,
  knowledge: KnowledgeLike | null
): Promise<MemorySearchResult> {
  const t0 = Date.now();
  const q = parseQuery(rawQuery);
  if (!q) return laneResult('exact', rawQuery, t0, { state: 'error', error: 'empty query' });
  if (!root) return laneResult('exact', q.raw, t0, { state: 'no-hive' });

  const budget = new ScanBudget(t0 + EXACT_DEADLINE_MS);
  const needles = needlesOf(q);
  const agentFiles = await corpus.agentFiles(root);
  const floor = await corpus.snapshot(root, budget, agentFiles);

  // Tickets.
  const tickets: TicketHit[] = [];
  for (const t of floor.tickets) {
    const score = scoreUnit(q, t.head, t.body);
    if (score <= 0) continue;
    const ledger = floor.ledger.get(t.id);
    const hit: TicketHit = { kind: 'ticket', id: t.id, title: t.title, agentIds: ledger?.agentIds ?? [], score };
    if (t.status) hit.status = t.status;
    if (t.at) hit.at = t.at;
    if (needles.some((n) => t.body.folded.includes(n))) hit.snippet = makeSnippet(t.body, needles, SNIPPET);
    tickets.push(hit);
    await budget.breathe();
  }

  // Agents, by name / id / role. Weighted up: someone typing a name means them.
  const agents: AgentHit[] = [];
  for (const p of floor.people) {
    const head = prepare(`${p.name} ${p.id}`);
    const body = prepare(p.role ?? '');
    const score = scoreUnit(q, head, body);
    if (score <= 0) continue;
    const hit: AgentHit = { kind: 'agent', id: p.id, score: score * 1.2 };
    if (p.role && needles.some((n) => body.folded.includes(n))) hit.snippet = makeSnippet(body, needles, SNIPPET);
    agents.push(hit);
  }

  // Notes: every memory section, the board, the user's notes.
  const notes: NoteHit[] = [];
  const pushNote = (n: NoteHit): void => {
    notes.push(n);
    if (notes.length > RAW_NOTE_CAP * 2) {
      notes.sort((a, b) => b.score - a.score);
      notes.length = RAW_NOTE_CAP;
    }
  };

  for (const f of agentFiles) {
    if (!budget.ok()) break;
    const doc = await corpus.md(f.path, f.stamp, budget);
    if (!doc) continue;
    for (const s of doc.sections) {
      const score = scoreUnit(q, s.head, s.body);
      if (score <= 0) continue;
      pushNote({
        kind: 'note',
        key: `memory:${f.id}:${s.section.index}`,
        source: 'memory',
        title: s.title,
        authorId: f.id,
        at: s.at,
        path: f.path,
        ref: { kind: 'memory', agentId: f.id, section: s.section.index, heading: s.section.heading },
        ticketRefs: findTicketRefs(`${s.section.heading}\n${s.section.body}`, floor.ledgerIds),
        score,
        snippet: bodySnippet(s.body, needles)
      });
    }
    await budget.breathe();
  }

  if (budget.ok()) {
    const path = join(root, 'board.md');
    const stamp = await regularFile(path);
    const doc = stamp ? await corpus.md(path, stamp, budget) : null;
    for (const s of doc?.sections ?? []) {
      const score = scoreUnit(q, s.head, s.body);
      if (score <= 0) continue;
      const note: NoteHit = {
        kind: 'note',
        key: `board:${s.section.index}`,
        source: 'board',
        title: s.title,
        at: s.at,
        path,
        ref: { kind: 'board', section: s.section.index, heading: s.section.heading },
        ticketRefs: findTicketRefs(`${s.section.heading}\n${s.section.body}`, floor.ledgerIds),
        score,
        snippet: bodySnippet(s.body, needles)
      };
      if (floor.godId) note.authorId = floor.godId;
      pushNote(note);
    }
  }

  for (const f of budget.ok() ? await corpus.noteFiles(root) : []) {
    if (!budget.ok()) break;
    const doc = await corpus.note(f.file, f.path, f.stamp, budget);
    if (!doc) continue;
    const score = scoreUnit(q, doc.head, doc.body);
    if (score > 0) {
      pushNote({
        kind: 'note',
        key: `notes:${f.file}`,
        source: 'notes',
        title: doc.title,
        at: doc.at,
        path: f.path,
        ref: { kind: 'notes', file: f.file },
        ticketRefs: findTicketRefs(doc.body.text, floor.ledgerIds),
        score,
        snippet: bodySnippet(doc.body, needles)
      });
    }
    await budget.breathe();
  }

  // The knowledge graph's own keyword index, when it is on. One note per
  // document (its best chunk); re-scored with ours so it ranks alongside.
  if (knowledge && budget.ok()) {
    try {
      if (knowledge.active()) {
        const seen = new Set<string>();
        knowledge.search(q.raw, 20).forEach((h, rank) => {
          if (seen.has(h.docId)) return;
          seen.add(h.docId);
          const body = prepare(h.snippet ?? '');
          const score = Math.max(scoreUnit(q, prepare(h.title ?? ''), body), 1 / (rank + 2));
          pushNote({
            kind: 'note',
            key: `knowledge:${h.docId}`,
            source: 'knowledge',
            title: h.title || h.source || h.docId,
            ref: { kind: 'knowledge', docId: h.docId },
            ticketRefs: findTicketRefs(h.snippet ?? '', floor.ledgerIds),
            score,
            snippet: bodySnippet(body, needles)
          });
        });
      }
    } catch (e) {
      console.warn('[memory] knowledge search failed:', e instanceof Error ? e.message : e);
    }
  }

  notes.sort((a, b) => b.score - a.score);
  const answer = groupAnswer({
    tickets,
    agents,
    notes: notes.slice(0, RAW_NOTE_CAP),
    ledger: floor.ledger,
    people: floor.people
  });
  return { ok: true, lane: 'exact', query: q.raw, state: 'ok', answer, partial: budget.partial || undefined, tookMs: Date.now() - t0 };
}

function bodySnippet(body: ReturnType<typeof prepare>, needles: string[]) {
  return needles.some((n) => body.folded.includes(n)) ? makeSnippet(body, needles, SNIPPET) : leadSnippet(body.text, SNIPPET.max);
}

// ─── Meaning ────────────────────────────────────────────────────────────────

/** The slice of MemoryManager (src/main/memory.ts) the meaning lane uses. */
export interface PalaceLike {
  status(): { available: boolean; enabled: boolean; active: boolean; initialized: boolean };
  resetBinCache(): void;
  search(query: string, opts: { results?: number }): Promise<{ ok: boolean; output: string; error?: string }>;
}

function djb2(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (((h << 5) + h) ^ s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** Turn MemPalace's text output into an answer, attributing each drawer to
 *  the agent whose wing it was mined into. */
export async function meaningAnswer(
  corpus: FloorCorpus,
  root: string,
  q: ParsedQuery,
  output: string
): Promise<{ answer: MemorySearchResult['answer']; notice?: string; unparsed: boolean; raw?: string }> {
  const parsed = parsePalaceOutput(output);
  const budget = new ScanBudget(Date.now() + EXACT_DEADLINE_MS);
  const floor: FloorSnapshot = await corpus.snapshot(root, budget);
  const needles = needlesOf(q);
  const notes: NoteHit[] = [];
  for (const h of parsed.hits) {
    const authorId = resolveAgent(h.wing, floor.people);
    const text = prepare(h.text);
    const firstHeading = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/m.exec(h.text)?.[1];
    const title = (firstHeading && sectionTitle({ heading: firstHeading, body: '' }))
      || sectionTitle({ heading: '', body: h.text })
      || h.room;
    const note: NoteHit = {
      kind: 'note',
      key: `palace:${wingKey(h.wing)}:${djb2(h.text)}`,
      source: 'palace',
      title,
      ref: { kind: 'palace', wing: h.wing.slice(0, 200), room: h.room.slice(0, 200), source: h.source.slice(0, 255) },
      ticketRefs: findTicketRefs(h.text, floor.ledgerIds),
      // Keep MemPalace's own order: its hybrid rank is the point of this lane.
      score: Math.round((10 / Math.max(1, h.rank) + (h.similarity ?? 0)) * 1000) / 1000,
      snippet: needles.some((n) => text.folded.includes(n)) ? makeSnippet(text, needles, { radius: 120, max: 320 }) : leadSnippet(h.text, 320),
      text: h.text
    };
    if (authorId) note.authorId = authorId;
    const at = firstHeading ? headingDate(firstHeading) : undefined;
    if (at) note.at = at;
    // The drawer came from a file in the agent's folder; point at it when it
    // is a plain file name that is really there.
    if (authorId && /^[A-Za-z0-9._-]{1,255}$/.test(h.source) && h.source !== '..') {
      const path = join(root, 'agents', authorId, h.source);
      if (await regularFile(path)) note.path = path;
    }
    notes.push(note);
  }
  const answer = groupAnswer({ tickets: [], agents: [], notes, ledger: floor.ledger, people: floor.people });
  return { answer, notice: parsed.notice, unparsed: parsed.unparsed, raw: parsed.unparsed ? output.slice(0, 20_000) : undefined };
}

// ─── Stats ──────────────────────────────────────────────────────────────────

export async function floorStats(corpus: FloorCorpus, root: string | null, knowledge: KnowledgeLike | null): Promise<MemoryStats> {
  const empty: MemoryStats = { ok: true, state: 'no-hive', topics: 0, tickets: 0, agentsWithMemory: 0, entries: 0, notes: 0, documents: 0 };
  if (!root) return empty;
  const budget = new ScanBudget(Date.now() + EXACT_DEADLINE_MS * 2);
  const agentFiles = await corpus.agentFiles(root);
  const floor = await corpus.snapshot(root, budget, agentFiles);
  const topics = new Set<string>();
  let agentsWithMemory = 0;
  let entries = 0;
  for (const f of agentFiles) {
    if (!budget.ok()) break;
    const doc = await corpus.md(f.path, f.stamp, budget);
    if (!doc) continue;
    if (doc.sections.length) agentsWithMemory += 1;
    entries += doc.sections.length;
    for (const t of doc.topics) topics.add(t);
    await budget.breathe();
  }
  const boardPath = join(root, 'board.md');
  const boardStamp = budget.ok() ? await regularFile(boardPath) : null;
  const board = boardStamp ? await corpus.md(boardPath, boardStamp, budget) : null;
  for (const t of board?.topics ?? []) topics.add(t);
  const noteFiles = budget.ok() ? await corpus.noteFiles(root) : [];
  for (const f of noteFiles) {
    if (!budget.ok()) break;
    const doc = await corpus.note(f.file, f.path, f.stamp, budget);
    for (const t of doc?.topics ?? []) topics.add(t);
    await budget.breathe();
  }
  let documents = 0;
  try { if (knowledge?.active()) documents = knowledge.status().docCount; } catch { /* off or unreadable */ }
  return {
    ok: true,
    state: 'ok',
    topics: topics.size,
    tickets: floor.tickets.length,
    agentsWithMemory,
    entries,
    notes: noteFiles.length,
    documents,
    partial: budget.partial || undefined
  };
}

// ─── Reading one note ───────────────────────────────────────────────────────

const AGENT_ID = /^[A-Za-z0-9._-]{1,200}$/;
const NOTE_FILE = /^[^/\\\0]{1,255}$/;

function sectionText(heading: string, body: string): string {
  return heading ? `## ${heading}\n\n${body}` : body;
}

/**
 * The full text behind a note ref. Every ref is re-validated here: ids and
 * file names are single path segments, checked by pattern, joined under the
 * hive root and read only if they are regular files — so a ref can never name
 * a file outside `<hive>/agents/<id>/memory.md`, `<hive>/board.md` or
 * `<hive>/notes/`.
 */
export async function readNote(root: string | null, ref: MemoryNoteRef, knowledge: KnowledgeLike | null): Promise<MemoryNoteText> {
  const fail = (error: string): MemoryNoteText => ({ ok: false, title: '', text: '', error });
  if (ref.kind === 'knowledge') {
    try {
      if (!knowledge?.active()) return fail('knowledge graph is off');
      const doc = knowledge.get(ref.docId);
      if (!doc) return fail('not found');
      const truncated = doc.text.length > MAX_DOC_CHARS;
      return { ok: true, title: doc.meta.title, text: truncated ? doc.text.slice(0, MAX_DOC_CHARS) : doc.text, truncated };
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }
  }
  if (!root) return fail('no hive');
  if (ref.kind === 'palace') return fail('not a file');

  if (ref.kind === 'notes') {
    const file = ref.file;
    if (!NOTE_FILE.test(file) || file.startsWith('.') || !NOTE_EXTS.some((x) => file.toLowerCase().endsWith(x))) {
      return fail('invalid note');
    }
    const path = join(root, 'notes', file);
    const text = await readCapped(path, MAX_MD_BYTES);
    if (!text) return fail('not found');
    const heading = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/m.exec(text.text)?.[1];
    const title = (heading && sectionTitle({ heading, body: '' })) || file.replace(/\.[^.]+$/, '');
    return { ok: true, title, text: text.text, path, truncated: text.truncated };
  }

  let path: string;
  if (ref.kind === 'memory') {
    if (!AGENT_ID.test(ref.agentId) || ref.agentId === '.' || ref.agentId === '..') return fail('invalid agent');
    path = join(root, 'agents', ref.agentId, 'memory.md');
  } else {
    path = join(root, 'board.md');
  }
  const file = await readCapped(path, MAX_MD_BYTES);
  if (!file) return fail('not found');
  const section = findSection(splitSections(file.text, { minLevel: 2 }), ref.section, ref.heading);
  if (!section) {
    // The section moved or was condensed away: show the whole file rather
    // than nothing, so the click still leads somewhere true.
    return { ok: true, title: '', text: file.text, path, truncated: file.truncated };
  }
  return { ok: true, title: sectionTitle(section), text: sectionText(section.heading, section.body), path, truncated: file.truncated };
}
