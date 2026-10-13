/**
 * The recording state machine behind Record message and Record meeting.
 * Pure — no React, no IPC — so every path is unit-tested
 * (test/stapler-flow.test.cjs) and the component that drives it only performs
 * side effects on phase changes.
 *
 *   idle → starting → recording → stopping → transcribing → review → sending → done
 *                                                        ↘ (meeting) done
 *   any busy phase ──fail/timeout──→ error ──retry/start/send──→ …
 *   any phase ──cancel──→ idle
 *
 * "Record message never gets stuck": every phase that waits on something
 * outside (the mic opening, the WAV being written, the transcriber, the send)
 * has a deadline, checked by `tick`; a recording has a maximum length and is
 * stopped for the user when it passes; and every async result carries the
 * session it belongs to, so a late answer from a cancelled recording can never
 * move the current one.
 */

export type FlowKind = 'message' | 'meeting';

export type FlowPhase =
  | 'idle'
  | 'starting'
  | 'recording'
  | 'stopping'
  | 'transcribing'
  | 'review'
  | 'sending'
  | 'done'
  | 'error';

export interface FlowState {
  phase: FlowPhase;
  kind: FlowKind | null;
  sessionId: string | null;
  /** When the current phase was entered. */
  since: number;
  /** When audio actually started flowing. */
  startedAt: number | null;
  /** The message text: what was typed plus what was transcribed (editable). */
  text: string;
  error: string | null;
  /** The phase that failed — decides what "Try again" does. */
  failedIn: FlowPhase | null;
  /** The recording hit its maximum length and was stopped automatically. */
  autoStopped: boolean;
  /** Length of the last capture, once it is written. */
  recordedMs: number;
}

export type FlowEvent =
  | { type: 'start'; kind: FlowKind; sessionId: string; now: number }
  | { type: 'started'; sessionId: string; now: number }
  | { type: 'stop'; now: number }
  | { type: 'stopped'; sessionId: string; durationMs: number; now: number }
  | { type: 'transcribed'; sessionId: string; text: string; now: number }
  | { type: 'edit'; text: string }
  | { type: 'send'; now: number }
  | { type: 'sent'; now: number }
  | { type: 'fail'; error: string; now: number; sessionId?: string }
  | { type: 'retry'; now: number }
  | { type: 'cancel'; now: number }
  | { type: 'discard'; now: number }
  | { type: 'tick'; now: number };

/** How long each waiting phase may take before it is an error. Transcribing
 *  is generous: a ten-minute message on the local model on a slow CPU. */
export const PHASE_TIMEOUT_MS: Partial<Record<FlowPhase, number>> = {
  starting: 15_000,
  stopping: 20_000,
  transcribing: 10 * 60_000,
  sending: 20_000
};

/** A recording is stopped for the user after this long. */
export const MAX_RECORDING_MS: Record<FlowKind, number> = {
  message: 10 * 60_000,
  meeting: 4 * 60 * 60_000
};

/** How long "Sent" / "Saved" stays up before the flow returns to idle. */
export const DONE_LINGER_MS = 2_500;

export const TIMEOUT_ERROR = 'timeout';

/**
 * The deadline for the current phase. Transcription scales with what was
 * recorded — a two-hour meeting on the local model can honestly take longer
 * than ten minutes — at twice real time, never less than the fixed floor.
 */
export function phaseTimeout(s: FlowState): number | undefined {
  const base = PHASE_TIMEOUT_MS[s.phase];
  if (s.phase === 'transcribing' && base !== undefined) return Math.max(base, 2 * s.recordedMs);
  return base;
}

export const initialFlow = (now = 0): FlowState => ({
  phase: 'idle',
  kind: null,
  sessionId: null,
  since: now,
  startedAt: null,
  text: '',
  error: null,
  failedIn: null,
  autoStopped: false,
  recordedMs: 0
});

const BUSY: readonly FlowPhase[] = ['starting', 'recording', 'stopping', 'transcribing', 'sending'];

/** Something is in flight (the puck shows it; a second recording waits). */
export function isBusy(s: FlowState): boolean {
  return BUSY.includes(s.phase);
}

/** Audio is being captured or written. */
export function isCapturing(s: FlowState): boolean {
  return s.phase === 'starting' || s.phase === 'recording' || s.phase === 'stopping';
}

/** Can the compose panel send now? */
export function canSend(s: FlowState, attachmentCount: number): boolean {
  if (s.phase !== 'idle' && s.phase !== 'review' && s.phase !== 'error' && s.phase !== 'done') return false;
  if (s.kind === 'meeting' && s.phase === 'error') return false;
  return s.text.trim().length > 0 || attachmentCount > 0;
}

