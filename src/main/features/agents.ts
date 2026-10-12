/**
 * Agent cards + agent rooms — main-process side (owned by the `wsAgents` unit).
 *
 * Existing APIs first: window.cth.controlPause/controlHalt/controlSteer
 * (pause tools, stop after this step, steer), hiveSetAgentHold (1:1),
 * setAgentTokenCap, agentUsage/telemetryUsage (spend), hivePatchAgentRole.
 *
 * Channels: feat:agents:<action>. FOUNDATION STUB: registers nothing yet.
 */
import type { FeatureModule } from './types';

export const agentsFeature: FeatureModule = {
  name: 'agents',
  register(ctx) {
    void ctx;
    // TODO(agents): register feat:agents:* ipcMain handlers here.
  }
};
