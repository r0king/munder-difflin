/**
 * Feature layer entry point — the only thing src/main/index.ts imports from
 * src/main/features/.
 *
 * Owns three things and nothing else:
 *   1. the module list and its lifecycle (early Chromium switches, register,
 *      mic gate, last-window-closed, dispose);
 *   2. the FeatureContext every module receives;
 *   3. the renderer bridge: `feat:deliver` / `feat:navigate` out to the main
 *      window, the `feat:roster` snapshot back in, and the queue that holds
 *      deliveries while no renderer is listening.
 *
 * Units never edit this file to add behaviour; they fill in their own module.
 * Adding a twelfth module is the one reason to touch FEATURE_MODULES.
 */
import { app, BrowserWindow, ipcMain, type WebContents } from 'electron';
import { join } from 'node:path';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { HarnessConfig } from '../config';
import { mergeEnableFeatures } from '../../shared/features/switches';
import { FEAT_BRIDGE } from '../../shared/features/channels';
import { isDeliverRequest, type DeliverRequest, type DeliverResult } from '../../shared/features/deliver';
import { sanitizeRoster, type RosterEntry } from '../../shared/features/roster';
import { cleanRoute, isWorkspaceRoute, type WorkspaceRoute } from '../../shared/features/route';
import type { FeatureContext, FeatureModule, RendererEntry } from './types';
import { staplerFeature } from './stapler';
import { transcribeFeature } from './transcribe';
import { dictateFeature } from './dictate';
import { sidebarFeature } from './sidebar';
import { agentsFeature } from './agents';
import { orchestratorFeature } from './orchestrator';
import { tasksFeature } from './tasks';
import { inboxFeature } from './inbox';
import { automationsFeature } from './automations';
import { memoryFeature } from './memory';
import { capabilitiesFeature } from './capabilities';

export type { FeatureContext, FeatureModule, RendererEntry } from './types';

/** Every unit's main-process module, in registration order. transcribe comes
 *  before stapler and dictate, which call into it. */
export const FEATURE_MODULES: readonly FeatureModule[] = [
  transcribeFeature,
  staplerFeature,
  dictateFeature,
  sidebarFeature,
  agentsFeature,
  orchestratorFeature,
  tasksFeature,
  inboxFeature,
  automationsFeature,
  memoryFeature,
  capabilitiesFeature
];

/** What index.ts hands over to build the context. Functions, not values: the
 *  main window and the config change over the app's life. */
export interface FeatureHost {
  isDev: boolean;
  preloadPath: string;
  /** Directory holding the built renderer entries (out/renderer). */
  rendererDir: string;
  /** ELECTRON_RENDERER_URL in dev, undefined in a build. */
  rendererUrl?: string;
  getMainWindow(): BrowserWindow | null;
  appWindows(): BrowserWindow[];
  readConfig(): HarnessConfig;
  writeConfig(patch: Partial<HarnessConfig>): HarnessConfig;
  harnessHome(): string | null;
}

// ─── Early switches ─────────────────────────────────────────────────────────

/**
 * Apply every module's `earlyEnableFeatures` as ONE `--enable-features` value.
 * Must run at module top level in index.ts, before app 'ready': Chromium reads
 * its feature list once, at startup, and a switch appended later is ignored.
 */
export function applyEarlyFeatureSwitches(): void {
  const wanted = FEATURE_MODULES.flatMap((m) => m.earlyEnableFeatures ?? []);
  if (!wanted.length) return;
  const merged = mergeEnableFeatures(app.commandLine.getSwitchValue('enable-features'), wanted);
  if (merged) app.commandLine.appendSwitch('enable-features', merged);
}

// ─── Bridge state ───────────────────────────────────────────────────────────

/** Deliveries held while no renderer bridge is subscribed (boot, reload, the
 *  hive picker). Bounded: a feature stuck in a loop must not grow main's heap. */
const MAX_PENDING_DELIVERIES = 50;
const pendingDeliveries: DeliverRequest[] = [];
/** Only the LAST navigation matters; older ones are superseded. */
let pendingRoute: WorkspaceRoute | null = null;
/** webContents ids whose useFeatureBridge has subscribed (sent `ready`). A
 *  main-frame navigation (reload) clears the mark until the new page re-sends. */
const readyBridges = new Set<number>();
/** Which webContents we already attached lifecycle listeners to. */
const watched = new Set<number>();
/** Latest roster per app webContents (floors are separate offices). */
const rosters = new Map<number, { at: number; list: RosterEntry[] }>();
const rosterListeners = new Set<(roster: RosterEntry[]) => void>();

let host: FeatureHost | null = null;
let ctxSingleton: FeatureContext | null = null;
let registered = false;
let disposed = false;

