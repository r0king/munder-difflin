/**
 * Audio capture — owned by the `transcribe` unit, used by `stapler` (record
 * message, record meeting) and `dictate`.
 *
 * Captures the microphone ('you') and/or system audio ('them') in a renderer,
 * converts each to 16 kHz mono Int16 in an AudioWorklet (pcm-worklet.ts), and
 * streams ~1 s chunks to main, which appends them to
 * `<userData>/features/transcribe/sessions/<sessionId>/{mic,system}.wav`.
 * Nothing accumulates here, however long the recording.
 *
 * Order matters: the session is opened in main (`beginSession`) BEFORE
 * getUserMedia, because main's microphone permission gate only opens while a
 * feature reports a live capture.
 *
 * Mic processing: for a meeting it is OFF (no echo cancellation, noise
 * suppression or auto gain). Chromium's echo canceller only knows audio this
 * app plays, not the call app's, so it cannot remove the other side — but it
 * does duck your voice while both talk, and those words are what a meeting
 * transcript must keep. The far end leaking into the mic is removed later, as
 * text (meeting.ts drops a 'you' line that repeats a simultaneous 'them'
 * line). For a message or dictation (near-field, nothing playing) Chromium's
 * defaults stay on: steadier levels for a short clip.
 *
 * stop() flushes the worklet (its resampler tail and partial chunk) before the
 * session is finalized, so the last word is kept, and releases the devices as
 * soon as the flush is back — a few milliseconds after the click.
 */
import workletUrl from './pcm-worklet?worker&url';
import {
  DEFAULT_TRANSCRIBE_SETTINGS,
  isValidSessionId,
  newSessionId,
  type CapturePurpose,
  type SystemAudioMode,
  type TranscribeSettings,
  type TranscribeStatus,
  type TranscribeTrack
} from '../../../../shared/features/transcribe';
import { meterLevel } from '../../../../shared/features/transcribeAudio';
import { loopbackFailure, planSystemAudio, type AudioInput } from './systemAudio';
import type { WorkletMessage } from './pcm-worklet';

export { newSessionId };
export type { AudioInput };

export interface CaptureOptions {
  /** Names the session folder (see newSessionId); one session = one recording. */
  sessionId: string;
  /** Capture the microphone ('you'). */
  mic: boolean;
  /** Capture system audio ('them'). */
  system: boolean;
  /** Override the device chosen in transcription settings ('' = default). */
  micDeviceId?: string;
  systemDeviceId?: string;
  /** Default: 'meeting' when system audio is captured, else 'message'. */
  purpose?: CapturePurpose;
}

export interface CaptureLevels {
  /** 0..1 (a -60..0 dBFS meter) */
  mic: number;
  /** 0..1 */
  system: number;
}

/** Something the user should know about this capture (i18n:
 *  `transcribe.notice.<code>`, see captureNoticeKey). */
export type CaptureNotice =
  | 'mic-device-missing'
  | 'system-device-missing'
  | 'system-no-monitor'
  | 'system-unsupported'
  | 'system-permission'
  | 'system-no-audio';

export interface CaptureInfo {
  sessionId: string;
  /** Label of the microphone in use ('' when the OS does not say). */
  micLabel: string | null;
  /** How system audio is captured, or null when it is not. */
  system: null | { kind: 'loopback' | 'monitor' | 'device'; label: string };
  notices: CaptureNotice[];
}

export interface CaptureStopResult {
  ok: boolean;
  /** Absolute path of the microphone WAV, when captured. */
  micWav?: string;
  /** Absolute path of the system-audio WAV, when captured. */
  systemWav?: string;
  durationMs: number;
  error?: string;
}

export interface CaptureHandle {
  readonly sessionId: string;
  readonly info: CaptureInfo;
  /** Live input levels (~20 Hz); returns the unsubscribe function. */
  onLevel(cb: (levels: CaptureLevels) => void): () => void;
  /** A device went away mid-recording (unplugged, share ended by the OS). */
  onEnded(cb: (track: TranscribeTrack) => void): () => void;
  /** Stop and write the WAV file(s). Idempotent. */
  stop(): Promise<CaptureStopResult>;
  /** Stop and discard everything. */
  cancel(): Promise<void>;
}

export type CaptureErrorCode = 'invalid' | 'begin-failed' | 'no-input' | 'audio-failed';

/** Errors of our own. getUserMedia's DOMExceptions (NotAllowedError for a
 *  denied mic, NotFoundError…) are rethrown unchanged, so callers can tell
 *  "permission" from "no device" by `name`. */
export class CaptureError extends Error {
  readonly code: CaptureErrorCode;
  constructor(code: CaptureErrorCode, message: string) {
    super(message);
    this.name = 'CaptureError';
    this.code = code;
  }
}

export function captureNoticeKey(n: CaptureNotice): string {
  return `transcribe.notice.${n}`;
}

const FLUSH_TIMEOUT_MS = 600;

function api(): typeof window.cth.features.transcribe {
  return window.cth.features.transcribe;
}

function micConstraints(deviceId: string, purpose: CapturePurpose): MediaTrackConstraints {
  const processing = purpose !== 'meeting';
  return {
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    echoCancellation: processing,
    noiseSuppression: processing,
    autoGainControl: processing
  };
}

