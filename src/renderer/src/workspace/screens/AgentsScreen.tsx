/**
 * Agents: a card per agent with its status, ticket, live line, context and spend; "Add an agent".
 * Owned by the `wsAgents` unit.
 *
 * FOUNDATION STUB — a placeholder from the shared primitives. Replace the body;
 * keep the export name and the props (Workspace.tsx renders it per route).
 */
import { useTranslation } from 'react-i18next';
import { EmptyState, Screen, ScreenHeader } from '../ui';
import type { WorkspaceScreenProps } from '../types';

export function AgentsScreen({ config }: WorkspaceScreenProps) {
  const { t } = useTranslation();
  void config;
  return (
    <Screen header={<ScreenHeader title={t('wsAgents.title')} />}>
      <EmptyState title={t('wsAgents.title')} body={t('ws.shell.stubBody')} />
    </Screen>
  );
}
