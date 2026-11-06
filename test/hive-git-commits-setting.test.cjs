'use strict';

/**
 * The hive commits itself to git on every state change, synchronously on the
 * main process. A setting turns that off. These pin what the setting promises,
 * what stays the same without it, and the semantic-memory ignore files, which
 * used to be refreshed only as a side effect of the first commit.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');
const { applyGitCommitsSetting, gitCommitsDisabled } = loadTs('src/main/hiveGitSetting.ts');

function home(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-hive-git-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function floor(t, dir, disabled) {
  const hive = new HiveManager(() => dir);
  hive.setGitCommitsDisabled(disabled);
  await hive.ensureAgent({ id: 'god-1', name: 'Boss', provider: 'claude', cwd: dir, isGod: true });
  await hive.ensureAgent({ id: 'worker-1', name: 'Helper', provider: 'claude', cwd: dir });
  return hive;
}

function head(root) {
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

const MESSAGE = { to: 'god-1', act: 'inform', subject: 'hello', body: 'world' };

test('without the setting a new hive is a git repository and a message commits', async (t) => {
  const dir = home(t);
  const hive = await floor(t, dir, false);
  const root = path.join(dir, 'hive');
  const before = head(root);

  hive.send(MESSAGE, 'worker-1');

  assert.notEqual(head(root), before);
});

test('with the setting a new hive gets no git repository', async (t) => {
  const dir = home(t);
  await floor(t, dir, true);

  assert.equal(fs.existsSync(path.join(dir, 'hive', '.git')), false);
});

test('with the setting nothing commits to a repository that already exists, and it is left alone', async (t) => {
  const dir = home(t);
  await floor(t, dir, false);
  const root = path.join(dir, 'hive');
  const before = head(root);

  const hive = new HiveManager(() => dir);
  hive.setGitCommitsDisabled(true);
  hive.ensureHive();
  hive.send(MESSAGE, 'worker-1');
  fs.writeFileSync(path.join(root, 'agents', 'worker-1', 'outbox', 'a.json'), JSON.stringify(MESSAGE));
  assert.equal(hive.routeOnce(), 1);
  hive.commit('anything');

  assert.equal(head(root), before);
  assert.equal(hive.inbox('god-1').length, 2, 'mail is delivered as before');
});

test('a message is still delivered on a hive with no repository', async (t) => {
  const dir = home(t);
  const hive = await floor(t, dir, true);

  hive.send(MESSAGE, 'worker-1');

  assert.equal(hive.inbox('god-1')[0].body, 'world');
});

for (const disabled of [true, false]) {
  test(`a stopped agent's ignore file is refreshed at startup (setting ${disabled ? 'on' : 'off'})`, async (t) => {
    const dir = home(t);
    await floor(t, dir, disabled);
    const ignore = path.join(dir, 'hive', 'agents', 'worker-1', '.gitignore');
    fs.writeFileSync(ignore, 'keep-me\n');

    const restarted = new HiveManager(() => dir);
    restarted.setGitCommitsDisabled(disabled);
    restarted.ensureHive();

    const lines = fs.readFileSync(ignore, 'utf8').split('\n');
    assert.ok(lines.includes('.codex/'), 'a Codex home stays out of semantic memory');
    assert.ok(lines.includes('inbox/'), 'raw inbox files stay out of semantic memory');
    assert.ok(lines.includes('keep-me'), 'existing entries are kept');
  });
}

test('the refresh runs once for each hive folder, not on every ensureHive', async (t) => {
  const dir = home(t);
  const hive = await floor(t, dir, true);
  const ignore = path.join(dir, 'hive', 'agents', 'worker-1', '.gitignore');
  hive.ensureHive();
  fs.rmSync(ignore);

  hive.ensureHive();

  assert.equal(fs.existsSync(ignore), false);
});

test('the app applies the setting before the hive is first prepared, and on every config write', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8')
    .split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
  const start = source.indexOf('function bootstrapHiveServices');
  const set = source.indexOf('hive.setGitCommitsDisabled(gitCommitsDisabled(readConfig().disableHiveGitCommits))', start);
  assert.ok(set > start, 'read at bootstrap');
  assert.ok(set < source.indexOf('hive.ensureHive()', start), 'a new hive must not be initialised first');
  assert.match(source, /'disableHiveGitCommits' in patch\) applyGitCommitsSetting\(hive, patch\.disableHiveGitCommits\)/);
});

test('turning commits back on while running creates the repository and commits resume', async (t) => {
  const dir = home(t);
  const hive = await floor(t, dir, true);
  const root = path.join(dir, 'hive');
  assert.equal(fs.existsSync(path.join(root, '.git')), false);

  applyGitCommitsSetting(hive, false);

  const before = head(root);
  hive.send(MESSAGE, 'worker-1');
  assert.notEqual(head(root), before);
});

test('turning commits off while running stops them and leaves the repository', async (t) => {
  const dir = home(t);
  const hive = await floor(t, dir, false);
  const root = path.join(dir, 'hive');
  const before = head(root);

  applyGitCommitsSetting(hive, true);
  hive.send(MESSAGE, 'worker-1');

  assert.equal(head(root), before);
});

for (const junk of ['true', 'false', 1, 0, null, {}, []]) {
  test(`a value of ${JSON.stringify(junk)} leaves commits on and warns`, async (t) => {
    const warnings = [];
    assert.equal(gitCommitsDisabled(junk, (line) => warnings.push(line)), false);
    assert.equal(warnings.length, 1);

    const dir = home(t);
    const hive = await floor(t, dir, true);
    applyGitCommitsSetting(hive, junk, () => {});
    const before = head(path.join(dir, 'hive'));
    hive.send(MESSAGE, 'worker-1');
    assert.notEqual(head(path.join(dir, 'hive')), before);
  });
}

for (const value of [true, false, undefined]) {
  test(`a value of ${value} gives no warning`, () => {
    const warnings = [];
    assert.equal(gitCommitsDisabled(value, (line) => warnings.push(line)), value === true);
    assert.equal(warnings.length, 0);
  });
}
