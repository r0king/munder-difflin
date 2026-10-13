/**
 * The Board: four columns, cards drawn where they are (or where you have
 * staged them to go), dragged between columns or moved with the keyboard.
 *
 * Dropping a card, or pressing Shift+arrow, or picking a column from its menu,
 * STAGES a move (onStage) — the Send bar then hands every staged move to the
 * orchestrator in one message. A card drops anywhere in a column: the ledger
 * has no order within a column, so position there is the Board's own sort.
 *
 * Keyboard handling is the pure reducer in @shared/workspace/tasksKeys; this
 * component only renders its state, moves DOM focus to follow it, and reads
 * its announcements out through a polite live region.
 */
import { useCallback, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useRtl } from '@/i18n/useDirection';
import type { TaskColumn } from '@shared/workspace/tasks';
import { boardColumns, type TaskView } from '@shared/workspace/tasksView';
import { boardKeyReducer, INITIAL_BOARD_KEYS, type BoardKeyEffect, type BoardKeyState, type BoardLayout } from '@shared/workspace/tasksKeys';
import { COLUMN_META, DRAG_MIME } from './meta';
import { TaskCard } from './TaskCard';
import type { AgentOption } from './useTaskBoard';

export interface BoardViewProps {
  views: TaskView[];
  now: number;
  nameOf: (agentId: string) => string | undefined;
  owners: readonly AgentOption[];
  onOpen: (taskId: string) => void;
  onStage: (view: TaskView, change: { toColumn?: TaskColumn; toOwner?: string | null }) => void;
  onUndo: (taskId: string) => void;
  onAsks: () => void;
  onShowList: () => void;
}

