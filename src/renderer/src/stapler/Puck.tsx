/**
 * The Stapler puck: the floating creature, and the ring that opens on click
 * (Screenshot, Record message, Record meeting, Make invisible). Owned by the
 * `stapler` unit.
 *
 * FOUNDATION STUB — a token-coloured square so the window is visibly alive.
 */
import type { CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';

export function Puck() {
  const { t } = useTranslation();
  return (
    <div
      role="button"
      aria-label={t('stapler.title')}
      title={t('stapler.title')}
      style={{
        width: 56,
        height: 56,
        margin: 8,
        background: 'var(--cth-lemon)',
        boxShadow: 'inset 0 0 0 2px var(--cth-ink-900), var(--cth-shadow-hard)',
        // The whole puck is a drag handle until the unit builds its own.
        WebkitAppRegion: 'drag'
      } as CSSProperties}
    />
  );
}
