'use strict';

/**
 * The main-process side of the Memory screen against a real hive on disk:
 * the exact lane, the meaning lane's attribution, the header stats and note
 * reads (src/main/features/memory/{corpus,search}.ts). No Electron needed —
 * the feature module only wires these to ipcMain.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { FloorCorpus, readCapped, parseRegistry, findSection } = loadTs('src/main/features/memory/corpus.ts');
const { exactSearch, floorStats, readNote, meaningAnswer } = loadTs('src/main/features/memory/search.ts');
const { parseQuery } = loadTs('src/shared/workspace/memoryQuery.ts');

function makeHive() {
  // A space in the path on purpose: hives live in "My Documents" too.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ws memory '));
  const root = path.join(home, 'hive');
  const w = (rel, text) => {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text, 'utf8');
    return p;
  };
  w('registry.json', JSON.stringify({
    godId: 'god',
    agents: {
      god: { id: 'god', name: 'Michael', isGod: true, cwd: '/x' },
      'dwight-1': { id: 'dwight-1', name: 'Dwight', role: 'owns the auth tests', cwd: '/x' },
      'jim-1': { id: 'jim-1', name: 'Jim', cwd: '/x', archived: true }
    }
  }));
  w('agents/dwight-1/memory.md', [
    '# Memory — Dwight (dwight-1)', '', '_Append durable facts, decisions, and context below._', '',
    '## 2026-10-06 — Safari cookies', 'The cookie expires early on Safari. Seen while fixing bmt-12.', '',
    '## 2026-10-07 — **Deploys**', 'Blue/green only.'
  ].join('\n'));
  w('agents/jim-1/memory.md', '# Memory — Jim (jim-1)\n\n_Append durable facts, decisions, and context below._\n');
  w('agents/god/memory.md', '## Hiring\nPam joins Monday.\n');
  w('board.md', '# Hive board\n\n## Plan\nShip SSO after the login test (bmt-12) is green.\n');
  w('notes/release-checklist.md', '# Release checklist\n\n- check the **cookie** banner on Safari\n');
  w('notes/.hidden.md', 'cookie safari secret');
  w('tasks.json', JSON.stringify({
    tasks: [
      { id: 'bmt-12', title: 'Fix the flaky login test', status: 'doing', assignee: 'dwight-1', description: 'Safari only.' },
      { id: 'bmt-13', title: 'Ship SSO', status: 'todo', assignee: 'Michael' }
    ]
  }));
  return { home, root, w };
}

test('the exact lane answers in three shapes from every source', async () => {
  const { root } = makeHive();
  const r = await exactSearch(new FloorCorpus(), root, 'safari', null);
  assert.equal(r.ok, true);
  assert.equal(r.state, 'ok');
  assert.equal(r.lane, 'exact');
  const a = r.answer;
  // tickets: bmt-12 matched directly (description); people: assignee + the note's author
  assert.deepEqual(a.tickets.map((t) => [t.id, t.mentioned]), [['bmt-12', false]]);
  assert.deepEqual(a.tickets[0].agentIds, ['dwight-1']);
  // notes: Dwight's section and the user's note; never the dotfile, never the seed
  const notes = Object.fromEntries(a.notes.map((n) => [n.key, n]));
  assert.ok(notes['memory:dwight-1:1'], 'memory section');
  assert.ok(notes['notes:release-checklist.md'], 'user note');
  assert.equal(Object.keys(notes).length, 2);
  const m = notes['memory:dwight-1:1'];
  assert.equal(m.title, 'Safari cookies');
  assert.equal(m.at, '2026-10-06');
  assert.equal(m.authorId, 'dwight-1');
  assert.deepEqual(m.ticketRefs, ['bmt-12']);
  assert.equal(m.path, path.join(root, 'agents', 'dwight-1', 'memory.md'));
  assert.ok(m.snippet.marks.length > 0);
  const n = notes['notes:release-checklist.md'];
  assert.equal(n.title, 'Release checklist');
  assert.equal(n.authorId, undefined);
  // agents: Dwight, via his ticket and note
  assert.deepEqual(a.agents.map((x) => x.id), ['dwight-1']);
  assert.deepEqual(a.people.map((p) => p.name), ['Dwight']);
});

test('a ticket named only by a matching note is pulled in, the board is the orchestrator\'s', async () => {
  const { root } = makeHive();
  const r = await exactSearch(new FloorCorpus(), root, 'ship sso', null);
  const ids = r.answer.tickets.map((t) => t.id);
  assert.ok(ids.includes('bmt-13'), 'direct title hit');
  const board = r.answer.notes.find((x) => x.source === 'board');
  assert.ok(board);
  assert.equal(board.authorId, 'god');
  assert.deepEqual(board.ticketRefs, ['bmt-12']);
  const mentioned = r.answer.tickets.find((t) => t.id === 'bmt-12');
  assert.equal(mentioned.mentioned, true);
  // bmt-13's free-text assignee "Michael" resolved by name
  assert.deepEqual(r.answer.tickets.find((t) => t.id === 'bmt-13').agentIds, ['god']);
});

test('agents match by name and role; a ticket id finds its card', async () => {
  const { root } = makeHive();
  const corpus = new FloorCorpus();
  const byRole = await exactSearch(corpus, root, 'auth tests', null);
  assert.ok(byRole.answer.agents.find((a) => a.id === 'dwight-1' && a.direct));
  const byId = await exactSearch(corpus, root, 'BMT-12', null);
  assert.equal(byId.answer.tickets[0].id, 'bmt-12');
  assert.equal(byId.answer.tickets[0].mentioned, false);
});

test('no hive, an empty query and a missing hive folder all answer calmly', async () => {
  const corpus = new FloorCorpus();
  assert.equal((await exactSearch(corpus, null, 'cookie', null)).state, 'no-hive');
  assert.equal((await exactSearch(corpus, '/nope', '  ', null)).state, 'error');
  const missing = await exactSearch(corpus, path.join(os.tmpdir(), 'no-such-hive-xyz'), 'cookie', null);
  assert.equal(missing.ok, true);
  assert.equal(missing.answer.notes.length, 0);
});

test('the scan re-reads a file only when it changed', async () => {
  const { root, w } = makeHive();
  const corpus = new FloorCorpus();
  assert.equal((await exactSearch(corpus, root, 'zebra', null)).answer.notes.length, 0);
  const p = path.join(root, 'agents', 'dwight-1', 'memory.md');
  w('agents/dwight-1/memory.md', `${fs.readFileSync(p, 'utf8')}\n\n## Zebra\nstripes`);
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(p, later, later);
  assert.equal((await exactSearch(corpus, root, 'zebra', null)).answer.notes.length, 1);
});

test('symlinks are not followed out of the hive', { skip: process.platform === 'win32' }, async () => {
  const { root } = makeHive();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'));
  fs.writeFileSync(path.join(outside, 'secret.md'), 'platypus credentials');
  fs.symlinkSync(path.join(outside, 'secret.md'), path.join(root, 'notes', 'link.md'));
  fs.mkdirSync(path.join(root, 'agents', 'evil'));
  fs.symlinkSync(path.join(outside, 'secret.md'), path.join(root, 'agents', 'evil', 'memory.md'));
  const r = await exactSearch(new FloorCorpus(), root, 'platypus', null);
  assert.equal(r.answer.notes.length, 0);
  assert.equal((await readNote(root, { kind: 'notes', file: 'link.md' }, null)).ok, false);
});

test('a knowledge-graph hit becomes a document note', async () => {
  const { root } = makeHive();
  const kg = {
    active: () => true,
    search: () => [
      { docId: 'd1', title: 'Auth spec', source: 'spec.pdf', chunkIdx: 0, score: 3, snippet: 'Safari session cookie rules' },
      { docId: 'd1', title: 'Auth spec', source: 'spec.pdf', chunkIdx: 1, score: 1, snippet: 'more safari' }
    ],
    get: (id) => (id === 'd1' ? { meta: { title: 'Auth spec' }, text: 'full text' } : null),
    status: () => ({ enabled: true, docCount: 7 })
  };
  const r = await exactSearch(new FloorCorpus(), root, 'safari', kg);
  const docs = r.answer.notes.filter((n) => n.source === 'knowledge');
  assert.equal(docs.length, 1, 'one note per document');
  assert.deepEqual(docs[0].ref, { kind: 'knowledge', docId: 'd1' });
  const read = await readNote(root, docs[0].ref, kg);
  assert.deepEqual([read.ok, read.title, read.text], [true, 'Auth spec', 'full text']);
  assert.equal((await floorStats(new FloorCorpus(), root, kg)).documents, 7);
});

test('floorStats counts topics, tickets, agents with memory, entries and notes', async () => {
  const { root } = makeHive();
  const s = await floorStats(new FloorCorpus(), root, null);
  assert.equal(s.state, 'ok');
  assert.equal(s.tickets, 2);
  assert.equal(s.agentsWithMemory, 2, 'Jim holds only the seed');
  assert.equal(s.entries, 3);
  assert.equal(s.notes, 1);
  // safari cookies, deploys, hiring, release checklist, cookie (bold) — "plan" is generic
  assert.equal(s.topics, 5);
  assert.equal((await floorStats(new FloorCorpus(), null, null)).state, 'no-hive');
});

test('readNote returns the section, falls back to the file, refuses traversal', async () => {
  const { root } = makeHive();
  const ok = await readNote(root, { kind: 'memory', agentId: 'dwight-1', section: 1, heading: '2026-10-06 — Safari cookies' }, null);
  assert.equal(ok.ok, true);
  assert.equal(ok.title, 'Safari cookies');
  assert.match(ok.text, /^## 2026-10-06 — Safari cookies\n\nThe cookie expires early/);
  // The file was edited above the section: found by heading instead.
  const moved = await readNote(root, { kind: 'memory', agentId: 'dwight-1', section: 9, heading: '2026-10-07 — **Deploys**' }, null);
  assert.match(moved.text, /Blue\/green only/);
  const gone = await readNote(root, { kind: 'memory', agentId: 'dwight-1', section: 9, heading: 'nope' }, null);
  assert.equal(gone.ok, true);
  assert.match(gone.text, /# Memory — Dwight/);
  const board = await readNote(root, { kind: 'board', section: 1, heading: 'Plan' }, null);
  assert.match(board.text, /Ship SSO/);
  for (const bad of [
    { kind: 'memory', agentId: '..', section: 0 },
    { kind: 'memory', agentId: '../../etc', section: 0 },
    { kind: 'notes', file: '../registry.json' },
    { kind: 'notes', file: '.hidden.md' },
    { kind: 'notes', file: 'nope.md' }
  ]) {
    assert.equal((await readNote(root, bad, null)).ok, false, JSON.stringify(bad));
  }
  assert.equal((await readNote(null, { kind: 'board', section: 0 }, null)).ok, false);
});

test('the meaning lane attributes drawers to agents and tickets', async () => {
  const { root } = makeHive();
  const out = [
    '', '='.repeat(60), '  Results for: "browser session expiry"', '='.repeat(60), '',
    '  [1] dwight_1 / auth', '      Source: memory.md', '      Match:  cosine_sim=0.61  bm25=0.0', '',
    '      ## 2026-10-06 — Safari cookies', '      The cookie expires early on Safari. Seen while fixing bmt-12.', '',
    `  ${'-'.repeat(56)}`,
    '  [2] unknown_wing / general', '      Source: ../../etc/passwd', '      Match:  cosine_sim=0.2  bm25=0.0', '',
    '      Something else.', '', `  ${'-'.repeat(56)}`, ''
  ].join('\n');
  const r = await meaningAnswer(new FloorCorpus(), root, parseQuery('browser session expiry'), out);
  assert.equal(r.unparsed, false);
  const [first, second] = r.answer.notes;
  assert.equal(first.authorId, 'dwight-1');
  assert.equal(first.title, 'Safari cookies');
  assert.equal(first.at, '2026-10-06');
  assert.equal(first.path, path.join(root, 'agents', 'dwight-1', 'memory.md'));
  assert.deepEqual(first.ticketRefs, ['bmt-12']);
  assert.ok(first.score > second.score, 'MemPalace order is kept');
  assert.equal(second.authorId, undefined);
  assert.equal(second.path, undefined, 'a source that is not a plain file name never becomes a path');
  assert.deepEqual(r.answer.tickets.map((t) => [t.id, t.mentioned]), [['bmt-12', true]]);
  assert.deepEqual(r.answer.agents.map((a) => a.id), ['dwight-1']);
  const raw = await meaningAnswer(new FloorCorpus(), root, parseQuery('anything'), 'Traceback: something broke');
  assert.equal(raw.unparsed, true);
  assert.equal(raw.raw, 'Traceback: something broke');
});

test('readCapped reads up to the cap and says it truncated', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-'));
  const p = path.join(dir, 'big.md');
  fs.writeFileSync(p, 'a'.repeat(100));
  const r = await readCapped(p, 10);
  assert.deepEqual([r.text, r.truncated, r.size], ['a'.repeat(10), true, 100]);
  assert.equal(await readCapped(path.join(dir, 'missing.md'), 10), null);
  assert.equal(await readCapped(dir, 10), null, 'a directory is not a file');
});

test('parseRegistry and findSection tolerate odd input', () => {
  assert.deepEqual(parseRegistry('not json'), { people: [], godId: null });
  assert.deepEqual(parseRegistry('{"agents":{"x":{}}}').people, [{ id: 'x', name: 'x' }]);
  const sections = [{ index: 1, heading: 'A', level: 2, body: '' }, { index: 2, heading: 'B', level: 2, body: '' }];
  assert.equal(findSection(sections, 1, 'A').heading, 'A');
  assert.equal(findSection(sections, 1, 'B').heading, 'B');
  assert.equal(findSection(sections, 1).heading, 'A');
  assert.equal(findSection(sections, 5, 'C'), null);
});
