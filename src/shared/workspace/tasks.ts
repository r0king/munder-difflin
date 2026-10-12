/**
 * The Workspace Tasks screen's model of the task ledger (`hive/tasks.json`).
 *
 * Pure: no React, no Electron, no `window`. The renderer screen, the main
 * process's activity tracker (tasksActivity.ts) and the node tests all import it.
 *
 * The ledger is a HAND-WRITTEN file — the orchestrator edits it with whatever
 * tools it has, so every field but the array itself is optional in practice and
 * a status can arrive spelled `in_progress` or `In Review` rather than `doing`.
 * Everything that reads a raw card goes through `normalizeLedger`, which never
 * throws and never drops a card: a card nobody can classify lands in To do, the
 * same fallback the Classic kanban's parseTasks uses.
 */

// ─── Columns ────────────────────────────────────────────────────────────────

/** The four board columns. Also the canonical ledger `status` values — the
 *  orchestrator is asked to write exactly these. */
export type TaskColumn = 'todo' | 'doing' | 'blocked' | 'done';

export const TASK_COLUMNS: readonly TaskColumn[] = ['todo', 'doing', 'blocked', 'done'];

export function isTaskColumn(value: unknown): value is TaskColumn {
  return typeof value === 'string' && (TASK_COLUMNS as readonly string[]).includes(value);
}

/**
 * Status spellings seen in hand-written ledgers, keyed by their squashed form
 * (lower case, every run of non-alphanumerics removed — so `In Review`,
 * `in-review` and `in_review` are all `inreview`).
 */
const STATUS_SYNONYMS: Record<string, TaskColumn> = {
  todo: 'todo', backlog: 'todo', open: 'todo', new: 'todo', pending: 'todo', queued: 'todo',
  planned: 'todo', ready: 'todo', triage: 'todo', notstarted: 'todo', next: 'todo',

  doing: 'doing', inprogress: 'doing', progress: 'doing', wip: 'doing', active: 'doing',
  working: 'doing', started: 'doing', ongoing: 'doing', review: 'doing', inreview: 'doing',
  reviewing: 'doing', testing: 'doing', qa: 'doing', dispatched: 'doing', assigned: 'doing',

  blocked: 'blocked', waiting: 'blocked', onhold: 'blocked', hold: 'blocked', held: 'blocked',
  stuck: 'blocked', paused: 'blocked', needsinput: 'blocked', needshuman: 'blocked',
  waitingonhuman: 'blocked', waitingforhuman: 'blocked', askme: 'blocked',

  done: 'done', complete: 'done', completed: 'done', closed: 'done', resolved: 'done',
  finished: 'done', shipped: 'done', merged: 'done', delivered: 'done', cancelled: 'done',
  canceled: 'done', wontfix: 'done', dropped: 'done', archived: 'done'
};

/** Map whatever the ledger says a card's status is to a board column. */
export function columnForStatus(raw: unknown): TaskColumn {
  if (typeof raw !== 'string') return 'todo';
  const squashed = raw.toLowerCase().replace(/[^a-z0-9]+/g, '');
  return STATUS_SYNONYMS[squashed] ?? 'todo';
}

// ─── The normalized card ────────────────────────────────────────────────────

export interface WsTaskAsk {
  q: string;
  askedAt?: string;
}

export interface WsTask {
  /** The ledger id (`bmt-12`), or the same synthetic `t-xxxx` the Classic
   *  kanban derives, so `openTaskDetail(id)` finds the card in the overlay. */
  id: string;
  /** Unique within one normalized ledger — `id`, suffixed when the hand-written
   *  file repeats an id. Use it for React keys, never for the ledger. */
  key: string;
  title: string;
  description?: string;
  /** Agent id, as the ledger stores it. */
  assignee?: string;
  column: TaskColumn;
  /** The status exactly as written, for the List view's tooltip and the
   *  message to the orchestrator. */
  rawStatus: string;
  /** 1 (lowest) … 5 (highest); 3 when the card does not say. */
  priority: number;
  createdAtMs: number | null;
  /** An explicit last-update stamp the writer put on the card, when it did. */
  updatedAtMs: number | null;
  /** The card's open question for the human (unanswered, not dismissed). */
  openAsk?: WsTaskAsk;
  /** Position in the ledger file. */
  index: number;
}

