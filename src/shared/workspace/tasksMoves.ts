/**
 * Staged board moves — the product rule that the human never writes a card's
 * status or owner directly.
 *
 * Dragging a card (or moving it with the keyboard, or picking a new owner)
 * STAGES the change here. Nothing touches the ledger. One Send then hands every
 * staged change to the orchestrator as a single message (`buildMoveMessage`),
 * and he applies them — he is the ledger's writer, and a move he has not heard
 * about is work he does not know is happening. After Send the changes are kept
 * as SENT until the ledger shows them (or a while passes), so a card does not
 * appear to jump back to where it was while he gets to it.
 *
 * Pure: the zustand store (workspace/tasks/movesStore.ts) persists what this
 * returns; the tests drive it directly.
 */
import type { TaskColumn } from './tasks';

/** One staged change to one card. `from*` is the ledger's value — refreshed
 *  from the live ledger by `reconcileMoves`, so it is never a stale guess. */
export interface StagedMove {
  taskId: string;
  /** Title at staging time — kept so the message still names a card the
   *  ledger renamed or dropped meanwhile. */
  title: string;
  fromColumn: TaskColumn;
  toColumn: TaskColumn;
  /** Agent ids; null is unassigned. */
  fromOwner: string | null;
  toOwner: string | null;
  stagedAt: number;
}

export interface SentMove extends StagedMove {
  sentAt: number;
}

/** What the ledger says about one card right now. */
export interface LedgerCardState {
  id: string;
  title: string;
  column: TaskColumn;
  assignee?: string;
}

export type MoveAction =
  | {
    type: 'stage';
    taskId: string;
    title: string;
    /** The card's ledger values (where it really is). */
    fromColumn: TaskColumn;
    fromOwner: string | null;
    /** What the human wants. Omitted → keep what is already staged. */
    toColumn?: TaskColumn;
    toOwner?: string | null;
    now: number;
  }
  | { type: 'undo'; taskId: string }
  | { type: 'clear' };

/** True when a move changes nothing. */
export function isNoopMove(m: Pick<StagedMove, 'fromColumn' | 'toColumn' | 'fromOwner' | 'toOwner'>): boolean {
  return m.fromColumn === m.toColumn && (m.fromOwner ?? null) === (m.toOwner ?? null);
}

/**
 * The staged-move reducer.
 *
 *   stage — at most ONE entry per card: a second move of the same card folds
 *           into the first (it keeps the ledger origin and takes the new
 *           target), so "Doing → Blocked → Done" is staged as "Doing → Done".
 *           A move back to where the card really is removes the entry.
 *   undo  — drop one card's entry.
 *   clear — drop all (after Send).
 */
export function movesReducer(state: readonly StagedMove[], action: MoveAction): StagedMove[] {
  switch (action.type) {
    case 'clear':
      return [];
    case 'undo':
      return state.filter((m) => m.taskId !== action.taskId);
    case 'stage': {
      const existing = state.find((m) => m.taskId === action.taskId);
      const next: StagedMove = {
        taskId: action.taskId,
        title: action.title,
        fromColumn: action.fromColumn,
        fromOwner: action.fromOwner ?? null,
        toColumn: action.toColumn ?? existing?.toColumn ?? action.fromColumn,
        toOwner: action.toOwner !== undefined
          ? (action.toOwner ?? null)
          : existing ? existing.toOwner : (action.fromOwner ?? null),
        stagedAt: existing?.stagedAt ?? action.now
      };
      if (isNoopMove(next)) return state.filter((m) => m.taskId !== action.taskId);
      if (existing) return state.map((m) => (m.taskId === action.taskId ? next : m));
      return [...state, next];
    }
    default:
      return [...state];
  }
}

/**
 * Re-align staged moves with the live ledger (every poll):
 *   - a card no longer in the ledger loses its move (there is nothing to move);
 *   - `from*` is refreshed to where the card is NOW — an agent may have moved
 *     it since — so the message always describes a real transition;
 *   - a move that has become a no-op (an agent already put the card there) is
 *     dropped.
 * Returns the same array instance when nothing changed, so a store can skip
 * a write.
 */
