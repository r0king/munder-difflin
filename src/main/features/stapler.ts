/**
 * Stapler — main-process side (owned by the `stapler` unit).
 *
 * The floating puck and its ring (stapler/puckWindow.ts), the screenshot
 * overlay (stapler/screenshot.ts), the tray of shots and files waiting to be
 * sent (stapler/draft.ts), the meetings library on disk (stapler/meetingStore.ts),
 * the Start/stop meeting global shortcut, and "Make invisible".
 *
 * Who does what:
 *   - The puck's renderer (src/renderer/src/stapler) runs the flows and the
 *     audio capture (the transcribe unit's capture.ts); it tells main what is
 *     recording (`setRecording`) BEFORE it opens the mic, so the permission
 *     gate and content protection are already right when audio starts.
 *   - Main owns every path. The renderer never names a file: shots are made
 *     here, files come from main's own dialog (or a drop, re-validated), and
 *     meetings are addressed by an id that cannot leave the library root.
 *   - Everything the Stapler catches goes out through ctx.deliverToAgent, the
 *     same queue the composer uses.
 *
 * Settings: <userData>/features/stapler/settings.json (enabled, invisible,
 * per-display position, the To target, remembered regions); the pending tray
 * in draft.json beside it; shots in shots/ (swept after 7 days); meetings in
 * <harnessHome>/meetings/ (or <userData>/features/stapler/meetings before a
 * hive is open).
 *
 * Channels (invoke unless noted): feat:stapler:getState, setEnabled,
 * setInvisible, resetPosition, retryShortcut, getEnv, openScreenSettings,
 * openPanel, puckReady, setMode, setIgnoreMouse, dragStart, dragEnd,
 * setRecording, getTarget, setTarget, screenshot, overlayInit, overlayCommit,
 * overlayCancel, getDraft, removeAttachment, clearDraft, pickFiles, addPaths,
 * send, transcribe, meetingStart, meetingAbort, meetingList, meetingGet,
 * meetingUpdate, meetingDelete, meetingSend, meetingReveal, meetingRetry,
 * takeMeetingFocus, openMeetingInApp.
 * Push: feat:stapler:state (every window), feat:stapler:command,
 * feat:stapler:draft (puck), feat:stapler:meetings, feat:stapler:focusMeeting
 * (app windows).
 */
