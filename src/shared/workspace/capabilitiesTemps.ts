/**
 * TEMPS — an agent hired for one job. The pure half: request validation, the
 * queue's concurrency rule, the token fold over the hive's cost ledger, and the
 * history row a finished temp leaves behind.
 *
 * A temp IS an ephemeral worker (main/index.ts processSpawnRequest): it gets the
 * same isolated worktree, the same objective dispatch, the same `act:"done"`
 * release and the same safety-gated teardown that never discards unmerged work.
 * What the Temps tab adds is the human hiring it, a cap on how many run at once,
 * and the row it leaves when it is gone: the job, how long it ran, the tokens it
 * used, and the worktree it kept because that worktree holds unmerged work.
 */
import { canReceiveInbox, isAgentProvider, providerPreset, type AgentProvider } from '../agentProvider';

/* ───────────────────────────────── records ──────────────────────────────── */

export type TempState =
  /** Waiting for one of the temp slots (the Temps cap). */
  | 'queued'
  /** Handed to the worker controller; not on the floor yet (it may be waiting
   *  for a worker slot of its own). */
  | 'starting'
  /** Has a live terminal. */
  | 'running'
  /** Its terminal is gone; the worktree verdict and token total are settling. */
  | 'finishing';

export type TempOutcome =
  /** Signalled done itself. */
  | 'done'
  /** Stopped (or cancelled) by the user. */
  | 'stopped'
  /** Never started: rejected by the worker controller or the spawn failed. */
  | 'failed'
  /** Ended without signalling done — reaped as idle, over its token cap, or crashed. */
  | 'ended'
  /** The app quit while it was running, so it stopped being a temp. */
  | 'interrupted';

export interface TempRecord {
  id: string;
  /** Hive / PTY id the worker controller gives it: `worker-<id>`. */
  workerId: string;
  job: string;
  provider: AgentProvider;
  model?: string;
  cwd: string;
  isolate: boolean;
  state: TempState;
  createdAt: number;
  submittedAt?: number;
  startedAt?: number;
  endedAt?: number;
  /** Byte length of cost-ledger.jsonl when it was submitted: its token fold
   *  reads from here, never the whole ledger. */
  ledgerOffset?: number;
  /** The branch its worktree is cut from (for the unmerged-work check). */
  baseBranch?: string;
  /** Last tick that saw it on the floor — the end time an app quit leaves. */
  lastSeenAt?: number;
  stopRequested?: boolean;
  /** Set when the outcome is known before teardown settles (failed / stopped). */
  outcome?: TempOutcome;
  error?: string;
}

export interface TempWorktree {
  path: string;
  branch?: string;
  /** Still on disk because it holds unmerged work (dirty, or commits ahead of base). */
  kept: boolean;
  detail?: string;
}

export interface TempHistoryRow {
  id: string;
  job: string;
  provider: AgentProvider;
  model?: string;
  cwd: string;
  outcome: TempOutcome;
  createdAt: number;
  startedAt: number | null;
  endedAt: number;
  /** Wall time on the floor; null when it never started. */
  durationMs: number | null;
  /** Total tokens (input + output + cache), null when no usage was recorded
   *  (engines without telemetry). */
  tokens: number | null;
  worktree?: TempWorktree;
  error?: string;
}

export interface TempsFile {
  version: 1;
  maxConcurrent: number;
  active: TempRecord[];
  history: TempHistoryRow[];
}

export const DEFAULT_MAX_TEMPS = 3;
export const MAX_TEMPS_LIMIT = 8;
export const TEMP_HISTORY_MAX = 200;
export const MAX_JOB_CHARS = 4000;
const MAX_ACTIVE = 50;

/* ──────────────────────────────── requests ──────────────────────────────── */

/** Same character set hire manifests allow for a model: it goes onto the
 *  spawn command line, and on Windows a `.cmd` shim routes that through cmd.exe. */
const MODEL_RE = /^[A-Za-z0-9 ._()[\]/:@+-]{1,80}$/;

export interface TempRequest {
  job: string;
  provider: AgentProvider;
  model?: string;
  cwd: string;
  isolate: boolean;
}

/** Engines a temp may run on: the objective is delivered through the inbox, so
 *  an engine that cannot receive inbox mail would never hear its job. */
