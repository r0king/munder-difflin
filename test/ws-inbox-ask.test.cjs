'use strict';

// Inbox (wsInbox) — answering an Ask me question on the RAW humanQA array:
// the answer lands only on the question it was typed against, unmodelled
// fields survive, and the orchestrator gets the same mail AskMeTab sends.

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { answerHumanQA, dismissHumanQA, findRawTask, answerMail, countBlockedBehind } = loadTs('src/shared/workspace/inboxAsk.ts');

const NOW = '2026-10-12T10:00:00.000Z';

test('the open question is answered and the history kept', () => {
  const qa = [
    { q: 'Old?', a: 'yes', askedAt: '2026-10-01T00:00:00Z', answeredAt: '2026-10-01T01:00:00Z' },
    { q: 'Which logo?', askedAt: '2026-10-11T00:00:00Z', source: 'angela' }
  ];
  const next = answerHumanQA(qa, 'Which logo?', '  logo.svg  ', NOW);
  assert.deepEqual(next, [
    qa[0],
    { q: 'Which logo?', askedAt: '2026-10-11T00:00:00Z', source: 'angela', a: 'logo.svg', answeredAt: NOW }
  ]);
  assert.equal(qa[1].a, undefined, 'the input is not mutated');
});

test('a question that is no longer open is never answered', () => {
  const answered = [{ q: 'Which logo?', a: 'logo.svg' }];
  assert.equal(answerHumanQA(answered, 'Which logo?', 'other', NOW), null);
  const dismissed = [{ q: 'Which logo?', dismissedAt: NOW }];
  assert.equal(answerHumanQA(dismissed, 'Which logo?', 'other', NOW), null);
  const swapped = [{ q: 'Which font?' }];
  assert.equal(answerHumanQA(swapped, 'Which logo?', 'logo.svg', NOW), null, 'the god swapped the question in');
});

test('every open copy of the same question is resolved, as AskMeTab does', () => {
  const qa = [{ q: 'Ship?' }, { q: 'Ship?' }];
  const next = answerHumanQA(qa, 'Ship?', 'yes', NOW);
  assert.ok(next.every((e) => e.a === 'yes'));
});

test('an empty answer, a non-array or junk entries are handled', () => {
  assert.equal(answerHumanQA([{ q: 'x' }], 'x', '   ', NOW), null);
  assert.equal(answerHumanQA(undefined, 'x', 'a', NOW), null);
  const next = answerHumanQA([null, 'junk', { q: 'x' }], 'x', 'a', NOW);
  assert.deepEqual(next, [null, 'junk', { q: 'x', a: 'a', answeredAt: NOW }]);
});

test('dismiss marks the entry without inventing an answer', () => {
  const next = dismissHumanQA([{ q: 'x', askedAt: 't' }], 'x', NOW);
  assert.deepEqual(next, [{ q: 'x', askedAt: 't', dismissedAt: NOW }]);
  assert.equal(dismissHumanQA([{ q: 'x', a: 'done' }], 'x', NOW), null);
});

test('findRawTask reads a hive:tasks reply defensively', () => {
  const ledger = { tasks: [null, { id: 'a' }, { id: 'b', slack: { channel: 'C' } }] };
  assert.deepEqual(findRawTask(ledger, 'b'), { id: 'b', slack: { channel: 'C' } });
  assert.equal(findRawTask(ledger, 'zzz'), null);
  assert.equal(findRawTask(null, 'a'), null);
  assert.equal(findRawTask({ tasks: 'nope' }, 'a'), null);
});

test('the orchestrator mail matches the Classic ASK ME wording', () => {
  const mail = answerMail({ id: 'bmt-17', title: 'Swap the logo' }, 'Which logo?', ' logo.svg ');
  assert.equal(mail.to, 'god');
  assert.equal(mail.act, 'inform');
  assert.equal(mail.subject, 'HUMAN ANSWER on task "Swap the logo"');
  assert.equal(mail.body, [
    'The human answered the open question on task bmt-17 ("Swap the logo"):',
    'Q: Which logo?',
    'A: logo.svg',
    'The answer is also recorded in the card\'s humanQA. Act on it, unblock the card, and continue the work.'
  ].join('\n'));
});

test('countBlockedBehind follows the dependents chain, skips done, survives cycles', () => {
  const cards = [
    { id: 'a', status: 'blocked' },
    { id: 'b', status: 'todo', dependsOn: ['a'] },
    { id: 'c', status: 'todo', dependsOn: ['b'] },
    { id: 'd', status: 'done', dependsOn: ['a'] },
    { id: 'e', status: 'todo' },
    { id: 'x', status: 'todo', dependsOn: ['y'] },
    { id: 'y', status: 'todo', dependsOn: ['x'] }
  ];
  assert.equal(countBlockedBehind('a', cards), 2);
  assert.equal(countBlockedBehind('e', cards), 0);
  assert.equal(countBlockedBehind('x', cards), 1, 'a cycle counts each card once');
});
