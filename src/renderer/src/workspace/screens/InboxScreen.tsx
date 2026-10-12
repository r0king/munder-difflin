/**
 * Inbox: Ask me first, then a row per agent, every routed message, and Outside (Slack, webhooks).
 * Owned by the `wsInbox` unit.
 *
 * FOUNDATION STUB — a placeholder from the shared primitives. Replace the body;
 * keep the export name and the props (Workspace.tsx renders it per route).
 */
import { useTranslation } from 'react-i18next';
import { EmptyState, Screen, ScreenHeader } from '../ui';
import type { WorkspaceScreenProps } from '../types';

export interface InboxScreenProps extends WorkspaceScreenProps {
  /** Which section is open (route param). */
  section?: string;
}

export function InboxScreen({ config, section }: InboxScreenProps) {
  const { t } = useTranslation();
  void config; void section;
  return (
    <Screen header={<ScreenHeader title={t('wsInbox.title')} />}>
      <EmptyState title={t('wsInbox.title')} body={t('ws.shell.stubBody')} />
    </Screen>
  );
}