export function tempCapableProvider(p: AgentProvider): boolean {
  return p !== 'custom' && canReceiveInbox(p);
}

/** Validate an untrusted hire request (it crosses IPC). The cwd's existence is
 *  main's check; this one is shape only. */
export function validateTempRequest(raw: unknown): { ok: true; value: TempRequest } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'bad request' };
  const r = raw as Record<string, unknown>;
  const job = typeof r.job === 'string' ? r.job.trim() : '';
  if (!job) return { ok: false, error: 'job' };
  if (job.length > MAX_JOB_CHARS) return { ok: false, error: 'jobTooLong' };
  if (!isAgentProvider(r.provider) || !tempCapableProvider(r.provider)) return { ok: false, error: 'provider' };
  let model: string | undefined;
  if (r.model !== undefined && r.model !== null && r.model !== '') {
    if (typeof r.model !== 'string' || !MODEL_RE.test(r.model.trim())) return { ok: false, error: 'model' };
    model = r.model.trim();
  }
  const cwd = typeof r.cwd === 'string' ? r.cwd.trim() : '';
  if (!cwd || cwd.length > 1024 || cwd.includes('\0')) return { ok: false, error: 'cwd' };
  return { ok: true, value: { job, provider: r.provider, model, cwd, isolate: r.isolate !== false } };
}

/** `temp-<base36 time>-<4 random>` — unique, sortable, and a valid hive id. */
export function newTempId(now: number, random: () => number = Math.random): string {
  const rand = Math.floor(random() * 36 ** 4).toString(36).padStart(4, '0');
  return `temp-${now.toString(36)}-${rand}`;
}

export function tempWorkerId(tempId: string): string {
  return `worker-${tempId}`;
}

/** The floor card's name: the job's first line, short. */
export function tempDisplayName(job: string): string {
  const first = job.split(/\r?\n/).find((l) => l.trim())?.trim() ?? job.trim();
  const flat = first.replace(/\s+/g, ' ');
  return flat.length > 40 ? `${flat.slice(0, 39).trimEnd()}…` : flat;
}

/**
 * The command line for the worker controller, built from the provider preset
 * the same way the renderer's buildSpawnCommand does it — the controller's own
 * `model` field always uses `--model`, which is wrong for engines whose flag
 * differs, so the model goes into the command here instead. Auto-mode flags are
 * NOT added: the controller adds the provider's own when the app is in auto mode.
 */
export function tempCommandLine(provider: AgentProvider, model: string | undefined, claudeCommand?: string): string {
  const preset = providerPreset(provider);
  const base = provider === 'claude' ? (claudeCommand?.trim() || preset.defaultCommand) : preset.defaultCommand;
  if (!model || !preset.supportsModel || !preset.modelFlag) return base;
  const m = /\s/.test(model) ? `"${model}"` : model;
  return `${base} ${preset.modelFlag} ${m}`;
}

/* ─────────────────────────────── the queue ──────────────────────────────── */

/** Temps holding a slot: handed to the controller or on the floor. */
export function runningCount(active: readonly TempRecord[]): number {
  return active.filter((t) => t.state === 'starting' || t.state === 'running').length;
}

export function clampMaxTemps(n: unknown): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : DEFAULT_MAX_TEMPS;
  return Math.min(MAX_TEMPS_LIMIT, Math.max(1, v));
}

/** Queued temps that may start now, oldest first, without exceeding the cap. */
export function nextToSubmit(active: readonly TempRecord[], maxConcurrent: number): TempRecord[] {
  const free = clampMaxTemps(maxConcurrent) - runningCount(active);
  if (free <= 0) return [];
  return active
    .filter((t) => t.state === 'queued')
    .sort((a, b) => a.createdAt - b.createdAt)
    .slice(0, free);
}

/* ──────────────────────────────── tokens ────────────────────────────────── */

/**
 * Total tokens one agent burned, folded from cost-ledger.jsonl lines.
 *
 * Ledger rows are CUMULATIVE snapshots per (agent, session) — a running total,
 * not an increment (main/usage.ts). So the total is the peak of each session,
 * summed; and because the in-memory counter restarts at zero when the app does,
 * a DECREASE inside one session closes a segment (the same reset rule as
 * main/costLifetime.ts). Unparseable lines are skipped. null = no row at all.
 */
