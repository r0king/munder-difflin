/**
 * Capabilities: skills, connections and MCP servers granted per agent, the
 * eleven role bundles, the marketplace, the floor-wide "who has what", and
 * Temps. Owned by the `wsCapabilities` unit; the tabs live in
 * workspace/capabilities/.
 *
 * The open tab is the route's (`{ kind: 'capabilities', tab }`), so the sidebar's
 * Temps rows can link straight to it; without one the last tab used opens.
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Screen, ScreenHeader, Tabs } from '../ui';
import { loadWsPref, saveWsPref, useWorkspace } from '../store';
import { useStore } from '@/store/store';
import type { WorkspaceScreenProps } from '../types';
import { MarketplaceTab } from '../capabilities/MarketplaceTab';
import { InstalledTab } from '../capabilities/InstalledTab';
import { WhoHasWhatTab } from '../capabilities/WhoHasWhatTab';
import { TempsTab } from '../capabilities/TempsTab';
import {
  useCapabilitiesState,
  useConnections,
  useFloorAgents,
  useLocalSkills,
  useTemps
} from '../capabilities/useCapabilities';
import '../capabilities/capabilities.css';

export interface CapabilitiesScreenProps extends WorkspaceScreenProps {
  /** Which tab is open (route param). */
  tab?: string;
}

type TabId = 'marketplace' | 'installed' | 'who' | 'temps';
const TAB_IDS: readonly TabId[] = ['marketplace', 'installed', 'who', 'temps'];
const isTab = (v: unknown): v is TabId => typeof v === 'string' && (TAB_IDS as readonly string[]).includes(v);

export function CapabilitiesScreen({ config, tab }: CapabilitiesScreenProps) {
  const { t } = useTranslation();
  const navigate = useWorkspace((s) => s.navigate);
  const current: TabId = isTab(tab) ? tab : loadWsPref<TabId>('capabilities.tab', 'marketplace', isTab);
  useEffect(() => { saveWsPref('capabilities.tab', current); }, [current]);
  const setTab = (id: TabId) => navigate({ kind: 'capabilities', tab: id });

  const agents = useFloorAgents();
  const agentIds = useMemo(() => agents.map((a) => a.id), [agents]);
  const { state, error } = useCapabilitiesState(agentIds);
  const { skills: local, reload: reloadLocal } = useLocalSkills();
  const { records, reload: reloadRecords } = useConnections();
  const { temps } = useTemps(false);

  // Who a bundle or a one-agent install goes to: the agent on screen when there
  // is one, else the first agent that is not the orchestrator.
  const selectedId = useStore((s) => s.selectedId);
  const [target, setTarget] = useState('');
  useEffect(() => {
    if (target && agents.some((a) => a.id === target)) return;
    const pick = agents.find((a) => a.id === selectedId && !a.isGod) ?? agents.find((a) => !a.isGod) ?? agents[0];
    setTarget(pick?.id ?? '');
  }, [agents, selectedId, target]);
  const [bundleRequest, setBundleRequest] = useState<{ bundleId: string; seq: number } | null>(null);

  const running = temps ? temps.running : 0;
  const tabs = [
    { id: 'marketplace' as const, label: t('wsCapabilities.tabs.marketplace') },
    { id: 'installed' as const, label: t('wsCapabilities.tabs.installed') },
    { id: 'who' as const, label: t('wsCapabilities.tabs.who') },
    { id: 'temps' as const, label: t('wsCapabilities.tabs.temps'), badge: running > 0 ? `${running}/${temps?.maxConcurrent ?? 3}` : undefined }
  ];

  return (
    <Screen
      header={(
        <ScreenHeader title={t('wsCapabilities.title')} subtitle={t('wsCapabilities.subtitle')}>
          <Tabs<TabId> tabs={tabs} value={current} onChange={setTab} ariaLabel={t('wsCapabilities.title')} />
        </ScreenHeader>
      )}
    >
      {error && !state && (
        <div className="cth-ws-capabilities-banner" data-tone="error"><span>{t('wsCapabilities.common.loadFailed')}</span></div>
      )}
      {current === 'marketplace' && (
        <MarketplaceTab
          agents={agents}
          state={state}
          connections={records}
          target={target}
          onTarget={setTarget}
          reloadLocal={reloadLocal}
          bundleRequest={bundleRequest}
        />
      )}
      {current === 'installed' && (
        <InstalledTab
          agents={agents}
          state={state}
          local={local}
          reloadLocal={reloadLocal}
          records={records}
          reloadRecords={reloadRecords}
          config={config}
        />
      )}
      {current === 'who' && (
        <WhoHasWhatTab
          agents={agents}
          state={state}
          records={records}
          config={config}
          onBundle={(agentId, bundleId) => {
            setTarget(agentId);
            setBundleRequest((r) => ({ bundleId, seq: (r?.seq ?? 0) + 1 }));
            setTab('marketplace');
          }}
        />
      )}
      {current === 'temps' && <TempsTab config={config} />}
    </Screen>
  );
}
