/**
 * Workspace UI primitives — the shared vocabulary every Workspace and Stapler
 * unit builds its screens from, so eleven people working in parallel produce
 * one product rather than eleven.
 *
 * Styling lives in ./workspace.css (imported here, once, so importing any
 * primitive brings it along — including in the Stapler's own window). Every
 * value there is a `--cth-*` token; nothing here takes a colour, a radius or a
 * pixel size as a prop. If a screen needs a variant that is not here, build it
 * in the unit's own file from these pieces rather than widening them ad hoc.
 *
 * Text that is part of the UI is translated by the caller and passed in as a
 * node; the only strings these components look up themselves are their own
 * accessibility labels and status words (namespace `ws`).
 */
import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useId,
  useState
} from 'react';
import { useTranslation } from 'react-i18next';
import { isActiveStatus, statusColorVar, statusLabel, type WsAgentStatus } from './agentStatus';
import './workspace.css';

const cx = (...parts: Array<string | false | null | undefined>): string => parts.filter(Boolean).join(' ');

// ─── ScreenHeader ───────────────────────────────────────────────────────────

export interface ScreenHeaderProps {
  title: ReactNode;
  subtitle?: ReactNode;
  /** Right-aligned controls (buttons, a SegmentedControl, a SearchInput). */
  actions?: ReactNode;
  /** Before the title (a back IconButton, a StatusDot). */
  leading?: ReactNode;
  /** Under the title row, flush with the header's bottom rule — put Tabs here. */
  children?: ReactNode;
}

/** The top of every Workspace screen. Pair with `.cth-ws-screen` +
 *  `.cth-ws-screen-body` (see Screen below). */
export function ScreenHeader({ title, subtitle, actions, leading, children }: ScreenHeaderProps) {
  return (
    <header className="cth-ws-header">
      <div className="cth-ws-header-row">
        {leading}
        <div className="cth-ws-header-text">
          <h1 className="cth-ws-header-title">{title}</h1>
          {subtitle !== undefined && subtitle !== null && subtitle !== '' && (
            <span className="cth-ws-header-subtitle">{subtitle}</span>
          )}
        </div>
        {actions && <div className="cth-ws-header-actions">{actions}</div>}
      </div>
      {children}
    </header>
  );
}

/** Screen scaffold: a header and a scrolling body. `fill` drops the body's
 *  padding and scroll for screens that lay out their own panes. */
export function Screen({ header, children, fill, bodyClassName }: {
  header: ReactNode;
  children?: ReactNode;
  fill?: boolean;
  bodyClassName?: string;
}) {
  return (
    <section className="cth-ws-screen">
      {header}
      <div className={cx('cth-ws-screen-body', fill && 'cth-ws-screen-body--fill', bodyClassName)}>{children}</div>
    </section>
  );
}

// ─── Card ───────────────────────────────────────────────────────────────────

export interface CardProps {
  children?: ReactNode;
  /** Makes the whole card a button (Enter/Space activate it). */
  onClick?: () => void;
  selected?: boolean;
  padding?: 'none' | 'sm' | 'md';
  className?: string;
  style?: CSSProperties;
  title?: string;
  ariaLabel?: string;
}

export function Card({ children, onClick, selected, padding = 'md', className, style, title, ariaLabel }: CardProps) {
  const clickable = !!onClick;
  return (
    <div
      className={cx(
        'cth-ws-card',
        padding !== 'none' && `cth-ws-card--pad-${padding}`,
        clickable && 'cth-ws-card--clickable',
        selected && 'cth-ws-card--selected',
        className
      )}
      style={style}
      title={title}
      aria-label={ariaLabel}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      aria-pressed={clickable && selected !== undefined ? selected : undefined}
      onClick={onClick}
      onKeyDown={clickable ? (e: ReactKeyboardEvent<HTMLDivElement>) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick?.(); }
      } : undefined}
    >
      {children}
    </div>
  );
}

// ─── Chip ───────────────────────────────────────────────────────────────────

export type ChipTone = 'neutral' | 'info' | 'warn' | 'danger' | 'ok' | 'accent';

