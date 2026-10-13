/**
 * A text field that saves when you leave it (or press Enter) — the Workspace
 * has no Save buttons. Escape puts back the saved value. The caller parses:
 * `parse` returns the value to save, or 'invalid' to refuse it with a mark on
 * the field instead of a write.
 */
import { useEffect, useRef, useState } from 'react';

export interface CommitInputProps<T> {
  /** The saved value, rendered by `format` while the field is not being edited. */
  value: T;
  format: (v: T) => string;
  parse: (text: string) => T | 'invalid';
  /** Persist. A rejection keeps the typed text and marks the field invalid. */
  onCommit: (v: T) => Promise<unknown> | void;
  /** Called on every keystroke with the parsed value (for live warnings). */
  onDraft?: (v: T | 'invalid' | null) => void;
  placeholder?: string;
  ariaLabel: string;
  wide?: boolean;
  inputMode?: 'decimal' | 'numeric' | 'text';
  disabled?: boolean;
}

export function CommitInput<T>({
  value, format, parse, onCommit, onDraft, placeholder, ariaLabel, wide, inputMode = 'text', disabled
}: CommitInputProps<T>) {
  const [text, setText] = useState(() => format(value));
  const [invalid, setInvalid] = useState(false);
  const editing = useRef(false);
  const skipBlur = useRef(false);

  // Follow the saved value while the field is not being edited (another
  // window, a push from main, a reconcile after a failed write).
  useEffect(() => {
    if (!editing.current) { setText(format(value)); setInvalid(false); }
  }, [value, format]);

  const commit = async () => {
    editing.current = false;
    const parsed = parse(text);
    if (parsed === 'invalid') { setInvalid(true); return; }
    setInvalid(false);
    if (format(parsed) === format(value)) { setText(format(value)); onDraft?.(null); return; }
    try {
      await onCommit(parsed);
      onDraft?.(null);
    } catch {
      setInvalid(true);
    }
  };

  return (
    <input
      className={`cth-ws-orch-input${wide ? ' cth-ws-orch-input--wide' : ''}`}
      value={text}
      placeholder={placeholder}
      aria-label={ariaLabel}
      aria-invalid={invalid || undefined}
      inputMode={inputMode}
      spellCheck={false}
      disabled={disabled}
      onFocus={() => { editing.current = true; }}
      onChange={(e) => {
        editing.current = true;
        setText(e.target.value);
        setInvalid(false);
        onDraft?.(parse(e.target.value));
      }}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing) return;
        if (e.key === 'Enter') { e.currentTarget.blur(); }
        else if (e.key === 'Escape') {
          skipBlur.current = true;
          editing.current = false;
          setText(format(value));
          setInvalid(false);
          onDraft?.(null);
          e.currentTarget.blur();
        }
      }}
      onBlur={() => {
        if (skipBlur.current) { skipBlur.current = false; return; }
        void commit();
      }}
    />
  );
}
