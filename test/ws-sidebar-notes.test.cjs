'use strict';

// Workspace sidebar notes, the pure half: slug validation (the only thing
// standing between a renderer-supplied name and the filesystem), the file
// format, search ranking, and what "Send to…" hands an agent.

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const {
  isValidNoteSlug,
  noteSlugFromFileName,
  slugifyNoteTitle,
  uniqueSlug,
  cleanNoteTitle,
  parseNoteFile,
  serializeNote,
  noteExcerpt,
  queryTerms,
  rankNotes,
  noteDeliveryText,
  isNoteWriteRequest,
  isNoteRenameRequest,
  NOTE_SLUG_MAX,
  NOTE_BODY_MAX,
  NOTE_INLINE_SEND_MAX
} = loadTs('src/shared/workspace/sidebarNotes.ts');

test('slug validation refuses every traversal and separator trick', () => {
  for (const bad of [
    '', '..', '../x', 'a/b', 'a\\b', '/etc/passwd', 'C:', 'c:\\x', 'a..b', '.hidden', 'x.md',
    'Upper', 'with space', 'trailing-', '-leading', 'double--hyphen', 'nul\u0000', 'é', '笔记',
    'con', 'NUL', 'com1', 'lpt9', 'x'.repeat(NOTE_SLUG_MAX + 1), 42, null, undefined, {}
  ]) {
    assert.equal(isValidNoteSlug(bad), false, `accepted ${JSON.stringify(bad)}`);
  }
  for (const good of ['a', 'standup-notes', 'q3-plan-2026', 'x'.repeat(NOTE_SLUG_MAX), 'con-notes']) {
    assert.equal(isValidNoteSlug(good), true, `rejected ${good}`);
  }
});

test('noteSlugFromFileName: only `<valid slug>.md` is a sidebar note', () => {
  assert.equal(noteSlugFromFileName('standup-notes.md'), 'standup-notes');
  assert.equal(noteSlugFromFileName('a1.md'), 'a1');
  for (const other of [
    'Standup.md', 'draft 2.md', 'todo.txt', 'notes.markdown', '.md', 'x.MD', 'con.md',
    '../evil.md', 'sub/dir.md', 'a--b.md', '-a.md', 'a.md.txt', '', 42, null, undefined
  ]) {
    assert.equal(noteSlugFromFileName(other), null, `took ${JSON.stringify(other)}`);
  }
  assert.equal(noteSlugFromFileName(`${'a'.repeat(NOTE_SLUG_MAX)}.md`), 'a'.repeat(NOTE_SLUG_MAX));
  assert.equal(noteSlugFromFileName(`${'a'.repeat(NOTE_SLUG_MAX + 1)}.md`), null);
});

test('slugify folds accents and punctuation, and never yields an invalid slug', () => {
  assert.equal(slugifyNoteTitle('Café: Q3 plan!'), 'cafe-q3-plan');
  assert.equal(slugifyNoteTitle('  ../../etc/passwd  '), 'etc-passwd');
  assert.equal(slugifyNoteTitle('客户名单'), 'note');
  assert.equal(slugifyNoteTitle('ملاحظات'), 'note');
  assert.equal(slugifyNoteTitle('CON'), 'con-note');
  const long = slugifyNoteTitle('word '.repeat(60));
  assert.ok(long.length <= NOTE_SLUG_MAX && isValidNoteSlug(long));
  for (const t of ['', '---', 'A B', 'x'.repeat(500), 'Ünïcödé', 'tab\there']) {
    assert.equal(isValidNoteSlug(slugifyNoteTitle(t)), true, t);
  }
});

test('uniqueSlug numbers collisions and stays within the length cap', () => {
  assert.equal(uniqueSlug('plan', new Set()), 'plan');
  assert.equal(uniqueSlug('plan', new Set(['plan', 'plan-2'])), 'plan-3');
  const base = 'x'.repeat(NOTE_SLUG_MAX);
  const next = uniqueSlug(base, new Set([base]));
  assert.ok(isValidNoteSlug(next) && next.endsWith('-2'));
  // An invalid base is slugified first rather than trusted.
  assert.equal(uniqueSlug('../Bad Name', new Set()), 'bad-name');
});

test('titles are one clean line', () => {
  assert.equal(cleanNoteTitle('  Two\nlines\t here '), 'Two lines here');
  assert.equal(cleanNoteTitle(5), '');
  assert.equal(cleanNoteTitle('x'.repeat(500)).length, 120);
});

test('the file format round-trips and tolerates hand-written notes', () => {
  const text = serializeNote('Standup', 'Ship the login fix.\n\n- [ ] Safari\n');
  assert.equal(text, '# Standup\n\nShip the login fix.\n\n- [ ] Safari\n');
  assert.deepEqual(parseNoteFile('standup', text), { title: 'Standup', body: 'Ship the login fix.\n\n- [ ] Safari\n' });
  // No heading: the slug is the title and the whole file is the body.
  assert.deepEqual(parseNoteFile('scratch', 'just text'), { title: 'scratch', body: 'just text' });
  // CRLF and a BOM from a Windows editor.
  assert.deepEqual(parseNoteFile('w', '\uFEFF# Win\r\n\r\nbody\r\n'), { title: 'Win', body: 'body\n' });
  // A `#` inside the title is kept; a closing ATX run is dropped.
  assert.equal(parseNoteFile('c', '# C# tips #\n').title, 'C# tips');
  // A level-2 heading is body, not title.
  assert.equal(parseNoteFile('h', '## Sub\nx').title, 'h');
  assert.equal(serializeNote('Empty', ''), '# Empty\n');
});

