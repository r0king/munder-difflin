/**
 * Transcription settings (owned by the `transcribe` unit). Self-contained, no
 * props and no store: the Stapler embeds it in its settings panel (puck
 * window) and in the meetings library (main window), and every value comes
 * from main over `window.cth.features.transcribe`, so both show the same.
 *
 * Engine picker with each engine's availability and reason · model status,
 * download and progress · Groq key presence (never the key) · microphone and
 * system-audio pickers with a live test meter · the user's own vocabulary.
 * Every control saves at once.
 */
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import {
  MAX_CUSTOM_WORDS,
  MAX_CUSTOM_WORD_LENGTH,
  newSessionId,
  type EngineInfo,
  type ModelInfo,
  type TranscribeEngine,
  type TranscribeSettings as Settings,
  type TranscribeStatus
} from '@shared/features/transcribe';
import { Button, Chip, Section, Spinner, type ChipTone } from '@/workspace/ui';
import {
  captureNoticeKey,
  listAudioInputs,
  startCapture,
  type AudioInput,
  type CaptureHandle,
  type CaptureLevels,
  type CaptureNotice
} from './audio/capture';
import './audio/transcribe-settings.css';

const TEST_SECONDS = 20;

const api = (): typeof window.cth.features.transcribe => window.cth.features.transcribe;
const isStaplerWindow = (): boolean => document.documentElement.classList.contains('cth-stapler');
const mb = (bytes: number): string => String(Math.round(bytes / 1_000_000));

function engineKey(id: TranscribeEngine): string {
  return id === 'local-large' ? 'localLarge' : id;
}

function Meter({ label, level, active }: { label: string; level: number; active: boolean }) {
  return (
    <div className="cth-tx-meter-row">
      <span className="cth-tx-meter-label">{label}</span>
      <span className="cth-tx-meter" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(level * 100)}>
        <span className="cth-tx-meter-fill" data-active={active || undefined} style={{ inlineSize: `${Math.round(level * 100)}%` }} />
      </span>
    </div>
  );
}

function ProgressBar({ pct, label }: { pct: number; label: string }) {
  return (
    <span className="cth-tx-progress" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}>
      <span className="cth-tx-progress-fill" style={{ inlineSize: `${Math.max(0, Math.min(100, pct))}%` }} />
    </span>
  );
}

// ─── Engine ─────────────────────────────────────────────────────────────────

function EngineList({ status, settings, onPick }: { status: TranscribeStatus; settings: Settings; onPick: (e: TranscribeEngine) => void }) {
  const { t } = useTranslation();
  const large = status.models.find((m) => m.id === 'large');
  const effective = status.effectiveEngine;
  return (
    <div className="cth-tx-rows">
      <div className="cth-tx-engines" role="radiogroup" aria-label={t('transcribe.engine.title')}>
        {status.engines.map((e: EngineInfo) => {
          const selected = settings.engine === e.id;
          // An unavailable engine can still be chosen when it only needs a
          // download (the larger model): choosing it starts the download.
          const pickable = e.available || e.reason === 'model-missing' || e.reason === 'downloading';
          return (
            <button
              key={e.id}
              type="button"
              role="radio"
              aria-checked={selected}
              className="cth-tx-engine"
              disabled={!pickable && !selected}
              onClick={() => { if (!selected) onPick(e.id); }}
            >
              <span className="cth-tx-radio" aria-hidden />
              <span className="cth-tx-engine-text">
                <span className="cth-tx-engine-name">{t(`transcribe.engine.${engineKey(e.id)}.name`)}</span>
                <span className="cth-tx-note">
                  {t(`transcribe.engine.${engineKey(e.id)}.desc`, { size: mb(large?.sizeBytes ?? 0) })}
                </span>
              </span>
              {e.available
                ? effective === e.id && <Chip tone="ok">{t('transcribe.engine.inUse')}</Chip>
                : <Chip tone={e.reason === 'downloading' ? 'info' : 'neutral'}>{t(`transcribe.reason.${e.reason}`)}</Chip>}
            </button>
          );
        })}
      </div>
      {settings.engine !== effective && (
        <p className="cth-tx-note" role="status">
          {t('transcribe.engine.fallback', { engine: t(`transcribe.engine.${engineKey(settings.engine)}.name`) })}
        </p>
      )}
      <p className="cth-tx-note">{t('transcribe.engine.englishOnly')}</p>
    </div>
  );
}

