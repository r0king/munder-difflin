/**
 * The List: every card in the current filter as one row — done cards
 * included, however long ago they finished (the Board lets those go; the List
 * is where they stay). Column and owner are pickers on the row; changing
 * either STAGES the change, exactly like a drag on the Board.
 */
import { useTranslation } from 'react-i18next';
import { TASK_COLUMNS, type TaskColumn } from '@shared/workspace/tasks';
import type { TaskView } from '@shared/workspace/tasksView';
import { COLUMN_META, useAge } from './meta';
import type { AgentOption } from './useTaskBoard';

export interface ListViewProps {
  views: TaskView[];
  now: number;
  nameOf: (agentId: string) => string | undefined;
  owners: readonly AgentOption[];
  onOpen: (taskId: string) => void;
  onStage: (view: TaskView, change: { toColumn?: TaskColumn; toOwner?: string | null }) => void;
  onUndo: (taskId: string) => void;
  onAsks: () => void;
}

const NO_OWNER = '';

export function ListView({ views, now, nameOf, owners, onOpen, onStage, onUndo, onAsks }: ListViewProps) {
  const { t } = useTranslation();
  const age = useAge();
  const ownerLabel = (id: string | null) => (id ? nameOf(id) ?? id : t('wsTasks.unassigned'));

  return (
    <div className="cth-ws-tasks-listwrap">
      <table className="cth-ws-tasks-table">
        <thead>
          <tr>
            <th scope="col" className="cth-ws-tasks-th-id">{t('wsTasks.list.id')}</th>
            <th scope="col">{t('wsTasks.list.title')}</th>
            <th scope="col" className="cth-ws-tasks-th-column">{t('wsTasks.list.column')}</th>
            <th scope="col" className="cth-ws-tasks-th-owner">{t('wsTasks.list.owner')}</th>
            <th scope="col" className="cth-ws-tasks-th-updated">{t('wsTasks.list.updated')}</th>
            <th scope="col" className="cth-ws-tasks-th-flags"><span className="cth-ws-tasks-sr">{t('wsTasks.list.flags')}</span></th>
          </tr>
        </thead>
        <tbody>
          {views.map((v) => {
            const { task, staged, sent } = v;
            const ownerKnown = !v.owner || owners.some((o) => o.id === v.owner);
            return (
              <tr key={task.key} data-staged={staged ? 'true' : undefined}>
                <td className="cth-ws-tasks-nowrap">
                  <span className="cth-ws-tasks-card-id">{task.id}</span>
                </td>
                <td>
                  <button
                    type="button"
                    className="cth-ws-tasks-row-title cth-ws-ellipsis"
                    title={task.title}
                    dir="auto"
                    onClick={() => onOpen(task.id)}
                  >
                    {task.title}
                  </button>
                </td>
                <td className="cth-ws-tasks-nowrap">
                  <select
                    className="cth-ws-tasks-select cth-ws-tasks-select--sm"
                    aria-label={t('wsTasks.list.columnFor', { id: task.id })}
                    title={task.rawStatus && task.rawStatus !== task.column ? t('wsTasks.list.rawStatus', { status: task.rawStatus }) : undefined}
                    value={v.column}
                    onChange={(e) => onStage(v, { toColumn: e.target.value as TaskColumn })}
                  >
                    {TASK_COLUMNS.map((c) => <option key={c} value={c}>{t(COLUMN_META[c].labelKey)}</option>)}
                  </select>
                </td>
                <td className="cth-ws-tasks-nowrap">
                  <select
                    className="cth-ws-tasks-select cth-ws-tasks-select--sm"
                    aria-label={t('wsTasks.list.ownerFor', { id: task.id })}
                    value={v.owner ?? NO_OWNER}
                    onChange={(e) => onStage(v, { toOwner: e.target.value === NO_OWNER ? null : e.target.value })}
                  >
                    <option value={NO_OWNER}>{t('wsTasks.unassigned')}</option>
                    {!ownerKnown && v.owner && <option value={v.owner}>{ownerLabel(v.owner)}</option>}
                    {owners.map((o) => (
                      <option key={o.id} value={o.id}>{o.isGod ? t('wsTasks.ownerGod', { name: o.name }) : o.name}</option>
                    ))}
                  </select>
                </td>
                <td className="cth-ws-tasks-nowrap cth-ws-muted">
                  {v.lastActivity !== null ? t('wsTasks.ago', { age: age(now - v.lastActivity) }) : '—'}
                </td>
                <td>
                  <span className="cth-ws-tasks-cell-flags">
                    {v.asks && (
                      <button type="button" className="cth-ws-chip cth-ws-chip--accent" title={t('wsTasks.flag.asksTitle')} onClick={onAsks}>
                        {t('wsTasks.flag.asks')}
                      </button>
                    )}
                    {v.staleMs !== null && (
                      <span className="cth-ws-chip cth-ws-chip--warn">{t('wsTasks.flag.stale', { age: age(v.staleMs) })}</span>
                    )}
                    {sent && (
                      <span className="cth-ws-chip cth-ws-chip--info" title={t('wsTasks.flag.sentTitle', { age: age(now - sent.sentAt) })}>
                        {sent.toColumn !== sent.fromColumn
                          ? t('wsTasks.flag.sentMove', { column: t(COLUMN_META[sent.toColumn].labelKey) })
                          : t('wsTasks.flag.sentOwner', { owner: ownerLabel(sent.toOwner) })}
                      </span>
                    )}
                    {staged && (
                      <>
                        <span className="cth-ws-chip cth-ws-chip--neutral">{t('wsTasks.pending.short')}</span>
                        <button type="button" className="cth-ws-btn cth-ws-btn--ghost cth-ws-btn--sm" onClick={() => onUndo(task.id)}>
                          {t('wsTasks.pending.undo')}
                        </button>
                      </>
                    )}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
