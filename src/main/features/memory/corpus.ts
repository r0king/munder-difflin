/**
 * The floor's text, read for search — main process only.
 *
 * Reads, under `<harnessHome>/hive`:
 *   agents/<id>/memory.md   one note per section
 *   board.md                one note per section, written by the orchestrator
 *   notes/*.md|*.txt        the user's own notes, one note per file
 *   tasks.json              one ticket per card
 *   registry.json           who the agents are (names, roles)
 *
 * Bounded everywhere, because this runs in the process every window's IPC
 * goes through:
 *   - a per-file byte cap (a runaway memory.md is read up to the cap, not whole);
 *   - a total byte budget and a file budget per scan;
 *   - a wall-clock deadline, checked between files — a scan that runs out
 *     returns what it has with `partial: true` rather than holding main;
 *   - the event loop is yielded to every ~20 ms of CPU work;
 *   - only regular files are read (lstat): a symlink planted in the hive is
 *     not followed out of it.
 *
 * Parsed files are cached by (path, mtime, size), so a second query over an
 * unchanged floor only stats the files. The cache has a size ceiling and is
 * dropped whole when it passes it — simpler than LRU, and a rebuild is one scan.
 */
import { lstat, open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  collectTopics,
  headingDate,
  resolveAgent,
  sectionTitle,
  splitSections,
  ticketUnits,
  type MdSection
} from '../../../shared/workspace/memoryCorpus';
import { prepare, type Prepared } from '../../../shared/workspace/memoryQuery';
import type { MemoryAgentInfo } from '../../../shared/workspace/memoryTypes';
import type { LedgerTicket } from '../../../shared/workspace/memoryGroup';

// ─── Budgets ────────────────────────────────────────────────────────────────

/** Bytes read from one markdown file. Memory files are condensed by the
 *  reflector well before this; the cap is for the one that was not. */
export const MAX_MD_BYTES = 2 * 1024 * 1024;
/** The ledger and registry must be read whole to parse as JSON. */
export const MAX_LEDGER_BYTES = 16 * 1024 * 1024;
export const MAX_REGISTRY_BYTES = 4 * 1024 * 1024;
export const MAX_AGENT_DIRS = 1000;
export const MAX_NOTE_FILES = 2000;
/** Total bytes one scan may read from disk (cache hits are free). */
export const SCAN_BYTE_BUDGET = 96 * 1024 * 1024;
/** Characters the cache may hold (text + folded copy count twice). */
const CACHE_CHAR_CEILING = 160 * 1024 * 1024;
const NOTE_EXTS = ['.md', '.markdown', '.txt'];

// ─── Low-level reads ────────────────────────────────────────────────────────

export interface FileText {
  text: string;
  mtimeMs: number;
  size: number;
  truncated: boolean;
}

export interface FileStamp {
  mtimeMs: number;
  size: number;
}

/** lstat a path; null unless it is a regular file. */
export async function regularFile(path: string): Promise<FileStamp | null> {
  try {
    const st = await lstat(path);
    return st.isFile() ? { mtimeMs: st.mtimeMs, size: st.size } : null;
  } catch {
    return null;
  }
}

/** Read up to `cap` bytes of a regular file as UTF-8. A multi-byte character
 *  cut by the cap decodes to U+FFFD, which is harmless in a search corpus. */
export async function readCapped(path: string, cap: number): Promise<FileText | null> {
  const stamp = await regularFile(path);
  if (!stamp) return null;
  const want = Math.min(stamp.size, cap);
  let fh: Awaited<ReturnType<typeof open>> | null = null;
  try {
    fh = await open(path, 'r');
    const buf = Buffer.alloc(want);
    let got = 0;
    while (got < want) {
      const { bytesRead } = await fh.read(buf, got, want - got, got);
      if (bytesRead === 0) break;
      got += bytesRead;
    }
    return { text: buf.subarray(0, got).toString('utf8'), mtimeMs: stamp.mtimeMs, size: stamp.size, truncated: stamp.size > cap };
  } catch {
    return null;
  } finally {
    await fh?.close().catch(() => undefined);
  }
}

