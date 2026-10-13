/**
 * The hidden recorder window — main process only.
 *
 * Dictation records in its own BrowserWindow (stapler.html#dictate →
 * DictationHostPage) rather than in the puck: it works with the Stapler off,
 * and a crash or reload of the puck cannot strand a recording. The window is
 * never shown and never takes focus — focus must stay in the app the user is
 * dictating into. It is created on first use and kept warm while dictation is
 * enabled, so the second dictation starts as fast as the mic opens.
 *
 * Commands that arrive before the page has subscribed are held and flushed on
 * its `ready`. Messages from any other webContents are ignored.
 */
import { BrowserWindow, type WebContents } from 'electron';
import type { DictateHostCommand } from '../../../shared/features/dictate';
import type { FeatureContext } from '../types';

/** The page must answer `ready` within this long, or the host is given up on. */
const READY_TIMEOUT_MS = 15_000;

export class DictationHost {
  private win: BrowserWindow | null = null;
  private ready = false;
  private held: DictateHostCommand[] = [];
  private waiters: Array<{ resolve: () => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }> = [];

  constructor(
    private readonly ctx: FeatureContext,
    /** The window died (crash, load failure) — a running dictation is lost. */
    private readonly onGone: (reason: string) => void
  ) {}

  /** True when `wc` is the recorder window's page. */
  isHost(wc: WebContents | null | undefined): boolean {
    return !!wc && !!this.win && !this.win.isDestroyed() && this.win.webContents.id === wc.id;
  }

  webContentsId(): number | null {
    return this.win && !this.win.isDestroyed() ? this.win.webContents.id : null;
  }

  isReady(): boolean {
    return this.ready && !!this.win && !this.win.isDestroyed();
  }

  /** Create the window if needed and wait until its page listens. */
  ensure(): Promise<void> {
    if (this.isReady()) return Promise.resolve();
    if (!this.win || this.win.isDestroyed()) this.create();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.timer !== timer);
        reject(new Error('the recorder window did not start'));
        // Start over next time rather than wait on a page that never answers.
        if (!this.ready) this.destroy();
      }, READY_TIMEOUT_MS);
      this.waiters.push({ resolve, reject, timer });
    });
  }

  /** The page called `host.ready()`. */
  markReady(wc: WebContents): void {
    if (!this.isHost(wc)) return;
    this.ready = true;
    const held = this.held.splice(0);
    for (const cmd of held) this.deliver(cmd);
    const waiters = this.waiters.splice(0);
    for (const w of waiters) { clearTimeout(w.timer); w.resolve(); }
  }

  /** Send now, or hold until the page is ready. `notify` is dropped when the
   *  page is not up: the caller falls back to a main-process notification. */
  send(cmd: DictateHostCommand): boolean {
    if (this.isReady()) return this.deliver(cmd);
    if (cmd.cmd === 'notify') return false;
    if (this.win && !this.win.isDestroyed()) { this.held.push(cmd); return true; }
    return false;
  }

  destroy(): void {
    const w = this.win;
    this.win = null;
    this.ready = false;
    this.held = [];
    this.failWaiters('the recorder window closed');
    if (w && !w.isDestroyed()) {
      try { w.destroy(); } catch { /* already gone */ }
    }
  }

  private deliver(cmd: DictateHostCommand): boolean {
    const w = this.win;
    if (!w || w.isDestroyed() || w.webContents.isDestroyed()) return false;
    try { w.webContents.send('feat:dictate:host:command', cmd); return true; } catch { return false; }
  }

  private failWaiters(reason: string): void {
    const waiters = this.waiters.splice(0);
    for (const w of waiters) { clearTimeout(w.timer); w.reject(new Error(reason)); }
  }

  private gone(reason: string): void {
    if (!this.win) return;
    this.destroy();
    this.onGone(reason);
  }

  private create(): void {
    this.ready = false;
    const win = new BrowserWindow({
      show: false,
      width: 320,
      height: 200,
      frame: false,
      focusable: false,
      skipTaskbar: true,
      resizable: false,
      title: 'Munder Difflin Dictation',
      webPreferences: {
        preload: this.ctx.preloadPath,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        // A hidden window is "background": without this Chromium throttles its
        // timers and the level meter / chunk flushing stall.
        backgroundThrottling: false,
        // The capture graph runs in an AudioContext that is created without a
        // user gesture (main starts it on a global shortcut).
        autoplayPolicy: 'no-user-gesture-required',
        spellcheck: false
      }
    });
    this.win = win;
    const wc = win.webContents;
    // This page records audio and nothing else: no popups, no navigation away.
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.on('will-navigate', (e) => e.preventDefault());
    // A reload (dev HMR) drops the page's listeners until it says ready again.
    wc.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument && this.win === win) this.ready = false;
    });
    wc.on('render-process-gone', (_e, details) => {
      console.error('[dictate] recorder window renderer gone:', details.reason);
      if (this.win === win) this.gone(`renderer ${details.reason}`);
    });
    wc.on('did-fail-load', (_e, code, desc, _url, isMainFrame) => {
      if (!isMainFrame) return;
      console.error('[dictate] recorder window failed to load:', code, desc);
      if (this.win === win) this.gone(`load failed: ${desc}`);
    });
    win.on('closed', () => {
      if (this.win === win) this.gone('closed');
    });
    this.ctx.loadRendererEntry(win, 'stapler', 'dictate').catch((e: unknown) => {
      console.error('[dictate] could not load the recorder window:', e);
      if (this.win === win) this.gone('load failed');
    });
  }
}