const liveWin = (w: BrowserWindow | null | undefined): w is BrowserWindow =>
  !!w && !w.isDestroyed() && !w.webContents.isDestroyed();

function watch(wc: WebContents): void {
  if (watched.has(wc.id)) return;
  watched.add(wc.id);
  const id = wc.id;
  wc.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) readyBridges.delete(id);
  });
  wc.once('destroyed', () => {
    readyBridges.delete(id);
    watched.delete(id);
    if (rosters.delete(id)) emitRoster();
  });
}

/** The renderer that should receive bridge traffic: the main window when its
 *  bridge is up, else any app window whose bridge is. */
function bridgeTarget(): WebContents | null {
  if (!host) return null;
  const main = host.getMainWindow();
  if (liveWin(main) && readyBridges.has(main.webContents.id)) return main.webContents;
  for (const w of host.appWindows()) {
    if (liveWin(w) && readyBridges.has(w.webContents.id)) return w.webContents;
  }
  return null;
}

function currentRoster(): RosterEntry[] {
  if (!host) return [];
  const main = host.getMainWindow();
  if (liveWin(main)) {
    const mine = rosters.get(main.webContents.id);
    if (mine) return mine.list;
  }
  let best: { at: number; list: RosterEntry[] } | null = null;
  for (const r of rosters.values()) if (!best || r.at > best.at) best = r;
  return best?.list ?? [];
}

function featureWindows(): BrowserWindow[] {
  const appSet = new Set(host?.appWindows() ?? []);
  return BrowserWindow.getAllWindows().filter((w) => liveWin(w) && !appSet.has(w));
}

function emitRoster(): void {
  const list = currentRoster();
  for (const cb of [...rosterListeners]) {
    try { cb(list); } catch (e) { console.error('[features] roster listener:', e); }
  }
  for (const w of featureWindows()) {
    try { w.webContents.send(FEAT_BRIDGE.rosterChanged, list); } catch { /* window tearing down */ }
  }
}

function deliver(req: DeliverRequest): void {
  if (!isDeliverRequest(req)) {
    console.warn('[features] dropped an invalid delivery request');
    return;
  }
  const wc = bridgeTarget();
  if (wc) {
    try { wc.send(FEAT_BRIDGE.deliver, req); return; } catch { /* fall through to the queue */ }
  }
  pendingDeliveries.push(req);
  if (pendingDeliveries.length > MAX_PENDING_DELIVERIES) {
    pendingDeliveries.shift();
    console.warn('[features] delivery queue full — dropped the oldest pending delivery');
  }
}

function navigate(route: WorkspaceRoute): void {
  if (!isWorkspaceRoute(route) || !host) return;
  const clean = cleanRoute(route);
  const win = liveWin(host.getMainWindow()) ? host.getMainWindow() : host.appWindows().find(liveWin) ?? null;
  if (liveWin(win)) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
  const wc = bridgeTarget();
  if (wc) {
    try { wc.send(FEAT_BRIDGE.navigate, clean); return; } catch { /* hold it */ }
  }
  pendingRoute = clean;
}

// ─── Context ────────────────────────────────────────────────────────────────

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function featureDataDir(name: string): string {
  if (!SAFE_NAME.test(name)) throw new Error(`invalid feature name: ${name}`);
  const dir = join(app.getPath('userData'), 'features', name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function readFeatureSettings<T extends object>(name: string, defaults: T): T {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(featureDataDir(name), 'settings.json'), 'utf8'));
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) return { ...defaults, ...(raw as Partial<T>) };
  } catch { /* missing or corrupt — defaults */ }
  return { ...defaults };
}

function writeFeatureSettings<T extends object>(name: string, defaults: T, patch: Partial<T>): T {
  const next = { ...readFeatureSettings(name, defaults), ...patch };
  const file = join(featureDataDir(name), 'settings.json');
  // Write-then-rename so a crash mid-write leaves the previous file intact.
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
  renameSync(tmp, file);
  return next;
}

