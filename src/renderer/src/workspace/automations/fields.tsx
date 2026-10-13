/**
 * The Automations screen's form pieces. There is no Save button anywhere on
 * this screen, so every control here commits on its own:
 *
 *   text      saves when you leave the field (blur, or Enter on one line);
 *             Escape puts the stored value back
 *   switches, selects, day toggles
 *             save at once
 *
 * `useSaveState` is the row's quiet "Saving… / Saved" line, and the place an
 * error that came back from main is said out loud, next to what failed.
 */
import {
  useCallback, useEffect, useId, useRef, useState,
  type KeyboardEvent as ReactKeyboardEvent, type ReactNode
} from 'react';
import { useTranslation } from 'react-i18next';
import { blurDecision, normalizeFieldText, type TextFieldRule } from '@shared/workspace/automations';
import { WsIcon } from '../ui';
import type { WriteOutcome } from './useAutomationsData';

/* ──────────────────────────────── save state ────────────────────────────── */

export type SaveState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved' }
  | { kind: 'error'; message: string };

const SAVED_FOR_MS = 1800;

/**
 * Wrap a write so the row can show what happened to it. Overlapping writes are
 * counted: "Saved" appears only when the LAST one lands, and any failure wins
 * until the next write starts.
 */
export function useSaveState(describeError: (code: string) => string) {
  const [state, setState] = useState<SaveState>({ kind: 'idle' });
  const pending = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const failed = useRef(false);
  const alive = useRef(true);

  useEffect(() => () => {
    alive.current = false;
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const track = useCallback(async <T extends WriteOutcome>(write: Promise<T>): Promise<T> => {
    if (timer.current) clearTimeout(timer.current);
    if (pending.current === 0) failed.current = false;
    pending.current += 1;
    setState({ kind: 'saving' });
    const res = await write;
    pending.current -= 1;
    if (!alive.current) return res;
    if (!res.ok) {
      failed.current = true;
      setState({ kind: 'error', message: describeError(res.error) });
    } else if (pending.current === 0 && !failed.current) {
      setState({ kind: 'saved' });
      timer.current = setTimeout(() => { if (alive.current) setState({ kind: 'idle' }); }, SAVED_FOR_MS);
    }
    return res;
  }, [describeError]);

  /** Report a problem that never reached main (a refused field, a blocked switch). */
  const fail = useCallback((message: string) => {
    if (timer.current) clearTimeout(timer.current);
    setState({ kind: 'error', message });
  }, []);

  const clear = useCallback(() => setState({ kind: 'idle' }), []);

  return { state, track, fail, clear };
}

export function SaveNote({ state }: { state: SaveState }) {
  const { t } = useTranslation();
  if (state.kind === 'idle') return null;
  if (state.kind === 'error') {
    return <span className="cth-ws-automations-savestate" data-state="error" role="alert">{state.message}</span>;
  }
  return (
    <span className="cth-ws-automations-savestate" data-state={state.kind} aria-live="polite">
      {state.kind === 'saved' && <WsIcon name="check" />}
      {state.kind === 'saving' ? t('wsAutomations.save.saving') : t('wsAutomations.save.saved')}
    </span>
  );
}

/* ─────────────────────────────────── field ──────────────────────────────── */

export function Field({ label, hint, error, wide, children, htmlFor }: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  wide?: boolean;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className={`cth-ws-automations-field${wide ? ' cth-ws-automations-field--wide' : ''}`}>
      <label className="cth-ws-automations-label" htmlFor={htmlFor}>{label}</label>
      {children}
      {error ? <p className="cth-ws-automations-fielderr" role="alert">{error}</p>
        : hint ? <p className="cth-ws-automations-hint">{hint}</p> : null}
    </div>
  );
}

/* ───────────────────────────────── blur text ────────────────────────────── */

export interface BlurTextProps {
  /** What is stored. The draft follows it whenever the field is not focused,
   *  so another window's (or Classic's) save shows up without a reload. */
  value: string;
  /** Persist. Called only when the normalised text actually changed. */
  onCommit: (value: string) => Promise<WriteOutcome> | void;
  label: ReactNode;
  hint?: ReactNode;
  rule?: TextFieldRule;
  /** Text that may not be stored at all (bad JSON): the draft stays for fixing
   *  and the message shows under the field. Return null when it is fine. */
  validate?: (value: string) => string | null;
  multiline?: boolean;
  rows?: number;
  placeholder?: string;
  mono?: boolean;
  wide?: boolean;
  autoFocus?: boolean;
  /** Called with a refusal (`required`, `tooLong`) — the field restores the
   *  stored value itself; the row decides how to word it. */
  onReject?: (reason: 'required' | 'tooLong') => void;
  /** Count characters against `rule.maxLength` once past this share of it. */
  showCountFrom?: number;
  ariaLabel?: string;
}

/**
 * A text input (or textarea) that saves on blur.
 *
 * Enter commits a single-line field (and leaves it, which is what "done" means
 * without a button); a textarea keeps Enter for newlines and commits when focus
 * moves on, or on Mod+Enter. An Enter that confirms an IME candidate is not a
 * commit.
 */
export function BlurText({
  value, onCommit, label, hint, rule = {}, validate, multiline, rows = 4, placeholder,
  mono, wide, autoFocus, onReject, showCountFrom = 0.8, ariaLabel
}: BlurTextProps) {
  const { t } = useTranslation();
  const id = useId();
  const [draft, setDraft] = useState(value);
  const [focused, setFocused] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  // Escape sets this so the blur it triggers does not commit the discarded draft.
  const skipCommit = useRef(false);

  useEffect(() => {
    if (!focused) setDraft(value);
  }, [value, focused]);

  useEffect(() => {
    if (!autoFocus) return;
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.select();
    // Only on mount: a re-render must not steal focus back.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const commit = () => {
    if (skipCommit.current) { skipCommit.current = false; return; }
    if (validate) {
      const problem = validate(normalizeFieldText(draft, rule));
      if (problem) { setError(problem); return; }
    }
    const d = blurDecision(value, draft, rule);
    if (d.action === 'none') { setError(null); setDraft(value); return; }
    if (d.action === 'reject') {
      setDraft(d.restore);
      setError(d.reason === 'required' ? t('wsAutomations.field.required') : t('wsAutomations.field.tooLong', { max: rule.maxLength }));
      onReject?.(d.reason);
      return;
    }
    setError(null);
    setDraft(d.value);
    const res = onCommit(d.value);
    if (res && typeof (res as Promise<WriteOutcome>).then === 'function') {
      void (res as Promise<WriteOutcome>).then((r) => {
        // A failed write: put the draft back so the field shows the truth. The
        // row's save line says why.
        if (!r.ok) setDraft(value);
      });
    }
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      skipCommit.current = true;
      setDraft(value);
      setError(null);
      (e.currentTarget as HTMLElement).blur();
      return;
    }
    if (e.key === 'Enter' && (!multiline || e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      (e.currentTarget as HTMLElement).blur();
    }
  };

  const max = rule.maxLength;
  const count = max && draft.length >= max * showCountFrom
    ? t('wsAutomations.field.count', { n: draft.length, max })
    : null;

  const common = {
    id,
    ref,
    value: draft,
    placeholder,
    'aria-label': ariaLabel,
    'aria-invalid': error ? true : undefined,
    dir: 'auto' as const,
    spellCheck: multiline ? true : false,
    onChange: (e: { target: { value: string } }) => { setDraft(e.target.value); if (error) setError(null); },
    onFocus: () => setFocused(true),
    onBlur: () => { setFocused(false); commit(); },
    onKeyDown
  };

  return (
    <Field label={label} htmlFor={id} wide={wide} error={error} hint={count ?? hint}>
      {multiline
        ? <textarea {...common} rows={rows} className={`cth-ws-automations-textarea${mono ? ' cth-ws-automations-mono' : ''}`} />
        : <input {...common} type="text" className={`cth-ws-automations-input${mono ? ' cth-ws-automations-mono' : ''}`} />}
    </Field>
  );
}

/* ───────────────────────────────── kind icon ────────────────────────────── */

const KIND_PATHS = {
  schedule: 'M8 2.5a5.5 5.5 0 1 0 0 11a5.5 5.5 0 1 0 0-11zM8 5v3.2l2.2 1.4',
  context: 'M4 2.5h5.5l2.5 2.5v8.5H4zM6.5 7.5h3M6.5 10h3',
  webhook: 'M8 2.5v6.5M5.2 6.4L8 9.2l2.8-2.8M2.5 10v3.5h11V10'
} as const;

/** 16px stroke glyph for a row's kind, drawn like the Workspace's WsIcon set. */
export function KindIcon({ kind }: { kind: keyof typeof KIND_PATHS }) {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={KIND_PATHS[kind]} />
    </svg>
  );
}
