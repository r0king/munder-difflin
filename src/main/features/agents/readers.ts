/**
 * Disk reads behind the Workspace agent cards and rooms (wsAgents unit).
 *
 * Everything here is READ-ONLY with respect to the hive and the CLIs' files,
 * takes an agent id the renderer sent (validated here, never a path), and is
 * cached on file/dir mtimes so a 3–5 s poll costs a stat when nothing moved:
 *
 *   - the agent's Claude Code transcript, located from the hive registry's
 *     recorded session id + cwd (tail only — transcripts grow to many MB);
 *   - its mailbox: inbox, inbox/.done, outbox, outbox/.sent;
 *   - the ASK ME questions on the cards assigned to it (hive/tasks.json);
 *   - its last abnormal exit (hive/log.jsonl `agent-exit`).
 *
 * Text that leaves for the renderer goes through hive.ts's redactSecrets — the
 * same gate the voice read-layer uses — so a key an agent echoed into a reply
 * or a message never crosses IPC verbatim.
 */
import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { redactSecrets } from '../../hive';
import { projectDir } from '../../transcript';
import { parseTranscript, transcriptActivity, type TranscriptEvent } from '../../../shared/workspace/agentsTranscript';
import type { AskRecord, HiveMailRecord } from '../../../shared/workspace/agentsConversation';
import type { AgentActivity } from '../../../shared/workspace/agentsSummary';

// ─── Ids and paths ──────────────────────────────────────────────────────────

/** Hive agent ids are slugs (`god`, `dwight-3f2a`, worker ids). Anything else
 *  is refused before it gets near a path. */
const SAFE_AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** Claude session ids are UUIDs; transcript.ts uses the same charset. */
const SAFE_SESSION_ID = /^[A-Za-z0-9_-]{8,128}$/;

export function isSafeAgentId(id: unknown): id is string {
  return typeof id === 'string' && SAFE_AGENT_ID.test(id) && !id.includes('..');
}

/** `<root>/agents/<id>`, or null when the join would leave `<root>/agents`. */
export function agentDir(root: string, id: string): string | null {
  if (!isSafeAgentId(id)) return null;
  const base = resolve(root, 'agents');
  const dir = resolve(base, id);
  return dir.startsWith(base + sep) ? dir : null;
}

// ─── Small cached readers ───────────────────────────────────────────────────

