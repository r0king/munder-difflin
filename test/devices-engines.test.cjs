'use strict';
/**
 * Devices phase 2, item 5: engines other than Claude Code on a device. Hook
 * files that live in the user's home are built here and written to the
 * DEVICE's home; they run the device's own node and its own copy of the
 * shim; the shims reach the floor over the forwarded port. Check finds each
 * engine's CLI with an install command. No network: a fake RemoteHome and
 * the fake ssh (test/fake-ssh.cjs).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const loadTs = require('./load-ts.cjs');
const { fakeDevice, waitForState } = require('./fake-ssh.cjs');

const electron = require.resolve('electron');
require.cache[electron] = {
  id: electron, filename: electron, loaded: true,
  exports: { Notification: class { show() {} static isSupported() { return false; } } }
};
const { HiveManager } = loadTs('src/main/hive.ts');
const dc = loadTs('src/main/deviceCommands.ts');
const { DeviceLink, checkDevice } = loadTs('src/main/devices.ts');
const { DEVICE_PROVIDERS } = loadTs('src/shared/devices.ts');
const { installInfoForProvider } = loadTs('src/shared/agentProvider.ts');

const DEVICE = { home: '/home/alice', node: '/usr/bin/node' };

/** A temp hive home, with HOME pointed at it so a stray local write shows. */
function setup(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-engines-'));
  const realHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => {
    process.env.HOME = realHome;
    fs.rmSync(home, { recursive: true, force: true });
  });
  assert.equal(os.homedir(), home);
  const writes = [];
  const remote = { ...DEVICE, write: async (files) => { writes.push(...files); } };
  return { home, hive: new HiveManager(() => home), writes, remote };
}

test('only the engines the spec lists run on a device', () => {
  assert.deepEqual([...DEVICE_PROVIDERS].sort(), ['antigravity', 'claude', 'codex', 'crush', 'custom', 'grok', 'qwen']);
});

test('agy on a device: its hooks go to the device home, run by the device node', async (t) => {
  const { home, hive, writes, remote } = setup(t);
  await hive.ensureAgent({ id: 'agy-1', name: 'Agy', provider: 'antigravity', cwd: home }, { remote });
  assert.deepEqual(writes.map((w) => w.path).sort(),
    ['.cache/munder-difflin/agy-hook.cjs', '.gemini/antigravity-cli/hooks.json', '.gemini/config/hooks.json']);
  const cfg = writes.find((w) => w.path === '.gemini/config/hooks.json');
  assert.equal(cfg.mergeKey, 'munder-hive');
  assert.equal(JSON.parse(cfg.content).Stop[0].hooks[0].command,
    '"/usr/bin/node" "/home/alice/.cache/munder-difflin/agy-hook.cjs" Stop');
  assert.equal(fs.existsSync(path.join(home, '.gemini')), false, "this laptop's home is untouched");
});

test('grok on a device: same, with its own file', async (t) => {
  const { home, hive, writes, remote } = setup(t);
  await hive.ensureAgent({ id: 'grok-1', name: 'Grok', provider: 'grok', cwd: home }, { remote });
  assert.deepEqual(writes.map((w) => w.path).sort(), ['.cache/munder-difflin/grok-hook.cjs', '.grok/hooks/munder-hive.json']);
  const hooks = JSON.parse(writes.find((w) => w.path === '.grok/hooks/munder-hive.json').content).hooks;
  assert.equal(hooks.Stop[0].hooks[0].command, '"/usr/bin/node" "/home/alice/.cache/munder-difflin/grok-hook.cjs"');
  assert.equal(fs.existsSync(path.join(home, '.grok')), false);
});

test("codex on a device: its hive CODEX_HOME runs the device's shim copy", async (t) => {
  const { home, hive, writes, remote } = setup(t);
  const inj = await hive.ensureAgent({ id: 'cx-1', name: 'Codex', provider: 'codex', cwd: home }, { remote });
  const toml = fs.readFileSync(path.join(inj.env.CODEX_HOME, 'config.toml'), 'utf8');
  assert.ok(toml.includes(`command = ${JSON.stringify('"/usr/bin/node" "/home/alice/.cache/munder-difflin/cth-hook.cjs"')}`), toml);
  assert.ok(!toml.includes('hive-node'), "never this laptop's Electron launcher");
  assert.deepEqual(writes, [], 'codex keeps its config in the hive, which the device mounts');
});