function cssEscape(id: string): string {
  return typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(id) : id.replace(/["\\]/g, '\\$&');
}

export function BoardView({ views, now, nameOf, owners, onOpen, onStage, onUndo, onAsks, onShowList }: BoardViewProps) {
  const { t } = useTranslation();
  const rtl = useRtl();
  const board = useRef<HTMLDivElement>(null);
  const [keys, setKeys] = useState<BoardKeyState>(INITIAL_BOARD_KEYS);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropColumn, setDropColumn] = useState<TaskColumn | null>(null);
  const [announcement, setAnnouncement] = useState('');
  // Set when DOM focus should follow keys.focusId after the next render (the
  // card may have changed column, i.e. remounted).
  const focusPending = useRef(false);

  const columns = useMemo(() => boardColumns(views, now, keys.lifted), [views, now, keys.lifted]);
  const layout = useMemo<BoardLayout>(
    () => ({ columns: columns.map((c) => ({ column: c.column, ids: c.cards.map((v) => v.task.id) })) }),
    [columns]
  );
  const byId = useMemo(() => new Map(views.map((v) => [v.task.id, v])), [views]);
  const colName = useCallback((c: TaskColumn) => t(COLUMN_META[c].labelKey), [t]);

  // The single tab stop: the focused card while it is on the board, else the first card.
  const allIds = layout.columns.flatMap((c) => c.ids);
  const tabStop = keys.focusId && allIds.includes(keys.focusId) ? keys.focusId : allIds[0] ?? null;

  useLayoutEffect(() => {
    if (!focusPending.current || !keys.focusId) return;
    focusPending.current = false;
    board.current?.querySelector<HTMLElement>(`[data-task-id="${cssEscape(keys.focusId)}"]`)?.focus();
  });

  const runEffect = useCallback((effect: BoardKeyEffect | null) => {
    if (!effect) return;
    switch (effect.kind) {
      case 'focus':
        focusPending.current = true;
        break;
      case 'open':
        onOpen(effect.id);
        break;
      case 'stage': {
        const v = byId.get(effect.id);
        if (!v) break;
        onStage(v, { toColumn: effect.to });
        focusPending.current = true;
        setAnnouncement(t('wsTasks.kbd.moved', { id: effect.id, column: colName(effect.to) }));
        break;
      }
      case 'announce-lift':
        focusPending.current = true;
        setAnnouncement(t('wsTasks.kbd.lifted', { id: effect.id, column: colName(effect.column) }));
        break;
      case 'announce-cancel':
        focusPending.current = true;
        setAnnouncement(t('wsTasks.kbd.cancelled', { id: effect.id }));
        break;
    }
  }, [byId, onOpen, onStage, t, colName]);

  const onCardKey = (e: KeyboardEvent<HTMLDivElement>) => {
    // Keys pressed on a chip, Undo or the ⋯ button inside a card are theirs.
    if (e.target !== e.currentTarget) return;
    if (e.nativeEvent.isComposing) return;
    const r = boardKeyReducer(keys, e, layout, rtl);
    if (!r.handled && r.state === keys) return;
    if (r.handled) { e.preventDefault(); e.stopPropagation(); }
    setKeys(r.state);
    runEffect(r.effect);
  };

  // ── Drag and drop ──
  const onDragStart = (id: string) => (e: DragEvent<HTMLDivElement>) => {
    e.dataTransfer.setData(DRAG_MIME, id);
    e.dataTransfer.setData('text/plain', id);
    e.dataTransfer.effectAllowed = 'move';
    setDragId(id);
    if (keys.lifted) setKeys({ focusId: keys.lifted.id, lifted: null });
  };
  const endDrag = () => { setDragId(null); setDropColumn(null); };
  const isOurs = (e: DragEvent) => Array.from(e.dataTransfer.types).includes(DRAG_MIME);
  const onDragOver = (column: TaskColumn) => (e: DragEvent<HTMLDivElement>) => {
    if (!isOurs(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dropColumn !== column) setDropColumn(column);
  };
  const onDragLeave = (column: TaskColumn) => (e: DragEvent<HTMLDivElement>) => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    if (dropColumn === column) setDropColumn(null);
  };
  const onDrop = (column: TaskColumn) => (e: DragEvent<HTMLDivElement>) => {
    if (!isOurs(e)) return;
    e.preventDefault();
    const id = e.dataTransfer.getData(DRAG_MIME);
    endDrag();
    const v = byId.get(id);
    if (!v || v.column === column) return;
    onStage(v, { toColumn: column });
    setKeys({ focusId: id, lifted: null });
    setAnnouncement(t('wsTasks.kbd.moved', { id, column: colName(column) }));
  };

  return (
    <div
      ref={board}
      className="cth-ws-tasks-board"
      role="group"
      aria-label={t('wsTasks.view.board')}
      aria-describedby="cth-ws-tasks-kbd-hint"
      onBlur={(e) => {
        // Leaving the board puts a lifted card back.
        if (keys.lifted && !e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setKeys({ focusId: keys.lifted.id, lifted: null });
        }
      }}
    >
      <span id="cth-ws-tasks-kbd-hint" className="cth-ws-tasks-sr">{t('wsTasks.kbd.hint')}</span>
      <span className="cth-ws-tasks-sr" aria-live="polite">{announcement}</span>
      {columns.map((col) => (
        <div
          key={col.column}
          className="cth-ws-tasks-col"
          style={{ ['--cth-ws-tasks-accent' as string]: COLUMN_META[col.column].accent } as CSSProperties}
          data-drop={dropColumn === col.column ? 'true' : undefined}
          onDragOver={onDragOver(col.column)}
          onDragLeave={onDragLeave(col.column)}
          onDrop={onDrop(col.column)}
        >
          <div className="cth-ws-tasks-col-head">
            <span className="cth-ws-ellipsis">{colName(col.column)}</span>
            <span className="cth-ws-tasks-col-count">{col.cards.length}</span>
          </div>
          <div className="cth-ws-tasks-col-body" role="list" aria-label={colName(col.column)}>
            {col.cards.length === 0 && (
              <div className="cth-ws-tasks-col-empty">
                {dragId ? t('wsTasks.board.dropHere') : t('wsTasks.board.empty')}
              </div>
            )}
            {col.cards.map((v) => (
              <TaskCard
                key={v.task.key}
                view={v}
                variant="board"
                now={now}
                nameOf={nameOf}
                owners={owners}
                tabbable={v.task.id === tabStop}
                lifted={keys.lifted?.id === v.task.id}
                dragging={dragId === v.task.id}
                draggable
                onOpen={() => onOpen(v.task.id)}
                onStage={(change) => onStage(v, change)}
                onUndo={() => onUndo(v.task.id)}
                onAsks={onAsks}
                onFocus={() => { if (keys.focusId !== v.task.id && !keys.lifted) setKeys({ focusId: v.task.id, lifted: null }); }}
                onKeyDown={onCardKey}
                onDragStart={onDragStart(v.task.id)}
                onDragEnd={endDrag}
              />
            ))}
          </div>
          {col.column === 'done' && col.hiddenDone > 0 && (
            <div className="cth-ws-tasks-col-foot">
              {t('wsTasks.board.hiddenDone', { count: col.hiddenDone })}{' '}
              <button type="button" className="cth-ws-tasks-link" onClick={onShowList}>
                {t('wsTasks.board.showInList')}
              </button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