// ─── Models ─────────────────────────────────────────────────────────────────

function ModelRow({ model, status, onChanged }: { model: ModelInfo; status: TranscribeStatus; onChanged: () => void }) {
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);
  const size = mb(model.sizeBytes);
  const dl = status.downloading?.model === model.id ? status.downloading : null;
  const otherDownloading = !!status.downloading && !dl;
  const run = async (fn: () => Promise<{ ok: boolean; error?: string }>): Promise<void> => {
    setError(null);
    try {
      const r = await fn();
      if (!r.ok) setError(r.error ?? t('transcribe.model.failed'));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    onChanged();
  };
  let state: string;
  if (dl) state = t('transcribe.model.downloading', { pct: dl.pct.toFixed(0) });
  else if (model.state === 'bundled') state = t('transcribe.model.bundled');
  else if (model.state === 'cached') state = t('transcribe.model.cached');
  else if (model.state === 'error') state = t('transcribe.model.error', { error: model.error ?? '' });
  else state = t(model.id === 'base' ? 'transcribe.model.firstUse' : 'transcribe.model.missing', { size });
  const tone: ChipTone = model.state === 'error' ? 'danger' : model.state === 'bundled' || model.state === 'cached' ? 'ok' : dl ? 'info' : 'neutral';
  return (
    <div className="cth-tx-model">
      <div className="cth-tx-row">
        <span className="cth-tx-model-name">
          {t(`transcribe.model.${model.id}`)}
          <span className="cth-tx-note"> · {model.repo.split('/')[1]} · {t('transcribe.model.size', { size })}</span>
        </span>
        <span className="cth-tx-grow" />
        <Chip tone={tone}>{state}</Chip>
      </div>
      {dl && <ProgressBar pct={dl.pct} label={t('transcribe.model.downloadingLabel')} />}
      <div className="cth-tx-row">
        {dl ? (
          <Button size="sm" variant="ghost" onClick={() => void run(() => api().cancelDownload())}>{t('transcribe.model.cancel')}</Button>
        ) : model.state === 'missing' || model.state === 'error' ? (
          <Button size="sm" disabled={otherDownloading} onClick={() => void run(() => api().downloadModel(model.id))}>
            {model.state === 'error' ? t('transcribe.model.retry') : t('transcribe.model.download')}
          </Button>
        ) : model.state === 'cached' && model.id === 'large' ? (
          <Button size="sm" variant="ghost" onClick={() => void run(() => api().removeModel(model.id))}>{t('transcribe.model.remove')}</Button>
        ) : null}
      </div>
      {error && <p className="cth-tx-error" role="alert">{error}</p>}
    </div>
  );
}

// ─── Groq ───────────────────────────────────────────────────────────────────

function GroqKey({ status }: { status: TranscribeStatus }) {
  const { t } = useTranslation();
  const inStapler = isStaplerWindow();
  return (
    <div className="cth-tx-rows">
      <div className="cth-tx-row">
        <Chip tone={status.groqKey ? 'ok' : 'neutral'}>{status.groqKey ? t('transcribe.groq.keySaved') : t('transcribe.groq.noKey')}</Chip>
        <span className="cth-tx-grow" />
        {!inStapler && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => window.dispatchEvent(new CustomEvent('cth:open-settings', { detail: { section: 'Voice' } }))}
          >
            {t('transcribe.groq.openSettings')}
          </Button>
        )}
      </div>
      <p className="cth-tx-note">{t('transcribe.groq.desc')}</p>
      {inStapler && <p className="cth-tx-note">{t('transcribe.groq.whereKey')}</p>}
    </div>
  );
}

