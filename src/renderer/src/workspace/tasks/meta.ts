/**
 * Display metadata for the Tasks screen: column names and accents, the view
 * and range choices, and the age formatter every view shares.
 */
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { ageParts, type TaskColumn, type TaskRange } from '@shared/workspace/tasks';

/** Column accents match the Classic kanban's, so a column is the same colour
 *  in both interfaces. */
export const COLUMN_META: Record<TaskColumn, { labelKey: string; accent: string }> = {
  todo: { labelKey: 'wsTasks.col.todo', accent: 'var(--cth-sky)' },
  doing: { labelKey: 'wsTasks.col.doing', accent: 'var(--cth-lemon)' },
  blocked: { labelKey: 'wsTasks.col.blocked', accent: 'var(--cth-coral)' },
  done: { labelKey: 'wsTasks.col.done', accent: 'var(--cth-mint)' }
};

export type TasksView = 'board' | 'list' | 'cards';
export const TASK_VIEWS: readonly TasksView[] = ['board', 'list', 'cards'];
export const isTasksView = (v: unknown): v is TasksView =>
  typeof v === 'string' && (TASK_VIEWS as readonly string[]).includes(v);

export const RANGE_LABEL: Record<TaskRange, string> = {
  today: 'wsTasks.range.today',
  week: 'wsTasks.range.week',
  month: 'wsTasks.range.month',
  all: 'wsTasks.range.all'
};

/** "6h", "3d", "45m" — localized. */
export function useAge(): (ms: number) => string {
  const { t } = useTranslation();
  return useCallback((ms: number) => {
    const { n, unit } = ageParts(ms);
    return t(`wsTasks.age.${unit}`, { n });
  }, [t]);
}

/** MIME type for a card being dragged. A custom type, so a file or a link
 *  dragged in from elsewhere is never taken for a card. */
export const DRAG_MIME = 'application/x-cth-task';
