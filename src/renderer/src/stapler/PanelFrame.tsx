/**
 * The chrome every flow panel shares: a header with the little Stapler (click
 * it, or Esc, to fold back into the puck), a scrolling body, an optional foot.
 */
import { useEffect, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { IconButton } from '@/workspace/ui';
import { PuckFace, type PuckMood } from './PuckFace';
import { StaplerIcon } from './icons';

export function PanelFrame({ title, mood, onClose, onBack, children, foot, closeOnEscape = true }: {
  title: ReactNode;
  mood?: PuckMood;
  onClose: () => void;
  /** Shows a back arrow instead of the creature (the To list from compose). */
  onBack?: () => void;
  children: ReactNode;
  foot?: ReactNode;
  closeOnEscape?: boolean;
}) {
  const { t } = useTranslation();
  useEffect(() => {
    if (!closeOnEscape) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return;
      e.preventDefault();
      (onBack ?? onClose)();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onBack, onClose, closeOnEscape]);
  return (
    <section className="cth-stapler-panel" data-stapler-hit="">
      <header className="cth-stapler-panel-head">
        {onBack ? (
          <IconButton label={t('stapler.panel.back')} onClick={onBack} size="sm">
            <StaplerIcon name="back" />
          </IconButton>
        ) : (
          <button
            type="button"
            className="cth-stapler-face cth-stapler-face--small"
            aria-label={t('stapler.panel.fold')}
            title={t('stapler.panel.fold')}
            onClick={onClose}
          >
            <PuckFace mood={mood} />
          </button>
        )}
        <h1 className="cth-stapler-panel-title">{title}</h1>
        <IconButton label={t('stapler.panel.close')} onClick={onClose} size="sm" tip={false}>
          <StaplerIcon name="close" />
        </IconButton>
      </header>
      <div className="cth-stapler-panel-body">{children}</div>
      {foot && <footer className="cth-stapler-panel-foot">{foot}</footer>}
    </section>
  );
}

/** A horizontal level meter (0..1). */
export function LevelMeter({ label, level }: { label: string; level: number }) {
  // Speech RMS sits low; a gentle curve makes a normal voice fill half the bar.
  const pct = Math.round(Math.min(1, Math.sqrt(Math.max(0, level)) * 1.4) * 100);
  return (
    <div className="cth-stapler-meter">
      <span className="cth-stapler-meter-name">{label}</span>
      <span className="cth-stapler-meter-bar" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
        <span className="cth-stapler-meter-fill" style={{ width: `${pct}%` }} />
      </span>
    </div>
  );
}
