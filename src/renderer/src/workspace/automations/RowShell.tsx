/**
 * One automation row: name, the one-line "when / what", an on/off switch, and
 * — expanded — the editor. Every kind (schedule, context rule, webhook) uses
 * this chrome, so the list reads as one list rather than three stacked forms.
 */
import { forwardRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Toggle, WsIcon } from '../ui';
import type { AutomationKind } from '@shared/workspace/automations';
import { KindIcon, SaveNote, type SaveState } from './fields';

export interface RowShellProps {
  kind: AutomationKind;
  name: string;
  description: string;
  /** Quiet extras before the switch: "Next in 3 h", a held-count chip. */
  meta?: ReactNode;
  enabled: boolean;
  onToggle: (on: boolean) => void;
  /** Why the switch cannot be turned on yet; the switch stays clickable and
   *  says so in the row instead of silently doing nothing. */
  toggleTitle?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  save: SaveState;
  /** The editor. Rendered only while open. */
  children?: ReactNode;
  /** Absent for rows that cannot be deleted (the built-in compact / clear). */
  onDelete?: () => void;
  bodyId: string;
}

export const RowShell = forwardRef<HTMLDivElement, RowShellProps>(function RowShell({
  kind, name, description, meta, enabled, onToggle, toggleTitle, open, onOpenChange, save, children, onDelete, bodyId
}, ref) {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState(false);
  const kindLabel = t(`wsAutomations.kind.${kind}`);

  return (
    <div ref={ref} className="cth-ws-automations-row" data-open={open} data-on={enabled}>
      <div className="cth-ws-automations-rowhead">
        <button
          type="button"
          className="cth-ws-automations-rowmain"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => onOpenChange(!open)}
        >
          <span className="cth-ws-automations-kind" title={kindLabel}>
            <KindIcon kind={kind} />
            <span style={srOnly}>{kindLabel}</span>
          </span>
          <span className="cth-ws-automations-text">
            <span className="cth-ws-automations-name" dir="auto">{name || t('wsAutomations.untitled')}</span>
            <span className="cth-ws-automations-desc" dir="auto">{description}</span>
          </span>
        </button>
        {/* While collapsed the save line sits in the row, so a switch flipped
            from the list still answers "saved" or "failed" where it was flipped. */}
        {!open && save.kind !== 'idle' && <SaveNote state={save} />}
        {meta && <span className="cth-ws-automations-meta">{meta}</span>}
        <Toggle
          checked={enabled}
          onChange={onToggle}
          ariaLabel={t(enabled ? 'wsAutomations.row.turnOff' : 'wsAutomations.row.turnOn', { name: name || t('wsAutomations.untitled') })}
          title={toggleTitle}
        />
        <button
          type="button"
          className="cth-ws-iconbtn cth-ws-iconbtn--sm cth-ws-automations-caret"
          aria-label={t(open ? 'wsAutomations.row.collapse' : 'wsAutomations.row.expand', { name: name || t('wsAutomations.untitled') })}
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => onOpenChange(!open)}
        >
          <WsIcon name={open ? 'chevron-down' : 'chevron-right'} />
        </button>
      </div>
      {open && (
        <div id={bodyId} className="cth-ws-automations-body">
          {children}
          <div className="cth-ws-automations-footer">
            <span className="cth-ws-automations-grow"><SaveNote state={save} /></span>
            {onDelete && !confirming && (
              <Button size="sm" variant="ghost" onClick={() => setConfirming(true)}>{t('wsAutomations.row.delete')}</Button>
            )}
            {onDelete && confirming && (
              <>
                <span className="cth-ws-automations-hint">{t('wsAutomations.row.deleteConfirm')}</span>
                <Button size="sm" variant="danger" onClick={() => { setConfirming(false); onDelete(); }}>{t('wsAutomations.row.deleteYes')}</Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>{t('wsAutomations.row.deleteNo')}</Button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
});

/** Visually hidden, still read out — the kind icon's name. */
const srOnly = {
  position: 'absolute', width: 1, height: 1, padding: 0, margin: -1,
  overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap', border: 0
} as const;
