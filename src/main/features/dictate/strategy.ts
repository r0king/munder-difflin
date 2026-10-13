/**
 * How dictated words reach an app that is not ours — pure, unit-tested
 * (test/dictate-strategy.test.cjs). No Electron, no child_process: main's
 * insert.ts gathers the facts (platform, env, helper tools on PATH, the
 * Accessibility grant), this file decides, insert.ts runs the plan.
 *
 * Every strategy is "clipboard + the platform's paste key". The text itself
 * never appears in a command line: it only ever travels through the
 * clipboard, so nothing the user said can be read as a flag or a script.
 */
import type {
  DictatePasteMode,
  DictatePlatform,
  InsertNotice,
  InsertStrategy
} from '../../../shared/features/dictate';

export type LinuxSession = 'x11' | 'wayland' | 'unknown';

export interface SessionEnv {
  XDG_SESSION_TYPE?: string;
  WAYLAND_DISPLAY?: string;
  DISPLAY?: string;
}

/**
 * The Linux display server. XDG_SESSION_TYPE is authoritative when set; a
 * Wayland session also exports DISPLAY (for XWayland), so WAYLAND_DISPLAY is
 * checked before DISPLAY.
 */
export function linuxSession(env: SessionEnv): LinuxSession {
  const type = (env.XDG_SESSION_TYPE ?? '').trim().toLowerCase();
  if (type === 'wayland') return 'wayland';
  if (type === 'x11') return 'x11';
  if (env.WAYLAND_DISPLAY) return 'wayland';
  if (env.DISPLAY) return 'x11';
  return 'unknown';
}

export interface InsertTools {
  xdotool: boolean;
  wtype: boolean;
  powershell: boolean;
}

export interface StrategyInput {
  platform: DictatePlatform;
  env: SessionEnv;
  tools: InsertTools;
  /** macOS: systemPreferences.isTrustedAccessibilityClient(false). */
  accessibilityTrusted: boolean;
  pasteMode: DictatePasteMode;
}

export interface StrategyChoice {
  strategy: InsertStrategy;
  /** Set whenever the words will be left on the clipboard: why. */
  notice?: InsertNotice;
}

/** Pick how to put words into the app in front. */
export function chooseInsertStrategy(input: StrategyInput): StrategyChoice {
  if (input.pasteMode === 'clipboard') return { strategy: 'clipboard', notice: 'user-choice' };
  switch (input.platform) {
    case 'darwin':
      // System Events can only press keys for an app the user trusted in
      // Privacy & Security → Accessibility.
      return input.accessibilityTrusted
        ? { strategy: 'osascript' }
        : { strategy: 'clipboard', notice: 'accessibility' };
    case 'win32':
      return input.tools.powershell
        ? { strategy: 'sendkeys' }
        : { strategy: 'clipboard', notice: 'no-powershell' };
    case 'linux': {
      const session = linuxSession(input.env);
      if (session === 'wayland') {
        // Wayland gives no app a way to type into another; wtype uses the
        // virtual-keyboard protocol, which wlroots compositors (Sway,
        // Hyprland, …) offer and GNOME does not. xdotool would only reach
        // XWayland windows, and we cannot tell which kind is in front.
        return input.tools.wtype
          ? { strategy: 'wtype' }
          : { strategy: 'clipboard', notice: 'wayland' };
      }
      if (session === 'x11') {
        return input.tools.xdotool
          ? { strategy: 'xdotool' }
          : { strategy: 'clipboard', notice: 'no-xdotool' };
      }
      return { strategy: 'clipboard', notice: 'no-display' };
    }
    default:
      return { strategy: 'clipboard', notice: 'unsupported-platform' };
  }
}

/** A command to run with execFile (argv array, no shell). */
export interface PasteCommand {
  file: string;
  args: string[];
}

/** Where each helper lives. Resolved by insert.ts (absolute paths). */
export interface ToolPaths {
  osascript: string;
  powershell: string | null;
  xdotool: string | null;
  wtype: string | null;
}

/** AppleScript for ⌘V. `keystroke "v"` maps the character through the
 *  current keyboard layout, so Dvorak and AZERTY paste too. */
export const MAC_PASTE_SCRIPT = 'tell application "System Events" to keystroke "v" using command down';

/** PowerShell for Ctrl+V. A constant: no user text is ever interpolated. */
export const WIN_PASTE_SCRIPT =
  "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^v')";

/** The paste-key command for a strategy, or null when it has none
 *  (in-app, clipboard) or its helper is missing. */
export function pasteCommand(strategy: InsertStrategy, paths: ToolPaths): PasteCommand | null {
  switch (strategy) {
    case 'osascript':
      return { file: paths.osascript, args: ['-e', MAC_PASTE_SCRIPT] };
    case 'sendkeys':
      return paths.powershell
        ? { file: paths.powershell, args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WIN_PASTE_SCRIPT] }
        : null;
    case 'xdotool':
      // --clearmodifiers: lift any modifier still held from the shortcut, so
      // the app sees Ctrl+V and not Ctrl+Alt+V.
      return paths.xdotool ? { file: paths.xdotool, args: ['key', '--clearmodifiers', 'ctrl+v'] } : null;
    case 'wtype':
      return paths.wtype ? { file: paths.wtype, args: ['-M', 'ctrl', '-k', 'v', '-m', 'ctrl'] } : null;
    default:
      return null;
  }
}

/**
 * Turn a failed paste helper's output into the reason we tell the user.
 * osascript reports a missing Automation grant as -1743 ("Not authorized to
 * send Apple events to System Events") and a missing Accessibility grant as
 * 1002 / -25211 ("osascript is not allowed to send keystrokes").
 */
export function classifyPasteFailure(strategy: InsertStrategy, stderr: string): InsertNotice {
  const s = stderr.toLowerCase();
  if (strategy === 'osascript') {
    if (s.includes('-1743') || s.includes('not authorized to send apple events')) return 'automation';
    if (s.includes('(1002)') || s.includes('-25211') || s.includes('not allowed to send keystrokes') || s.includes('assistive')) {
      return 'accessibility';
    }
  }
  if (strategy === 'wtype') return 'wtype-failed';
  return 'paste-failed';
}

/** The clipboard may be put back only if it still holds what we wrote: if
 *  the user (or the app) copied something in the meantime, that wins. */
export function shouldRestoreClipboard(current: string, written: string): boolean {
  return current === written;
}
