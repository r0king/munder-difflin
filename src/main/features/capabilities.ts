/**
 * Capabilities, Temps and role bundles — main-process side (owned by the `wsCapabilities` unit).
 *
 * Skills: skillsLocal / skillsCatalog / skillsInstall / skillsUninstall.
 * Connections: integrationsList / integrationsUpsert / integrationsSetSecret
 * (write-only secrets). MCP defaults: config.mcpDefaults. Temps build on
 * the ephemeral workers: listWorkers / stopWorker.
 *
 * Channels: feat:capabilities:<action>. FOUNDATION STUB: registers nothing yet.
 */
import type { FeatureModule } from './types';

export const capabilitiesFeature: FeatureModule = {
  name: 'capabilities',
  register(ctx) {
    void ctx;
    // TODO(capabilities): register feat:capabilities:* ipcMain handlers here.
  }
};
