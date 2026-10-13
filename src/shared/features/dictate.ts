/**
 * Dictate into any app — the contract every window shares (owned by the
 * `dictate` unit), plus the pure logic both processes need: accelerator
 * parsing / validation / display, and the transcript clean-up that decides how
 * the words sit next to the text already in the field.
 *
 * No React, no Electron, no DOM: main, the preload, the renderer and the
 * node:test suite all import this file as is.
 *
 * Why a TOGGLE and not "hold Option": Electron's globalShortcut cannot see a key
 * being released and cannot bind a bare modifier, and this app adds no native
 * keyboard hook. So the shortcut starts on the first press and stops on the
 * second. Where the OS repeats a held hotkey (Windows, X11), main also notices
 * the repeats stop and treats that as "let go" — see main/features/dictate/press.ts.
 */

import { applyVocabularyCasing } from './vocabulary';

// ─── State (main → every window) ────────────────────────────────────────────

/** idle → starting (mic opening) → recording → transcribing → inserting → idle.
 *  'error' is shown for a few seconds, then main drops back to 'idle'. */
export type DictatePhase = 'idle' | 'starting' | 'recording' | 'transcribing' | 'inserting' | 'error';

export const DICTATE_PHASES: readonly DictatePhase[] = [
  'idle', 'starting', 'recording', 'transcribing', 'inserting', 'error'
];

/** Why a dictation failed. The renderer turns these into words
 *  (`dictate.error.<code>`); main never sends prose. */
export type DictateErrorCode =
  | 'mic-denied'          // the OS (or the user) refused the microphone
  | 'mic-unavailable'     // no input device / the capture could not open
  | 'host-failed'         // the hidden recording window did not load or crashed
  | 'capture-failed'      // the recording could not be written
  | 'capture-timeout'     // the recorder stopped answering
  | 'transcribe-failed'   // the engine returned an error (detail carries it)
  | 'transcribe-timeout'  // the engine took too long
  | 'nothing-heard'       // the recording held no words
  | 'insert-failed';      // the words could not be delivered at all

/** How the words reached the field. */
export type InsertStrategy =
  | 'in-app'      // a Munder Difflin text field, inserted by its own renderer
  | 'osascript'   // macOS: clipboard + System Events ⌘V
  | 'sendkeys'    // Windows: clipboard + PowerShell SendKeys ^v
  | 'xdotool'     // Linux X11: clipboard + xdotool ctrl+v
  | 'wtype'       // Linux Wayland (wlroots): clipboard + wtype ctrl+v
  | 'clipboard';  // left on the clipboard for the user to paste

/** Why the words were left on the clipboard instead of being typed (the UI
 *  explains each one: `dictate.notice.<code>`). */
export type InsertNotice =
  | 'user-choice'          // the paste setting says "clipboard only"
  | 'accessibility'        // macOS: Accessibility not granted
  | 'automation'           // macOS: not allowed to control System Events
  | 'wayland'              // Wayland without wtype: apps may not type into other apps
  | 'wtype-failed'         // wtype is installed but the compositor refused it
  | 'no-xdotool'           // X11 without xdotool
  | 'no-display'           // Linux with neither DISPLAY nor WAYLAND_DISPLAY
  | 'no-powershell'        // Windows without PowerShell
  | 'paste-failed'         // the paste helper ran and failed
  | 'focus-ours'           // a Munder Difflin window had taken focus by the time the text was ready
  | 'no-field'             // a Munder Difflin window was in front, but no text box was focused
  | 'unsupported-platform';

export interface DictateOutcome {
  at: number;
  strategy: InsertStrategy;
  /** Set when the words were left on the clipboard (or not typed) — why. */
  notice?: InsertNotice;
  /** The transcript, so the user can copy it again from the Stapler or the
   *  settings. Memory only: never written to disk by this unit. */
  text: string;
}

export type ShortcutError =
  | AcceleratorError
  | 'taken'        // another app holds the combination (globalShortcut.register returned false)
  | 'unavailable'; // globalShortcut threw (no display server, …)

export interface DictateShortcutStatus {
  /** The canonical accelerator in use (or attempted). */
  accelerator: string;
  registered: boolean;
  error?: ShortcutError;
}

