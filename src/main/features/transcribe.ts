/**
 * Transcription — main-process side (owned by the `transcribe` unit).
 *
 * Engines: local Whisper (the bundled base.en model, default; the larger
 * small.en one download away), Groq with the user's own key, and Apple's
 * on-device recogniser — listed, honestly, as unavailable (see appleReason).
 * The vocabulary (126 built-in technical names + the user's words) is the
 * engine prompt and a casing pass on the result. Meetings: the mic track is
 * 'you', system audio 'them', merged by meeting.ts.
 *
 * Contract for other units (same process, no IPC):
 *   transcribeFile(wavPath, opts?)             one track (stapler messages, dictate)
 *   transcribeMeeting(micWav?, systemWav?)     You / Them
 *   transcribeSession(sessionId, opts?)        by capture session id
 *   sessionAudio(sessionId)                    the WAV paths a finalized session left
 * Each resolves a TranscribeResult and never throws. A result with ok:true and
 * no text means no speech was found.
 *
 * The renderer records through `feat:transcribe:*` (audio/capture.ts): a
 * session is opened BEFORE getUserMedia so the mic gate (micLive) is open
 * exactly while a recording runs. Inference runs in a worker thread
 * (transcribe/localEngine.ts); nothing heavy runs on this thread.
 *
 * Retention: recordings are deleted 24 h after they are transcribed and after
 * 7 days if they never are — swept at startup and hourly.
 */
