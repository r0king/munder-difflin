/**
 * The two titlebar controls the feature layer adds, in BOTH interfaces: the
 * Classic | Workspace switch and the Stapler toggle. Kept out of App.tsx so
 * App only places them.
 *
 * Both sit in the macOS drag region, so each carries `cth-titlebar-nodrag`, and
 * both use the CSS `cth-tip` bubble — the native `title` does not render
 * reliably inside a hiddenInset titlebar (see global.css).
 */
import { useTranslation } from 'react-i18next';
import type { UiMode } from '@shared/features/route';
import { SegmentedControl, WsIcon } from './ui';
import { setStaplerEnabled, useStaplerState } from './useStaplerState';

export function UiModeSwitch({ mode, onChange }: { mode: UiMode; onChange: (mode: UiMode) => void }) {
  const { t } = useTranslation();
  return (
    <span className="cth-titlebar-nodrag cth-tip" data-tip={t('ws.mode.tip')} style={{ display: 'inline-flex' }}>
      <SegmentedControl<UiMode>
        size="sm"
        ariaLabel={t('ws.mode.label')}
        value={mode}
        onChange={onChange}
        options={[
          { value: 'classic', label: t('ws.mode.classic') },
          { value: 'workspace', label: t('ws.mode.workspace') }
        ]}
      />
    </span>
  );
}

export function StaplerTitlebarToggle() {
  const { t } = useTranslation();
  const { enabled } = useStaplerState();
  return (
    <button
      type="button"
      className="cth-titlebar-nodrag cth-tip"
      data-tip={enabled ? t('ws.stapler.on') : t('ws.stapler.off')}
      aria-label={t('ws.stapler.toggleAria')}
      aria-pressed={enabled}
      onClick={() => { void setStaplerEnabled(!enabled); }}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: 28, height: 28, padding: 0, border: 'none', cursor: 'pointer',
        color: 'var(--cth-ink-900)',
        background: enabled ? 'var(--cth-lemon-light)' : 'var(--cth-paper-100)',
        boxShadow: `inset 0 0 0 1px ${enabled ? 'var(--cth-lemon)' : 'var(--cth-ink-300)'}`
      }}
    >
      <WsIcon name="stapler" />
    </button>
  );
}
