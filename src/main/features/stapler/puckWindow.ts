/**
 * The puck's window: a frameless, transparent, always-on-top window that
 * floats over every app, carries no taskbar entry, and only takes keyboard
 * focus while a flow panel needs typing.
 *
 * One window, three sizes (StaplerMode): the bare puck, the ring around it,
 * and a flow panel that grows out of the puck's corner. The puck's RESTING
 * rect is the source of truth for where it lives; the ring and panel are
 * derived from it (geometry.ts) and the window returns to it on collapse.
 *
 * Platform notes, decided here once:
 *   macOS   — `type: 'panel'` (a non-activating panel: floats above full-screen
 *             apps and on every Space, and can take keys for the note field
 *             without pulling the whole app forward), level 'screen-saver'.
 *             NOT setVisibleOnAllWorkspaces' default process transform: that
 *             hides the app's Dock icon for good (Electron calls DockHide).
 *   Windows — not focusable at rest, so clicking the puck never steals focus
 *             from the app the user is in; focusable while a panel is open.
 *             Click-through transparent areas via setIgnoreMouseEvents with
 *             forwarding, toggled by the renderer on hover.
 *   Linux   — Chromium cannot forward mouse moves to an ignoring window, so a
 *             click-through puck would never see the pointer come back and
 *             could never be clicked again. The window is kept tight to its
 *             content instead and never ignores the mouse. Resizable, because
 *             X11 window managers pin a non-resizable window's size hints and
 *             then refuse our own setBounds.
 */
import { BrowserWindow, screen, type WebContents } from 'electron';
import type { FeatureContext } from '../types';
import type { StaplerLayout, StaplerMode, StaplerPanel } from '../../../shared/features/stapler';
import {
  PANEL_WINDOW,
  PANEL_WINDOW_TALL,
  PUCK_WINDOW,
  centerIn,
  clampRect,
  displayForRect,
  dragPosition,
  initialPuckRect,
  panelRect,
  reclampPuckRect,
  ringRect,
  spotFromRect,
  type Point,
  type Rect,
  type SavedPlacement
} from './geometry';

const IS_MAC = process.platform === 'darwin';
const IS_WIN = process.platform === 'win32';
const IS_LINUX = process.platform === 'linux';

/** See the Linux note above. */
export const CAN_CLICK_THROUGH = !IS_LINUX;

/** A drag that never got its pointerup (renderer crashed mid-drag) ends here. */
const MAX_DRAG_MS = 60_000;
/** ~60 Hz: smooth, and cheap — one getCursorScreenPoint + setBounds a frame. */
const DRAG_TICK_MS = 16;

export interface PuckHost {
  /** Resolved lazily: the controllers exist before register() runs. */
  ctx(): FeatureContext;
  placement(): SavedPlacement;
  savePlacement(next: SavedPlacement): void;
  /** Content protection wanted right now. */
  protection(): boolean;
  /** The window went away without us closing it. */
  onUnexpectedClose(): void;
}

export class PuckWindow {
  private win: BrowserWindow | null = null;
  private rest: Rect | null = null;
  private mode: StaplerMode = 'puck';
  private panel: StaplerPanel | undefined;
  private drag: { timer: NodeJS.Timeout; grab: Point; started: number } | null = null;
  private closing = false;
  private hiddenForCapture = false;
  private reclampTimer: NodeJS.Timeout | null = null;
  private lastCrashReload = 0;
  private readonly onDisplaysChanged = (): void => this.scheduleReclamp();

  constructor(private readonly host: PuckHost) {}

  get window(): BrowserWindow | null {
    return this.win && !this.win.isDestroyed() ? this.win : null;
  }

  isSender(wc: WebContents): boolean {
    const w = this.window;
    return !!w && !w.webContents.isDestroyed() && w.webContents.id === wc.id;
  }

  send(channel: string, payload?: unknown): void {
    const w = this.window;
    if (!w || w.webContents.isDestroyed()) return;
    try { w.webContents.send(channel, payload); } catch { /* tearing down */ }
  }

  layout(): StaplerLayout {
    const b = this.window?.getBounds() ?? { width: PUCK_WINDOW.width, height: PUCK_WINDOW.height };
    return { mode: this.mode, ...(this.panel && this.mode === 'panel' ? { panel: this.panel } : {}), width: b.width, height: b.height };
  }