/** Same djb2 → base36 as TasksKanban's stableId: a card without a usable id
 *  gets the SAME synthetic id on every poll and in every view. */
export function stableTaskId(seed: string): string {
  let h = 5381;
  for (let i = 0; i < seed.length; i++) h = (((h << 5) + h) ^ seed.charCodeAt(i)) | 0;
  return `t-${(h >>> 0).toString(36)}`;
}

/** Parse an ISO-ish timestamp (or epoch ms) to epoch ms; null when unusable. */
export function parseStamp(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null;
  if (typeof value !== 'string' || !value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** Fields a writer may use to say "this card last changed at". */
const UPDATE_FIELDS = [
  'updatedAt', 'updated_at', 'lastUpdate', 'lastUpdatedAt', 'last_updated', 'modifiedAt',
  'statusChangedAt', 'completedAt', 'doneAt', 'startedAt'
] as const;

/** The latest explicit update stamp on a raw card, or null. */
export function explicitUpdateStamp(raw: Record<string, unknown>): number | null {
  let best: number | null = null;
  for (const f of UPDATE_FIELDS) {
    const ms = parseStamp(raw[f]);
    if (ms !== null && (best === null || ms > best)) best = ms;
  }
  return best;
}

/** The latest time ANYTHING on a raw card is known to have happened: its
 *  update stamps, its creation, every ask and answer in its humanQA trail. */
export function evidenceStamp(raw: Record<string, unknown>): number | null {
  let best = explicitUpdateStamp(raw);
  const bump = (v: unknown): void => {
    const ms = parseStamp(v);
    if (ms !== null && (best === null || ms > best)) best = ms;
  };
  bump(raw.createdAt);
  if (Array.isArray(raw.humanQA)) {
    for (const e of raw.humanQA) {
      if (!e || typeof e !== 'object') continue;
      const qa = e as Record<string, unknown>;
      bump(qa.askedAt);
      bump(qa.answeredAt);
      bump(qa.dismissedAt);
    }
  }
  return best;
}

/** The ledger's card array, from whatever `hive:tasks` / the file returned. */
export function ledgerCards(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object' && Array.isArray((raw as { tasks?: unknown }).tasks)) {
    return (raw as { tasks: unknown[] }).tasks;
  }
  return [];
}

function openAskOf(raw: Record<string, unknown>): WsTaskAsk | undefined {
  if (!Array.isArray(raw.humanQA)) return undefined;
  for (let i = raw.humanQA.length - 1; i >= 0; i--) {
    const e = raw.humanQA[i] as Record<string, unknown> | null;
    if (!e || typeof e !== 'object' || typeof e.q !== 'string') continue;
    if (typeof e.a === 'string' && e.a) continue;
    if (typeof e.dismissedAt === 'string' && e.dismissedAt) continue;
    return { q: e.q, askedAt: typeof e.askedAt === 'string' ? e.askedAt : undefined };
  }
  return undefined;
}

/** The id a raw card is known by everywhere in the app. */
export function rawTaskId(raw: Record<string, unknown>, index: number): string {
  if (typeof raw.id === 'string' && raw.id) return raw.id;
  const title = typeof raw.title === 'string' ? raw.title : '';
  const created = typeof raw.createdAt === 'string' ? raw.createdAt : '';
  return stableTaskId(`${title}|${created}|${index}`);
}

/** Normalize the raw ledger into board cards. Never throws, never drops a
 *  well-formed object. Non-objects are skipped (they have nothing to show). */
export function normalizeLedger(raw: unknown): WsTask[] {
  const out: WsTask[] = [];
  const seen = new Map<string, number>();
  ledgerCards(raw).forEach((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return;
    const r = entry as Record<string, unknown>;
    const id = rawTaskId(r, index);
    const dup = seen.get(id) ?? 0;
    seen.set(id, dup + 1);
    const rawStatus = typeof r.status === 'string' ? r.status : '';
    const priority = typeof r.priority === 'number' && Number.isFinite(r.priority)
      ? Math.max(1, Math.min(5, Math.round(r.priority)))
      : 3;
    out.push({
      id,
      key: dup === 0 ? id : `${id}~${dup}`,
      title: typeof r.title === 'string' && r.title.trim() ? r.title : '(untitled)',
      description: typeof r.description === 'string' ? r.description : undefined,
      assignee: typeof r.assignee === 'string' && r.assignee ? r.assignee : undefined,
      column: columnForStatus(r.status),
      rawStatus,
      priority,
      createdAtMs: parseStamp(r.createdAt),
      updatedAtMs: explicitUpdateStamp(r),
      openAsk: openAskOf(r),
      index
    });
  });
  return out;
}

/** "Asks you": blocked with an open question — the same predicate the ASK ME
 *  board and the Inbox use (TasksKanban.waitsOnHuman), so the chip and the
 *  place it links to always agree. */
export function asksYou(task: WsTask): boolean {
  return task.column === 'blocked' && !!task.openAsk;
}

// ─── Activity (from the main-process tracker) ───────────────────────────────

/** When a card last changed and when it entered its current column, as
 *  observed by the main process (see tasksActivity.ts). Epoch ms. */
export interface CardActivity {
  changedAt: number;
  statusSince: number;
}

export type ActivityMap = Record<string, CardActivity>;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A Doing card with no change for this long says so. */
export const STALE_AFTER_MS = 4 * HOUR;
/** A Done card leaves the Board (not the List) this long after it got there. */
export const DONE_LEAVES_BOARD_AFTER_MS = DAY;

/** When the card last changed: the tracker's observation, else the card's own
 *  update stamp. Null when nothing is known — callers treat that as "not
 *  stale", never as "stale since 1970". */
export function lastChangeMs(task: WsTask, act: CardActivity | undefined): number | null {
  const candidates = [act?.changedAt, task.updatedAtMs].filter(
    (v): v is number => typeof v === 'number' && Number.isFinite(v)
  );
  return candidates.length ? Math.max(...candidates) : null;
}

/** The latest moment the card is known to have been touched (created or
 *  changed). Drives the date filters and the List's "updated" column. */
export function lastActivityMs(task: WsTask, act: CardActivity | undefined): number | null {
  const candidates = [act?.changedAt, task.updatedAtMs, task.createdAtMs].filter(
    (v): v is number => typeof v === 'number' && Number.isFinite(v)
  );
  return candidates.length ? Math.max(...candidates) : null;
}

/** How long a Doing card has gone without a change, when that is at least
 *  STALE_AFTER_MS; null otherwise (not Doing, fresh, or unknown). */
export function staleForMs(
  task: WsTask,
  act: CardActivity | undefined,
  now: number,
  threshold = STALE_AFTER_MS
): number | null {
  if (task.column !== 'doing') return null;
  const last = lastChangeMs(task, act);
  if (last === null) return null;
  const age = now - last;
  return age >= threshold ? age : null;
}

/** True when a Done card has been done long enough to leave the Board. A done
 *  card whose done-time is unknown stays — hiding needs evidence. */
export function leftTheBoard(
  task: WsTask,
  act: CardActivity | undefined,
  now: number,
  after = DONE_LEAVES_BOARD_AFTER_MS
): boolean {
  if (task.column !== 'done') return false;
  const since = act?.statusSince ?? task.updatedAtMs;
  if (typeof since !== 'number' || !Number.isFinite(since)) return false;
  return now - since >= after;
}

/** A compact age: minutes under an hour, hours under two days, then days. */
export function ageParts(ms: number): { n: number; unit: 'm' | 'h' | 'd' } {
  const safe = Math.max(0, ms);
  if (safe < HOUR) return { n: Math.max(1, Math.floor(safe / MINUTE)), unit: 'm' };
  if (safe < 2 * DAY) return { n: Math.floor(safe / HOUR), unit: 'h' };
  return { n: Math.floor(safe / DAY), unit: 'd' };
}

// ─── Filters ────────────────────────────────────────────────────────────────

export type TaskRange = 'today' | 'week' | 'month' | 'all';

export const TASK_RANGES: readonly TaskRange[] = ['today', 'week', 'month', 'all'];

export function isTaskRange(value: unknown): value is TaskRange {
  return typeof value === 'string' && (TASK_RANGES as readonly string[]).includes(value);
}

/**
 * Start of the range in LOCAL time, as epoch ms; null for All time.
 *
 * Built from calendar fields (`new Date(y, m, d)`) rather than by subtracting
 * 24h multiples, so a day that is 23 or 25 hours long (a DST switch) still
 * starts at local midnight. `weekStartsOn` is 0 = Sunday … 6 = Saturday.
 */
export function rangeStartMs(range: TaskRange, now: number, weekStartsOn = 1): number | null {
  if (range === 'all') return null;
  const d = new Date(now);
  if (range === 'today') return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  if (range === 'month') return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  const start = ((Math.trunc(weekStartsOn) % 7) + 7) % 7;
  const back = (d.getDay() - start + 7) % 7;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - back).getTime();
}

