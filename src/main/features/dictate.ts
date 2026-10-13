/**
 * Dictate into any app — main-process side (owned by the `dictate` unit).
 *
 * Press the shortcut, talk, press it again (or, where the OS repeats a held
 * hotkey, hold it and let go): the words land in whatever field is in front
 * of you, and in every text box inside Munder Difflin.
 *
 *   shortcut / ring ─▶ start: note which window has focus, open the mic in the
 *                      hidden recorder window (dictate/host.ts → stapler.html#dictate)
 *   second press ───▶ stop: the recorder writes a WAV (transcribe unit's capture),
 *                      transcribeFile() turns it into text
 *   insert ─────────▶ a Munder Difflin window was in front → its renderer puts the
 *                      text at the caret (useDictationInsert);
 *                      another app → clipboard + paste key (dictate/insert.ts),
 *                      or the clipboard alone with the reason why.
 *
 * Why the shortcut toggles: globalShortcut cannot see a key-up or bind a bare
 * modifier, and this unit adds no native keyboard hook (see press.ts for how a
 * held key is still recognised where the OS repeats it).
 *
 * State is pushed to every window (`feat:dictate:state`) — the puck and the
 * settings render it; errors and "left on the clipboard" also raise a system
 * notification, worded by the recorder window in the user's language (with an
 * English fallback from main when that window is not up).
 *
 * Channels: feat:dictate:{toggle,cancel,getState,getSettings,setSettings,
 * getStatus,requestPermission,copyLast} (invoke), feat:dictate:state and
 * feat:dictate:level (push), feat:dictate:insert / insertReady / insertResult
 * (app windows), feat:dictate:host:{ready,command,event} (recorder window).
 */
import { realpathSync } from 'node:fs';
import { extname, sep } from 'node:path';
import { BrowserWindow, Notification, globalShortcut, ipcMain, webContents, type WebContents } from 'electron';
import {
  DEFAULT_DICTATE_STATE,
  cleanTranscript,
  defaultDictateConfig,
  toDictatePlatform,
  validateAccelerator,
  type DictateConfig,
  type DictateErrorCode,
  type DictateHostEvent,
  type DictateInsertReply,
  type DictateOutcome,
  type DictatePlatformStatus,
  type DictateSetResult,
  type DictateState,
  type ShortcutError
} from '../../shared/features/dictate';
import { newSessionId } from '../../shared/features/transcribe';
import { transcribeFile } from './transcribe';
import type { FeatureContext, FeatureModule } from './types';
import { applyDictatePatch, sanitizeDictateConfig } from './dictate/config';
import { DictationHost } from './dictate/host';
import { copyToClipboard, flushPendingRestore, insertIntoFrontApp } from './dictate/insert';
import {
  ensureMicrophone,
  macFrontmostIsUs,
  microphoneStatus,
  openPermissionSettings,
  platformStatus,
  promptAccessibility
} from './dictate/platform';
import { beginPress, checkRelease, onTrigger, type PressState } from './dictate/press';
// The English strings, for the rare notification main has to show itself.
import enStrings from '../../renderer/src/i18n/features/dictate.en.json';

const PLATFORM = toDictatePlatform(process.platform);
const SETTINGS = 'dictate';

/** Host ready → mic open. Covers a slow device, not the macOS prompt (main
 *  waits for that before asking the recorder). */
const START_TIMEOUT_MS = 12_000;
/** Stop → WAV on disk. */
const CAPTURE_TIMEOUT_MS = 15_000;
/** An app window must answer an insert this fast (it is a DOM call). */
const INSERT_REPLY_TIMEOUT_MS = 2_500;
/** How long 'error' stays on screen before the puck goes back to idle. */
const ERROR_LINGER_MS = 5_000;
const RELEASE_POLL_MS = 100;
/** Keep the recorder warm this long after a ring-started dictation while
 *  dictation itself is off. */
const HOST_RETIRE_MS = 30_000;