import { app, ipcMain, net, systemPreferences, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from 'electron';
import { existsSync, rmSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { release } from 'node:os';
import {
  DEFAULT_TRANSCRIBE_SETTINGS,
  TRANSCRIBE_CH,
  failedTranscription,
  isValidSessionId,
  newSessionId,
  normalizeSettings,
  sanitizeSettingsPatch,
  type BeginSessionRequest,
  type BeginSessionResult,
  type DownloadProgress,
  type EngineInfo,
  type EngineUnavailableReason,
  type FinalizeResult,
  type LocalModelId,
  type ModelInfo,
  type SystemAudioMode,
  type TranscribeEngine,
  type TranscribeOptions,
  type TranscribeResult,
  type TranscribeSessionOptions,
  type TranscribeSettings,
  type TranscribeStatus,
  type TranscribeTrack,
  type TranscriptSegment
} from '../../shared/features/transcribe';
import {
  BUILTIN_VOCABULARY,
  applyVocabularyCasing,
  buildVocabularyPrompt,
  compileVocabulary,
  mergeVocabulary
} from '../../shared/features/vocabulary';
import type { FeatureContext, FeatureModule } from './types';
import { SessionStore } from './transcribe/sessions';
import { LocalEngine } from './transcribe/localEngine';
import { MODELS, modelDir, modelSize, resolveModel, type ModelSpec } from './transcribe/models';
import { downloadModelFiles } from './transcribe/downloader';
import { groqTranscribePiece } from './transcribe/groqEngine';
import { stitchSegments } from './transcribe/groqPlan';
import { cleanSegments, levelBetween, mergeMeeting, transcriptText } from './transcribe/meeting';
import { LOOPBACK_FEATURES, armLoopback, disarmLoopback, ensureDisplayMediaHandler } from './transcribe/displayMedia';

const UNIT = 'transcribe';
const BYTES_PER_SECOND = 32_000;
const SWEEP_EVERY_MS = 60 * 60 * 1000;
/** Prompt budgets: Whisper reads ≤ 224 tokens; leave it room for context. */
const LOCAL_PROMPT_TOKENS = 120;
const GROQ_PROMPT_TOKENS = 160;
const GROQ_MAX_CHUNK_SEC = 600;

let ctxRef: FeatureContext | null = null;
let sessions: SessionStore | null = null;
let sweepTimer: ReturnType<typeof setInterval> | null = null;
let statusTimer: ReturnType<typeof setTimeout> | null = null;
const engine = new LocalEngine(() => publishStatus());

interface ActiveDownload {
  model: LocalModelId;
  loaded: number;
  total: number;
  controller: AbortController;
  promise: Promise<void>;
}
let download: ActiveDownload | null = null;
const modelErrors: Partial<Record<LocalModelId, string>> = {};
/** Session id → webContents ids armed for loopback (to disarm on close). */
const loopbackOwners = new Map<string, number>();
const watchedOwners = new Set<number>();

// ─── Paths, settings ────────────────────────────────────────────────────────

function dataDir(): string {
  if (!ctxRef) throw new Error('transcription is not ready yet');
  return ctxRef.featureDataDir(UNIT);
}

const cacheRoot = (): string => join(dataDir(), 'models');

/** Where release builds put the bundled model (electron-builder extraResources
 *  from resources/models, filled by tools/fetch-whisper-model.cjs). */
function bundledRoot(): string {
  return app.isPackaged ? join(process.resourcesPath, 'models') : join(app.getAppPath(), 'resources', 'models');
}

function readSettings(): TranscribeSettings {
  if (!ctxRef) return { ...DEFAULT_TRANSCRIBE_SETTINGS };
  return normalizeSettings(ctxRef.readFeatureSettings<TranscribeSettings>(UNIT, DEFAULT_TRANSCRIBE_SETTINGS));
}

const fsProbe = {
  sizeOf(p: string): number {
    try {
      const st = statSync(p);
      return st.isFile() ? st.size : -1;
    } catch {
      return -1;
    }
  }
};

function resolved(id: LocalModelId): ReturnType<typeof resolveModel> {
  return resolveModel(MODELS[id], { bundled: bundledRoot(), cache: cacheRoot() }, fsProbe);
}

function hasGroqKey(): boolean {
  return !!ctxRef?.readConfig().groqApiKey?.trim();
}

// ─── Status ─────────────────────────────────────────────────────────────────

/** Darwin kernel major: 22 = macOS 13, 25 = macOS 26. */
function darwinMajor(): number {
  return process.platform === 'darwin' ? Number.parseInt(release().split('.')[0] ?? '0', 10) || 0 : 0;
}

/**
 * Apple's on-device recogniser. On macOS 26 it is SpeechAnalyzer, a Swift-only
 * framework: reaching it needs a signed native helper (or a Node addon), and
 * this build adds no native code. So it is listed with the reason instead of
 * being faked or silently mapped to another engine.
 */
function appleReason(): EngineUnavailableReason {
  if (process.platform !== 'darwin') return 'macos-only';
  return darwinMajor() >= 25 ? 'no-native-helper' : 'needs-macos-26';
}

function systemAudioMode(): SystemAudioMode {
  if (process.platform === 'win32') return 'loopback';
  if (process.platform === 'darwin') return darwinMajor() >= 22 ? 'loopback' : 'device';
  if (process.platform === 'linux') return 'monitor';
  return 'device';
}

function screenAccess(): TranscribeStatus['screenAccess'] {
  if (process.platform !== 'darwin') return undefined;
  try {
    return systemPreferences.getMediaAccessStatus('screen') as TranscribeStatus['screenAccess'];
  } catch {
    return 'unknown';
  }
}

function modelInfo(id: LocalModelId): ModelInfo {
  const spec = MODELS[id];
  const r = resolved(id);
  const state = download?.model === id ? 'downloading' : r.state === 'missing' && modelErrors[id] ? 'error' : r.state;
  return {
    id,
    repo: spec.repo,
    sizeBytes: modelSize(spec),
    state,
    ...(modelErrors[id] && state !== 'downloading' ? { error: modelErrors[id] } : {})
  };
}

function engineInfos(models: ModelInfo[]): EngineInfo[] {
  const large = models.find((m) => m.id === 'large');
  const largeReady = large?.state === 'bundled' || large?.state === 'cached';
  return [
    // The default model is always usable: bundled in releases, otherwise
    // fetched on first use.
    { id: 'local', available: true },
    largeReady
      ? { id: 'local-large', available: true }
      : { id: 'local-large', available: false, reason: large?.state === 'downloading' ? 'downloading' : 'model-missing' },
    { id: 'apple', available: false, reason: appleReason() },
    hasGroqKey() ? { id: 'groq', available: true } : { id: 'groq', available: false, reason: 'no-groq-key' }
  ];
}

function effectiveEngine(preferred: TranscribeEngine, engines: EngineInfo[]): TranscribeEngine {
  return engines.find((e) => e.id === preferred)?.available ? preferred : 'local';
}

function currentStatus(): TranscribeStatus {
  const settings = readSettings();
  const models = (['base', 'large'] as const).map(modelInfo);
  const engines = engineInfos(models);
  const effective = effectiveEngine(settings.engine, engines);
  const base = models[0];
  const progress: DownloadProgress | undefined = download
    ? {
        model: download.model,
        loadedBytes: download.loaded,
        totalBytes: download.total,
        pct: download.total ? Math.min(100, Math.round((download.loaded / download.total) * 1000) / 10) : 0
      }
    : undefined;
  return {
    engine: settings.engine,
    effectiveEngine: effective,
    modelReady: effective === 'local' ? base.state === 'bundled' || base.state === 'cached' : true,
    engines,
    models,
    ...(progress ? { downloading: progress } : {}),
    groqKey: hasGroqKey(),
    busy: engine.busy,
    platform: process.platform,
    systemAudio: systemAudioMode(),
    builtinVocabularyCount: BUILTIN_VOCABULARY.length,
    ...(process.platform === 'darwin' ? { screenAccess: screenAccess() } : {})
  };
}

/** Broadcast to every window, coalesced (download progress fires often). */
function publishStatus(): void {
  if (!ctxRef || statusTimer) return;
  statusTimer = setTimeout(() => {
    statusTimer = null;
    try {
      ctxRef?.broadcastAll(TRANSCRIBE_CH.status, currentStatus());
    } catch (e) {
      console.error('[transcribe] status broadcast failed:', e);
    }
  }, 200);
}

// ─── Models ─────────────────────────────────────────────────────────────────

function startDownload(id: LocalModelId): Promise<void> {
  if (download) {
    if (download.model === id) return download.promise;
    return Promise.reject(new Error('another model is downloading'));
  }
  const spec: ModelSpec = MODELS[id];
  const controller = new AbortController();
  const d: ActiveDownload = { model: id, loaded: 0, total: modelSize(spec), controller, promise: Promise.resolve() };
  download = d;
  delete modelErrors[id];
  d.promise = downloadModelFiles({
    spec,
    root: cacheRoot(),
    fetchImpl: (url, init) => net.fetch(url, init),
    signal: controller.signal,
    onProgress: (p) => {
      d.loaded = p.loadedBytes;
      publishStatus();
    }
  })
    .catch((e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      if (!controller.signal.aborted) modelErrors[id] = msg;
      throw e instanceof Error ? e : new Error(msg);
    })
    .finally(() => {
      if (download === d) download = null;
      publishStatus();
    });
  publishStatus();
  return d.promise;
}

/** A local model ready to load: the bundled/cached copy, the base model
 *  downloaded on first use, or — for the larger one when it is absent — the
 *  base model with a warning. */
async function localModel(want: LocalModelId): Promise<{ id: LocalModelId; root: string; warning?: string }> {
  if (want === 'large') {
    const r = resolved('large');
    if (r.root) return { id: 'large', root: r.root };
    const base = await localModel('base');
    return { ...base, warning: 'the larger model is not downloaded; used the default model' };
  }
  let r = resolved('base');
  if (!r.root) {
    await startDownload('base');
    r = resolved('base');
  }
  if (!r.root) throw new Error('the speech model is not available');
  return { id: 'base', root: r.root };
}

// ─── Engines ────────────────────────────────────────────────────────────────

interface EngineRun {
  ok: boolean;
  segments: TranscriptSegment[];
  durationMs: number;
  engine: TranscribeEngine;
  error?: string;
  warning?: string;
}

function audioSeconds(path: string): number {
  return Math.max(1, fsProbe.sizeOf(path) / BYTES_PER_SECOND);
}

async function runLocal(path: string, which: LocalModelId, words: string[], lead: string): Promise<EngineRun> {
  const m = await localModel(which);
  const spec = MODELS[m.id];
  const factor = m.id === 'large' ? 5 : 2;
  const res = await engine.run(
    {
      type: 'transcribe',
      wavPath: path,
      model: { root: m.root, repo: spec.repo, dtype: spec.dtype },
      lead,
      vocabulary: words,
      promptTokens: LOCAL_PROMPT_TOKENS
    },
    60_000 + audioSeconds(path) * 1000 * factor
  );
  if (res.type !== 'transcribed') throw new Error('unexpected worker reply');
  return {
    ok: true,
    segments: res.segments,
    durationMs: res.durationMs,
    engine: m.id === 'large' ? 'local-large' : 'local',
    ...(m.warning ? { warning: m.warning } : {})
  };
}

async function runGroq(path: string, words: string[], lead: string, language?: string): Promise<EngineRun> {
  const apiKey = ctxRef?.readConfig().groqApiKey?.trim() ?? '';
  if (!apiKey) throw new Error('no Groq API key set');
  const outDir = join(dataDir(), 'groq-tmp', newSessionId());
  try {
    const prep = await engine.run(
      { type: 'prepare', wavPath: path, outDir, maxChunkSec: GROQ_MAX_CHUNK_SEC },
      60_000 + audioSeconds(path) * 200
    );
    if (prep.type !== 'prepared') throw new Error('unexpected worker reply');
    const prompt = buildVocabularyPrompt(words, { lead, maxTokens: GROQ_PROMPT_TOKENS });
    const pieces: Array<{ offsetMs: number; segments: TranscriptSegment[] }> = [];
    for (const c of prep.chunks) {
      const r = await groqTranscribePiece({ apiKey, wavPath: c.path, prompt, language });
      if (!r.ok) {
        const err = new Error(r.error || 'Groq transcription failed') as Error & { transient?: boolean };
        err.transient = r.transient;
        throw err;
      }
      // Groq's times are relative to the piece; keep them inside it.
      pieces.push({
        offsetMs: c.offsetMs,
        segments: r.segments.map((s) => ({ ...s, endMs: Math.min(s.endMs, c.durationMs), startMs: Math.min(s.startMs, c.durationMs) }))
      });
    }
    const segments = cleanSegments(stitchSegments(pieces), {
      gate: prep.gate,
      levelAt: (a, b) => levelBetween(prep.frameLevels, prep.frameMs, a, b),
      vocabulary: words
    });
    return { ok: true, segments, durationMs: prep.durationMs, engine: 'groq' };
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

/** Run the chosen engine on one track; falls back to the local model when
 *  the choice cannot run (and says so in `warning`). */
async function runEngine(path: string, opts: TranscribeOptions): Promise<EngineRun> {
  const settings = readSettings();
  const engines = engineInfos((['base', 'large'] as const).map(modelInfo));
  const chosen = effectiveEngine(opts.engine ?? settings.engine, engines);
  const words = opts.vocabulary === false ? [] : mergeVocabulary(settings.customVocabulary);
  const lead = (opts.prompt ?? '').slice(0, 400);
  if (chosen === 'groq') {
    try {
      return await runGroq(path, words, lead, opts.language);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!(e as { transient?: boolean }).transient) {
        return { ok: false, segments: [], durationMs: 0, engine: 'groq', error: msg };
      }
      // Network, rate limit or a Groq outage: the local model can still do it.
      const local = await runLocal(path, 'base', words, lead);
      return { ...local, warning: `Groq: ${msg}; used the local model` };
    }
  }
  return runLocal(path, chosen === 'local-large' ? 'large' : 'base', words, lead);
}

function checkAudioPath(p: unknown): string | null {
  if (typeof p !== 'string' || !p || p.length > 4096 || !isAbsolute(p)) return null;
  try {
    const st = statSync(p);
    return st.isFile() && st.size > 44 ? p : null;
  } catch {
    return null;
  }
}

function casing(words: string[]): (text: string) => string {
  const compiled = compileVocabulary(words);
  return (text) => applyVocabularyCasing(text, compiled);
}

function markTranscribed(paths: Array<string | undefined>): void {
  if (!sessions) return;
  const ids = new Set<string>();
  for (const p of paths) {
    const id = p ? sessions.sessionOfPath(p) : null;
    if (id) ids.add(id);
  }
  for (const id of ids) sessions.markTranscribed(id);
}

// ─── Contract ───────────────────────────────────────────────────────────────

/** Transcribe one WAV file (absolute path, any PCM/float WAV). */
export async function transcribeFile(wavPath: string, opts: TranscribeOptions = {}): Promise<TranscribeResult> {
  if (!ctxRef) return failedTranscription('transcription is not ready yet');
  const path = checkAudioPath(wavPath);
  if (!path) return failedTranscription('no audio file');
  try {
    const run = await runEngine(path, opts);
    if (!run.ok) return failedTranscription(run.error || 'transcription failed', run.engine);
    const fix = casing(opts.vocabulary === false ? [] : mergeVocabulary(readSettings().customVocabulary));
    const segments = run.segments.map((s) => ({ ...s, text: fix(s.text) }));
    markTranscribed([path]);
    return {
      ok: true,
      text: transcriptText(segments),
      segments,
      engine: run.engine,
      durationMs: run.durationMs,
      ...(run.warning ? { warning: run.warning } : {})
    };
  } catch (e) {
    return failedTranscription(e instanceof Error ? e.message : String(e), readSettings().engine);
  } finally {
    publishStatus();
  }
}

/**
 * Transcribe a meeting: the microphone track as 'you', the system-audio track
 * as 'them', each on its own, then interleaved by start time with the mic's
 * echo of the call removed. Either track may be absent; if one fails the other
 * is still returned (ok, with `warning`).
 */
export async function transcribeMeeting(micWav?: string, systemWav?: string, opts: TranscribeOptions = {}): Promise<TranscribeResult> {
  if (!ctxRef) return failedTranscription('transcription is not ready yet');
  const mic = micWav ? checkAudioPath(micWav) : null;
  const sys = systemWav ? checkAudioPath(systemWav) : null;
  if (!mic && !sys) return failedTranscription('no audio file');
  const runs: Partial<Record<'you' | 'them', EngineRun>> = {};
  const errors: string[] = [];
  for (const [who, p] of [['you', mic], ['them', sys]] as const) {
    if (!p) continue;
    try {
      const r = await runEngine(p, opts);
      if (r.ok) runs[who] = r;
      else errors.push(`${who}: ${r.error}`);
    } catch (e) {
      errors.push(`${who}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  publishStatus();
  if (!runs.you && !runs.them) return failedTranscription(errors.join('; ') || 'transcription failed', readSettings().engine);
  const fix = casing(opts.vocabulary === false ? [] : mergeVocabulary(readSettings().customVocabulary));
  const merged = mergeMeeting(runs.you?.segments ?? [], runs.them?.segments ?? []).map((s) => ({ ...s, text: fix(s.text) }));
  markTranscribed([runs.you ? mic ?? undefined : undefined, runs.them ? sys ?? undefined : undefined]);
  const warnings = [...errors, runs.you?.warning, runs.them?.warning].filter(Boolean);
  return {
    ok: true,
    text: transcriptText(merged, { you: 'You', them: 'Them' }),
    segments: merged,
    engine: (runs.you ?? runs.them)!.engine,
    durationMs: Math.max(runs.you?.durationMs ?? 0, runs.them?.durationMs ?? 0),
    ...(warnings.length ? { warning: [...new Set(warnings)].join('; ') } : {})
  };
}

/** The WAV files a finalized capture session left on disk. */
export function sessionAudio(sessionId: string): FinalizeResult {
  if (!sessions || !isValidSessionId(sessionId)) {
    return { ok: false, sessionId: String(sessionId), durationMs: 0, error: 'unknown session' };
  }
  if (sessions.isOpen(sessionId)) return { ok: false, sessionId, durationMs: 0, error: 'session is still recording' };
  return sessions.describe(sessionId);
}

/** Transcribe a finalized capture session by id. */
export async function transcribeSession(sessionId: string, opts: TranscribeSessionOptions = {}): Promise<TranscribeResult> {
  const audio = sessionAudio(sessionId);
  if (!audio.ok) return failedTranscription(audio.error || 'no audio', readSettings().engine);
  const o: TranscribeOptions = opts.engine ? { engine: opts.engine } : {};
  if (opts.meeting) return transcribeMeeting(audio.micWav, audio.systemWav, o);
  return transcribeFile((audio.micWav ?? audio.systemWav)!, o);
}

// ─── IPC ────────────────────────────────────────────────────────────────────

/** Finalize what a renderer left open when it goes away (crash, reload,
 *  closed window): the audio is kept, the mic gate closes. */
function watchOwner(wc: WebContents): void {
  if (watchedOwners.has(wc.id)) return;
  watchedOwners.add(wc.id);
  const id = wc.id;
  const releaseOwned = (): void => {
    for (const sid of sessions?.ownedBy(id) ?? []) closeSession(sid, 'finalize');
  };
  wc.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) releaseOwned();
  });
  wc.once('destroyed', () => {
    watchedOwners.delete(id);
    releaseOwned();
  });
}

function closeSession(id: string, how: 'finalize' | 'cancel', ownerId?: number): FinalizeResult | boolean {
  const out = how === 'finalize' ? sessions!.finalize(id, ownerId) : sessions!.cancel(id, ownerId);
  const owner = loopbackOwners.get(id);
  if (owner !== undefined && !sessions!.isOpen(id)) {
    loopbackOwners.delete(id);
    disarmLoopback(owner);
  }
  return out;
}

function parseBegin(raw: unknown): BeginSessionRequest | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!isValidSessionId(r.sessionId) || typeof r.mic !== 'boolean' || typeof r.system !== 'boolean') return null;
  const purpose = r.purpose === 'message' || r.purpose === 'meeting' || r.purpose === 'dictation' ? r.purpose : undefined;
  return { sessionId: r.sessionId, mic: r.mic, system: r.system, ...(purpose ? { purpose } : {}) };
}

function toBytes(chunk: unknown): Uint8Array | null {
  if (chunk instanceof Uint8Array) return chunk;
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
  if (ArrayBuffer.isView(chunk)) return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  return null;
}

const isTrack = (t: unknown): t is TranscribeTrack => t === 'mic' || t === 'system';
const isModelId = (m: unknown): m is LocalModelId => m === 'base' || m === 'large';

function registerIpc(): void {
  ipcMain.handle(TRANSCRIBE_CH.begin, (evt: IpcMainInvokeEvent, raw: unknown): BeginSessionResult => {
    const req = parseBegin(raw);
    if (!req || !sessions) return { ok: false, error: 'invalid request', loopback: false };
    const r = sessions.begin(req, evt.sender.id);
    if (!r.ok) return { ok: false, error: r.error, loopback: false };
    watchOwner(evt.sender);
    let loopback = false;
    if (req.system && systemAudioMode() === 'loopback') {
      ensureDisplayMediaHandler(evt.sender.session);
      armLoopback(evt.sender.id);
      loopbackOwners.set(req.sessionId, evt.sender.id);
      loopback = true;
    }
    return { ok: true, loopback };
  });

  ipcMain.on(TRANSCRIBE_CH.append, (evt: IpcMainEvent, sessionId: unknown, track: unknown, chunk: unknown) => {
    const bytes = toBytes(chunk);
    if (!sessions || !isValidSessionId(sessionId) || !isTrack(track) || !bytes) return;
    sessions.append(sessionId, evt.sender.id, track, bytes);
  });

  ipcMain.handle(TRANSCRIBE_CH.finalize, (evt, sessionId: unknown): FinalizeResult => {
    if (!sessions || !isValidSessionId(sessionId)) {
      return { ok: false, sessionId: String(sessionId), durationMs: 0, error: 'invalid session id' };
    }
    const owner = sessions.ownerOf(sessionId);
    if (owner !== null && owner !== evt.sender.id) return { ok: false, sessionId, durationMs: 0, error: 'not your session' };
    return closeSession(sessionId, 'finalize', evt.sender.id) as FinalizeResult;
  });

  ipcMain.handle(TRANSCRIBE_CH.cancel, (evt, sessionId: unknown) => {
    if (!sessions || !isValidSessionId(sessionId)) return { ok: false };
    return { ok: closeSession(sessionId, 'cancel', evt.sender.id) === true };
  });

  ipcMain.handle(TRANSCRIBE_CH.transcribeSession, async (_evt, sessionId: unknown, rawOpts: unknown) => {
    if (!isValidSessionId(sessionId)) return failedTranscription('invalid session id');
    const o = (rawOpts && typeof rawOpts === 'object' ? rawOpts : {}) as Record<string, unknown>;
    const eng = sanitizeSettingsPatch({ engine: o.engine }).engine;
    return transcribeSession(sessionId, { meeting: o.meeting === true, ...(eng ? { engine: eng } : {}) });
  });

  ipcMain.handle(TRANSCRIBE_CH.getSettings, () => readSettings());

  ipcMain.handle(TRANSCRIBE_CH.setSettings, (_evt, patch: unknown) => {
    const clean = sanitizeSettingsPatch(patch);
    const next = normalizeSettings(ctxRef!.writeFeatureSettings<TranscribeSettings>(UNIT, DEFAULT_TRANSCRIBE_SETTINGS, clean));
    // Picking the larger model is the "one download away": start it now.
    if (clean.engine === 'local-large' && !resolved('large').root && !download) {
      startDownload('large').catch(() => { /* surfaced in status */ });
    }
    publishStatus();
    return next;
  });

  ipcMain.handle(TRANSCRIBE_CH.getStatus, () => currentStatus());

  ipcMain.handle(TRANSCRIBE_CH.downloadModel, async (_evt, which: unknown) => {
    if (!isModelId(which)) return { ok: false, error: 'unknown model' };
    if (resolved(which).root) return { ok: true };
    if (download && download.model !== which) return { ok: false, error: 'another model is downloading' };
    startDownload(which).catch(() => { /* surfaced in status */ });
    return { ok: true };
  });

  ipcMain.handle(TRANSCRIBE_CH.cancelDownload, () => {
    download?.controller.abort();
    return { ok: true };
  });

  ipcMain.handle(TRANSCRIBE_CH.removeModel, (_evt, which: unknown) => {
    if (!isModelId(which)) return { ok: false, error: 'unknown model' };
    const r = resolved(which);
    if (r.state === 'bundled') return { ok: false, error: 'the bundled model cannot be removed' };
    if (download?.model === which) download.controller.abort();
    try {
      rmSync(modelDir(cacheRoot(), MODELS[which]), { recursive: true, force: true });
      delete modelErrors[which];
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    publishStatus();
    return { ok: true };
  });

  ipcMain.handle(TRANSCRIBE_CH.getVocabulary, () => ({ builtin: [...BUILTIN_VOCABULARY] }));
}

function sweep(): void {
  try {
    const removed = sessions?.sweep() ?? [];
    if (removed.length) console.log(`[transcribe] deleted ${removed.length} expired recording(s)`);
    // Leftover Groq pieces from a crash mid-upload.
    const tmp = join(dataDir(), 'groq-tmp');
    if (existsSync(tmp) && !engine.busy) rmSync(tmp, { recursive: true, force: true });
  } catch (e) {
    console.error('[transcribe] retention sweep failed:', e);
  }
}

export const transcribeFeature: FeatureModule = {
  name: UNIT,
  // ScreenCaptureKit system-audio loopback for getDisplayMedia (macOS 13+).
  earlyEnableFeatures: process.platform === 'darwin' ? LOOPBACK_FEATURES : [],
  register(ctx) {
    ctxRef = ctx;
    sessions = new SessionStore(join(ctx.featureDataDir(UNIT), 'sessions'), () => publishStatus());
    registerIpc();
    // Off the boot path, then hourly.
    setTimeout(sweep, 15_000).unref?.();
    sweepTimer = setInterval(sweep, SWEEP_EVERY_MS);
    sweepTimer.unref?.();
  },
  micLive() {
    return sessions?.anyOpen() ?? false;
  },
  dispose() {
    if (sweepTimer) clearInterval(sweepTimer);
    sweepTimer = null;
    if (statusTimer) clearTimeout(statusTimer);
    statusTimer = null;
    download?.controller.abort();
    sessions?.closeAll();
    engine.dispose();
  }
};