export interface ChipProps {
  tone?: ChipTone;
  children?: ReactNode;
  icon?: ReactNode;
  title?: string;
  /** Renders as a button. */
  onClick?: () => void;
  className?: string;
}

export function Chip({ tone = 'neutral', children, icon, title, onClick, className }: ChipProps) {
  const cls = cx('cth-ws-chip', `cth-ws-chip--${tone}`, className);
  if (onClick) {
    return <button type="button" className={cls} title={title} onClick={onClick}>{icon}{children}</button>;
  }
  return <span className={cls} title={title}>{icon}{children}</span>;
}

// ─── Status ─────────────────────────────────────────────────────────────────

export interface StatusDotProps {
  status: WsAgentStatus;
  /** Edge in px; 8 by default (a multiple of 4 keeps rows on the grid). */
  size?: 8 | 12;
  /** Blink while active. Defaults to isActiveStatus(status). Reduced motion
   *  turns it off globally (global.css). */
  pulse?: boolean;
  /** Tooltip; defaults to the translated status word. */
  title?: string;
}

/** A square status mark (DESIGN.md: no rounded corners, ever). */
export function StatusDot({ status, size = 8, pulse, title }: StatusDotProps) {
  const { t } = useTranslation();
  const label = title ?? statusLabel(t, status);
  return (
    <span
      className={cx('cth-ws-dot', (pulse ?? isActiveStatus(status)) && 'cth-ws-dot--pulse')}
      style={{ width: size, height: size, background: statusColorVar(status) }}
      title={label}
      role="img"
      aria-label={label}
    />
  );
}

/** Dot + the status word ("Working", "Needs you"). */
export function StatusBadge({ status, label }: { status: WsAgentStatus; label?: ReactNode }) {
  const { t } = useTranslation();
  return (
    <span className="cth-ws-status">
      <StatusDot status={status} title="" />
      {label ?? statusLabel(t, status)}
    </span>
  );
}

// ─── Tabs ───────────────────────────────────────────────────────────────────

export interface TabItem<T extends string = string> {
  id: T;
  label: ReactNode;
  /** A count or short marker after the label; hidden when 0/undefined. */
  badge?: ReactNode;
}

export interface TabsProps<T extends string = string> {
  tabs: ReadonlyArray<TabItem<T>>;
  value: T;
  onChange: (id: T) => void;
  ariaLabel?: string;
}

/** Underlined tabs for a screen header. Arrow keys move between tabs. */
export function Tabs<T extends string = string>({ tabs, value, onChange, ariaLabel }: TabsProps<T>) {
  const move = (dir: 1 | -1) => {
    const i = tabs.findIndex((x) => x.id === value);
    const next = tabs[(i + dir + tabs.length) % tabs.length];
    if (next) onChange(next.id);
  };
  return (
    <div
      className="cth-ws-tabs"
      role="tablist"
      aria-label={ariaLabel}
      onKeyDown={(e) => {
        // Logical: "next" is to the right in English and to the left in Arabic.
        const rtl = document.documentElement.getAttribute('dir') === 'rtl';
        if (e.key === 'ArrowRight') { e.preventDefault(); move(rtl ? -1 : 1); }
        else if (e.key === 'ArrowLeft') { e.preventDefault(); move(rtl ? 1 : -1); }
      }}
    >
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          className="cth-ws-tab"
          aria-selected={tab.id === value}
          tabIndex={tab.id === value ? 0 : -1}
          onClick={() => onChange(tab.id)}
        >
          {tab.label}
          {tab.badge !== undefined && tab.badge !== null && tab.badge !== 0 && tab.badge !== '' && (
            <span className="cth-ws-tab-badge">{tab.badge}</span>
          )}
        </button>
      ))}
    </div>
  );
}

// ─── SegmentedControl ───────────────────────────────────────────────────────

export interface SegmentOption<T extends string = string> {
  value: T;
  label: ReactNode;
  title?: string;
  disabled?: boolean;
}

export interface SegmentedControlProps<T extends string = string> {
  options: ReadonlyArray<SegmentOption<T>>;
  value: T;
  onChange: (value: T) => void;
  size?: 'sm' | 'md';
  ariaLabel?: string;
  className?: string;
}