/** Transcription budget: model load + ~2× real time on a slow CPU, capped. */
function transcribeBudget(durationMs: number): number {
  return Math.min(10 * 60_000, 90_000 + 2 * Math.max(0, durationMs));
}

type RunTarget =
  | { kind: 'app'; wcId: number }
  /** `ourWcId`: one of our windows had focus at the start but cannot insert
   *  by itself (no useDictationInsert there) — a native paste into it is fine. */
  | { kind: 'external'; ourWcId: number | null };

interface Run {
  token: number;
  sessionId: string;
  target: RunTarget;
  /** Set for a shortcut-started run: reads repeats as hold / release. */
  press: PressState | null;
  cancelled: boolean;
  timers: Set<ReturnType<typeof setTimeout>>;
  releasePoll: ReturnType<typeof setInterval> | null;
}

let ctx: FeatureContext | null = null;
let config: DictateConfig = defaultDictateConfig(PLATFORM);
let state: DictateState = { ...DEFAULT_DICTATE_STATE };
let run: Run | null = null;
let nextToken = 1;
let host: DictationHost | null = null;
let registeredToggle: string | null = null;
let registeredCancel: string | null = null;
let errorTimer: ReturnType<typeof setTimeout> | null = null;
let retireTimer: ReturnType<typeof setTimeout> | null = null;
/** macOS: the Accessibility prompt is shown once per launch, not per dictation. */
let accessibilityPrompted = false;

/** App windows whose renderer can insert at its caret. */
const insertReady = new Set<number>();
const watchedInsert = new Set<number>();
const pendingInserts = new Map<number, { wcId: number; resolve: (r: DictateInsertReply) => void }>();
let nextInsertId = 1;

// ─── State ──────────────────────────────────────────────────────────────────

function publish(patch: Partial<DictateState>): void {
  state = { ...state, ...patch };
  ctx?.broadcastAll('feat:dictate:state', state);
}

function capturing(): boolean {
  return state.phase === 'starting' || state.phase === 'recording';
}

// ─── Shortcuts ──────────────────────────────────────────────────────────────

function tryRegister(acc: string, cb: () => void): { ok: boolean; error?: ShortcutError } {
  try {
    if (globalShortcut.isRegistered(acc)) return { ok: false, error: 'taken' };
    const ok = globalShortcut.register(acc, cb);
    return ok ? { ok: true } : { ok: false, error: 'taken' };
  } catch (e) {
    console.warn('[dictate] could not register', acc, e);
    return { ok: false, error: 'unavailable' };
  }
}

function unregister(acc: string | null): void {
  if (!acc) return;
  try { globalShortcut.unregister(acc); } catch { /* already gone */ }
}

function applyToggleShortcut(): void {
  unregister(registeredToggle);
  registeredToggle = null;
  const accelerator = config.accelerator;
  if (!config.enabled) {
    publish({ enabled: false, shortcut: { accelerator, registered: false } });
    return;
  }
  const check = validateAccelerator(accelerator, PLATFORM, 'toggle', config.cancelAccelerator);
  if (!check.ok) {
    publish({ enabled: true, shortcut: { accelerator, registered: false, error: check.error } });
    return;
  }
  const r = tryRegister(check.accelerator, onShortcut);
  if (r.ok) registeredToggle = check.accelerator;
  publish({ enabled: true, shortcut: { accelerator, registered: r.ok, ...(r.error ? { error: r.error } : {}) } });
}

/** The cancel key is held only while a dictation runs, so a bare Escape is
 *  borrowed from other apps for seconds, not all day. */
function registerCancelShortcut(): void {
  if (registeredCancel) return;
  const acc = config.cancelAccelerator;
  const r = tryRegister(acc, () => cancel());
  if (r.ok) registeredCancel = acc;
  publish({ cancelShortcut: { accelerator: acc, registered: r.ok, ...(r.error ? { error: r.error } : {}) } });
}

function unregisterCancelShortcut(): void {
  if (!registeredCancel) return;
  unregister(registeredCancel);
  registeredCancel = null;
  publish({ cancelShortcut: { accelerator: config.cancelAccelerator, registered: false } });
}