/** A loopback or monitor source is the mix itself: never process it. */
function rawConstraints(deviceId: string): MediaTrackConstraints {
  return { deviceId: { exact: deviceId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false };
}

function errName(e: unknown): string {
  return e && typeof e === 'object' && 'name' in e ? String((e as { name: unknown }).name) : '';
}

/** Audio inputs, labelled. Device labels are only exposed while the mic gate
 *  is open, so when they come back blank a recording-less probe session opens
 *  the gate for the one enumerate call. */
export async function listAudioInputs(): Promise<AudioInput[]> {
  const read = async (): Promise<AudioInput[]> =>
    (await navigator.mediaDevices.enumerateDevices())
      .filter((d) => d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications')
      .map((d) => ({ deviceId: d.deviceId, label: d.label }));
  let list = await read();
  if (list.length && list.some((d) => d.label)) return list;
  const probe = newSessionId();
  const begun = await api().beginSession({ sessionId: probe, mic: true, system: false, purpose: 'message' }).catch(() => null);
  try {
    if (begun?.ok) list = await read();
  } finally {
    if (begun?.ok) await api().cancelSession(probe).catch(() => undefined);
  }
  return list;
}

async function openLoopback(platform: string): Promise<MediaStream> {
  const s = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: { frameRate: 1 } });
  for (const v of s.getVideoTracks()) {
    if (platform === 'darwin') {
      // ScreenCaptureKit delivers audio and video from one stream; stopping
      // the video can end the audio with it. Keep it, disabled, at 1 fps,
      // until the recording stops.
      v.enabled = false;
    } else {
      v.stop();
      s.removeTrack(v);
    }
  }
  if (!s.getAudioTracks().length) {
    for (const t of s.getTracks()) t.stop();
    throw Object.assign(new Error('the screen share carried no audio'), { name: 'NoAudioTrack' });
  }
  return s;
}

interface TrackRig {
  track: TranscribeTrack;
  stream: MediaStream;
  node: AudioWorkletNode;
  source: MediaStreamAudioSourceNode;
  flushed: Promise<void>;
  markFlushed: () => void;
}