/** One-of-N switch (Board | List | Cards, Classic | Workspace). */
export function SegmentedControl<T extends string = string>({
  options, value, onChange, size = 'md', ariaLabel, className
}: SegmentedControlProps<T>) {
  return (
    <div className={cx('cth-ws-seg', size === 'sm' && 'cth-ws-seg--sm', className)} role="radiogroup" aria-label={ariaLabel}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          className="cth-ws-seg-item"
          aria-checked={o.value === value}
          title={o.title}
          disabled={o.disabled}
          onClick={() => { if (o.value !== value) onChange(o.value); }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ─── SearchInput ────────────────────────────────────────────────────────────

export interface SearchInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** Enter. */
  onSubmit?: (value: string) => void;
  autoFocus?: boolean;
  ariaLabel?: string;
  className?: string;
}

export function SearchInput({ value, onChange, placeholder, onSubmit, autoFocus, ariaLabel, className }: SearchInputProps) {
  const { t } = useTranslation();
  return (
    <label className={cx('cth-ws-search', className)}>
      <WsIcon name="search" />
      <input
        type="search"
        value={value}
        placeholder={placeholder ?? t('ws.ui.search')}
        aria-label={ariaLabel ?? placeholder ?? t('ws.ui.search')}
        autoFocus={autoFocus}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          // An IME candidate Enter is not a submit (see @shared/imeGuard).
          if (e.nativeEvent.isComposing) return;
          if (e.key === 'Enter') onSubmit?.(value);
          else if (e.key === 'Escape' && value) { e.preventDefault(); onChange(''); }
        }}
      />
      {value && (
        <button
          type="button"
          className="cth-ws-iconbtn cth-ws-iconbtn--sm"
          aria-label={t('ws.ui.clear')}
          onClick={() => onChange('')}
        >
          <WsIcon name="close" />
        </button>
      )}
    </label>
  );
}

// ─── Toggle ─────────────────────────────────────────────────────────────────

export interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Visible label after the switch. */
  label?: ReactNode;
  disabled?: boolean;
  /** Required when there is no visible label. */
  ariaLabel?: string;
  title?: string;
}

/** An on/off switch. Saves at once (the Workspace has no Save buttons). */
export function Toggle({ checked, onChange, label, disabled, ariaLabel, title }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      className="cth-ws-toggle"
      aria-checked={checked}
      aria-label={ariaLabel}
      title={title}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="cth-ws-toggle-track"><span className="cth-ws-toggle-thumb" /></span>
      {label}
    </button>
  );
}

// ─── Buttons ────────────────────────────────────────────────────────────────

export interface IconButtonProps {
  /** Accessible name AND tooltip text. */
  label: string;
  onClick?: () => void;
  children: ReactNode;
  /** Pressed state for toggles (aria-pressed). */
  active?: boolean;
  size?: 'sm' | 'md';
  disabled?: boolean;
  /** Show the styled `cth-tip` tooltip (default) or none. */
  tip?: boolean;
  className?: string;
}

