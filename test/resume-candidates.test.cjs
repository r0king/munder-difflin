'use strict';
// A resumed Claude reports a fresh session id before its first turn, and that
// id has no transcript. Restarted before that turn, an agent must fall back to
// its earlier ids or it starts fresh (oscar, 2026-10-29).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');

test('resumeCandidates: the recorded id first, then earlier ones, newest first, no repeats', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-resume-'));
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'oscar-1', name: 'Oscar', provider: 'claude', cwd: home }, {});
  for (const sid of ['real-a', 'fresh-1', 'real-a', 'fresh-2']) hive.recordSession('oscar-1', sid);
  hive.recordSession('kelly-1', 'not-oscars');
  fs.appendFileSync(path.join(home, 'hive', 'log.jsonl'), '{"kind":"session","agentId":"oscar-1",\n'); // a torn line
  assert.deepEqual(hive.resumeCandidates('oscar-1'), ['fresh-2', 'real-a', 'fresh-1']);
  assert.deepEqual(hive.resumeCandidates('oscar-1', 2), ['fresh-2', 'real-a']);
  assert.deepEqual(hive.resumeCandidates('nobody'), []);
});

test('the spawn tries each candidate and resumes the first whose transcript is there', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8');
  assert.match(src, /hive\.resumeCandidates\(opts\.hive\.id\)/);
  assert.match(src, /for \(const c of candidates\)[\s\S]{0,1600}if \(present\) \{ sid = c; break; \}/);
});