/** Build the context index.ts passes to `registerFeatures`. */
export function createFeatureContext(h: FeatureHost): FeatureContext {
  host = h;
  const ctx: FeatureContext = {
    isDev: h.isDev,
    preloadPath: h.preloadPath,
    loadRendererEntry: (win, entry: RendererEntry, hash?: string) => {
      const frag = (hash ?? '').replace(/^#/, '');
      if (h.isDev && h.rendererUrl) {
        const base = h.rendererUrl.replace(/\/+$/, '');
        const url = entry === 'index' ? `${base}/` : `${base}/${entry}.html`;
        return win.loadURL(frag ? `${url}#${frag}` : url);
      }
      return win.loadFile(join(h.rendererDir, `${entry}.html`), frag ? { hash: frag } : undefined);
    },
    getMainWindow: () => {
      const w = h.getMainWindow();
      return liveWin(w) ? w : null;
    },
    appWindows: () => h.appWindows().filter(liveWin),
    featureWindows,
    broadcast: (channel, payload) => {
      for (const w of h.appWindows()) {
        if (!liveWin(w)) continue;
        try { w.webContents.send(channel, payload); } catch { /* tearing down */ }
      }
    },
    broadcastAll: (channel, payload) => {
      for (const w of BrowserWindow.getAllWindows()) {
        if (!liveWin(w)) continue;
        try { w.webContents.send(channel, payload); } catch { /* tearing down */ }
      }
    },
    deliverToAgent: deliver,
    navigateMainWindow: navigate,
    getRoster: currentRoster,
    onRosterChanged: (cb) => {
      rosterListeners.add(cb);
      return () => { rosterListeners.delete(cb); };
    },
    readConfig: () => h.readConfig(),
    writeConfig: (patch) => h.writeConfig(patch),
    userDataDir: app.getPath('userData'),
    harnessHome: () => h.harnessHome(),
    featureDataDir,
    readFeatureSettings,
    writeFeatureSettings
  };
  ctxSingleton = ctx;
  return ctx;
}

/** The context, once created. For a module's helper that runs outside
 *  `register` (e.g. transcribeFile called from the stapler module). */
export function featureContext(): FeatureContext | null {
  return ctxSingleton;
}

function registerBridgeIpc(ctx: FeatureContext): void {
  ipcMain.on(FEAT_BRIDGE.roster, (evt, list: unknown) => {
    watch(evt.sender);
    rosters.set(evt.sender.id, { at: Date.now(), list: sanitizeRoster(list) });
    emitRoster();
  });
  ipcMain.handle(FEAT_BRIDGE.ready, (evt) => {
    watch(evt.sender);
    readyBridges.add(evt.sender.id);
    const deliveries = pendingDeliveries.splice(0, pendingDeliveries.length);
    const navigateTo = pendingRoute;
    pendingRoute = null;
    return { deliveries, navigate: navigateTo };
  });
  ipcMain.handle(FEAT_BRIDGE.rosterGet, () => ctx.getRoster());
  ipcMain.handle(FEAT_BRIDGE.deliverRequest, (_evt, req: unknown): DeliverResult => {
    if (!isDeliverRequest(req)) return { ok: false, error: 'invalid delivery request' };
    // Reject a target we can SEE is wrong. With no roster yet (boot) we cannot
    // tell, so it is queued and the renderer's deliverToAgent decides.
    const roster = ctx.getRoster();
    if (req.target.kind === 'agent' && roster.length > 0) {
      const agentId = req.target.agentId;
      if (!roster.some((a) => a.id === agentId)) return { ok: false, error: `unknown agent: ${agentId}` };
    }
    ctx.deliverToAgent(req);
    return { ok: true };
  });
  ipcMain.handle(FEAT_BRIDGE.navigateRequest, (_evt, route: unknown) => {
    if (!isWorkspaceRoute(route)) return { ok: false, error: 'invalid route' };
    ctx.navigateMainWindow(route);
    return { ok: true };
  });
}

/** Register the bridge and every module. Once; a module that throws is logged
 *  and skipped so one unit's bug cannot take the app's boot down with it. */
export function registerFeatures(ctx: FeatureContext): void {
  if (registered) return;
  registered = true;
  registerBridgeIpc(ctx);
  for (const m of FEATURE_MODULES) {
    try { m.register(ctx); } catch (e) { console.error(`[features] ${m.name}.register failed:`, e); }
  }
}

/** True while any module is capturing audio (ORed into the mic gate). */
export function featureMicLive(): boolean {
  return FEATURE_MODULES.some((m) => {
    try { return m.micLive?.() === true; } catch { return false; }
  });
}

/** The last app window closed (see FeatureModule.onAppWindowsClosed). */
export function notifyAppWindowsClosed(): void {
  for (const m of FEATURE_MODULES) {
    try { m.onAppWindowsClosed?.(); } catch (e) { console.error(`[features] ${m.name}.onAppWindowsClosed:`, e); }
  }
}

/** Quit: dispose every module, once, in reverse registration order. */
export function disposeFeatures(): void {
  if (disposed) return;
  disposed = true;
  for (const m of [...FEATURE_MODULES].reverse()) {
    try { m.dispose?.(); } catch (e) { console.error(`[features] ${m.name}.dispose:`, e); }
  }
  rosterListeners.clear();
}
