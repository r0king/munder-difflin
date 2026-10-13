/**
 * The right-click menu on an agent row: the common jobs, each one an action
 * the app already has —
 *
 *   Open room / the orchestrator   useWorkspace().navigate
 *   Open terminal in focus mode    store.setFullscreen (App renders focus mode
 *                                  in both interfaces)
 *   Open in IDE                    store.setIdeOpen(true, id)
 *   Restart & Continue / Restart   the Agents unit's restartAgentProcess (the
 *                                  command center's restart, step for step)
 *   Stop                           what the detail panel's kill does: killPty,
 *                                  dispose the pooled xterm, archive the agent
 *
 * Restart (fresh) and Stop throw work away, so each takes a second click —
 * the item turns into its own confirmation instead of a modal over the sidebar.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore, type Agent } from '@/store/store';
import { disposeTerminal } from '@/components/terminalPool';
import { useWorkspace } from '../store';
import { canResume, restartAgentProcess, useRestartState } from '../agents/restartAgent';
import { MenuList, Popover, type MenuEntry, type PopoverAnchor } from './Popover';

interface AgentMenuProps {
  agent: Agent;
  anchor: PopoverAnchor;
  onClose: () => void;
}

export function AgentMenu({ agent, anchor, onClose }: AgentMenuProps) {
  const { t, i18n } = useTranslation();
  const navigate = useWorkspace((s) => s.navigate);
  const setFullscreen = useStore((s) => s.setFullscreen);
  const setIdeOpen = useStore((s) => s.setIdeOpen);
  const archiveAgent = useStore((s) => s.archiveAgent);
  const restarting = useRestartState((s) => !!s.restarting[agent.id]);
  const [confirm, setConfirm] = useState<'stop' | 'restart' | null>(null);
  const [note, setNote] = useState<{ text: string; error?: boolean } | null>(null);

  const live = !!agent.ptyId;
  const name = agent.name;

  const errorText = (error: string): string =>
    // The Agents unit's own codes translate when its strings are present;
    // anything else (main's message) is shown verbatim inside ours.
    error.startsWith('wsAgents.') && i18n.exists(error)
      ? t(error)
      : t('wsSidebar.menu.restartFailed', { error: error.startsWith('wsAgents.') ? error.split('.').pop() : error });

  const restart = async (resume: boolean): Promise<void> => {
    setNote({ text: resume ? t('wsSidebar.menu.continuing', { name }) : t('wsSidebar.menu.restarting', { name }) });
    const res = await restartAgentProcess(agent.id, resume ? { resume: true } : {});
    if (res.ok) onClose();
    else setNote({ text: errorText(res.error ?? ''), error: true });
  };

  const stop = async (): Promise<void> => {
    if (!agent.ptyId) return;
    const ptyId = agent.ptyId;
    try {
      const res = await window.cth.killPty(ptyId);
      // An already-dead PTY is the state Stop wants.
      if (!res.ok && !/^no pty:/.test(res.error ?? '')) {
        setNote({ text: t('wsSidebar.menu.stopFailed', { error: res.error ?? '' }), error: true });
        return;
      }
      disposeTerminal(ptyId);
      archiveAgent(agent.id);
      onClose();
    } catch (e) {
      setNote({ text: t('wsSidebar.menu.stopFailed', { error: e instanceof Error ? e.message : String(e) }), error: true });
    }
  };

  const entries: MenuEntry[] = [
    { key: 'head', header: name },
    agent.isGod
      ? { key: 'open', label: t('wsSidebar.menu.openOrchestrator'), onSelect: () => navigate({ kind: 'orchestrator' }) }
      : { key: 'open', label: t('wsSidebar.menu.openRoom'), onSelect: () => navigate({ kind: 'agent', agentId: agent.id }) },
    {
      key: 'focus',
      label: t('wsSidebar.menu.focusTerminal'),
      disabled: !live,
      title: live ? undefined : t('wsSidebar.menu.noTerminal'),
      onSelect: () => setFullscreen(agent.id)
    },
    {
      key: 'ide',
      label: t('wsSidebar.menu.openIde'),
      onSelect: () => setIdeOpen(true, agent.id)
    },
    { key: 'sep1', separator: true }
  ];
  if (canResume(agent)) {
    entries.push({
      key: 'continue',
      label: t('wsSidebar.menu.restartContinue'),
      disabled: !live || restarting,
      title: t('wsSidebar.menu.restartContinueTip'),
      keepOpen: true,
      onSelect: () => { void restart(true); }
    });
  }
  entries.push({
    key: 'restart',
    label: confirm === 'restart' ? t('wsSidebar.menu.restartConfirm', { name }) : t('wsSidebar.menu.restart'),
    disabled: !live || restarting,
    title: t('wsSidebar.menu.restartTip'),
    keepOpen: true,
    onSelect: () => {
      if (confirm !== 'restart') { setConfirm('restart'); return; }
      setConfirm(null);
      void restart(false);
    }
  });
  if (!agent.isGod) {
    // The orchestrator is respawned by the app whenever his terminal goes;
    // "Stop" on him would be a restart in disguise, so it is not offered.
    entries.push({
      key: 'stop',
      label: confirm === 'stop' ? t('wsSidebar.menu.stopConfirm', { name }) : t('wsSidebar.menu.stop'),
      danger: true,
      disabled: !live || restarting,
      keepOpen: true,
      onSelect: () => {
        if (confirm !== 'stop') { setConfirm('stop'); return; }
        void stop();
      }
    });
  }
  if (note) entries.push({ key: 'note', note: note.text, error: note.error });

  return (
    <Popover anchor={anchor} onClose={onClose} role="menu" ariaLabel={t('wsSidebar.menu.label', { name })} autoFocus>
      <MenuList entries={entries} onClose={onClose} />
    </Popover>
  );
}
