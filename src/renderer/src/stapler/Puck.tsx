/**
 * The Stapler puck window (stapler.html#puck): the creature, the ring that
 * opens on click, and the flow panels. Owned by the `stapler` unit.
 *
 * The window is one of three sizes (main resizes it; see
 * src/main/features/stapler/puckWindow.ts) and this component renders
 * whichever `layout` main settled on:
 *   puck  — the creature, with a recording dot, a timer and the tray count;
 *   ring  — the creature centred, eight actions around it;
 *   panel — compose (message + tray), meeting, To, settings.
 *
 * Clicks: on macOS and Windows the transparent parts of the window pass
 * clicks to the app underneath. Main makes the whole window click-through and
 * forwards mouse moves; every element marked `data-stapler-hit` turns that
 * off while the pointer is over it.
 *
 * Drag: past a 4 px threshold a press on the creature becomes a drag, which
 * MAIN performs (it follows the real cursor), so the drag follows the pointer
 * exactly; a press that never moved is a click.
 */
import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ORCHESTRATOR_TARGET,
  formatDuration,
  type StaplerCommand,
  type StaplerDraft,
  type StaplerLayout,
  type StaplerPanel,
  type StaplerTarget
} from '@shared/features/stapler';
import { useStaplerState } from '@/workspace/useStaplerState';
import { effectiveTarget, errorText, stapler, targetName, useDictateState, useFeatureRoster } from './bridge';
import { elapsedMs, isBusy, isCapturing } from './flow';
import { useRecorder } from './useRecorder';
import { PuckFace, type PuckMood } from './PuckFace';
import { Ring, RING_SIZE, type RingItem } from './Ring';
import { ComposePanel, type ComposeNotice } from './ComposePanel';
import { MeetingPanel } from './MeetingPanel';
import { PanelFrame } from './PanelFrame';
import { TargetList } from './TargetList';
import { StaplerSettings } from './StaplerSettings';
import { StaplerIcon } from './icons';
import './stapler.css';

/** The ring folds back this long after the pointer leaves its buttons. */
const RING_LINGER_MS = 1500;
/** "Sent" stays on the compose panel this long before it folds away. */
const SENT_LINGER_MS = 1600;