import { app, BrowserWindow, dialog, globalShortcut, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import {
  DEFAULT_STAPLER_STATE,
  MAX_SHOTS,
  cleanTarget,
  isStaplerMode,
  isStaplerPanel,
  isStaplerSendRequest,
  isStaplerTarget,
  type DraftAttachment,
  type MeetingRecord,
  type MeetingSegment,
  type MeetingShortcutStatus,
  type StaplerCommand,
  type StaplerDraft,
  type StaplerRecording,
  type StaplerResult,
  type StaplerState,
  type StaplerTarget,
  type StaplerTranscribeRequest,
  type StaplerTranscribeResult
} from '../../shared/features/stapler';
import type { TranscribeResult } from '../../shared/features/transcribe';
import { transcribeFile, transcribeMeeting } from './transcribe';
import type { FeatureContext, FeatureModule } from './types';
import { DEFAULT_SETTINGS, sanitizeSettings, type StaplerSettings } from './stapler/settings';
import { PuckWindow } from './stapler/puckWindow';
import { ScreenshotController, screenPermission, type SavedShot } from './stapler/screenshot';
import { addAttachments, classifyAttachment, emptyDraft, removeAttachment, sanitizeDraft, shotCount } from './stapler/draft';
import { MeetingStore } from './stapler/meetingStore';
import { isMeetingId, meetingDeliveryText } from './stapler/meetings';

const UNIT = 'stapler';
const IS_MAC = process.platform === 'darwin';
/** setContentProtection is a no-op on Linux (no compositor API for it). */
const CAN_HIDE = process.platform === 'darwin' || process.platform === 'win32';
/** Shift+Command+Space on the Mac, Control+Shift+Space elsewhere (README). */
export const MEETING_ACCELERATOR = IS_MAC ? 'Shift+Command+Space' : 'Ctrl+Shift+Space';
/** Sent shots stay readable for the agent this long, then are swept. */
const SHOT_RETENTION_MS = 7 * 24 * 60 * 60_000;
const MAX_QUERY = 500;

const ch = (action: string): string => `feat:${UNIT}:${action}`;

// ─── Module state ───────────────────────────────────────────────────────────

let ctxRef: FeatureContext | null = null;
let settings: StaplerSettings = { ...DEFAULT_SETTINGS };
let recording: StaplerRecording = null;
let activeMeeting: { id: string; startedAt: string } | null = null;
let shortcut: MeetingShortcutStatus | null = null;
let draft: StaplerDraft = emptyDraft();
let pendingCommands: StaplerCommand[] = [];
let puckReady = false;
let pendingFocus: string | null = null;
let disposed = false;
/** Meetings main is transcribing right now (not "interrupted"). */
const transcribing = new Set<string>();

const puck = new PuckWindow({
  ctx: null as unknown as FeatureContext, // replaced in register()
  placement: () => settings.placement,
  savePlacement: (placement) => saveSettings({ placement }),
  protection: () => protectionWanted(),
  onUnexpectedClose: () => onPuckGone()
});

const screenshots = new ScreenshotController({
  ctx: null as unknown as FeatureContext, // replaced in register()
  shotsDir: () => join(ctx().featureDataDir(UNIT), 'shots'),
  rememberedRegion: (displayId) => settings.regions[displayId],
  shotCount: () => shotCount(draft),
  protection: () => protectionWanted(),
  hidePuck: () => puck.hideForCapture(),
  showPuck: () => puck.showAfterCapture(),
  onShot: (shot) => onShot(shot)
});

const store = new MeetingStore(() => meetingsRoot());

function ctx(): FeatureContext {
  if (!ctxRef) throw new Error('stapler: not registered');
  return ctxRef;
}

function meetingsRoot(): string {
  const home = ctx().harnessHome();
  return home ? join(home, 'meetings') : join(ctx().featureDataDir(UNIT), 'meetings');
}

// ─── State ──────────────────────────────────────────────────────────────────

function protectionWanted(): boolean {
  // "and does so on its own while it records"
  return settings.invisible || recording === 'message' || recording === 'meeting';
}

function currentState(): StaplerState {
  let meetingsDir: string | null = null;
  try { meetingsDir = ctxRef ? meetingsRoot() : null; } catch { meetingsDir = null; }
  return {
    ...DEFAULT_STAPLER_STATE,
    enabled: !!puck.window,
    invisible: settings.invisible,
    recording,
    hiddenFromCapture: CAN_HIDE && protectionWanted(),
    canHide: CAN_HIDE,
    meetingShortcut: shortcut,
    meeting: activeMeeting,
    pendingAttachments: draft.attachments.length,
    meetingsDir
  };
}

function publish(): StaplerState {
  const s = currentState();
  if (ctxRef) ctxRef.broadcastAll(ch('state'), s);
  return s;
}

function saveSettings(patch: Partial<StaplerSettings>): void {
  settings = { ...settings, ...patch };
  try {
    ctx().writeFeatureSettings<StaplerSettings>(UNIT, DEFAULT_SETTINGS, settings);
  } catch (e) {
    console.error('[stapler] could not save settings:', e);
  }
}

function applyProtection(): void {
  const on = protectionWanted();
  puck.applyProtection(on);
  screenshots.applyProtection(on);
}

/** main → puck, or held until the puck's renderer says it is listening. */
function command(c: StaplerCommand): void {
  if (puckReady && puck.window) {
    puck.send(ch('command'), c);
    return;
  }
  pendingCommands.push(c);
  if (pendingCommands.length > 10) pendingCommands.shift();
}

// ─── Enable / disable ───────────────────────────────────────────────────────

function registerShortcut(): void {
  if (shortcut?.registered) return;
  let ok = false;
  let error: string | undefined;
  try {
    ok = globalShortcut.register(MEETING_ACCELERATOR, () => command({ type: 'toggleMeeting' }));
    if (!ok) error = 'taken';
  } catch (e) {
    console.error('[stapler] meeting shortcut:', e);
    error = 'failed';
  }
  // Electron registers through X11 grabs; under a Wayland session the grab
  // succeeds against XWayland and the compositor never delivers the key.
  if (ok && process.platform === 'linux' && process.env.XDG_SESSION_TYPE === 'wayland') error = 'wayland';
  shortcut = { accelerator: MEETING_ACCELERATOR, registered: ok, ...(error ? { error } : {}) };
}

function unregisterShortcut(): void {
  if (shortcut?.registered) {
    try { globalShortcut.unregister(MEETING_ACCELERATOR); } catch { /* app quitting */ }
  }
  shortcut = null;
}

function showPuck(): boolean {
  if (puck.window) return true;
  puckReady = false;
  if (!puck.create()) return false;
  registerShortcut();
  return true;
}

function setEnabled(on: boolean): StaplerState {
  if (on) {
    if (showPuck()) saveSettings({ enabled: true });
  } else {
    // A recording lives in the puck's renderer; closing it would cut the
    // audio off mid-word and strand the session. Stop it first.
    if (recording === 'message' || recording === 'meeting') return publish();
    screenshots.close();
    puck.destroy();
    puckReady = false;
    unregisterShortcut();
    saveSettings({ enabled: false });
  }
  return publish();
}

/** The puck's window or renderer went away without us asking. */
function onPuckGone(): void {
  puckReady = false;
  recording = null;
  interruptActiveMeeting();
  unregisterShortcut();
  applyProtection();
  publish();
}

function interruptActiveMeeting(): void {
  if (!activeMeeting) return;
  const id = activeMeeting.id;
  activeMeeting = null;
  try {
    const rec = store.get(id);
    if (rec && rec.status === 'recording') store.markInterrupted(new Set([...transcribing]));
  } catch { /* library unreadable */ }
  broadcastMeetings();
}

// ─── The tray ───────────────────────────────────────────────────────────────

function draftFile(): string {
  return join(ctx().featureDataDir(UNIT), 'draft.json');
}

function saveDraft(): void {
  try {
    const file = draftFile();
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(draft), 'utf8');
    renameSync(tmp, file);
  } catch (e) {
    console.error('[stapler] could not save the tray:', e);
  }
  puck.send(ch('draft'), draft);
  publish();
}

