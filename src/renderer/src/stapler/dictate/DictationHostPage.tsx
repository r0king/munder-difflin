/**
 * The hidden recorder window's page (stapler.html#dictate), owned by the
 * `dictate` unit. Main creates the window (main/features/dictate/host.ts),
 * never shows it, and drives it with commands:
 *
 *   start  → open the mic through the transcribe unit's capture (audio/capture.ts)
 *   stop   → write the WAV and hand its path back; main transcribes it
 *   cancel → throw the recording away
 *   notify → show a system notification, worded here because this window has
 *            the user's language and main does not
 *
 * Every reply carries the run's token, so a late answer from a cancelled run
 * cannot be mistaken for the current one. Nothing is rendered.
 */
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { DictateHostCommand, DictateHostEvent } from '@shared/features/dictate';
import { startCapture, type CaptureHandle } from '../audio/capture';

interface ActiveRun {
  token: number;
  handle: CaptureHandle | null;
  offLevel: (() => void) | null;
  stopRequested: boolean;
  cancelled: boolean;
}

/** Levels go to the puck ~10×/s; more is IPC for nothing. */
const LEVEL_INTERVAL_MS = 100;

function failureCode(e: unknown): Extract<DictateHostEvent, { type: 'failed' }>['code'] {
  const name = e && typeof e === 'object' && 'name' in e ? String((e as { name: unknown }).name) : '';
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') return 'mic-denied';
  if (name === 'NotFoundError' || name === 'NotReadableError' || name === 'OverconstrainedError' || name === 'AbortError') {
    return 'mic-unavailable';
  }
  return 'capture-failed';
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e ?? '');
}

export function DictationHostPage(): null {
  const { t } = useTranslation();
  const tRef = useRef(t);
  tRef.current = t;

  useEffect(() => {
    const api = window.cth.features.dictate;
    let active: ActiveRun | null = null;
    const send = (evt: DictateHostEvent): void => api.host.event(evt);

    const finish = async (run: ActiveRun): Promise<void> => {
      if (!run.handle) { run.stopRequested = true; return; }
      run.offLevel?.();
      run.offLevel = null;
      let res;
      try {
        res = await run.handle.stop();
      } catch (e) {
        res = { ok: false, durationMs: 0, error: message(e) };
      }
      if (active === run) active = null;
      if (run.cancelled) return;
      if (res.ok && res.micWav) send({ type: 'captured', token: run.token, wavPath: res.micWav, durationMs: res.durationMs });
      else send({ type: 'failed', token: run.token, code: 'capture-failed', detail: res.error });
    };

    const discard = (run: ActiveRun): void => {
      run.cancelled = true;
      run.offLevel?.();
      run.offLevel = null;
      if (active === run) active = null;
      if (run.handle) run.handle.cancel().catch(() => { /* already gone */ });
    };

    const begin = async (token: number, sessionId: string): Promise<void> => {
      if (active) discard(active); // main moved on; that run is dead
      const run: ActiveRun = { token, handle: null, offLevel: null, stopRequested: false, cancelled: false };
      active = run;
      let handle: CaptureHandle;
      try {
        handle = await startCapture({ sessionId, mic: true, system: false });
      } catch (e) {
        if (active === run) active = null;
        if (!run.cancelled) send({ type: 'failed', token, code: failureCode(e), detail: message(e) });
        return;
      }
      if (run.cancelled) { handle.cancel().catch(() => {}); return; }
      run.handle = handle;
      let lastLevelAt = 0;
      run.offLevel = handle.onLevel((levels) => {
        const now = performance.now();
        if (now - lastLevelAt < LEVEL_INTERVAL_MS) return;
        lastLevelAt = now;
        send({ type: 'level', token, level: levels.mic });
      });
      send({ type: 'started', token });
      if (run.stopRequested) void finish(run);
    };

    const showNotification = (title: string, body: string, params: Record<string, string>): void => {
      try {
        // eslint-disable-next-line no-new
        new Notification(tRef.current(title, params), { body: tRef.current(body, params), silent: true });
      } catch { /* notifications unavailable */ }
    };

    const onCommand = (cmd: DictateHostCommand): void => {
      switch (cmd.cmd) {
        case 'start':
          void begin(cmd.token, cmd.sessionId);
          return;
        case 'stop':
          if (active && active.token === cmd.token) void finish(active);
          return;
        case 'cancel':
          if (active && active.token === cmd.token) discard(active);
          return;
        case 'notify':
          showNotification(cmd.title, cmd.body, cmd.params ?? {});
          return;
      }
    };

    const off = api.host.onCommand(onCommand);
    void api.host.ready();
    return () => {
      off();
      if (active) discard(active);
    };
  }, []);

  return null;
}
