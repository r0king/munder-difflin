'use strict';

/**
 * End-to-end: runHiddenClaude against a fake `claude` that reproduces the two
 * live failures of 2026-10-28, when every memory condense aborted for 90 min:
 *
 *  1. The TUI paints its prompt, goes quiet, and still drops input for a while.
 *     A paste typed in that window vanishes, no transcript is ever written, and
 *     the run used to end "no assistant response found in transcript".
 *  2. Another session in the same cwd (god runs in the hive home) writes the
 *     newest .jsonl in the project dir. The run used to read god's last turn
 *     ("no parseable summary").
 *
 * It also checks the parent session's CLAUDE_CODE_CHILD_SESSION marker is
 * stripped: with it, the CLI turns transcript saving off.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const POSIX = process.platform !== 'win32';

const FAKE = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const at = process.argv.indexOf('--session-id');
const id = at > 0 ? process.argv[at + 1] : 'no-session-id';
const dir = process.env.FAKE_PROJECT_DIR;
const decoy = path.join(dir, 'god.jsonl');
const turn = (text) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } }) + '\\n';
const bootedAt = Date.now();
process.stdin.setRawMode(true);
process.stdout.write('banner\\n> ');
let buf = '';
process.stdin.on('data', (d) => {
  // god keeps typing in the same project dir, so its file is always the newest.
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(decoy, turn('DECOY: god'));
  if (Date.now() - bootedAt < 2500) return; // painted, not yet listening
  buf += d.toString();
  if (!buf.endsWith('\\r')) return;
  if (!buf.includes('\\x1b[200~')) { buf = ''; return; } // Enter on an empty prompt
  // Transcript saving is off in a child session, as in the real CLI.
  if (!process.env.CLAUDE_CODE_CHILD_SESSION) {
    const file = path.join(dir, id + '.jsonl');
    fs.appendFileSync(file, JSON.stringify({ type: 'user' }) + '\\n');
    fs.appendFileSync(file, turn('submits=' + (buf.match(/\\x1b\\[200~/g) || []).length));
  }
  process.stdout.write('done\\n');
  buf = '';
});
`;

test('a paste dropped during boot is re-sent, and only our own transcript is read', { skip: !POSIX, timeout: 30_000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hidden-claude-'));
  const home = path.join(tmp, 'home');
  const cwd = path.join(tmp, 'hive');
  fs.mkdirSync(home);
  fs.mkdirSync(cwd);
  const fake = path.join(tmp, 'claude');
  fs.writeFileSync(fake, FAKE, { mode: 0o755 });

  const saved = { HOME: process.env.HOME, FAKE_PROJECT_DIR: process.env.FAKE_PROJECT_DIR, CHILD: process.env.CLAUDE_CODE_CHILD_SESSION };
  process.env.HOME = home; // os.homedir() → projectDir() lands in the temp home
  process.env.CLAUDE_CODE_CHILD_SESSION = '1';
  try {
    const loadTs = require('./load-ts.cjs');
    const { projectDir } = loadTs('src/main/transcript.ts');
    const { runHiddenClaude } = loadTs('src/main/hiddenClaude.ts');
    process.env.FAKE_PROJECT_DIR = projectDir(cwd);

    const r = await runHiddenClaude('summarize please', {
      model: 'claude-haiku-4-5', cwd, command: fake, idleMs: 800, bootCapMs: 5000, timeoutMs: 20_000
    });
    assert.equal(r.ok, true, r.error);
    // Exactly one paste reached the CLI's input once it was listening.
    assert.equal(r.text, 'submits=1');
  } finally {
    for (const [k, v] of [['HOME', saved.HOME], ['FAKE_PROJECT_DIR', saved.FAKE_PROJECT_DIR], ['CLAUDE_CODE_CHILD_SESSION', saved.CHILD]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
