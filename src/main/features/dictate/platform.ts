/**
 * What this machine allows dictation to do — main process only.
 *
 * Gathers the facts strategy.ts decides on (helper tools on PATH, the macOS
 * Accessibility grant, the microphone grant, which display server Linux runs)
 * and opens the system settings page that fixes each one. Every external
 * command runs through `runTool`: execFile with an argv array, a timeout and no
 * shell, so nothing here can be steered by text the user dictated.
 */
import { execFile } from 'node:child_process';
import { accessSync, constants, existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { shell, systemPreferences } from 'electron';
import type { DictatePlatform, DictatePlatformStatus, DictatePasteMode } from '../../../shared/features/dictate';
import { chooseInsertStrategy, linuxSession, type InsertTools, type ToolPaths } from './strategy';

export interface ToolResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** Run a helper: argv array, no shell, bounded time and output. Never throws. */
export function runTool(file: string, args: string[], timeoutMs: number): Promise<ToolResult> {
  return new Promise((resolve) => {
    try {
      execFile(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
        resolve({ ok: !err, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') || (err ? err.message : '') });
      });
    } catch (e) {
      resolve({ ok: false, stdout: '', stderr: e instanceof Error ? e.message : String(e) });
    }
  });
}

/**
 * Find an executable on PATH. A desktop launcher can hand a packaged app a
 * thin PATH (no /usr/local/bin), so the usual system folders are searched too.
 */
export function findOnPath(name: string, platform: DictatePlatform): string | null {
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  if (platform !== 'win32') dirs.push('/usr/bin', '/usr/local/bin', '/bin', '/opt/homebrew/bin');
  const names = platform === 'win32' ? [`${name}.exe`, name] : [name];
  for (const dir of dirs) {
    for (const n of names) {
      const candidate = join(dir, n);
      try {
        accessSync(candidate, platform === 'win32' ? constants.F_OK : constants.X_OK);
        return candidate;
      } catch { /* not here */ }
    }
  }
  return null;
}

/** Windows PowerShell 5.1 ships with every supported Windows at a fixed path;
 *  use that rather than PATH so a stray powershell.exe cannot stand in. */
function windowsPowerShell(): string | null {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  const builtin = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (existsSync(builtin)) return builtin;
  return findOnPath('pwsh', 'win32');
}

const TOOL_TTL_MS = 30_000;
let toolCache: { at: number; paths: ToolPaths } | null = null;

/** Resolve the helpers once per 30 s (installing xdotool should not need a restart). */
export function toolPaths(platform: DictatePlatform, fresh = false): ToolPaths {
  if (!fresh && toolCache && Date.now() - toolCache.at < TOOL_TTL_MS) return toolCache.paths;
  const paths: ToolPaths = {
    osascript: '/usr/bin/osascript',
    powershell: platform === 'win32' ? windowsPowerShell() : null,
    xdotool: platform === 'linux' ? findOnPath('xdotool', platform) : null,
    wtype: platform === 'linux' ? findOnPath('wtype', platform) : null
  };
  toolCache = { at: Date.now(), paths };
  return paths;
}

export function toolsFrom(paths: ToolPaths): InsertTools {
  return { xdotool: !!paths.xdotool, wtype: !!paths.wtype, powershell: !!paths.powershell };
}

/** macOS: may this app press keys in other apps? Never prompts. */
export function accessibilityTrusted(platform: DictatePlatform): boolean {
  if (platform !== 'darwin') return false;
  try { return systemPreferences.isTrustedAccessibilityClient(false); } catch { return false; }
}

/** macOS: show the system's "allow Accessibility" prompt. */
export function promptAccessibility(platform: DictatePlatform): void {
  if (platform !== 'darwin') return;
  try { systemPreferences.isTrustedAccessibilityClient(true); } catch { /* older macOS */ }
}

export type MicStatus = DictatePlatformStatus['microphone'];

/** The OS-level microphone grant (macOS and Windows keep one; Linux does not). */
export function microphoneStatus(platform: DictatePlatform): MicStatus {
  if (platform !== 'darwin' && platform !== 'win32') return 'unknown';
  try {
    const s = systemPreferences.getMediaAccessStatus('microphone');
    return s === 'granted' || s === 'denied' || s === 'not-determined' || s === 'restricted' ? s : 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Make sure the OS lets us open the mic before the recorder asks for it.
 * macOS shows its prompt once (askForMediaAccess); after a refusal only System
 * Settings can change it. Windows has no prompt, only the privacy switch.
 */
export async function ensureMicrophone(platform: DictatePlatform): Promise<boolean> {
  const status = microphoneStatus(platform);
  if (status === 'denied' || status === 'restricted') return false;
  if (platform === 'darwin' && status === 'not-determined') {
    try { return await systemPreferences.askForMediaAccess('microphone'); } catch { return false; }
  }
  return true;
}

/** The settings page that grants each permission. */
export async function openPermissionSettings(
  platform: DictatePlatform,
  which: 'accessibility' | 'microphone' | 'automation'
): Promise<void> {
  let url: string | null = null;
  if (platform === 'darwin') {
    const pane = which === 'accessibility' ? 'Privacy_Accessibility' : which === 'automation' ? 'Privacy_Automation' : 'Privacy_Microphone';
    url = `x-apple.systempreferences:com.apple.preference.security?${pane}`;
  } else if (platform === 'win32' && which === 'microphone') {
    url = 'ms-settings:privacy-microphone';
  }
  if (!url) return;
  try { await shell.openExternal(url); } catch { /* no handler — nothing more we can do */ }
}

/**
 * macOS: is Munder Difflin the frontmost app right now? Asked when none of our
 * windows is key: clicking a non-activating window can still bring the app
 * forward, and a ⌘V sent then would land in our own window instead of the
 * app the user was dictating into. Uses NSWorkspace through JXA — no Apple
 * Event, so no Automation prompt. Null when it cannot tell.
 */
export async function macFrontmostIsUs(): Promise<boolean | null> {
  const script = 'ObjC.import("AppKit"); $.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier';
  const r = await runTool('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script], 2000);
  if (!r.ok) return null;
  const pid = Number.parseInt(r.stdout.trim(), 10);
  return Number.isFinite(pid) ? pid === process.pid : null;
}

/** Everything the settings panel shows about this machine. */
export function platformStatus(
  platform: DictatePlatform,
  pasteMode: DictatePasteMode,
  fresh = false
): DictatePlatformStatus {
  const paths = toolPaths(platform, fresh);
  const tools = toolsFrom(paths);
  const env = { XDG_SESSION_TYPE: process.env.XDG_SESSION_TYPE, WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY, DISPLAY: process.env.DISPLAY };
  const trusted = accessibilityTrusted(platform);
  const choice = chooseInsertStrategy({ platform, env, tools, accessibilityTrusted: trusted, pasteMode });
  const session = platform === 'linux' ? linuxSession(env) : null;
  return {
    platform,
    linuxSession: session,
    accessibility: platform === 'darwin' ? (trusted ? 'granted' : 'denied') : null,
    microphone: microphoneStatus(platform),
    tools: {
      xdotool: platform === 'linux' ? tools.xdotool : null,
      wtype: platform === 'linux' ? tools.wtype : null,
      powershell: platform === 'win32' ? tools.powershell : null
    },
    strategy: choice.strategy,
    notice: choice.notice,
    // Electron grabs global keys through X11. Under Wayland that grab only sees
    // keys while one of our (XWayland) windows has focus.
    globalShortcuts: session === 'wayland' ? 'focused-only' : 'ok'
  };
}

export function sessionEnv(): { XDG_SESSION_TYPE?: string; WAYLAND_DISPLAY?: string; DISPLAY?: string } {
  return { XDG_SESSION_TYPE: process.env.XDG_SESSION_TYPE, WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY, DISPLAY: process.env.DISPLAY };
}
