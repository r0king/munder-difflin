/**
 * Drives the recording state machine (flow.ts) with real side effects: tell
 * main what is recording, open the capture (the transcribe unit's capture.ts),
 * stop it, transcribe the session, and — for a message — send.
 *
 * Side effects run on PHASE CHANGES, never inside event handlers, so a click,
 * the global shortcut and a timeout all take exactly the same path. Each async
 * result is dispatched with the session it belongs to; the reducer drops it if
 * that session is no longer current.
 *
 * "The mic stops at the click": 'stopping' calls handle.stop() immediately,
 * before anything else, and main is told recording ended as soon as it has.
 */
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { startCapture, type CaptureHandle, type CaptureLevels, type CaptureStopResult } from './audio/capture';
import { flowReducer, initialFlow, type FlowKind, type FlowState } from './flow';
import { newSessionId, type MeetingSegment, type MeetingSummary, type StaplerResult } from '@shared/features/stapler';
import type { TranscribeResult } from '@shared/features/transcribe';
import { reason, stapler } from './bridge';

const ZERO: CaptureLevels = { mic: 0, system: 0 };

interface LiveCapture {
  sessionId: string;
  /** Resolves to the handle once the capture is open, or null if it failed. */
  handle: Promise<CaptureHandle | null>;
  unsubscribe?: () => void;
}

export interface Recorder {
  kind: FlowKind;
  flow: FlowState;
  levels: CaptureLevels;
  /** Wall clock, refreshed while anything is in flight (for the timer). */
  now: number;
  start(): void;
  stop(): void;
  cancel(): void;
  discard(): void;
  retry(): void;
  edit(text: string): void;
  send(): void;
  /** Meetings: the last one saved (for "Open in library"). */
  saved: MeetingSummary | null;
}

function toSegments(r: TranscribeResult): MeetingSegment[] {
  return (r.segments ?? []).map((s) => ({
    speaker: s.speaker === 'them' ? 'them' : 'you',
    startMs: s.startMs,
    endMs: s.endMs,
    text: s.text
  }));
}