// ─── Devices ────────────────────────────────────────────────────────────────

function systemHelpKey(status: TranscribeStatus): string {
  if (status.systemAudio === 'loopback') return status.platform === 'darwin' ? 'transcribe.devices.helpMac' : 'transcribe.devices.helpWindows';
  if (status.systemAudio === 'monitor') return 'transcribe.devices.helpLinux';
  return 'transcribe.devices.helpDevice';
}

function Devices({ status, settings, onSave }: { status: TranscribeStatus; settings: Settings; onSave: (p: Partial<Settings>) => void }) {
  const { t } = useTranslation();
  const [inputs, setInputs] = useState<AudioInput[] | null>(null);
  const [listError, setListError] = useState(false);
  const [test, setTest] = useState<'idle' | 'starting' | 'running'>('idle');
  const [testError, setTestError] = useState<string | null>(null);
  const [levels, setLevels] = useState<CaptureLevels>({ mic: 0, system: 0 });
  const [notices, setNotices] = useState<CaptureNotice[]>([]);
  const [hasSystem, setHasSystem] = useState(false);
  const handle = useRef<CaptureHandle | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(() => {
    listAudioInputs().then((l) => { setInputs(l); setListError(false); }, () => setListError(true));
  }, []);

  useEffect(() => {
    refresh();
    navigator.mediaDevices.addEventListener('devicechange', refresh);
    return () => navigator.mediaDevices.removeEventListener('devicechange', refresh);
  }, [refresh]);

  const stopTest = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const h = handle.current;
    handle.current = null;
    setTest('idle');
    setLevels({ mic: 0, system: 0 });
    // A test keeps nothing.
    if (h) await h.cancel().catch(() => undefined);
  }, []);

  useEffect(() => () => { void stopTest(); }, [stopTest]);

  const startTest = async (): Promise<void> => {
    setTestError(null);
    setNotices([]);
    setTest('starting');
    try {
      const h = await startCapture({ sessionId: newSessionId(), mic: true, system: true, purpose: 'meeting' });
      handle.current = h;
      setNotices(h.info.notices);
      setHasSystem(!!h.info.system);
      let frame = 0;
      h.onLevel((l) => {
        if (frame) return;
        frame = requestAnimationFrame(() => { frame = 0; setLevels(l); });
      });
      setTest('running');
      timer.current = setTimeout(() => { void stopTest(); }, TEST_SECONDS * 1000);
      // Labels become readable once the mic is open.
      refresh();
    } catch (e) {
      handle.current = null;
      setTest('idle');
      const name = e && typeof e === 'object' && 'name' in e ? String((e as { name: unknown }).name) : '';
      setTestError(name === 'NotAllowedError' ? t('transcribe.devices.micDenied') : t('transcribe.devices.testFailed', { error: e instanceof Error ? e.message : String(e) }));
    }
  };

  const label = (d: AudioInput, i: number): string => d.label || t('transcribe.devices.noLabel', { n: i + 1 });
  const options = inputs ?? [];
  const known = (id: string): boolean => !id || options.some((d) => d.deviceId === id);

  return (
    <div className="cth-tx-rows">
      <label className="cth-tx-row">
        <span className="cth-tx-label">{t('transcribe.devices.mic')}</span>
        <select
          className="cth-tx-select"
          value={settings.micDeviceId}
          disabled={test !== 'idle'}
          onChange={(e) => onSave({ micDeviceId: e.target.value })}
        >
          <option value="">{t('transcribe.devices.default')}</option>
          {options.map((d, i) => <option key={d.deviceId} value={d.deviceId}>{label(d, i)}</option>)}
          {!known(settings.micDeviceId) && <option value={settings.micDeviceId}>{t('transcribe.devices.disconnected')}</option>}
        </select>
      </label>
      <label className="cth-tx-row">
        <span className="cth-tx-label">{t('transcribe.devices.system')}</span>
        <select
          className="cth-tx-select"
          value={settings.systemDeviceId}
          disabled={test !== 'idle'}
          onChange={(e) => onSave({ systemDeviceId: e.target.value })}
        >
          <option value="">{t('transcribe.devices.automatic')}</option>
          {options.map((d, i) => <option key={d.deviceId} value={d.deviceId}>{label(d, i)}</option>)}
          {!known(settings.systemDeviceId) && <option value={settings.systemDeviceId}>{t('transcribe.devices.disconnected')}</option>}
        </select>
      </label>
      <p className="cth-tx-note">{t(systemHelpKey(status))}</p>
      {status.platform === 'darwin' && status.systemAudio === 'loopback' && status.screenAccess && status.screenAccess !== 'granted' && (
        <p className="cth-tx-warn">{t('transcribe.devices.screenAccessOff')}</p>
      )}
      {listError && <p className="cth-tx-error">{t('transcribe.devices.listFailed')}</p>}

      <div className="cth-tx-test">
        <div className="cth-tx-row">
          {test === 'idle' ? (
            <Button size="sm" onClick={() => void startTest()}>{t('transcribe.devices.test')}</Button>
          ) : test === 'starting' ? (
            <Spinner label={t('transcribe.devices.starting')} />
          ) : (
            <Button size="sm" variant="secondary" onClick={() => void stopTest()}>{t('transcribe.devices.stopTest')}</Button>
          )}
          <span className="cth-tx-note">{test === 'running' ? t('transcribe.devices.testing') : t('transcribe.devices.testHelp')}</span>
        </div>
        <Meter label={t('transcribe.devices.you')} level={levels.mic} active={test === 'running'} />
        <Meter label={t('transcribe.devices.them')} level={levels.system} active={test === 'running' && hasSystem} />
        {notices.map((n) => <p key={n} className="cth-tx-warn">{t(captureNoticeKey(n))}</p>)}
        {testError && <p className="cth-tx-error" role="alert">{testError}</p>}
      </div>
    </div>
  );
}