export interface DictateState {
  /** Dictation is on: the shortcut is registered and the recorder kept warm. */
  enabled: boolean;
  phase: DictatePhase;
  /** epoch ms the current recording started (for an elapsed timer). */
  startedAt: number | null;
  /** epoch ms the safety stop fires. */
  stopsAt: number | null;
  /** Where the words will go: a Munder Difflin field, or the app in front. */
  target: 'app' | 'external' | null;
  error: { code: DictateErrorCode; detail?: string } | null;
  last: DictateOutcome | null;
  shortcut: DictateShortcutStatus;
  /** The cancel key is registered only while a dictation runs; this says
   *  whether it is valid and, during a run, whether it got registered. */
  cancelShortcut: DictateShortcutStatus;
}

// ─── Settings (persisted by main in <userData>/features/dictate/settings.json) ──

/** 'paste': type the words into the app in front (clipboard + paste key).
 *  'clipboard': only copy them; never press keys in other apps. */
export type DictatePasteMode = 'paste' | 'clipboard';

export interface DictateConfig {
  enabled: boolean;
  /** Start / stop. Electron accelerator syntax, canonical form. */
  accelerator: string;
  /** Cancel a running dictation. Registered only while one runs, so a bare
   *  Escape does not steal Escape from every app all day. */
  cancelAccelerator: string;
  pasteMode: DictatePasteMode;
  /** Put back what was on the clipboard after pasting. */
  restoreClipboard: boolean;
  /** Safety stop: a dictation ends (and is inserted) after this long. */
  maxSeconds: number;
}

export const MIN_MAX_SECONDS = 10;
export const MAX_MAX_SECONDS = 600;
export const DEFAULT_MAX_SECONDS = 120;
export const DEFAULT_CANCEL_ACCELERATOR = 'Escape';

/** Platform as the renderer and main both see it. */
export type DictatePlatform = 'darwin' | 'win32' | 'linux' | 'other';

export function toDictatePlatform(p: string | undefined | null): DictatePlatform {
  return p === 'darwin' || p === 'win32' || p === 'linux' ? p : 'other';
}

/**
 * The default start/stop shortcut.
 *
 * Windows and Linux: Control+Alt+Space, as documented. It types nothing, and
 * no desktop binds it by default (Alt+Space alone is the window menu there).
 *
 * macOS: Option+Space (⌥Space). The README's Mac key is "hold Option", and a
 * bare modifier cannot be a global shortcut, so the Option chord closest to it
 * is the honest stand-in, and it is what Mac dictation tools (Superwhisper)
 * ship with. Known neighbours: Alfred, Raycast and the ChatGPT app offer ⌥Space
 * as their launcher key; whoever registers it first gets it, and a failed
 * registration shows in the settings with a field to pick another. ⌃⌥Space was
 * rejected because macOS reserves it for "select next input source", which
 * would silently swallow it for everyone with two keyboard languages. Inside
 * text fields ⌥Space types a non-breaking space; while dictation is on the
 * shortcut takes it instead, which most people only ever type by accident.
 */
export function defaultAccelerator(platform: DictatePlatform): string {
  return platform === 'darwin' ? 'Alt+Space' : 'Control+Alt+Space';
}

/** The Stapler's meeting shortcut on each platform (stapler unit, README):
 *  dictation must not try to take it. */
export function meetingAccelerator(platform: DictatePlatform): string {
  return platform === 'darwin' ? 'Shift+Command+Space' : 'Control+Shift+Space';
}

export function defaultDictateConfig(platform: DictatePlatform): DictateConfig {
  return {
    enabled: false,
    accelerator: defaultAccelerator(platform),
    cancelAccelerator: DEFAULT_CANCEL_ACCELERATOR,
    pasteMode: 'paste',
    restoreClipboard: true,
    maxSeconds: DEFAULT_MAX_SECONDS
  };
}

export const DEFAULT_DICTATE_STATE: DictateState = {
  enabled: false,
  phase: 'idle',
  startedAt: null,
  stopsAt: null,
  target: null,
  error: null,
  last: null,
  shortcut: { accelerator: '', registered: false },
  cancelShortcut: { accelerator: DEFAULT_CANCEL_ACCELERATOR, registered: false }
};