function loadDraft(): void {
  try {
    draft = sanitizeDraft(JSON.parse(readFileSync(draftFile(), 'utf8')), (p) => existsSync(p));
  } catch {
    draft = emptyDraft();
  }
}

const newId = (): string => randomBytes(6).toString('hex');

/** True when `p` is a shot WE wrote (so removing it from the tray may delete it). */
function isOurShot(p: string): boolean {
  try {
    const dir = join(ctx().featureDataDir(UNIT), 'shots');
    const rel = relative(dir, resolve(p));
    return !!rel && !rel.startsWith('..') && !isAbsolute(rel);
  } catch {
    return false;
  }
}

function onShot(shot: SavedShot): void {
  const item: DraftAttachment = {
    id: newId(),
    kind: 'shot',
    path: shot.path,
    name: basename(shot.path),
    thumb: shot.thumb,
    width: shot.width,
    height: shot.height
  };
  try { item.size = statSync(shot.path).size; } catch { /* still listed */ }
  const res = addAttachments(draft, [item]);
  draft = res.draft;
  if (!res.added.length) {
    try { unlinkSync(shot.path); } catch { /* best-effort */ }
  }
  saveSettings({ regions: { ...settings.regions, [shot.displayId]: shot.region } });
  saveDraft();
  command({ type: 'openPanel', panel: 'compose' });
}

