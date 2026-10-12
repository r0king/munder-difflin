/**
 * Capabilities: skills, connections and MCP per agent, role bundles, and Temps.
 * Owned by the `wsCapabilities` unit.
 *
 * FOUNDATION STUB — a placeholder from the shared primitives. Replace the body;
 * keep the export name and the props (Workspace.tsx renders it per route).
 */
import { useTranslation } from 'react-i18next';
import { EmptyState, Screen, ScreenHeader } from '../ui';
import type { WorkspaceScreenProps } from '../types';

export interface CapabilitiesScreenProps extends WorkspaceScreenProps {
  /** Which tab is open (route param). */
  tab?: string;
}

export function CapabilitiesScreen({ config, tab }: CapabilitiesScreenProps) {
  const { t } = useTranslation();
  void config; void tab;
  return (
    <Screen header={<ScreenHeader title={t('wsCapabilities.title')} />}>
      <EmptyState title={t('wsCapabilities.title')} body={t('ws.shell.stubBody')} />
    </Screen>
  );
}
