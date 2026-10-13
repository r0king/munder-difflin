/**
 * Screenshot: freeze the display under the cursor, let the user drag a region
 * on a full-screen overlay, crop at physical-pixel scale, save a PNG.
 *
 * The capture is a desktopCapturer thumbnail requested at the display's
 * physical resolution, so the crop is as sharp as the screen. The full image
 * stays in main (a NativeImage); the overlay only gets a JPEG of it to draw —
 * a 5K screen as PNG is tens of MB over IPC, as JPEG a couple — and the crop
 * is cut from the original, never from what the overlay displayed.
 *
 * macOS needs the Screen Recording permission. Without it desktopCapturer
 * succeeds but returns the wallpaper with no windows, which would be a silent
 * lie; so the status is checked first and the user is told how to grant it.
 */
import {
  BrowserWindow,
  desktopCapturer,
  screen,
  systemPreferences,
  type Display,
  type NativeImage,
  type WebContents
} from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { FeatureContext } from '../types';
import {
  fitRegion,
  regionToPixels,
  type OverlayInit,
  type Region,
  type ScreenshotStart
} from '../../../shared/features/stapler';

const IS_MAC = process.platform === 'darwin';

/** An overlay nobody answers (the user walked away) gives up after this. */
const OVERLAY_TIMEOUT_MS = 5 * 60_000;
/** Time for the compositor to drop the hidden puck before the capture. */
const HIDE_SETTLE_MS = IS_MAC ? 220 : 140;
/** Tray thumbnails: small enough for the draft file, big enough to recognise. */
const THUMB_MAX = { width: 240, height: 160 };

export type ScreenPermission = 'granted' | 'denied' | 'not-determined' | 'restricted' | 'unknown';

export function screenPermission(): ScreenPermission {
  if (!IS_MAC) return 'granted';
  try { return systemPreferences.getMediaAccessStatus('screen'); } catch { return 'unknown'; }
}

export interface SavedShot {
  path: string;
  width: number;
  height: number;
  thumb: string;
  displayId: string;
  region: Region;
}

interface Capture {
  displayId: string;
  bounds: Display['bounds'];
  image: NativeImage;
  view: { width: number; height: number };
}

export interface ScreenshotHost {
  ctx: FeatureContext;
  shotsDir(): string;
  /** Remembered region for a display (CSS px). */
  rememberedRegion(displayId: string): Region | undefined;
  shotCount(): number;
  protection(): boolean;
  /** Before capture / after the overlay closes. */
  hidePuck(): void;
  showPuck(): void;
  /** A shot was saved (the overlay is already closing). */
  onShot(shot: SavedShot): void;
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * The capturer source for a display. `display_id` matches on macOS and
 * Windows; some Linux backends leave it empty, where the sources come back in
 * screen.getAllDisplays() order — or there is only one.
 */
function sourceFor(sources: Electron.DesktopCapturerSource[], display: Display): Electron.DesktopCapturerSource | null {
  const byId = sources.find((s) => s.display_id && s.display_id === String(display.id));
  if (byId) return byId;
  if (sources.length === 1) return sources[0];
  const idx = screen.getAllDisplays().findIndex((d) => d.id === display.id);
  return (idx >= 0 ? sources[idx] : null) ?? sources[0] ?? null;
}

export class ScreenshotController {
  private overlay: BrowserWindow | null = null;
  private capture: Capture | null = null;
  private busy = false;
  private timeout: NodeJS.Timeout | null = null;

  constructor(private readonly host: ScreenshotHost) {}

  isOverlay(wc: WebContents): boolean {
    const o = this.overlay;
    return !!o && !o.isDestroyed() && !o.webContents.isDestroyed() && o.webContents.id === wc.id;
  }

  overlayWindow(): BrowserWindow | null {
    return this.overlay && !this.overlay.isDestroyed() ? this.overlay : null;
  }