/** What the settings panel shows about this machine. */
export interface DictatePlatformStatus {
  platform: DictatePlatform;
  /** Linux only. */
  linuxSession: 'x11' | 'wayland' | 'unknown' | null;
  /** macOS only: may this app press keys in other apps? */
  accessibility: 'granted' | 'denied' | null;
  microphone: 'granted' | 'denied' | 'not-determined' | 'restricted' | 'unknown';
  /** Helpers found on PATH (null = not relevant on this platform). */
  tools: { xdotool: boolean | null; wtype: boolean | null; powershell: boolean | null };
  /** What happens to the words in another app, with the current settings. */
  strategy: InsertStrategy;
  notice?: InsertNotice;
  /** Wayland sessions only deliver a shortcut while one of our windows has focus. */
  globalShortcuts: 'ok' | 'focused-only';
}

export type DictateSetResult =
  | { ok: true; config: DictateConfig; state: DictateState }
  | { ok: false; field: keyof DictateConfig; error: AcceleratorError | 'invalid'; config: DictateConfig };

// ─── IPC payloads (preload/features/dictate.ts) ─────────────────────────────

/** main → recorder window. `token` names one dictation run. */
export type DictateHostCommand =
  | { cmd: 'start'; token: number; sessionId: string }
  | { cmd: 'stop'; token: number }
  | { cmd: 'cancel'; token: number }
  | { cmd: 'notify'; title: string; body: string; params?: Record<string, string> };

/** recorder window → main. */
export type DictateHostEvent =
  | { type: 'started'; token: number }
  | { type: 'failed'; token: number; code: 'mic-denied' | 'mic-unavailable' | 'capture-failed'; detail?: string }
  | { type: 'captured'; token: number; wavPath: string; durationMs: number }
  | { type: 'level'; token: number; level: number };

/** main → app window: put this text at the caret. */
export interface DictateInsertRequest {
  id: number;
  text: string;
}

export type DictateInsertReply =
  | { id: number; ok: true }
  | { id: number; ok: false; reason: 'no-field' | 'failed' };

// ─── Accelerators ───────────────────────────────────────────────────────────

export type Modifier = 'Control' | 'Alt' | 'Shift' | 'Command' | 'Super';

/** Canonical modifier order, so two spellings of one chord compare equal. */
const MODIFIER_ORDER: readonly Modifier[] = ['Control', 'Alt', 'Shift', 'Command', 'Super'];

export type AcceleratorError =
  | 'empty'
  | 'syntax'          // an unknown token, or two keys
  | 'no-key'          // only modifiers
  | 'needs-modifier'  // would steal ordinary typing
  | 'reserved'        // the OS (or every app) owns it
  | 'conflict';       // the other dictation key, or the Stapler's meeting key

export interface ParsedAccelerator {
  modifiers: Modifier[];
  key: string;
}

const NAMED_KEYS: Record<string, string> = {
  space: 'Space', tab: 'Tab', backspace: 'Backspace', delete: 'Delete', del: 'Delete',
  insert: 'Insert', ins: 'Insert', return: 'Return', enter: 'Return', escape: 'Escape', esc: 'Escape',
  up: 'Up', down: 'Down', left: 'Left', right: 'Right', home: 'Home', end: 'End',
  pageup: 'PageUp', pagedown: 'PageDown', plus: 'Plus', printscreen: 'PrintScreen',
  num0: 'num0', num1: 'num1', num2: 'num2', num3: 'num3', num4: 'num4', num5: 'num5', num6: 'num6',
  num7: 'num7', num8: 'num8', num9: 'num9', numdec: 'numdec', numadd: 'numadd', numsub: 'numsub',
  nummult: 'nummult', numdiv: 'numdiv'
};

/** Single printable characters Electron accepts as a key (US layout names). */
const PUNCTUATION = new Set(['`', '-', '=', '[', ']', '\\', ';', "'", ',', '.', '/']);

function canonicalModifier(token: string, platform: DictatePlatform): Modifier | null {
  switch (token.toLowerCase()) {
    case 'control': case 'ctrl': return 'Control';
    case 'alt': case 'option': case 'altgr': return 'Alt';
    case 'shift': return 'Shift';
    case 'command': case 'cmd': return platform === 'darwin' ? 'Command' : 'Super';
    case 'super': case 'meta': case 'win': return platform === 'darwin' ? 'Command' : 'Super';
    case 'commandorcontrol': case 'cmdorctrl': return platform === 'darwin' ? 'Command' : 'Control';
    default: return null;
  }
}

