/**
 * What the Tasks screen draws: each ledger card combined with the human's
 * staged change (shown where it WILL be, marked pending), any sent change the
 * orchestrator has not applied yet, and main's activity record (stale age).
 * Then the Board's grouping into columns, with done cards that have been done
 * a while taken off the Board (they stay in the List).
 *
 * Pure, so the grouping rules are tested rather than eyeballed.
 */
import {
  TASK_COLUMNS,
  asksYou,
  compareInColumn,
  lastActivityMs,
  leftTheBoard,
  staleForMs,
  type ActivityMap,
  type CardActivity,
  type TaskColumn,
  type WsTask
} from './tasks';
import type { SentMove, StagedMove } from './tasksMoves';

export interface TaskView {
  task: WsTask;
  act?: CardActivity;
  /** Where the card is drawn: the staged target if there is one, else the ledger's column. */
  column: TaskColumn;
  /** Who it is drawn as belonging to (agent id or null), staged owner included. */
  owner: string | null;
  staged?: StagedMove;
  sent?: SentMove;
  staleMs: number | null;
  asks: boolean;
  lastActivity: number | null;
}

export interface ViewContext {
  activity: ActivityMap;
  staged: readonly StagedMove[];
  sent: readonly SentMove[];
  now: number;
}

export function buildTaskViews(tasks: readonly WsTask[], ctx: ViewContext): TaskView[] {
  const staged = new Map(ctx.staged.map((m) => [m.taskId, m]));
  const sent = new Map(ctx.sent.map((m) => [m.taskId, m]));
  const seen = new Set<string>();
  return tasks.map((task) => {
    // A repeated id (hand-written ledger) only carries the move on its first card.
    const first = !seen.has(task.id);
    seen.add(task.id);
    const move = first ? staged.get(task.id) : undefined;
    const act = ctx.activity[task.id];
    return {
      task,
      act,
      column: move?.toColumn ?? task.column,
      owner: move ? move.toOwner : (task.assignee ?? null),
      staged: move,
      sent: first && !move ? sent.get(task.id) : undefined,
      staleMs: staleForMs(task, act, ctx.now),
      asks: asksYou(task),
      lastActivity: lastActivityMs(task, act)
    };
  });
}

export interface BoardColumn {
  column: TaskColumn;
  cards: TaskView[];
  /** Done cards taken off the Board because they have been done a while. */
  hiddenDone: number;
}

/**
 * Group views into the four Board columns.
 *
 * @param lifted a card the keyboard is carrying: drawn in the column it is
 *               over, so the person sees where it would land.
 */
export function boardColumns(
  views: readonly TaskView[],
  now: number,
  lifted?: { id: string; column: TaskColumn } | null
): BoardColumn[] {
  const cols: BoardColumn[] = TASK_COLUMNS.map((column) => ({ column, cards: [], hiddenDone: 0 }));
  const byColumn = new Map(cols.map((c) => [c.column, c]));
  const activity: ActivityMap = {};
  for (const v of views) {
    if (v.act) activity[v.task.id] = v.act;
  }
  for (const v of views) {
    const column = lifted && lifted.id === v.task.id ? lifted.column : v.column;
    // Only a card that is really done, and that nobody is moving, leaves.
    if (column === 'done' && !v.staged && !(lifted && lifted.id === v.task.id) && leftTheBoard(v.task, v.act, now)) {
      byColumn.get('done')!.hiddenDone++;
      continue;
    }
    byColumn.get(column)!.cards.push(column === v.column ? v : { ...v, column });
  }
  for (const c of cols) {
    c.cards.sort((a, b) => compareInColumn(
      a.task.column === c.column ? a.task : { ...a.task, column: c.column },
      b.task.column === c.column ? b.task : { ...b.task, column: c.column },
      activity,
      now
    ));
  }
  return cols;
}

/** The List's order: by column (To do → Done), then the in-column order. */
export function listOrder(views: readonly TaskView[], now: number): TaskView[] {
  const activity: ActivityMap = {};
  for (const v of views) if (v.act) activity[v.task.id] = v.act;
  const rank = (c: TaskColumn): number => TASK_COLUMNS.indexOf(c);
  return [...views].sort((a, b) => {
    const d = rank(a.column) - rank(b.column);
    if (d !== 0) return d;
    return compareInColumn({ ...a.task, column: a.column }, { ...b.task, column: b.column }, activity, now);
  });
}
