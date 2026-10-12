/**
 * Automations — main-process side (owned by the `wsAutomations` unit).
 *
 * Schedules are config.missions (listMissions / saveMissions /
 * onMissionsUpdated), context rules getContextTrigger / setContextTrigger,
 * webhooks listWebhooks / saveWebhooks / webhooksStatus.
 *
 * Channels: feat:automations:<action>. FOUNDATION STUB: registers nothing yet.
 */
import type { FeatureModule } from './types';

export const automationsFeature: FeatureModule = {
  name: 'automations',
  register(ctx) {
    void ctx;
    // TODO(automations): register feat:automations:* ipcMain handlers here.
  }
};
