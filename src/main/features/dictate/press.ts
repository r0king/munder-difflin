/**
 * Reading a toggle shortcut as press / hold / release — pure, unit-tested
 * (test/dictate-press.test.cjs).
 *
 * Electron's globalShortcut only reports "pressed". On Windows and X11 a held
 * hotkey keeps firing with the keyboard's auto-repeat; macOS reports it once.
 * So one stream of triggers can mean three things, and the dictation must not
 * stop because the user's finger is still on the key:
 *
 *   - Auto-repeat of a held key: triggers arrive faster than REPEAT_GAP_MS
 *     apart. Ignored. Two of them in a row mark the press as HELD.
 *   - The keyboard's initial repeat delay (250 ms – 1 s): the first repeat
 *     comes late. Anything inside GUARD_MS of the start is ignored for the
 *     same reason (nobody dictates in under a second anyway).
 *   - A fresh press: a trigger after a gap, past the guard — stop.
 *
 * When a press is HELD and the repeats stop, the key was let go: that is the
 * README's "talk, and let go", on the platforms that let us see it. A hold
 * shorter than MIN_HOLD_MS is read as a slow tap instead (the user meant
 * "start"), and the dictation keeps running until the next press.
 */

export const PRESS_TIMING = {
  /** Triggers closer than this are auto-repeat. Slowest common repeat rate is
   *  ~2.5/s (Windows) → 400 ms; X11 can be set to 2/s → 500 ms. */
  REPEAT_GAP_MS: 550,
  /** Ignore every trigger this soon after the start (covers the longest
   *  initial repeat delay, 1 s on Windows). */
  GUARD_MS: 1100,
  /** A held press shorter than this was a slow tap, not hold-to-talk. */
  MIN_HOLD_MS: 1200,
  /** Silence after the last repeat that means "released": three repeat
   *  intervals, clamped. */
  RELEASE_MIN_MS: 300,
  RELEASE_MAX_MS: 1200
} as const;

export interface PressState {
  /** When the starting press landed. */
  startedAt: number;
  /** The last trigger (press or repeat). */
  lastAt: number;
  /** Consecutive auto-repeat intervals seen. */
  repeats: number;
  /** The key is being held (we have seen it repeat). */
  held: boolean;
  /** The most recent repeat interval, to size the release gap. */
  interval: number;
}

export function beginPress(now: number): PressState {
  return { startedAt: now, lastAt: now, repeats: 0, held: false, interval: 0 };
}

export type TriggerAction = 'ignore' | 'stop';

/** A trigger arrived while a dictation is starting or recording. */
export function onTrigger(state: PressState, now: number): { state: PressState; action: TriggerAction } {
  const gap = now - state.lastAt;
  const next: PressState = { ...state, lastAt: now };
  if (gap < PRESS_TIMING.REPEAT_GAP_MS) {
    next.repeats = state.repeats + 1;
    next.interval = gap;
    if (next.repeats >= 2) next.held = true;
    return { state: next, action: 'ignore' };
  }
  if (now - state.startedAt < PRESS_TIMING.GUARD_MS) return { state: next, action: 'ignore' };
  // A fresh press. Whatever came before, the user pressed again to stop.
  return { state: { ...next, repeats: 0 }, action: 'stop' };
}

/** How long the repeats may pause before the key counts as released. */
export function releaseGap(state: PressState): number {
  const base = state.interval > 0 ? state.interval * 3 : PRESS_TIMING.RELEASE_MIN_MS;
  return Math.min(PRESS_TIMING.RELEASE_MAX_MS, Math.max(PRESS_TIMING.RELEASE_MIN_MS, base));
}

export type ReleaseVerdict =
  /** Not held, or still repeating. */
  | 'keep'
  /** Held long enough and let go: stop and type. */
  | 'stop'
  /** Let go after a short hold: it was a slow tap — keep recording, wait for
   *  the next press. The returned state has `held` cleared. */
  | 'toggle';

/** Poll this while recording (every ~100 ms). */
export function checkRelease(state: PressState, now: number): { state: PressState; verdict: ReleaseVerdict } {
  if (!state.held) return { state, verdict: 'keep' };
  if (now - state.lastAt <= releaseGap(state)) return { state, verdict: 'keep' };
  const heldFor = state.lastAt - state.startedAt;
  if (heldFor < PRESS_TIMING.MIN_HOLD_MS) {
    return { state: { ...state, held: false, repeats: 0, interval: 0 }, verdict: 'toggle' };
  }
  return { state, verdict: 'stop' };
}
