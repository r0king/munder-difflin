/**
 * One meeting, open for reading and correcting: "Correct the transcript, add
 * a description, and send it to any of your agents."
 *
 * Every edit saves itself (the Workspace has no Save buttons): the title, the
 * description and the transcript are held locally and written ~0.8 s after
 * the last keystroke, and on leaving the meeting. While an edit is pending a
 * change on disk does not overwrite it.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  formatDuration,
  MAX_DESCRIPTION_CHARS,
  MAX_TITLE_CHARS,
  type MeetingRecord,
  type MeetingSegment,
  type StaplerTarget
} from '@shared/features/stapler';
import type { TranscribeResult } from '@shared/features/transcribe';
import { useStore } from '@/store/store';
import { Button, Chip, EmptyState, IconButton, Spinner, type ChipTone } from '@/workspace/ui';
import { StaplerIcon } from '@/stapler/icons';
import { errorText, reason, stapler } from '@/stapler/bridge';
import { TargetPicker } from './TargetPicker';

const SAVE_DELAY_MS = 800;

interface Draft { title: string; description: string; segments: MeetingSegment[] }

export function statusChip(status: MeetingRecord['status']): ChipTone | null {
  switch (status) {
    case 'recording': return 'danger';
    case 'transcribing': return 'info';
    case 'failed': return 'danger';
    case 'interrupted': return 'warn';
    default: return null;
  }
}

export function formatMeetingDate(iso: string, lng: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  try {
    return new Intl.DateTimeFormat(lng, { dateStyle: 'medium', timeStyle: 'short' }).format(d);
  } catch {
    return d.toLocaleString();
  }
}

function rowsFor(text: string): number {
  return Math.min(8, Math.max(1, Math.ceil(text.length / 64) + (text.match(/\n/g)?.length ?? 0)));
}

export function MeetingDetail({ id, onDeleted }: { id: string; onDeleted: () => void }) {
  const { t, i18n } = useTranslation();
  const agents = useStore((s) => s.agents);
  const [rec, setRec] = useState<MeetingRecord | null | undefined>(undefined);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [sendNote, setSendNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const draftRef = useRef<Draft | null>(null);
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await stapler().meetingGet(id);
      setRec(r);
      if (!dirty.current) {
        const d = r ? { title: r.title, description: r.description, segments: r.segments } : null;
        draftRef.current = d;
        setDraft(d);
      }
    } catch {
      setRec(null);
    }
  }, [id]);

  const flush = useCallback(async () => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    const d = draftRef.current;
    if (!dirty.current || !d) return;
    dirty.current = false;
    setSaveState('saving');
    try {
      const r = await stapler().meetingUpdate(id, d);
      if (r) { setRec(r); setSaveState('saved'); } else { setSaveState('error'); }
    } catch {
      setSaveState('error');
    }
  }, [id]);

  useEffect(() => {
    dirty.current = false;
    setRec(undefined);
    setSendNote(null);
    setConfirmDelete(false);
    setActionError(null);
    setSaveState('idle');
    void load();
    const off = stapler().onMeetings(() => { if (!dirty.current) void load(); });
    return () => {
      off();
      // Leaving this meeting: write what was typed.
      void flush();
    };
  }, [id, load, flush]);

  const change = (patch: Partial<Draft>) => {
    const base = draftRef.current;
    if (!base) return;
    const next = { ...base, ...patch };
    draftRef.current = next;
    setDraft(next);
    dirty.current = true;
    setSaveState('idle');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { void flush(); }, SAVE_DELAY_MS);
  };

  const setSegment = (i: number, patch: Partial<MeetingSegment>) => {
    const segs = [...(draftRef.current?.segments ?? [])];
    if (!segs[i]) return;
    segs[i] = { ...segs[i], ...patch };
    change({ segments: segs });
  };

  const names = useMemo(() => new Map(agents.map((a) => [a.id, a.name])), [agents]);

  const send = async (target: StaplerTarget) => {
    setSendNote(null);
    await flush();
    const name = target.kind === 'orchestrator'
      ? agents.find((a) => a.isGod)?.name ?? t('stapler.to.orchestrator')
      : names.get(target.agentId) ?? t('stapler.to.unknownAgent');
    try {
      const r = await stapler().meetingSend(id, target);
      setSendNote(r.ok ? { ok: true, text: t('stapler.library.sent', { name }) } : { ok: false, text: errorText(t, r.error) });
    } catch (e) {
      setSendNote({ ok: false, text: reason(e) });
    }
  };

  const retry = async () => {
    if (!rec?.sessionId) return;
    setRetrying(true);
    setActionError(null);
    const sessionId = rec.sessionId;
    const durationMs = rec.durationMs;
    try {
      const marked = await stapler().meetingTranscribing(id, { sessionId, durationMs });
      if (!marked.ok) { setActionError(errorText(t, marked.error)); return; }
      let r: TranscribeResult;
      try {
        r = await window.cth.features.transcribe.transcribeSession(sessionId, { meeting: true });
      } catch (e) {
        r = { ok: false, text: '', segments: [], engine: 'local', error: reason(e) };
      }
      await stapler().meetingFinish(id, {
        ok: r.ok,
        durationMs: durationMs || r.durationMs || 0,
        segments: r.ok ? r.segments.map((s) => ({ speaker: s.speaker === 'them' ? 'them' : 'you', startMs: s.startMs, endMs: s.endMs, text: s.text })) : [],
        engine: r.engine,
        ...(r.ok ? {} : { error: r.error || 'transcription failed' })
      });
      if (!r.ok) setActionError(t('stapler.library.retryFailed', { error: errorText(t, r.error) }));
    } catch (e) {
      setActionError(reason(e));
    } finally {
      setRetrying(false);
      void load();
    }
  };

  const remove = async () => {
    setConfirmDelete(false);
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    dirty.current = false;
    const r = await stapler().meetingDelete(id).catch(() => ({ ok: false, error: 'failed' }));
    if (r.ok) onDeleted();
    else setActionError(errorText(t, r.error));
  };

  if (rec === undefined) {
    return <div className="cth-stapler-lib-detail"><Spinner label={t('stapler.library.loading')} /></div>;
  }
  if (rec === null || !draft) {
    return (
      <div className="cth-stapler-lib-detail">
        <EmptyState title={t('stapler.library.gone')} body={t('stapler.library.goneBody')} fill />
      </div>
    );
  }

  const locked = rec.status === 'recording' || rec.status === 'transcribing';
  const tone = statusChip(rec.status);
  return (
    <div className="cth-stapler-lib-detail">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--cth-space-2)' }}>
        <input
          className="cth-stapler-input cth-stapler-lib-title"
          value={draft.title}
          maxLength={MAX_TITLE_CHARS}
          disabled={locked}
          aria-label={t('stapler.library.titleLabel')}
          onChange={(e) => change({ title: e.target.value })}
          onBlur={() => { void flush(); }}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); void flush(); } }}
        />
        <div className="cth-stapler-row">
          <span className="cth-stapler-help">
            {formatMeetingDate(rec.startedAt, i18n.language)} · {formatDuration(rec.durationMs)}
            {rec.engine ? ` · ${t('stapler.library.engine', { engine: rec.engine })}` : ''}
          </span>
          {tone && <Chip tone={tone}>{t(`stapler.library.status.${rec.status}`)}</Chip>}
          <span className="cth-stapler-spacer" />
          <span className="cth-stapler-help" role="status">
            {saveState === 'saving' ? t('stapler.library.saving') : saveState === 'saved' ? t('stapler.library.saved') : saveState === 'error' ? t('stapler.library.saveFailed') : ''}
          </span>
        </div>
        <div className="cth-stapler-row">
          <TargetPicker label={t('stapler.library.send')} disabled={locked} onPick={(target) => { void send(target); }} />
          <Button size="sm" icon={<StaplerIcon name="external" />} onClick={() => { void stapler().meetingReveal(id); }}>
            {t('stapler.library.reveal')}
          </Button>
          <span className="cth-stapler-spacer" />
          {confirmDelete ? (
            <>
              <Button size="sm" variant="danger" onClick={() => { void remove(); }}>{t('stapler.library.deleteConfirm')}</Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>{t('stapler.compose.keep')}</Button>
            </>
          ) : (
            <Button size="sm" variant="ghost" icon={<StaplerIcon name="trash" />} disabled={locked} onClick={() => setConfirmDelete(true)}>
              {t('stapler.library.delete')}
            </Button>
          )}
        </div>
        {sendNote && (
          <div className={`cth-stapler-notice${sendNote.ok ? ' cth-stapler-notice--ok' : ' cth-stapler-notice--danger'}`} role="status">
            <p>{sendNote.text}</p>
          </div>
        )}
        {actionError && <div className="cth-stapler-notice cth-stapler-notice--danger" role="alert"><p>{actionError}</p></div>}
      </div>

      {rec.status === 'recording' && (
        <div className="cth-stapler-notice"><p>{t('stapler.library.recordingNow')}</p></div>
      )}
      {(rec.status === 'transcribing' || retrying) && (
        <div className="cth-stapler-row"><Spinner label={t('stapler.meeting.transcribing')} /><span className="cth-stapler-text">{t('stapler.meeting.transcribing')}</span></div>
      )}
      {(rec.status === 'failed' || rec.status === 'interrupted') && !retrying && (
        <div className={`cth-stapler-notice${rec.status === 'failed' ? ' cth-stapler-notice--danger' : ''}`}>
          <p>{rec.status === 'failed' ? t('stapler.library.failedBody', { error: errorText(t, rec.error) }) : t('stapler.library.interruptedBody')}</p>
          {rec.sessionId ? (
            <div><Button size="sm" onClick={() => { void retry(); }}>{t('stapler.library.retry')}</Button></div>
          ) : (
            <p>{t('stapler.library.noAudio')}</p>
          )}
          <p>{t('stapler.library.retention')}</p>
        </div>
      )}

      <label style={{ display: 'flex', flexDirection: 'column', gap: 'var(--cth-space-2)' }}>
        <span className="cth-stapler-label">{t('stapler.library.description')}</span>
        <textarea
          className="cth-stapler-textarea"
          value={draft.description}
          maxLength={MAX_DESCRIPTION_CHARS}
          placeholder={t('stapler.library.descriptionPlaceholder')}
          disabled={locked}
          onChange={(e) => change({ description: e.target.value })}
          onBlur={() => { void flush(); }}
          style={{ minHeight: 72 }}
        />
      </label>

      <section style={{ display: 'flex', flexDirection: 'column', gap: 'var(--cth-space-2)' }}>
        <div className="cth-stapler-row">
          <span className="cth-stapler-label">{t('stapler.library.transcript', { count: draft.segments.length })}</span>
        </div>
        {draft.segments.length === 0 && !locked && (
          <p className="cth-stapler-help">{rec.status === 'ready' ? t('stapler.library.emptyTranscript') : t('stapler.library.noTranscriptYet')}</p>
        )}
        <div>
          {draft.segments.map((s, i) => (
            <div key={i} className="cth-stapler-seg">
              <button
                type="button"
                className={`cth-stapler-speaker cth-stapler-speaker--${s.speaker}`}
                disabled={locked}
                title={t('stapler.library.switchSpeaker')}
                onClick={() => setSegment(i, { speaker: s.speaker === 'you' ? 'them' : 'you' })}
              >
                {s.speaker === 'you' ? t('stapler.rec.you') : t('stapler.rec.them')}
              </button>
              <span className="cth-stapler-seg-time">{formatDuration(s.startMs)}</span>
              <textarea
                className="cth-stapler-textarea"
                value={s.text}
                rows={rowsFor(s.text)}
                disabled={locked}
                aria-label={t('stapler.library.lineLabel', { time: formatDuration(s.startMs) })}
                onChange={(e) => setSegment(i, { text: e.target.value })}
                onBlur={() => { void flush(); }}
              />
              <IconButton
                label={t('stapler.library.removeLine')}
                size="sm"
                tip={false}
                disabled={locked}
                onClick={() => change({ segments: (draftRef.current?.segments ?? []).filter((_, j) => j !== i) })}
              >
                <StaplerIcon name="close" />
              </IconButton>
            </div>
          ))}
        </div>
        {!locked && (
          <div>
            <Button
              size="sm"
              variant="ghost"
              icon={<StaplerIcon name="plus" />}
              onClick={() => {
                const segs = draftRef.current?.segments ?? [];
                const at = segs.length ? segs[segs.length - 1].endMs : 0;
                change({ segments: [...segs, { speaker: 'you', startMs: at, endMs: at, text: '' }] });
              }}
            >
              {t('stapler.library.addLine')}
            </Button>
          </div>
        )}
      </section>
    </div>
  );
}