export function foldLedgerTokens(lines: readonly string[], agentId: string): number | null {
  const segs = new Map<string, { committed: number; peak: number; last: number }>();
  let any = false;
  for (const line of lines) {
    if (!line || !line.includes(agentId)) continue;
    let row: Record<string, unknown>;
    try { row = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    if (row.agent_id !== agentId) continue;
    const n = (k: string): number => {
      const v = row[k];
      return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
    };
    const total = n('input') + n('output') + n('cache_read') + n('cache_creation');
    const sid = typeof row.session_id === 'string' ? row.session_id : '';
    any = true;
    const seg = segs.get(sid) ?? { committed: 0, peak: 0, last: 0 };
    if (total < seg.last) {
      seg.committed += seg.peak;
      seg.peak = 0;
    }
    seg.peak = Math.max(seg.peak, total);
    seg.last = total;
    segs.set(sid, seg);
  }
  if (!any) return null;
  let sum = 0;
  for (const s of segs.values()) sum += s.committed + s.peak;
  return sum;
}

/* ─────────────────────────────── settling ───────────────────────────────── */

/** How a temp that left the floor ended. A done signal wins over a stop the
 *  user clicked a moment too late; a recorded failure wins over everything. */
export function settleOutcome(rec: Pick<TempRecord, 'outcome' | 'stopRequested'>, doneSignaled: boolean): TempOutcome {
  if (rec.outcome === 'failed') return 'failed';
  if (doneSignaled) return 'done';
  if (rec.stopRequested) return 'stopped';
  return rec.outcome ?? 'ended';
}

/**
 * The kept-worktree verdict. `exists` is the worktree path on disk after the
 * controller's teardown settled; `unmerged` is git's answer for it (main runs
 * worktreeHasUnintegratedWork). The controller removes a clean worktree and
 * keeps one with unmerged work, so: gone → not kept; on disk → kept exactly
 * when it holds work. An unknown git answer counts as kept (fail safe — the
 * same posture as the teardown itself).
 */
export function worktreeVerdict(input: {
  isolate: boolean;
  path: string | null;
  exists: boolean;
  unmerged: { keep: boolean; branch?: string; detail?: string } | null;
}): TempWorktree | undefined {
  if (!input.isolate || !input.path) return undefined;
  if (!input.exists) return { path: input.path, kept: false };
  if (!input.unmerged) return { path: input.path, kept: true, detail: 'unknown' };
  return { path: input.path, kept: input.unmerged.keep, branch: input.unmerged.branch, detail: input.unmerged.detail };
}

/** The row a finished temp leaves behind. */
export function buildHistoryRow(
  rec: TempRecord,
  end: { endedAt: number; outcome: TempOutcome; tokens: number | null; worktree?: TempWorktree; error?: string }
): TempHistoryRow {
  const startedAt = rec.startedAt ?? null;
  const durationMs = startedAt === null ? null : Math.max(0, end.endedAt - startedAt);
  const row: TempHistoryRow = {
    id: rec.id,
    job: rec.job,
    provider: rec.provider,
    cwd: rec.cwd,
    outcome: end.outcome,
    createdAt: rec.createdAt,
    startedAt,
    endedAt: end.endedAt,
    durationMs,
    tokens: end.tokens
  };
  if (rec.model) row.model = rec.model;
  if (end.worktree) row.worktree = end.worktree;
  const error = end.error ?? rec.error;
  if (error) row.error = error;
  return row;
}

/** Newest first, bounded. Replaces an older row for the same temp. */
export function pushHistory(history: readonly TempHistoryRow[], row: TempHistoryRow, max = TEMP_HISTORY_MAX): TempHistoryRow[] {
  return [row, ...history.filter((h) => h.id !== row.id)].slice(0, Math.max(1, max));
}

/* ───────────────────────────────── file ─────────────────────────────────── */

const STATES: readonly TempState[] = ['queued', 'starting', 'running', 'finishing'];
const OUTCOMES: readonly TempOutcome[] = ['done', 'stopped', 'failed', 'ended', 'interrupted'];

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const str = (v: unknown, max = 1024): string | undefined =>
  (typeof v === 'string' && v.length > 0 ? v.slice(0, max) : undefined);

function parseRecord(raw: unknown): TempRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = str(r.id, 64);
  const job = str(r.job, MAX_JOB_CHARS);
  const cwd = str(r.cwd);
  const createdAt = num(r.createdAt);
  if (!id || !/^temp-[a-z0-9-]+$/.test(id) || !job || !cwd || createdAt === undefined) return null;
  if (!isAgentProvider(r.provider) || !STATES.includes(r.state as TempState)) return null;
  const rec: TempRecord = {
    id, workerId: tempWorkerId(id), job, provider: r.provider, cwd,
    isolate: r.isolate !== false, state: r.state as TempState, createdAt
  };
  const model = str(r.model, 80);
  if (model) rec.model = model;
  for (const k of ['submittedAt', 'startedAt', 'endedAt', 'ledgerOffset', 'lastSeenAt'] as const) {
    const v = num(r[k]);
    if (v !== undefined) rec[k] = v;
  }
  const base = str(r.baseBranch, 256);
  if (base) rec.baseBranch = base;
  if (r.stopRequested === true) rec.stopRequested = true;
  if (OUTCOMES.includes(r.outcome as TempOutcome)) rec.outcome = r.outcome as TempOutcome;
  const error = str(r.error, 500);
  if (error) rec.error = error;
  return rec;
}

