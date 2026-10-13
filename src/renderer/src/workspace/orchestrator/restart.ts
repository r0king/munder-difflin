/**
 * Restart the orchestrator's terminal in place — on the same engine and model
 * ("Restart & Continue", resuming his conversation) or on a new one.
 *
 * The same sequence as the Classic command center's restartWithModel
 * (components/CommandCenterPanel.tsx), which is local to that component, so it
 * is restated here for the one agent this screen restarts. The order matters
 * and is kept exactly:
 *   1. a resume needs a recorded session id (and, for Claude, its transcript)
 *      BEFORE anything is killed — an explicit "continue" that cannot continue
 *      fails without touching the running process;
 *   2. capture the live grid, kill the PTY (an already-dead PTY is the goal,
 *      not an error), respawn under the SAME pty id;
 *   3. only once the replacement is accepted, swap the pooled xterm for a
 *      fresh one (resume) and bump terminalGeneration so just this terminal
 *      remounts; a fresh start resets the old xterm in place instead.
 */
import { useStore, type Agent } from '@/store/store';
import { acquireTerminal, disposeTerminal, resetTerminal } from '@/components/terminalPool';
import {
  buildSpawnCommand,
  inferAgentProvider,
  tokenizeCommand,
  type AgentProvider
} from '@/store/config';
import { roleForHiveSpawn } from '@shared/agentRole';

export interface RestartOptions {
  provider?: AgentProvider;
  model?: string;
  /** Keep the conversation. */
  resume?: boolean;
  /** Resume when possible, start fresh when not (a model change); without it
   *  a resume that cannot happen is an error (Restart & Continue). */
  resumeOptional?: boolean;
}

export type RestartError =
  | 'noTerminal' | 'crossProvider' | 'noSession' | 'noTranscript' | 'killFailed' | 'spawnFailed' | 'resumeRefused';

export class OrchestratorRestartError extends Error {
  constructor(readonly code: RestartError, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

export async function restartOrchestrator(god: Agent, opts: RestartOptions = {}): Promise<{ resumed: boolean }> {
  if (!god.ptyId) throw new OrchestratorRestartError('noTerminal');
  const ptyId = god.ptyId;
  const cfg = await window.cth.getConfig();
  const previousProvider = inferAgentProvider(god.command, god.provider);
  const provider = opts.provider ?? previousProvider;
  const model = opts.model !== undefined ? opts.model : god.model;
  let resume = opts.resume === true && provider === previousProvider;
  if (opts.resume && !resume && !opts.resumeOptional) throw new OrchestratorRestartError('crossProvider');

  let resumeSessionId: string | undefined;
  if (resume) {
    const giveUp = (code: RestartError) => {
      if (!opts.resumeOptional) throw new OrchestratorRestartError(code);
      resume = false;
      resumeSessionId = undefined;
    };
    const registry = await window.cth.hiveRegistry();
    resumeSessionId = registry.agents[god.id]?.sessionId;
    if (!resumeSessionId) giveUp('noSession');
    else if (provider === 'claude' && !(await window.cth.resolveSessionCwd(resumeSessionId))) giveUp('noTranscript');
  }

  const entry = acquireTerminal(ptyId);
  let cols = entry.term.cols || 100;
  let rows = entry.term.rows || 30;
  try { entry.fit.fit(); cols = entry.term.cols; rows = entry.term.rows; } catch { /* host not sized yet */ }

  const killed = await window.cth.killPty(ptyId);
  if (!killed.ok && !/^no pty:/.test(killed.error ?? '')) {
    throw new OrchestratorRestartError('killFailed', killed.error);
  }
  if (!resume) resetTerminal(ptyId);

  const command = buildSpawnCommand(cfg, model, provider).trim();
  const [exe, ...args] = tokenizeCommand(command);
  const res = await window.cth.spawnPty({
    id: ptyId,
    cwd: god.cwd,
    command: exe,
    args,
    provider,
    cols,
    rows,
    hive: {
      id: god.id,
      name: god.name,
      cwd: god.cwd,
      provider,
      isGod: true,
      role: roleForHiveSpawn(god)
    },
    resume,
    resumeSessionId,
    requireResume: resume
  });
  if (!res.ok) throw new OrchestratorRestartError('spawnFailed', res.error);
  if (resume && res.resumed !== true) throw new OrchestratorRestartError('resumeRefused');

  const { updateAgent } = useStore.getState();
  if (resume) {
    disposeTerminal(ptyId);
    acquireTerminal(ptyId);
    updateAgent(god.id, { terminalGeneration: (god.terminalGeneration ?? 0) + 1 });
  }
  updateAgent(god.id, { command, provider, model, status: 'idle', action: resume ? 'continuing…' : 'restarting…' });
  return { resumed: resume };
}
