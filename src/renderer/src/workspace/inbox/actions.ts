/**
 * The Inbox's writes — every one through a path the app already uses.
 *
 *   answerAsk / dismissAsk   the Classic ASK ME path (AskMeTab): the card's
 *                            open humanQA entry on hive/tasks.json, then mail
 *                            to the orchestrator. Here the ledger is RE-READ
 *                            first and the entry located by its question text
 *                            (shared/workspace/inboxAsk.ts), so an answer
 *                            typed against a question the orchestrator has
 *                            since replaced is refused, not misfiled.
 *   replyTo                  the ThreadsPanel reply: `hiveSend` as "human",
 *                            to the sender, in the same conversation.
 */
import type { HumanQA } from '@/components/TasksKanban';
import { refreshHiveTasks } from '../useHiveTasks';
import { answerHumanQA, answerMail, dismissHumanQA, findRawTask } from '@shared/workspace/inboxAsk';
import { replySubject, type InboxMessage } from '@shared/workspace/inboxMessages';
import { addSentMessage } from './mailStore';

export type AskOutcome =
  /** Recorded on the card and the orchestrator told. */
  | { ok: true; notified: boolean }
  /** The question is no longer open on the card (answered elsewhere, dismissed, replaced). */
  | { ok: false; reason: 'changed' }
  /** The ledger could not be read or written. */
  | { ok: false; reason: 'failed' };

async function patchOpenQuestion(
  taskId: string,
  edit: (humanQA: unknown) => unknown[] | null
): Promise<{ ok: true } | { ok: false; reason: 'changed' | 'failed' }> {
  let raw: Record<string, unknown> | null;
  try {
    raw = findRawTask(await window.cth.hiveTasks(), taskId);
  } catch {
    return { ok: false, reason: 'failed' };
  }
  if (!raw) return { ok: false, reason: 'changed' };
  const next = edit(raw.humanQA);
  if (!next) return { ok: false, reason: 'changed' };
  try {
    const res = await window.cth.hivePatchTask(taskId, { humanQA: next as HumanQA[] });
    if (!res?.ok) return { ok: false, reason: 'failed' };
  } catch {
    return { ok: false, reason: 'failed' };
  }
  return { ok: true };
}

export async function answerAsk(task: { id: string; title: string }, question: string, answer: string): Promise<AskOutcome> {
  const text = answer.trim();
  if (!text) return { ok: false, reason: 'failed' };
  const patched = await patchOpenQuestion(task.id, (qa) => answerHumanQA(qa, question, text, new Date().toISOString()));
  if (!patched.ok) return patched;
  // The answer is on the card now; telling the orchestrator is the second
  // half. If only that half fails the card still says what you decided, and
  // the caller says so rather than pretending nothing happened.
  let notified = false;
  try {
    const res = await window.cth.hiveSend(answerMail(task, question, text), 'human');
    notified = !!res?.ok;
    if (res?.message) addSentMessage(res.message);
  } catch { /* notified stays false */ }
  void refreshHiveTasks();
  return { ok: true, notified };
}

/** Clear the ask off the board without answering (the ASK ME ✕). The card
 *  stays blocked; the orchestrator can ask again. */
export async function dismissAsk(task: { id: string }, question: string): Promise<AskOutcome> {
  const patched = await patchOpenQuestion(task.id, (qa) => dismissHumanQA(qa, question, new Date().toISOString()));
  if (!patched.ok) return patched;
  void refreshHiveTasks();
  return { ok: true, notified: false };
}

/** Reply to a message, to its sender, in its conversation. */
export async function replyTo(m: InboxMessage, body: string): Promise<boolean> {
  const text = body.trim();
  if (!text) return false;
  try {
    const res = await window.cth.hiveSend({
      to: m.from,
      act: 'inform',
      conversation: m.conversation,
      in_reply_to: m.id,
      subject: replySubject(m.subject),
      body: text
    }, 'human');
    if (!res?.ok) return false;
    if (res.message) addSentMessage(res.message);
    return true;
  } catch {
    return false;
  }
}
