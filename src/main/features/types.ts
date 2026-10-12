/**
 * The contract between src/main/index.ts and the feature modules (one per
 * Workspace/Stapler unit, see docs/WORKSPACE_UNITS.md).
 *
 * A module never reaches into index.ts. Everything it needs from the app — the
 * windows, config, the hive's home, a way to hand text to an agent — comes in
 * through this context, so eleven units can each live in their own file and
 * index.ts only ever has to know about `registerFeatures`.
 */
import type { BrowserWindow } from 'electron';
import type { HarnessConfig } from '../config';
import type { DeliverRequest } from '../../shared/features/deliver';
import type { RosterEntry } from '../../shared/features/roster';
import type { WorkspaceRoute } from '../../shared/features/route';

/** The renderer HTML entries electron-vite builds (electron.vite.config.ts). */
export type RendererEntry = 'index' | 'stapler';

export interface FeatureContext {
  /** `npm run dev` (renderer served by Vite) vs a built app. */
  readonly isDev: boolean;
  /** Absolute path of the preload every app window uses. Feature windows use
   *  it too, so `window.cth.features.*` exists there. Keep `sandbox: true` and
   *  `contextIsolation: true` on any window that loads it. */
  readonly preloadPath: string;
  /** Load a renderer entry into a window: the Vite dev server in dev
   *  (`<ELECTRON_RENDERER_URL>/stapler.html#hash`), the built file otherwise
   *  (`loadFile(out/renderer/stapler.html, { hash })`). */
  loadRendererEntry(win: BrowserWindow, entry: RendererEntry, hash?: string): Promise<void>;
  /** The most recently focused app window (primary or a floor), or null. */
  getMainWindow(): BrowserWindow | null;
  /** Every live app window — the primary and its floors. NEVER feature windows. */
  appWindows(): BrowserWindow[];
  /** Every live window that is NOT an app window (the puck, overlays). */
  featureWindows(): BrowserWindow[];
  /** Send to every app window. */
  broadcast(channel: string, payload?: unknown): void;
  /** Send to every window, app and feature alike (state the puck shows too). */
  broadcastAll(channel: string, payload?: unknown): void;
  /** Hand text (+ attachments) to an agent or the orchestrator through the main
   *  window's renderer (`feat:deliver` → workspace/deliver.ts). Queued in main
   *  while no renderer is listening, and flushed when one subscribes.
   *  Fire-and-forget: invalid requests are dropped with a warning. */
  deliverToAgent(req: DeliverRequest): void;
  /** Show + focus the main window and navigate its Workspace (`feat:navigate`).
   *  In Classic mode only an agent route has a visible effect (it selects him). */
  navigateMainWindow(route: WorkspaceRoute): void;
  /** The roster the main window last pushed (empty until it has). */
  getRoster(): RosterEntry[];
  /** Subscribe to roster pushes; returns an unsubscribe function. */
  onRosterChanged(cb: (roster: RosterEntry[]) => void): () => void;
  readConfig(): HarnessConfig;
  /** Persist a config patch. Broadcasts `config:changed` to every app window —
   *  prefer feature settings (below) for anything only your unit reads. */
  writeConfig(patch: Partial<HarnessConfig>): HarnessConfig;
  /** app.getPath('userData'). */
  readonly userDataDir: string;
  /** The open hive's home folder (config.harnessHome), or null before
   *  onboarding. The hive itself lives at `<harnessHome>/hive`. */
  harnessHome(): string | null;
  /** `<userData>/features/<name>`, created on first call. */
  featureDataDir(name: string): string;
  /** Per-unit settings, a JSON file at `<featureDataDir(name)>/settings.json`.
   *  Lets a unit keep its own switches without editing config.ts. Missing or
   *  unreadable → `defaults`. */
  readFeatureSettings<T extends object>(name: string, defaults: T): T;
  /** Shallow-merge a patch into the unit's settings file (atomic write) and
   *  return the merged result. */
  writeFeatureSettings<T extends object>(name: string, defaults: T, patch: Partial<T>): T;
}

export interface FeatureModule {
  /** The unit name; also the `<unit>` in its `feat:<unit>:<action>` channels. */
  name: string;
  /** Chromium features this module needs enabled. Applied ONCE, before the app
   *  is ready (`applyEarlyFeatureSwitches`), merged across all modules. */
  earlyEnableFeatures?: string[];
  /** Called once, inside app.whenReady, after the hive services boot and the
   *  primary window is created. Register ipcMain handlers here. */
  register(ctx: FeatureContext): void;
  /** True while this module is capturing audio. ORed into the main window's
   *  microphone permission gate (micFeatureLive in index.ts). */
  micLive?(): boolean;
  /** The last app window closed. Close your own windows here, or Windows and
   *  Linux never see `window-all-closed` and the app never quits. */
  onAppWindowsClosed?(): void;
  /** App is quitting: stop timers, kill child processes, close windows. */
  dispose?(): void;
}
