/**
 * Tasks board — main-process side (owned by the `wsTasks` unit).
 *
 * The ledger is hive/tasks.json: window.cth.hiveTasks / hiveAddTask /
 * hivePatchTask / hiveDeleteTask already cover reads and edits, and
 * src/shared/taskLedger.ts holds the non-destructive merge rules.
 *
 * Channels: feat:tasks:<action>. FOUNDATION STUB: registers nothing yet.
 */
import type { FeatureModule } from './types';

export const tasksFeature: FeatureModule = {
  name: 'tasks',
  register(ctx) {
    void ctx;
    // TODO(tasks): register feat:tasks:* ipcMain handlers here.
  }
};
