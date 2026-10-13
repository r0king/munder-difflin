/**
 * The orchestrator's screen — main-process side (owned by the `wsOrchestrator` unit).
 *
 * Three things live here, because each needs the main process:
 *
 *   1. DELIVERIES PAUSED — one floor-wide hold on every agent's queue. The flag
 *      is persisted in `<featureDataDir>/delivery.json`, so it survives a
 *      renderer reload and an app restart, and it is MIRRORED into the two
 *      places that decide whether to type into an agent's terminal, both of
 *      which already read the per-agent `autoDeliveryPaused` control flag:
 *        - `control:snapshot` (index.ts) ORs it in, so the renderer's queue
 *          drain (useHive effect #4) holds every queued message — the inbox
 *          nudges, scheduler and Slack items included, since they all ride
 *          that queue — and every composer says "held" instead of "sending";
 *        - the worker-wake watchdog's facts (index.ts) OR it in, so main stops
 *          nudging workers about their mail too.
 *      "Send now" (a released queue item) and Steer still pass, exactly as
 *      they pass the per-agent pause: the hold must never be a dead end.
 *
 *   2. THE DAILY DOLLAR CAP — the existing `costCapUsd` is a deprecated floor
 *      ceiling on the process-lifetime counter, not a day's spend. This keeps
 *      its own incremental fold of `<hive>/cost-ledger.jsonl` (see
 *      shared/workspace/orchestratorBudget.ts for the arithmetic), persists the
 *      cap in `<featureDataDir>/budget.json`, and when today's spend reaches the
 *      cap pauses deliveries (reason 'budget'), tells every app window and
 *      raises a system notification. Once per (day, cap): a user who resumes
 *      after a trip is not paused again the same day unless the cap changes.
 *
 *   3. THE ROUTING LOG — the tail of `<hive>/log.jsonl` reduced to routed
 *      messages, subjects redacted here before they cross IPC.
 *
 * Plus the default per-agent token cap the breaker falls back to
 * (`orchestratorDefaultAgentTokenCap`, read by index.ts's breaker config).
 */
import { app, ipcMain, Notification } from 'electron';
import { join } from 'node:path';
import { createReadStream, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import type { FeatureContext, FeatureModule } from './types';
import {
  DailySpendFold,
  evaluateCap,
  localDayKey,
  sanitizeCap,
  shouldTripCap,
  type CapTrip
} from '../../shared/workspace/orchestratorBudget';
import { parseRoutingLog } from '../../shared/workspace/orchestratorRouting';
import {
  ORCH_CHANNELS,
  ROUTING_LOG_DEFAULT_LIMIT,
  ROUTING_LOG_MAX_LIMIT,
  type BudgetSnapshot,
  type DeliveryState,
  type OrchestratorState,
  type RoutingLogResult
} from '../../shared/workspace/orchestratorTypes';
import { MAX_AGENT_TOKEN_CAP } from '../../shared/tokenCaps';
import { redactSecrets } from '../hive';

const FEATURE = 'orchestrator';

/** How often the ledger is re-folded and the cap checked. The breaker beat
 *  appends ledger rows every ~30s; checking twice as often keeps the meter
 *  live without doing work nobody sees. */
const BUDGET_BEAT_MS = 15_000;
/** Bytes folded per pass. Each pass parses on the main thread, so it is kept
 *  small and passes yield to the event loop between them; a cold start on a
 *  large ledger catches up over a few ticks instead of in one stall. */
const LEDGER_BYTES_PER_PASS = 2 * 1024 * 1024;
/** Passes per refresh before handing back (the next beat resumes). */
const LEDGER_MAX_PASSES = 16;
/** Trailing bytes of log.jsonl the routing log reads. Routed messages are a
 *  small fraction of that log; 6 MB holds weeks of routing on a busy floor
 *  without ever reading an unbounded file into memory. */
const ROUTING_TAIL_BYTES = 6 * 1024 * 1024;

// ─── Persistence ────────────────────────────────────────────────────────────

interface BudgetFile {
  dailyCapUsd: number | null;
  defaultAgentTokenCap: number | null;
  lastTrip: CapTrip | null;
}

const BUDGET_DEFAULTS: BudgetFile = { dailyCapUsd: null, defaultAgentTokenCap: null, lastTrip: null };
const DELIVERY_DEFAULTS: DeliveryState = { paused: false, reason: null, since: null };

let ctxRef: FeatureContext | null = null;

/** `<userData>/features/orchestrator`. Usable BEFORE register() runs: index.ts
 *  asks `floorDeliveriesPaused()` from IPC handlers that can fire during boot,
 *  and the answer must already be the persisted one. Same path ctx uses. */
function dataDir(): string {
  if (ctxRef) return ctxRef.featureDataDir(FEATURE);
  const dir = join(app.getPath('userData'), 'features', FEATURE);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function readJsonFile(name: string): Record<string, unknown> | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(dataDir(), name), 'utf8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
  } catch { return null; }
}