/** Validate user-chosen paths (from our dialog or a drop) into attachments. */
function attachmentsFromPaths(paths: unknown): DraftAttachment[] {
  if (!Array.isArray(paths)) return [];
  const out: DraftAttachment[] = [];
  for (const raw of paths.slice(0, 64)) {
    if (typeof raw !== 'string' || !raw || raw.length > 4096 || !isAbsolute(raw)) continue;
    try {
      const st = statSync(raw);
      if (!st.isFile() && !st.isDirectory()) continue;
      const name = basename(raw) || raw;
      const item: DraftAttachment = { id: newId(), kind: classifyAttachment(name, st.isDirectory()), path: raw, name };
      if (st.isFile()) item.size = st.size;
      out.push(item);
    } catch { /* gone, or no permission — skip */ }
  }
  return out;
}

function addPaths(paths: unknown): { draft: StaplerDraft; rejected: number } {
  const res = addAttachments(draft, attachmentsFromPaths(paths));
  draft = res.draft;
  saveDraft();
  return { draft, rejected: res.rejected.length };
}

/** Sent shots are kept for the agent to read; old ones go. */
function sweepShots(): void {
  try {
    const dir = join(ctx().featureDataDir(UNIT), 'shots');
    if (!existsSync(dir)) return;
    const keep = new Set(draft.attachments.map((a) => resolve(a.path)));
    const cutoff = Date.now() - SHOT_RETENTION_MS;
    for (const name of readdirSync(dir)) {
      if (!/^shot-[\w-]+\.png$/.test(name)) continue;
      const p = join(dir, name);
      if (keep.has(resolve(p))) continue;
      try { if (statSync(p).mtimeMs < cutoff) unlinkSync(p); } catch { /* raced */ }
    }
  } catch (e) {
    console.error('[stapler] shot sweep:', e);
  }
}

// ─── Delivery ───────────────────────────────────────────────────────────────

function targetKnown(target: StaplerTarget): boolean {
  if (target.kind === 'orchestrator') return true;
  const roster = ctx().getRoster();
  // With no roster yet (boot, no app window) we cannot tell; the renderer's
  // deliverToAgent makes the final call.
  return roster.length === 0 || roster.some((a) => a.id === target.agentId);
}

function send(req: unknown): StaplerResult {
  if (!isStaplerSendRequest(req)) return { ok: false, error: 'invalid' };
  const target = cleanTarget(req.target);
  if (!targetKnown(target)) return { ok: false, error: 'unknown-agent' };
  const attachments = draft.attachments.filter((a) => existsSync(a.path)).map((a) => a.path);
  const text = req.text.trim();
  if (!text && !attachments.length) return { ok: false, error: 'empty' };
  ctx().deliverToAgent({ target, text, attachments, mode: 'queue', source: 'stapler' });
  // The files stay on disk: the agent reads them when the message lands.
  draft = emptyDraft();
  saveDraft();
  saveSettings({ lastTarget: target });
  return { ok: true };
}

// ─── Transcription ──────────────────────────────────────────────────────────

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/;

/** Roots a capture WAV may live under: the app's data, or the OS temp dir. */
function wavRoots(): string[] {
  const roots: string[] = [];
  for (const r of [ctx().userDataDir, tmpdir()]) {
    try { roots.push(realpathSync(r)); } catch { roots.push(resolve(r)); }
  }
  return roots;
}

/**
 * A WAV path handed back by the puck after a capture: absolute, a .wav, a real
 * file, belonging to this session (its id is in the path) and under the app's
 * data or temp dir. undefined = not given; null = given but refused.
 */
function checkWav(p: unknown, sessionId: string): string | undefined | null {
  if (p === undefined || p === null || p === '') return undefined;
  if (typeof p !== 'string' || p.length > 4096 || !isAbsolute(p)) return null;
  if (extname(p).toLowerCase() !== '.wav' || !p.includes(sessionId)) return null;
  try {
    const real = realpathSync(p);
    if (!statSync(real).isFile()) return null;
    const inside = wavRoots().some((root) => {
      const rel = relative(root, real);
      return !!rel && !rel.startsWith('..') && !isAbsolute(rel);
    });
    return inside ? real : null;
  } catch {
    return null;
  }
}

