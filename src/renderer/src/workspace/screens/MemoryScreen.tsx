/**
 * Memory: ask the floor what it knows, by exact words or by meaning.
 * Owned by the `wsMemory` unit.
 *
 * FOUNDATION STUB — a placeholder from the shared primitives. Replace the body;
 * keep the export name and the props (Workspace.tsx renders it per route).
 */
import { useTranslation } from 'react-i18next';
import { EmptyState, Screen, ScreenHeader } from '../ui';
import type { WorkspaceScreenProps } from '../types';

export interface MemoryScreenProps extends WorkspaceScreenProps {
  /** A search to run on open (route param). */
  query?: string;
}

export function MemoryScreen({ config, query }: MemoryScreenProps) {
  const { t } = useTranslation();
  void config; void query;
  return (
    <Screen header={<ScreenHeader title={t('wsMemory.title')} />}>
      <EmptyState title={t('wsMemory.title')} body={t('ws.shell.stubBody')} />
    </Screen>
  );
}
