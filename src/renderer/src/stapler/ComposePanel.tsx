/**
 * The message the Stapler is putting together: who it goes to, the tray of
 * shots and files, the note — typed, or spoken and read back — and Send.
 *
 * Screenshot: "drag a region, add a note, send … up to eight shots go in one
 * send." Record message: "speak, read the transcript back, then send", with
 * screenshots, PDFs, videos and folders riding the same message.
 */
import { useState, type DragEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { MAX_SHOTS, formatDuration, type DraftAttachment, type StaplerDraft } from '@shared/features/stapler';
import { Button, KeyHint, Spinner } from '@/workspace/ui';
import { canSend, elapsedMs, isBusy, MAX_RECORDING_MS } from './flow';
import type { Recorder } from './useRecorder';
import { errorText, stapler } from './bridge';
import { LevelMeter, PanelFrame } from './PanelFrame';
import { StaplerIcon, type StaplerIconName } from './icons';
import type { PuckMood } from './PuckFace';

export interface ComposeNotice {
  tone: 'warn' | 'danger';
  text: string;
  /** "Open System Settings" for the macOS permission. */
  action?: { label: string; run: () => void };
}

const KIND_ICON: Record<DraftAttachment['kind'], StaplerIconName> = {
  shot: 'image', image: 'image', pdf: 'pdf', video: 'video', folder: 'folder', file: 'file'
};

function Tile({ a, onRemove }: { a: DraftAttachment; onRemove: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="cth-stapler-tile" title={a.path}>
      {a.thumb ? (
        <img src={a.thumb} alt={t('stapler.compose.shotAlt', { w: a.width ?? 0, h: a.height ?? 0 })} draggable={false} />
      ) : (
        <>
          <StaplerIcon name={KIND_ICON[a.kind]} size={20} />
          <span className="cth-stapler-tile-name">{a.name}</span>
        </>
      )}
      <button type="button" className="cth-stapler-tile-x" aria-label={t('stapler.compose.remove', { name: a.name })} onClick={onRemove}>
        <StaplerIcon name="close" />
      </button>
    </div>
  );
}

export function ComposePanel({ rec, draft, toName, targetGone, onOpenTo, onScreenshot, notice, onDismissNotice, micBusy, onClose, mood }: {
  rec: Recorder;
  draft: StaplerDraft;
  toName: string;
  targetGone: boolean;
  onOpenTo: () => void;
  onScreenshot: () => void;
  notice: ComposeNotice | null;
  onDismissNotice: () => void;
  /** A meeting holds the microphone. */
  micBusy: boolean;
  onClose: () => void;
  mood: PuckMood;
}) {
  const { t } = useTranslation();
  const [dragOver, setDragOver] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const { flow } = rec;
  const shots = draft.attachments.filter((a) => a.kind === 'shot').length;
  const sendable = canSend(flow, draft.attachments.length);
  const busy = isBusy(flow);

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const paths: string[] = [];
    for (const f of Array.from(e.dataTransfer.files)) {
      try {
        const p = window.cth.pathForFile(f);
        if (p) paths.push(p);
      } catch { /* not a file on disk */ }
    }
    if (paths.length) void stapler().addPaths(paths);
  };

  const clearAll = () => {
    setConfirmClear(false);
    rec.discard();
    void stapler().clearDraft();
  };

  const recorder = (() => {
    switch (flow.phase) {
      case 'starting':
        return (
          <div className="cth-stapler-row">
            <Spinner label={t('stapler.rec.opening')} />
            <span className="cth-stapler-text">{t('stapler.rec.opening')}</span>
            <span className="cth-stapler-spacer" />
            <Button size="sm" variant="ghost" onClick={rec.cancel}>{t('stapler.rec.cancel')}</Button>
          </div>
        );
      case 'recording':
        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--cth-space-2)' }}>
            <div className="cth-stapler-row">
              <span className="cth-stapler-clock">{formatDuration(elapsedMs(flow, rec.now))}</span>
              <span className="cth-stapler-help">{t('stapler.rec.limit', { max: formatDuration(MAX_RECORDING_MS.message) })}</span>
              <span className="cth-stapler-spacer" />
              <Button size="sm" variant="ghost" onClick={rec.cancel}>{t('stapler.rec.cancel')}</Button>
              <Button size="sm" variant="primary" icon={<StaplerIcon name="stop" />} onClick={rec.stop}>{t('stapler.rec.stop')}</Button>
            </div>
            <LevelMeter label={t('stapler.rec.you')} level={rec.levels.mic} />
          </div>
        );
      case 'stopping':
      case 'transcribing':
        return (
          <div className="cth-stapler-row">
            <Spinner label={t('stapler.rec.transcribing')} />
            <span className="cth-stapler-text">{t('stapler.rec.transcribing')}</span>
            <span className="cth-stapler-spacer" />
            <Button size="sm" variant="ghost" onClick={rec.cancel}>{t('stapler.rec.cancel')}</Button>
          </div>
        );
      case 'error':
        return (
          <div className="cth-stapler-notice cth-stapler-notice--danger" role="alert">
            <p>{flow.failedIn === 'transcribing' ? t('stapler.rec.transcribeFailed', { error: errorText(t, flow.error) }) : t('stapler.rec.failed', { error: errorText(t, flow.error) })}</p>
            <div className="cth-stapler-row">
              <Button size="sm" onClick={rec.retry}>{t('stapler.rec.retry')}</Button>
              <Button size="sm" variant="ghost" onClick={rec.cancel}>{t('stapler.rec.dismiss')}</Button>
            </div>
          </div>
        );
      default:
        return (
          <div className="cth-stapler-row">
            <Button
              size="sm"
              icon={<StaplerIcon name="message" />}
              disabled={micBusy || flow.phase === 'sending'}
              onClick={rec.start}
            >
              {flow.text.trim() ? t('stapler.rec.recordMore') : t('stapler.rec.record')}
            </Button>
            {micBusy && <span className="cth-stapler-help">{t('stapler.rec.micBusy')}</span>}
          </div>
        );
    }
  })();

  return (
    <PanelFrame
      title={t('stapler.compose.title')}
      mood={mood}
      onClose={onClose}
      foot={
        <>
          {confirmClear ? (
            <>
              <Button size="sm" variant="danger" onClick={clearAll}>{t('stapler.compose.clearConfirm')}</Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmClear(false)}>{t('stapler.compose.keep')}</Button>
            </>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              icon={<StaplerIcon name="trash" />}
              disabled={busy || (!flow.text && draft.attachments.length === 0)}
              onClick={() => setConfirmClear(true)}
            >
              {t('stapler.compose.clear')}
            </Button>
          )}
          <span className="cth-stapler-spacer" />
          <KeyHint combo="Mod+Enter" />
          <Button variant="primary" icon={<StaplerIcon name="send" />} disabled={!sendable} onClick={rec.send}>
            {flow.phase === 'sending' ? t('stapler.compose.sending') : t('stapler.compose.send')}
          </Button>
        </>
      }
    >
      <div
        onDragOver={(e) => { e.preventDefault(); if (!dragOver) setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        className={dragOver ? 'cth-stapler-drop' : undefined}
        style={{ display: 'flex', flexDirection: 'column', gap: 'var(--cth-space-3)' }}
      >
        {notice && (
          <div className={`cth-stapler-notice${notice.tone === 'danger' ? ' cth-stapler-notice--danger' : ''}`} role="alert">
            <p>{notice.text}</p>
            <div className="cth-stapler-row">
              {notice.action && <Button size="sm" variant="primary" onClick={notice.action.run}>{notice.action.label}</Button>}
              <Button size="sm" variant="ghost" onClick={onDismissNotice}>{t('stapler.rec.dismiss')}</Button>
            </div>
          </div>
        )}
        {flow.phase === 'done' && (
          <div className="cth-stapler-notice cth-stapler-notice--ok" role="status"><p>{t('stapler.compose.sent', { name: toName })}</p></div>
        )}
        {flow.phase === 'review' && flow.error && (
          <div className="cth-stapler-notice cth-stapler-notice--danger" role="alert">
            <p>{t('stapler.compose.sendFailed', { error: errorText(t, flow.error) })}</p>
          </div>
        )}

        <div className="cth-stapler-row">
          <span className="cth-stapler-label">{t('stapler.compose.to')}</span>
          <Button size="sm" icon={<StaplerIcon name="to" />} onClick={onOpenTo} title={t('stapler.to.title')}>{toName}</Button>
        </div>
        {targetGone && <p className="cth-stapler-help">{t('stapler.to.gone')}</p>}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--cth-space-2)' }}>
          <div className="cth-stapler-row">
            <span className="cth-stapler-label">{t('stapler.compose.attachments', { count: draft.attachments.length })}</span>
            <span className="cth-stapler-spacer" />
            <span className="cth-stapler-help">{t('stapler.compose.shotCount', { count: shots, max: MAX_SHOTS })}</span>
          </div>
          {draft.attachments.length > 0 ? (
            <div className="cth-stapler-tray">
              {draft.attachments.map((a) => (
                <Tile key={a.id} a={a} onRemove={() => { void stapler().removeAttachment(a.id); }} />
              ))}
            </div>
          ) : (
            <p className="cth-stapler-help">{t('stapler.compose.emptyTray')}</p>
          )}
          <div className="cth-stapler-row">
            <Button size="sm" icon={<StaplerIcon name="screenshot" />} disabled={shots >= MAX_SHOTS} onClick={onScreenshot}>
              {t('stapler.compose.addShot')}
            </Button>
            <Button size="sm" icon={<StaplerIcon name="file" />} onClick={() => { void stapler().pickFiles('files'); }}>
              {t('stapler.compose.addFiles')}
            </Button>
            <Button size="sm" icon={<StaplerIcon name="folder" />} onClick={() => { void stapler().pickFiles('folders'); }}>
              {t('stapler.compose.addFolder')}
            </Button>
          </div>
        </div>

        <label style={{ display: 'flex', flexDirection: 'column', gap: 'var(--cth-space-2)' }}>
          <span className="cth-stapler-label">{t('stapler.compose.note')}</span>
          <textarea
            className="cth-stapler-textarea"
            value={flow.text}
            placeholder={t('stapler.compose.notePlaceholder')}
            disabled={flow.phase === 'sending'}
            spellCheck
            onChange={(e) => rec.edit(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                if (sendable) rec.send();
              }
            }}
          />
        </label>
        {flow.phase === 'review' && !flow.text.trim() && !flow.error && (
          <p className="cth-stapler-help">{t('stapler.rec.nothingHeard')}</p>
        )}
        {flow.autoStopped && flow.phase !== 'recording' && (
          <p className="cth-stapler-help">{t('stapler.rec.autoStopped', { max: formatDuration(MAX_RECORDING_MS.message) })}</p>
        )}
        {recorder}
      </div>
    </PanelFrame>
  );
}