// ─── Vocabulary ─────────────────────────────────────────────────────────────

function Vocabulary({ status, settings, onSave }: { status: TranscribeStatus; settings: Settings; onSave: (p: Partial<Settings>) => void }) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState('');
  const [builtin, setBuiltin] = useState<string[] | null>(null);
  const [showBuiltin, setShowBuiltin] = useState(false);
  const words = settings.customVocabulary;
  const full = words.length >= MAX_CUSTOM_WORDS;

  const add = (): void => {
    // A comma or newline separates several entries pasted at once.
    const fresh = draft.split(/[,\n]/).map((w) => w.replace(/\s+/g, ' ').trim()).filter((w) => w && w.length <= MAX_CUSTOM_WORD_LENGTH);
    if (!fresh.length) return;
    const seen = new Set(words.map((w) => w.toLowerCase()));
    const next = [...words];
    for (const w of fresh) {
      if (seen.has(w.toLowerCase()) || next.length >= MAX_CUSTOM_WORDS) continue;
      seen.add(w.toLowerCase());
      next.push(w);
    }
    setDraft('');
    if (next.length !== words.length) onSave({ customVocabulary: next });
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      add();
    }
  };

  const toggleBuiltin = (): void => {
    setShowBuiltin((v) => !v);
    if (!builtin) api().getVocabulary().then((v) => setBuiltin(v.builtin), () => setBuiltin([]));
  };

  return (
    <div className="cth-tx-rows">
      <p className="cth-tx-note">{t('transcribe.vocab.intro', { count: status.builtinVocabularyCount })}</p>
      <div className="cth-tx-row">
        <input
          className="cth-tx-input"
          value={draft}
          maxLength={MAX_CUSTOM_WORD_LENGTH * 4}
          disabled={full}
          placeholder={t('transcribe.vocab.placeholder')}
          aria-label={t('transcribe.vocab.placeholder')}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKey}
        />
        <Button size="sm" disabled={!draft.trim() || full} onClick={add}>{t('transcribe.vocab.add')}</Button>
      </div>
      {full && <p className="cth-tx-note">{t('transcribe.vocab.limit', { max: MAX_CUSTOM_WORDS })}</p>}
      {words.length ? (
        <ul className="cth-tx-words" aria-label={t('transcribe.vocab.yours')}>
          {words.map((w) => (
            <li key={w} className="cth-tx-word">
              <span>{w}</span>
              <button
                type="button"
                className="cth-tx-word-remove"
                aria-label={t('transcribe.vocab.remove', { word: w })}
                title={t('transcribe.vocab.remove', { word: w })}
                onClick={() => onSave({ customVocabulary: words.filter((x) => x !== w) })}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="cth-tx-note">{t('transcribe.vocab.empty')}</p>
      )}
      <div className="cth-tx-row">
        <Button size="sm" variant="ghost" onClick={toggleBuiltin}>
          {showBuiltin ? t('transcribe.vocab.hideBuiltin') : t('transcribe.vocab.showBuiltin', { count: status.builtinVocabularyCount })}
        </Button>
      </div>
      {showBuiltin && (builtin ? <p className="cth-tx-builtin">{builtin.join(' · ')}</p> : <Spinner />)}
    </div>
  );
}

// ─── Root ───────────────────────────────────────────────────────────────────

export function TranscribeSettings() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<TranscribeStatus | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const refreshStatus = useCallback(() => {
    api().getStatus().then(setStatus, () => { /* keep the last one */ });
  }, []);

  useEffect(() => {
    let alive = true;
    Promise.all([api().getSettings(), api().getStatus()]).then(
      ([s, st]) => { if (alive) { setSettings(s); setStatus(st); } },
      () => { if (alive) setLoadFailed(true); }
    );
    const off = api().onStatus((st) => { if (alive) setStatus(st); });
    // The Groq key is saved elsewhere (Settings → Voice), and macOS
    // permissions change in System Settings: re-read when the user comes back,
    // and now and then while this is open.
    const onFocus = (): void => refreshStatus();
    window.addEventListener('focus', onFocus);
    const poll = setInterval(refreshStatus, 10_000);
    return () => {
      alive = false;
      off();
      window.removeEventListener('focus', onFocus);
      clearInterval(poll);
    };
  }, [refreshStatus]);

  const save = useCallback(async (patch: Partial<Settings>) => {
    setSaveError(null);
    try {
      setSettings(await api().setSettings(patch));
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    }
    refreshStatus();
  }, [refreshStatus]);

  if (loadFailed) return <div className="cth-tx"><p className="cth-tx-error">{t('transcribe.loadFailed')}</p></div>;
  if (!status || !settings) return <div className="cth-tx"><Spinner label={t('transcribe.loading')} /></div>;

  return (
    <div className="cth-tx">
      {status.busy && <Chip tone="info">{t('transcribe.busy')}</Chip>}
      {saveError && <p className="cth-tx-error" role="alert">{saveError}</p>}
      <Section title={t('transcribe.engine.title')}>
        <EngineList status={status} settings={settings} onPick={(engine) => void save({ engine })} />
      </Section>
      <Section title={t('transcribe.model.title')}>
        <div className="cth-tx-rows">
          {status.models.map((m) => <ModelRow key={m.id} model={m} status={status} onChanged={refreshStatus} />)}
        </div>
      </Section>
      <Section title={t('transcribe.groq.title')}>
        <GroqKey status={status} />
      </Section>
      <Section title={t('transcribe.devices.title')}>
        <Devices status={status} settings={settings} onSave={(p) => void save(p)} />
      </Section>
      <Section title={t('transcribe.vocab.title')}>
        <Vocabulary status={status} settings={settings} onSave={(p) => void save(p)} />
      </Section>
    </div>
  );
}
