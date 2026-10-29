'use strict';
/**
 * Devices phase 2, item 1: a moved agent's conversation file follows it.
 * Routing (laptop → device, device → laptop, device → device), the offline
 * and missing fallbacks, and byte-exact unicode, against fake devices
 * (test/fake-ssh.cjs). Nothing here touches the network.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { fakeDevice, waitForState } = require('./fake-ssh.cjs');

const { DeviceLink, copyTranscript } = loadTs('src/main/devices.ts');
const { projectKey } = loadTs('src/main/transcript.ts');
const { conversationStayedText } = loadTs('src/renderer/src/store/devices.ts');

const CWD = '/home/royal/Pro/Zensible/repo-x';
const SID = '0f3c2a9e-1111-4222-8333-944455556666';
const file = (home) => path.join(home, '.claude', 'projects', projectKey(CWD), `${SID}.jsonl`);
const put = (home, body) => {
  fs.mkdirSync(path.dirname(file(home)), { recursive: true });
  fs.writeFileSync(file(home), body);
};
// About 1 MB of lines full of 3- and 4-byte characters behind a 1-byte lead,
// so the pipe's chunk boundaries land inside a character somewhere.
const BODY = 'x' + Array.from({ length: 3000 }, (_, i) =>
  JSON.stringify({ i, text: '😀€中文 '.repeat(20) })).join('\n') + '\n';

function tmpHome(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'md-copy-home-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

async function online(t, f, id) {
  const link = new DeviceLink({ id, host: '100.65.189.1' }, f.env);
  t.after(() => link.stop());
  link.start();
  await waitForState(link, 'online');
  return link;
}

test('laptop → device: the file lands at the same path in the device home', async (t) => {
  const f = fakeDevice(t);
  const link = await online(t, f, 'my-lap');
  const home = tmpHome(t);
  put(home, BODY);
  assert.deepEqual(await copyTranscript(undefined, link, CWD, SID, home), { ok: true });
  assert.equal(fs.readFileSync(file(f.home), 'utf8'), BODY);
  assert.deepEqual(fs.readdirSync(path.dirname(file(f.home))), [`${SID}.jsonl`], 'no .part file left behind');
});

test('device → laptop: copied byte for byte, multi-byte characters included', async (t) => {
  const f = fakeDevice(t);
  const link = await online(t, f, 'my-lap');
  const home = tmpHome(t);
  put(f.home, BODY);
  assert.deepEqual(await copyTranscript(link, undefined, CWD, SID, home), { ok: true });
  assert.ok(fs.readFileSync(file(home)).equals(Buffer.from(BODY, 'utf8')));
});

test('device → device: read from one, written to the other', async (t) => {
  const a = fakeDevice(t);
  const b = fakeDevice(t);
  const from = await online(t, a, 'my-lap');
  const to = await online(t, b, 'big-box');
  put(a.home, BODY);
  assert.deepEqual(await copyTranscript(from, to, CWD, SID, tmpHome(t)), { ok: true });
  assert.equal(fs.readFileSync(file(b.home), 'utf8'), BODY);
});

test('the old device is offline: nothing is copied, reason offline', async (t) => {
  const f = fakeDevice(t);
  const link = new DeviceLink({ id: 'my-lap', host: '100.65.189.1' }, f.env); // never started
  const home = tmpHome(t);
  assert.deepEqual(await copyTranscript(link, undefined, CWD, SID, home), { ok: false, reason: 'offline' });
  assert.equal(fs.existsSync(file(home)), false);
});

test('the file is missing on either side: reason missing', async (t) => {
  const f = fakeDevice(t);
  const link = await online(t, f, 'my-lap');
  assert.deepEqual(await copyTranscript(link, undefined, CWD, SID, tmpHome(t)), { ok: false, reason: 'missing' });
  assert.deepEqual(await copyTranscript(undefined, link, CWD, SID, tmpHome(t)), { ok: false, reason: 'missing' });
});

test('a session id that is not one never becomes a path', async (t) => {
  const f = fakeDevice(t);
  const link = await online(t, f, 'my-lap');
  assert.deepEqual(await copyTranscript(undefined, link, CWD, '../../etc/passwd', tmpHome(t)), { ok: false, reason: 'missing' });
});

test('a copy cut short never takes the real name: a cut link is a plain EOF', (t) => {
  const { writeTranscriptCommand } = loadTs('src/main/deviceCommands.ts');
  const home = tmpHome(t);
  const gz = require('node:zlib').gzipSync(BODY);
  const run = (input) => require('node:child_process').spawnSync('bash', ['-c', writeTranscriptCommand(CWD, SID)], { input, env: { ...process.env, HOME: home } });
  assert.notEqual(run(gz.subarray(0, gz.length >> 1)).status, 0);
  assert.deepEqual(fs.readdirSync(path.dirname(file(home))), [], 'neither the transcript nor a .part file');
  assert.equal(run(gz).status, 0);
  assert.equal(fs.readFileSync(file(home), 'utf8'), BODY);
});

test('the floor says where the conversation stayed, in the spec words', () => {
  const en = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src/renderer/src/i18n/locales/en.json'), 'utf8'));
  const t = (k, o = {}) => k.split('.').reduce((x, p) => x?.[p], en).replace(/\{\{(\w+)\}\}/g, (_, v) => o[v]);
  assert.equal(conversationStayedText(t, { device: 'my-lap', reason: 'offline' }), 'conversation stayed on my-lap (offline); started fresh');
  assert.equal(conversationStayedText(t, { device: 'local', reason: 'missing' }), 'conversation stayed on This laptop (not found); started fresh');
});