function readJsonFile(p: string): unknown {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

interface RegistryAgent {
  provider?: string;
  sessionId?: string;
  cwd?: string;
  archived?: boolean;
}

let registryCache: { path: string; mtimeMs: number; agents: Record<string, RegistryAgent> } | null = null;

function registryAgents(root: string): Record<string, RegistryAgent> {
  const p = join(root, 'registry.json');
  try {
    const st = statSync(p);
    if (registryCache && registryCache.path === p && registryCache.mtimeMs === st.mtimeMs) return registryCache.agents;
    const raw = readJsonFile(p) as { agents?: unknown } | null;
    const agents = raw && raw.agents && typeof raw.agents === 'object' && !Array.isArray(raw.agents)
      ? raw.agents as Record<string, RegistryAgent>
      : {};
    registryCache = { path: p, mtimeMs: st.mtimeMs, agents };
    return agents;
  } catch {
    return {};
  }
}

// ─── Transcript ─────────────────────────────────────────────────────────────

/** Session id → transcript path found by scanning every project dir, kept so
 *  the scan runs once per session rather than once per poll. A miss is
 *  remembered briefly, then retried (the file appears with the first turn). */
const scannedPaths = new Map<string, { path: string | null; at: number }>();
const MISS_RETRY_MS = 30_000;

function scanProjectsFor(sessionId: string): string | null {
  const cached = scannedPaths.get(sessionId);
  if (cached && (cached.path || Date.now() - cached.at < MISS_RETRY_MS)) {
    if (!cached.path || existsSync(cached.path)) return cached.path;
  }
  let best: { path: string; mtime: number } | null = null;
  const projectsRoot = join(homedir(), '.claude', 'projects');
  try {
    for (const dir of readdirSync(projectsRoot)) {
      const candidate = join(projectsRoot, dir, `${sessionId}.jsonl`);
      try {
        const st = statSync(candidate);
        if (!best || st.mtimeMs > best.mtime) best = { path: candidate, mtime: st.mtimeMs };
      } catch { /* not in this project */ }
    }
  } catch { /* no ~/.claude/projects */ }
  scannedPaths.set(sessionId, { path: best?.path ?? null, at: Date.now() });
  if (scannedPaths.size > 200) scannedPaths.delete(scannedPaths.keys().next().value as string);
  return best?.path ?? null;
}

export type TranscriptLookup =
  | { path: string }
  | { missing: 'engine' | 'none' };

/**
 * Where an agent's live Claude session transcript is. The hive registry
 * records the session id at SessionStart (hive.recordSession); the file sits in
 * the project dir keyed by the cwd the CLI ran in. A worktree agent's CLI may
 * have run somewhere else than the registry's cwd, so a miss falls back to a
 * one-off scan of every project dir for that session id.
 */
export function locateTranscript(root: string, agentId: string): TranscriptLookup {
  const reg = registryAgents(root)[agentId];
  const provider = typeof reg?.provider === 'string' ? reg.provider : 'claude';
  if (provider !== 'claude') return { missing: 'engine' };
  const sid = reg?.sessionId;
  if (typeof sid !== 'string' || !SAFE_SESSION_ID.test(sid)) return { missing: 'none' };
  if (typeof reg.cwd === 'string' && reg.cwd) {
    try {
      const direct = join(projectDir(reg.cwd), `${sid}.jsonl`);
      if (existsSync(direct)) return { path: direct };
    } catch { /* fall through to the scan */ }
  }
  const scanned = scanProjectsFor(sid);
  return scanned ? { path: scanned } : { missing: 'none' };
}

/** Parsed tails, keyed by path + tail size, reused while the file is unchanged. */
const tailCache = new Map<string, { size: number; mtimeMs: number; events: TranscriptEvent[] }>();

/** Parse the last `bytes` of a transcript. Never throws. */
export function readTranscriptTail(path: string, bytes: number): TranscriptEvent[] {
  const key = `${path}#${bytes}`;
  let fd: number | null = null;
  try {
    fd = openSync(path, 'r');
    const st = fstatSync(fd);
    const hit = tailCache.get(key);
    if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.events;
    const len = Math.min(st.size, bytes);
    const buf = Buffer.alloc(len);
    if (len > 0) readSync(fd, buf, 0, len, st.size - len);
    const events = parseTranscript(buf.toString('utf8')).map((e) => ({ ...e, text: redactSecrets(e.text) }));
    tailCache.set(key, { size: st.size, mtimeMs: st.mtimeMs, events });
    if (tailCache.size > 64) tailCache.delete(tailCache.keys().next().value as string);
    return events;
  } catch {
    return [];
  } finally {
    if (fd !== null) try { closeSync(fd); } catch { /* already closed */ }
  }
}

// ─── Mailbox ────────────────────────────────────────────────────────────────

interface RawMessage {
  id?: unknown;
  from?: unknown;
  to?: unknown;
  act?: unknown;
  subject?: unknown;
  body?: unknown;
  created_at?: unknown;
  conversation?: unknown;
  requires_reply?: unknown;
}

/** Most messages read per folder. `.done` and `.sent` grow without bound; the
 *  room shows recent conversation, and the newest files are the ones kept. */
const MAX_PER_FOLDER = 150;
/** Longest body kept for a message (the room renders it as markdown). */
const MAX_BODY = 20_000;

const folderCache = new Map<string, { mtimeMs: number; messages: HiveMailRecord[] }>();

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function readFolder(dir: string, direction: 'inbox' | 'outbox'): HiveMailRecord[] {
  let mtimeMs: number;
  try { mtimeMs = statSync(dir).mtimeMs; } catch { return []; }
  const cacheKey = `${dir}#${direction}`;
  const hit = folderCache.get(cacheKey);
  if (hit && hit.mtimeMs === mtimeMs) return hit.messages;
  let names: string[];
  try { names = readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return []; }
  // Hive-written names start with an ISO stamp, so a name sort is a time sort;
  // agent-written outbox names are arbitrary, so fall back to mtime when the
  // folder is big enough for the cut to matter.
  let chosen = names;
  if (names.length > MAX_PER_FOLDER) {
    chosen = names
      .map((n) => { try { return { n, t: statSync(join(dir, n)).mtimeMs }; } catch { return { n, t: 0 }; } })
      .sort((a, b) => a.t - b.t)
      .slice(-MAX_PER_FOLDER)
      .map((x) => x.n);
  }
  const messages: HiveMailRecord[] = [];
  for (const name of chosen) {
    const raw = readJsonFile(join(dir, name)) as RawMessage | null;
    if (!raw || typeof raw !== 'object') continue;
    const id = str(raw.id) || name.replace(/\.json$/, '');
    const ts = Date.parse(str(raw.created_at));
    let fileTs = 0;
    if (Number.isNaN(ts)) { try { fileTs = statSync(join(dir, name)).mtimeMs; } catch { /* keep 0 */ } }
    const body = redactSecrets(str(raw.body));
    messages.push({
      id,
      from: str(raw.from) || 'unknown',
      to: str(raw.to) || 'unknown',
      act: str(raw.act) || 'inform',
      subject: redactSecrets(str(raw.subject)).slice(0, 500),
      body: body.length > MAX_BODY ? `${body.slice(0, MAX_BODY)}…` : body,
      ts: Number.isNaN(ts) ? fileTs : ts,
      direction,
      ...(str(raw.conversation) ? { conversation: str(raw.conversation) } : {}),
      ...(raw.requires_reply === true ? { requiresReply: true } : {})
    });
  }
  folderCache.set(cacheKey, { mtimeMs, messages });
  if (folderCache.size > 256) folderCache.delete(folderCache.keys().next().value as string);
  return messages;
}

/** Everything in an agent's mailbox, newest last. Each message once, even
 *  though a delivered message sits in both the sender's and the recipient's
 *  folders (only THIS agent's folders are read, and ids are deduped). */
export function readMailbox(root: string, agentId: string): HiveMailRecord[] {
  const dir = agentDir(root, agentId);
  if (!dir) return [];
  const all = [
    ...readFolder(join(dir, 'inbox'), 'inbox'),
    ...readFolder(join(dir, 'inbox', '.done'), 'inbox'),
    ...readFolder(join(dir, 'outbox'), 'outbox'),
    ...readFolder(join(dir, 'outbox', '.sent'), 'outbox')
  ];
  const seen = new Set<string>();
  const out: HiveMailRecord[] = [];
  for (const m of all) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    out.push(m);
  }
  return out.sort((a, b) => a.ts - b.ts);
}