function onShortcut(): void {
  const now = Date.now();
  const r = run;
  if (r && capturing()) {
    if (!r.press) { stopOrCancel(r); return; } // started from the ring: any press stops
    const t = onTrigger(r.press, now);
    r.press = t.state;
    if (t.action === 'stop') stopOrCancel(r);
    return;
  }
  if (r) return; // transcribing / inserting: busy, the press is ignored
  void start(now, true);
}

function stopOrCancel(r: Run): void {
  if (state.phase === 'recording') stop(r);
  else cancel();
}

function pollRelease(r: Run): void {
  if (run !== r || !r.press) return;
  const c = checkRelease(r.press, Date.now());
  r.press = c.state;
  if (c.verdict === 'stop' && state.phase === 'recording') stop(r);
}

// ─── The run ────────────────────────────────────────────────────────────────

function later(r: Run, ms: number, fn: () => void): void {
  const t = setTimeout(() => { r.timers.delete(t); fn(); }, ms);
  r.timers.add(t);
}

function clearRunTimers(r: Run): void {
  for (const t of r.timers) clearTimeout(t);
  r.timers.clear();
  if (r.releasePoll) { clearInterval(r.releasePoll); r.releasePoll = null; }
}

function hostInstance(): DictationHost {
  if (!host) {
    if (!ctx) throw new Error('dictate is not registered');
    host = new DictationHost(ctx, (reason) => {
      const r = run;
      if (r && (capturing() || state.phase === 'transcribing')) fail(r, 'host-failed', reason);
    });
  }
  return host;
}

/** Off and idle: close the recorder after a while (it is only kept warm
 *  while dictation is enabled). */
function scheduleHostRetire(): void {
  if (retireTimer) clearTimeout(retireTimer);
  retireTimer = null;
  if (config.enabled || !host) return;
  retireTimer = setTimeout(() => {
    retireTimer = null;
    if (!config.enabled && !run) host?.destroy();
  }, HOST_RETIRE_MS);
}

function endRun(r: Run): void {
  clearRunTimers(r);
  if (run === r) run = null;
  unregisterCancelShortcut();
  scheduleHostRetire();
}

function chooseTarget(): RunTarget {
  const focused = BrowserWindow.getFocusedWindow();
  const wc = focused && !focused.isDestroyed() ? focused.webContents : null;
  if (!wc || host?.isHost(wc)) return { kind: 'external', ourWcId: null };
  return insertReady.has(wc.id) ? { kind: 'app', wcId: wc.id } : { kind: 'external', ourWcId: wc.id };
}

async function start(now: number, fromShortcut: boolean): Promise<void> {
  if (!ctx || run) return;
  // Windows and Linux quit with their last app window; a recorder created now
  // would keep the process alive. A Mac app outlives its windows.
  if (PLATFORM !== 'darwin' && ctx.appWindows().length === 0) return;
  if (errorTimer) { clearTimeout(errorTimer); errorTimer = null; }
  if (retireTimer) { clearTimeout(retireTimer); retireTimer = null; }

  const r: Run = {
    token: nextToken++,
    sessionId: newSessionId(now),
    target: chooseTarget(),
    press: fromShortcut ? beginPress(now) : null,
    cancelled: false,
    timers: new Set(),
    releasePoll: null
  };
  run = r;
  publish({ phase: 'starting', startedAt: null, stopsAt: null, target: r.target.kind, error: null });
  registerCancelShortcut();
  if (r.press) r.releasePoll = setInterval(() => pollRelease(r), RELEASE_POLL_MS);

  // Ask the OS first: the macOS prompt can sit on screen for a while, and the
  // recorder's own timeout must not run during it.
  const micOk = await ensureMicrophone(PLATFORM);
  if (run !== r) return;
  if (!micOk) { fail(r, 'mic-denied'); return; }

  try {
    await hostInstance().ensure();
  } catch (e) {
    if (run === r) fail(r, 'host-failed', e instanceof Error ? e.message : String(e));
    return;
  }
  if (run !== r) return;
  if (!hostInstance().send({ cmd: 'start', token: r.token, sessionId: r.sessionId })) {
    fail(r, 'host-failed', 'the recorder window is not listening');
    return;
  }
  later(r, START_TIMEOUT_MS, () => {
    if (run === r && state.phase === 'starting') fail(r, 'mic-unavailable', 'the microphone did not open in time');
  });
}

