/**
 * Terminal — his live terminal, the same PtyTerminalView the Classic command
 * center docks (pooled xterm, recovery, fit, theme), wired the same way: the
 * stream feeds the avatar-state parser and a typed prompt lands in history.
 *
 * Only ONE live xterm may drive a pty at a time (two fight over its cols/rows
 * and corrupt the display), so while focus mode holds him this tab shows a
 * placeholder instead, exactly like the docked Classic panel.
 */
import { useTranslation } from 'react-i18next';
import { useStore, type Agent } from '@/store/store';
import { PtyTerminalView } from '@/components/PtyTerminalView';
import { terminalInstanceKey } from '@/components/terminalRecovery';
import { usePtyParser } from '@/hooks/usePtyParser';
import { Button, EmptyState } from '../ui';

export function TerminalTab({ god }: { god: Agent }) {
  const { t } = useTranslation();
  const updateAgent = useStore((s) => s.updateAgent);
  const setFullscreen = useStore((s) => s.setFullscreen);
  const fullscreenAgentId = useStore((s) => s.fullscreenAgentId);
  const onPtyStream = usePtyParser(god.id);

  if (fullscreenAgentId === god.id) {
    return (
      <EmptyState
        fill
        title={t('wsOrchestrator.terminal.inFocus')}
        body={t('wsOrchestrator.terminal.inFocusBody', { godName: god.name })}
        action={<Button onClick={() => setFullscreen(null)}>{t('wsOrchestrator.terminal.leaveFocus')}</Button>}
      />
    );
  }
  if (!god.ptyId) {
    return (
      <EmptyState
        fill
        title={t('wsOrchestrator.terminal.none', { godName: god.name })}
        body={t('wsOrchestrator.terminal.noneBody')}
      />
    );
  }
  return (
    <div className="cth-ws-orch-terminal">
      <PtyTerminalView
        key={terminalInstanceKey(god.ptyId, god.terminalGeneration)}
        ptyId={god.ptyId}
        onStreamData={onPtyStream}
        onUserPrompt={(text) => {
          updateAgent(god.id, { lastPrompt: text });
          if (text.trim().toLowerCase() === '/clear') {
            updateAgent(god.id, { contextTokens: 0, contextLimit: undefined, progress: 0 });
          }
          void window.cth.historyAdd({ agentId: god.id, cwd: god.cwd, text });
        }}
        onToggleFullscreen={() => setFullscreen(god.id)}
        embedded
      />
    </div>
  );
}
