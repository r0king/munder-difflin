/**
 * Dictation settings, owned by the `dictate` unit. Self-contained (no store,
 * no props): the Stapler embeds it in its settings panel, and it works the
 * same in an app window.
 *
 * Every control saves at once through `features.dictate.setSettings`; main
 * validates, persists, re-registers the shortcut, and the pushed state says
 * whether the registration took — so a shortcut another app holds shows up
 * here as "in use", not as a silent no-op.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  acceleratorFromKeyEvent,
  acceleratorKeys,
  defaultDictateConfig,
  formatAccelerator,
  toDictatePlatform,
  validateAccelerator,
  type AcceleratorError,
  type DictateConfig,
  type DictatePasteMode,
  type DictatePlatform,
  type DictatePlatformStatus,
  type DictateShortcutStatus,
  type DictateState
} from '@shared/features/dictate';
import { Button, Chip, Section, SegmentedControl, Spinner, Toggle, type ChipTone } from '../../workspace/ui';
import { useDictateState } from './useDictateState';
import { useDictationInsert } from './useDictationInsert';
import './dictate.css';

const SAFETY_STOPS = [60, 120, 300, 600];

function Keys({ accelerator, platform }: { accelerator: string; platform: DictatePlatform }) {
  const keys = acceleratorKeys(accelerator, platform);
  if (!keys.length) return <span className="cth-stapler-dictate-code">{accelerator}</span>;
  return (
    // A chord reads left to right in every language (Ctrl, then Alt, then Space).
    <span className="cth-ws-keys" dir="ltr" aria-label={keys.join(' ')}>
      {keys.map((k, i) => <kbd key={i} className="cth-ws-key">{k}</kbd>)}
    </span>
  );
}

function Row({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="cth-stapler-dictate-row">
      <span className="cth-stapler-dictate-label">{label}</span>
      {children}
    </div>
  );
}

/** "Press the new shortcut" field. Escape leaves it (unless Escape is what
 *  is being recorded, for the cancel key). */
function ShortcutRecorder({ platform, role, onPick, onCancel }: {
  platform: DictatePlatform;
  role: 'toggle' | 'cancel';
  onPick: (accelerator: string) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    ref.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault();
      e.stopPropagation();
      const bare = !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey;
      if (e.code === 'Escape' && bare && role === 'toggle') { onCancel(); return; }
      const acc = acceleratorFromKeyEvent(e, platform);
      if (acc) onPick(acc);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [platform, role, onPick, onCancel]);
  return (
    <button ref={ref} type="button" className="cth-stapler-dictate-record" aria-pressed="true" onBlur={onCancel}>
      {t('dictate.settings.pressKeys')}
    </button>
  );
}

function shortcutChip(t: (k: string) => string, s: DictateShortcutStatus, enabled: boolean, focusedOnly: boolean): { tone: ChipTone; text: string } | null {
  if (!enabled) return null;
  if (s.registered) return focusedOnly
    ? { tone: 'warn', text: t('dictate.settings.shortcutFocusedOnly') }
    : { tone: 'ok', text: t('dictate.settings.shortcutOn') };
  // Wayland: a failed grab is the display server's rule, not another app.
  if (focusedOnly || s.error === 'unavailable') return { tone: 'danger', text: t('dictate.settings.shortcutUnavailable') };
  if (s.error === 'taken') return { tone: 'danger', text: t('dictate.settings.shortcutTaken') };
  return { tone: 'danger', text: t('dictate.settings.shortcutInvalid') };
}

function phaseTone(state: DictateState): ChipTone {
  switch (state.phase) {
    case 'recording': return 'danger';
    case 'starting': case 'transcribing': case 'inserting': return 'info';
    case 'error': return 'warn';
    default: return 'neutral';
  }
}

function useElapsed(since: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (since === null) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [since]);
  return since === null ? 0 : Math.max(0, Math.floor((now - since) / 1000));
}