function parseRow(raw: unknown): TempHistoryRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = str(r.id, 64);
  const job = str(r.job, MAX_JOB_CHARS);
  const endedAt = num(r.endedAt);
  if (!id || !job || endedAt === undefined || !isAgentProvider(r.provider) || !OUTCOMES.includes(r.outcome as TempOutcome)) return null;
  const row: TempHistoryRow = {
    id, job, provider: r.provider, cwd: str(r.cwd) ?? '',
    outcome: r.outcome as TempOutcome,
    createdAt: num(r.createdAt) ?? endedAt,
    startedAt: num(r.startedAt) ?? null,
    endedAt,
    durationMs: num(r.durationMs) ?? null,
    tokens: num(r.tokens) ?? null
  };
  const model = str(r.model, 80);
  if (model) row.model = model;
  const error = str(r.error, 500);
  if (error) row.error = error;
  const wt = r.worktree as Record<string, unknown> | undefined;
  if (wt && typeof wt === 'object' && str(wt.path)) {
    row.worktree = { path: str(wt.path)!, kept: wt.kept === true };
    const branch = str(wt.branch, 256);
    if (branch) row.worktree.branch = branch;
    const detail = str(wt.detail, 300);
    if (detail) row.worktree.detail = detail;
  }
  return row;
}

/** Parse temps.json tolerantly; a corrupt file becomes an empty one. */
export function parseTempsFile(raw: unknown): TempsFile {
  const out: TempsFile = { version: 1, maxConcurrent: DEFAULT_MAX_TEMPS, active: [], history: [] };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const r = raw as Record<string, unknown>;
  out.maxConcurrent = clampMaxTemps(r.maxConcurrent);
  if (Array.isArray(r.active)) {
    for (const a of r.active) {
      const rec = parseRecord(a);
      if (rec && !out.active.some((x) => x.id === rec.id)) out.active.push(rec);
      if (out.active.length >= MAX_ACTIVE) break;
    }
  }
  if (Array.isArray(r.history)) {
    for (const h of r.history) {
      const row = parseRow(h);
      if (row && !out.history.some((x) => x.id === row.id)) out.history.push(row);
      if (out.history.length >= TEMP_HISTORY_MAX) break;
    }
  }
  return out;
}

/* ─────────────────────────────── formatting ─────────────────────────────── */

/** `4m 12s`, `45s`, `1h 03m`. Units are the same short Latin letters in every
 *  language (the spec's own row reads "4m 12s"); the numbers are locale-free. */
export function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, '0')}m`;
}

/** `950`, `38k`, `1.2M` — the compact token count the history row shows. */
export function formatTokens(n: number | null): string {
  if (n === null || !Number.isFinite(n) || n < 0) return '—';
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${n < 10_000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') : Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}
