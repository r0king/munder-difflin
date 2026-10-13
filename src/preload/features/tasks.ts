/**
 * `window.cth.features.tasks` — owned by the `wsTasks` unit. The Tasks board.
 *
 * Add members here and nowhere else; the object is spread into the bridge as
 * is, so its type IS the renderer's type. Invoke channels are
 * `feat:tasks:<action>`.
 *
 * Reading and writing the ledger itself stays on the existing hive bridge
 * (hiveTasks / hiveAddTask); this adds what only main can know.
 */
import { ipcRenderer } from 'electron';
import type { TasksActivityReply } from '../../shared/workspace/tasks';

export const tasksApi = {
  /** When each card last changed and entered its column, as main has observed
   *  the ledger, plus the hive folder's ticket key. Re-reads the ledger unless
   *  it did so in the last couple of seconds. */
  activity: (): Promise<TasksActivityReply> => ipcRenderer.invoke('feat:tasks:activity')
};
