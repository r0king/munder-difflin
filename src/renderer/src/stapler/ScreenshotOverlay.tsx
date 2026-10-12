/**
 * Full-screen overlay for dragging a screenshot region, adding a note, and
 * sending (up to eight shots per send; the last region is remembered). Owned
 * by the `stapler` unit.
 *
 * FOUNDATION STUB — a dimmed layer with the title, so an opened overlay is
 * obviously not a frozen screen.
 */
import { useTranslation } from 'react-i18next';

export function ScreenshotOverlay() {
  const { t } = useTranslation();
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(26, 19, 32, 0.25)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: 'var(--cth-font-ui)',
        color: 'var(--cth-cream-50)'
      }}
    >
      {t('stapler.title')}
    </div>
  );
}