// ─── Parsed units ───────────────────────────────────────────────────────────

export interface SectionUnit {
  section: MdSection;
  title: string;
  /** The raw heading, prepared (matching runs on it as the "title" field). */
  head: Prepared;
  body: Prepared;
  at?: string;
}

export interface MdDoc {
  sections: SectionUnit[];
  topics: string[];
  truncated: boolean;
}

export interface NoteDoc {
  title: string;
  head: Prepared;
  body: Prepared;
  at: string;
  topics: string[];
  truncated: boolean;
}

export interface TicketUnitPrepared {
  id: string;
  title: string;
  status?: string;
  people: string[];
  at?: string;
  head: Prepared;
  body: Prepared;
}

function mdDoc(text: string, truncated: boolean): MdDoc {
  const sections = splitSections(text, { minLevel: 2 }).map((section) => ({
    section,
    title: sectionTitle(section),
    head: prepare(section.heading),
    body: prepare(section.body),
    at: headingDate(section.heading)
  }));
  const topics = new Set<string>();
  collectTopics(text, topics);
  return { sections, topics: [...topics], truncated };
}

/** A user note: the first heading (or the file name) is its title. */
function noteDoc(file: string, text: string, mtimeMs: number, truncated: boolean): NoteDoc {
  const firstHeading = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/m.exec(text)?.[1];
  const base = file.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim();
  const title = sectionTitle({ heading: firstHeading ?? '', body: '' }) || base || file;
  const topics = new Set<string>();
  collectTopics(text, topics);
  if (firstHeading) {
    // A note's own title is a topic even at level 1.
    collectTopics(`## ${firstHeading}`, topics);
  }
  return {
    title,
    head: prepare(`${title}\n${base}`),
    body: prepare(text),
    at: new Date(mtimeMs).toISOString(),
    topics: [...topics],
    truncated
  };
}

// ─── Cache ──────────────────────────────────────────────────────────────────

interface CacheEntry<T> { mtimeMs: number; size: number; value: T; chars: number }

export class CorpusCache {
  private entries = new Map<string, CacheEntry<unknown>>();
  private chars = 0;

  get<T>(path: string, stamp: FileStamp): T | undefined {
    const e = this.entries.get(path);
    if (!e || e.mtimeMs !== stamp.mtimeMs || e.size !== stamp.size) return undefined;
    return e.value as T;
  }

  set<T>(path: string, stamp: FileStamp, value: T, chars: number): void {
    const prev = this.entries.get(path);
    if (prev) this.chars -= prev.chars;
    if (this.chars + chars > CACHE_CHAR_CEILING) { this.entries.clear(); this.chars = 0; }
    this.entries.set(path, { mtimeMs: stamp.mtimeMs, size: stamp.size, value, chars });
    this.chars += chars;
  }

  clear(): void { this.entries.clear(); this.chars = 0; }
}

// ─── The scan ───────────────────────────────────────────────────────────────

/** Running limits of one scan. */
export class ScanBudget {
  partial = false;
  private bytes = 0;
  private lastYield = Date.now();
  constructor(readonly deadline: number) {}

  /** False once the clock or the byte budget has run out (and marks partial). */
  ok(): boolean {
    if (Date.now() > this.deadline || this.bytes > SCAN_BYTE_BUDGET) { this.partial = true; return false; }
    return true;
  }

  spend(bytes: number): void { this.bytes += bytes; }

  /** Let IPC and timers run if we have held the loop for a while. */
  async breathe(): Promise<void> {
    if (Date.now() - this.lastYield < 20) return;
    await new Promise<void>((r) => setImmediate(r));
    this.lastYield = Date.now();
  }
}

export interface AgentFile {
  id: string;
  path: string;
  stamp: FileStamp;
}

export interface FloorSnapshot {
  root: string;
  people: MemoryAgentInfo[];
  godId: string | null;
  tickets: TicketUnitPrepared[];
  ledger: Map<string, LedgerTicket>;
  ledgerIds: string[];
}