function stop(r: Run): void {
  if (run !== r || state.phase !== 'recording') return;
  clearRunTimers(r);
  publish({ phase: 'transcribing', stopsAt: null });
  hostInstance().send({ cmd: 'stop', token: r.token });
  later(r, CAPTURE_TIMEOUT_MS, () => {
    if (run === r && state.phase === 'transcribing') fail(r, 'capture-timeout');
  });
}

/** Abandon the running dictation; nothing is typed. */
function cancel(): void {
  const r = run;
  if (!r || state.phase === 'inserting') return; // too late to take it back
  r.cancelled = true;
  host?.send({ cmd: 'cancel', token: r.token });
  endRun(r);
  publish({ phase: 'idle', target: null, startedAt: null, stopsAt: null, error: null });
}

function fail(r: Run, code: DictateErrorCode, detail?: string): void {
  if (run !== r) return;
  host?.send({ cmd: 'cancel', token: r.token });
  const error = { code, ...(detail ? { detail: detail.slice(0, 300) } : {}) };
  // Notify before endRun: it may schedule the recorder (our translator) to close.
  notify('dictate.notify.failed', `dictate.error.${code}`, { detail: error.detail ?? '' });
  endRun(r);
  publish({ phase: 'error', error, target: null, startedAt: null, stopsAt: null });
  if (errorTimer) clearTimeout(errorTimer);
  errorTimer = setTimeout(() => {
    errorTimer = null;
    if (!run && state.phase === 'error') publish({ phase: 'idle' });
  }, ERROR_LINGER_MS);
}

// ─── Recorder events ────────────────────────────────────────────────────────

function isHostEvent(v: unknown): v is DictateHostEvent {
  if (!v || typeof v !== 'object') return false;
  const e = v as Record<string, unknown>;
  if (typeof e.token !== 'number') return false;
  switch (e.type) {
    case 'started': return true;
    case 'level': return typeof e.level === 'number';
    case 'failed': return e.code === 'mic-denied' || e.code === 'mic-unavailable' || e.code === 'capture-failed';
    case 'captured': return typeof e.wavPath === 'string' && e.wavPath.length < 4096 && typeof e.durationMs === 'number';
    default: return false;
  }
}

function onHostEvent(evt: DictateHostEvent): void {
  const r = run;
  if (!r || evt.token !== r.token) return; // a cancelled or finished run
  switch (evt.type) {
    case 'started': {
      if (state.phase !== 'starting') return;
      clearRunTimers(r);
      if (r.press) r.releasePoll = setInterval(() => pollRelease(r), RELEASE_POLL_MS);
      const now = Date.now();
      const maxMs = config.maxSeconds * 1000;
      publish({ phase: 'recording', startedAt: now, stopsAt: now + maxMs });
      // The safety stop: a forgotten dictation ends (and is typed) on its own.
      later(r, maxMs, () => stop(r));
      return;
    }
    case 'level': {
      if (state.phase !== 'recording' || !ctx) return;
      const level = Math.max(0, Math.min(1, evt.level));
      for (const w of ctx.featureWindows()) {
        if (host?.isHost(w.webContents)) continue;
        try { w.webContents.send('feat:dictate:level', level); } catch { /* closing */ }
      }
      return;
    }
    case 'failed':
      fail(r, evt.code, evt.detail);
      return;
    case 'captured':
      if (state.phase !== 'transcribing') return;
      clearRunTimers(r);
      void transcribeAndInsert(r, evt.wavPath, evt.durationMs);
      return;
  }
}