function canonicalKey(token: string): string | null {
  if (/^[a-z]$/i.test(token)) return token.toUpperCase();
  if (/^[0-9]$/.test(token)) return token;
  if (PUNCTUATION.has(token)) return token;
  const f = /^f([1-9]|1[0-9]|2[0-4])$/i.exec(token);
  if (f) return `F${f[1]}`;
  return NAMED_KEYS[token.toLowerCase()] ?? null;
}

/** Parse "Ctrl+Alt+Space"-style text. Case-insensitive, aliases accepted
 *  (Cmd, Option, CmdOrCtrl, Esc, Enter…); null when it is not one chord. */
export function parseAccelerator(raw: string, platform: DictatePlatform): ParsedAccelerator | null {
  const text = raw.trim();
  if (!text) return null;
  // "Plus" is the key's name; a literal '+' can only be a separator. A
  // trailing '+' ("Ctrl++") is therefore a syntax error, not the plus key.
  const tokens = text.split('+').map((t) => t.trim());
  if (tokens.some((t) => !t)) return null;
  const mods = new Set<Modifier>();
  let key: string | null = null;
  for (const token of tokens) {
    const mod = canonicalModifier(token, platform);
    if (mod) { mods.add(mod); continue; }
    const k = canonicalKey(token);
    if (!k || key) return null; // unknown token, or a second key
    key = k;
  }
  if (!key) return { modifiers: MODIFIER_ORDER.filter((m) => mods.has(m)), key: '' };
  return { modifiers: MODIFIER_ORDER.filter((m) => mods.has(m)), key };
}

export function acceleratorToString(p: ParsedAccelerator): string {
  return [...p.modifiers, p.key].filter(Boolean).join('+');
}

/** The canonical spelling, or null when it does not parse to a full chord. */
export function normalizeAccelerator(raw: string, platform: DictatePlatform): string | null {
  const p = parseAccelerator(raw, platform);
  return p && p.key ? acceleratorToString(p) : null;
}

/** Chords no app should take: the OS owns them, or every app relies on them
 *  (and dictation itself presses ⌘V / Ctrl+V). Canonical spellings. */
function reservedAccelerators(platform: DictatePlatform): string[] {
  const editing = ['A', 'C', 'V', 'X', 'Z'];
  if (platform === 'darwin') {
    return [
      ...editing.map((k) => `Command+${k}`),
      'Command+Space', 'Alt+Command+Space',
      'Command+Tab', 'Command+Q', 'Command+W', 'Command+H', 'Command+M',
      'Shift+Command+3', 'Shift+Command+4', 'Shift+Command+5',
      'Control+Command+Q', 'Control+Command+Space'
    ];
  }
  return [
    ...editing.map((k) => `Control+${k}`), 'Control+Y',
    'Alt+Tab', 'Alt+F4', 'Alt+Space', 'Control+Alt+Delete', 'Control+Shift+Escape', 'Control+Escape',
    'Super+L', 'Super+D', 'Super+Tab', 'Alt+Escape'
  ];
}

/** Keys that may stand alone: they type nothing. */
function bareAllowed(key: string, role: 'toggle' | 'cancel'): boolean {
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(key)) return true;
  return role === 'cancel' && key === 'Escape';
}

export type AcceleratorCheck =
  | { ok: true; accelerator: string }
  | { ok: false; error: AcceleratorError };

/**
 * Validate a dictation accelerator.
 *
 * `role` 'cancel' may be a bare Escape: it is registered only while a
 * dictation runs. `other` is the other dictation accelerator (they must
 * differ); the Stapler's meeting shortcut is always a conflict.
 */
export function validateAccelerator(
  raw: string,
  platform: DictatePlatform,
  role: 'toggle' | 'cancel',
  other?: string
): AcceleratorCheck {
  if (!raw || !raw.trim()) return { ok: false, error: 'empty' };
  const p = parseAccelerator(raw, platform);
  if (!p) return { ok: false, error: 'syntax' };
  if (!p.key) return { ok: false, error: 'no-key' };
  const meaningful = p.modifiers.filter((m) => m !== 'Shift');
  if (meaningful.length === 0 && !bareAllowed(p.key, role)) return { ok: false, error: 'needs-modifier' };
  const canonical = acceleratorToString(p);
  if (reservedAccelerators(platform).includes(canonical)) return { ok: false, error: 'reserved' };
  if (canonical === normalizeAccelerator(meetingAccelerator(platform), platform)) return { ok: false, error: 'conflict' };
  if (other) {
    const o = normalizeAccelerator(other, platform);
    if (o && o === canonical) return { ok: false, error: 'conflict' };
  }
  return { ok: true, accelerator: canonical };
}