export function DictateSettings() {
  const { t } = useTranslation();
  useDictationInsert(); // the "try it" box below is in this window
  const state = useDictateState();
  const platform = toDictatePlatform(window.cth?.platform);
  const [config, setConfig] = useState<DictateConfig | null>(null);
  const [status, setStatus] = useState<DictatePlatformStatus | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [fieldError, setFieldError] = useState<{ field: keyof DictateConfig; error: AcceleratorError | 'invalid' } | null>(null);
  const [recording, setRecording] = useState<'toggle' | 'cancel' | null>(null);
  const [copied, setCopied] = useState(false);
  const elapsed = useElapsed(state.phase === 'recording' ? state.startedAt : null);
  const api = window.cth.features.dictate;

  const refreshStatus = useCallback(() => {
    api.getStatus().then(setStatus, () => { /* keep the last one */ });
  }, [api]);

  useEffect(() => {
    let alive = true;
    Promise.all([api.getSettings(), api.getStatus()]).then(
      ([c, s]) => { if (alive) { setConfig(c); setStatus(s); } },
      () => { if (alive) setLoadFailed(true); }
    );
    // A permission granted in System Settings shows up when the user comes back.
    const onFocus = (): void => refreshStatus();
    window.addEventListener('focus', onFocus);
    return () => { alive = false; window.removeEventListener('focus', onFocus); };
  }, [api, refreshStatus]);

  // Another window (the Stapler's panel, the meetings screen) may change the
  // settings; the pushed state says when the shortcut or the switch moved.
  useEffect(() => {
    api.getSettings().then(setConfig, () => { /* keep what we have */ });
  }, [api, state.enabled, state.shortcut.accelerator, state.cancelShortcut.accelerator]);
  useEffect(() => { setCopied(false); }, [state.last?.at]);

  const save = useCallback(async (patch: Partial<DictateConfig>) => {
    try {
      const r = await api.setSettings(patch);
      setConfig(r.config);
      setFieldError(r.ok ? null : { field: r.field, error: r.error });
      if (r.ok && 'pasteMode' in patch) refreshStatus();
    } catch {
      setFieldError({ field: Object.keys(patch)[0] as keyof DictateConfig, error: 'invalid' });
    }
  }, [api, refreshStatus]);

  const pick = useCallback((role: 'toggle' | 'cancel', accelerator: string) => {
    if (!config) return;
    const other = role === 'toggle' ? config.cancelAccelerator : config.accelerator;
    const check = validateAccelerator(accelerator, platform, role, other);
    const field = role === 'toggle' ? 'accelerator' : 'cancelAccelerator';
    // Show a bad chord at once; keep listening so the user can try another.
    if (!check.ok) { setFieldError({ field, error: check.error }); return; }
    setRecording(null);
    void save({ [field]: check.accelerator });
  }, [config, platform, save]);
  const pickToggle = useCallback((a: string) => pick('toggle', a), [pick]);
  const pickCancel = useCallback((a: string) => pick('cancel', a), [pick]);
  const stopRecording = useCallback(() => setRecording(null), []);

  if (loadFailed) {
    return <div className="cth-stapler-dictate"><p className="cth-stapler-dictate-error">{t('dictate.settings.loadFailed')}</p></div>;
  }
  if (!config || !status) {
    return <div className="cth-stapler-dictate"><Spinner label={t('dictate.settings.loading')} /></div>;
  }

  const defaults = defaultDictateConfig(platform);
  const shortcut = formatAccelerator(config.accelerator, platform);
  const cancelKey = formatAccelerator(config.cancelAccelerator, platform);
  const chip = shortcutChip(t, state.shortcut, config.enabled, status.globalShortcuts === 'focused-only');
  const errorFor = (field: keyof DictateConfig): ReactNode =>
    fieldError && fieldError.field === field
      ? <p className="cth-stapler-dictate-error" role="alert">{t(`dictate.accelError.${fieldError.error}`)}</p>
      : null;
  const stops = SAFETY_STOPS.includes(config.maxSeconds) ? SAFETY_STOPS : [...SAFETY_STOPS, config.maxSeconds].sort((a, b) => a - b);
  const pasteOptions: Array<{ value: DictatePasteMode; label: string }> = [
    { value: 'paste', label: t('dictate.settings.pasteTypeIt') },
    { value: 'clipboard', label: t('dictate.settings.pasteClipboard') }
  ];

  return (
    <div className="cth-stapler-dictate">
      <Section
        title={t('dictate.settings.title')}
        actions={<Toggle checked={config.enabled} onChange={(on) => void save({ enabled: on })} ariaLabel={t('dictate.settings.enable')} />}
      >
        <div className="cth-stapler-dictate-rows">
          <p>{t('dictate.settings.intro', { shortcut })}</p>
          <p className="cth-stapler-dictate-note">
            {t(platform === 'darwin' ? 'dictate.settings.holdNoteMac' : 'dictate.settings.holdNote', { cancel: cancelKey })}
          </p>
          <div className="cth-stapler-dictate-row" aria-live="polite">
            <Chip tone={phaseTone(state)}>
              {state.phase === 'recording'
                ? t('dictate.phase.recordingFor', { seconds: String(elapsed) })
                : state.phase === 'idle' && !config.enabled
                  ? t('dictate.phase.off')
                  : t(`dictate.phase.${state.phase}`)}
            </Chip>
            {state.phase === 'error' && state.error && (
              <span className="cth-stapler-dictate-error">{t(`dictate.error.${state.error.code}`, { detail: state.error.detail ?? '' })}</span>
            )}
            <span className="cth-stapler-dictate-grow" />
            {(state.phase === 'starting' || state.phase === 'recording' || state.phase === 'transcribing') && (
              <Button size="sm" variant="ghost" onClick={() => void api.cancel()}>{t('dictate.settings.cancelNow')}</Button>
            )}
          </div>
        </div>
      </Section>

      <Section title={t('dictate.settings.shortcutSection')}>
        <div className="cth-stapler-dictate-rows">
          <Row label={t('dictate.settings.startStop')}>
            {recording === 'toggle'
              ? <ShortcutRecorder platform={platform} role="toggle" onPick={pickToggle} onCancel={stopRecording} />
              : <Keys accelerator={config.accelerator} platform={platform} />}
            {chip && <Chip tone={chip.tone}>{chip.text}</Chip>}
            <span className="cth-stapler-dictate-grow" />
            <Button size="sm" onClick={() => { setFieldError(null); setRecording('toggle'); }}>{t('dictate.settings.change')}</Button>
            {config.accelerator !== defaults.accelerator && (
              <Button size="sm" variant="ghost" onClick={() => void save({ accelerator: defaults.accelerator })}>{t('dictate.settings.useDefault')}</Button>
            )}
          </Row>
          {errorFor('accelerator')}
          <Row label={t('dictate.settings.cancelKey')}>
            {recording === 'cancel'
              ? <ShortcutRecorder platform={platform} role="cancel" onPick={pickCancel} onCancel={stopRecording} />
              : <Keys accelerator={config.cancelAccelerator} platform={platform} />}
            {state.cancelShortcut.error === 'taken' && <Chip tone="warn">{t('dictate.settings.shortcutTaken')}</Chip>}
            <span className="cth-stapler-dictate-grow" />
            <Button size="sm" onClick={() => { setFieldError(null); setRecording('cancel'); }}>{t('dictate.settings.change')}</Button>
            {config.cancelAccelerator !== defaults.cancelAccelerator && (
              <Button size="sm" variant="ghost" onClick={() => void save({ cancelAccelerator: defaults.cancelAccelerator })}>{t('dictate.settings.useDefault')}</Button>
            )}
          </Row>
          {errorFor('cancelAccelerator')}
          <p className="cth-stapler-dictate-note">{t('dictate.settings.cancelNote')}</p>
          {state.shortcut.error === 'taken' && config.enabled && (
            <p className="cth-stapler-dictate-note">{t('dictate.settings.takenHelp')}</p>
          )}
          {status.globalShortcuts === 'focused-only' && (
            <p className="cth-stapler-dictate-note">{t('dictate.settings.waylandShortcut')}</p>
          )}
        </div>
      </Section>

      <Section title={t('dictate.settings.otherApps')}>
        <div className="cth-stapler-dictate-rows">
          <Row label={t('dictate.settings.pasteLabel')}>
            <SegmentedControl
              size="sm"
              options={pasteOptions}
              value={config.pasteMode}
              onChange={(v) => void save({ pasteMode: v })}
              ariaLabel={t('dictate.settings.pasteLabel')}
            />
          </Row>
          <Row label={t('dictate.settings.restoreLabel')}>
            <Toggle
              checked={config.restoreClipboard}
              disabled={config.pasteMode === 'clipboard'}
              onChange={(on) => void save({ restoreClipboard: on })}
              ariaLabel={t('dictate.settings.restoreLabel')}
            />
          </Row>
          <p className="cth-stapler-dictate-note">{t('dictate.settings.restoreNote')}</p>
          <p>{t(`dictate.strategy.${status.strategy}`)}</p>
          {status.notice && status.notice !== 'user-choice' && (
            <p className="cth-stapler-dictate-note">{t(`dictate.notice.${status.notice}`)}</p>
          )}
          <p className="cth-stapler-dictate-note">{t('dictate.settings.inAppNote')}</p>
        </div>
      </Section>

      <Section title={t('dictate.settings.safetyStop')}>
        <div className="cth-stapler-dictate-rows">
          <SegmentedControl
            size="sm"
            options={stops.map((s) => ({ value: String(s), label: t('dictate.settings.minutes', { n: String(Math.round((s / 60) * 10) / 10) }) }))}
            value={String(config.maxSeconds)}
            onChange={(v) => void save({ maxSeconds: Number(v) })}
            ariaLabel={t('dictate.settings.safetyStop')}
          />
          <p className="cth-stapler-dictate-note">{t('dictate.settings.safetyNote')}</p>
        </div>
      </Section>

      <PlatformSection status={status} onRequest={(which) => { api.requestPermission(which).then(setStatus, () => {}); }} />

      <Section title={t('dictate.settings.tryIt')}>
        <div className="cth-stapler-dictate-rows">
          <textarea className="cth-stapler-dictate-try" placeholder={t('dictate.settings.tryPlaceholder', { shortcut })} aria-label={t('dictate.settings.tryIt')} />
          {state.last && (
            <>
              <div className="cth-stapler-dictate-row">
                <span className="cth-stapler-dictate-note cth-stapler-dictate-grow">
                  {t(`dictate.result.${state.last.strategy === 'clipboard' ? 'clipboard' : 'typed'}`)}
                </span>
                <Button size="sm" variant="ghost" onClick={() => { void api.copyLast().then((r) => setCopied(r.ok)); }}>
                  {copied ? t('dictate.settings.copied') : t('dictate.settings.copyAgain')}
                </Button>
              </div>
              <div className="cth-stapler-dictate-last">{state.last.text}</div>
            </>
          )}
        </div>
      </Section>
    </div>
  );
}

