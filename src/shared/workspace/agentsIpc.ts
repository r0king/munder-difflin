/**
 * `feat:agents:*` — the wsAgents unit's IPC contract, shared by
 * src/main/features/agents.ts (handlers) and src/preload/features/agents.ts
 * (the `window.cth.features.agents` bridge). Types for the payloads live with
 * the logic that produces them (agentsSummary.ts, agentsConversation.ts).
 */

export const AGENTS_CHANNELS = {
  /** (agentIds: string[]) → AgentActivity[] — what each card reads off disk. */
  activity: 'feat:agents:activity',
  /** (agentId: string) → ConversationSources (without `history`). */
  conversation: 'feat:agents:conversation',
  /** (agentId: string, input: RecordSendInput) → { ok, error? } */
  recordSend: 'feat:agents:recordSend',
  /** (agentId: string) → AgentExitInfo | null */
  lastExit: 'feat:agents:lastExit',
  /** (agentId: string) → { ok, error? } — show its crash log in the file manager. */
  revealCrashLog: 'feat:agents:revealCrashLog'
} as const;

export interface RecordSendInput {
  text: string;
  mode: 'send' | 'steer';
}

/** The newest abnormal exit the hive logged for an agent. */
export interface AgentExitInfo {
  ts: number;
  exitCode: number | null;
  signal: number | null;
  /** A crash log (the terminal's last output) was kept and can be revealed. */
  hasLog: boolean;
}

/** Bounds the handlers enforce on renderer input. */
export const MAX_ACTIVITY_IDS = 200;
export const MAX_SEND_TEXT = 200_000;
