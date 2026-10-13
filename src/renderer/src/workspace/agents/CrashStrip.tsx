/**
 * The crash strip: an agent whose process died says so, with the exit the hive
 * recorded and a way back — instead of a terminal that silently stopped.
 *
 * Restart continues the conversation when the engine can (Claude, Codex, Grok,
 * Gemini resume their session) and starts fresh otherwise; a crashed agent's
 * worktree and uncommitted work stay where they are either way. The crash log
 * (the terminal's last output, kept by hive.recordAgentExit) opens in the file
 * manager — main resolves the path, the renderer never names one.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Agent } from '@/store/store';
import { Button } from '../ui';
import { useLastExit } from './hooks';
import { canResume, restartAgentProcess, restartErrorText, useRestartState } from './restartAgent';
import { formatWhen } from './format';

export function CrashStrip({ agent, compact }: { agent: Agent; compact?: boolean }) {
  const { t, i18n } = useTranslation();
  const exit = useLastExit(agent.id, true);
  const busy = useRestartState((s) => !!s.restarting[agent.id]);
  const error = useRestartState((s) => s.errors[agent.id] || '');
  const [logError, setLogError] = useState('');
  const resumable = canResume(agent);

  const detail = exit
    ? exit.signal
      ? t('wsAgents.crash.exitedSignal', { code: exit.exitCode ?? '?', signal: exit.signal, when: formatWhen(exit.ts, i18n.language) })
      : t('wsAgents.crash.exitedCode', { code: exit.exitCode ?? '?', when: formatWhen(exit.ts, i18n.language) })
    : t('wsAgents.crash.ended');

  return (
    <div className="cth-ws-agents-crash" role="alert" onClick={(e) => e.stopPropagation()}>
      <span className="cth-ws-agents-crash-text">
        <strong>{t('wsAgents.crash.title', { name: agent.name })}</strong>{' '}{detail}
        {!compact && <> {t('wsAgents.crash.workKept')}</>}
      </span>
      <Button
        size="sm"
        variant="primary"
        disabled={busy}
        title={resumable ? t('wsAgents.crash.restartContinueTip') : t('wsAgents.crash.restartTip')}
        onClick={() => { void restartAgentProcess(agent.id, { resume: resumable, resumeOptional: true }); }}
      >
        {busy ? t('wsAgents.crash.restarting') : resumable ? t('wsAgents.crash.restartContinue') : t('wsAgents.crash.restart')}
      </Button>
      {exit?.hasLog && (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setLogError('');
            void window.cth.features.agents.revealCrashLog(agent.id)
              .then((r) => { if (!r.ok) setLogError(r.error ?? ''); })
              .catch(() => setLogError(t('wsAgents.crash.logFailed')));
          }}
        >
          {t('wsAgents.crash.showLog')}
        </Button>
      )}
      {(error || logError) && (
        <span className="cth-ws-agents-crash-error">
          {error ? restartErrorText(t, error) : logError}
        </span>
      )}
    </div>
  );
}
