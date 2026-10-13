/**
 * Temps: hire an agent for one job. It runs as an ephemeral worker — its own
 * worktree, the job in its inbox, released when it says it is done — and leaves
 * a row behind: the job, how long it ran, the tokens it used, and the worktree
 * it kept because that worktree holds unmerged work.
 *
 * Stop is the Workers tab's stop (`workers:stop`): the same safety-gated
 * teardown as a reap, so stopping never discards committed work.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Card, Chip, EmptyState, Section, Spinner } from '../ui';
import { useWorkspace } from '../store';
import {
  AGENT_PROVIDER_PRESETS,
  modelsForProvider,
  type AgentProvider,
  type HarnessConfig
} from '@/store/config';
import {
  DEFAULT_MAX_TEMPS,
  MAX_TEMPS_LIMIT,
  formatDuration,
  formatTokens,
  tempCapableProvider,
  type TempHistoryRow,
  type TempRecord
} from '@shared/workspace/capabilitiesTemps';
import { engineLabel, relativeTime } from './parts';
import { useTemps } from './useCapabilities';

const ENGINES = AGENT_PROVIDER_PRESETS.filter((p) => tempCapableProvider(p.id));
/** The folder picker's "Choose a folder…" entry (not a path anyone can have). */
const CHOOSE = '::choose-folder::';

function useNow(active: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

const OUTCOME_TONE: Record<TempHistoryRow['outcome'], 'ok' | 'neutral' | 'danger' | 'warn' | 'info'> = {
  done: 'ok', stopped: 'neutral', failed: 'danger', ended: 'warn', interrupted: 'info'
};

function HireForm({ config, disabled, onHired }: { config: HarnessConfig; disabled: boolean; onHired: () => void }) {
  const { t } = useTranslation();
  const repos = config.registeredRepos ?? [];
  const [job, setJob] = useState('');
  const [provider, setProvider] = useState<AgentProvider>(() => {
    const def = ENGINES.find((e) => e.id === 'claude') ?? ENGINES[0];
    return (def?.id ?? 'claude') as AgentProvider;
  });
  const [model, setModel] = useState('');
  const [cwd, setCwd] = useState(repos[0] ?? '');
  const [isolate, setIsolate] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const models = useMemo(() => modelsForProvider(provider), [provider]);
  const preset = ENGINES.find((e) => e.id === provider);
  const folders = cwd && !repos.includes(cwd) ? [cwd, ...repos] : repos;

  const choose = async () => {
    const res = await window.cth.chooseFolder().catch(() => null);
    if (res && res.ok) setCwd(res.path);
  };

  const hire = async () => {
    setError('');
    if (!job.trim()) { setError(t('wsCapabilities.temps.errors.job')); return; }
    if (!cwd) { setError(t('wsCapabilities.temps.errors.cwd')); return; }
    setBusy(true);
    try {
      const res = await window.cth.features.capabilities.hireTemp({ job: job.trim(), provider, model: model || undefined, cwd, isolate });
      if (res.ok) { setJob(''); onHired(); }
      else setError(t(`wsCapabilities.temps.errors.${['job', 'jobTooLong', 'provider', 'model', 'cwd', 'noHive', 'tooMany'].includes(res.error) ? res.error : 'generic'}`, { error: res.error }));
    } catch (e) {
      setError(t('wsCapabilities.temps.errors.generic', { error: e instanceof Error ? e.message : String(e) }));
    } finally { setBusy(false); }
  };

  return (
    <Card padding="md" className="cth-ws-capabilities-hire">
      <label className="cth-ws-capabilities-field">
        <span>{t('wsCapabilities.temps.job')}</span>
        <textarea
          className="cth-ws-capabilities-textarea"
          value={job}
          maxLength={4000}
          placeholder={t('wsCapabilities.temps.jobPlaceholder')}
          onChange={(e) => setJob(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void hire(); }
          }}
        />
      </label>
      <div className="cth-ws-capabilities-hire-fields">
        <label className="cth-ws-capabilities-field">
          <span>{t('wsCapabilities.temps.engine')}</span>
          <select className="cth-ws-capabilities-select" value={provider} onChange={(e) => { setProvider(e.target.value as AgentProvider); setModel(''); }}>
            {ENGINES.map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}
          </select>
        </label>
        {preset?.supportsModel && (
          <label className="cth-ws-capabilities-field">
            <span>{t('wsCapabilities.temps.model')}</span>
            <select className="cth-ws-capabilities-select" value={model} onChange={(e) => setModel(e.target.value)}>
              {models.map((m) => <option key={m.label} value={m.id ?? ''}>{m.id ? m.label : t('wsCapabilities.temps.defaultModel')}</option>)}
              {!models.some((m) => !m.id) && <option value="">{t('wsCapabilities.temps.defaultModel')}</option>}
            </select>
          </label>
        )}
        <label className="cth-ws-capabilities-field">
          <span>{t('wsCapabilities.temps.folder')}</span>
          <select className="cth-ws-capabilities-select" value={cwd} onChange={(e) => { if (e.target.value === CHOOSE) void choose(); else setCwd(e.target.value); }}>
            {folders.length === 0 && <option value="">{t('wsCapabilities.temps.noFolder')}</option>}
            {folders.map((f) => <option key={f} value={f}>{f}</option>)}
            <option value={CHOOSE}>{t('wsCapabilities.temps.chooseFolder')}</option>
          </select>
        </label>
        <label className="cth-ws-capabilities-check" title={t('wsCapabilities.temps.worktreeTitle')}>
          <input type="checkbox" checked={isolate} onChange={(e) => setIsolate(e.target.checked)} />
          {t('wsCapabilities.temps.worktree')}
        </label>
      </div>
      <div className="cth-ws-capabilities-actions">
        <Button variant="primary" disabled={disabled || busy || !job.trim() || !cwd} onClick={() => { void hire(); }}>
          {t('wsCapabilities.temps.hire')}
        </Button>
        {busy && <Spinner />}
        {error && <span className="cth-ws-capabilities-error">{error}</span>}
        <span className="cth-ws-muted">{t('wsCapabilities.temps.hireNote')}</span>
      </div>
    </Card>
  );
}

