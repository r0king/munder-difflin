'use strict';

// What a Workspace agent card says: the latest update in the agent's own words
// (newest of its reply and its last message, else the live line), the ticket
// it shows, the open question, and the one-move "Add a ticket".

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const {
  plainPreview,
  pickLatestUpdate,
  toolLineFromAction,
  formatToolLine,
  pickCurrentTicket,
  openAskFor,
  buildTicket,
  ticketBriefing,
  contextPercent,
  contextTone,
  formatUsd
} = loadTs('src/shared/workspace/agentsSummary.ts');

test('plainPreview reduces markdown to one readable line', () => {
  assert.equal(plainPreview('## Done\n\n**Fixed** the `login` test. See [PR](https://x).'), 'Done');
  assert.equal(plainPreview('```js\ncode\n```\n\n- [x] Ran *all* tests'), 'Ran all tests');
  assert.equal(plainPreview('| a | b |\n|---|---|\n\nAfter the table.'), 'After the table.');
  assert.equal(plainPreview(''), '');
  assert.equal(plainPreview('---\n\n```\nonly code\n```'), '');
  const long = plainPreview('word '.repeat(100), 40);
  assert.ok(long.length <= 41 && long.endsWith('…'), long);
});

test('plainPreview keeps CJK and Arabic text', () => {
  assert.equal(plainPreview('**修复**了登录测试'), '修复了登录测试');
  assert.equal(plainPreview('تم إصلاح الاختبار'), 'تم إصلاح الاختبار');
});

test('latest update: the newer of reply and mail, else the live line', () => {
  const reply = { text: 'Running the login tests again.', ts: 200 };
  const mail = { subject: 'Re: logo', body: 'Asks which of two logos is current.', to: 'god', ts: 100 };
  assert.deepEqual(pickLatestUpdate({ agentId: 'a', lastReply: reply, lastMail: mail }, 'Idle'),
    { text: 'Running the login tests again.', source: 'reply', ts: 200 });
  assert.deepEqual(pickLatestUpdate({ agentId: 'a', lastReply: { ...reply, ts: 50 }, lastMail: mail }, 'Idle'),
    { text: 'Asks which of two logos is current.', source: 'mail', ts: 100 });
  assert.deepEqual(pickLatestUpdate(undefined, 'Working'), { text: 'Working', source: 'live' });
  assert.deepEqual(pickLatestUpdate({ agentId: 'a', lastReply: { text: '```\n```', ts: 9 } }, 'Idle'), { text: 'Idle', source: 'live' });
});

test('latest update: a sentence-like subject wins over the body', () => {
  const mail = { subject: 'Shipped the onboarding screens', body: 'long body', to: 'god', ts: 1 };
  assert.equal(pickLatestUpdate({ agentId: 'a', lastMail: mail }, '').text, 'Shipped the onboarding screens');
});

test('tool line from the store action (non-Claude engines)', () => {
  assert.deepEqual(toolLineFromAction('bash npm test auth/login'), { tool: 'Bash', text: 'npm test auth/login' });
  assert.deepEqual(toolLineFromAction('read SPEC.md'), { tool: 'Read', text: 'SPEC.md' });
  assert.deepEqual(toolLineFromAction('using WebFetch'), { tool: 'WebFetch', text: '' });
  assert.equal(toolLineFromAction('idle'), null);
  assert.equal(toolLineFromAction(undefined), null);
  assert.equal(formatToolLine('Bash', 'npm test'), 'npm test');
  assert.equal(formatToolLine('Read', 'a.ts'), 'Read a.ts');
  assert.equal(formatToolLine('WebFetch', ''), 'WebFetch');
});

const tasks = [
  { id: 'bmt-1', title: 'Old todo', assignee: 'dwight', status: 'todo', createdAt: '2026-10-01T00:00:00Z' },
  { id: 'bmt-2', title: 'Blocked', assignee: 'dwight', status: 'blocked', createdAt: '2026-10-02T00:00:00Z', humanQA: [{ q: 'Which logo?', askedAt: '2026-10-02T01:00:00Z' }] },
  { id: 'bmt-3', title: 'Doing', assignee: 'dwight', status: 'doing', createdAt: '2026-10-03T00:00:00Z' },
  { id: 'bmt-4', title: 'Done', assignee: 'dwight', status: 'done', createdAt: '2026-10-04T00:00:00Z' },
  { id: 'bmt-5', title: 'Not his', assignee: 'jim', status: 'doing' }
];

test('current ticket: doing, then blocked, then todo; never done', () => {
  assert.deepEqual(pickCurrentTicket(tasks, 'dwight'), { id: 'bmt-3', title: 'Doing', status: 'doing' });
  assert.deepEqual(pickCurrentTicket(tasks.filter((t) => t.id !== 'bmt-3'), 'dwight').id, 'bmt-2');
  assert.equal(pickCurrentTicket([tasks[3]], 'dwight'), null);
  assert.equal(pickCurrentTicket([], 'x'), null);
});

test('open ask: newest unanswered question on its blocked cards', () => {
  assert.deepEqual(openAskFor(tasks, 'dwight'), { taskId: 'bmt-2', taskTitle: 'Blocked', q: 'Which logo?', askedAt: '2026-10-02T01:00:00Z' });
  const answered = [{ ...tasks[1], humanQA: [{ q: 'x', a: 'y' }] }];
  assert.equal(openAskFor(answered, 'dwight'), null);
  const dismissed = [{ ...tasks[1], humanQA: [{ q: 'x', dismissedAt: 'now' }] }];
  assert.equal(openAskFor(dismissed, 'dwight'), null);
  // Same rule as the ASK ME board: only a BLOCKED card waits on you.
  const notBlocked = [{ ...tasks[1], status: 'doing' }];
  assert.equal(openAskFor(notBlocked, 'dwight'), null);
  assert.equal(openAskFor(tasks, 'jim'), null);
});

test('buildTicket: one line in, a todo card assigned to the agent out', () => {
  const now = new Date('2026-10-12T10:00:00Z');
  const t = buildTicket('  Fix the   flaky login test ', 'dwight', 'bmt-13', now);
  assert.deepEqual(t, {
    id: 'bmt-13', title: 'Fix the flaky login test', assignee: 'dwight', status: 'todo',
    dependsOn: [], priority: 3, createdAt: '2026-10-12T10:00:00.000Z'
  });
  assert.equal(buildTicket('   ', 'dwight', 'x', now), null);
  const long = buildTicket('a'.repeat(300), 'dwight', 'x', now);
  assert.equal(long.title.length, 200);
  assert.equal(long.description.length, 300);
  const brief = ticketBriefing(t);
  assert.match(brief, /bmt-13 — Fix the flaky login test/);
  assert.match(brief, /assigned to you/);
});

test('context percent and tone', () => {
  assert.equal(contextPercent(62_000, 100_000), 62);
  assert.equal(contextPercent(5, 0), null);
  assert.equal(contextPercent(undefined, 10), null);
  assert.equal(contextPercent(2_000_000, 1_000_000), 100);
  assert.equal(contextTone(null), 'ok');
  assert.equal(contextTone(75), 'warn');
  assert.equal(contextTone(90), 'danger');
});

test('formatUsd', () => {
  assert.equal(formatUsd(0.42, 'en-US'), '$0.42');
  assert.equal(formatUsd(0.001, 'en-US'), '<$0.01');
  assert.equal(formatUsd(0, 'en-US'), '$0.00');
  assert.equal(formatUsd(1204.4, 'en-US'), '$1,204');
  assert.equal(formatUsd(undefined), null);
  assert.equal(formatUsd(NaN), null);
});