/** `'all'`, `'unassigned'`, or one agent id. */
export type AssigneeFilter = string;
export const ASSIGNEE_ALL = 'all';
export const ASSIGNEE_NONE = 'unassigned';

export interface TaskFilter {
  range: TaskRange;
  assignee: AssigneeFilter;
  query: string;
}

export interface FilterContext {
  now: number;
  weekStartsOn?: number;
  activity?: ActivityMap;
  /** Display name for an agent id (search matches names, not just ids). */
  nameOf?: (agentId: string) => string | undefined;
}

/** Does the card match the search text? Case-insensitive; every word must
 *  appear somewhere in the id, title, description, status or owner name. */
export function matchesQuery(task: WsTask, query: string, nameOf?: (id: string) => string | undefined): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const owner = task.assignee ? `${task.assignee} ${nameOf?.(task.assignee) ?? ''}` : '';
  const hay = `${task.id}\n${task.title}\n${task.description ?? ''}\n${task.rawStatus}\n${owner}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}

/**
 * Apply the header's filters.
 *
 * The date range keeps cards TOUCHED in the period (created or changed), which
 * is what "what happened this week" means. One exception: a card that needs
 * you — it asks you something, or it has gone stale in Doing — is shown in
 * every range, because a filter must never be the reason you miss it.
 */
export function filterTasks(tasks: readonly WsTask[], filter: TaskFilter, ctx: FilterContext): WsTask[] {
  const start = rangeStartMs(filter.range, ctx.now, ctx.weekStartsOn ?? 1);
  return tasks.filter((task) => {
    if (filter.assignee === ASSIGNEE_NONE ? !!task.assignee : filter.assignee !== ASSIGNEE_ALL && task.assignee !== filter.assignee) {
      return false;
    }
    if (!matchesQuery(task, filter.query, ctx.nameOf)) return false;
    if (start === null) return true;
    const act = ctx.activity?.[task.id];
    if (asksYou(task) || staleForMs(task, act, ctx.now) !== null) return true;
    const last = lastActivityMs(task, act);
    return last !== null && last >= start;
  });
}

/** The header line: "3 in progress, 1 asks you". Counted over the whole
 *  ledger, not the filtered view — it describes the floor. */
export function summarizeTasks(tasks: readonly WsTask[]): { doing: number; asksYou: number; total: number } {
  let doing = 0;
  let asks = 0;
  for (const t of tasks) {
    if (t.column === 'doing') doing++;
    if (asksYou(t)) asks++;
  }
  return { doing, asksYou: asks, total: tasks.length };
}

/**
 * Order within a column. The ledger has no in-column order, so this is visual
 * only: cards that need you first, then higher priority, then the most
 * recently touched — except Done, which is purely most recently finished.
 */
export function compareInColumn(
  a: WsTask,
  b: WsTask,
  activity: ActivityMap | undefined,
  now: number
): number {
  const actA = activity?.[a.id];
  const actB = activity?.[b.id];
  if (a.column !== 'done' || b.column !== 'done') {
    const needA = asksYou(a) ? 2 : staleForMs(a, actA, now) !== null ? 1 : 0;
    const needB = asksYou(b) ? 2 : staleForMs(b, actB, now) !== null ? 1 : 0;
    if (needA !== needB) return needB - needA;
    if (a.priority !== b.priority) return b.priority - a.priority;
  }
  const la = lastActivityMs(a, actA) ?? 0;
  const lb = lastActivityMs(b, actB) ?? 0;
  if (la !== lb) return lb - la;
  return a.index - b.index;
}

// ─── New task ids ───────────────────────────────────────────────────────────

const KEYED_ID = /^([A-Za-z][A-Za-z0-9]{0,9})-(\d{1,9})$/;

/**
 * A short ticket key from a folder name: its first three ASCII letters or
 * digits, upper-cased, starting at the first letter (`munder-difflin` → `MUN`,
 * `v53 site` → `V53`, `2026-site` → `SIT`). A name that yields fewer than two
 * characters — `x`, or a folder named in Chinese — gets `TSK`.
 */
export function deriveTaskKey(folderName: string): string {
  const alnum = (folderName || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase().replace(/^[0-9]+/, '');
  const base = alnum.slice(0, 3);
  return base.length >= 2 ? base : 'TSK';
}

/**
 * The next id for a card added from the Tasks screen.
 *
 * Follows the ledger's own convention first: the prefix most of its `key-N`
 * ids use (`bmt` on a `bmt-12` floor), at one past that prefix's highest
 * number, in the case it is written in. A ledger with no keyed ids yet starts
 * `fallbackKey-1`. The result is never an id already in the ledger.
 */
export function nextTaskId(existingIds: readonly string[], fallbackKey: string): string {
  const groups = new Map<string, { spelling: Map<string, number>; count: number; max: number }>();
  for (const id of existingIds) {
    const m = typeof id === 'string' ? KEYED_ID.exec(id) : null;
    if (!m) continue;
    const lower = m[1].toLowerCase();
    const n = Number(m[2]);
    const g = groups.get(lower) ?? { spelling: new Map<string, number>(), count: 0, max: 0 };
    g.count++;
    g.max = Math.max(g.max, n);
    g.spelling.set(m[1], (g.spelling.get(m[1]) ?? 0) + 1);
    groups.set(lower, g);
  }
  let prefix = (fallbackKey || 'TSK').replace(/[^A-Za-z0-9]/g, '').slice(0, 10) || 'TSK';
  if (!/^[A-Za-z]/.test(prefix)) prefix = `T${prefix}`.slice(0, 10);
  let next = (groups.get(prefix.toLowerCase())?.max ?? 0) + 1;
  let best: { count: number; max: number } | null = null;
  for (const g of groups.values()) {
    if (!best || g.count > best.count || (g.count === best.count && g.max > best.max)) {
      best = g;
      prefix = [...g.spelling.entries()].sort((a, b) => b[1] - a[1])[0][0];
      next = g.max + 1;
    }
  }
  const taken = new Set(existingIds);
  while (taken.has(`${prefix}-${next}`)) next++;
  return `${prefix}-${next}`;
}

/** Hard caps on what the New task form writes into the ledger. */
export const MAX_TASK_TITLE = 200;
export const MAX_TASK_DESCRIPTION = 8000;
