/**
 * An agent's room: the conversation on one side, its live terminal on the
 * other. Send or steer; pause tools, stop after this step, 1:1; drop in files
 * and screenshots or hold ⌥ and speak; change its engine, model, role or token
 * cap. Owned by the `wsAgents` unit.
 *
 * The terminal is the agent's real PTY through the shared terminal pool — the
 * same xterm (scrollback and all) Classic shows, re-parented here — and the
 * PTY stream feeds the same parser Classic's panel does, so status stays live
 * whichever interface is open. The split is resizable (drag, arrow keys,
 * double-click resets) and remembered.
 *
 * Workspace.tsx renders this only for an agent on the roster that is not god
 * (god's room is the orchestrator screen).
 */
import { type KeyboardEvent as ReactKeyboardEvent, useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '@/store/store';
import { PtyTerminalView } from '@/components/PtyTerminalView';
import { terminalInstanceKey } from '@/components/terminalRecovery';
import { acquireTerminal } from '@/components/terminalPool';
import { usePtyParser } from '@/hooks/usePtyParser';
import { useResolvedGodName } from '@/hooks/useResolvedGodName';
import { useFleetTelemetry } from '@/hooks/useTelemetry';
import { useRtl } from '@/i18n/useDirection';
import { contextPercent, formatUsd, pickCurrentTicket } from '@shared/workspace/agentsSummary';
import { agentLiveLine, deriveAgentStatus, liveLineText } from '../agentStatus';
import { Button, Chip, EmptyState, IconButton, KeyHint, Screen, ScreenHeader, StatusBadge, WsIcon } from '../ui';
import { loadWsPref, saveWsPref, useWorkspace } from '../store';
import { useAskedYou, useHiveTasks } from '../useHiveTasks';
import type { WorkspaceScreenProps } from '../types';
import { Conversation } from '../agents/Conversation';
import { CrashStrip } from '../agents/CrashStrip';
import { HandsOnWheel } from '../agents/HandsOnWheel';
import { RoomComposer } from '../agents/RoomComposer';
import { AgentSettingsDrawer } from '../agents/AgentSettingsDrawer';
import { useConversation } from '../agents/useConversation';
import { useControlSnapshot, useExitedPtys } from '../agents/hooks';
import { engineModelLabel } from '../agents/format';
import '../agents/agents.css';

export interface AgentRoomProps extends WorkspaceScreenProps {
  agentId: string;
}

const SPLIT_KEY = 'agents.roomSplit';
const SPLIT_DEFAULT = 0.46;
/** Neither pane gets narrower than this while dragging. */
const MIN_PANE_PX = 300;
const isRatio = (v: unknown): v is number => typeof v === 'number' && v >= 0.15 && v <= 0.85;

export function AgentRoom({ agentId, config }: AgentRoomProps) {
  const { t, i18n } = useTranslation();
  const rtl = useRtl();
  const agent = useStore((s) => s.agents.find((a) => a.id === agentId));
  const godAgentName = useStore((s) => s.agents.find((a) => a.isGod)?.name);
  const resolvedGod = useResolvedGodName();
  const godName = godAgentName ?? resolvedGod;
  const fullscreenId = useStore((s) => s.fullscreenAgentId);
  const setFullscreen = useStore((s) => s.setFullscreen);
  const setIdeOpen = useStore((s) => s.setIdeOpen);
  const updateAgent = useStore((s) => s.updateAgent);
  const navigate = useWorkspace((s) => s.navigate);
  const askedYou = useAskedYou();
  const { tasks } = useHiveTasks();
  const { samples } = useFleetTelemetry();
  const conversation = useConversation(agentId);
  const [snap, setSnap] = useControlSnapshot(agentId);
  const onPtyStream = usePtyParser(agentId);
  const dead = useExitedPtys([agent?.ptyId]);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const room = useRef<HTMLDivElement | null>(null);
  const [ratio, setRatio] = useState<number>(() => loadWsPref<number>(SPLIT_KEY, SPLIT_DEFAULT, isRatio));
  const [dragging, setDragging] = useState(false);

  const clampRatio = useCallback((r: number): number => {
    const width = room.current?.clientWidth ?? 0;
    const minR = width > 0 ? Math.min(0.5, MIN_PANE_PX / width) : 0.2;
    return Math.min(1 - minR, Math.max(minR, r));
  }, []);
  const commitRatio = (r: number): void => {
    const next = clampRatio(r);
    setRatio(next);
    saveWsPref(SPLIT_KEY, Math.round(next * 1000) / 1000);
  };
  const ratioAt = (clientX: number): number => {
    const rect = room.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return ratio;
    // The conversation sits on the inline-start side: left in English, right
    // in Arabic, so the same drag means the opposite thing there.
    return rtl ? (rect.right - clientX) / rect.width : (clientX - rect.left) / rect.width;
  };

  const ticket = useMemo(() => pickCurrentTicket(tasks, agentId), [tasks, agentId]);

  if (!agent) {
    return (
      <Screen header={<ScreenHeader title={agentId} />}>
        <EmptyState title={t('ws.shell.agentGone')} body={t('ws.shell.agentGoneBody')} />
      </Screen>
    );
  }

  const isDead = !!agent.ptyId && dead.has(agent.ptyId);
  const input = {
    status: agent.status, action: agent.action, ptyId: agent.ptyId, archived: agent.archived,
    isGod: agent.isGod, hasOpenQuestion: askedYou.has(agent.id)
  };
  const status = isDead ? 'offline' as const : deriveAgentStatus(input);
  const live = isDead ? t('wsAgents.card.processEnded') : liveLineText(t, agentLiveLine(input));
  const { engine, model } = engineModelLabel(t, agent);
  const pct = contextPercent(agent.contextTokens, agent.contextLimit);
  const spend = formatUsd(samples[agent.id]?.usd, i18n.language);
  const inFocusMode = fullscreenId === agent.id;

  const focusTerminal = (): void => {
    if (!agent.ptyId) return;
    if (ratio > 0.7) commitRatio(SPLIT_DEFAULT);
    try { acquireTerminal(agent.ptyId).term.focus(); } catch { /* not attached yet */ }
  };

  const onSplitKey = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    const step = 0.03;
    const towardEnd = rtl ? 'ArrowLeft' : 'ArrowRight';
    const towardStart = rtl ? 'ArrowRight' : 'ArrowLeft';
    if (e.key === towardEnd) { e.preventDefault(); commitRatio(ratio + step); }
    else if (e.key === towardStart) { e.preventDefault(); commitRatio(ratio - step); }
    else if (e.key === 'Home') { e.preventDefault(); commitRatio(0); }
    else if (e.key === 'End') { e.preventDefault(); commitRatio(1); }
  };

  return (
    <Screen
      fill
      header={
        <ScreenHeader
          leading={
            <IconButton label={t('wsAgents.room.back')} onClick={() => navigate({ kind: 'agents' })}>
              <WsIcon name={rtl ? 'chevron-right' : 'chevron-left'} />
            </IconButton>
          }
          title={agent.name}
          subtitle={live}
          actions={
            <>
              <StatusBadge status={status} />
              <IconButton label={t('wsAgents.room.settings')} active={settingsOpen} onClick={() => setSettingsOpen((o) => !o)}>
                <WsIcon name="settings" />
              </IconButton>
              <Button variant="secondary" size="sm" onClick={() => setIdeOpen(true, agent.id)} title={t('wsAgents.room.ideTip')}>
                {t('wsAgents.room.openIde')} <KeyHint combo="Mod+I" />
              </Button>
              <Button variant="secondary" size="sm" disabled={!agent.ptyId || inFocusMode} onClick={focusTerminal} title={t('wsAgents.room.focusTip')}>
                {t('wsAgents.room.focusTerminal')}
              </Button>
            </>
          }
        >
          <div className="cth-ws-agents-room-meta">
            <span className="cth-ws-ellipsis" title={`${engine} · ${model}`}>{engine} · {model}</span>
            {ticket && (
              <span className="cth-ws-ellipsis" title={`${ticket.id} · ${ticket.title}`}>
                <span className="cth-ws-agents-ticket-key">{ticket.id}</span> {ticket.title}
              </span>
            )}
            <span title={pct === null ? t('wsAgents.card.contextUnknown') : undefined}>
              {t('wsAgents.card.context')} <span className="cth-ws-agents-num">{pct === null ? '—' : `${pct}%`}</span>
            </span>
            <span title={t('wsAgents.card.spendTip')}>
              {t('wsAgents.room.spend')} <span className="cth-ws-agents-num">{spend ?? '—'}</span>
            </span>
            {agent.onHold && <Chip tone="accent">{t('wsAgents.wheel.inOneOnOne')}</Chip>}
            {agent.worktreePath && <span className="cth-ws-ellipsis" title={agent.worktreePath}>{t('wsAgents.room.worktree')}</span>}
          </div>
        </ScreenHeader>
      }
    >
      <div className="cth-ws-agents-room" ref={room}>
        <section
          className="cth-ws-agents-pane cth-ws-agents-pane--talk"
          style={{ flex: `0 0 ${(ratio * 100).toFixed(2)}%` }}
          aria-label={t('wsAgents.room.talkAria', { name: agent.name })}
        >
          <Conversation agent={agent} state={conversation} godName={godName} />
          <HandsOnWheel agent={agent} godName={godName} dead={isDead} snap={snap} setSnap={setSnap} />
          <RoomComposer agent={agent} deliveryPaused={!!snap?.autoDeliveryPaused} onSent={conversation.refresh} />
        </section>

        <div
          className="cth-ws-agents-splitter"
          role="separator"
          aria-orientation="vertical"
          aria-label={t('wsAgents.room.splitAria')}
          aria-valuemin={15}
          aria-valuemax={85}
          aria-valuenow={Math.round(ratio * 100)}
          tabIndex={0}
          title={t('wsAgents.room.splitAria')}
          data-active={dragging ? 'true' : undefined}
          onKeyDown={onSplitKey}
          onDoubleClick={() => commitRatio(SPLIT_DEFAULT)}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            e.currentTarget.setPointerCapture(e.pointerId);
            setDragging(true);
          }}
          onPointerMove={(e) => { if (dragging) setRatio(clampRatio(ratioAt(e.clientX))); }}
          onPointerUp={(e) => {
            if (!dragging) return;
            setDragging(false);
            commitRatio(ratioAt(e.clientX));
            try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* released */ }
          }}
          onPointerCancel={() => setDragging(false)}
        />

        <section className="cth-ws-agents-pane cth-ws-agents-pane--term" aria-label={t('wsAgents.room.terminalAria', { name: agent.name })}>
          {isDead && <CrashStrip agent={agent} />}
          {!agent.ptyId ? (
            <div className="cth-ws-agents-term-empty">
              <EmptyState fill title={t('wsAgents.room.noTerminal')} body={t('wsAgents.room.noTerminalBody', { name: agent.name })} />
            </div>
          ) : inFocusMode ? (
            <div className="cth-ws-agents-term-empty">
              <EmptyState
                fill
                title={t('wsAgents.room.inFocusMode')}
                body={t('wsAgents.room.inFocusModeBody', { name: agent.name })}
                action={<Button onClick={() => setFullscreen(null)}>{t('wsAgents.room.bringBack')}</Button>}
              />
            </div>
          ) : (
            <div className="cth-ws-agents-term-host" dir="ltr">
              <PtyTerminalView
                key={terminalInstanceKey(agent.ptyId, agent.terminalGeneration)}
                ptyId={agent.ptyId}
                onStreamData={onPtyStream}
                onUserPrompt={(text) => {
                  // Same bookkeeping as Classic's terminal tab.
                  updateAgent(agent.id, { lastPrompt: text });
                  if (text.trim().toLowerCase() === '/clear') {
                    updateAgent(agent.id, { contextTokens: 0, contextLimit: undefined, progress: 0 });
                  }
                  void window.cth.historyAdd({ agentId: agent.id, cwd: agent.cwd, text });
                }}
                onToggleFullscreen={() => setFullscreen(agent.id)}
                fullscreen={false}
                embedded
              />
            </div>
          )}
        </section>

        {settingsOpen && <AgentSettingsDrawer agent={agent} config={config} onClose={() => setSettingsOpen(false)} />}
      </div>
    </Screen>
  );
}
