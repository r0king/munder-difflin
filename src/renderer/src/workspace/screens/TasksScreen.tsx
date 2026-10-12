/**
 * Tasks: cards on a board (or list, or cards), staged moves sent to the orchestrator in one go.
 * Owned by the `wsTasks` unit.
 *
 * FOUNDATION STUB — a placeholder from the shared primitives. Replace the body;
 * keep the export name and the props (Workspace.tsx renders it per route).
 */
import { useTranslation } from 'react-i18next';
import { EmptyState, Screen, ScreenHeader } from '../ui';
import type { WorkspaceScreenProps } from '../types';

export function TasksScreen({ config }: WorkspaceScreenProps) {
  const { t } = useTranslation();
  void config;
  return (
    <Screen header={<ScreenHeader title={t('wsTasks.title')} />}>
      <EmptyState title={t('wsTasks.title')} body={t('ws.shell.stubBody')} />
    </Screen>
  );
}