export function Puck() {
  const { t } = useTranslation();
  const state = useStaplerState();
  const roster = useFeatureRoster();
  const dictate = useDictateState();
  const [layout, setLayout] = useState<StaplerLayout>({ mode: 'puck', width: 80, height: 80 });
  const [draft, setDraft] = useState<StaplerDraft>({ attachments: [] });
  const [target, setTarget] = useState<StaplerTarget>(ORCHESTRATOR_TARGET);
  const [clickThrough, setClickThrough] = useState(true);
  const [notice, setNotice] = useState<ComposeNotice | null>(null);
  const [toReturn, setToReturn] = useState<'ring' | StaplerPanel>('ring');
  const [dictateLevel, setDictateLevel] = useState(0);
  const eff = effectiveTarget(target, roster);
  const toName = targetName(t, eff.target, roster);

  const message = useRecorder('message', {
    onSend: (text) => stapler().send({ target: eff.target, text })
  });
  const meeting = useRecorder('meeting');

  const go = useCallback(async (mode: StaplerLayout['mode'], panel?: StaplerPanel) => {
    try {
      setLayout(await stapler().setMode(mode, panel));
    } catch { /* main gone; the window is going too */ }
  }, []);

  // ── Commands from main (the shortcut, the library, a finished screenshot) ──
  const onCommand = useRef<(c: StaplerCommand) => void>(() => {});
  onCommand.current = (c) => {
    if (c.type === 'openPanel') void go('panel', c.panel);
    else if (c.type === 'collapse') void go('puck');
    else if (c.type === 'toggleMeeting') {
      if (isCapturing(meeting.flow)) meeting.stop();
      else if (!isBusy(meeting.flow) && !isCapturing(message.flow)) meeting.start();
    }
  };

  useEffect(() => {
    const api = stapler();
    const offCommand = api.onCommand((c) => onCommand.current(c));
    const offDraft = api.onDraft(setDraft);
    api.puckReady().then((boot) => {
      setLayout(boot.layout);
      setDraft(boot.draft);
      setTarget(boot.target);
      setClickThrough(boot.clickThrough);
      for (const c of boot.commands) onCommand.current(c);
    }, () => { /* main not ready */ });
    return () => { offCommand(); offDraft(); };
  }, []);

  useEffect(() => {
    const api = window.cth.features.dictate as Partial<typeof window.cth.features.dictate> | undefined;
    if (!api?.onLevel) return;
    return api.onLevel(setDictateLevel);
  }, []);

  // ── Click-through: opaque only over [data-stapler-hit] ──
  const ignoring = useRef(true);
  const ringTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    ignoring.current = true; // main resets it on every mode change
    const clearRingTimer = () => { if (ringTimer.current) { clearTimeout(ringTimer.current); ringTimer.current = null; } };
    const armRingTimer = () => {
      if (layout.mode !== 'ring' || ringTimer.current) return;
      ringTimer.current = setTimeout(() => { ringTimer.current = null; void go('puck'); }, RING_LINGER_MS);
    };
    const onMove = (e: MouseEvent) => {
      const hit = !!(e.target instanceof Element && e.target.closest('[data-stapler-hit]'));
      if (hit) clearRingTimer(); else armRingTimer();
      if (!clickThrough || layout.mode === 'panel') return;
      if (hit !== ignoring.current) return;
      ignoring.current = !hit;
      stapler().setIgnoreMouse(!hit);
    };
    const onLeave = () => armRingTimer();
    window.addEventListener('mousemove', onMove);
    document.documentElement.addEventListener('mouseleave', onLeave);
    return () => {
      clearRingTimer();
      window.removeEventListener('mousemove', onMove);
      document.documentElement.removeEventListener('mouseleave', onLeave);
    };
  }, [clickThrough, layout.mode, go]);

  // ── After a send, show "Sent" briefly, then fold away ──
  useEffect(() => {
    if (message.flow.phase !== 'done' || layout.mode !== 'panel' || layout.panel !== 'compose') return;
    const timer = setTimeout(() => { void go('puck'); }, SENT_LINGER_MS);
    return () => clearTimeout(timer);
  }, [message.flow.phase, layout.mode, layout.panel, go]);

  // ── Actions ──
  const takeShot = async () => {
    setNotice(null);
    const res = await stapler().screenshot().catch(() => ({ ok: false as const, error: 'capture-failed' as const, detail: undefined }));
    if (res.ok || res.error === 'busy') return; // the overlay is up
    if (res.error === 'permission') {
      setNotice({
        tone: 'warn',
        text: `${t('stapler.permission.body')} ${t('stapler.permission.relaunch')}`,
        action: { label: t('stapler.permission.open'), run: () => { void stapler().openScreenSettings(); } }
      });
    } else if (res.error === 'limit') {
      setNotice({ tone: 'warn', text: t('stapler.errors.limit') });
    } else {
      setNotice({ tone: 'danger', text: t('stapler.errors.captureFailed', { detail: res.detail ?? '' }) });
    }
    void go('panel', 'compose');
  };

  const pickTarget = async (next: StaplerTarget) => {
    setTarget(next);
    try { setTarget(await stapler().setTarget(next)); } catch { /* keep the local pick */ }
    if (toReturn === 'ring') void go('ring');
    else void go('panel', toReturn);
  };

  const openTo = (from: 'ring' | StaplerPanel) => {
    setToReturn(from);
    void go('panel', 'to');
  };

  const openLibrary = (id?: string) => {
    void stapler().openMeetingInApp(id);
    void go('puck');
  };

  const messageCapturing = isCapturing(message.flow);
  const meetingCapturing = isCapturing(meeting.flow);
  const dictating = dictate?.phase === 'recording' || dictate?.phase === 'starting';
  const dictateApi = window.cth.features.dictate as Partial<typeof window.cth.features.dictate> | undefined;

  const onFaceClick = () => {
    if (layout.mode === 'ring') { void go('puck'); return; }
    if (layout.mode === 'panel') { void go('puck'); return; }
    if (messageCapturing) { void go('panel', 'compose'); return; }
    void go('ring');
  };

  const mood: PuckMood = (() => {
    if (messageCapturing || meetingCapturing) return 'listening';
    if (dictating) return 'listening';
    if (message.flow.phase === 'error' || meeting.flow.phase === 'error') return 'error';
    if (isBusy(message.flow) || isBusy(meeting.flow) || dictate?.phase === 'transcribing' || dictate?.phase === 'inserting') return 'busy';
    if (message.flow.phase === 'done') return 'happy';
    return 'idle';
  })();
  const level = messageCapturing ? message.levels.mic : meetingCapturing ? Math.max(meeting.levels.mic, meeting.levels.system) : dictating ? dictateLevel : 0;

  // ── Drag vs click on the creature ──
  const press = useRef<{ x: number; y: number; dragging: boolean } | null>(null);
  const faceHandlers = {
    onPointerDown: (e: ReactPointerEvent<HTMLButtonElement>) => {
      if (e.button !== 0) return;
      press.current = { x: e.screenX, y: e.screenY, dragging: false };
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    onPointerMove: (e: ReactPointerEvent<HTMLButtonElement>) => {
      const p = press.current;
      if (!p || p.dragging || layout.mode !== 'puck') return;
      if (Math.abs(e.screenX - p.x) + Math.abs(e.screenY - p.y) > 4) {
        p.dragging = true;
        void stapler().dragStart();
      }
    },
    onPointerUp: () => {
      const p = press.current;
      press.current = null;
      if (!p) return;
      if (p.dragging) void stapler().dragEnd();
      else onFaceClick();
    },
    onLostPointerCapture: () => {
      const p = press.current;
      if (p?.dragging) { press.current = null; void stapler().dragEnd(); }
    },
    onKeyDown: (e: ReactKeyboardEvent<HTMLButtonElement>) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onFaceClick(); }
    }
  };

  const face = (left: number, top: number) => (
    <button
      type="button"
      data-stapler-hit=""
      className={`cth-stapler-face${state.hiddenFromCapture ? ' cth-stapler-face--hidden' : ''}`}
      style={{ left, top }}
      aria-label={layout.mode === 'ring' ? t('stapler.puck.close') : t('stapler.puck.open')}
      title={layout.mode === 'puck' ? t('stapler.puck.tip') : undefined}
      {...faceHandlers}
    >
      <PuckFace mood={mood} level={level} />
    </button>
  );

  // ── Render ──
  if (layout.mode === 'panel') {
    const close = () => { void go('puck'); };
    switch (layout.panel) {
      case 'meeting':
        return (
          <div className="cth-stapler-root">
            <MeetingPanel
              rec={meeting}
              accelerator={state.meetingShortcut?.accelerator ?? (window.cth.platform === 'darwin' ? 'Shift+Command+Space' : 'Ctrl+Shift+Space')}
              micBusy={messageCapturing}
              onOpenLibrary={openLibrary}
              onClose={close}
              mood={mood}
            />
          </div>
        );
      case 'to':
        return (
          <div className="cth-stapler-root">
            <PanelFrame
              title={t('stapler.to.title')}
              mood={mood}
              onClose={close}
              onBack={() => { if (toReturn === 'ring') void go('ring'); else void go('panel', toReturn); }}
            >
              <p className="cth-stapler-help">{t('stapler.to.help')}</p>
              <TargetList roster={roster} value={eff.target} onPick={(next) => { void pickTarget(next); }} autoFocus />
            </PanelFrame>
          </div>
        );
      case 'settings':
        return (
          <div className="cth-stapler-root">
            <PanelFrame title={t('stapler.settings.title')} mood={mood} onClose={close}>
              <StaplerSettings where="puck" />
            </PanelFrame>
          </div>
        );
      case 'compose':
      default:
        return (
          <div className="cth-stapler-root">
            <ComposePanel
              rec={message}
              draft={draft}
              toName={toName}
              targetGone={eff.gone}
              onOpenTo={() => openTo('compose')}
              onScreenshot={() => { void takeShot(); }}
              notice={notice}
              onDismissNotice={() => setNotice(null)}
              micBusy={meetingCapturing}
              onClose={close}
              mood={mood}
            />
          </div>
        );
    }
  }

  if (layout.mode === 'ring') {
    const items: RingItem[] = [
      {
        id: 'screenshot', icon: 'screenshot', label: t('stapler.ring.screenshot'),
        mark: draft.attachments.length ? String(draft.attachments.length) : undefined,
        onClick: () => { void takeShot(); }
      },
      {
        id: 'message', icon: messageCapturing ? 'stop' : 'message',
        label: messageCapturing ? t('stapler.ring.messageLive') : t('stapler.ring.message'),
        live: messageCapturing,
        disabled: meetingCapturing,
        onClick: () => {
          void go('panel', 'compose');
          if (!isBusy(message.flow) && !meetingCapturing) message.start();
        }
      },
      {
        id: 'meeting', icon: meetingCapturing ? 'stop' : 'meeting',
        label: meetingCapturing
          ? t('stapler.ring.meetingStop', { time: formatDuration(elapsedMs(meeting.flow, meeting.now)) })
          : t('stapler.ring.meeting'),
        live: meetingCapturing,
        disabled: messageCapturing,
        onClick: () => {
          if (meetingCapturing) { meeting.stop(); void go('panel', 'meeting'); return; }
          void go('panel', 'meeting');
          if (!isBusy(meeting.flow)) meeting.start();
        }
      },
      {
        id: 'dictate', icon: 'dictate',
        label: !dictateApi?.toggle ? t('stapler.ring.dictateUnavailable')
          : dictate && !dictate.enabled ? t('stapler.ring.dictateOff')
          : dictating ? t('stapler.ring.dictateLive') : t('stapler.ring.dictate'),
        pressed: dictating,
        disabled: !dictateApi?.toggle || messageCapturing || meetingCapturing,
        onClick: () => {
          if (dictate && !dictate.enabled) { void go('panel', 'settings'); return; }
          void dictateApi?.toggle?.();
          void go('puck');
        }
      },
      {
        id: 'to', icon: 'to', label: t('stapler.ring.to', { name: toName }),
        onClick: () => openTo('ring')
      },
      {
        id: 'settings', icon: 'settings', label: t('stapler.ring.settings'),
        onClick: () => { void go('panel', 'settings'); }
      },
      {
        id: 'computer', icon: 'computer', label: t('stapler.ring.computer'),
        disabled: true,
        onClick: () => {}
      },
      {
        id: 'invisible', icon: state.invisible ? 'visible' : 'invisible',
        label: !state.canHide ? t('stapler.ring.invisibleUnsupported')
          : state.invisible ? t('stapler.ring.visible') : t('stapler.ring.invisible'),
        pressed: state.invisible,
        disabled: !state.canHide,
        onClick: () => { void stapler().setInvisible(!state.invisible); }
      }
    ];
    return (
      <div className="cth-stapler-root">
        {face(RING_SIZE / 2 - 28, RING_SIZE / 2 - 28)}
        <Ring items={items} idleCaption={t('stapler.ring.caption', { name: toName })} />
      </div>
    );
  }

  // Resting puck.
  const recording = messageCapturing || meetingCapturing;
  const timerFlow = meetingCapturing ? meeting : messageCapturing ? message : null;
  return (
    <div className="cth-stapler-root">
      {face(12, 4)}
      {recording && <span className="cth-stapler-recdot" style={{ top: 4, left: 8 }} aria-hidden="true" />}
      {draft.attachments.length > 0 && !recording && (
        <span className="cth-stapler-badge" style={{ top: 2, insetInlineEnd: 6 }} aria-label={t('stapler.puck.pending', { count: draft.attachments.length })}>
          {draft.attachments.length}
        </span>
      )}
      {state.hiddenFromCapture && (
        <span className="cth-stapler-badge" style={{ top: 44, insetInlineEnd: 6, padding: 0, width: 16 }} title={t('stapler.puck.hidden')}>
          <StaplerIcon name="invisible" />
        </span>
      )}
      {timerFlow && timerFlow.flow.phase === 'recording' && (
        <div className="cth-stapler-timer">
          <span>{formatDuration(elapsedMs(timerFlow.flow, timerFlow.now))}</span>
        </div>
      )}
      {!recording && (isBusy(meeting.flow) || isBusy(message.flow)) && (
        <div className="cth-stapler-timer"><span>{t('stapler.puck.working')}</span></div>
      )}
      {!recording && (meeting.flow.phase === 'error' || message.flow.phase === 'error') && (
        <div className="cth-stapler-timer">
          <span>{errorText(t, 'short')}</span>
        </div>
      )}
    </div>
  );
}
