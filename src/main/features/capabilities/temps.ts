/**
 * Temps — hire an agent for one job, and keep the row it leaves behind.
 *
 * A temp is an EPHEMERAL WORKER, run by the controller that already exists in
 * index.ts (processSpawnRequest / ephemeralWorkerTick): fresh isolated
 * worktree, the objective dispatched through the inbox, release on its
 * `act:"done"`, idle and token-cap reaping, and the safety-gated teardown that
 * never deletes a worktree holding unmerged work. Nothing here spawns or kills a
 * process. This module owns three things the controller does not have:
 *
 *   1. A human hiring queue with its own cap ("1 of 3 running"). Requests wait
 *      here until a temp slot frees, then go to the controller as an ordinary
 *      spawn-request file — in `<userData>/features/capabilities/temp-requests/`,
 *      NOT the hive's spawn-requests/. The hive folder is writable by every
 *      agent and its intake is gated on "the orchestrator may hire"; this one
 *      sits outside every agent's sandbox, and the hire is the user's own click,
 *      so index.ts takes it past that gate (still under maxConcurrentWorkers).
 *   2. Watching it through the files the controller already writes: the hive
 *      registry (on the floor = `archived:false`; teardownPty archives it), the
 *      spawn-requests/.failed archive, its outbox (`act:"done"`), the cost
 *      ledger (tokens) and its worktree path (kept or removed at teardown).
 *   3. The history row: job, how long it ran, tokens, and the worktree it kept.
 *
 * State is temps.json beside the queue (bounded history). Stopping a running
 * temp is the existing `workers:stop` (the renderer calls it with the worker id
 * this module hands back), so a stop takes the same safe teardown as a reap.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { getBranch, worktreeHasUnintegratedWork } from '../../git';
import {
  buildHistoryRow,
  clampMaxTemps,
  foldLedgerTokens,
  newTempId,
  nextToSubmit,
  parseTempsFile,
  pushHistory,
  runningCount,
  settleOutcome,
  tempCommandLine,
  tempDisplayName,
  tempWorkerId,
  validateTempRequest,
  worktreeVerdict,
  type TempOutcome,
  type TempRecord,
  type TempsFile
} from '../../../shared/workspace/capabilitiesTemps';

const TICK_MS = 2000;
/** After the terminal goes, give the controller's async worktree teardown
 *  (unlink deps, git status, remove or keep) time to settle. */
const SETTLE_MS = 8000;
/** A request the controller took but that never reached the floor. */
const LOST_AFTER_MS = 3 * 60_000;
/** How often a running temp's heartbeat is persisted (its end time if the app quits). */
const HEARTBEAT_SAVE_MS = 30_000;

export interface TempsView extends TempsFile {
  running: number;
  hive: boolean;
}

export interface TempsDeps {
  dataDir: string;
  harnessHome: () => string | null;
  /** config.defaultCommand — the Claude binary the user configured. */
  claudeCommand: () => string | undefined;
  onChange: () => void;
}

function expandHome(p: string): string {
  return p === '~' ? homedir() : p.startsWith('~/') || p.startsWith('~\\') ? join(homedir(), p.slice(2)) : p;
}

export class TempsController {
  private state: TempsFile;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private lastHeartbeatSave = 0;

  constructor(private deps: TempsDeps) {
    this.state = this.load();
    this.recoverAfterRestart();
  }

  /* ─────────────────────────────── storage ─────────────────────────────── */

  private filePath(): string { return join(this.deps.dataDir, 'temps.json'); }
  queueDir(): string { return join(this.deps.dataDir, 'temp-requests'); }

  private load(): TempsFile {
    try {
      const p = this.filePath();
      if (existsSync(p)) return parseTempsFile(JSON.parse(readFileSync(p, 'utf8')));
    } catch { /* corrupt → start empty */ }
    return parseTempsFile(null);
  }