/** The newest message this agent itself wrote to the floor. */
export function latestMailFrom(root: string, agentId: string): HiveMailRecord | null {
  const dir = agentDir(root, agentId);
  if (!dir) return null;
  const mine = [
    ...readFolder(join(dir, 'outbox'), 'outbox'),
    ...readFolder(join(dir, 'outbox', '.sent'), 'outbox')
  ].filter((m) => m.from === agentId);
  let best: HiveMailRecord | null = null;
  for (const m of mine) if (!best || m.ts > best.ts) best = m;
  return best;
}

// ─── ASK ME ─────────────────────────────────────────────────────────────────

let tasksCache: { mtimeMs: number; tasks: unknown[] } | null = null;

function ledger(root: string): unknown[] {
  const p = join(root, 'tasks.json');
  try {
    const st = statSync(p);
    if (tasksCache && tasksCache.mtimeMs === st.mtimeMs) return tasksCache.tasks;
    const raw = readJsonFile(p) as { tasks?: unknown } | null;
    const tasks = raw && Array.isArray(raw.tasks) ? raw.tasks : [];
    tasksCache = { mtimeMs: st.mtimeMs, tasks };
    return tasks;
  } catch {
    return [];
  }
}

function ms(v: unknown): number | undefined {
  const t = typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isNaN(t) ? undefined : t;
}