export async function startCapture(opts: CaptureOptions): Promise<CaptureHandle> {
  const { sessionId } = opts;
  if (!isValidSessionId(sessionId)) throw new CaptureError('invalid', 'invalid session id');
  if (!opts.mic && !opts.system) throw new CaptureError('invalid', 'nothing to record');
  const t = api();
  const [settings, status] = await Promise.all([
    t.getSettings().catch((): TranscribeSettings => ({ ...DEFAULT_TRANSCRIBE_SETTINGS })),
    t.getStatus().catch((): TranscribeStatus | null => null)
  ]);
  const purpose: CapturePurpose = opts.purpose ?? (opts.system ? 'meeting' : 'message');
  const begun = await t.beginSession({ sessionId, mic: opts.mic, system: opts.system, purpose });
  if (!begun.ok) throw new CaptureError('begin-failed', begun.error ?? 'could not start the recording');

  const streams: MediaStream[] = [];
  const notices: CaptureNotice[] = [];
  let ctx: AudioContext | null = null;
  const releaseDevices = (): void => {
    for (const s of streams) for (const tr of s.getTracks()) tr.stop();
  };

  try {
    // ── Microphone ──
    let micStream: MediaStream | null = null;
    if (opts.mic) {
      const wanted = opts.micDeviceId ?? settings.micDeviceId;
      try {
        micStream = await navigator.mediaDevices.getUserMedia({ audio: micConstraints(wanted, purpose) });
      } catch (e) {
        const gone = errName(e) === 'OverconstrainedError' || errName(e) === 'NotFoundError';
        if (!wanted || !gone) throw e;
        notices.push('mic-device-missing');
        micStream = await navigator.mediaDevices.getUserMedia({ audio: micConstraints('', purpose) });
      }
      streams.push(micStream);
    }

    // ── System audio ──
    let sysStream: MediaStream | null = null;
    let sysInfo: CaptureInfo['system'] = null;
    if (opts.system) {
      const mode: SystemAudioMode = status?.systemAudio ?? 'device';
      const inputs = await listAudioInputs().catch(() => [] as AudioInput[]);
      const plan = planSystemAudio({
        mode,
        chosenDeviceId: opts.systemDeviceId ?? settings.systemDeviceId,
        inputs,
        loopbackArmed: begun.loopback
      });
      if (plan.kind === 'loopback') {
        try {
          sysStream = await openLoopback(status?.platform ?? '');
          sysInfo = { kind: 'loopback', label: sysStream.getAudioTracks()[0]?.label ?? '' };
        } catch (e) {
          notices.push(loopbackFailure(e) === 'permission' ? 'system-permission' : 'system-no-audio');
        }
      } else if (plan.kind === 'device' || plan.kind === 'monitor') {
        try {
          sysStream = await navigator.mediaDevices.getUserMedia({ audio: rawConstraints(plan.deviceId) });
          sysInfo = { kind: plan.kind, label: plan.label || sysStream.getAudioTracks()[0]?.label || '' };
        } catch {
          notices.push(plan.kind === 'monitor' ? 'system-no-monitor' : 'system-device-missing');
        }
      } else {
        notices.push(
          plan.notice === 'device-missing' ? 'system-device-missing' : plan.notice === 'no-monitor' ? 'system-no-monitor' : 'system-unsupported'
        );
      }
      if (sysStream) streams.push(sysStream);
    }
    if (!micStream && !sysStream) throw new CaptureError('no-input', 'no audio source is available');

    // ── Graph: source → worklet → (silent) destination ──
    ctx = new AudioContext({ latencyHint: 'interactive' });
    await ctx.audioWorklet.addModule(workletUrl);
    // A zero-gain sink keeps every worklet pulled by the renderer even though
    // nothing is audible.
    const sink = ctx.createGain();
    sink.gain.value = 0;
    sink.connect(ctx.destination);

    const levels: CaptureLevels = { mic: 0, system: 0 };
    const levelCbs = new Set<(l: CaptureLevels) => void>();
    const endedCbs = new Set<(tr: TranscribeTrack) => void>();
    const rigs: TrackRig[] = [];
    const audioCtx = ctx;
    const rig = (track: TranscribeTrack, stream: MediaStream): TrackRig => {
      const source = audioCtx.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(audioCtx, 'cth-pcm-capture', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1]
      });
      let markFlushed = (): void => {};
      const flushed = new Promise<void>((resolve) => { markFlushed = resolve; });
      node.port.onmessage = (e: MessageEvent<WorkletMessage>) => {
        const m = e.data;
        if (m.type === 'pcm') t.appendPcm(sessionId, track, m.samples);
        else if (m.type === 'level') {
          levels[track] = meterLevel(m.rms);
          const snap = { ...levels };
          for (const cb of levelCbs) {
            try { cb(snap); } catch { /* a listener's bug is its own */ }
          }
        } else if (m.type === 'flushed') markFlushed();
      };
      source.connect(node);
      node.connect(sink);
      for (const tr of stream.getAudioTracks()) {
        tr.addEventListener('ended', () => {
          for (const cb of endedCbs) {
            try { cb(track); } catch { /* ignore */ }
          }
        });
      }
      return { track, stream, node, source, flushed, markFlushed };
    };
    if (micStream) rigs.push(rig('mic', micStream));
    if (sysStream) rigs.push(rig('system', sysStream));
    if (ctx.state === 'suspended') await ctx.resume().catch(() => undefined);

    const teardown = (): void => {
      releaseDevices();
      for (const r of rigs) {
        try { r.source.disconnect(); r.node.disconnect(); } catch { /* already */ }
        r.node.port.onmessage = null;
      }
      void audioCtx.close().catch(() => undefined);
    };

    let stopping: Promise<CaptureStopResult> | null = null;
    let cancelled = false;
    const handle: CaptureHandle = {
      sessionId,
      info: {
        sessionId,
        micLabel: micStream ? micStream.getAudioTracks()[0]?.label ?? '' : null,
        system: sysInfo,
        notices
      },
      onLevel(cb) {
        levelCbs.add(cb);
        return () => { levelCbs.delete(cb); };
      },
      onEnded(cb) {
        endedCbs.add(cb);
        return () => { endedCbs.delete(cb); };
      },
      stop() {
        if (stopping) return stopping;
        if (cancelled) return Promise.resolve({ ok: false, durationMs: 0, error: 'cancelled' });
        stopping = (async (): Promise<CaptureStopResult> => {
          // Flush first: every chunk the worklet holds is posted (and so sent
          // to main) before its `flushed` arrives on the same port.
          for (const r of rigs) r.node.port.postMessage({ type: 'flush' });
          await Promise.race([
            Promise.all(rigs.map((r) => r.flushed)),
            new Promise((resolve) => setTimeout(resolve, FLUSH_TIMEOUT_MS))
          ]);
          teardown();
          levelCbs.clear();
          try {
            const r = await t.finalizeSession(sessionId);
            return {
              ok: r.ok,
              ...(r.micWav ? { micWav: r.micWav } : {}),
              ...(r.systemWav ? { systemWav: r.systemWav } : {}),
              durationMs: r.durationMs,
              ...(r.error ? { error: r.error } : {})
            };
          } catch (e) {
            return { ok: false, durationMs: 0, error: e instanceof Error ? e.message : String(e) };
          }
        })();
        return stopping;
      },
      async cancel() {
        if (cancelled) return;
        cancelled = true;
        if (stopping) {
          // Already finalizing: let it land, then delete what it wrote.
          await stopping.catch(() => undefined);
        } else {
          teardown();
          levelCbs.clear();
        }
        await t.cancelSession(sessionId).catch(() => undefined);
      }
    };
    return handle;
  } catch (e) {
    releaseDevices();
    if (ctx) void ctx.close().catch(() => undefined);
    await t.cancelSession(sessionId).catch(() => undefined);
    if (e instanceof CaptureError || errName(e)) throw e;
    throw new CaptureError('audio-failed', e instanceof Error ? e.message : String(e));
  }
}
