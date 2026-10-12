/**
 * `window.cth.features.stapler` — owned by the `stapler` unit.
 *
 * The three members below are the contract the titlebar toggle and the
 * Workspace sidebar build against; keep their shapes. Add the puck's own calls
 * (ring actions, screenshot, recordings, meetings library) beside them.
 */
import { ipcRenderer, type IpcRendererEvent } from 'electron';
import type { StaplerState } from '../../shared/features/stapler';

export const staplerApi = {
  getState: (): Promise<StaplerState> => ipcRenderer.invoke('feat:stapler:getState'),
  /** Show or hide the puck. Resolves with the state main settled on, which is
   *  what a toggle should render (it may refuse). */
  setEnabled: (on: boolean): Promise<StaplerState> => ipcRenderer.invoke('feat:stapler:setEnabled', on),
  /** Every state change, in every window. Returns the unsubscribe function. */
  onState: (cb: (state: StaplerState) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, state: StaplerState) => cb(state);
    ipcRenderer.on('feat:stapler:state', listener);
    return () => ipcRenderer.removeListener('feat:stapler:state', listener);
  }
};
