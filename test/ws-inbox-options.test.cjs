'use strict';

// Inbox (wsInbox) — quick replies: the options a question CLEARLY enumerates.
// The bar is "clearly": a list of STEPS must not turn into answer buttons.

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { extractOptions, optionLabel, MAX_OPTIONS } = loadTs('src/shared/workspace/inboxOptions.ts');

test('a bold ask followed by a bullet list of options', () => {
  const q = [
    '**Which logo is current?**',
    '',
    '- `logo.svg`',
    '- `logo_old.svg`'
  ].join('\n');
  assert.deepEqual(extractOptions(q), ['logo.svg', 'logo_old.svg']);
});

test('numbered options with explanations are labelled by their lead', () => {
  const q = [
    '**Should I ship the release tonight?** Pick one:',
    '1. **Ship now** — the flaky test is quarantined',
    '2. **Hold** until Dwight fixes the cookie',
    '3. **Ship a beta**: tag it, no announcement'
  ].join('\n');
  assert.deepEqual(extractOptions(q), ['Ship now', 'Hold', 'Ship a beta']);
});

test('a loose list (blank lines between items) still counts', () => {
  const q = 'Which database do you prefer?\n\n- Postgres\n\n- SQLite\n';
  assert.deepEqual(extractOptions(q), ['Postgres', 'SQLite']);
});

test('lettered options', () => {
  const q = 'Choose an approach:\nA) Rewrite the parser\nB) Patch the regex';
  assert.deepEqual(extractOptions(q), ['Rewrite the parser', 'Patch the regex']);
});

test('a list of STEPS is not a choice', () => {
  const q = [
    '**Please create the Stripe account for us.**',
    '',
    '1. Sign up at stripe.com with the team address',
    '2. Paste the publishable key into Settings'
  ].join('\n');
  assert.deepEqual(extractOptions(q), []);
});

test('inline alternatives in code or bold, joined by "or"', () => {
  assert.deepEqual(extractOptions('Should I use `logo.svg` or `logo_old.svg`?'), ['logo.svg', 'logo_old.svg']);
  assert.deepEqual(extractOptions('**Ship** or **hold**?'), ['Ship', 'hold']);
  assert.deepEqual(extractOptions('Deploy to `staging`, `canary` or `prod`?'), ['staging', 'canary', 'prod']);
});

test('two named things that are not a choice yield nothing', () => {
  assert.deepEqual(extractOptions('Can I edit `a.ts` to call `b()`?'), []);
  assert.deepEqual(extractOptions('I used `logo.svg` or `logo_old.svg`.'), [], 'not a question');
  assert.deepEqual(extractOptions('Is `a`, `b` fine?'), [], 'a list without "or" is not a choice');
});

test('Chinese and Arabic choice words count', () => {
  assert.deepEqual(extractOptions('你想用哪个？\n- 方案一\n- 方案二'), ['方案一', '方案二']);
  assert.deepEqual(extractOptions('أي خيار تفضل؟\n- الأول\n- الثاني'), ['الأول', 'الثاني']);
  assert.deepEqual(extractOptions('用 `a` 还是 `b`？'), ['a', 'b']);
});

test('too many items, or a sentence for an item, is not a quick reply', () => {
  const many = 'Which one?\n' + Array.from({ length: MAX_OPTIONS + 1 }, (_, i) => `- option ${i}`).join('\n');
  assert.deepEqual(extractOptions(many), []);
  const long = `Which one?\n- ${'word '.repeat(30)}\n- short`;
  assert.deepEqual(extractOptions(long), []);
});

test('the LAST choice list wins and duplicates collapse', () => {
  const q = 'Context:\n- step one\n- step two\n\nWhich do you want?\n- Yes\n- yes\n- No';
  assert.deepEqual(extractOptions(q), ['Yes', 'No']);
});

test('lists inside fenced code are content, not options', () => {
  const q = 'Which output is right?\n```\n- a\n- b\n```';
  assert.deepEqual(extractOptions(q), []);
});

test('nothing in, nothing out', () => {
  assert.deepEqual(extractOptions(''), []);
  assert.deepEqual(extractOptions(undefined), []);
  assert.deepEqual(extractOptions('Just tell me when you are back.'), []);
});

test('optionLabel cuts a long explanation at the dash or colon', () => {
  assert.equal(optionLabel('Keep both — archive the old one in brand/archive and link it from the readme'), 'Keep both');
  assert.equal(optionLabel('[Postgres](https://postgresql.org)'), 'Postgres');
  assert.equal(optionLabel('**Merge**: then tag'), 'Merge');
});

test('a yes/no ask over a list of steps is a to-do, not a choice', () => {
  const q = '**Can you create the account?**\n\n1. Sign up with the team address\n2. Paste the key into Settings';
  assert.deepEqual(extractOptions(q), []);
});

test('items named "Option …" are a choice on their own', () => {
  const q = 'Here is where we are.\n- Option A: rewrite\n- Option B: patch';
  assert.deepEqual(extractOptions(q), ['Option A: rewrite', 'Option B: patch']);
});