export function useRecorder(kind: FlowKind, opts: { onSend?: (text: string) => Promise<StaplerResult> } = {}): Recorder {
  const [flow, dispatch] = useReducer(flowReducer, undefined, () => initialFlow(Date.now()));
  const flowRef = useRef(flow);
  flowRef.current = flow;
  const capture = useRef<LiveCapture | null>(null);
  const meetingId = useRef<string | null>(null);
  const [levels, setLevels] = useState<CaptureLevels>(ZERO);
  const [now, setNow] = useState(() => Date.now());
  const [saved, setSaved] = useState<MeetingSummary | null>(null);
  const onSend = useRef(opts.onSend);
  onSend.current = opts.onSend;

  // The clock: deadlines, the maximum length, and the elapsed timer.
  const active = flow.phase !== 'idle';
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      const n = Date.now();
      setNow(n);
      dispatch({ type: 'tick', now: n });
    }, 250);
    return () => clearInterval(timer);
  }, [active]);

  /** Drop the live capture. `discard`: the user cancelled (throw the audio
   *  and an empty meeting folder away); otherwise it failed (keep the folder,
   *  marked failed). A failed meeting's audio is finalized, not deleted: the
   *  meeting already names its session, so the library can transcribe it. */
  const release = useCallback((discard: boolean, error?: string) => {
    const live = capture.current;
    capture.current = null;
    if (live) {
      live.unsubscribe?.();
      setLevels(ZERO);
      const keep = !discard && kind === 'meeting';
      void live.handle.then(async (h) => { if (keep) await h?.stop(); else await h?.cancel(); }).catch(() => { /* already gone */ });
      void stapler().setRecording(null).catch(() => { /* main gone */ });
      const id = meetingId.current;
      if (kind === 'meeting' && id) {
        meetingId.current = null;
        if (discard) void stapler().meetingAbort(id).catch(() => { /* best-effort */ });
        else void stapler().meetingFinish(id, { ok: false, durationMs: 0, segments: [], error: error || 'capture failed' }).catch(() => { /* best-effort */ });
      }
    }
  }, [kind]);

  const begin = useCallback(async (sessionId: string) => {
    let resolve: (h: CaptureHandle | null) => void = () => {};
    const handle = new Promise<CaptureHandle | null>((r) => { resolve = r; });
    const live: LiveCapture = { sessionId, handle };
    capture.current = live;
    try {
      // Main first: the permission gate and "invisible while recording".
      await stapler().setRecording(kind);
      if (kind === 'meeting') {
        const r = await stapler().meetingStart(sessionId);
        if (!r.ok || !r.id) throw new Error(r.error || 'meeting-start');
        if (capture.current !== live) {
          // Cancelled (or stopped) before main answered: release() could not
          // name this meeting yet, so drop its empty folder here.
          resolve(null);
          void stapler().meetingAbort(r.id).catch(() => { /* best-effort */ });
          return;
        }
        meetingId.current = r.id;
      }
      let micDeviceId: string | undefined;
      let systemDeviceId: string | undefined;
      try {
        const s = await window.cth.features.transcribe.getSettings();
        micDeviceId = s.micDeviceId || undefined;
        systemDeviceId = s.systemDeviceId || undefined;
      } catch { /* defaults */ }
      const h = await startCapture({ sessionId, mic: true, system: kind === 'meeting', micDeviceId, systemDeviceId });
      if (capture.current !== live) {
        // Cancelled while the mic was opening.
        resolve(null);
        await h.cancel().catch(() => { /* gone */ });
        return;
      }
      live.unsubscribe = h.onLevel(setLevels);
      resolve(h);
      dispatch({ type: 'started', sessionId, now: Date.now() });
    } catch (e) {
      resolve(null);
      const msg = reason(e);
      if (capture.current === live) release(true, msg);
      dispatch({ type: 'fail', error: msg, sessionId, now: Date.now() });
    }
  }, [kind, release]);

  const finish = useCallback(async (sessionId: string) => {
    const live = capture.current;
    if (!live || live.sessionId !== sessionId) {
      dispatch({ type: 'fail', error: 'no-capture', sessionId, now: Date.now() });
      return;
    }
    const h = await live.handle;
    if (!h) return; // begin() already reported why
    let res: CaptureStopResult;
    try {
      res = await h.stop();
    } catch (e) {
      res = { ok: false, durationMs: 0, error: reason(e) };
    }
    live.unsubscribe?.();
    setLevels(ZERO);
    if (capture.current === live) capture.current = null;
    void stapler().setRecording(null).catch(() => { /* main gone */ });
    if (!res.ok) {
      const id = meetingId.current;
      if (kind === 'meeting' && id) {
        void stapler().meetingFinish(id, { ok: false, durationMs: res.durationMs, segments: [], error: res.error || 'capture failed' }).catch(() => {});
      }
      dispatch({ type: 'fail', error: res.error || 'capture failed', sessionId, now: Date.now() });
      return;
    }
    dispatch({ type: 'stopped', sessionId, durationMs: res.durationMs, now: Date.now() });
  }, [kind]);

  const transcribe = useCallback(async (sessionId: string) => {
    const id = meetingId.current;
    const durationMs = flowRef.current.recordedMs;
    if (kind === 'meeting' && id) {
      await stapler().meetingTranscribing(id, { sessionId, durationMs }).catch(() => { /* still try */ });
    }
    let r: TranscribeResult;
    try {
      r = await window.cth.features.transcribe.transcribeSession(sessionId, { meeting: kind === 'meeting' });
    } catch (e) {
      r = { ok: false, text: '', segments: [], engine: 'local', error: reason(e) };
    }
    if (kind === 'meeting' && id) {
      // Saved whatever the UI is doing now — even if it gave up waiting, the
      // meeting's folder gets its transcript.
      try {
        const fin = await stapler().meetingFinish(id, {
          ok: r.ok,
          durationMs: durationMs || r.durationMs || 0,
          segments: r.ok ? toSegments(r) : [],
          engine: r.engine,
          ...(r.ok ? {} : { error: r.error || 'transcription failed' })
        });
        if (fin.meeting) setSaved(fin.meeting);
      } catch { /* main gone */ }
    }
    if (r.ok) dispatch({ type: 'transcribed', sessionId, text: r.text ?? '', now: Date.now() });
    else dispatch({ type: 'fail', error: r.error || 'transcription failed', sessionId, now: Date.now() });
  }, [kind]);

  const deliver = useCallback(async () => {
    const send = onSend.current;
    if (!send) { dispatch({ type: 'fail', error: 'invalid', now: Date.now() }); return; }
    try {
      const res = await send(flowRef.current.text);
      if (res.ok) dispatch({ type: 'sent', now: Date.now() });
      else dispatch({ type: 'fail', error: res.error || 'send failed', now: Date.now() });
    } catch (e) {
      dispatch({ type: 'fail', error: reason(e), now: Date.now() });
    }
  }, []);

  // Side effects on phase changes.
  useEffect(() => {
    const s = flowRef.current;
    const sid = s.sessionId;
    switch (s.phase) {
      case 'starting': if (sid) void begin(sid); break;
      case 'stopping': if (sid) void finish(sid); break;
      case 'transcribing': if (sid) void transcribe(sid); break;
      case 'sending': void deliver(); break;
      case 'idle': release(true); break;
      case 'error': release(false, s.error ?? undefined); break;
      default: break;
    }
  }, [flow.phase, flow.sessionId, begin, finish, transcribe, deliver, release]);

  // Leaving (window closing, reload): never leave a mic open.
  useEffect(() => () => release(true), [release]);

  return {
    kind,
    flow,
    levels,
    now,
    saved,
    start: () => {
      if (kind === 'meeting') { meetingId.current = null; setSaved(null); }
      dispatch({ type: 'start', kind, sessionId: newSessionId(kind), now: Date.now() });
    },
    stop: () => dispatch({ type: 'stop', now: Date.now() }),
    cancel: () => dispatch({ type: 'cancel', now: Date.now() }),
    discard: () => dispatch({ type: 'discard', now: Date.now() }),
    retry: () => dispatch({ type: 'retry', now: Date.now() }),
    edit: (text: string) => dispatch({ type: 'edit', text }),
    send: () => dispatch({ type: 'send', now: Date.now() })
  };
}
