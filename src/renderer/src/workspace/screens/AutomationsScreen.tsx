/**
 * Automations: schedules, context rules and webhooks in one list.
 * Owned by the `wsAutomations` unit.
 *
 * FOUNDATION STUB — a placeholder from the shared primitives. Replace the body;
 * keep the export name and the props (Workspace.tsx renders it per route).
 */
import { useTranslation } from 'react-i18next';
import { EmptyState, Screen, ScreenHeader } from '../ui';
import type { WorkspaceScreenProps } from '../types';

export function AutomationsScreen({ config }: WorkspaceScreenProps) {
  const { t } = useTranslation();
  void config;
  return (
    <Screen header={<ScreenHeader title={t('wsAutomations.title')} />}>
      <EmptyState title={t('wsAutomations.title')} body={t('ws.shell.stubBody')} />
    </Screen>
  );
}