/** Write-then-rename so a crash mid-write leaves the previous file intact. */
function writeJsonFile(name: string, data: unknown): void {
  try {
    const file = join(dataDir(), name);
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    renameSync(tmp, file);
  } catch (e) {
    console.error(`[orchestrator] could not save ${name}:`, e);
  }
}

function sanitizeTokenCap(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0 || value > MAX_AGENT_TOKEN_CAP) return undefined;
  return value;
}

function loadBudget(): BudgetFile {
  const raw = readJsonFile('budget.json');
  if (!raw) return { ...BUDGET_DEFAULTS };
  const trip = raw.lastTrip as Record<string, unknown> | null | undefined;
  return {
    dailyCapUsd: sanitizeCap(raw.dailyCapUsd) ?? null,
    defaultAgentTokenCap: sanitizeTokenCap(raw.defaultAgentTokenCap) ?? null,
    lastTrip: trip && typeof trip.day === 'string' && typeof trip.capUsd === 'number'
      ? { day: trip.day, capUsd: trip.capUsd }
      : null
  };
}

function loadDelivery(): DeliveryState {
  const raw = readJsonFile('delivery.json');
  if (!raw || raw.paused !== true) return { ...DELIVERY_DEFAULTS };
  return {
    paused: true,
    reason: raw.reason === 'budget' ? 'budget' : 'manual',
    since: typeof raw.since === 'number' && Number.isFinite(raw.since) ? raw.since : Date.now()
  };
}

let budget: BudgetFile | null = null;
let delivery: DeliveryState | null = null;

function budgetFile(): BudgetFile {
  if (!budget) budget = loadBudget();
  return budget;
}

function deliveryState(): DeliveryState {
  if (!delivery) delivery = loadDelivery();
  return delivery;
}

// ─── Exports read by index.ts (the mirrors described above) ─────────────────

/** True while the floor-wide delivery hold is on. Cheap: in-memory after the
 *  first read. Never throws — a broken data dir reads as "not paused". */
export function floorDeliveriesPaused(): boolean {
  try { return deliveryState().paused; } catch { return false; }
}

/** Lift the floor-wide hold. Called by index.ts when Classic's floor switch
 *  resumes delivery: every agent's control snapshot reports this hold, so a
 *  surface that offers "resume" must be able to actually resume it. */
export function liftFloorDeliveryPause(): void {
  try { setDeliveriesPaused(false); } catch { /* best-effort */ }
}

/** The default per-agent token cap (work tokens) for agents without one of
 *  their own, or undefined. Read by the breaker's config on every tick. */
export function orchestratorDefaultAgentTokenCap(): number | undefined {
  try { return budgetFile().defaultAgentTokenCap ?? undefined; } catch { return undefined; }
}

// ─── Deliveries paused ──────────────────────────────────────────────────────

function setDeliveriesPaused(paused: boolean, reason: 'manual' | 'budget' = 'manual'): void {
  const cur = deliveryState();
  if (cur.paused === paused && (!paused || cur.reason === reason)) return;
  delivery = paused
    ? { paused: true, reason, since: cur.paused ? cur.since : Date.now() }
    : { ...DELIVERY_DEFAULTS };
  writeJsonFile('delivery.json', delivery);
  console.log(`[orchestrator] deliveries ${paused ? `paused (${reason})` : 'resumed'}`);
  publish(true);
}

// ─── Ledger fold ────────────────────────────────────────────────────────────

/** Incremental reader over cost-ledger.jsonl: each pass reads only the bytes
 *  appended since the last one. Mirrors costLifetime.ts's reader (byte-exact
 *  tail handling, truncation → start over) feeding DailySpendFold instead. */
class LedgerDayReader {
  private path: string | null = null;
  private offset = 0;
  private tail: Buffer = Buffer.alloc(0);
  readonly fold = new DailySpendFold();
  warm = false;
  private busy = false;

