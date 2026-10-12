/**
 * The orchestrator's screen: terminal, messages, routing log, budget and breaker, board, configuration.
 * Owned by the `wsOrchestrator` unit.
 *
 * FOUNDATION STUB — a placeholder from the shared primitives. Replace the body;
 * keep the export name and the props (Workspace.tsx renders it per route).
 */
import { useTranslation } from 'react-i18next';
import { EmptyState, Screen, ScreenHeader } from '../ui';
import type { WorkspaceScreenProps } from '../types';

export interface OrchestratorScreenProps extends WorkspaceScreenProps {
  /** Which tab is open (route param). Change it with navigate({ kind: 'orchestrator', tab }). */
  tab?: string;
}

export function OrchestratorScreen({ config, tab }: OrchestratorScreenProps) {
  const { t } = useTranslation();
  void config; void tab;
  return (
    <Screen header={<ScreenHeader title={t('wsOrchestrator.title')} />}>
      <EmptyState title={t('wsOrchestrator.title')} body={t('ws.shell.stubBody')} />
    </Screen>
  );
}
