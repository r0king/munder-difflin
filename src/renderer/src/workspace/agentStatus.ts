/**
 * Renderer face of the Workspace status model. The logic is pure and lives in
 * src/shared/workspace/agentStatus.ts (so node:test can load it); this module
 * re-exports it and adds the two things that need React/i18n: translating a
 * status or live line, and a hook that derives both for one agent.
 */
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { Agent } from '@/store/store';
import {
  agentLiveLine,
  deriveAgentStatus,
  statusKey,
  type LiveLine,
  type WsAgentStatus
} from '@shared/workspace/agentStatus';

export {
  WS_AGENT_STATUSES,
  agentLiveLine,
  deriveAgentStatus,
  isActiveStatus,
  liveLine,
  statusColorToken,
  statusColorVar,
  statusKey
} from '@shared/workspace/agentStatus';
export type {
  AgentStatusInput,
  LiveLine,
  LiveLineInput,
  LiveLineKind,
  WsAgentStatus
} from '@shared/workspace/agentStatus';

/** `ws.status.<key>` — "Working", "Needs you", … */
export function statusLabel(t: TFunction, status: WsAgentStatus): string {
  return t(`ws.status.${statusKey(status)}`);
}

/** The i18n key for a live line: `ws.live.<kind>` or `ws.live.<kind>Detail`. */
export function liveLineKey(line: LiveLine): string {
  return `ws.live.${line.kind}${line.detail ? 'Detail' : ''}`;
}

/** Translate a live line; the detail (agent-written text) is passed verbatim. */
export function liveLineText(t: TFunction, line: LiveLine): string {
  return line.detail ? t(liveLineKey(line), { detail: line.detail }) : t(liveLineKey(line));
}

/** Status + live line for one store agent. `hasOpenQuestion` comes from
 *  useAskedYou() (workspace/useHiveTasks.ts) when the caller has it. */
export function useAgentPresence(
  agent: Pick<Agent, 'status' | 'action' | 'ptyId' | 'archived' | 'isGod'> | undefined,
  hasOpenQuestion = false
): { status: WsAgentStatus; line: LiveLine; label: string; text: string } {
  const { t } = useTranslation();
  const input = agent
    ? { status: agent.status, action: agent.action, ptyId: agent.ptyId, archived: agent.archived, isGod: agent.isGod, hasOpenQuestion }
    : { status: 'ghost' };
  const status = deriveAgentStatus(input);
  const line = agentLiveLine(input);
  return { status, line, label: statusLabel(t, status), text: liveLineText(t, line) };
}
