/**
 * Ask me — writing the human's answer onto a card (owned by the `wsInbox` unit).
 *
 * The Inbox and its bell answer through the SAME path as the Classic ASK ME
 * tab (components/AskMeTab.tsx): the answer is written into the card's open
 * `humanQA` entry on hive/tasks.json, then mailed to the orchestrator with the
 * same subject and body, so the orchestrator cannot tell which surface the
 * human used. What this module adds is the edit itself as a pure function
 * over the RAW `humanQA` array, so:
 *
 *   - unmodelled fields on an entry survive (the god may write more than
 *     q/a/askedAt), because the entry is spread, never rebuilt;
 *   - the answer lands only while the question it was typed against is still
 *     open — re-read the ledger, apply, and a question the god swapped in
 *     underneath you yields `null` instead of your answer on the wrong ask.
 *
 * "Open" is the same predicate as TasksKanban `openQuestion()`: a string `q`
 * with no `a` and no `dismissedAt`. Every open entry carrying the question's
 * text is resolved, as AskMeTab does — a god that appended the same ask twice
 * would otherwise leave the card on the board after it was answered.
 *
 * Pure and import-free (node:test loads it via test/load-ts.cjs).
 */

type Entry = Record<string, unknown>;

const isEntry = (e: unknown): e is Entry => !!e && typeof e === 'object' && !Array.isArray(e);

function isOpen(e: unknown, question: string): e is Entry {
  return isEntry(e) && e.q === question && !e.a && !e.dismissedAt;
}

function resolveOpen(humanQA: unknown, question: string, patch: Entry): unknown[] | null {
  if (!Array.isArray(humanQA) || typeof question !== 'string') return null;
  let hit = false;
  const next = humanQA.map((e) => {
    if (!isOpen(e, question)) return e;
    hit = true;
    return { ...e, ...patch };
  });
  return hit ? next : null;
}

/** `humanQA` with the open `question` answered, or null when that question is
 *  no longer open on the card (answered, dismissed or replaced meanwhile). */
export function answerHumanQA(humanQA: unknown, question: string, answer: string, nowIso: string): unknown[] | null {
  const text = typeof answer === 'string' ? answer.trim() : '';
  if (!text) return null;
  return resolveOpen(humanQA, question, { a: text, answeredAt: nowIso });
}

/** `humanQA` with the open `question` dismissed WITHOUT an answer (the ASK ME
 *  ✕): the entry stays on the card, marked `dismissedAt`, so the history is
 *  kept and the card leaves the board. Null when it is no longer open. */
export function dismissHumanQA(humanQA: unknown, question: string, nowIso: string): unknown[] | null {
  return resolveOpen(humanQA, question, { dismissedAt: nowIso });
}

/** The raw card with this id from a `hive:tasks` reply, or null. */
export function findRawTask(ledger: unknown, id: string): Entry | null {
  const tasks = isEntry(ledger) && Array.isArray(ledger.tasks) ? ledger.tasks : [];
  for (const t of tasks) if (isEntry(t) && t.id === id) return t;
  return null;
}

/** The mail that tells the orchestrator an ask was answered — word for word
 *  what AskMeTab sends, so his handling does not depend on the surface. */
export function answerMail(task: { id: string; title: string }, question: string, answer: string): {
  to: 'god';
  act: 'inform';
  subject: string;
  body: string;
} {
  return {
    to: 'god',
    act: 'inform',
    subject: `HUMAN ANSWER on task "${task.title}"`,
    body: [
      `The human answered the open question on task ${task.id} ("${task.title}"):`,
      `Q: ${question}`,
      `A: ${answer.trim()}`,
      'The answer is also recorded in the card\'s humanQA. Act on it, unblock the card, and continue the work.'
    ].join('\n')
  };
}
