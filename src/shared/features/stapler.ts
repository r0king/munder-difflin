/**
 * Stapler state as seen by every window (the titlebar toggle, the sidebar row,
 * the puck itself). Placeholder shape — the `stapler` unit owns it and may add
 * fields; keep the three below, other units read them.
 */
export interface StaplerState {
  /** The puck is shown (the titlebar toggle). */
  enabled: boolean;
  /** Excluded from screen shares and recordings (content protection). */
  invisible: boolean;
  /** What, if anything, is recording right now. */
  recording: null | 'message' | 'meeting' | 'dictation';
}

export const DEFAULT_STAPLER_STATE: StaplerState = {
  enabled: false,
  invisible: false,
  recording: null
};