function toSegments(r: TranscribeResult, meeting: boolean): MeetingSegment[] {
  return (r.segments ?? [])
    .filter((s) => s && typeof s.text === 'string' && s.text.trim())
    .map((s) => ({
      speaker: meeting && s.speaker === 'them' ? 'them' : 'you',
      startMs: Number.isFinite(s.startMs) ? Math.max(0, Math.round(s.startMs)) : 0,
      endMs: Number.isFinite(s.endMs) ? Math.max(0, Math.round(s.endMs)) : 0,
      text: s.text.trim()
    }));
}

async function runMeetingTranscription(id: string, micWav: string | undefined, systemWav: string | undefined, durationMs: number): Promise<MeetingRecord | null> {
  transcribing.add(id);
  try {
    store.markTranscribing(id, durationMs, { micWav, systemWav });
    broadcastMeetings();
    let r: TranscribeResult;
    try {
      r = await transcribeMeeting(micWav, systemWav);
    } catch (e) {
      r = { ok: false, text: '', segments: [], engine: 'local', error: e instanceof Error ? e.message : String(e) };
    }
    const rec = store.finish(id, {
      durationMs,
      segments: r.ok ? toSegments(r, true) : [],
      engine: r.engine,
      ...(r.ok ? {} : { error: r.error || 'transcription failed' }),
      audio: { micWav, systemWav }
    });
    return rec;
  } finally {
    transcribing.delete(id);
    broadcastMeetings();
  }
}

async function transcribe(req: unknown): Promise<StaplerTranscribeResult> {
  const fail = (error: string): StaplerTranscribeResult => ({ ok: false, text: '', segments: [], error });
  if (!req || typeof req !== 'object') return fail('invalid');
  const r = req as Partial<StaplerTranscribeRequest>;
  if ((r.kind !== 'message' && r.kind !== 'meeting') || typeof r.sessionId !== 'string' || !SESSION_ID.test(r.sessionId)) return fail('invalid');
  const micWav = checkWav(r.micWav, r.sessionId);
  const systemWav = checkWav(r.systemWav, r.sessionId);
  if (micWav === null || systemWav === null) return fail('invalid-audio');
  const durationMs = typeof r.durationMs === 'number' && Number.isFinite(r.durationMs) ? Math.max(0, r.durationMs) : 0;

  if (r.kind === 'message') {
    if (!micWav) return fail('no-audio');
    try {
      const res = await transcribeFile(micWav);
      if (!res.ok) return { ok: false, text: '', segments: [], engine: res.engine, error: res.error || 'transcription failed' };
      return { ok: true, text: res.text.trim(), segments: toSegments(res, false), engine: res.engine };
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }
  }

  // Meeting: the folder was created at start.
  const id = r.meetingId;
  if (!isMeetingId(id) || !store.get(id)) return fail('unknown-meeting');
  if (activeMeeting?.id === id) activeMeeting = null;
  publish();
  if (!micWav && !systemWav) {
    const rec = store.finish(id, { durationMs, segments: [], error: 'no-audio' });
    broadcastMeetings();
    return { ok: false, text: '', segments: [], error: 'no-audio', ...(rec ? { meeting: store.summary(id) ?? undefined } : {}) };
  }
  const rec = await runMeetingTranscription(id, micWav, systemWav, durationMs);
  const summary = store.summary(id) ?? undefined;
  if (!rec || rec.status !== 'ready') {
    return { ok: false, text: '', segments: [], error: rec?.error || 'transcription failed', meeting: summary };
  }
  return { ok: true, text: '', segments: rec.segments, engine: rec.engine, meeting: summary };
}

// ─── Meetings library ───────────────────────────────────────────────────────

function broadcastMeetings(): void {
  if (ctxRef) ctxRef.broadcastAll(ch('meetings'));
}

/** What the renderer gets: the record minus the capture paths. */
function publicRecord(rec: MeetingRecord | null): MeetingRecord | null {
  if (!rec) return null;
  const { audio: _audio, ...rest } = rec;
  void _audio;
  return rest;
}

