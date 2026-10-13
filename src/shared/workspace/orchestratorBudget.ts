/**
 * The orchestrator's daily budget — pure logic shared by main (which folds the
 * cost ledger and enforces the cap) and the renderer (which shows it).
 *
 * WHAT "SPEND TODAY" MEANS
 * ────────────────────────
 * `<hive>/cost-ledger.jsonl` holds one row per usage sample, and each row's
 * `usd` is CUMULATIVE for its (agent, session) since the app process started
 * (see src/main/costLifetime.ts for why the counter restarts on every app
 * restart). Today's spend is therefore not a sum of rows but a sum of the
 * INCREASES between consecutive rows of the same (agent, session), each
 * increase booked to the local calendar day of the row that observed it:
 *
 *   - first row ever seen for a key → its whole `usd` is new spend;
 *   - a row above the previous one   → the difference is new spend;
 *   - a row BELOW the previous one   → the counter restarted (app restart) and
 *     climbed back to `usd` since, so `usd` itself is new spend. Same reset
 *     signature costLifetime.ts uses, same float-noise epsilon.
 *
 * The beat appends a row roughly every 30 seconds, so an increase lands on the
 * day it happened to within one beat. A session that spans midnight splits
 * correctly: yesterday's rows book yesterday's growth, today's book today's.
 *
 * LOCAL DAY, DST
 * ──────────────
 * "Today" is the user's local calendar day, keyed `YYYY-MM-DD` from the local
 * date of a timestamp. The key is derived from the Date's local fields, never
 * from `ts - ts % 86_400_000`, so a 23- or 25-hour day around a DST switch is
 * still exactly one day and midnight is the wall-clock midnight.
 *
 * Import-free on purpose so node:test loads it through test/load-ts.cjs.
 */

/** One ledger row reduced to what the budget needs. */
export interface LedgerRow {
  agentId: string;
  sessionId: string;
  ts: number;
  usd: number;
}

/** Float noise guard, identical to costLifetime.ts: real resets drop by cents
 *  at minimum, anything smaller is arithmetic dust. */
const EPS = 1e-9;

/** The highest daily cap the UI and IPC accept. Large enough to never be the
 *  binding constraint for a real floor, small enough to reject a typo of
 *  several extra zeros. */
export const MAX_DAILY_CAP_USD = 100_000;

/** Fraction of the cap at which the meter turns to a warning. */
export const NEAR_CAP_FRACTION = 0.8;

/** Days of per-agent breakdown kept in memory. The floor total is kept for
 *  every day (one number each); the per-agent split only for the recent past
 *  the Budget tab can show. */
export const AGENT_BREAKDOWN_DAYS = 31;

/** Parse one ledger line, or null for a half-written / foreign / bad line.
 *  Never throws — the ledger is append-only and a crash mid-append leaves a
 *  torn last line behind. */
export function parseLedgerLine(line: string): LedgerRow | null {
  if (!line) return null;
  let raw: unknown;
  try { raw = JSON.parse(line); } catch { return null; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.agent_id !== 'string' || !r.agent_id) return null;
  const ts = typeof r.ts === 'number' && Number.isFinite(r.ts) ? r.ts : NaN;
  if (!Number.isFinite(ts) || ts <= 0) return null;
  const usd = typeof r.usd === 'number' && Number.isFinite(r.usd) && r.usd >= 0 ? r.usd : 0;
  return {
    agentId: r.agent_id,
    sessionId: typeof r.session_id === 'string' ? r.session_id : '',
    ts,
    usd
  };
}

const pad2 = (n: number): string => (n < 10 ? `0${n}` : String(n));

/** `YYYY-MM-DD` of `ts` in the process's local time zone. */
export function localDayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Local midnight that starts the day containing `ts`, and the one that ends
 *  it. Built from calendar fields, so the span is 23 or 25 hours on a DST
 *  switch day and 24 otherwise. */
export function localDayBounds(ts: number): { start: number; end: number } {
  const d = new Date(ts);
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const end = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
  return { start, end };
}

