/**
 * Agents: a card per agent — its status in words, engine and model, its
 * ticket, its latest update in its own words, the tool call it is on and what
 * that printed, the question it is waiting on, its context and its spend.
 * Click a card for the agent's room. Owned by the `wsAgents` unit.
 *
 * Data, all live and all existing: the hive store (status, action, context,
 * queues), the shared task-ledger poll (ticket, ASK ME), live telemetry
 * (spend), and `feat:agents:activity` for what the agent last wrote and ran
 * (read off its transcript and outbox by main).
 */
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '@/store/store';
import { useFleetTelemetry } from '@/hooks/useTelemetry';
import { openAskFor, pickCurrentTicket } from '@shared/workspace/agentsSummary';
import { Button, EmptyState, Screen, ScreenHeader, WsIcon } from '../ui';
import { useWorkspace } from '../store';
import { useAskedYou, useHiveTasks } from '../useHiveTasks';
import type { WorkspaceScreenProps } from '../types';
import { AgentCardView } from '../agents/AgentCardView';
import { useAgentActivity, useExitedPtys } from '../agents/hooks';
import '../agents/agents.css';

export function AgentsScreen({ config }: WorkspaceScreenProps) {
  const { t } = useTranslation();
  const agents = useStore((s) => s.agents);
  const setAddAgentOpen = useStore((s) => s.setAddAgentOpen);
  const navigate = useWorkspace((s) => s.navigate);
  const { tasks, loaded: tasksLoaded } = useHiveTasks();
  const askedYou = useAskedYou();
  const { samples } = useFleetTelemetry();

  // The orchestrator first, then the floor in its own (user-orderable) order.
  const ordered = useMemo(() => {
    const live = agents.filter((a) => !a.archived);
    return [...live.filter((a) => a.isGod), ...live.filter((a) => !a.isGod)];
  }, [agents]);
  const ids = useMemo(() => ordered.map((a) => a.id), [ordered]);
  const activity = useAgentActivity(ids);
  const dead = useExitedPtys(ordered.map((a) => a.ptyId));
  const liveCount = ordered.filter((a) => a.ptyId && !dead.has(a.ptyId)).length;

  return (
    <Screen
      header={
        <ScreenHeader
          title={t('wsAgents.title')}
          subtitle={ordered.length === 1
            ? t('wsAgents.screen.summaryOne', { live: liveCount })
            : t('wsAgents.screen.summary', { total: ordered.length, live: liveCount })}
          actions={
            <>
              <Button variant="ghost" icon={<WsIcon name="capabilities" />} onClick={() => navigate({ kind: 'capabilities' })}>
                {t('wsAgents.screen.capabilities')}
              </Button>
              <Button variant="primary" icon={<WsIcon name="plus" />} onClick={() => setAddAgentOpen(true)}>
                {t('wsAgents.screen.addAgent')}
              </Button>
            </>
          }
        />
      }
    >
      {ordered.length === 0 ? (
        <EmptyState
          title={t('wsAgents.screen.emptyTitle')}
          body={t('wsAgents.screen.emptyBody')}
          action={<Button variant="primary" onClick={() => setAddAgentOpen(true)}>{t('wsAgents.screen.addAgent')}</Button>}
        />
      ) : (
        <div className="cth-ws-agents-grid">
          {ordered.map((a) => (
            <AgentCardView
              key={a.id}
              agent={a}
              activity={activity[a.id]}
              ticket={tasksLoaded ? pickCurrentTicket(tasks, a.id) : null}
              ask={openAskFor(tasks, a.id)}
              hasOpenQuestion={askedYou.has(a.id)}
              dead={!!a.ptyId && dead.has(a.ptyId)}
              usd={samples[a.id]?.usd}
              harnessHome={config.harnessHome}
            />
          ))}
        </div>
      )}
    </Screen>
  );
}
