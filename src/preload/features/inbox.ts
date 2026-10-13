/**
 * `window.cth.features.inbox` — owned by the `wsInbox` unit. The Inbox.
 *
 * Only the floor's mail and the read watermarks are new here; Ask me and
 * Outside ride bridges that already exist (`hiveTasks` / `hivePatchTask` /
 * `hiveSend`, `listTriggerHistory` / `decideTriggerHistory` /
 * `onTriggerHistoryUpdated`). See src/main/features/inbox.ts.
 */
import { ipcRenderer, type IpcRendererEvent } from 'electron';
import {
  INBOX_CHANNELS,
  type InboxMessagesReply,
  type InboxMessagesRequest,
  type MarkReadReply,
  type ReadMarkEntry,
  type ReadMarksReply
} from '../../shared/workspace/inboxChannels';

export const inboxApi = {
  /** Every routed message on the floor, newest first, redacted in main. */
  messages: (opts?: InboxMessagesRequest): Promise<InboxMessagesReply> =>
    ipcRenderer.invoke(INBOX_CHANNELS.messages, opts ?? {}),
  /** This hive's read watermarks, by section key. */
  readMarks: (): Promise<ReadMarksReply> => ipcRenderer.invoke(INBOX_CHANNELS.readMarks),
  /** Move watermarks forward (never back). Returns the merged marks. */
  markRead: (entries: ReadMarkEntry[]): Promise<MarkReadReply> =>
    ipcRenderer.invoke(INBOX_CHANNELS.markRead, entries),
  /** Another window (or this one) marked something read. */
  onReadMarks: (cb: (reply: ReadMarksReply) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, reply: ReadMarksReply) => cb(reply);
    ipcRenderer.on(INBOX_CHANNELS.readMarksChanged, listener);
    return () => ipcRenderer.removeListener(INBOX_CHANNELS.readMarksChanged, listener);
  }
};