/** The day key `offset` calendar days from `dayKey` (negative = earlier). */
export function shiftDayKey(dayKey: string, offset: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dayKey);
  if (!m) return dayKey;
  // Noon, not midnight: a DST switch can never push noon across a date line.
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + offset, 12);
  return localDayKey(d.getTime());
}

/**
 * Incremental fold of ledger rows into spend per local day. Feed rows in file
 * order with `add`; read with `spendOn` / `agentSpendOn` / `history`.
 */
export class DailySpendFold {
  /** `agentId \t sessionId` → last cumulative usd seen. */
  private readonly last = new Map<string, number>();
  /** dayKey → floor spend that day. */
  private readonly days = new Map<string, number>();
  /** dayKey → agentId → spend that day (recent days only, see prune). */
  private readonly agentDays = new Map<string, Map<string, number>>();

  add(row: LedgerRow): void {
    const key = `${row.agentId}\t${row.sessionId}`;
    const prev = this.last.get(key);
    let delta: number;
    if (prev === undefined) delta = row.usd;
    else if (row.usd < prev - EPS) delta = row.usd; // counter restarted, then climbed to usd
    else delta = Math.max(0, row.usd - prev);
    this.last.set(key, row.usd);
    if (delta <= EPS) return;
    const day = localDayKey(row.ts);
    this.days.set(day, (this.days.get(day) ?? 0) + delta);
    let perAgent = this.agentDays.get(day);
    if (!perAgent) {
      perAgent = new Map();
      this.agentDays.set(day, perAgent);
      this.prune(day);
    }
    perAgent.set(row.agentId, (perAgent.get(row.agentId) ?? 0) + delta);
  }

  /** Fold every parseable line of a text chunk (whole lines only). */
  addText(text: string): void {
    for (const line of text.split('\n')) {
      const row = parseLedgerLine(line.trim());
      if (row) this.add(row);
    }
  }

  /** Floor spend booked to `dayKey`, 0 when none. */
  spendOn(dayKey: string): number {
    return this.days.get(dayKey) ?? 0;
  }

  /** Per-agent spend booked to `dayKey`, biggest first. */
  agentSpendOn(dayKey: string): Array<{ agentId: string; usd: number }> {
    const m = this.agentDays.get(dayKey);
    if (!m) return [];
    return [...m.entries()]
      .map(([agentId, usd]) => ({ agentId, usd }))
      .sort((a, b) => b.usd - a.usd || a.agentId.localeCompare(b.agentId));
  }

  /** The `n` days ending at `endDayKey` (inclusive), oldest first, with 0 for
   *  days nothing was spent. */
  history(endDayKey: string, n: number): Array<{ day: string; usd: number }> {
    const out: Array<{ day: string; usd: number }> = [];
    for (let i = n - 1; i >= 0; i--) {
      const day = shiftDayKey(endDayKey, -i);
      out.push({ day, usd: this.spendOn(day) });
    }
    return out;
  }

  /** Forget everything (the ledger was truncated or the hive changed). */
  reset(): void {
    this.last.clear();
    this.days.clear();
    this.agentDays.clear();
  }

  /** Keep the per-agent split for the most recent AGENT_BREAKDOWN_DAYS days
   *  only. Day keys sort lexicographically in date order. */
  private prune(newest: string): void {
    if (this.agentDays.size <= AGENT_BREAKDOWN_DAYS) return;
    const cutoff = shiftDayKey(newest, -(AGENT_BREAKDOWN_DAYS - 1));
    for (const day of [...this.agentDays.keys()]) {
      if (day < cutoff) this.agentDays.delete(day);
    }
  }
}

/** Convenience for tests and one-shot callers: spend per day of a whole
 *  ledger held in memory. */
export function dailySpendFromLedger(text: string): DailySpendFold {
  const fold = new DailySpendFold();
  fold.addText(text);
  return fold;
}