const SAFE_SEGMENT = /^[A-Za-z0-9._-]{1,200}$/;
const safeSegment = (s: string): boolean => SAFE_SEGMENT.test(s) && s !== '.' && s !== '..';

export class FloorCorpus {
  readonly cache = new CorpusCache();

  /** Registry → people. Agents with a folder but no registry entry (an old
   *  hive, a hand-made folder) are added by id so their notes still have an
   *  author. */
  async people(root: string, agentIds: string[], budget: ScanBudget): Promise<{ people: MemoryAgentInfo[]; godId: string | null }> {
    const path = join(root, 'registry.json');
    const stamp = await regularFile(path);
    let parsed: { people: MemoryAgentInfo[]; godId: string | null } | undefined;
    if (stamp) {
      parsed = this.cache.get(path, stamp);
      if (!parsed) {
        const file = stamp.size <= MAX_REGISTRY_BYTES ? await readCapped(path, MAX_REGISTRY_BYTES) : null;
        if (file) budget.spend(file.size);
        parsed = parseRegistry(file?.text ?? '');
        this.cache.set(path, stamp, parsed, file?.text.length ?? 0);
      }
    }
    const people = [...(parsed?.people ?? [])];
    const have = new Set(people.map((p) => p.id));
    for (const id of agentIds) if (!have.has(id)) people.push({ id, name: id });
    return { people, godId: parsed?.godId ?? null };
  }

  /** Agent folders that hold a memory.md, newest-edited first so a scan cut
   *  short by its deadline has already covered the live part of the floor. */
  async agentFiles(root: string): Promise<AgentFile[]> {
    let names: string[] = [];
    try {
      const ents = await readdir(join(root, 'agents'), { withFileTypes: true });
      names = ents.filter((e) => e.isDirectory() && safeSegment(e.name)).map((e) => e.name).slice(0, MAX_AGENT_DIRS);
    } catch { return []; }
    const out: AgentFile[] = [];
    for (const id of names) {
      const path = join(root, 'agents', id, 'memory.md');
      const stamp = await regularFile(path);
      if (stamp) out.push({ id, path, stamp });
    }
    out.sort((a, b) => b.stamp.mtimeMs - a.stamp.mtimeMs);
    return out;
  }

  async noteFiles(root: string): Promise<Array<{ file: string; path: string; stamp: FileStamp }>> {
    let names: string[] = [];
    try {
      const ents = await readdir(join(root, 'notes'), { withFileTypes: true });
      names = ents
        .filter((e) => e.isFile() && !e.name.startsWith('.') && NOTE_EXTS.some((x) => e.name.toLowerCase().endsWith(x)))
        .map((e) => e.name)
        .slice(0, MAX_NOTE_FILES);
    } catch { return []; }
    const out: Array<{ file: string; path: string; stamp: FileStamp }> = [];
    for (const file of names) {
      const path = join(root, 'notes', file);
      const stamp = await regularFile(path);
      if (stamp) out.push({ file, path, stamp });
    }
    out.sort((a, b) => b.stamp.mtimeMs - a.stamp.mtimeMs);
    return out;
  }

  async md(path: string, stamp: FileStamp, budget: ScanBudget): Promise<MdDoc | null> {
    const hit = this.cache.get<MdDoc>(path, stamp);
    if (hit) return hit;
    const file = await readCapped(path, MAX_MD_BYTES);
    if (!file) return null;
    budget.spend(Math.min(file.size, MAX_MD_BYTES));
    const doc = mdDoc(file.text, file.truncated);
    this.cache.set(path, stamp, doc, file.text.length * 2);
    return doc;
  }

  async note(file: string, path: string, stamp: FileStamp, budget: ScanBudget): Promise<NoteDoc | null> {
    const hit = this.cache.get<NoteDoc>(path, stamp);
    if (hit) return hit;
    const text = await readCapped(path, MAX_MD_BYTES);
    if (!text) return null;
    budget.spend(Math.min(text.size, MAX_MD_BYTES));
    const doc = noteDoc(file, text.text, text.mtimeMs, text.truncated);
    this.cache.set(path, stamp, doc, text.text.length * 2);
    return doc;
  }