const MAC_SYMBOLS: Record<Modifier, string> = { Control: '⌃', Alt: '⌥', Shift: '⇧', Command: '⌘', Super: '⌘' };
const PC_NAMES: Record<Modifier, string> = { Control: 'Ctrl', Alt: 'Alt', Shift: 'Shift', Command: 'Win', Super: 'Super' };
/** Key names that read better as symbols on a Mac. */
const MAC_KEYS: Record<string, string> = {
  Return: '↩', Escape: 'Esc', Backspace: '⌫', Delete: '⌦', Tab: '⇥',
  Up: '↑', Down: '↓', Left: '←', Right: '→', Space: 'Space'
};

/** A chord as keycaps: ['⌥', 'Space'] on a Mac, ['Ctrl', 'Alt', 'Space']
 *  elsewhere. Empty when it does not parse. */
export function acceleratorKeys(raw: string, platform: DictatePlatform): string[] {
  const p = parseAccelerator(raw, platform);
  if (!p || !p.key) return [];
  if (platform === 'darwin') {
    // macOS menu order: ⌃ ⌥ ⇧ ⌘.
    return [...p.modifiers.map((m) => MAC_SYMBOLS[m]), MAC_KEYS[p.key] ?? p.key];
  }
  const names = p.modifiers.map((m) => (platform === 'win32' && m === 'Super' ? 'Win' : PC_NAMES[m]));
  return [...names, p.key];
}

/** How a chord is printed in running text: "⌥Space" on a Mac, "Ctrl+Alt+Space" elsewhere. */
export function formatAccelerator(raw: string, platform: DictatePlatform): string {
  const keys = acceleratorKeys(raw, platform);
  if (!keys.length) return raw;
  return platform === 'darwin' ? keys.join('') : keys.join('+');
}

/** The parts of a KeyboardEvent the recorder needs (kept DOM-free). */
export interface KeyChord {
  key: string;
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

/** `KeyboardEvent.code` → accelerator key. `code` is layout-independent, which
 *  is what a global shortcut binds to (and ⌥ on a Mac changes `key` into
 *  a special character, so `key` cannot be trusted there). */
function keyFromCode(code: string): string | null {
  let m = /^Key([A-Z])$/.exec(code);
  if (m) return m[1];
  m = /^Digit([0-9])$/.exec(code);
  if (m) return m[1];
  m = /^Numpad([0-9])$/.exec(code);
  if (m) return `num${m[1]}`;
  m = /^F([1-9]|1[0-9]|2[0-4])$/.exec(code);
  if (m) return `F${m[1]}`;
  const map: Record<string, string> = {
    Space: 'Space', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete', Insert: 'Insert',
    Enter: 'Return', NumpadEnter: 'Return', Escape: 'Escape', ArrowUp: 'Up', ArrowDown: 'Down',
    ArrowLeft: 'Left', ArrowRight: 'Right', Home: 'Home', End: 'End', PageUp: 'PageUp',
    PageDown: 'PageDown', Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[',
    BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.',
    Slash: '/', NumpadDecimal: 'numdec', NumpadAdd: 'numadd', NumpadSubtract: 'numsub',
    NumpadMultiply: 'nummult', NumpadDivide: 'numdiv', PrintScreen: 'PrintScreen'
  };
  return map[code] ?? null;
}

/** Turn a keydown into an accelerator, for the "press the new shortcut" field.
 *  Null while only modifiers are down (keep waiting) or for a key a shortcut
 *  cannot use. */
export function acceleratorFromKeyEvent(e: KeyChord, platform: DictatePlatform): string | null {
  const key = keyFromCode(e.code);
  if (!key) return null;
  const mods: Modifier[] = [];
  if (e.ctrlKey) mods.push('Control');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push(platform === 'darwin' ? 'Command' : 'Super');
  return acceleratorToString({ modifiers: MODIFIER_ORDER.filter((m) => mods.includes(m)), key });
}

// ─── Transcript clean-up ────────────────────────────────────────────────────

/** Upper bound on one dictation's text crossing IPC (a two-minute monologue is
 *  ~2,000 characters; this is a guard, not a budget). */
export const MAX_DICTATION_TEXT = 20_000;

/**
 * Tidy an engine's transcript for typing: drop Whisper's bracketed sound
 * tags ("[BLANK_AUDIO]", "[ Silence ]", "[Music]"), a transcript that is only
 * a parenthetical sound ("(upbeat music)"), and collapse runs of whitespace —
 * a dictation is prose, not layout, so newlines become spaces too.
 */
export function cleanTranscript(raw: string): string {
  let text = (raw ?? '').replace(/\[[^\]\n]{0,40}\]/g, ' ');
  text = text.replace(/\s+/g, ' ').trim();
  if (/^\([^)]{0,40}\)$/.test(text)) return '';
  // An isolated leading/trailing ellipsis or dash is an artefact of a cut-off
  // segment, not something anyone dictates.
  text = text.replace(/^(?:\.\.\.|…|-+)\s*/, '').replace(/\s*(?:-+)$/, '').trim();
  return text.slice(0, MAX_DICTATION_TEXT);
}