export function reconcileMoves(state: readonly StagedMove[], ledger: readonly LedgerCardState[]): readonly StagedMove[] {
  if (!state.length) return state;
  const byId = new Map(ledger.map((c) => [c.id, c]));
  let dirty = false;
  const out: StagedMove[] = [];
  for (const m of state) {
    const card = byId.get(m.taskId);
    if (!card) { dirty = true; continue; }
    const fromOwner = card.assignee ?? null;
    const next = (m.fromColumn === card.column && m.fromOwner === fromOwner && m.title === card.title)
      ? m
      : { ...m, fromColumn: card.column, fromOwner, title: card.title };
    if (isNoopMove(next)) { dirty = true; continue; }
    if (next !== m) dirty = true;
    out.push(next);
  }
  return dirty ? out : state;
}

/** How long a sent move is shown as "sent" before we stop waiting for it. */
export const SENT_MOVE_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Keep a sent move only while it is still news: the card exists, the ledger
 * still shows it where it was when we sent (the orchestrator has not acted on
 * it — once he applies it, or does something else with the card, the ledger
 * speaks for itself), and it is younger than SENT_MOVE_TTL_MS.
 */
export function reconcileSent(sent: readonly SentMove[], ledger: readonly LedgerCardState[], now: number): readonly SentMove[] {
  if (!sent.length) return sent;
  const byId = new Map(ledger.map((c) => [c.id, c]));
  const out = sent.filter((m) => {
    const card = byId.get(m.taskId);
    if (!card) return false;
    if (now - m.sentAt >= SENT_MOVE_TTL_MS) return false;
    return card.column === m.fromColumn && (card.assignee ?? null) === m.fromOwner;
  });
  return out.length === sent.length ? sent : out;
}

/** Mark staged moves as sent; a newer send of the same card replaces the older one. */
export function markSent(sent: readonly SentMove[], moves: readonly StagedMove[], now: number): SentMove[] {
  const ids = new Set(moves.map((m) => m.taskId));
  return [...sent.filter((m) => !ids.has(m.taskId)), ...moves.map((m) => ({ ...m, sentAt: now }))];
}

// ─── The message ────────────────────────────────────────────────────────────

/** English column names for the message. The message is for an agent, so it
 *  is written in the language every agent prompt in this app is written in,
 *  whatever the UI language — and it names the exact ledger value as well. */
const COLUMN_NAME: Record<TaskColumn, string> = {
  todo: 'To do',
  doing: 'Doing',
  blocked: 'Blocked',
  done: 'Done'
};

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * The single message Send hands to the orchestrator. One numbered line per
 * card: its id and title, the column change with the ledger `status` values
 * to write, and the owner change with the `assignee` ids to write.
 *
 * @param ownerName display name for an agent id (falls back to the id).
 */
export function buildMoveMessage(
  moves: readonly StagedMove[],
  ownerName: (agentId: string) => string | undefined = () => undefined
): string {
  const who = (id: string | null): string => {
    if (!id) return 'unassigned';
    const name = ownerName(id);
    return name && name !== id ? `${name} (assignee "${id}")` : `assignee "${id}"`;
  };
  const lines = moves.map((m, i) => {
    const parts: string[] = [];
    if (m.fromColumn !== m.toColumn) {
      parts.push(`${COLUMN_NAME[m.fromColumn]} → ${COLUMN_NAME[m.toColumn]} (status "${m.fromColumn}" → "${m.toColumn}")`);
    }
    if ((m.fromOwner ?? null) !== (m.toOwner ?? null)) {
      parts.push(`owner ${who(m.fromOwner)} → ${who(m.toOwner)}`);
    }
    if (m.fromColumn === m.toColumn) parts.push(`stays in ${COLUMN_NAME[m.toColumn]}`);
    return `${i + 1}. ${m.taskId} "${oneLine(m.title, 120)}": ${parts.join('; ')}`;
  });
  const count = moves.length === 1 ? 'one change' : `${moves.length} changes`;
  return [
    `Board changes from the human, made on the Tasks screen (${count}). I have not edited tasks.json — please apply each one to the ledger yourself, setting "status" and "assignee" exactly as listed, and tell any new owner about the card.`,
    '',
    ...lines,
    '',
    'If a change does not fit what you know (the work is not actually finished, say, or the new owner is busy), leave that card as it is and tell me why.'
  ].join('\n');
}