function meetingSend(id: unknown, target: unknown): StaplerResult {
  if (!isStaplerTarget(target)) return { ok: false, error: 'invalid' };
  const rec = store.get(id);
  if (!rec) return { ok: false, error: 'not-found' };
  const t = cleanTarget(target);
  if (!targetKnown(t)) return { ok: false, error: 'unknown-agent' };
  const transcript = store.transcriptPath(rec.id);
  ctx().deliverToAgent({
    target: t,
    text: meetingDeliveryText(rec),
    attachments: transcript && existsSync(transcript) ? [transcript] : [],
    mode: 'queue',
    source: 'stapler'
  });
  return { ok: true };
}

async function meetingRetry(id: unknown): Promise<StaplerResult> {
  const rec = store.get(id);
  if (!rec) return { ok: false, error: 'not-found' };
  if (transcribing.has(rec.id) || activeMeeting?.id === rec.id) return { ok: false, error: 'busy' };
  const micWav = rec.audio?.micWav && existsSync(rec.audio.micWav) ? rec.audio.micWav : undefined;
  const systemWav = rec.audio?.systemWav && existsSync(rec.audio.systemWav) ? rec.audio.systemWav : undefined;
  if (!micWav && !systemWav) return { ok: false, error: 'audio-gone' };
  const done = await runMeetingTranscription(rec.id, micWav, systemWav, rec.durationMs);
  return done?.status === 'ready' ? { ok: true } : { ok: false, error: done?.error || 'transcription failed' };
}

function openMeetingInApp(id: unknown): StaplerResult {
  const focus = isMeetingId(id) ? id : null;
  pendingFocus = focus;
  ctx().navigateMainWindow({ kind: 'stapler' });
  if (focus) ctx().broadcast(ch('focusMeeting'), focus);
  return { ok: true };
}

// ─── IPC ────────────────────────────────────────────────────────────────────