/**
 * The transcript as it should be typed: cleaned, then the vocabulary's
 * spellings applied (the transcribe unit's casing pass — "kubernetes" →
 * "Kubernetes", whole words only). The engine already runs that pass; running
 * it again here is idempotent and keeps the guarantee whichever engine
 * answered.
 */
export function polishTranscript(raw: string, vocabulary: readonly string[]): string {
  const text = cleanTranscript(raw);
  return text ? applyVocabularyCasing(text, vocabulary) : '';
}

/** Pronoun forms that keep their capital mid-sentence. */
const ALWAYS_CAPITAL = new Set(['I', "I'm", "I'll", "I've", "I'd", 'I’m', 'I’ll', 'I’ve', 'I’d']);

export interface FitOptions {
  /** True for a word that must keep its casing (a vocabulary name like
   *  "Claude" or "Kubernetes"). Acronyms and CamelCase are kept regardless. */
  keepCase?: (word: string) => boolean;
}

/**
 * Fit a transcript to the text around the caret.
 *
 * Engines transcribe each clip as if it were a whole sentence: a capital at
 * the start and a full stop at the end. Dropped into the middle of a line
 * that is wrong, so:
 *   - a space goes in front when the caret sits right after a word or a
 *     punctuation mark (not after a space, a newline, or an opening bracket /
 *     quote), unless the transcript itself starts with punctuation;
 *   - the first word is lowercased when the caret is mid-sentence (after a
 *     word or a comma) — never "I", acronyms, CamelCase or a vocabulary name;
 *     it is capitalised when the caret starts a sentence;
 *   - the closing full stop is dropped when the text after the caret carries
 *     on in lowercase, and a space is added when it starts with a word.
 */
export function fitToContext(text: string, before: string, after: string, opts: FitOptions = {}): string {
  let out = cleanTranscript(text);
  if (!out) return '';
  const prev = before.replace(/[ \t]+$/, '');
  const startsSentence = prev === '' || /[.!?…]["'”’)]*$/.test(prev) || /\n\s*$/.test(before);

  const firstWord = /^[^\s.,;:!?]+/.exec(out)?.[0] ?? '';
  if (startsSentence) {
    out = out.charAt(0).toUpperCase() + out.slice(1);
  } else if (
    /^[A-Z][a-z'’]*$/.test(firstWord.replace(/[.,;:!?"”’)]+$/, '')) &&
    !ALWAYS_CAPITAL.has(firstWord) &&
    !(opts.keepCase?.(firstWord.replace(/[^A-Za-z'’-]+$/g, '')) ?? false)
  ) {
    out = out.charAt(0).toLowerCase() + out.slice(1);
  }

  const lastChar = before.slice(-1);
  const needsLeadingSpace =
    before.length > 0 &&
    !/\s/.test(lastChar) &&
    !/[([{"'“‘`/\\\-–—]/.test(lastChar) &&
    !/^[.,;:!?)\]}”’…]/.test(out);
  if (needsLeadingSpace) out = ` ${out}`;

  const next = after.replace(/^[ \t]+/, '');
  if (/^[a-z]/.test(next) && /[^.]\.$/.test(out)) out = out.slice(0, -1);
  if (after.length > 0 && /^[A-Za-z0-9]/.test(after)) out = `${out} `;
  return out;
}
