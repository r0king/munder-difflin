/**
 * Workspace sidebar — main-process side (owned by the `wsSidebar` unit).
 *
 * Anything the sidebar needs from main that no existing IPC serves (e.g. a
 * persisted agent/project order shared across floors). Most of what the
 * sidebar shows already has an API: the roster is in the renderer store,
 * tasks via window.cth.hiveTasks(), notes via the store's setAgentNote.
 *
 * Channels: feat:sidebar:<action>. FOUNDATION STUB: registers nothing yet.
 */
import type { FeatureModule } from './types';

export const sidebarFeature: FeatureModule = {
  name: 'sidebar',
  register(ctx) {
    void ctx;
    // TODO(sidebar): register feat:sidebar:* ipcMain handlers here.
  }
};
