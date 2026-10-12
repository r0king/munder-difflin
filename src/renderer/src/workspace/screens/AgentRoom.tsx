/**
 * An agent's room: the conversation on one side, its live terminal on the
 * other; send or steer, pause tools, stop after this step, 1:1; engine, model,
 * role and token cap. Owned by the `wsAgents` unit.
 *
 * FOUNDATION STUB — a placeholder from the shared primitives. Replace the body;
 * keep the export name and the props (Workspace.tsx renders it for
 * `{ kind: 'agent', agentId }`, and only for an agent that is on the roster
 * and is not god — god's room is the orchestrator screen).
 */
import { useTranslation } from 'react-i18next';
import { useStore } from '@/store/store';
import { useAgentPresence } from '../agentStatus';
import { EmptyState, Screen, ScreenHeader, StatusBadge } from '../ui';
import type { WorkspaceScreenProps } from '../types';

export interface AgentRoomProps extends WorkspaceScreenProps {
  agentId: string;
}

export function AgentRoom({ agentId, config }: AgentRoomProps) {
  const { t } = useTranslation();
  const agent = useStore((s) => s.agents.find((a) => a.id === agentId));
  const presence = useAgentPresence(agent);
  void config;
  return (
    <Screen
      header={
        <ScreenHeader
          title={agent?.name ?? agentId}
          subtitle={presence.text}
          actions={<StatusBadge status={presence.status} />}
        />
      }
    >
      <EmptyState title={t('wsAgents.title')} body={t('ws.shell.stubBody')} />
    </Screen>
  );
}