/** Every question → answer on the cards assigned to this agent. */
export function readAsks(root: string, agentId: string): AskRecord[] {
  const out: AskRecord[] = [];
  for (const raw of ledger(root)) {
    if (!raw || typeof raw !== 'object') continue;
    const t = raw as Record<string, unknown>;
    if (t.assignee !== agentId || typeof t.id !== 'string' || !Array.isArray(t.humanQA)) continue;
    const title = str(t.title) || t.id;
    for (const e of t.humanQA) {
      if (!e || typeof e !== 'object') continue;
      const qa = e as Record<string, unknown>;
      const q = str(qa.q);
      if (!q.trim()) continue;
      out.push({
        taskId: t.id,
        taskTitle: title,
        q: redactSecrets(q),
        ...(str(qa.a) ? { a: redactSecrets(str(qa.a)) } : {}),
        askedAt: ms(qa.askedAt),
        answeredAt: ms(qa.answeredAt),
        ...(qa.dismissedAt ? { dismissed: true } : {})
      });
    }
  }
  return out;
}

// ─── Activity (cards) ───────────────────────────────────────────────────────

/** Bytes of transcript tail read for a card: enough for the last turn's
 *  reply and tool calls without parsing megabytes per agent per poll. */
const CARD_TAIL_BYTES = 192 * 1024;

export function readActivity(root: string, agentId: string): AgentActivity {
  const out: AgentActivity = { agentId };
  const found = locateTranscript(root, agentId);
  if ('path' in found) {
    const act = transcriptActivity(readTranscriptTail(found.path, CARD_TAIL_BYTES));
    if (act.lastReply) out.lastReply = { text: act.lastReply.text.slice(0, 2000), ts: act.lastReply.ts };
    if (act.lastTool) out.lastTool = { tool: act.lastTool.tool, text: act.lastTool.text, ts: act.lastTool.ts };
    if (act.lastResult) out.lastResult = act.lastResult;
  }
  const mail = latestMailFrom(root, agentId);
  if (mail) {
    out.lastMail = { subject: mail.subject, body: mail.body.slice(0, 2000), to: mail.to, ts: mail.ts };
  }
  return out;
}

// ─── Last exit ──────────────────────────────────────────────────────────────

export interface AgentExitRecord {
  ts: number;
  exitCode: number | null;
  signal: number | null;
  /** Main keeps the path; the renderer only learns that a log exists. */
  tailPath: string | null;
}

const LOG_TAIL_BYTES = 512 * 1024;

/** The newest abnormal exit hive.recordAgentExit logged for this agent. */
export function readLastExit(root: string, agentId: string): AgentExitRecord | null {
  const p = join(root, 'log.jsonl');
  let fd: number | null = null;
  try {
    fd = openSync(p, 'r');
    const size = fstatSync(fd).size;
    const len = Math.min(size, LOG_TAIL_BYTES);
    const buf = Buffer.alloc(len);
    if (len > 0) readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const l = lines[i].trim();
      if (!l.includes('"agent-exit"') || !l.includes(agentId)) continue;
      try {
        const rec = JSON.parse(l) as Record<string, unknown>;
        if (rec.kind !== 'agent-exit' || rec.agentId !== agentId) continue;
        const tailPath = typeof rec.tailPath === 'string' ? rec.tailPath : null;
        // Only a crash log inside THIS hive's crashes/ folder is ours to open.
        const crashes = resolve(root, 'crashes') + sep;
        return {
          ts: typeof rec.ts === 'number' ? rec.ts : 0,
          exitCode: typeof rec.exitCode === 'number' ? rec.exitCode : null,
          signal: typeof rec.signal === 'number' ? rec.signal : null,
          tailPath: tailPath && resolve(tailPath).startsWith(crashes) ? resolve(tailPath) : null
        };
      } catch { /* a cut first line */ }
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== null) try { closeSync(fd); } catch { /* already closed */ }
  }
}
