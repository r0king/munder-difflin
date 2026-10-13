/**
 * The Tasks screen's staged and sent moves, kept per ledger.
 *
 * A zustand store so they survive the screen unmounting (switching to Inbox and
 * back), persisted to localStorage so they survive a reload — a half-planned
 * reshuffle of the board must not vanish because the window refreshed. The
 * rules (folding, reconciling with the ledger) are the pure reducer in
 * @shared/workspace/tasksMoves; this file is only state and storage.
 *
 * Keyed by ledgerId (a hash of the hive's path, from main): moves staged on
 * one hive are never shown, or sent, on another.
 */
import { create } from 'zustand';
import { isTaskColumn } from '@shared/workspace/tasks';
import {
  markSent,
  movesReducer,
  reconcileMoves,
  reconcileSent,
  type LedgerCardState,
  type MoveAction,
  type SentMove,
  type StagedMove
} from '@shared/workspace/tasksMoves';

const LS_KEY = 'cth.ws.tasks.moves';
/** Ledger buckets kept in storage; the oldest beyond this are dropped. */
const MAX_LEDGERS = 8;
/** Moves per ledger — a guard against a corrupted store, not a UX limit. */
const MAX_MOVES = 500;
/** The bucket used before main has told us which ledger is open. */
const UNBOUND = '_';

interface Bucket {
  staged: StagedMove[];
  sent: SentMove[];
  /** Last touched, for evicting old ledgers. */
  at: number;
}

type Buckets = Record<string, Bucket>;

const EMPTY: Bucket = { staged: [], sent: [], at: 0 };

function isMove(v: unknown): v is StagedMove {
  if (!v || typeof v !== 'object') return false;
  const m = v as Record<string, unknown>;
  const owner = (o: unknown): boolean => o === null || (typeof o === 'string' && o.length > 0 && o.length <= 200);
  return typeof m.taskId === 'string' && m.taskId.length > 0 && m.taskId.length <= 200
    && typeof m.title === 'string'
    && isTaskColumn(m.fromColumn) && isTaskColumn(m.toColumn)
    && owner(m.fromOwner) && owner(m.toOwner)
    && typeof m.stagedAt === 'number';
}

function isSent(v: unknown): v is SentMove {
  return isMove(v) && typeof (v as unknown as Record<string, unknown>).sentAt === 'number';
}

function load(): Buckets {
  try {
    const raw: unknown = JSON.parse(window.localStorage.getItem(LS_KEY) ?? 'null');
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out: Buckets = {};
    for (const [id, b] of Object.entries(raw as Record<string, unknown>)) {
      if (!b || typeof b !== 'object') continue;
      const bucket = b as Record<string, unknown>;
      out[id] = {
        staged: Array.isArray(bucket.staged) ? bucket.staged.filter(isMove).slice(0, MAX_MOVES) : [],
        sent: Array.isArray(bucket.sent) ? bucket.sent.filter(isSent).slice(0, MAX_MOVES) : [],
        at: typeof bucket.at === 'number' ? bucket.at : 0
      };
    }
    return out;
  } catch {
    return {}; // unavailable or corrupt
  }
}

function save(buckets: Buckets): void {
  // Drop empty buckets and the oldest beyond MAX_LEDGERS.
  const kept = Object.entries(buckets)
    .filter(([, b]) => b.staged.length > 0 || b.sent.length > 0)
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, MAX_LEDGERS);
  try { window.localStorage.setItem(LS_KEY, JSON.stringify(Object.fromEntries(kept))); } catch { /* best-effort */ }
}

export interface TaskMovesState {
  ledgerId: string;
  buckets: Buckets;
  /** Point the store at the open ledger. Moves staged before main answered
   *  (the unbound bucket) are carried over. */
  bindLedger: (ledgerId: string) => void;
  dispatch: (action: MoveAction) => void;
  /** Align with the live ledger (each poll). Writes only when something changed. */
  reconcile: (ledger: readonly LedgerCardState[], now: number) => void;
  /** After a successful Send: the staged moves become sent, staging empties. */
  commitSent: (moves: readonly StagedMove[], now: number) => void;
}

function withBucket(state: TaskMovesState, next: Bucket): Buckets {
  const buckets = { ...state.buckets, [state.ledgerId]: next };
  save(buckets);
  return buckets;
}

export const useTaskMoves = create<TaskMovesState>((set, get) => ({
  ledgerId: UNBOUND,
  buckets: load(),
  bindLedger: (ledgerId) => {
    const s = get();
    if (!ledgerId || s.ledgerId === ledgerId) return;
    const buckets = { ...s.buckets };
    const early = buckets[UNBOUND];
    if (early && (early.staged.length || early.sent.length)) {
      const into = buckets[ledgerId] ?? EMPTY;
      let staged = into.staged;
      for (const m of early.staged) {
        staged = movesReducer(staged, {
          type: 'stage', taskId: m.taskId, title: m.title, fromColumn: m.fromColumn, fromOwner: m.fromOwner,
          toColumn: m.toColumn, toOwner: m.toOwner, now: m.stagedAt
        });
      }
      buckets[ledgerId] = { staged, sent: [...into.sent, ...early.sent], at: Date.now() };
      delete buckets[UNBOUND];
      save(buckets);
    }
    set({ ledgerId, buckets });
  },
  dispatch: (action) => {
    const s = get();
    const cur = s.buckets[s.ledgerId] ?? EMPTY;
    const staged = movesReducer(cur.staged, action).slice(0, MAX_MOVES);
    set({ buckets: withBucket(s, { ...cur, staged, at: Date.now() }) });
  },
  reconcile: (ledger, now) => {
    const s = get();
    const cur = s.buckets[s.ledgerId];
    if (!cur) return;
    const staged = reconcileMoves(cur.staged, ledger);
    const sent = reconcileSent(cur.sent, ledger, now);
    if (staged === cur.staged && sent === cur.sent) return;
    set({ buckets: withBucket(s, { ...cur, staged: [...staged], sent: [...sent] }) });
  },
  commitSent: (moves, now) => {
    const s = get();
    const cur = s.buckets[s.ledgerId] ?? EMPTY;
    const ids = new Set(moves.map((m) => m.taskId));
    set({
      buckets: withBucket(s, {
        staged: cur.staged.filter((m) => !ids.has(m.taskId)),
        sent: markSent(cur.sent, moves, now),
        at: now
      })
    });
  }
}));

const NO_STAGED: StagedMove[] = [];
const NO_SENT: SentMove[] = [];

/** The open ledger's staged moves (stable identity while unchanged). */
export function useStagedMoves(): StagedMove[] {
  return useTaskMoves((s) => s.buckets[s.ledgerId]?.staged ?? NO_STAGED);
}

/** The open ledger's sent-but-not-yet-applied moves. */
export function useSentMoves(): SentMove[] {
  return useTaskMoves((s) => s.buckets[s.ledgerId]?.sent ?? NO_SENT);
}