  private reset(path: string | null): void {
    this.path = path;
    this.offset = 0;
    this.tail = Buffer.alloc(0);
    this.fold.reset();
    this.warm = false;
  }

  /** Fold what was appended. Resolves once caught up or after
   *  LEDGER_MAX_PASSES passes; never throws. */
  async refresh(path: string | null): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      if (path !== this.path) this.reset(path);
      if (!path) { this.warm = true; return; }
      for (let pass = 0; pass < LEDGER_MAX_PASSES; pass++) {
        let size: number;
        try { size = statSync(path).size; } catch { this.warm = true; return; } // no ledger yet = no spend
        if (size < this.offset) this.reset(path); // truncated or replaced
        if (size === this.offset) { this.warm = true; return; }
        const end = Math.min(size, this.offset + LEDGER_BYTES_PER_PASS) - 1;
        await new Promise<void>((resolve, reject) => {
          const stream = createReadStream(path, { start: this.offset, end });
          stream.on('data', (chunk: string | Buffer) => this.consume(typeof chunk === 'string' ? Buffer.from(chunk) : chunk));
          stream.on('error', reject);
          stream.on('end', () => resolve());
        });
        this.offset = end + 1;
        if (this.offset >= size) { this.warm = true; return; }
        await new Promise<void>((r) => setImmediate(r));
      }
    } catch (e) {
      console.warn('[orchestrator] cost ledger read failed:', e);
    } finally {
      this.busy = false;
    }
  }

  private consume(chunk: Buffer): void {
    const buf = this.tail.length ? Buffer.concat([this.tail, chunk]) : chunk;
    const cut = buf.lastIndexOf(0x0a);
    if (cut === -1) { this.tail = buf; return; }
    this.tail = Buffer.from(buf.subarray(cut + 1));
    this.fold.addText(buf.subarray(0, cut).toString('utf8'));
  }
}

const ledger = new LedgerDayReader();
let beat: ReturnType<typeof setInterval> | null = null;
let lastPublished = '';

function hiveRoot(): string | null {
  const home = ctxRef?.harnessHome();
  return home ? join(home, 'hive') : null;
}

function snapshot(now = Date.now()): OrchestratorState {
  const b = budgetFile();
  const today = localDayKey(now);
  const root = hiveRoot();
  const spend = ledger.warm ? ledger.fold.spendOn(today) : 0;
  const cap = evaluateCap(spend, b.dailyCapUsd);
  const budgetSnap: BudgetSnapshot = {
    ready: ledger.warm,
    noHive: !root,
    today,
    spendTodayUsd: Math.round(spend * 10_000) / 10_000,
    dailyCapUsd: b.dailyCapUsd,
    level: cap.level,
    fraction: cap.fraction,
    remainingUsd: cap.remainingUsd,
    history: ledger.fold.history(today, 7).map((h) => ({ day: h.day, usd: Math.round(h.usd * 10_000) / 10_000 })),
    byAgent: ledger.fold.agentSpendOn(today).map((a) => ({ agentId: a.agentId, usd: Math.round(a.usd * 10_000) / 10_000 })),
    defaultAgentTokenCap: b.defaultAgentTokenCap,
    lastTrip: b.lastTrip
  };
  return { budget: budgetSnap, delivery: { ...deliveryState() } };
}

/** Push the state to every app window when it changed (or when forced). */
function publish(force = false): OrchestratorState {
  const state = snapshot();
  const key = JSON.stringify(state);
  if (force || key !== lastPublished) {
    lastPublished = key;
    ctxRef?.broadcast(ORCH_CHANNELS.state, state);
  }
  return state;
}

/** Re-fold, enforce the cap, publish. */
async function budgetTick(): Promise<void> {
  const root = hiveRoot();
  await ledger.refresh(root ? join(root, 'cost-ledger.jsonl') : null);
  enforceCap();
  publish();
}