/**
 * The recorder names the WAV it wrote; main reads that file, so it must be
 * one of the transcribe unit's own session files and nothing else (no `..`,
 * no symlink out of the folder).
 */
function containedWav(p: string): string | null {
  if (!ctx || extname(p).toLowerCase() !== '.wav') return null;
  try {
    const root = realpathSync(ctx.featureDataDir('transcribe'));
    const real = realpathSync(p);
    return real.startsWith(root + sep) ? real : null;
  } catch {
    return null;
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | 'timeout'> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve('timeout'), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e: unknown) => { clearTimeout(t); reject(e); });
  });
}

async function transcribeAndInsert(r: Run, wavPath: string, durationMs: number): Promise<void> {
  const wav = containedWav(wavPath);
  if (!wav) { fail(r, 'capture-failed', 'the recording is not where it should be'); return; }
  let result;
  try {
    result = await withTimeout(transcribeFile(wav), transcribeBudget(durationMs));
  } catch (e) {
    if (run === r) fail(r, 'transcribe-failed', e instanceof Error ? e.message : String(e));
    return;
  }
  if (run !== r || r.cancelled) return;
  if (result === 'timeout') { fail(r, 'transcribe-timeout'); return; }
  if (!result.ok) { fail(r, 'transcribe-failed', result.error); return; }
  const text = cleanTranscript(result.text);
  if (!text) { fail(r, 'nothing-heard'); return; }

  // Past the point of no return: the cancel key goes back to its owner.
  unregisterCancelShortcut();
  publish({ phase: 'inserting' });
  let outcome: DictateOutcome;
  try {
    outcome = await deliverText(r, text);
  } catch (e) {
    copyToClipboard(text);
    outcome = { at: Date.now(), strategy: 'clipboard', notice: 'paste-failed', text };
    console.error('[dictate] insert failed:', e);
  }
  if (run !== r) return;
  endRun(r);
  publish({ phase: 'idle', target: null, startedAt: null, stopsAt: null, error: null, last: outcome });
  if (outcome.notice && outcome.notice !== 'user-choice') {
    notify('dictate.notify.copied', `dictate.notice.${outcome.notice}`);
  }
}

// ─── Inserting ──────────────────────────────────────────────────────────────

function requestInsert(wc: WebContents, text: string): Promise<DictateInsertReply> {
  const id = nextInsertId++;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingInserts.delete(id);
      resolve({ id, ok: false, reason: 'failed' });
    }, INSERT_REPLY_TIMEOUT_MS);
    pendingInserts.set(id, {
      wcId: wc.id,
      resolve: (reply) => { clearTimeout(timer); pendingInserts.delete(id); resolve(reply); }
    });
    try {
      wc.send('feat:dictate:insert', { id, text });
    } catch {
      clearTimeout(timer);
      pendingInserts.delete(id);
      resolve({ id, ok: false, reason: 'failed' });
    }
  });
}

/** Would a paste key now land in one of OUR windows rather than the app the
 *  user started in? (The puck was clicked, or our app came forward.) */
async function ourWindowInFront(target: RunTarget): Promise<boolean> {
  const startedIn = target.kind === 'external' ? target.ourWcId : null;
  const focused = BrowserWindow.getFocusedWindow();
  if (focused && !focused.isDestroyed() && !host?.isHost(focused.webContents)) {
    return focused.webContents.id !== startedIn;
  }
  // macOS can make our app frontmost with no key window (a click on a
  // non-activating window); only NSWorkspace can tell.
  if (PLATFORM === 'darwin' && config.pasteMode === 'paste' && startedIn === null) {
    return (await macFrontmostIsUs()) === true;
  }
  return false;
}

