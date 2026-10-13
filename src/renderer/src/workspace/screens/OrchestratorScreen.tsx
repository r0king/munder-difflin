/**
 * The orchestrator's screen: terminal, messages, routing log, budget and
 * breaker, board, configuration. Owned by the `wsOrchestrator` unit; the tabs
 * and their pieces live in ../orchestrator/.
 *
 * Above the tabs: the floor-wide "Deliveries paused" switch (header), its
 * banner while it is on, and the stat strip — spend today against the cap,
 * the breaker, tasks in progress, questions waiting on you.
 *
 * The open tab is the route's `tab` param, so it survives a reload and a
 * deep link (navigate({ kind: 'orchestrator', tab: 'budget' })) opens it.
 */
import { useTranslation } from 'react-i18next';
import { useStore } from '@/store/store';
import { inferAgentProvider, modelsForProvider, providerPreset } from '@/store/config';
import { TasksKanban } from '@/components/TasksKanban';
import { useResolvedGodName } from '@/hooks/useResolvedGodName';
import { EmptyState, Screen, ScreenHeader, Spinner, StatusDot, Tabs } from '../ui';
import { useAgentPresence } from '../agentStatus';
import { useAskedYou } from '../useHiveTasks';
import { useWorkspace } from '../store';
import type { WorkspaceScreenProps } from '../types';
import { ORCH_TABS, toOrchTab, type OrchTab } from '../orchestrator/tabs';
import { StatStrip } from '../orchestrator/StatStrip';
import { DeliveriesPausedBanner, DeliveriesToggle } from '../orchestrator/Deliveries';
import { TerminalTab } from '../orchestrator/TerminalTab';
import { MessagesTab } from '../orchestrator/MessagesTab';
import { RoutingTab } from '../orchestrator/RoutingTab';
import { BudgetTab } from '../orchestrator/BudgetTab';
import { ConfigTab } from '../orchestrator/ConfigTab';
import '../orchestrator/orchestrator.css';

export interface OrchestratorScreenProps extends WorkspaceScreenProps {
  /** Which tab is open (route param). Change it with navigate({ kind: 'orchestrator', tab }). */
  tab?: string;
}

export function OrchestratorScreen({ config, tab }: OrchestratorScreenProps) {
  const { t } = useTranslation();
  const god = useStore((s) => s.agents.find((a) => a.isGod));
  const godStatus = useStore((s) => s.godStatus);
  const godName = useResolvedGodName();
  const navigate = useWorkspace((s) => s.navigate);
  const askedYou = useAskedYou();
  const presence = useAgentPresence(god, !!god && askedYou.has(god.id));
  const current = toOrchTab(tab);
  const open = (next: OrchTab) => navigate({ kind: 'orchestrator', tab: next });

  if (!god) {
    // The shell covers an empty floor and a failed boot; this is god missing
    // from a floor that has other agents (still booting, or closed).
    return (
      <Screen fill header={<ScreenHeader title={godName} subtitle={t('wsOrchestrator.role')} actions={<DeliveriesToggle />} />}>
        <EmptyState
          fill
          icon={godStatus === 'booting' ? <Spinner label={t('wsOrchestrator.booting', { godName })} /> : undefined}
          title={godStatus === 'booting' ? t('wsOrchestrator.booting', { godName }) : t('wsOrchestrator.absent', { godName })}
          body={godStatus === 'booting' ? t('wsOrchestrator.bootingBody') : t('wsOrchestrator.absentBody', { godName })}
        />
      </Screen>
    );
  }

  const provider = inferAgentProvider(god.command, god.provider);
  const modelLabel = modelsForProvider(provider).find((m) => (m.id ?? '') === (god.model ?? ''))?.label ?? god.model;
  const subtitle = [t('wsOrchestrator.role'), providerPreset(provider).label, modelLabel].filter(Boolean).join(' · ');

  const tabLabels: Record<OrchTab, string> = {
    terminal: t('wsOrchestrator.tabs.terminal'),
    messages: t('wsOrchestrator.tabs.messages'),
    routing: t('wsOrchestrator.tabs.routing'),
    budget: t('wsOrchestrator.tabs.budget'),
    board: t('wsOrchestrator.tabs.board'),
    config: t('wsOrchestrator.tabs.config')
  };

  return (
    <Screen
      fill
      header={
        <ScreenHeader
          leading={<StatusDot status={presence.status} size={12} title={presence.label} />}
          title={god.name}
          subtitle={subtitle}
          actions={<DeliveriesToggle />}
        >
          <Tabs<OrchTab>
            tabs={ORCH_TABS.map((id) => ({ id, label: tabLabels[id] }))}
            value={current}
            onChange={open}
            ariaLabel={t('wsOrchestrator.tabsAria', { godName: god.name })}
          />
        </ScreenHeader>
      }
    >
      <DeliveriesPausedBanner onRaiseCap={() => open('budget')} />
      <div className="cth-ws-orch-top">
        <StatStrip config={config} onOpenTab={open} />
      </div>
      <div className="cth-ws-orch-body" role="tabpanel" aria-label={tabLabels[current]}>
        {current === 'terminal' && <TerminalTab god={god} />}
        {current === 'messages' && <MessagesTab god={god} />}
        {current === 'routing' && <RoutingTab />}
        {current === 'budget' && <BudgetTab config={config} />}
        {current === 'board' && <div className="cth-ws-orch-board"><TasksKanban /></div>}
        {current === 'config' && <ConfigTab god={god} config={config} />}
      </div>
    </Screen>
  );
}
