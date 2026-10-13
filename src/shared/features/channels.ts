/**
 * IPC channel names for the feature layer.
 *
 * CONVENTION: every feature channel is `feat:<unit>:<action>`, where <unit> is
 * the main-process module name (stapler, transcribe, dictate, sidebar, agents,
 * orchestrator, tasks, inbox, automations, memory, capabilities). Push channels
 * (main → renderer) name the thing that changed (`feat:stapler:state`). A unit
 * declares its own channel strings in its own files; `featChannel` exists so a
 * typo'd prefix is impossible, not to centralise them.
 *
 * The bridge channels below are foundation-owned: the four `feat:<x>` names
 * without a unit are the renderer↔main seam every unit shares.
 */
export const FEAT_BRIDGE = {
  /** main → app renderer: a DeliverRequest to run through deliverToAgent. */
  deliver: 'feat:deliver',
  /** main → app renderer: a WorkspaceRoute to navigate to. */
  navigate: 'feat:navigate',
  /** app renderer → main (send): the RosterEntry[] snapshot. */
  roster: 'feat:roster',
  /** app renderer → main (invoke): the bridge is subscribed; returns what was
   *  queued while no renderer was listening. */
  ready: 'feat:bridge:ready',
  /** any renderer → main (invoke): the cached roster. */
  rosterGet: 'feat:bridge:roster',
  /** main → feature windows: the roster changed. */
  rosterChanged: 'feat:bridge:rosterChanged',
  /** feature renderer → main (invoke): deliver on my behalf. */
  deliverRequest: 'feat:bridge:deliver',
  /** feature renderer → main (invoke): navigate the main window. */
  navigateRequest: 'feat:bridge:navigate'
} as const;

/** `feat:<unit>:<action>`. */
export function featChannel(unit: string, action: string): string {
  return `feat:${unit}:${action}`;
}
