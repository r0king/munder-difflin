/**
 * Restart an agent's process in place — the crash strip's Restart and the
 * room's engine/model change.
 *
 * This is the Command Center's `restartWithModel` (CommandCenterPanel.tsx),
 * which lives inside that component and so cannot be imported. It is followed
 * step for step, because every step there exists for a reported bug:
 *
 *   - capture the live grid size before anything is replaced;
 *   - a kill that answers `no pty:` is the state we wanted (the process already
 *     died — the crash case), not a failure;
 *   - a fresh start resets the pooled terminal; a resume replaces it only AFTER
 *     the new session was accepted, so a refused resume never leaves a blank
 *     xterm with the scrollback gone;
 *   - the model/provider/command are recorded even on a resume, or the next
 *     restore relaunches the old command.
 *
 * Plus a small zustand store of which agents are mid-restart and the last
 * error, so a card and a room showing the same agent agree.
 */
import { create } from 'zustand';
import { useStore, type Agent } from '@/store/store';
import { acquireTerminal, disposeTerminal, resetTerminal } from '@/components/terminalPool';
import {
  buildSpawnCommand,
  inferAgentProvider,
  providerPreset,
  tokenizeCommand,
  type AgentProvider
} from '@/store/config';
import { roleForHiveSpawn } from '@shared/agentRole';

export interface RestartOptions {
  /** Model to run; defaults to the agent's current one. */
  model?: string;
  /** Engine to run; defaults to the agent's current one. */
  provider?: AgentProvider;
  /** Continue the prior conversation (same engine only). */
  resume?: boolean;
  /** Resume if possible, else start fresh instead of failing. */
  resumeOptional?: boolean;
}

export interface RestartResult {
  ok: boolean;
  /** The conversation was continued. */
  resumed?: boolean;
  /** Either one of this unit's i18n keys (`wsAgents.restart.*`) or a message
   *  from main, verbatim. Show it with `restartErrorText`. */
  error?: string;
}

/** Translate a restart error: our own keys translate, main's messages are
 *  wrapped ("Restart failed: <message>"). */
export function restartErrorText(t: (key: string, opts?: Record<string, unknown>) => string, error: string): string {
  return error.startsWith('wsAgents.') ? t(error) : t('wsAgents.restart.failed', { error });
}

interface RestartState {
  restarting: Record<string, boolean>;
  errors: Record<string, string>;
}

export const useRestartState = create<RestartState>(() => ({ restarting: {}, errors: {} }));

/** Can this engine continue a conversation across a restart? */
export function canResume(agent: Pick<Agent, 'command' | 'provider'>): boolean {
  const provider = inferAgentProvider(agent.command, agent.provider);
  const preset = providerPreset(provider);
  return provider === 'claude' || !!preset.resumeFlag || !!preset.resumeSubcommand;
}

export async function restartAgentProcess(agentId: string, opts: RestartOptions = {}): Promise<RestartResult> {
  const a = useStore.getState().agents.find((x) => x.id === agentId);
  if (!a?.ptyId) return { ok: false, error: 'wsAgents.restart.noTerminal' };
  if (useRestartState.getState().restarting[agentId]) return { ok: false, error: 'wsAgents.restart.busy' };
  const ptyId = a.ptyId;
  useRestartState.setState((s) => ({
    restarting: { ...s.restarting, [agentId]: true },
    errors: { ...s.errors, [agentId]: '' }
  }));
  try {
    const cfg = await window.cth.getConfig();
    const previousProvider = inferAgentProvider(a.command, a.provider);
    const provider = opts.provider ?? previousProvider;
    const model = opts.model !== undefined ? opts.model : a.model;
    let resume = opts.resume === true && provider === previousProvider;
    if (opts.resume && !resume && !opts.resumeOptional) {
      throw new Error('wsAgents.restart.crossEngine');
    }
    let resumeSessionId: string | undefined;
    if (resume) {
      const giveUp = (reason: string): void => {
        if (!opts.resumeOptional) throw new Error(reason);
        resume = false;
        resumeSessionId = undefined;
      };
      const registry = await window.cth.hiveRegistry();
      resumeSessionId = registry.agents[a.id]?.sessionId;
      if (!resumeSessionId) giveUp('wsAgents.restart.noSession');
      else if (provider === 'claude' && !(await window.cth.resolveSessionCwd(resumeSessionId))) {
        giveUp('wsAgents.restart.noTranscript');
      }
    }

    const oldEntry = acquireTerminal(ptyId);
    let cols = oldEntry.term.cols || 100;
    let rows = oldEntry.term.rows || 30;
    try {
      oldEntry.fit.fit();
      cols = oldEntry.term.cols;
      rows = oldEntry.term.rows;
    } catch { /* host not sized yet */ }

    const killed = await window.cth.killPty(ptyId);
    if (!killed.ok && !/^no pty:/.test(killed.error ?? '')) {
      throw new Error(killed.error ?? 'wsAgents.restart.killFailed');
    }
    if (!resume) resetTerminal(ptyId);

    const command = buildSpawnCommand(cfg, model, provider);
    const [exe, ...args] = tokenizeCommand(command.trim());
    const res = await window.cth.spawnPty({
      id: ptyId,
      cwd: a.cwd,
      command: exe,
      args,
      provider,
      cols,
      rows,
      hive: {
        id: a.id,
        name: a.name,
        cwd: a.cwd,
        provider,
        isGod: a.isGod,
        isAssistant: a.isAssistant,
        role: roleForHiveSpawn(a)
      },
      resume,
      resumeSessionId,
      requireResume: resume
    });
    if (!res.ok) throw new Error(res.error ?? 'wsAgents.restart.spawnFailed');
    if (resume && res.resumed !== true) throw new Error('wsAgents.restart.resumeRefused');

    const { updateAgent } = useStore.getState();
    if (resume) {
      disposeTerminal(ptyId);
      acquireTerminal(ptyId);
      updateAgent(a.id, { terminalGeneration: (a.terminalGeneration ?? 0) + 1 });
    }
    updateAgent(a.id, {
      command: command.trim(),
      provider,
      model,
      status: 'idle',
      action: resume ? 'continuing…' : 'restarting…'
    });
    return { ok: true, resumed: resume };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    useRestartState.setState((s) => ({ errors: { ...s.errors, [agentId]: error } }));
    return { ok: false, error };
  } finally {
    useRestartState.setState((s) => {
      const { [agentId]: _done, ...rest } = s.restarting;
      void _done;
      return { restarting: rest };
    });
  }
}
