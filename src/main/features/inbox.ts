/**
 * Inbox — main-process side (owned by the `wsInbox` unit).
 *
 * Ask me (tasks waiting on the human — humanQA on hive/tasks.json),
 * Everyone (hiveMessages / onHiveMessage), Outside (listTriggerHistory /
 * decideTriggerHistory / onTriggerHistoryUpdated for webhooks and Slack).
 *
 * Channels: feat:inbox:<action>. FOUNDATION STUB: registers nothing yet.
 */
import type { FeatureModule } from './types';

export const inboxFeature: FeatureModule = {
  name: 'inbox',
  register(ctx) {
    void ctx;
    // TODO(inbox): register feat:inbox:* ipcMain handlers here.
  }
};