test('excerpt is the first meaningful line without markdown markers', () => {
  assert.equal(noteExcerpt('\n\n## Heading\nmore'), 'Heading');
  assert.equal(noteExcerpt('- [ ] **Call** the `vendor`'), 'Call the vendor');
  assert.equal(noteExcerpt(''), '');
  assert.ok(noteExcerpt('y'.repeat(400)).length <= 140);
});

test('queryTerms: whitespace terms, folded, deduplicated; CJK stays one term', () => {
  assert.deepEqual(queryTerms('  Café  cafe LOGIN '), ['cafe', 'login']);
  assert.deepEqual(queryTerms('客户名单'), ['客户名单']);
  assert.deepEqual(queryTerms(''), []);
});

const NOTES = [
  { slug: 'login-bug', title: 'Login bug', body: 'The cookie expires early on Safari.', updatedAt: 100 },
  { slug: 'standup', title: 'Standup', body: 'Login flow is flaky. Login tests fail on Safari. Ask Dwight.', updatedAt: 300 },
  { slug: 'vendors', title: 'Vendors', body: 'Paper suppliers and the login portal for orders.', updatedAt: 200 },
  { slug: 'groceries', title: 'Groceries', body: 'Beets.', updatedAt: 400 }
];

test('rank: title matches beat body matches; ties go to the newest', () => {
  const hits = rankNotes(NOTES, 'login');
  assert.deepEqual(hits.map((h) => h.slug), ['login-bug', 'standup', 'vendors']);
  // Groceries never matched.
  assert.ok(!hits.some((h) => h.slug === 'groceries'));
});

test('rank: every term must match (AND), across title and body', () => {
  assert.deepEqual(rankNotes(NOTES, 'login safari').map((h) => h.slug), ['login-bug', 'standup']);
  assert.deepEqual(rankNotes(NOTES, 'login dwight').map((h) => h.slug), ['standup']);
  assert.deepEqual(rankNotes(NOTES, 'login nowhere'), []);
});

test('rank: an exact title outranks everything', () => {
  const notes = [
    { slug: 'a', title: 'Plan for Q3 plans', body: 'plan plan plan plan', updatedAt: 9 },
    { slug: 'b', title: 'Plan', body: '', updatedAt: 1 }
  ];
  assert.equal(rankNotes(notes, 'plan')[0].slug, 'b');
});

test('rank: an empty query lists every note newest first', () => {
  assert.deepEqual(rankNotes(NOTES, '   ').map((h) => h.slug), ['groceries', 'standup', 'vendors', 'login-bug']);
});

test('rank: the snippet locates the body match, case- and accent-insensitively', () => {
  const [hit] = rankNotes([{ slug: 'c', title: 'Coffee', body: 'We tried the new CAFÉ downstairs.', updatedAt: 1 }], 'cafe');
  assert.equal(hit.snippet.slice(hit.matchStart, hit.matchStart + hit.matchLength), 'CAFÉ');
  const [cjk] = rankNotes([{ slug: 'n', title: 'note', body: '这是客户名单的备注', updatedAt: 1 }], '客户');
  assert.equal(cjk.snippet.slice(cjk.matchStart, cjk.matchStart + cjk.matchLength), '客户');
});

test('rank: a long body gets an ellipsised window around the match', () => {
  const body = `${'a '.repeat(200)}needle${' b'.repeat(200)}`;
  const [hit] = rankNotes([{ slug: 'l', title: 'Long', body, updatedAt: 1 }], 'needle');
  assert.ok(hit.snippet.startsWith('…') && hit.snippet.endsWith('…'));
  assert.equal(hit.snippet.slice(hit.matchStart, hit.matchStart + hit.matchLength), 'needle');
});

test('Send to…: short notes go inline with their path, long ones as a file', () => {
  const short = noteDeliveryText({ title: 'Plan', body: 'Do X.', path: '/h/hive/notes/plan.md' }, 'Use this');
  assert.equal(short.attachments.length, 0);
  assert.ok(short.text.startsWith('Use this\n\n'));
  assert.ok(short.text.includes('/h/hive/notes/plan.md') && short.text.includes('Do X.'));
  const long = noteDeliveryText({ title: 'Big', body: 'z'.repeat(NOTE_INLINE_SEND_MAX + 1), path: '/p/big.md' });
  assert.deepEqual(long.attachments, ['/p/big.md']);
  assert.ok(!long.text.includes('zzz'));
});

test('IPC payload validation', () => {
  assert.equal(isNoteWriteRequest({ title: 'T', body: 'b' }), true);
  assert.equal(isNoteWriteRequest({ slug: 'ok', title: 'T', body: 'b', expectedUpdatedAt: 5 }), true);
  assert.equal(isNoteWriteRequest({ slug: '../x', title: 'T', body: 'b' }), false);
  assert.equal(isNoteWriteRequest({ title: 'T', body: 'x'.repeat(NOTE_BODY_MAX + 1) }), false);
  assert.equal(isNoteWriteRequest({ title: 'T', body: 'b', expectedUpdatedAt: NaN }), false);
  assert.equal(isNoteWriteRequest({ title: 1, body: 'b' }), false);
  assert.equal(isNoteWriteRequest(null), false);
  assert.equal(isNoteRenameRequest({ slug: 'a', title: 'B' }), true);
  assert.equal(isNoteRenameRequest({ slug: 'a/b', title: 'B' }), false);
});
