/**
 * One task card, for the Board (compact) and the Cards view (wide).
 *
 * The id leads (bmt-12 is what everyone calls the card), then the title, then
 * the owner. Flags sit top-right and are only ever there for a reason: the
 * card asks you something, it has gone stale in Doing, or a change you sent
 * has not landed yet. A staged change shows as a dashed outline with a
 * "pending" line and its own Undo.
 *
 * Inner controls are tab stops only while the card itself has focus (the
 * Board uses a roving tab stop), so tabbing through the screen visits a board
 * once instead of three times per card.
 */
import type { DragEvent, KeyboardEvent, MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { TaskColumn } from '@shared/workspace/tasks';
import type { TaskView } from '@shared/workspace/tasksView';
import { WsIcon } from '../ui';
import { COLUMN_META, useAge } from './meta';
import { TaskMenu } from './TaskMenu';
import type { AgentOption } from './useTaskBoard';

export interface TaskCardProps {
  view: TaskView;
  variant: 'board' | 'wide';
  now: number;
  nameOf: (agentId: string) => string | undefined;
  owners: readonly AgentOption[];
  /** This card is the board's tab stop. */
  tabbable: boolean;
  lifted?: boolean;
  dragging?: boolean;
  draggable?: boolean;
  onOpen: () => void;
  onStage: (change: { toColumn?: TaskColumn; toOwner?: string | null }) => void;
  onUndo: () => void;
  onAsks: () => void;
  onFocus?: () => void;
  onKeyDown?: (e: KeyboardEvent<HTMLDivElement>) => void;
  onDragStart?: (e: DragEvent<HTMLDivElement>) => void;
  onDragEnd?: () => void;
}

export function TaskCard({
  view, variant, now, nameOf, owners, tabbable, lifted, dragging, draggable,
  onOpen, onStage, onUndo, onAsks, onFocus, onKeyDown, onDragStart, onDragEnd
}: TaskCardProps) {
  const { t } = useTranslation();
  const age = useAge();
  const { task, staged, sent } = view;
  const ownerLabel = (id: string | null): string =>
    id ? (nameOf(id) ?? id) : t('wsTasks.unassigned');
  const inner = tabbable ? 0 : -1;
  const stop = (e: MouseEvent) => e.stopPropagation();

  const flags = (
    <span className="cth-ws-tasks-card-flags">
      {view.asks && (
        <button
          type="button"
          className="cth-ws-chip cth-ws-chip--accent"
          tabIndex={inner}
          title={t('wsTasks.flag.asksTitle')}
          onClick={(e) => { stop(e); onAsks(); }}
        >
          {t('wsTasks.flag.asks')}
        </button>
      )}
      {view.staleMs !== null && (
        <span className="cth-ws-chip cth-ws-chip--warn" title={t('wsTasks.flag.staleTitle', { age: age(view.staleMs) })}>
          {t('wsTasks.flag.stale', { age: age(view.staleMs) })}
        </span>
      )}
      {sent && (
        <span
          className="cth-ws-chip cth-ws-chip--info"
          title={t('wsTasks.flag.sentTitle', { age: age(now - sent.sentAt) })}
        >
          {sent.toColumn !== sent.fromColumn
            ? t('wsTasks.flag.sentMove', { column: t(COLUMN_META[sent.toColumn].labelKey) })
            : t('wsTasks.flag.sentOwner', { owner: ownerLabel(sent.toOwner) })}
        </span>
      )}
    </span>
  );

  const label = [
    task.id,
    task.title,
    t(COLUMN_META[view.column].labelKey),
    ownerLabel(view.owner),
    staged ? t('wsTasks.pending.short') : '',
    view.asks ? t('wsTasks.flag.asks') : ''
  ].filter(Boolean).join(', ');

  return (
    <div
      className={variant === 'wide' ? 'cth-ws-tasks-card cth-ws-tasks-card--wide' : 'cth-ws-tasks-card'}
      data-task-id={task.id}
      data-staged={staged ? 'true' : undefined}
      data-lifted={lifted ? 'true' : undefined}
      data-dragging={dragging ? 'true' : undefined}
      role="listitem"
      aria-label={label}
      aria-roledescription={t('wsTasks.card.role')}
      tabIndex={tabbable ? 0 : -1}
      draggable={draggable}
      onClick={onOpen}
      onFocus={(e) => { if (e.target === e.currentTarget) onFocus?.(); }}
      onKeyDown={onKeyDown}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
    >
      <div className="cth-ws-tasks-card-top">
        <span className="cth-ws-tasks-card-id">{task.id}</span>
        {flags}
      </div>
      <div className="cth-ws-tasks-card-title" dir="auto">{task.title}</div>
      {variant === 'wide' && task.description?.trim() && (
        <div className="cth-ws-tasks-card-desc" dir="auto">{task.description.trim()}</div>
      )}
      {staged && (
        <div className="cth-ws-tasks-pending">
          <span className="cth-ws-ellipsis">
            {staged.fromColumn !== staged.toColumn
              ? t('wsTasks.pending.from', { column: t(COLUMN_META[staged.fromColumn].labelKey) })
              : t('wsTasks.pending.short')}
            {(staged.fromOwner ?? null) !== (staged.toOwner ?? null) && (
              <> · {t('wsTasks.pending.owner', { owner: ownerLabel(staged.toOwner) })}</>
            )}
          </span>
          <button
            type="button"
            className="cth-ws-btn cth-ws-btn--ghost cth-ws-btn--sm"
            tabIndex={inner}
            onClick={(e) => { stop(e); onUndo(); }}
          >
            {t('wsTasks.pending.undo')}
          </button>
        </div>
      )}
      <div className="cth-ws-tasks-card-foot">
        {variant === 'wide' && (
          <span className="cth-ws-tasks-colchip">
            <span className="cth-ws-tasks-swatch" style={{ background: COLUMN_META[view.column].accent }} />
            {t(COLUMN_META[view.column].labelKey)}
          </span>
        )}
        <span className={view.owner ? 'cth-ws-tasks-owner cth-ws-ellipsis' : 'cth-ws-tasks-owner cth-ws-tasks-owner--none cth-ws-ellipsis'}>
          {ownerLabel(view.owner)}
        </span>
        {variant === 'wide' && view.lastActivity !== null && (
          <span className="cth-ws-tasks-nowrap">{t('wsTasks.updatedAgo', { age: age(now - view.lastActivity) })}</span>
        )}
        <span className="cth-ws-tasks-card-actions" onClick={stop}>
          {!staged && view.asks && variant === 'board' ? null : null}
          <TaskMenu
            column={view.column}
            owner={view.owner}
            owners={owners}
            hasStaged={!!staged}
            tabIndex={inner}
            onStage={onStage}
            onOpen={onOpen}
            onUndo={onUndo}
          />
        </span>
      </div>
      {lifted && <WsIcon name="chevron-right" size={16} />}
    </div>
  );
}