async function deliverText(r: Run, text: string): Promise<DictateOutcome> {
  const at = Date.now();
  if (r.target.kind === 'app') {
    const wc = webContents.fromId(r.target.wcId);
    if (wc && !wc.isDestroyed() && insertReady.has(wc.id)) {
      const reply = await requestInsert(wc, text);
      if (reply.ok) return { at, strategy: 'in-app', text };
      copyToClipboard(text);
      return { at, strategy: 'clipboard', notice: reply.reason === 'no-field' ? 'no-field' : 'paste-failed', text };
    }
    // The window closed while the user talked: type into whatever is in front.
  }
  if (await ourWindowInFront(r.target)) {
    copyToClipboard(text);
    return { at, strategy: 'clipboard', notice: 'focus-ours', text };
  }
  const res = await insertIntoFrontApp(text, {
    platform: PLATFORM,
    pasteMode: config.pasteMode,
    restoreClipboard: config.restoreClipboard
  });
  if (res.notice === 'accessibility' && !accessibilityPrompted) {
    accessibilityPrompted = true;
    promptAccessibility(PLATFORM);
  }
  return { at, strategy: res.strategy, ...(res.notice ? { notice: res.notice } : {}), text };
}

// ─── Notifications ──────────────────────────────────────────────────────────

function english(key: string, params: Record<string, string>): string {
  let node: unknown = enStrings;
  for (const part of key.replace(/^dictate\./, '').split('.')) {
    node = node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined;
  }
  const s = typeof node === 'string' ? node : '';
  return s.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, k: string) => params[k] ?? '');
}

/** A system notification, worded by the recorder window (it has i18n), or by
 *  main in English when that window is not up. */
function notify(title: string, body: string, params: Record<string, string> = {}): void {
  if (host?.send({ cmd: 'notify', title, body, params })) return;
  try {
    if (!Notification.isSupported()) return;
    new Notification({ title: english(title, params), body: english(body, params), silent: true }).show();
  } catch { /* no notification server */ }
}

// ─── Settings ───────────────────────────────────────────────────────────────

function loadConfig(c: FeatureContext): DictateConfig {
  return sanitizeDictateConfig(c.readFeatureSettings<Record<string, unknown>>(SETTINGS, {}), PLATFORM);
}

function setSettings(patch: unknown): DictateSetResult {
  if (!ctx) return { ok: false, field: 'enabled', error: 'invalid', config };
  const r = applyDictatePatch(config, patch, PLATFORM);
  if (!r.ok) return { ok: false, field: r.field, error: r.error, config };
  const wasEnabled = config.enabled;
  try {
    const written = ctx.writeFeatureSettings<Record<string, unknown>>(SETTINGS, {}, { ...r.config });
    config = sanitizeDictateConfig(written, PLATFORM);
  } catch (e) {
    console.error('[dictate] could not save settings:', e);
    config = r.config; // apply for this session even if the disk refused
  }
  if (wasEnabled && !config.enabled && run) cancel();
  publish({ cancelShortcut: { accelerator: config.cancelAccelerator, registered: !!registeredCancel } });
  applyToggleShortcut();
  scheduleHostRetire();
  return { ok: true, config, state };
}

const PERMISSIONS = new Set(['accessibility', 'microphone', 'automation']);

async function requestPermission(which: unknown): Promise<DictatePlatformStatus> {
  if (typeof which === 'string' && PERMISSIONS.has(which)) {
    const w = which as 'accessibility' | 'microphone' | 'automation';
    if (w === 'accessibility') promptAccessibility(PLATFORM);
    if (w === 'microphone' && PLATFORM === 'darwin' && microphoneStatus(PLATFORM) === 'not-determined') {
      await ensureMicrophone(PLATFORM);
    } else {
      await openPermissionSettings(PLATFORM, w);
    }
  }
  return platformStatus(PLATFORM, config.pasteMode, true);
}

// ─── IPC ────────────────────────────────────────────────────────────────────

function watchInsertWindow(wc: WebContents): void {
  if (watchedInsert.has(wc.id)) return;
  watchedInsert.add(wc.id);
  const id = wc.id;
  // A reload drops the page's listener until it says ready again.
  wc.on('did-start-navigation', (d) => { if (d.isMainFrame && !d.isSameDocument) insertReady.delete(id); });
  wc.once('destroyed', () => { insertReady.delete(id); watchedInsert.delete(id); });
}

