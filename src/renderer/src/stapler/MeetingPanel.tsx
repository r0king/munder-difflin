/**
 * Record meeting: "both sides: the transcript says You and Them, one folder
 * per meeting". The panel is for starting, watching the two meters and
 * stopping; the transcript is corrected, described and sent from the library
 * in the main window, where there is room to read it.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatDuration } from '@shared/features/stapler';
import { Button, KeyHint, Spinner } from '@/workspace/ui';
import { elapsedMs } from './flow';
import type { Recorder } from './useRecorder';
import { errorText } from './bridge';
import { LevelMeter, PanelFrame } from './PanelFrame';
import { StaplerIcon } from './icons';
import { acceleratorCombo } from './StaplerSettings';
import type { PuckMood } from './PuckFace';

export function MeetingPanel({ rec, accelerator, micBusy, onOpenLibrary, onClose, mood }: {
  rec: Recorder;
  accelerator: string;
  /** A message recording holds the microphone. */
  micBusy: boolean;
  onOpenLibrary: (id?: string) => void;
  onClose: () => void;
  mood: PuckMood;
}) {
  const { t } = useTranslation();
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const { flow, saved } = rec;

  let body;
  switch (flow.phase) {
    case 'starting':
      body = (
        <div className="cth-stapler-row">
          <Spinner label={t('stapler.meeting.starting')} />
          <span className="cth-stapler-text">{t('stapler.meeting.starting')}</span>
          <span className="cth-stapler-spacer" />
          <Button size="sm" variant="ghost" onClick={rec.cancel}>{t('stapler.rec.cancel')}</Button>
        </div>
      );
      break;
    case 'recording':
      body = (
        <>
          <div className="cth-stapler-row">
            <span className="cth-stapler-clock cth-stapler-clock--big">{formatDuration(elapsedMs(flow, rec.now))}</span>
          </div>
          <LevelMeter label={t('stapler.rec.you')} level={rec.levels.mic} />
          <LevelMeter label={t('stapler.rec.them')} level={rec.levels.system} />
          <p className="cth-stapler-help">{t('stapler.meeting.recordingHelp')}</p>
          <div className="cth-stapler-row">
            <Button variant="primary" icon={<StaplerIcon name="stop" />} onClick={rec.stop}>{t('stapler.meeting.stop')}</Button>
            <span className="cth-stapler-spacer" />
            {confirmDiscard ? (
              <>
                <Button size="sm" variant="danger" onClick={() => { setConfirmDiscard(false); rec.cancel(); }}>{t('stapler.meeting.discardConfirm')}</Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirmDiscard(false)}>{t('stapler.compose.keep')}</Button>
              </>
            ) : (
              <Button size="sm" variant="ghost" icon={<StaplerIcon name="trash" />} onClick={() => setConfirmDiscard(true)}>{t('stapler.meeting.discard')}</Button>
            )}
          </div>
        </>
      );
      break;
    case 'stopping':
    case 'transcribing':
      body = (
        <>
          <div className="cth-stapler-row">
            <Spinner label={t('stapler.meeting.transcribing')} />
            <span className="cth-stapler-text">{t('stapler.meeting.transcribing')}</span>
          </div>
          <p className="cth-stapler-help">{t('stapler.meeting.transcribingHelp')}</p>
        </>
      );
      break;
    case 'error':
      body = (
        <div className="cth-stapler-notice cth-stapler-notice--danger" role="alert">
          <p>{t('stapler.meeting.failed', { error: errorText(t, flow.error) })}</p>
          <div className="cth-stapler-row">
            {saved && <Button size="sm" onClick={() => onOpenLibrary(saved.id)}>{t('stapler.meeting.openSaved')}</Button>}
            {flow.failedIn === 'transcribing' && <Button size="sm" onClick={rec.retry}>{t('stapler.rec.retry')}</Button>}
            <Button size="sm" variant="ghost" onClick={rec.cancel}>{t('stapler.rec.dismiss')}</Button>
          </div>
        </div>
      );
      break;
    default:
      body = (
        <>
          <p className="cth-stapler-text">{t('stapler.meeting.intro')}</p>
          <div className="cth-stapler-row">
            <Button variant="primary" icon={<StaplerIcon name="record" />} disabled={micBusy} onClick={rec.start}>
              {t('stapler.meeting.start')}
            </Button>
            <KeyHint combo={acceleratorCombo(accelerator)} />
          </div>
          {micBusy && <p className="cth-stapler-help">{t('stapler.rec.micBusy')}</p>}
          <p className="cth-stapler-help">{t('stapler.meeting.privacy')}</p>
        </>
      );
  }

  return (
    <PanelFrame
      title={t('stapler.meeting.title')}
      mood={mood}
      onClose={onClose}
      foot={
        <>
          <Button size="sm" variant="ghost" icon={<StaplerIcon name="library" />} onClick={() => onOpenLibrary()}>
            {t('stapler.meeting.library')}
          </Button>
        </>
      }
    >
      {saved && (flow.phase === 'done' || flow.phase === 'idle') && (
        <div className={`cth-stapler-notice${saved.status === 'ready' ? ' cth-stapler-notice--ok' : ' cth-stapler-notice--danger'}`} role="status">
          <p>{saved.status === 'ready' ? t('stapler.meeting.saved', { title: saved.title }) : t('stapler.meeting.savedFailed', { title: saved.title })}</p>
          <div className="cth-stapler-row">
            <Button size="sm" onClick={() => onOpenLibrary(saved.id)}>{t('stapler.meeting.openSaved')}</Button>
          </div>
        </div>
      )}
      {body}
    </PanelFrame>
  );
}