  /** The ledger as prepared tickets. Over the cap → no tickets (a cut JSON
   *  file does not parse) and the scan is marked partial. */
  async tickets(root: string, budget: ScanBudget): Promise<TicketUnitPrepared[]> {
    const path = join(root, 'tasks.json');
    const stamp = await regularFile(path);
    if (!stamp) return [];
    if (stamp.size > MAX_LEDGER_BYTES) { budget.partial = true; return []; }
    const hit = this.cache.get<TicketUnitPrepared[]>(path, stamp);
    if (hit) return hit;
    const file = await readCapped(path, MAX_LEDGER_BYTES);
    if (!file) return [];
    budget.spend(file.size);
    let raw: unknown = null;
    try { raw = JSON.parse(file.text); } catch { raw = null; }
    const units = ticketUnits(raw).map((u) => ({
      id: u.id,
      title: u.title,
      status: u.status,
      people: u.people,
      at: u.at,
      head: prepare(`${u.id} ${u.title}`),
      body: prepare(u.body)
    }));
    this.cache.set(path, stamp, units, file.text.length * 2);
    return units;
  }

  /** Everything a lane needs to know about the floor besides its own hits. */
  async snapshot(root: string, budget: ScanBudget, agentFiles?: AgentFile[]): Promise<FloorSnapshot> {
    const files = agentFiles ?? await this.agentFiles(root);
    const { people, godId } = await this.people(root, files.map((f) => f.id), budget);
    const tickets = await this.tickets(root, budget);
    const ledger = new Map<string, LedgerTicket>();
    for (const t of tickets) {
      if (ledger.has(t.id)) continue;
      const agentIds: string[] = [];
      for (const p of t.people) {
        const id = resolveAgent(p, people);
        if (id && !agentIds.includes(id)) agentIds.push(id);
      }
      ledger.set(t.id, { id: t.id, title: t.title, status: t.status, agentIds, at: t.at });
    }
    // Longest first, so `bmt-120` is tried before `bmt-12` (each is a whole-
    // token match anyway; the order only decides which wins the max-refs cap).
    const ledgerIds = [...ledger.keys()].sort((a, b) => b.length - a.length);
    return { root, people, godId, tickets, ledger, ledgerIds };
  }
}

/** registry.json → people. Tolerates every shape the file has had. */
export function parseRegistry(text: string): { people: MemoryAgentInfo[]; godId: string | null } {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return { people: [], godId: null }; }
  if (!raw || typeof raw !== 'object') return { people: [], godId: null };
  const r = raw as { godId?: unknown; agents?: unknown };
  const godId = typeof r.godId === 'string' && r.godId ? r.godId : null;
  const agents = r.agents && typeof r.agents === 'object' && !Array.isArray(r.agents) ? (r.agents as Record<string, unknown>) : {};
  const people: MemoryAgentInfo[] = [];
  for (const [key, val] of Object.entries(agents).slice(0, MAX_AGENT_DIRS)) {
    if (!val || typeof val !== 'object') continue;
    const a = val as Record<string, unknown>;
    const id = typeof a.id === 'string' && a.id ? a.id : key;
    const name = typeof a.name === 'string' && a.name.trim() ? a.name.trim().slice(0, 200) : id;
    const p: MemoryAgentInfo = { id, name };
    if (typeof a.role === 'string' && a.role.trim()) p.role = a.role.trim().slice(0, 500);
    if (a.isGod === true || id === godId) p.isGod = true;
    if (a.archived === true) p.archived = true;
    people.push(p);
  }
  return { people, godId };
}

/** Section lookup for a note ref: by index when the heading still agrees,
 *  else by heading (the file was edited above it), else null. */
export function findSection(sections: readonly MdSection[], index: number, heading?: string): MdSection | null {
  const byIndex = sections.find((s) => s.index === index);
  if (byIndex && (heading === undefined || byIndex.heading === heading)) return byIndex;
  if (heading !== undefined) {
    const byHeading = sections.find((s) => s.heading === heading);
    if (byHeading) return byHeading;
  }
  return null;
}
