/**
 * Tasks board — main-process side (owned by the `wsTasks` unit).
 *
 * The ledger is hive/tasks.json, and every read and write of it already has an
 * IPC path (window.cth.hiveTasks / hiveAddTask / hivePatchTask / hiveDeleteTask,
 * with src/shared/taskLedger.ts holding the non-destructive merge rules). This
 * module adds the one thing the ledger cannot say about itself: WHEN each card
 * last changed. That is what "stale · 6h" and "done cards leave the board on
 * their own" need, and the hand-written file has no reliable per-card stamp.
 *
 * So main watches. Every OBSERVE_MS, and whenever the Tasks screen asks, it
 * reads the ledger, fingerprints each card and folds the result into a small
 * state file (src/shared/workspace/tasksActivity.ts holds the rules and their
 * tests). The state lives under userData — never in the hive repo, which the
 * hive commits and MemPalace mines — one file per hive folder, so switching
 * hives does not mix their histories.
 *
 * Read-only with respect to the hive: this module never writes tasks.json. The
 * human's moves go to the orchestrator as a message (the renderer's Send), and
 * he writes the ledger.
 *
 * Channels:
 *   feat:tasks:activity  (invoke) → TasksActivityReply
 */
import { ipcMain } from 'electron';
import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import { basename, join } from 'node:path';
import { deriveTaskKey, type TasksActivityReply } from '../../shared/workspace/tasks';
import {
  activityMap,
  observeLedger,
  parseActivityState,
  type ActivityState
} from '../../shared/workspace/tasksActivity';
import type { FeatureContext, FeatureModule } from './types';

const CHANNEL_ACTIVITY = 'feat:tasks:activity';

/** Background observation cadence. The ledger changes at the pace agents
 *  work, and the screen asks on every change it sees anyway; this only keeps
 *  the record honest while the Tasks screen is closed. */
const OBSERVE_MS = 30_000;
/** A screen request within this window of the last read reuses it. The shared
 *  ledger poller ticks every 5s and every subscriber may ask at once. */
const REUSE_MS = 2_000;
/** Refuse to parse a ledger beyond this (the largest seen in the wild is
 *  ~440KB); a runaway file must not stall the main thread every 30s. */
const MAX_LEDGER_BYTES = 16 * 1024 * 1024;

interface Tracker {
  /** Absolute path of the hive root this state belongs to. */
  root: string;
  /** Hash of `root` — names the state file and is the renderer's ledgerId. */
  id: string;
  file: string;
  state: ActivityState | null;
  loaded: boolean;
  lastObservedAt: number;
  lastError: string | null;
}

let ctxRef: FeatureContext | null = null;
let tracker: Tracker | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let running: Promise<void> | null = null;

function hiveRoot(): string | null {
  const home = ctxRef?.harnessHome();
  return home ? join(home, 'hive') : null;
}

const rootId = (root: string): string => createHash('sha256').update(root).digest('hex').slice(0, 16);

function currentTracker(): Tracker | null {
  const root = hiveRoot();
  if (!root || !ctxRef) return null;
  if (!tracker || tracker.root !== root) {
    // One state file per hive root: `<userData>/features/tasks/activity-<hash>.json`.
    const id = rootId(root);
    const file = join(ctxRef.featureDataDir('tasks'), `activity-${id}.json`);
    tracker = { root, id, file, state: null, loaded: false, lastObservedAt: 0, lastError: null };
  }
  return tracker;
}

async function loadState(t: Tracker): Promise<void> {
  if (t.loaded) return;
  t.loaded = true;
  try {
    t.state = parseActivityState(JSON.parse(await fsp.readFile(t.file, 'utf8')));
  } catch {
    t.state = null; // missing or corrupt: a first look
  }
}

async function saveState(t: Tracker): Promise<void> {
  if (!t.state) return;
  // Write-then-rename so a crash mid-write leaves the previous record intact.
  const tmp = `${t.file}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(t.state), 'utf8');
  await fsp.rename(tmp, t.file);
}

/** Read the ledger once and fold it into the tracker. Never throws; a ledger
 *  caught mid-write (unparseable) skips this observation and keeps the last. */
async function observe(t: Tracker): Promise<void> {
  await loadState(t);
  const ledgerPath = join(t.root, 'tasks.json');
  let raw: unknown;
  let mtimeMs: number | null = null;
  try {
    const st = await fsp.stat(ledgerPath);
    if (st.size > MAX_LEDGER_BYTES) {
      t.lastError = 'ledger too large';
      return;
    }
    mtimeMs = st.mtimeMs;
    raw = JSON.parse(await fsp.readFile(ledgerPath, 'utf8'));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    // No ledger yet is an empty board, not an error.
    if (code === 'ENOENT') raw = { tasks: [] };
    else { t.lastError = 'ledger unreadable'; return; }
  }
  const now = Date.now();
  const { state, changed } = observeLedger(t.state, raw, now, mtimeMs);
  t.state = state;
  t.lastObservedAt = now;
  t.lastError = null;
  if (changed) {
    try { await saveState(t); } catch (e) { console.warn('[tasks] could not save card activity:', e); }
  }
}

/** One observation at a time; concurrent callers share it. */
function observeNow(): Promise<void> {
  if (running) return running;
  const t = currentTracker();
  if (!t) return Promise.resolve();
  running = observe(t).finally(() => { running = null; });
  return running;
}

async function activityReply(): Promise<TasksActivityReply> {
  const t = currentTracker();
  if (!t) return { ok: false, error: 'no hive is open' };
  if (Date.now() - t.lastObservedAt > REUSE_MS) await observeNow();
  const home = ctxRef?.harnessHome() ?? '';
  return {
    ok: true,
    ledgerId: t.id,
    activity: activityMap(t.state),
    folderKey: deriveTaskKey(basename(home)),
    observedAt: t.lastObservedAt,
    ...(t.lastError ? { warning: t.lastError } : {})
  };
}

export const tasksFeature: FeatureModule = {
  name: 'tasks',
  register(ctx) {
    ctxRef = ctx;
    // Takes no arguments, so there is nothing from the renderer to validate.
    ipcMain.handle(CHANNEL_ACTIVITY, () => activityReply());
    void observeNow();
    timer = setInterval(() => { void observeNow(); }, OBSERVE_MS);
  },
  dispose() {
    if (timer) clearInterval(timer);
    timer = null;
    try { ipcMain.removeHandler(CHANNEL_ACTIVITY); } catch { /* already gone */ }
  }
};
