/**
 * "New automation" → Schedule / Context rule / Webhook.
 *
 * A small menu button: arrow keys move, Enter picks, Escape closes and hands
 * focus back to the button, a click anywhere else closes it. The Workspace has
 * no menu primitive, so this is built from its button and tokens.
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AutomationKind } from '@shared/workspace/automations';
import { Button, WsIcon } from '../ui';
import { KindIcon } from './fields';

const KINDS: AutomationKind[] = ['schedule', 'context', 'webhook'];

export function NewAutomationMenu({ onPick, busy }: { onPick: (kind: AutomationKind) => void; busy?: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const items = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    if (!open) return;
    items.current[0]?.focus();
    const onDown = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) wrap.current?.querySelector<HTMLButtonElement>('button[aria-haspopup]')?.focus();
  };

  const move = (dir: 1 | -1) => {
    const i = items.current.findIndex((el) => el === document.activeElement);
    const next = (i + dir + KINDS.length) % KINDS.length;
    items.current[next]?.focus();
  };

  return (
    <div className="cth-ws-automations-menuwrap" ref={wrap}>
      <button
        type="button"
        className="cth-ws-btn cth-ws-btn--primary"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={busy}
        onClick={() => setOpen((o) => !o)}
      >
        <WsIcon name="plus" />
        {t('wsAutomations.new.button')}
        <WsIcon name="chevron-down" />
      </button>
      {open && (
        <div
          className="cth-ws-automations-menu"
          role="menu"
          aria-label={t('wsAutomations.new.button')}
          onKeyDown={(e) => {
            if (e.key === 'Escape') { e.preventDefault(); close(true); }
            else if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
            else if (e.key === 'Tab') close(false);
          }}
        >
          {KINDS.map((kind, i) => (
            <button
              key={kind}
              ref={(el) => { items.current[i] = el; }}
              type="button"
              role="menuitem"
              className="cth-ws-automations-menuitem"
              onClick={() => { close(false); onPick(kind); }}
            >
              <KindIcon kind={kind} />
              <span>
                {t(`wsAutomations.kind.${kind}`)}
                <small>{t(`wsAutomations.new.${kind}Blurb`)}</small>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Re-exported so the screen's empty state can offer the same three choices
 *  as plain buttons. */
export function NewAutomationButtons({ onPick, busy }: { onPick: (kind: AutomationKind) => void; busy?: boolean }) {
  const { t } = useTranslation();
  return (
    <>
      {KINDS.map((kind) => (
        <Button key={kind} variant="secondary" disabled={busy} icon={<KindIcon kind={kind} />} onClick={() => onPick(kind)}>
          {t(`wsAutomations.kind.${kind}`)}
        </Button>
      ))}
    </>
  );
}
