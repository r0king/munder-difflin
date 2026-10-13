/**
 * Floating surfaces for the sidebar: the right-click menu, the gear menu, the
 * "Send to…" picker and the ticket hover card.
 *
 * Portalled to <body> and positioned `fixed`: the sidebar column clips its
 * overflow (it scrolls), so anything anchored inside it would be cut off at
 * its edge. Placement is measured after mount and clamped into the viewport,
 * and it mirrors under Arabic: a card that opens beside the sidebar opens
 * toward the main area, which is on the LEFT when the sidebar is on the right.
 */
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState
} from 'react';
import { createPortal } from 'react-dom';
import { useRtl } from '@/i18n/useDirection';

export type PopoverAnchor =
  /** A pointer position (a context menu). */
  | { kind: 'point'; x: number; y: number }
  /** Beside the sidebar column, level with `rect` (the ticket card). */
  | { kind: 'side'; rect: DOMRect; edge: DOMRect }
  /** Above `rect`, start-aligned (the gear menu at the sidebar's foot). */
  | { kind: 'above'; rect: DOMRect }
  /** Below `rect`, start-aligned. */
  | { kind: 'below'; rect: DOMRect };

const GAP = 4;
const MARGIN = 8;

function place(anchor: PopoverAnchor, w: number, h: number, rtl: boolean): { left: number; top: number } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let left: number;
  let top: number;
  switch (anchor.kind) {
    case 'point':
      left = rtl ? anchor.x - w : anchor.x;
      top = anchor.y;
      if (left + w > vw - MARGIN) left = anchor.x - w;
      if (left < MARGIN) left = anchor.x;
      if (top + h > vh - MARGIN) top = anchor.y - h;
      break;
    case 'side':
      left = rtl ? anchor.edge.left - w - GAP : anchor.edge.right + GAP;
      top = anchor.rect.top;
      break;
    case 'above':
      left = rtl ? anchor.rect.right - w : anchor.rect.left;
      top = anchor.rect.top - h - GAP;
      if (top < MARGIN) top = anchor.rect.bottom + GAP;
      break;
    case 'below':
      left = rtl ? anchor.rect.right - w : anchor.rect.left;
      top = anchor.rect.bottom + GAP;
      if (top + h > vh - MARGIN) top = anchor.rect.top - h - GAP;
      break;
  }
  return {
    left: Math.max(MARGIN, Math.min(left, vw - w - MARGIN)),
    top: Math.max(MARGIN, Math.min(top, vh - h - MARGIN))
  };
}

export interface PopoverProps {
  anchor: PopoverAnchor;
  onClose: () => void;
  children: ReactNode;
  role?: 'menu' | 'dialog' | 'tooltip';
  ariaLabel?: string;
  className?: string;
  /** Focus the first focusable child on open (menus). */
  autoFocus?: boolean;
  /** Pointer handlers, for a hover card that stays open while hovered. */
  onPointerEnter?: () => void;
  onPointerLeave?: () => void;
  /** Close on a pointer-down outside (default true). A hover card sets false. */
  closeOnOutside?: boolean;
  /** The control that toggles this popover: a pointer-down on it is not
   *  "outside", so its own click can close what it opened. */
  toggleRef?: { current: HTMLElement | null };
}

export function Popover({
  anchor, onClose, children, role = 'dialog', ariaLabel, className, autoFocus,
  onPointerEnter, onPointerLeave, closeOnOutside = true, toggleRef
}: PopoverProps) {
  const rtl = useRtl();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setPos(place(anchor, el.offsetWidth, el.offsetHeight, rtl));
  }, [anchor, rtl]);

  useEffect(() => {
    if (!pos || !autoFocus) return;
    const first = ref.current?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled]), button:not([disabled]), input, textarea');
    first?.focus();
  }, [pos, autoFocus]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (!closeOnOutside) return;
      if (e.target instanceof Node) {
        if (ref.current?.contains(e.target)) return;
        if (toggleRef?.current?.contains(e.target)) return;
      }
      closeRef.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeRef.current(); }
    };
    const onBlur = () => closeRef.current();
    const onResize = () => closeRef.current();
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', onBlur);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('resize', onResize);
    };
  }, [closeOnOutside, toggleRef]);

  return createPortal(
    <div
      ref={ref}
      className={`cth-ws-sidebar-pop${className ? ` ${className}` : ''}`}
      role={role}
      aria-label={ariaLabel}
      dir={rtl ? 'rtl' : 'ltr'}
      style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: -9999, visibility: 'hidden' }}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onContextMenu={(e) => e.preventDefault()}
    >
      {children}
    </div>,
    document.body
  );
}

// ─── Menu ───────────────────────────────────────────────────────────────────

export type MenuEntry =
  | {
      key: string;
      label: ReactNode;
      onSelect: () => void;
      disabled?: boolean;
      danger?: boolean;
      hint?: ReactNode;
      /** Leave the menu open after selecting (a two-step confirm). */
      keepOpen?: boolean;
      title?: string;
    }
  | { key: string; separator: true }
  | { key: string; header: ReactNode }
  | { key: string; note: ReactNode; error?: boolean };

/** Arrow keys between items, Home/End, Enter/Space activate (native buttons). */
function onMenuKeyDown(e: ReactKeyboardEvent<HTMLDivElement>): void {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
  const items = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([disabled])')];
  if (!items.length) return;
  e.preventDefault();
  const i = items.indexOf(document.activeElement as HTMLButtonElement);
  let next = 0;
  if (e.key === 'ArrowDown') next = i < 0 ? 0 : (i + 1) % items.length;
  else if (e.key === 'ArrowUp') next = i < 0 ? items.length - 1 : (i - 1 + items.length) % items.length;
  else if (e.key === 'End') next = items.length - 1;
  items[next].focus();
}

export function MenuList({ entries, onClose }: { entries: readonly MenuEntry[]; onClose: () => void }) {
  return (
    <div onKeyDown={onMenuKeyDown}>
      {entries.map((entry) => {
        if ('separator' in entry) return <div key={entry.key} className="cth-ws-sidebar-menusep" role="separator" />;
        if ('header' in entry) return <div key={entry.key} className="cth-ws-sidebar-menuhead">{entry.header}</div>;
        if ('note' in entry) {
          return (
            <div key={entry.key} className={entry.error ? 'cth-ws-sidebar-menu-error' : 'cth-ws-sidebar-menu-note'} role="status">
              {entry.note}
            </div>
          );
        }
        return (
          <button
            key={entry.key}
            type="button"
            role="menuitem"
            className={`cth-ws-sidebar-menuitem${entry.danger ? ' cth-ws-sidebar-menuitem--danger' : ''}`}
            disabled={entry.disabled}
            title={entry.title}
            onClick={() => {
              entry.onSelect();
              if (!entry.keepOpen) onClose();
            }}
          >
            <span className="cth-ws-sidebar-menuitem-label">{entry.label}</span>
            {entry.hint && <span className="cth-ws-sidebar-menuitem-hint">{entry.hint}</span>}
          </button>
        );
      })}
    </div>
  );
}