/** Join typed text and a fresh transcript with one blank line between. */
export function appendTranscript(existing: string, transcript: string): string {
  const a = existing.replace(/\s+$/, '');
  const b = transcript.trim();
  if (!b) return existing;
  return a ? `${a}\n\n${b}` : b;
}

const enter = (s: FlowState, phase: FlowPhase, now: number, patch: Partial<FlowState> = {}): FlowState => ({
  ...s,
  ...patch,
  phase,
  since: now
});

const fail = (s: FlowState, error: string, now: number): FlowState =>
  enter(s, 'error', now, { error, failedIn: s.phase });

export function flowReducer(s: FlowState, e: FlowEvent): FlowState {
  switch (e.type) {
    case 'start': {
      if (isBusy(s)) return s;
      return enter(s, 'starting', e.now, {
        kind: e.kind,
        sessionId: e.sessionId,
        startedAt: null,
        error: null,
        failedIn: null,
        autoStopped: false,
        recordedMs: 0,
        // A meeting's transcript lives in its folder, not in the note.
        text: e.kind === 'meeting' ? '' : s.text
      });
    }
    case 'started':
      if (s.phase !== 'starting' || e.sessionId !== s.sessionId) return s;
      return enter(s, 'recording', e.now, { startedAt: e.now });
    case 'stop':
      // Stopping while the mic is still opening is a cancel of nothing yet:
      // go straight to stopping and let the driver tear the capture down.
      if (s.phase !== 'recording' && s.phase !== 'starting') return s;
      return enter(s, 'stopping', e.now);
    case 'stopped':
      if (s.phase !== 'stopping' || e.sessionId !== s.sessionId) return s;
      return enter(s, 'transcribing', e.now, { recordedMs: Math.max(0, e.durationMs) });
    case 'transcribed': {
      if (s.phase !== 'transcribing' || e.sessionId !== s.sessionId) return s;
      if (s.kind === 'meeting') return enter(s, 'done', e.now, { error: null, failedIn: null });
      return enter(s, 'review', e.now, { text: appendTranscript(s.text, e.text), error: null, failedIn: null });
    }
    case 'edit':
      if (isBusy(s) && s.phase !== 'recording' && s.phase !== 'transcribing') return s;
      return { ...s, text: e.text };
    case 'send':
      if (s.phase !== 'idle' && s.phase !== 'review' && s.phase !== 'error' && s.phase !== 'done') return s;
      return enter(s, 'sending', e.now, { error: null, failedIn: null, kind: s.kind ?? 'message' });
    case 'sent':
      if (s.phase !== 'sending') return s;
      return enter(s, 'done', e.now, { text: '', error: null, failedIn: null });
    case 'fail':
      if (!isBusy(s)) return s;
      if (e.sessionId !== undefined && e.sessionId !== s.sessionId) return s;
      // A failed send keeps the message in review so nothing typed is lost.
      if (s.phase === 'sending') return enter(s, 'review', e.now, { error: e.error, failedIn: 'sending' });
      return fail(s, e.error, e.now);
    case 'retry':
      if (s.phase !== 'error') return s;
      // Only a failed transcription is worth repeating as-is: the WAVs are on
      // disk. A capture that failed to open or to stop has nothing to retry,
      // so "Try again" clears the error and the user records afresh.
      if (s.failedIn === 'transcribing') return enter(s, 'transcribing', e.now, { error: null, failedIn: null });
      return enter(s, 'idle', e.now, { error: null, failedIn: null, sessionId: null, kind: null });
    case 'cancel':
      if (s.phase === 'idle') return s;
      return enter(s, 'idle', e.now, {
        sessionId: null,
        startedAt: null,
        error: null,
        failedIn: null,
        autoStopped: false,
        kind: null
      });
    case 'discard':
      return { ...initialFlow(e.now) };
    case 'tick': {
      const limit = phaseTimeout(s);
      if (limit !== undefined && e.now - s.since > limit) {
        if (s.phase === 'sending') return enter(s, 'review', e.now, { error: TIMEOUT_ERROR, failedIn: 'sending' });
        return fail(s, TIMEOUT_ERROR, e.now);
      }
      if (s.phase === 'recording' && s.kind && s.startedAt !== null && e.now - s.startedAt >= MAX_RECORDING_MS[s.kind]) {
        return enter(s, 'stopping', e.now, { autoStopped: true });
      }
      if (s.phase === 'done' && e.now - s.since >= DONE_LINGER_MS) {
        return enter(s, 'idle', e.now, { kind: null, sessionId: null, startedAt: null, autoStopped: false });
      }
      return s;
    }
    default:
      return s;
  }
}

/** Elapsed recording time for the meter, in ms. */
export function elapsedMs(s: FlowState, now: number): number {
  if (s.startedAt === null) return 0;
  if (s.phase === 'recording') return Math.max(0, now - s.startedAt);
  return 0;
}
