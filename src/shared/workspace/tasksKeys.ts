/**
 * Moving cards with the keyboard — the Board's key handling as a pure reducer.
 *
 * Two ways to move, both ending in a STAGED move (never a ledger write):
 *
 *   - Shift+Left / Shift+Right moves the focused card one column at once.
 *   - Space picks the card up; Left / Right carry it across columns (the Board
 *     previews where it would land); Space or Enter puts it down; Escape puts
 *     it back. This is the WAI-ARIA drag-and-drop pattern, for people who want
 *     to see the destination before committing.
 *
 * Without a card lifted, the arrows move FOCUS: Up/Down within a column,
 * Left/Right to the nearest card in the next non-empty column, Home/End to the
 * ends of a column. Enter opens the card.
 *
 * Left and Right are VISUAL: in a right-to-left layout the columns run from
 * the right, so ArrowLeft goes to the NEXT column there.
 */
import { TASK_COLUMNS, type TaskColumn } from './tasks';

/** The Board as rendered: every column, in order, with its visible card ids. */
export interface BoardLayout {
  columns: { column: TaskColumn; ids: string[] }[];
}

export interface BoardKeyState {
  focusId: string | null;
  lifted: { id: string; origin: TaskColumn; column: TaskColumn } | null;
}

export interface BoardKeyInput {
  key: string;
  shiftKey?: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
}

export type BoardKeyEffect =
  | { kind: 'focus'; id: string }
  | { kind: 'open'; id: string }
  | { kind: 'stage'; id: string; to: TaskColumn }
  | { kind: 'announce-lift'; id: string; column: TaskColumn }
  | { kind: 'announce-cancel'; id: string };

export interface BoardKeyResult {
  state: BoardKeyState;
  effect: BoardKeyEffect | null;
  /** True when the key was ours — the caller should preventDefault. */
  handled: boolean;
}

export const INITIAL_BOARD_KEYS: BoardKeyState = { focusId: null, lifted: null };

function locate(layout: BoardLayout, id: string): { col: number; row: number } | null {
  for (let c = 0; c < layout.columns.length; c++) {
    const row = layout.columns[c].ids.indexOf(id);
    if (row >= 0) return { col: c, row };
  }
  return null;
}

function columnIndex(column: TaskColumn): number {
  return TASK_COLUMNS.indexOf(column);
}

/** +1 for "toward the next column" in reading order, -1 for back. */
function horizontalStep(key: string, rtl: boolean): number {
  if (key === 'ArrowRight') return rtl ? -1 : 1;
  if (key === 'ArrowLeft') return rtl ? 1 : -1;
  return 0;
}

const unchanged = (state: BoardKeyState): BoardKeyResult => ({ state, effect: null, handled: false });

export function boardKeyReducer(
  state: BoardKeyState,
  input: BoardKeyInput,
  layout: BoardLayout,
  rtl = false
): BoardKeyResult {
  // Leave every chord with Ctrl/Cmd/Alt to the app (sidebar toggles, IDE…).
  if (input.ctrlKey || input.metaKey || input.altKey) return unchanged(state);
  const step = horizontalStep(input.key, rtl);

  // ── A card is lifted: arrows carry it, Space/Enter drops, Escape cancels.
  if (state.lifted) {
    const lifted = state.lifted;
    if (step !== 0) {
      const i = Math.max(0, Math.min(TASK_COLUMNS.length - 1, columnIndex(lifted.column) + step));
      const column = TASK_COLUMNS[i];
      return {
        state: { ...state, lifted: { ...lifted, column } },
        effect: column === lifted.column ? null : { kind: 'announce-lift', id: lifted.id, column },
        handled: true
      };
    }
    if (input.key === ' ' || input.key === 'Spacebar' || input.key === 'Enter') {
      const effect: BoardKeyEffect | null = lifted.column !== lifted.origin
        ? { kind: 'stage', id: lifted.id, to: lifted.column }
        : null;
      return { state: { focusId: lifted.id, lifted: null }, effect, handled: true };
    }
    if (input.key === 'Escape') {
      return { state: { focusId: lifted.id, lifted: null }, effect: { kind: 'announce-cancel', id: lifted.id }, handled: true };
    }
    if (input.key === 'ArrowUp' || input.key === 'ArrowDown') {
      // Order within a column is visual only; swallow so the page does not scroll.
      return { state, effect: null, handled: true };
    }
    if (input.key === 'Tab') {
      // Leaving the board puts the card back where it was.
      return { state: { focusId: lifted.id, lifted: null }, effect: { kind: 'announce-cancel', id: lifted.id }, handled: false };
    }
    return unchanged(state);
  }

  const focusId = state.focusId;
  const at = focusId ? locate(layout, focusId) : null;

  // Nothing focused yet (or the focused card left the view): any navigation
  // key lands on the first card on the board.
  if (!at || !focusId) {
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(input.key)) {
      const first = layout.columns.find((c) => c.ids.length > 0)?.ids[0];
      if (!first) return unchanged(state);
      return { state: { focusId: first, lifted: null }, effect: { kind: 'focus', id: first }, handled: true };
    }
    return unchanged(state);
  }

  const ids = layout.columns[at.col].ids;
  const focus = (id: string): BoardKeyResult =>
    ({ state: { focusId: id, lifted: null }, effect: { kind: 'focus', id }, handled: true });

  if (step !== 0 && input.shiftKey) {
    const fromColumn = layout.columns[at.col].column;
    const i = columnIndex(fromColumn) + step;
    if (i < 0 || i >= TASK_COLUMNS.length) return { state, effect: null, handled: true };
    return { state, effect: { kind: 'stage', id: focusId, to: TASK_COLUMNS[i] }, handled: true };
  }
  if (step !== 0) {
    for (let c = at.col + step; c >= 0 && c < layout.columns.length; c += step) {
      const target = layout.columns[c].ids;
      if (target.length) return focus(target[Math.min(at.row, target.length - 1)]);
    }
    return { state, effect: null, handled: true };
  }
  switch (input.key) {
    case 'ArrowUp':
      return at.row > 0 ? focus(ids[at.row - 1]) : { state, effect: null, handled: true };
    case 'ArrowDown':
      return at.row < ids.length - 1 ? focus(ids[at.row + 1]) : { state, effect: null, handled: true };
    case 'Home':
      return focus(ids[0]);
    case 'End':
      return focus(ids[ids.length - 1]);
    case 'Enter':
      return { state, effect: { kind: 'open', id: focusId }, handled: true };
    case ' ':
    case 'Spacebar': {
      const column = layout.columns[at.col].column;
      return {
        state: { focusId, lifted: { id: focusId, origin: column, column } },
        effect: { kind: 'announce-lift', id: focusId, column },
        handled: true
      };
    }
    default:
      return unchanged(state);
  }
}