  async start(maxShots: number): Promise<ScreenshotStart> {
    if (this.busy || this.overlayWindow()) {
      this.overlayWindow()?.focus();
      return { ok: false, error: 'busy' };
    }
    if (this.host.shotCount() >= maxShots) return { ok: false, error: 'limit' };
    const perm = screenPermission();
    if (perm !== 'granted') {
      // First ask: touching desktopCapturer is what makes macOS list the app
      // under Screen Recording and show its prompt. The answer only takes
      // effect after a relaunch, so this attempt still reports 'permission'.
      if (perm === 'not-determined') {
        try { await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } }); } catch { /* prompt only */ }
      }
      return { ok: false, error: 'permission', detail: perm };
    }
    this.busy = true;
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    this.host.hidePuck();
    try {
      await delay(HIDE_SETTLE_MS);
      const size = {
        width: Math.max(1, Math.round(display.bounds.width * display.scaleFactor)),
        height: Math.max(1, Math.round(display.bounds.height * display.scaleFactor))
      };
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size, fetchWindowIcons: false });
      const src = sourceFor(sources, display);
      if (!src || src.thumbnail.isEmpty()) {
        this.host.showPuck();
        return { ok: false, error: 'capture-failed' };
      }
      this.capture = {
        displayId: String(display.id),
        bounds: display.bounds,
        image: src.thumbnail,
        view: { width: display.bounds.width, height: display.bounds.height }
      };
      this.openOverlay(display);
      return { ok: true };
    } catch (e) {
      console.error('[stapler] screen capture failed:', e);
      this.capture = null;
      this.host.showPuck();
      return { ok: false, error: 'capture-failed', detail: e instanceof Error ? e.message : String(e) };
    } finally {
      this.busy = false;
    }
  }

  private openOverlay(display: Display): void {
    const { ctx } = this.host;
    const win = new BrowserWindow({
      ...display.bounds,
      show: false,
      frame: false,
      transparent: false,
      backgroundColor: '#1A1320',
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      enableLargerThanScreen: true,
      roundedCorners: false,
      title: 'Stapler',
      webPreferences: {
        preload: ctx.preloadPath,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: false
      }
    });
    this.overlay = win;
    win.setAlwaysOnTop(true, 'screen-saver');
    if (IS_MAC) {
      try { win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true }); } catch { /* best-effort */ }
    }
    win.setContentProtection(this.host.protection());
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.once('ready-to-show', () => {
      if (win.isDestroyed()) return;
      // Again after creation: macOS clamps a new window below the menu bar,
      // and the overlay must cover the whole display the image was taken of.
      win.setBounds(display.bounds, false);
      win.show();
      win.focus();
    });
    win.on('closed', () => {
      if (this.overlay === win) this.overlay = null;
      this.capture = null;
      if (this.timeout) { clearTimeout(this.timeout); this.timeout = null; }
      this.host.showPuck();
    });
    win.webContents.on('render-process-gone', () => this.close());
    this.timeout = setTimeout(() => this.close(), OVERLAY_TIMEOUT_MS);
    void ctx.loadRendererEntry(win, 'stapler', 'overlay').catch((e) => {
      console.error('[stapler] overlay load failed:', e);
      this.close();
    });
  }

  /** What the overlay draws. */
  init(): OverlayInit {
    const c = this.capture;
    if (!c) return { ok: false, error: 'no-capture' };
    return {
      ok: true,
      image: `data:image/jpeg;base64,${c.image.toJPEG(88).toString('base64')}`,
      width: c.view.width,
      height: c.view.height,
      remembered: fitRegion(this.host.rememberedRegion(c.displayId), c.view),
      shotCount: this.host.shotCount()
    };
  }

  /** Crop, save, hand the shot over, close. */
  commit(region: unknown): { ok: boolean; error?: string } {
    const c = this.capture;
    if (!c) return { ok: false, error: 'no-capture' };
    const r = fitRegion(region, c.view);
    if (!r) return { ok: false, error: 'region' };
    try {
      const px = regionToPixels(r, c.view, c.image.getSize());
      const cropped = c.image.crop(px);
      const dir = this.host.shotsDir();
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `shot-${stamp()}-${randomBytes(3).toString('hex')}.png`);
      writeFileSync(file, cropped.toPNG());
      const scale = Math.min(1, THUMB_MAX.width / px.width, THUMB_MAX.height / px.height);
      const thumbImg = scale < 1
        ? cropped.resize({ width: Math.max(1, Math.round(px.width * scale)), height: Math.max(1, Math.round(px.height * scale)), quality: 'good' })
        : cropped;
      const shot: SavedShot = {
        path: file,
        width: px.width,
        height: px.height,
        thumb: thumbImg.toDataURL(),
        displayId: c.displayId,
        region: r
      };
      this.close();
      this.host.onShot(shot);
      return { ok: true };
    } catch (e) {
      console.error('[stapler] saving the shot failed:', e);
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  close(): void {
    const o = this.overlayWindow();
    this.capture = null;
    if (this.timeout) { clearTimeout(this.timeout); this.timeout = null; }
    if (o) {
      try { o.destroy(); } catch { /* gone */ }
    } else {
      this.host.showPuck();
    }
  }

  applyProtection(on: boolean): void {
    const o = this.overlayWindow();
    if (o) o.setContentProtection(on);
  }
}