function registerIpc(): void {
  ipcMain.handle('feat:dictate:toggle', (): DictateState => {
    const r = run;
    if (!r) void start(Date.now(), false);
    else if (state.phase === 'recording') stop(r);
    else if (state.phase === 'starting') cancel();
    return state;
  });
  ipcMain.handle('feat:dictate:cancel', (): DictateState => { cancel(); return state; });
  ipcMain.handle('feat:dictate:getState', (): DictateState => state);
  ipcMain.handle('feat:dictate:getSettings', (): DictateConfig => config);
  ipcMain.handle('feat:dictate:setSettings', (_e, patch: unknown): DictateSetResult => setSettings(patch));
  ipcMain.handle('feat:dictate:getStatus', (): DictatePlatformStatus => platformStatus(PLATFORM, config.pasteMode, true));
  ipcMain.handle('feat:dictate:requestPermission', (_e, which: unknown) => requestPermission(which));
  ipcMain.handle('feat:dictate:copyLast', (): { ok: boolean } => ({ ok: state.last ? copyToClipboard(state.last.text) : false }));

  ipcMain.on('feat:dictate:insertReady', (evt, ready: unknown) => {
    if (host?.isHost(evt.sender)) return;
    watchInsertWindow(evt.sender);
    if (ready === true) insertReady.add(evt.sender.id);
    else insertReady.delete(evt.sender.id);
  });
  ipcMain.on('feat:dictate:insertResult', (evt, reply: unknown) => {
    if (!reply || typeof reply !== 'object') return;
    const r = reply as Record<string, unknown>;
    if (typeof r.id !== 'number') return;
    const pending = pendingInserts.get(r.id);
    if (!pending || pending.wcId !== evt.sender.id) return;
    pending.resolve(
      r.ok === true
        ? { id: r.id, ok: true }
        : { id: r.id, ok: false, reason: r.reason === 'no-field' ? 'no-field' : 'failed' }
    );
  });

  ipcMain.handle('feat:dictate:host:ready', (evt) => { host?.markReady(evt.sender); });
  ipcMain.on('feat:dictate:host:event', (evt, payload: unknown) => {
    if (!host?.isHost(evt.sender) || !isHostEvent(payload)) return;
    onHostEvent(payload);
  });
}

// ─── Module ─────────────────────────────────────────────────────────────────

export const dictateFeature: FeatureModule = {
  name: 'dictate',
  register(c) {
    ctx = c;
    config = loadConfig(c);
    state = {
      ...DEFAULT_DICTATE_STATE,
      enabled: config.enabled,
      shortcut: { accelerator: config.accelerator, registered: false },
      cancelShortcut: { accelerator: config.cancelAccelerator, registered: false }
    };
    registerIpc();
    applyToggleShortcut();
  },
  /** The mic gate opens for the recorder while dictation is on, and for a
   *  ring-started dictation while it captures. */
  micLive() {
    return config.enabled || (run !== null && capturing());
  },
  onAppWindowsClosed() {
    // Windows / Linux are quitting: let them. A Mac keeps the shortcut; the
    // recorder is re-created on the next dictation.
    if (PLATFORM !== 'darwin') cancel();
    if (!run) host?.destroy();
  },
  dispose() {
    if (run) { run.cancelled = true; clearRunTimers(run); run = null; }
    unregister(registeredToggle);
    unregister(registeredCancel);
    registeredToggle = null;
    registeredCancel = null;
    if (errorTimer) clearTimeout(errorTimer);
    if (retireTimer) clearTimeout(retireTimer);
    errorTimer = null;
    retireTimer = null;
    for (const p of pendingInserts.values()) p.resolve({ id: 0, ok: false, reason: 'failed' });
    pendingInserts.clear();
    host?.destroy();
    host = null;
    flushPendingRestore();
  }
};