export function IconButton({ label, onClick, children, active, size = 'md', disabled, tip = true, className }: IconButtonProps) {
  return (
    <button
      type="button"
      className={cx('cth-ws-iconbtn', size === 'sm' && 'cth-ws-iconbtn--sm', tip && 'cth-tip', className)}
      data-tip={tip ? label : undefined}
      aria-label={label}
      aria-pressed={active === undefined ? undefined : active}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export interface ButtonProps {
  children?: ReactNode;
  onClick?: () => void;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md';
  disabled?: boolean;
  type?: 'button' | 'submit';
  icon?: ReactNode;
  title?: string;
  className?: string;
  style?: CSSProperties;
}

export function Button({
  children, onClick, variant = 'secondary', size = 'md', disabled, type = 'button', icon, title, className, style
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cx('cth-ws-btn', `cth-ws-btn--${variant}`, size === 'sm' && 'cth-ws-btn--sm', className)}
      disabled={disabled}
      title={title}
      style={style}
      onClick={onClick}
    >
      {icon}
      {children}
    </button>
  );
}

// ─── EmptyState / Section / Spinner ─────────────────────────────────────────

export interface EmptyStateProps {
  title: ReactNode;
  body?: ReactNode;
  /** Buttons. */
  action?: ReactNode;
  icon?: ReactNode;
  compact?: boolean;
  /** Grow to fill the parent and centre vertically. */
  fill?: boolean;
}

export function EmptyState({ title, body, action, icon, compact, fill }: EmptyStateProps) {
  return (
    <div className={cx('cth-ws-empty', compact && 'cth-ws-empty--compact', fill && 'cth-ws-empty--fill')}>
      {icon && <div className="cth-ws-empty-icon">{icon}</div>}
      <p className="cth-ws-empty-title">{title}</p>
      {body && <p className="cth-ws-empty-body">{body}</p>}
      {action && <div className="cth-ws-empty-action">{action}</div>}
    </div>
  );
}

export interface SectionProps {
  title: ReactNode;
  /** Shown after the title, quiet. */
  count?: number;
  actions?: ReactNode;
  children?: ReactNode;
  /** Adds a disclosure toggle on the title. */
  collapsible?: boolean;
  defaultCollapsed?: boolean;
  className?: string;
}

export function Section({ title, count, actions, children, collapsible, defaultCollapsed, className }: SectionProps) {
  const [collapsed, setCollapsed] = useState(!!defaultCollapsed);
  const bodyId = useId();
  const heading = (
    <h2 className="cth-ws-section-title">
      {title}
      {count !== undefined && <span className="cth-ws-section-count"> · {count}</span>}
    </h2>
  );
  return (
    <section className={cx('cth-ws-section', className)}>
      <div className="cth-ws-section-head">
        {collapsible ? (
          <button
            type="button"
            className="cth-ws-section-toggle"
            aria-expanded={!collapsed}
            aria-controls={bodyId}
            onClick={() => setCollapsed((c) => !c)}
            style={{ flex: 1, minWidth: 0 }}
          >
            <WsIcon name={collapsed ? 'chevron-right' : 'chevron-down'} />
            {heading}
          </button>
        ) : heading}
        {actions}
      </div>
      {!(collapsible && collapsed) && <div id={bodyId}>{children}</div>}
    </section>
  );
}

/** Three stepping squares — "one sec". */
export function Spinner({ label }: { label?: string }) {
  return (
    <span className="cth-ws-spinner" role="status" aria-label={label}>
      <span /><span /><span />
    </span>
  );
}

// ─── KeyHint ────────────────────────────────────────────────────────────────

/** True on macOS (from the preload; never sniffed from navigator). */
export function isMac(): boolean {
  try { return window.cth?.platform === 'darwin'; } catch { return false; }
}

/**
 * Split a combo like 'Mod+\\' or 'Shift+Mod+Space' into display keys:
 * Mod is ⌘ on the Mac and Ctrl elsewhere, Alt is ⌥ / Alt, Shift is ⇧ / Shift.
 */
export function formatKeyCombo(combo: string, mac: boolean = isMac()): string[] {
  return combo.split('+').filter(Boolean).map((k) => {
    const key = k.trim();
    switch (key.toLowerCase()) {
      case 'mod': return mac ? '⌘' : 'Ctrl';
      case 'ctrl': case 'control': return mac ? '⌃' : 'Ctrl';
      case 'alt': case 'option': return mac ? '⌥' : 'Alt';
      case 'shift': return mac ? '⇧' : 'Shift';
      case 'enter': return '↵';
      case 'esc': case 'escape': return 'Esc';
      default: return key.length === 1 ? key.toUpperCase() : key;
    }
  });
}

/** Render a shortcut as keycaps: <KeyHint combo="Mod+," />. */
export function KeyHint({ combo, className }: { combo: string; className?: string }) {
  const keys = formatKeyCombo(combo);
  return (
    <span className={cx('cth-ws-keys', className)} aria-label={keys.join(' ')}>
      {keys.map((k, i) => <kbd key={i} className="cth-ws-key">{k}</kbd>)}
    </span>
  );
}

// ─── Icons ──────────────────────────────────────────────────────────────────

export type WsIconName =
  | 'orchestrator' | 'agents' | 'tasks' | 'inbox' | 'automations' | 'memory' | 'capabilities'
  | 'stapler' | 'sidebar' | 'search' | 'close' | 'plus' | 'chevron-down' | 'chevron-right'
  | 'chevron-left' | 'settings' | 'send' | 'mic' | 'attach' | 'more' | 'bell' | 'check';

/** Stroke paths on a 16-unit box. Kept to straight lines and simple arcs so
 *  they read at 16px beside Inter; the pixel icon set (components/Icon.tsx)
 *  stays the Classic office's. */
const ICON_PATHS: Record<WsIconName, string> = {
  orchestrator: 'M8 2.5v3M8 10.5v3M2.5 8h3M10.5 8h3M8 5.5a2.5 2.5 0 1 0 0 5a2.5 2.5 0 1 0 0-5z',
  agents: 'M6 7a2.25 2.25 0 1 0 0-4.5A2.25 2.25 0 0 0 6 7zM2 13.5c0-2.2 1.8-4 4-4s4 1.8 4 4M11 7.5a2 2 0 1 0 0-4M12 9.6c1.2.5 2 1.7 2 3.9',
  tasks: 'M3 3.5h10v9H3zM5.5 6.5l1.2 1.2L9 5.5M5.5 10h5',
  inbox: 'M2.5 9.5l1.5-6h8l1.5 6v3h-11zM2.5 9.5h3l.8 1.5h3.4l.8-1.5h3',
  automations: 'M8 2.5v2M8 11.5v2M3.2 5.2l1.4 1M11.4 9.8l1.4 1M3.2 10.8l1.4-1M11.4 6.2l1.4-1M8 6a2 2 0 1 0 0 4a2 2 0 1 0 0-4z',
  memory: 'M3 4.5c0-1.1 2.2-2 5-2s5 .9 5 2v7c0 1.1-2.2 2-5 2s-5-.9-5-2zM3 4.5c0 1.1 2.2 2 5 2s5-.9 5-2M3 8c0 1.1 2.2 2 5 2s5-.9 5-2',
  capabilities: 'M6 2.5h4v3H6zM3 10.5h4v3H3zM9 10.5h4v3H9zM8 5.5v2.5M5 10.5V8h6v2.5',
  stapler: 'M2.5 9.5h11v3h-11zM3.5 9.5L4.5 5h8l-1 4.5M6 5l.5-2h4.5l1 2',
  sidebar: 'M2.5 3h11v10h-11zM6 3v10',
  search: 'M7 3a4 4 0 1 0 0 8a4 4 0 1 0 0-8zM10 10l3.5 3.5',
  close: 'M4 4l8 8M12 4l-8 8',
  plus: 'M8 3v10M3 8h10',
  'chevron-down': 'M4 6l4 4l4-4',
  'chevron-right': 'M6 4l4 4l-4 4',
  'chevron-left': 'M10 4l-4 4l4 4',
  settings: 'M8 5.5a2.5 2.5 0 1 0 0 5a2.5 2.5 0 1 0 0-5zM8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4',
  send: 'M2.5 8h10M8.5 4l4 4l-4 4',
  mic: 'M8 2.5a2 2 0 0 0-2 2v3a2 2 0 1 0 4 0v-3a2 2 0 0 0-2-2zM4 7.5a4 4 0 0 0 8 0M8 11.5v2',
  attach: 'M11 7.5l-4 4a2.1 2.1 0 0 1-3-3l4.5-4.5a1.4 1.4 0 0 1 2 2L6 10.5',
  more: 'M3.5 8h.01M8 8h.01M12.5 8h.01',
  bell: 'M4 11V7.5a4 4 0 0 1 8 0V11l1 1.5H3zM6.5 13.5a1.5 1.5 0 0 0 3 0',
  check: 'M3 8.5l3 3l7-7'
};

/** A 16px stroke icon in `currentColor`. Decorative (aria-hidden) — give the
 *  surrounding control its accessible name. */
export function WsIcon({ name, size = 16 }: { name: WsIconName; size?: 16 | 20 | 24 }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={name === 'more' ? 2.4 : 1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      style={{ imageRendering: 'auto', flexShrink: 0 }}
    >
      <path d={ICON_PATHS[name]} />
    </svg>
  );
}