function grantTone(v: string | null): ChipTone {
  return v === 'granted' ? 'ok' : v === 'not-determined' || v === 'unknown' ? 'neutral' : 'danger';
}

function PlatformSection({ status, onRequest }: {
  status: DictatePlatformStatus;
  onRequest: (which: 'accessibility' | 'microphone' | 'automation') => void;
}) {
  const { t } = useTranslation();
  const tool = (found: boolean | null) =>
    found ? <Chip tone="ok">{t('dictate.status.installed')}</Chip> : <Chip tone="warn">{t('dictate.status.missing')}</Chip>;
  return (
    <Section title={t('dictate.settings.thisComputer')}>
      <div className="cth-stapler-dictate-rows">
        {(status.platform === 'darwin' || status.platform === 'win32') && (
          <Row label={t('dictate.status.microphone')}>
            <Chip tone={grantTone(status.microphone)}>{t(`dictate.status.grant.${status.microphone}`)}</Chip>
            <span className="cth-stapler-dictate-grow" />
            {status.microphone !== 'granted' && (
              <Button size="sm" onClick={() => onRequest('microphone')}>
                {status.microphone === 'not-determined' ? t('dictate.status.allow') : t('dictate.status.openSettings')}
              </Button>
            )}
          </Row>
        )}
        {status.platform === 'darwin' && (
          <>
            <Row label={t('dictate.status.accessibility')}>
              <Chip tone={grantTone(status.accessibility)}>{t(`dictate.status.grant.${status.accessibility ?? 'unknown'}`)}</Chip>
              <span className="cth-stapler-dictate-grow" />
              {status.accessibility !== 'granted' && (
                <Button size="sm" onClick={() => onRequest('accessibility')}>{t('dictate.status.openSettings')}</Button>
              )}
            </Row>
            <Row label={t('dictate.status.automation')}>
              <span className="cth-stapler-dictate-note cth-stapler-dictate-grow">{t('dictate.status.automationNote')}</span>
              <Button size="sm" variant="ghost" onClick={() => onRequest('automation')}>{t('dictate.status.openSettings')}</Button>
            </Row>
          </>
        )}
        {status.platform === 'win32' && (
          <Row label={t('dictate.status.powershell')}>{tool(status.tools.powershell)}</Row>
        )}
        {status.platform === 'linux' && (
          <>
            <Row label={t('dictate.status.session')}>
              <Chip tone={status.linuxSession === 'x11' ? 'ok' : 'warn'}>{t(`dictate.status.sessionKind.${status.linuxSession ?? 'unknown'}`)}</Chip>
            </Row>
            {status.linuxSession === 'wayland' ? (
              <>
                <Row label="wtype">{tool(status.tools.wtype)}</Row>
                <p className="cth-stapler-dictate-note">{t('dictate.status.waylandNote')}</p>
              </>
            ) : (
              <>
                <Row label="xdotool">{tool(status.tools.xdotool)}</Row>
                {!status.tools.xdotool && <p className="cth-stapler-dictate-note">{t('dictate.status.xdotoolNote')}</p>}
              </>
            )}
          </>
        )}
        {status.platform === 'other' && <p className="cth-stapler-dictate-note">{t('dictate.notice.unsupported-platform')}</p>}
      </div>
    </Section>
  );
}