// ─── Cap evaluation ─────────────────────────────────────────────────────────

export type CapLevel = 'none' | 'ok' | 'near' | 'over';

export interface CapEvaluation {
  level: CapLevel;
  /** spend / cap, unclamped (1.25 = 25% over). 0 without a cap. */
  fraction: number;
  /** cap - spend, never negative. null without a cap. */
  remainingUsd: number | null;
}

/** Where today's spend sits against the cap. A cap of null / 0 / negative /
 *  non-finite means "no cap". Reaching the cap exactly counts as over: the
 *  cap is the most the user agreed to spend, and the breaker acts on it. */
export function evaluateCap(spendUsd: number, capUsd: number | null | undefined): CapEvaluation {
  const spend = Number.isFinite(spendUsd) && spendUsd > 0 ? spendUsd : 0;
  if (typeof capUsd !== 'number' || !Number.isFinite(capUsd) || capUsd <= 0) {
    return { level: 'none', fraction: 0, remainingUsd: null };
  }
  const fraction = spend / capUsd;
  const level: CapLevel = spend >= capUsd - EPS ? 'over' : fraction >= NEAR_CAP_FRACTION ? 'near' : 'ok';
  return { level, fraction, remainingUsd: Math.max(0, capUsd - spend) };
}

/** What the enforcer last did, persisted beside the cap so a restart neither
 *  forgets a trip nor repeats it. */
export interface CapTrip {
  day: string;
  capUsd: number;
}

/**
 * Should the cap trip now? Once per (day, cap value): a user who resumes
 * deliveries after a trip is not paused again the same day for the same cap,
 * but raising the cap and crossing it again, or a new day, trips afresh.
 */
export function shouldTripCap(input: {
  dayKey: string;
  spendUsd: number;
  capUsd: number | null | undefined;
  lastTrip: CapTrip | null | undefined;
}): boolean {
  if (evaluateCap(input.spendUsd, input.capUsd).level !== 'over') return false;
  const t = input.lastTrip;
  return !(t && t.day === input.dayKey && Math.abs(t.capUsd - (input.capUsd as number)) < 0.005);
}

/**
 * Parse what the user typed into the cap field. Accepts `10`, `10.5`, `$10`,
 * ` 1,250.00 `; an empty field clears the cap. Returns 'invalid' for anything
 * else, zero, negatives and values above MAX_DAILY_CAP_USD. Rounded to cents.
 */
export function parseCapInput(text: string): number | null | 'invalid' {
  const s = text.trim().replace(/^\$/, '').replace(/,/g, '').trim();
  if (!s) return null;
  if (!/^\d+(\.\d+)?$/.test(s)) return 'invalid';
  const n = Math.round(Number(s) * 100) / 100;
  if (!Number.isFinite(n) || n <= 0 || n > MAX_DAILY_CAP_USD) return 'invalid';
  return n;
}

/**
 * Parse a token count as typed: `500000`, `500k`, `1.5M`, `2b`, `1,000,000`.
 * An empty field clears the cap (null). Zero, negatives, junk and anything
 * above `max` are 'invalid'.
 */
export function parseTokenInput(text: string, max: number): number | null | 'invalid' {
  const s = text.trim().replace(/,/g, '').toLowerCase();
  if (!s) return null;
  const m = /^(\d+(?:\.\d+)?)\s*([kmb])?$/.exec(s);
  if (!m) return 'invalid';
  const mult = m[2] === 'k' ? 1e3 : m[2] === 'm' ? 1e6 : m[2] === 'b' ? 1e9 : 1;
  const n = Math.round(Number(m[1]) * mult);
  return Number.isFinite(n) && n > 0 && n <= max ? n : 'invalid';
}

/** Validate a cap that crossed IPC: a finite positive number within bounds
 *  (rounded to cents), or null to clear. Anything else → undefined (reject). */
export function sanitizeCap(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > MAX_DAILY_CAP_USD) return undefined;
  return Math.round(value * 100) / 100;
}