  private save(notify = true): void {
    try {
      const p = this.filePath();
      const tmp = `${p}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.state, null, 2), 'utf8');
      renameSync(tmp, p);
    } catch (e) {
      console.error('[temps] save failed:', e);
    }
    if (notify) this.deps.onChange();
  }

  private hiveRoot(): string | null {
    const home = this.deps.harnessHome();
    return home ? join(home, 'hive') : null;
  }

  /** Spawn-request files waiting for the controller (index.ts reads these). */
  requestFiles(): string[] {
    const dir = this.queueDir();
    try {
      if (!existsSync(dir)) return [];
      return readdirSync(dir).filter((f) => /^temp-[a-z0-9-]+\.json$/.test(f)).sort().map((f) => join(dir, f));
    } catch { return []; }
  }

  view(): TempsView {
    return { ...this.state, running: runningCount(this.state.active), hive: this.hiveRoot() !== null };
  }

  /* ──────────────────────────────── verbs ──────────────────────────────── */

  hire(raw: unknown): { ok: true; temp: TempRecord } | { ok: false; error: string } {
    const v = validateTempRequest(raw);
    if (!v.ok) return v;
    if (!this.hiveRoot()) return { ok: false, error: 'noHive' };
    const cwd = resolve(expandHome(v.value.cwd));
    if (!isAbsolute(cwd)) return { ok: false, error: 'cwd' };
    try { if (!statSync(cwd).isDirectory()) return { ok: false, error: 'cwd' }; } catch { return { ok: false, error: 'cwd' }; }
    if (this.state.active.length >= 50) return { ok: false, error: 'tooMany' };
    const now = Date.now();
    const id = newTempId(now);
    const temp: TempRecord = {
      id, workerId: tempWorkerId(id), job: v.value.job, provider: v.value.provider,
      cwd, isolate: v.value.isolate, state: 'queued', createdAt: now
    };
    if (v.value.model) temp.model = v.value.model;
    this.state.active.push(temp);
    this.save();
    void this.tick();
    return { ok: true, temp };
  }

  /** Cancel a queued temp, or ask for a running one to stop. A running temp's
   *  worker id comes back so the renderer can call `workers:stop` (the
   *  controller's own safe teardown); this module never kills a process. */
  stop(id: unknown): { ok: boolean; workerId?: string; error?: string } {
    if (typeof id !== 'string') return { ok: false, error: 'bad id' };
    const rec = this.state.active.find((t) => t.id === id);
    if (!rec) return { ok: false, error: 'not found' };
    if (rec.state === 'queued') {
      this.finish(rec, { endedAt: Date.now(), outcome: 'stopped', tokens: null });
      return { ok: true };
    }
    if (rec.state === 'starting') {
      // Still in our queue → take it back before the controller sees it.
      const file = join(this.queueDir(), `${rec.id}.json`);
      let reclaimed = false;
      try { if (existsSync(file)) { unlinkSync(file); reclaimed = true; } } catch { /* the controller has it */ }
      if (reclaimed) {
        this.finish(rec, { endedAt: Date.now(), outcome: 'stopped', tokens: null });
        return { ok: true };
      }
    }
    rec.stopRequested = true;
    this.save();
    return { ok: true, workerId: rec.state === 'running' ? rec.workerId : undefined };
  }

  setMax(n: unknown): number {
    this.state.maxConcurrent = clampMaxTemps(n);
    this.save();
    void this.tick();
    return this.state.maxConcurrent;
  }

  clearHistory(): void {
    this.state.history = [];
    this.save();
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, TICK_MS);
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    // Persist the heartbeat so a temp running at quit gets an honest end time.
    if (this.state.active.some((t) => t.state === 'running')) this.save(false);
  }

  /* ─────────────────────────────── watching ────────────────────────────── */

  /**
   * After an app restart the controller's in-memory worker table is empty: a
   * temp that was on the floor is gone (or comes back as a regular restored
   * agent, which is no longer a temp). Settle those rather than leave them
   * holding a slot forever. A request still sitting in our queue is untouched —
   * the controller will pick it up.
   */
  private recoverAfterRestart(): void {
    let changed = false;
    for (const rec of this.state.active) {
      const queued = existsSync(join(this.queueDir(), `${rec.id}.json`));
      if (rec.state === 'running' || (rec.state === 'starting' && !queued)) {
        rec.state = 'finishing';
        rec.endedAt = rec.lastSeenAt ?? rec.startedAt ?? rec.submittedAt ?? Date.now();
        if (!rec.outcome) rec.outcome = rec.startedAt ? 'interrupted' : 'failed';
        if (!rec.startedAt && !rec.error) rec.error = 'interrupted';
        changed = true;
      }
    }
    if (changed) this.save(false);
  }

  private readRegistry(root: string): Record<string, { archived?: boolean; lastSeen?: number; isGod?: boolean }> {
    try {
      const reg = JSON.parse(readFileSync(join(root, 'registry.json'), 'utf8')) as { agents?: Record<string, { archived?: boolean; lastSeen?: number; isGod?: boolean }> };
      return reg.agents && typeof reg.agents === 'object' ? reg.agents : {};
    } catch { return {}; }
  }

  /** Did the worker post `act:"done"` after it started? Same scan (outbox and
   *  outbox/.sent, created_at else mtime) the controller releases it on. */
  private doneSignaled(root: string, rec: TempRecord): boolean {
    const since = rec.startedAt ?? rec.submittedAt ?? rec.createdAt;
    const base = join(root, 'agents', rec.workerId, 'outbox');
    for (const dir of [base, join(base, '.sent')]) {
      let files: string[];
      try { files = readdirSync(dir); } catch { continue; }
      for (const f of files) {
        if (!f.endsWith('.json')) continue;
        try {
          const fp = join(dir, f);
          const msg = JSON.parse(readFileSync(fp, 'utf8')) as { act?: string; created_at?: string };
          if (msg.act !== 'done') continue;
          let ts = Date.parse(msg.created_at ?? '');
          if (!Number.isFinite(ts)) ts = statSync(fp).mtimeMs;
          if (ts >= since) return true;
        } catch { /* partial file */ }
      }
    }
    return false;
  }

  /**
   * Why the controller turned a request down. processSpawnRequest tells the
   * orchestrator (`Spawn-request <file> rejected: <reason>.`) and nobody else,
   * so the reason is read back out of his inbox rather than lost — "engine CLI
   * "codex" is not installed" is worth more on the row than "rejected".
   */
  private rejectionReason(root: string, rec: TempRecord, reg: Record<string, { isGod?: boolean }>): string | null {
    const godId = (() => {
      try {
        const r = JSON.parse(readFileSync(join(root, 'registry.json'), 'utf8')) as { godId?: string };
        if (typeof r.godId === 'string' && /^[A-Za-z0-9._-]+$/.test(r.godId)) return r.godId;
      } catch { /* fall through */ }
      return Object.entries(reg).find(([, a]) => a.isGod)?.[0] ?? 'god';
    })();
    const needle = `Spawn-request ${rec.id}.json rejected: `;
    const since = rec.submittedAt ?? rec.createdAt;
    const inbox = join(root, 'agents', godId, 'inbox');
    for (const dir of [inbox, join(inbox, '.done')]) {
      let files: string[];
      try { files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort(); } catch { continue; }
      for (const f of files.slice(-300)) {
        const fp = join(dir, f);
        try {
          if (statSync(fp).mtimeMs < since - 1000) continue;
          const body = (JSON.parse(readFileSync(fp, 'utf8')) as { body?: unknown }).body;
          if (typeof body !== 'string') continue;
          const at = body.indexOf(needle);
          if (at < 0) continue;
          const rest = body.slice(at + needle.length).split('\n')[0].replace(/\.$/, '').trim();
          return rest ? rest.slice(0, 300) : null;
        } catch { /* partial file */ }
      }
    }
    return null;
  }

  /** Tokens from the ledger bytes appended since this temp was handed over. */
  private async tokensFor(root: string, rec: TempRecord): Promise<number | null> {
    const ledger = join(root, 'cost-ledger.jsonl');
    let fh: Awaited<ReturnType<typeof open>> | null = null;
    try {
      const size = statSync(ledger).size;
      let from = rec.ledgerOffset ?? 0;
      if (from > size) from = 0; // rotated or rewritten
      // Bounded: even a long temp on a busy floor appends a few MB at most.
      const length = Math.min(size - from, 32 * 1024 * 1024);
      if (length <= 0) return null;
      fh = await open(ledger, 'r');
      const buf = Buffer.alloc(length);
      await fh.read(buf, 0, length, from);
      return foldLedgerTokens(buf.toString('utf8').split('\n'), rec.workerId);
    } catch {
      return null;
    } finally {
      try { await fh?.close(); } catch { /* noop */ }
    }
  }

  /** Where spawnAgentCore puts an isolated agent's worktree. */
  private worktreePath(rec: TempRecord): string | null {
    const home = this.deps.harnessHome();
    if (!home || !rec.isolate) return null;
    return join(home, 'worktrees', rec.workerId.replace(/[^A-Za-z0-9._-]/g, '-'));
  }

  private finish(rec: TempRecord, end: Parameters<typeof buildHistoryRow>[1]): void {
    this.state.history = pushHistory(this.state.history, buildHistoryRow(rec, end));
    this.state.active = this.state.active.filter((t) => t.id !== rec.id);
    this.save();
  }

  private async finalize(root: string, rec: TempRecord): Promise<void> {
    const outcome: TempOutcome = settleOutcome(rec, rec.startedAt ? this.doneSignaled(root, rec) : false);
    const tokens = rec.startedAt ? await this.tokensFor(root, rec) : null;
    const path = this.worktreePath(rec);
    let worktree;
    if (path && rec.startedAt) {
      const exists = existsSync(path);
      let unmerged: { keep: boolean; branch?: string; detail?: string } | null = null;
      if (exists) {
        try { unmerged = await worktreeHasUnintegratedWork(path, rec.baseBranch ?? 'main'); } catch { unmerged = null; }
      }
      worktree = worktreeVerdict({ isolate: rec.isolate, path, exists, unmerged });
    }
    // The record may have been finished by a concurrent stop() while we awaited.
    if (!this.state.active.includes(rec)) return;
    this.finish(rec, { endedAt: rec.endedAt ?? Date.now(), outcome, tokens, worktree });
  }

  private async submit(rec: TempRecord, root: string): Promise<void> {
    try {
      if (!statSync(rec.cwd).isDirectory()) throw new Error('not a directory');
    } catch {
      rec.outcome = 'failed';
      rec.error = 'cwd';
      this.finish(rec, { endedAt: Date.now(), outcome: 'failed', tokens: null });
      return;
    }
    if (rec.isolate) {
      try {
        const br = await getBranch(rec.cwd);
        if ('current' in br && br.current) rec.baseBranch = br.current;
      } catch { /* not a repo — the controller falls back to the shared folder */ }
    }
    try { rec.ledgerOffset = statSync(join(root, 'cost-ledger.jsonl')).size; } catch { rec.ledgerOffset = 0; }
    const request = {
      id: rec.id,
      objective: rec.job,
      command: tempCommandLine(rec.provider, rec.model, this.deps.claudeCommand()),
      provider: rec.provider,
      cwd: rec.cwd,
      name: tempDisplayName(rec.job),
      isolate: rec.isolate
    };
    const dir = this.queueDir();
    try {
      mkdirSync(dir, { recursive: true });
      // Temp name the controller's `*.json` filter cannot match, then rename.
      const tmp = join(dir, `.${rec.id}.tmp`);
      writeFileSync(tmp, JSON.stringify(request, null, 2), 'utf8');
      renameSync(tmp, join(dir, `${rec.id}.json`));
    } catch (e) {
      rec.error = e instanceof Error ? e.message : String(e);
      this.finish(rec, { endedAt: Date.now(), outcome: 'failed', tokens: null });
      return;
    }
    rec.state = 'starting';
    rec.submittedAt = Date.now();
  }

  async tick(): Promise<void> {
    if (this.ticking || this.state.active.length === 0) return;
    const root = this.hiveRoot();
    if (!root) return;
    this.ticking = true;
    let changed = false;
    try {
      const now = Date.now();
      const reg = this.readRegistry(root);
      for (const rec of [...this.state.active]) {
        const agent = reg[rec.workerId];
        if (rec.state === 'starting') {
          const queued = existsSync(join(this.queueDir(), `${rec.id}.json`));
          const since = rec.submittedAt ?? rec.createdAt;
          const failedFile = join(root, 'spawn-requests', '.failed', `${rec.id}.json`);
          if (agent && (agent.lastSeen ?? now) >= since - 1000) {
            rec.state = 'running';
            rec.startedAt = agent.archived === false ? Math.max(since, Math.min(now, agent.lastSeen ?? now)) : since;
            rec.lastSeenAt = now;
            changed = true;
          } else if (!queued && existsSync(failedFile)) {
            rec.outcome = 'failed';
            rec.error = this.rejectionReason(root, rec, reg) ?? 'rejected';
            this.finish(rec, { endedAt: now, outcome: 'failed', tokens: null });
            continue;
          } else if (!queued && now - since > LOST_AFTER_MS) {
            rec.outcome = 'failed';
            rec.error = 'lost';
            this.finish(rec, { endedAt: now, outcome: 'failed', tokens: null });
            continue;
          }
        }
        if (rec.state === 'running') {
          const current = reg[rec.workerId];
          if (!current || current.archived === true) {
            rec.state = 'finishing';
            // setArchived stamps lastSeen at teardown — the real end time.
            const at = current?.lastSeen;
            rec.endedAt = typeof at === 'number' && at >= (rec.startedAt ?? 0) && at <= now ? at : now;
            changed = true;
          } else {
            rec.lastSeenAt = now;
          }
        }
        if (rec.state === 'finishing' && now - (rec.endedAt ?? now) >= SETTLE_MS) {
          await this.finalize(root, rec);
        }
      }
      for (const rec of nextToSubmit(this.state.active, this.state.maxConcurrent)) {
        await this.submit(rec, root);
        changed = true;
      }
      if (changed) {
        this.save();
        this.lastHeartbeatSave = now;
      } else if (now - this.lastHeartbeatSave > HEARTBEAT_SAVE_MS && this.state.active.some((t) => t.state === 'running')) {
        this.save(false);
        this.lastHeartbeatSave = now;
      }
    } catch (e) {
      console.error('[temps] tick failed:', e);
    } finally {
      this.ticking = false;
    }
  }
}