async function hookLine(t, shim, args, stdin) {
  const lines = [];
  const server = net.createServer((c) => {
    c.setEncoding('utf8');
    c.on('data', (d) => { lines.push(d); c.end('{}'); });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const p = spawn(process.execPath, [shim, ...args], {
    env: { PATH: process.env.PATH, AGENT_ID: 'a-1', HIVE_HOOK_PORT: String(server.address().port) },
    stdio: ['pipe', 'ignore', 'ignore']
  });
  p.stdin.end(stdin);
  await new Promise((r) => p.on('close', r));
  return lines.join('');
}

test('the agy and grok shims reach the floor over HIVE_HOOK_PORT, with no HIVE_SOCK', async (t) => {
  const { home, hive, remote } = setup(t);
  await hive.ensureAgent({ id: 'agy-1', name: 'Agy', provider: 'antigravity', cwd: home }, { remote });
  await hive.ensureAgent({ id: 'grok-1', name: 'Grok', provider: 'grok', cwd: home }, { remote });
  const agy = await hookLine(t, path.join(home, 'hive', 'bin', 'agy-hook.cjs'), ['Stop'], '{}');
  assert.equal(JSON.parse(agy).hook_event_name, 'Stop');
  const grok = await hookLine(t, path.join(home, 'hive', 'bin', 'grok-hook.cjs'), [], '{"hookEventName":"stop"}');
  assert.equal(JSON.parse(grok).agent_id, 'a-1');
});

function sandbox(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-homefile-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sh = (cmd, input) => spawnSync('bash', ['-c', cmd], {
    env: { ...process.env, HOME: dir, PATH: `${path.dirname(process.execPath)}:${process.env.PATH}` }, input, encoding: 'utf8'
  });
  return { dir, sh };
}

test('a home file is written from stdin, folders made', (t) => {
  const { dir, sh } = sandbox(t);
  assert.equal(sh(dc.writeHomeFileCommand('.grok/hooks/munder-hive.json'), '{"hooks":{}}').status, 0);
  assert.equal(fs.readFileSync(path.join(dir, '.grok/hooks/munder-hive.json'), 'utf8'), '{"hooks":{}}');
});

test('the home-file merge keeps other keys and survives garbage', (t) => {
  const { dir, sh } = sandbox(t);
  const f = path.join(dir, '.gemini/config/hooks.json');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ theirs: { x: 1 }, 'munder-hive': { old: true } }));
  assert.equal(sh(dc.mergeHomeJsonCommand('.gemini/config/hooks.json', 'munder-hive'), '{"Stop":[]}').status, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')), { theirs: { x: 1 }, 'munder-hive': { Stop: [] } });
  fs.writeFileSync(f, 'not json at all');
  assert.equal(sh(dc.mergeHomeJsonCommand('.gemini/config/hooks.json', 'munder-hive'), '{"Stop":[]}').status, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')), { 'munder-hive': { Stop: [] } });
});

test("the device's $HOME and node, or nothing", () => {
  assert.deepEqual(dc.parseRemoteEnv('home=/home/alice\nnode=/usr/bin/node\n'), DEVICE);
  assert.equal(dc.parseRemoteEnv('home=/home/alice\nnode=\n'), null, 'no node');
  assert.equal(dc.parseRemoteEnv('home=relative\nnode=/usr/bin/node\n'), null);
});

test("Check finds each engine's CLI, with the engine's own install command", async (t) => {
  const f = fakeDevice(t);
  f.tool('md-fake-engine', 'exit 0');
  const link = new DeviceLink({ id: 'my-lap', host: '100.65.189.1' }, f.env);
  t.after(() => link.stop());
  link.start();
  await waitForState(link, 'online');
  const items = (await checkDevice(link, f.hive, [], os.homedir(), [
    { provider: 'codex', bin: 'md-fake-engine' },
    { provider: 'codex', bin: 'md-missing-engine' }
  ])).filter((i) => i.id === 'engine');
  assert.deepEqual(items.map((i) => [i.name, i.ok]), [['md-fake-engine', true], ['md-missing-engine', false]]);
  const info = installInfoForProvider('codex', 'linux');
  assert.equal(items[1].fix, info.nativeCommand ?? info.command);
});

test('rosterAgentsOn carries each agent engine for Check', () => {
  const roster = { agents: [{ id: 'a', cwd: '/r', device: 'my-lap', provider: 'codex', command: 'codex --model x' }] };
  assert.deepEqual(dc.rosterAgentsOn(roster, 'my-lap'), [{ id: 'a', cwd: '/r', provider: 'codex', command: 'codex --model x' }]);
});
