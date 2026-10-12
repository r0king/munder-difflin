/**
 * Memory — main-process side (owned by the `wsMemory` unit).
 *
 * Exact search: window.cth.textSearch; by meaning: searchMemory
 * (MemPalace); per-agent notes: hiveMemory; the knowledge graph: kg*.
 *
 * Channels: feat:memory:<action>. FOUNDATION STUB: registers nothing yet.
 */
import type { FeatureModule } from './types';

export const memoryFeature: FeatureModule = {
  name: 'memory',
  register(ctx) {
    void ctx;
    // TODO(memory): register feat:memory:* ipcMain handlers here.
  }
};
