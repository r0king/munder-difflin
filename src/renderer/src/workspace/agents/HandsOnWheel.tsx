/**
 * Hands on the wheel: pause its tools, stop it after this step, or hold a 1:1
 * so the orchestrator sends it nothing while you talk.
 *
 * The same three controls as the Classic AgentControlStrip / AgentHoldButton,
 * on the same IPC — control:pause / control:resume / control:halt (Claude
 * Code's hook-return protocol, no keystrokes) and hive:setAgentHold — drawn
 * with the Workspace primitives. The 1:1 is mirrored into the store only after
 * main confirms the write, exactly as AgentHoldButton does, so the button never
 * shows a hold the orchestrator never heard about.
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore, type Agent } from '@/store/store';
import { inferAgentProvider, isClaudeProvider } from '@/store/config';
import { Button, Chip } from '../ui';
import type { ControlSnapshot } from './hooks';

export function HandsOnWheel({ agent, godName, dead, snap, setSnap }: {
  agent: Agent;
  godName: string;
  dead: boolean;
  /** The room's control snapshot (useControlSnapshot), shared with the composer. */
  snap: ControlSnapshot | null;
  setSnap: (s: ControlSnapshot | null) => void;
}) {
  const { t } = useTranslation();
  const [note, setNote] = useState<{ text: string; error?: boolean } | null>(null);
  const [holdBusy, setHoldBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hooked = isClaudeProvider(inferAgentProvider(agent.command, agent.provider));
  const live = !!agent.ptyId && !dead;

  // The registry is the record and survives restarts; the store copy can be
  // stale on a fresh launch. Read it back once per agent (as AgentHoldButton).
  useEffect(() => {
    let alive = true;
    window.cth.hiveRegistry().then((reg) => {
      if (!alive) return;
      const onHold = !!(reg as { agents?: Record<string, { onHold?: boolean }> })?.agents?.[agent.id]?.onHold;
      if (onHold !== !!useStore.getState().agents.find((a) => a.id === agent.id)?.onHold) {
        useStore.getState().updateAgent(agent.id, { onHold });
      }
    }).catch(() => { /* no hive — harmless either way */ });
    return () => { alive = false; };
  }, [agent.id]);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const flash = (text: string, error = false): void => {
    setNote({ text, error });
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setNote(null), 3000);
  };

  const togglePause = async (): Promise<void> => {
    const pausing = !snap?.paused;
    try {
      const s = pausing ? await window.cth.controlPause(agent.id, true) : await window.cth.controlResume(agent.id);
      if (s) setSnap(s);
      flash(pausing ? t('wsAgents.wheel.pausedNote') : t('wsAgents.wheel.resumedNote'));
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e), true);
    }
  };

  const halt = async (): Promise<void> => {
    try {
      const s = await window.cth.controlHalt(agent.id);
      if (s) setSnap(s);
      flash(t('wsAgents.wheel.haltNote', { name: agent.name }));
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e), true);
    }
  };

  const toggleHold = (): void => {
    const next = !agent.onHold;
    setHoldBusy(true);
    void Promise.resolve()
      .then(() => window.cth.hiveSetAgentHold(agent.id, next))
      .then((r) => {
        if (r?.ok) {
          useStore.getState().updateAgent(agent.id, { onHold: next });
          flash(next ? t('wsAgents.wheel.holdOnNote', { god: godName, name: agent.name }) : t('wsAgents.wheel.holdOffNote', { god: godName }));
        } else {
          flash(r?.error ?? t('wsAgents.wheel.holdFailed'), true);
        }
      })
      .catch((e: unknown) => flash(e instanceof Error ? e.message : String(e), true))
      .finally(() => setHoldBusy(false));
  };

  return (
    <div className="cth-ws-agents-wheel" role="group" aria-label={t('wsAgents.wheel.aria', { name: agent.name })}>
      {/* Both ride the engine's hooks (control.ts). Claude Code honours them;
          other engines may not, so they stay usable and say so on hover. */}
      <span className="cth-tip cth-tip-wrap" data-tip={`${snap?.paused ? t('wsAgents.wheel.resumeTip') : t('wsAgents.wheel.pauseTip')}${hooked ? '' : ` ${t('wsAgents.wheel.noHooks')}`}`}>
        <Button
          size="sm"
          variant="secondary"
          className={snap?.paused ? 'cth-ws-agents-btn-on' : undefined}
          disabled={!live}
          onClick={() => { void togglePause(); }}
        >
          {snap?.paused ? t('wsAgents.wheel.resumeTools') : t('wsAgents.wheel.pauseTools')}
        </Button>
      </span>
      <span className="cth-tip cth-tip-wrap" data-tip={`${t('wsAgents.wheel.haltTip')}${hooked ? '' : ` ${t('wsAgents.wheel.noHooks')}`}`}>
        <Button size="sm" variant="secondary" disabled={!live || !!snap?.halted} onClick={() => { void halt(); }}>
          {t('wsAgents.wheel.stopAfterStep')}
        </Button>
      </span>
      {!agent.isGod && (
        <span className="cth-tip cth-tip-wrap" data-tip={agent.onHold
          ? t('wsAgents.wheel.holdOffTip', { god: godName, name: agent.name })
          : t('wsAgents.wheel.holdOnTip', { god: godName, name: agent.name })}
        >
          <Button
            size="sm"
            variant="secondary"
            className={agent.onHold ? 'cth-ws-agents-btn-on' : undefined}
            disabled={holdBusy}
            onClick={toggleHold}
          >
            {agent.onHold ? t('wsAgents.wheel.inOneOnOne') : t('wsAgents.wheel.oneOnOne')}
          </Button>
        </span>
      )}
      {snap?.halted && <Chip tone="danger">{t('wsAgents.wheel.halting')}</Chip>}
      {!!snap?.pendingSteers && <Chip tone="accent">{t('wsAgents.wheel.steersWaiting', { count: snap.pendingSteers })}</Chip>}
      {snap?.autoDeliveryPaused && <Chip tone="warn" title={t('wsAgents.wheel.deliveriesPausedTip')}>{t('wsAgents.wheel.deliveriesPaused')}</Chip>}
      {note && <span className="cth-ws-agents-wheel-note" data-tone={note.error ? 'error' : undefined} role="status">{note.text}</span>}
    </div>
  );
}
