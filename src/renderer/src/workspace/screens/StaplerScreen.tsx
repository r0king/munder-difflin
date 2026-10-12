/**
 * The Stapler's meetings library: one folder per meeting, transcripts with
 * You and Them, searchable and editable, sendable to any agent. Owned by the
 * `stapler` unit (route `{ kind: 'stapler' }`).
 *
 * FOUNDATION STUB — a placeholder from the shared primitives. Replace the body;
 * keep the export name and the props.
 */
import { useTranslation } from 'react-i18next';
import { EmptyState, Screen, ScreenHeader } from '../ui';
import type { WorkspaceScreenProps } from '../types';

export function StaplerScreen({ config }: WorkspaceScreenProps) {
  const { t } = useTranslation();
  void config;
  return (
    <Screen header={<ScreenHeader title={t('stapler.title')} />}>
      <EmptyState title={t('stapler.title')} body={t('ws.shell.stubBody')} />
    </Screen>
  );
}
