/**
 * A card's ⋯ menu: move it to a column, give it to someone, open it, undo.
 * The mouse-and-keyboard alternative to dragging — and the only way to change
 * an owner from the Board or the Cards view. Every choice STAGES a change
 * (onStage); nothing here writes the ledger.
 *
 * Rendered in a portal with fixed positioning: the board's columns scroll, and
 * an absolutely positioned menu inside one would be clipped by it. A portal
 * still bubbles React events to the card, so the menu stops propagation at
 * its root — a click on "Doing" must not also open the card, and an arrow key
 * must not also move board focus.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { TASK_COLUMNS, type TaskColumn } from '@shared/workspace/tasks';
import { WsIcon } from '../ui';
import { COLUMN_META } from './meta';
import type { AgentOption } from './useTaskBoard';

export interface TaskMenuProps {
  column: TaskColumn;
  owner: string | null;
  owners: readonly AgentOption[];
  hasStaged: boolean;
  /** Tab stop or not (roving focus on the board). */
  tabIndex?: number;
  onStage: (change: { toColumn?: TaskColumn; toOwner?: string | null }) => void;
  onOpen: () => void;
  onUndo: () => void;
}

const MENU_MAX_HEIGHT = 320;

export function TaskMenu({ column, owner, owners, hasStaged, tabIndex, onStage, onOpen, onUndo }: TaskMenuProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<CSSProperties | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  }, []);

  useLayoutEffect(() => {
    if (!open || !button.current) return;
    const r = button.current.getBoundingClientRect();
    const rtl = document.documentElement.getAttribute('dir') === 'rtl';
    const below = window.innerHeight - r.bottom;
    const style: CSSProperties = { position: 'fixed', zIndex: 290 };
    if (below >= Math.min(MENU_MAX_HEIGHT, 200) || r.top < below) style.top = r.bottom + 2;
    else style.bottom = window.innerHeight - r.top + 2;
    // Align the menu's inline-end with the button's.
    if (rtl) style.left = Math.max(4, r.left);
    else style.right = Math.max(4, window.innerWidth - r.right);
    setPos(style);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const first = menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)');
    first?.focus();
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (menu.current?.contains(target) || button.current?.contains(target)) return;
      close(false);
    };
    // The menu is pinned to where the button WAS; once the page under it
    // scrolls, it would float over the wrong card. Its own scrolling is fine.
    const onScroll = (e: Event) => {
      if (menu.current?.contains(e.target as Node)) return;
      close(false);
    };
    const onResize = () => close(false);
    document.addEventListener('mousedown', onDown, true);
    window.addEventListener('resize', onResize);
    document.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('resize', onResize);
      document.removeEventListener('scroll', onScroll, true);
    };
  }, [open, close]);

  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>) => {
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); close(true); return; }
    if (e.key === 'Tab') { close(false); return; }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
    if (!items.length) return;
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === 'Home' ? 0
      : e.key === 'End' ? items.length - 1
        : e.key === 'ArrowDown' ? (i + 1) % items.length
          : (i - 1 + items.length) % items.length;
    items[next].focus();
  };

  const pick = (fn: () => void) => () => { fn(); close(true); };

  return (
    <>
      <button
        ref={button}
        type="button"
        className="cth-ws-iconbtn cth-ws-iconbtn--sm"
        aria-label={t('wsTasks.menu.label')}
        title={t('wsTasks.menu.label')}
        aria-haspopup="menu"
        aria-expanded={open}
        tabIndex={tabIndex}
        draggable={false}
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
        onKeyDown={(e) => {
          // Enter/Space on the button are the button's, not the board's.
          if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
            e.stopPropagation();
            if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); }
          }
        }}
      >
        <WsIcon name="more" />
      </button>
      {open && createPortal(
        <div
          ref={menu}
          role="menu"
          aria-label={t('wsTasks.menu.label')}
          className="cth-ws-tasks-menu"
          style={pos ?? { position: 'fixed', visibility: 'hidden' }}
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          onKeyDown={onMenuKey}
        >
          <div className="cth-ws-tasks-menu-label">{t('wsTasks.menu.moveTo')}</div>
          {TASK_COLUMNS.map((c) => (
            <button
              key={c}
              type="button"
              role="menuitemradio"
              aria-checked={c === column}
              className="cth-ws-tasks-menu-item"
              onClick={pick(() => onStage({ toColumn: c }))}
            >
              <span className="cth-ws-tasks-swatch" style={{ background: COLUMN_META[c].accent }} />
              {t(COLUMN_META[c].labelKey)}
            </button>
          ))}
          <div className="cth-ws-tasks-menu-sep" />
          <div className="cth-ws-tasks-menu-label">{t('wsTasks.menu.owner')}</div>
          <button
            type="button"
            role="menuitemradio"
            aria-checked={owner === null}
            className="cth-ws-tasks-menu-item"
            onClick={pick(() => onStage({ toOwner: null }))}
          >
            {t('wsTasks.unassigned')}
          </button>
          {owners.map((o) => (
            <button
              key={o.id}
              type="button"
              role="menuitemradio"
              aria-checked={owner === o.id}
              className="cth-ws-tasks-menu-item"
              onClick={pick(() => onStage({ toOwner: o.id }))}
            >
              <span className="cth-ws-ellipsis">{o.isGod ? t('wsTasks.ownerGod', { name: o.name }) : o.name}</span>
              {!o.live && <span className="cth-ws-muted">{t('wsTasks.ownerAway')}</span>}
            </button>
          ))}
          <div className="cth-ws-tasks-menu-sep" />
          <button type="button" role="menuitem" className="cth-ws-tasks-menu-item" onClick={pick(onOpen)}>
            {t('wsTasks.menu.open')}
          </button>
          {hasStaged && (
            <button type="button" role="menuitem" className="cth-ws-tasks-menu-item" onClick={pick(onUndo)}>
              {t('wsTasks.menu.undo')}
            </button>
          )}
        </div>,
        document.body
      )}
    </>
  );
}
