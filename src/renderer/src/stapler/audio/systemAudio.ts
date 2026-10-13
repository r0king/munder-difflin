/**
 * How to get "Them" — the other side of a call — on this machine (pure).
 *
 *   Windows        getDisplayMedia loopback (main answers the request).
 *   macOS 13+      the same, through ScreenCaptureKit; needs Screen & System
 *                  Audio Recording permission. Fallback: an input device the
 *                  user picked (BlackHole, Loopback…).
 *   Linux          a PulseAudio/PipeWire "Monitor of …" source, which Chromium
 *                  lists as an ordinary audio input. Else a chosen device.
 *   Anything else  a chosen device, or mic only with a notice.
 *
 * A device the user picked always wins: they chose it for a reason (a virtual
 * cable with just the call in it, say).
 */
import type { SystemAudioMode } from '../../../../shared/features/transcribe';

export interface AudioInput {
  deviceId: string;
  label: string;
}

export type SystemPlan =
  | { kind: 'device'; deviceId: string; label: string }
  | { kind: 'monitor'; deviceId: string; label: string }
  | { kind: 'loopback' }
  | { kind: 'none'; notice: SystemNotice };

/** Why there is no system audio (each has a user-facing explanation). */
export type SystemNotice =
  | 'device-missing'   // the chosen device is not connected
  | 'no-monitor'       // Linux: no monitor source found
  | 'unsupported';     // no loopback on this platform and no device chosen

/** PulseAudio/PipeWire monitor sources, as Chromium labels them. */
export function isMonitorLabel(label: string): boolean {
  return /^monitor of /i.test(label.trim()) || /\.monitor$/i.test(label.trim());
}

export function planSystemAudio(opts: {
  mode: SystemAudioMode;
  chosenDeviceId: string;
  inputs: readonly AudioInput[];
  /** Main armed its loopback handler for this session. */
  loopbackArmed: boolean;
}): SystemPlan {
  const { mode, chosenDeviceId, inputs } = opts;
  if (chosenDeviceId) {
    const dev = inputs.find((d) => d.deviceId === chosenDeviceId);
    if (dev) return { kind: 'device', deviceId: dev.deviceId, label: dev.label };
    // Labels are empty until the page has mic permission; trust the id then.
    if (inputs.every((d) => !d.label)) return { kind: 'device', deviceId: chosenDeviceId, label: '' };
    if (mode === 'loopback' && opts.loopbackArmed) return { kind: 'loopback' };
    return { kind: 'none', notice: 'device-missing' };
  }
  if (mode === 'loopback' && opts.loopbackArmed) return { kind: 'loopback' };
  if (mode === 'monitor') {
    // Prefer the monitor of the default sink when Chromium names it so.
    const monitors = inputs.filter((d) => isMonitorLabel(d.label));
    const pick = monitors.find((d) => /default/i.test(d.label)) ?? monitors[0];
    if (pick) return { kind: 'monitor', deviceId: pick.deviceId, label: pick.label };
    return { kind: 'none', notice: 'no-monitor' };
  }
  return { kind: 'none', notice: 'unsupported' };
}

/** After a loopback attempt fails (no audio track, permission), the
 *  explanation to show. */
export type LoopbackFailure = 'permission' | 'no-audio';

export function loopbackFailure(err: unknown): LoopbackFailure {
  const name = err && typeof err === 'object' && 'name' in err ? String((err as { name: unknown }).name) : '';
  return name === 'NotAllowedError' || name === 'SecurityError' ? 'permission' : 'no-audio';
}
