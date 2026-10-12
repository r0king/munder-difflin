/**
 * Stapler — main-process side (owned by the `stapler` unit).
 *
 * The floating puck window, its ring (screenshot region, record message,
 * record meeting, make invisible), the screenshot overlay window, the meetings
 * library on disk, and the Stapler's global shortcuts all live here.
 *
 * FOUNDATION STUB: only the state contract the titlebar toggle depends on is
 * wired. `setEnabled` is accepted and answered, but the puck does not exist
 * yet, so `enabled` stays false and the toggle reads off — a no-op, not a lie.
 *
 * Channels: feat:stapler:getState, feat:stapler:setEnabled (invoke),
 *           feat:stapler:state (push, every window).
 */
import { ipcMain } from 'electron';
import { DEFAULT_STAPLER_STATE, type StaplerState } from '../../shared/features/stapler';
import type { FeatureContext, FeatureModule } from './types';

let state: StaplerState = { ...DEFAULT_STAPLER_STATE };

function publish(ctx: FeatureContext): StaplerState {
  ctx.broadcastAll('feat:stapler:state', state);
  return state;
}

export const staplerFeature: FeatureModule = {
  name: 'stapler',
  register(ctx) {
    ipcMain.handle('feat:stapler:getState', (): StaplerState => state);
    ipcMain.handle('feat:stapler:setEnabled', (_evt, on: unknown): StaplerState => {
      if (typeof on !== 'boolean') return state;
      // TODO(stapler): create/destroy the puck window and persist the choice
      // (ctx.writeFeatureSettings('stapler', …)), then set `enabled: on`.
      state = { ...state, enabled: false };
      return publish(ctx);
    });
  }
};