function enforceCap(now = Date.now()): void {
  if (!ledger.warm || !hiveRoot()) return; // a cold fold undercounts — never trip on it
  const b = budgetFile();
  const day = localDayKey(now);
  const spend = ledger.fold.spendOn(day);
  if (!shouldTripCap({ dayKey: day, spendUsd: spend, capUsd: b.dailyCapUsd, lastTrip: b.lastTrip })) return;
  const cap = b.dailyCapUsd as number;
  budget = { ...b, lastTrip: { day, capUsd: cap } };
  writeJsonFile('budget.json', budget);
  setDeliveriesPaused(true, 'budget');
  console.warn(`[orchestrator] daily cap reached: $${spend.toFixed(2)} of $${cap.toFixed(2)} — deliveries paused`);
  // Raised regardless of the lifecycle-notifications setting: that switch is
  // about agents finishing turns, while this is money, at most once a day, and
  // the floor has just been stopped — the user has to hear about it even with
  // the window hidden. Copy is English like the breaker's toasts in index.ts
  // (main has no i18n); the in-app banner is the translated surface.
  try {
    if (Notification.isSupported()) {
      new Notification({
        title: 'Daily spend cap reached',
        body: `Today's spend is $${spend.toFixed(2)} of your $${cap.toFixed(2)} cap. Deliveries are paused until you resume them.`
      }).show();
    }
  } catch { /* unsupported platform */ }
}

// ─── Routing log ────────────────────────────────────────────────────────────

async function readRoutingLog(limitRaw: unknown): Promise<RoutingLogResult> {
  const limit = typeof limitRaw === 'number' && Number.isInteger(limitRaw) && limitRaw > 0
    ? Math.min(limitRaw, ROUTING_LOG_MAX_LIMIT)
    : ROUTING_LOG_DEFAULT_LIMIT;
  const root = hiveRoot();
  if (!root) return { ok: false, entries: [], truncated: false, error: 'no-hive' };
  const file = join(root, 'log.jsonl');
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(file, 'r');
    const { size } = await handle.stat();
    const start = Math.max(0, size - ROUTING_TAIL_BYTES);
    const length = size - start;
    const buf = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const r = await handle.read(buf, read, length - read, start + read);
      if (r.bytesRead === 0) break;
      read += r.bytesRead;
    }
    // A window that starts mid-file starts mid-line (possibly mid-character):
    // drop that first partial line rather than mis-parse it.
    const parsed = parseRoutingLog(buf.subarray(0, read).toString('utf8'), { skipFirstLine: start > 0 });
    const entries = parsed.length > limit ? parsed.slice(parsed.length - limit) : parsed;
    for (const e of entries) e.subject = redactSecrets(e.subject);
    return { ok: true, entries, truncated: start > 0 || parsed.length > limit };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    // A floor that has routed nothing yet has no log: that is empty, not broken.
    if (code === 'ENOENT') return { ok: true, entries: [], truncated: false };
    return { ok: false, entries: [], truncated: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    await handle?.close().catch(() => { /* already closed */ });
  }
}

// ─── Module ─────────────────────────────────────────────────────────────────

export const orchestratorFeature: FeatureModule = {
  name: FEATURE,
  register(ctx) {
    ctxRef = ctx;

    ipcMain.handle(ORCH_CHANNELS.getState, async () => {
      await budgetTick();
      return snapshot();
    });

    ipcMain.handle(ORCH_CHANNELS.setDailyCap, (_evt, value: unknown) => {
      const cap = sanitizeCap(value);
      if (cap === undefined) throw new Error('invalid daily cap');
      budget = { ...budgetFile(), dailyCapUsd: cap };
      writeJsonFile('budget.json', budget);
      // A new cap is evaluated at once: setting one below today's spend pauses
      // the floor now (the UI warns before saving), not at the next beat.
      enforceCap();
      return publish(true);
    });

    ipcMain.handle(ORCH_CHANNELS.setDefaultTokenCap, (_evt, value: unknown) => {
      const cap = sanitizeTokenCap(value);
      if (cap === undefined) throw new Error('invalid token cap');
      budget = { ...budgetFile(), defaultAgentTokenCap: cap };
      writeJsonFile('budget.json', budget);
      return publish(true);
    });

    ipcMain.handle(ORCH_CHANNELS.setDeliveriesPaused, (_evt, value: unknown) => {
      if (typeof value !== 'boolean') throw new Error('invalid paused flag');
      setDeliveriesPaused(value, 'manual');
      return publish(true);
    });

    ipcMain.handle(ORCH_CHANNELS.routingLog, (_evt, opts: unknown) => {
      const limit = opts && typeof opts === 'object' ? (opts as { limit?: unknown }).limit : undefined;
      return readRoutingLog(limit);
    });

    void budgetTick();
    beat = setInterval(() => { void budgetTick(); }, BUDGET_BEAT_MS);
  },
  dispose() {
    if (beat) clearInterval(beat);
    beat = null;
  }
};
