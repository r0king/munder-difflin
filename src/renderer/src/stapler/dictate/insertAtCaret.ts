/**
 * Put dictated words at the caret of a Munder Difflin text box — the in-app
 * half of "dictate into any app" (main sends `feat:dictate:insert` to the
 * window that had focus when dictation started).
 *
 * Three kinds of field, three routes:
 *   - <input> / <textarea> and contenteditable (the composer, settings fields,
 *     CodeMirror, Monaco's hidden textarea): `document.execCommand('insertText')`.
 *     It inserts at the caret, joins the undo stack, and fires a real `input`
 *     event, which is what React's onChange and the editors listen to. Where
 *     it is refused, a native setRangeText + `input` event does the same for
 *     inputs (React notices because its value tracker no longer matches).
 *   - xterm's hidden textarea: a `paste` event carrying the text, so the words
 *     go through the terminal's own paste path (bracketed paste) and nothing
 *     is executed by accident.
 *
 * The words are fitted to the text around the caret first (fitToContext:
 * spaces, the capital, the full stop).
 *
 * DOM-only; no store import, so the Stapler's windows can use it too.
 */
import { fitToContext, type FitOptions } from '@shared/features/dictate';

type Field =
  | { kind: 'text'; el: HTMLInputElement | HTMLTextAreaElement }
  | { kind: 'rich'; el: HTMLElement }
  | { kind: 'terminal'; el: HTMLTextAreaElement };

/** Input types that hold free text. Password is deliberately absent:
 *  dictating a password into a field is never what someone meant. */
const TEXT_TYPES = new Set(['', 'text', 'search', 'url', 'tel', 'email']);

/** How much text either side of the caret fitToContext gets to see. */
const CONTEXT_CHARS = 200;

function deepActiveElement(doc: Document = document): Element | null {
  let el: Element | null = doc.activeElement;
  while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
  return el;
}

/** The editable field `el` belongs to, or null. */
export function fieldFor(el: Element | null): Field | null {
  if (!el) return null;
  if (el instanceof HTMLTextAreaElement) {
    if (el.classList.contains('xterm-helper-textarea')) return { kind: 'terminal', el };
    return el.readOnly || el.disabled ? null : { kind: 'text', el };
  }
  if (el instanceof HTMLInputElement) {
    if (!TEXT_TYPES.has(el.type.toLowerCase()) || el.readOnly || el.disabled) return null;
    return { kind: 'text', el };
  }
  if (el instanceof HTMLElement && el.isContentEditable) {
    // The editing host, not a span inside it.
    let host: HTMLElement = el;
    while (host.parentElement && host.parentElement.isContentEditable) host = host.parentElement;
    return { kind: 'rich', el: host };
  }
  return null;
}

function visible(el: HTMLElement): boolean {
  return el.isConnected && el.getClientRects().length > 0;
}

/**
 * Remembers the last field that had focus (and, for rich text, where its
 * caret was), so a dictation still lands in the composer after a click on a
 * button moved focus away from it.
 */
export function trackLastField(): { get(): { field: Field; range: Range | null } | null; dispose(): void } {
  let last: { field: Field; range: Range | null } | null = null;
  const onFocusIn = (e: FocusEvent): void => {
    const target = e.composedPath()[0];
    const field = fieldFor(target instanceof Element ? target : null);
    if (field) last = { field, range: null };
  };
  const onSelection = (): void => {
    if (!last || last.field.kind !== 'rich') return;
    const sel = document.getSelection();
    if (sel && sel.rangeCount > 0 && last.field.el.contains(sel.anchorNode)) last.range = sel.getRangeAt(0).cloneRange();
  };
  document.addEventListener('focusin', onFocusIn, true);
  document.addEventListener('selectionchange', onSelection);
  return {
    get: () => (last && visible(last.field.el) && fieldFor(last.field.el) ? last : null),
    dispose: () => {
      document.removeEventListener('focusin', onFocusIn, true);
      document.removeEventListener('selectionchange', onSelection);
      last = null;
    }
  };
}

function insertIntoText(el: HTMLInputElement | HTMLTextAreaElement, text: string, opts: FitOptions): boolean {
  const value = el.value;
  // email inputs have no selection API (selectionStart is null): append.
  const start = el.selectionStart ?? value.length;
  const end = el.selectionEnd ?? start;
  const fitted = fitToContext(text, value.slice(Math.max(0, start - CONTEXT_CHARS), start), value.slice(end, end + CONTEXT_CHARS), opts);
  if (!fitted) return true;
  if (document.activeElement !== el) el.focus({ preventScroll: true });
  if (document.execCommand('insertText', false, fitted)) return true;
  try {
    el.setRangeText(fitted, start, end, 'end');
  } catch {
    // email/number inputs refuse setRangeText; replace the whole value.
    el.value = value.slice(0, start) + fitted + value.slice(end);
  }
  el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: fitted }));
  return true;
}

function rangeText(root: HTMLElement, range: Range, side: 'before' | 'after'): string {
  const r = document.createRange();
  r.selectNodeContents(root);
  if (side === 'before') r.setEnd(range.startContainer, range.startOffset);
  else r.setStart(range.endContainer, range.endOffset);
  const s = r.toString();
  return side === 'before' ? s.slice(-CONTEXT_CHARS) : s.slice(0, CONTEXT_CHARS);
}

function insertIntoRich(el: HTMLElement, text: string, saved: Range | null, opts: FitOptions): boolean {
  if (document.activeElement !== el && !el.contains(document.activeElement)) el.focus({ preventScroll: true });
  const sel = document.getSelection();
  if (!sel) return false;
  // Focusing a contenteditable puts the caret at its start; put back the one
  // the user left.
  if (saved && el.contains(saved.startContainer) && (sel.rangeCount === 0 || !el.contains(sel.anchorNode))) {
    sel.removeAllRanges();
    sel.addRange(saved);
  }
  const range = sel.rangeCount > 0 && el.contains(sel.anchorNode) ? sel.getRangeAt(0) : null;
  const before = range ? rangeText(el, range, 'before') : '';
  const after = range ? rangeText(el, range, 'after') : '';
  const fitted = fitToContext(text, before, after, opts);
  if (!fitted) return true;
  return document.execCommand('insertText', false, fitted);
}

function pasteIntoTerminal(el: HTMLTextAreaElement, text: string): boolean {
  const data = new DataTransfer();
  data.setData('text/plain', text);
  if (document.activeElement !== el) el.focus({ preventScroll: true });
  el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  return true;
}

export type InsertOutcome = 'ok' | 'no-field' | 'failed';

/** Insert `text` into the focused field, else the last one that had focus. */
export function insertAtCaret(
  text: string,
  remembered: { field: Field; range: Range | null } | null,
  opts: FitOptions = {}
): InsertOutcome {
  const active = fieldFor(deepActiveElement());
  const field = active ?? remembered?.field ?? null;
  if (!field) return 'no-field';
  try {
    switch (field.kind) {
      case 'terminal': return pasteIntoTerminal(field.el, text.trim()) ? 'ok' : 'failed';
      case 'text': return insertIntoText(field.el, text, opts) ? 'ok' : 'failed';
      case 'rich': return insertIntoRich(field.el, text, active ? null : remembered?.range ?? null, opts) ? 'ok' : 'failed';
    }
  } catch (e) {
    console.warn('[dictate] insert failed:', e);
    return 'failed';
  }
  return 'failed';
}