  /** Create and show the puck (no-op when it exists). False when there is no
   *  display to put it on. */
  create(): boolean {
    if (this.window) return true;
    const displays = screen.getAllDisplays();
    const init = initialPuckRect(displays, screen.getPrimaryDisplay().id, this.host.placement());
    if (!init) return false;
    this.rest = init.rect;
    this.mode = 'puck';
    this.panel = undefined;
    this.closing = false;
    const ctx = this.host.ctx();
    const win = new BrowserWindow({
      ...init.rect,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      resizable: IS_LINUX,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      focusable: !IS_WIN,
      title: 'Stapler',
      ...(IS_MAC ? { type: 'panel' } : {}),
      webPreferences: {
        preload: ctx.preloadPath,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        // A meeting records here for hours while the window sits behind
        // nothing; its timers and level meter must not be throttled.
        backgroundThrottling: false,
        spellcheck: true
      }
    });
    this.win = win;
    win.setAlwaysOnTop(true, IS_MAC ? 'screen-saver' : 'floating');
    if (!IS_WIN) {
      try { win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true }); } catch { /* WM without workspaces */ }
    }
    win.setContentProtection(this.host.protection());
    if (CAN_CLICK_THROUGH) win.setIgnoreMouseEvents(true, { forward: true });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.webContents.on('render-process-gone', (_e, details) => {
      if (details.reason === 'clean-exit' || this.closing) return;
      // One reload per 10 s: a renderer that crashes on load must not spin.
      const now = Date.now();
      if (now - this.lastCrashReload < 10_000) return;
      this.lastCrashReload = now;
      void ctx.loadRendererEntry(win, 'stapler', 'puck').catch(() => { /* gone */ });
    });
    win.once('ready-to-show', () => {
      if (!win.isDestroyed() && !this.hiddenForCapture) win.showInactive();
    });
    win.on('closed', () => {
      this.stopDrag();
      this.win = null;
      screen.removeListener('display-added', this.onDisplaysChanged);
      screen.removeListener('display-removed', this.onDisplaysChanged);
      screen.removeListener('display-metrics-changed', this.onDisplaysChanged);
      if (!this.closing) this.host.onUnexpectedClose();
    });
    screen.on('display-added', this.onDisplaysChanged);
    screen.on('display-removed', this.onDisplaysChanged);
    screen.on('display-metrics-changed', this.onDisplaysChanged);
    void ctx.loadRendererEntry(win, 'stapler', 'puck').catch((e) => console.error('[stapler] puck load failed:', e));
    this.remember(init.rect);
    return true;
  }

  destroy(): void {
    this.closing = true;
    this.stopDrag();
    if (this.reclampTimer) { clearTimeout(this.reclampTimer); this.reclampTimer = null; }
    const w = this.window;
    this.win = null;
    screen.removeListener('display-added', this.onDisplaysChanged);
    screen.removeListener('display-removed', this.onDisplaysChanged);
    screen.removeListener('display-metrics-changed', this.onDisplaysChanged);
    if (w) {
      try { w.destroy(); } catch { /* already gone */ }
    }
  }

  private workArea(): Rect {
    const displays = screen.getAllDisplays();
    const d = this.rest ? displayForRect(displays, this.rest) : null;
    return (d ?? screen.getPrimaryDisplay()).workArea;
  }

  /** Resize the window for a mode. The panel modes take keyboard focus. */
  setMode(mode: StaplerMode, panel?: StaplerPanel): StaplerLayout | null {
    const w = this.window;
    if (!w || !this.rest) return null;
    if (this.drag) this.dragEnd();
    const wa = this.workArea();
    let rect: Rect;
    if (mode === 'puck') rect = this.rest;
    else if (mode === 'ring') rect = ringRect(this.rest, wa);
    else rect = panelRect(this.rest, wa, panel === 'settings' ? PANEL_WINDOW_TALL : PANEL_WINDOW);
    this.mode = mode;
    this.panel = mode === 'panel' ? panel : undefined;
    w.setBounds(rect, false);
    if (mode === 'panel') {
      if (CAN_CLICK_THROUGH) w.setIgnoreMouseEvents(false);
      if (IS_WIN) w.setFocusable(true);
      w.focus();
    } else {
      if (IS_WIN) w.setFocusable(false);
      // The pointer is usually still over the puck after a collapse; the
      // renderer's forwarded hover flips this back within one mouse move.
      if (CAN_CLICK_THROUGH) w.setIgnoreMouseEvents(true, { forward: true });
    }
    return this.layout();
  }

  /** The renderer's hover tracking: opaque over the puck and the ring's
   *  buttons, click-through everywhere else. Panels are always opaque. */
  setIgnoreMouse(ignore: boolean): void {
    const w = this.window;
    if (!w || !CAN_CLICK_THROUGH || this.mode === 'panel' || this.drag) return;
    if (ignore) w.setIgnoreMouseEvents(true, { forward: true });
    else w.setIgnoreMouseEvents(false);
  }

  /**
   * "The drag follows your pointer": main polls the real cursor and puts the
   * window at cursor − grab offset every frame. Moving the window from
   * renderer pointer deltas drifts (the deltas are measured in a window that
   * is itself moving, and in mixed-DPI setups in the wrong scale); the OS
   * cursor position is exact on every platform.
   */
  dragStart(): boolean {
    const w = this.window;
    if (!w || this.mode !== 'puck') return false;
    this.stopDrag();
    const cursor = screen.getCursorScreenPoint();
    const b = w.getBounds();
    const grab = { x: cursor.x - b.x, y: cursor.y - b.y };
    const size = { width: b.width, height: b.height };
    if (CAN_CLICK_THROUGH) w.setIgnoreMouseEvents(false);
    const started = Date.now();
    const timer = setInterval(() => {
      const cur = this.window;
      if (!cur || Date.now() - started > MAX_DRAG_MS) { this.dragEnd(); return; }
      const p = dragPosition(screen.getCursorScreenPoint(), grab);
      // setBounds with the size, not setPosition: crossing onto a monitor
      // with another scale factor otherwise lets Windows resize the window.
      cur.setBounds({ x: p.x, y: p.y, ...size }, false);
    }, DRAG_TICK_MS);
    this.drag = { timer, grab, started };
    return true;
  }

  private stopDrag(): void {
    if (this.drag) { clearInterval(this.drag.timer); this.drag = null; }
  }

  /** Drop: clamp onto the display it landed on and remember the spot there. */
  dragEnd(): StaplerLayout | null {
    if (!this.drag) return this.window ? this.layout() : null;
    this.stopDrag();
    const w = this.window;
    if (!w) return null;
    const b = w.getBounds();
    const displays = screen.getAllDisplays();
    const d = displayForRect(displays, b) ?? screen.getPrimaryDisplay();
    const rect = clampRect({ ...b, width: PUCK_WINDOW.width, height: PUCK_WINDOW.height }, d.workArea);
    w.setBounds(rect, false);
    this.rest = rect;
    this.remember(rect);
    return this.layout();
  }

  /** "Reset puts it in the middle of the screen" — the screen it is on. */
  resetPosition(): void {
    const displays = screen.getAllDisplays();
    const d = (this.rest ? displayForRect(displays, this.rest) : null) ?? screen.getPrimaryDisplay();
    const rect = centerIn(d.workArea, PUCK_WINDOW);
    this.rest = rect;
    this.remember(rect);
    if (this.window) this.setMode(this.mode, this.panel);
  }

  /** Persist the resting spot for the display it is on. */
  private remember(rect: Rect): void {
    const displays = screen.getAllDisplays();
    const d = displayForRect(displays, rect);
    if (!d) return;
    const prev = this.host.placement();
    this.host.savePlacement({
      positions: { ...prev.positions, [String(d.id)]: spotFromRect(d, rect) },
      lastDisplayId: String(d.id)
    });
  }

  private scheduleReclamp(): void {
    if (this.reclampTimer) clearTimeout(this.reclampTimer);
    // Display events arrive in bursts (a dock connects: added + metrics ×3).
    this.reclampTimer = setTimeout(() => {
      this.reclampTimer = null;
      this.reclamp();
    }, 250);
  }

  /** "It never ends up off screen": after any display change. */
  reclamp(): void {
    if (!this.window || !this.rest) return;
    const displays = screen.getAllDisplays();
    const next = reclampPuckRect(displays, screen.getPrimaryDisplay().id, this.rest, this.host.placement());
    if (!next) return;
    this.rest = next.rect;
    this.setMode(this.mode, this.panel);
  }

  applyProtection(on: boolean): void {
    const w = this.window;
    if (w) w.setContentProtection(on);
  }

  /** Out of the way while the screen is captured, so it is not in the shot. */
  hideForCapture(): void {
    const w = this.window;
    this.hiddenForCapture = true;
    if (w && w.isVisible()) w.hide();
  }

  showAfterCapture(): void {
    this.hiddenForCapture = false;
    const w = this.window;
    if (w && !w.isVisible()) w.showInactive();
  }
}
