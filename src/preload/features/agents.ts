/**
 * `window.cth.features.agents` — owned by the `wsAgents` unit. Agent cards and agent rooms.
 *
 * Add members here and nowhere else; the object is spread into the bridge as
 * is, so its type IS the renderer's type. Channels and payload types are in
 * src/shared/workspace/agentsIpc.ts; the handlers in src/main/features/agents.ts.
 * Every call takes agent ids — never a path.
 */
import { ipcRenderer } from 'electron';
import {
  AGENTS_CHANNELS,
  type AgentExitInfo,
  type RecordSendInput
} from '../../shared/workspace/agentsIpc';
import type { ConversationSources } from '../../shared/workspace/agentsConversation';
import type { AgentActivity } from '../../shared/workspace/agentsSummary';

export const agentsApi = {
  /** What each card reads off disk: last reply, last message, current tool
   *  call and its result. Unknown or invalid ids are skipped. */
  activity: (agentIds: string[]): Promise<AgentActivity[]> =>
    ipcRenderer.invoke(AGENTS_CHANNELS.activity, agentIds),
  /** The room's conversation sources (merge them with buildConversation). */
  conversation: (agentId: string): Promise<ConversationSources> =>
    ipcRenderer.invoke(AGENTS_CHANNELS.conversation, agentId),
  /** Remember a Send / Steer from the room, so the conversation shows it before
   *  (and, for a steer, without) it ever reaching the transcript. */
  recordSend: (agentId: string, input: RecordSendInput): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(AGENTS_CHANNELS.recordSend, agentId, input),
  /** The newest abnormal exit the hive logged for this agent, or null. */
  lastExit: (agentId: string): Promise<AgentExitInfo | null> =>
    ipcRenderer.invoke(AGENTS_CHANNELS.lastExit, agentId),
  /** Show that exit's crash log (the terminal's last output) in the file manager. */
  revealCrashLog: (agentId: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(AGENTS_CHANNELS.revealCrashLog, agentId)
};