function stateLabelKey(rec: TempRecord, waitingForSlot: boolean): string {
  if (rec.stopRequested && rec.state !== 'queued') return 'stopping';
  if (rec.state === 'starting' && waitingForSlot) return 'waitingSlot';
  return rec.state;
}

export function TempsTab({ config }: { config: HarnessConfig }) {
  const { t, i18n } = useTranslation();
  const navigate = useWorkspace((s) => s.navigate);
  const { temps, workers, error } = useTemps();
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [stopErr, setStopErr] = useState<Record<string, string>>({});
  const active = temps?.active ?? [];
  const now = useNow(active.some((a) => a.state === 'running'));
  const liveIds = useMemo(() => new Set((workers?.live ?? []).map((w) => w.workerId)), [workers]);

  // A stop asked for before the temp reached the floor: stop it the moment it
  // does (main cannot kill a process; the worker controller's stop can).
  const sent = useRef(new Set<string>());
  useEffect(() => {
    for (const rec of active) {
      if (rec.state !== 'running' || !rec.stopRequested || sent.current.has(rec.workerId)) continue;
      sent.current.add(rec.workerId);
      void window.cth.stopWorker(rec.workerId).catch(() => { sent.current.delete(rec.workerId); });
    }
  }, [active]);

  const stop = async (rec: TempRecord) => {
    setBusy((b) => ({ ...b, [rec.id]: true }));
    setStopErr((e) => ({ ...e, [rec.id]: '' }));
    try {
      const res = await window.cth.features.capabilities.stopTemp(rec.id);
      if (res.ok && res.workerId) {
        sent.current.add(res.workerId);
        const r = await window.cth.stopWorker(res.workerId);
        if (!r.ok) setStopErr((e) => ({ ...e, [rec.id]: r.error ?? '' }));
      } else if (!res.ok) setStopErr((e) => ({ ...e, [rec.id]: res.error ?? '' }));
    } finally { setBusy((b) => ({ ...b, [rec.id]: false })); }
  };

  if (error && !temps) return <EmptyState title={t('wsCapabilities.temps.loadFailed')} />;
  if (!temps) return <EmptyState compact title={t('wsCapabilities.common.loading')} icon={<Spinner />} />;

  const max = temps.maxConcurrent ?? DEFAULT_MAX_TEMPS;
  const workerSlotsFull = (workers?.live.length ?? 0) >= (workers?.maxWorkers ?? Infinity);

  return (
    <>
      <p className="cth-ws-capabilities-intro">{t('wsCapabilities.temps.intro')}</p>
      {!temps.hive && <div className="cth-ws-capabilities-banner" data-tone="warn"><span>{t('wsCapabilities.common.noHive')}</span></div>}
      <HireForm config={config} disabled={!temps.hive} onHired={() => { /* main pushes the change */ }} />

      <Section
        title={t('wsCapabilities.temps.runningTitle', { running: temps.running, max })}
        actions={(
          <span className="cth-ws-capabilities-actions">
            <span className="cth-ws-capabilities-toolbar-label">{t('wsCapabilities.temps.atOnce')}</span>
            <select
              className="cth-ws-capabilities-select"
              value={max}
              aria-label={t('wsCapabilities.temps.atOnce')}
              onChange={(e) => { void window.cth.features.capabilities.setMaxTemps(Number(e.target.value)); }}
            >
              {Array.from({ length: MAX_TEMPS_LIMIT }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </span>
        )}
      >
        {active.length === 0 ? (
          <div className="cth-ws-muted">{t('wsCapabilities.temps.noneRunning')}</div>
        ) : (
          <div className="cth-ws-capabilities-list">
            {active.map((rec) => {
              const live = workers?.live.find((w) => w.workerId === rec.workerId);
              const started = rec.startedAt;
              const key = stateLabelKey(rec, rec.state === 'starting' && workerSlotsFull);
              return (
                <div key={rec.id} className="cth-ws-capabilities-row">
                  <div className="cth-ws-capabilities-row-main">
                    <div className="cth-ws-capabilities-row-title">
                      <span className="cth-ws-capabilities-job">{rec.job.split('\n')[0]}</span>
                      <Chip tone={rec.state === 'running' ? 'ok' : 'neutral'}>{t(`wsCapabilities.temps.state.${key}`)}</Chip>
                    </div>
                    <div className="cth-ws-capabilities-temp-stats">
                      <span>{engineLabel(rec.provider)}{rec.model ? ` · ${rec.model}` : ''}</span>
                      {started && <span>{formatDuration((rec.endedAt ?? now) - started)}</span>}
                      {live && <span>{t('wsCapabilities.temps.tokens', { tokens: formatTokens(live.tokensUsed) })}</span>}
                      <span className="cth-ws-ellipsis" title={rec.cwd}>{rec.cwd}</span>
                    </div>
                    {stopErr[rec.id] && <span className="cth-ws-capabilities-error">{stopErr[rec.id]}</span>}
                  </div>
                  <div className="cth-ws-capabilities-row-actions">
                    {rec.state === 'running' && liveIds.has(rec.workerId) && (
                      <Button size="sm" variant="ghost" onClick={() => navigate({ kind: 'agent', agentId: rec.workerId })}>{t('wsCapabilities.temps.open')}</Button>
                    )}
                    {rec.state !== 'finishing' && (
                      <Button size="sm" variant="ghost" disabled={busy[rec.id] || (rec.stopRequested && rec.state === 'running')} onClick={() => { void stop(rec); }}>
                        {rec.state === 'queued' ? t('wsCapabilities.temps.cancel') : t('wsCapabilities.temps.stop')}
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Section>

      <Section
        title={t('wsCapabilities.temps.historyTitle')}
        count={temps.history.length}
        actions={temps.history.length > 0
          ? <Button size="sm" variant="ghost" onClick={() => { void window.cth.features.capabilities.clearTempHistory(); }}>{t('wsCapabilities.temps.clearHistory')}</Button>
          : undefined}
      >
        {temps.history.length === 0 ? (
          <div className="cth-ws-muted">{t('wsCapabilities.temps.historyEmpty')}</div>
        ) : (
          <div className="cth-ws-capabilities-list">
            {temps.history.map((h) => (
              <div key={h.id} className="cth-ws-capabilities-row">
                <div className="cth-ws-capabilities-row-main">
                  <div className="cth-ws-capabilities-row-title">
                    <span className="cth-ws-capabilities-job">{h.job.split('\n')[0]}</span>
                    <Chip tone={OUTCOME_TONE[h.outcome]}>{t(`wsCapabilities.temps.outcome.${h.outcome}`)}</Chip>
                    {h.worktree?.kept && <Chip tone="warn" title={h.worktree.detail}>{t('wsCapabilities.temps.keptWorktree')}</Chip>}
                  </div>
                  <div className="cth-ws-capabilities-temp-stats">
                    <span>{formatDuration(h.durationMs)}</span>
                    <span>{h.tokens === null ? t('wsCapabilities.temps.noTokens') : t('wsCapabilities.temps.tokens', { tokens: formatTokens(h.tokens) })}</span>
                    <span>{engineLabel(h.provider)}{h.model ? ` · ${h.model}` : ''}</span>
                    <span>{relativeTime(i18n.language, h.endedAt)}</span>
                  </div>
                  {h.worktree?.kept && (
                    <div className="cth-ws-capabilities-row-meta">
                      {t('wsCapabilities.temps.keptDetail', { branch: h.worktree.branch ?? '—', detail: h.worktree.detail === 'unknown' ? t('wsCapabilities.temps.keptUnknown') : (h.worktree.detail ?? '') })}
                      {' '}<span className="cth-ws-mono">{h.worktree.path}</span>
                    </div>
                  )}
                  {h.error && (
                    <span className="cth-ws-capabilities-error">
                      {['rejected', 'lost', 'cwd', 'interrupted'].includes(h.error) ? t(`wsCapabilities.temps.why.${h.error}`) : h.error}
                    </span>
                  )}
                </div>
                {h.worktree?.kept && (
                  <div className="cth-ws-capabilities-row-actions">
                    <Button size="sm" variant="ghost" onClick={() => { void navigator.clipboard?.writeText(h.worktree!.path).catch(() => undefined); }}>
                      {t('wsCapabilities.temps.copyPath')}
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </Section>
    </>
  );
}