type Handler = (evt: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

function handle(action: string, fn: Handler): void {
  ipcMain.handle(ch(action), async (evt, ...args) => {
    try {
      return await fn(evt, ...args);
    } catch (e) {
      console.error(`[stapler] ${action} failed:`, e);
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });
}

/** Handlers only the puck may call (they move or resize the puck). */
function puckOnly(action: string, fn: Handler): void {
  handle(action, (evt, ...args) => (puck.isSender(evt.sender) ? fn(evt, ...args) : { ok: false, error: 'forbidden' }));
}

function registerIpc(): void {
  // ── State, settings ──
  handle('getState', () => currentState());
  handle('setEnabled', (_e, on) => (typeof on === 'boolean' ? setEnabled(on) : currentState()));
  handle('setInvisible', (_e, on) => {
    if (typeof on !== 'boolean') return currentState();
    saveSettings({ invisible: on });
    applyProtection();
    return publish();
  });
  handle('resetPosition', () => {
    puck.resetPosition();
    return currentState();
  });
  handle('retryShortcut', () => {
    if (puck.window) { unregisterShortcut(); registerShortcut(); }
    return publish();
  });
  handle('getEnv', () => ({
    platform: process.platform,
    screenPermission: screenPermission(),
    sessionType: process.platform === 'linux' ? (process.env.XDG_SESSION_TYPE || 'x11') : null
  }));
  handle('openScreenSettings', async () => {
    if (!IS_MAC) return { ok: false };
    await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
    return { ok: true };
  });
  // From an app window: "Stapler settings" etc. Turns the puck on if needed.
  handle('openPanel', (_e, panel) => {
    if (!isStaplerPanel(panel)) return { ok: false, error: 'invalid' };
    if (!showPuck()) return { ok: false, error: 'no-display' };
    saveSettings({ enabled: true });
    publish();
    command({ type: 'openPanel', panel });
    return { ok: true };
  });

  // ── The puck window ──
  puckOnly('puckReady', () => {
    puckReady = true;
    // A fresh renderer cannot be recording: whatever was live died with the
    // old one. Clear it so the mic gate and content protection let go.
    if (recording === 'message' || recording === 'meeting') {
      recording = null;
      interruptActiveMeeting();
      applyProtection();
      publish();
    }
    const commands = pendingCommands.splice(0, pendingCommands.length);
    return {
      commands,
      layout: puck.layout(),
      draft,
      target: settings.lastTarget,
      clickThrough: process.platform !== 'linux'
    };
  });
  puckOnly('setMode', (_e, mode, panel) => {
    if (!isStaplerMode(mode)) return puck.layout();
    return puck.setMode(mode, isStaplerPanel(panel) ? panel : undefined) ?? puck.layout();
  });
  puckOnly('setIgnoreMouse', (_e, ignore) => {
    if (typeof ignore === 'boolean') puck.setIgnoreMouse(ignore);
    return true;
  });
  puckOnly('dragStart', () => puck.dragStart());
  puckOnly('dragEnd', () => puck.dragEnd());
  puckOnly('setRecording', (_e, kind) => {
    if (kind !== null && kind !== 'message' && kind !== 'meeting') return currentState();
    recording = kind;
    applyProtection();
    return publish();
  });
  handle('getTarget', () => settings.lastTarget);
  handle('setTarget', (_e, target) => {
    if (!isStaplerTarget(target)) return settings.lastTarget;
    saveSettings({ lastTarget: cleanTarget(target) });
    return settings.lastTarget;
  });

  // ── Screenshot ──
  puckOnly('screenshot', () => screenshots.start(MAX_SHOTS));
  handle('overlayInit', (evt) => (screenshots.isOverlay(evt.sender) ? screenshots.init() : { ok: false, error: 'forbidden' }));
  handle('overlayCommit', (evt, region) => (screenshots.isOverlay(evt.sender) ? screenshots.commit(region) : { ok: false, error: 'forbidden' }));
  handle('overlayCancel', (evt) => {
    if (screenshots.isOverlay(evt.sender)) screenshots.close();
    return { ok: true };
  });

  // ── The tray ──
  handle('getDraft', () => draft);
  puckOnly('removeAttachment', (_e, id) => {
    if (typeof id !== 'string') return draft;
    const res = removeAttachment(draft, id);
    draft = res.draft;
    // An unsent shot is ours and nobody else will read it.
    if (res.removed?.kind === 'shot' && isOurShot(res.removed.path)) {
      try { unlinkSync(res.removed.path); } catch { /* already gone */ }
    }
    saveDraft();
    return draft;
  });
  puckOnly('clearDraft', () => {
    for (const a of draft.attachments) {
      if (a.kind === 'shot' && isOurShot(a.path)) {
        try { unlinkSync(a.path); } catch { /* already gone */ }
      }
    }
    draft = emptyDraft();
    saveDraft();
    return draft;
  });
  puckOnly('pickFiles', async (_e, what) => {
    const win = puck.window;
    const folders = what === 'folders';
    const opts: Electron.OpenDialogOptions = {
      properties: folders ? ['openDirectory', 'multiSelections'] : ['openFile', 'multiSelections']
    };
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    if (res.canceled || !res.filePaths.length) return { draft, rejected: 0, cancelled: true };
    return addPaths(res.filePaths);
  });
  // Files dropped onto the compose panel (paths via webUtils in the preload).
  puckOnly('addPaths', (_e, paths) => addPaths(paths));
  puckOnly('send', (_e, req) => send(req));

  // ── Recording ──
  puckOnly('transcribe', (_e, req) => transcribe(req));
  puckOnly('meetingStart', () => {
    if (activeMeeting) return { ok: false, error: 'busy' };
    const rec = store.create({ startedAt: new Date() });
    activeMeeting = { id: rec.id, startedAt: rec.startedAt };
    publish();
    broadcastMeetings();
    return { ok: true, id: rec.id, startedAt: rec.startedAt };
  });
  puckOnly('meetingAbort', (_e, id) => {
    if (!isMeetingId(id)) return { ok: false };
    if (activeMeeting?.id === id) activeMeeting = null;
    const rec = store.get(id);
    // Nothing was captured: the empty folder would only be clutter.
    if (rec && rec.status === 'recording' && rec.segments.length === 0) store.remove(id);
    publish();
    broadcastMeetings();
    return { ok: true };
  });

  // ── Meetings library (main window and puck) ──
  handle('meetingList', (_e, query) => store.list(typeof query === 'string' ? query.slice(0, MAX_QUERY) : ''));
  handle('meetingGet', (_e, id) => publicRecord(store.get(id)));
  handle('meetingUpdate', (_e, id, patch) => {
    if (activeMeeting?.id === id) return null;
    const rec = store.update(id, patch);
    if (rec) broadcastMeetings();
    return publicRecord(rec);
  });
  handle('meetingDelete', (_e, id) => {
    if (activeMeeting?.id === id || (typeof id === 'string' && transcribing.has(id))) return { ok: false, error: 'busy' };
    const ok = store.remove(id);
    if (ok) broadcastMeetings();
    return { ok };
  });
  handle('meetingSend', (_e, id, target) => meetingSend(id, target));
  handle('meetingReveal', async (_e, id) => {
    const dir = store.dirFor(id);
    if (!dir) return { ok: false, error: 'not-found' };
    const err = await shell.openPath(dir);
    return err ? { ok: false, error: err } : { ok: true };
  });
  handle('meetingRetry', (_e, id) => meetingRetry(id));
  handle('takeMeetingFocus', () => {
    const id = pendingFocus;
    pendingFocus = null;
    return id;
  });
  handle('openMeetingInApp', (_e, id) => openMeetingInApp(id));
}

// ─── Lifecycle ──────────────────────────────────────────────────────────────

/** An app window appeared (macOS Dock click after closing them all, a new
 *  floor): bring the puck back if the user had it on. */
function onWindowCreated(_e: unknown, win: BrowserWindow): void {
  setImmediate(() => {
    if (disposed || !ctxRef || puck.window || !settings.enabled) return;
    if (!ctxRef.appWindows().includes(win)) return;
    showPuck();
    publish();
  });
}

export const staplerFeature: FeatureModule = {
  name: UNIT,
  register(c) {
    ctxRef = c;
    // The controllers were built before the context existed.
    (puck as unknown as { host: { ctx: FeatureContext } }).host.ctx = c;
    (screenshots as unknown as { host: { ctx: FeatureContext } }).host.ctx = c;
    settings = sanitizeSettings(c.readFeatureSettings<Record<string, unknown>>(UNIT, {}));
    loadDraft();
    sweepShots();
    try {
      mkdirSync(meetingsRoot(), { recursive: true });
      store.markInterrupted();
    } catch (e) {
      console.error('[stapler] meetings library:', e);
    }
    registerIpc();
    app.on('browser-window-created', onWindowCreated);
    if (settings.enabled) {
      // After the office is on screen, not before: a puck floating over an
      // empty desktop for a second reads as a glitch.
      const main = c.getMainWindow();
      if (main && !main.isVisible()) main.once('ready-to-show', () => { if (!disposed) { showPuck(); publish(); } });
      else showPuck();
    }
    publish();
  },
  micLive() {
    // While the puck is up (its settings test the mic and list devices by
    // name, which needs the permission check to pass) and while recording.
    return !!puck.window || recording === 'message' || recording === 'meeting';
  },
  onAppWindowsClosed() {
    // macOS keeps running with no window, so the puck may keep floating (and
    // a meeting keeps recording). Windows and Linux quit when the last APP
    // window closes, which never happens while this window is open.
    if (IS_MAC) return;
    screenshots.close();
    puck.destroy();
    puckReady = false;
    unregisterShortcut();
  },
  dispose() {
    disposed = true;
    app.removeListener('browser-window-created', onWindowCreated);
    screenshots.close();
    puck.destroy();
    unregisterShortcut();
  }
};
