'use strict';
/**
 * Devices, Task 10: the renderer side. Every new string exists in all three
 * locales with its placeholders, plus the two small rules Settings and the
 * agent cards use.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { deviceInUse, deviceOffline } = loadTs('src/renderer/src/store/devices.ts');
const LOCALES = ['en', 'ar', 'zh-CN'];
const read = (l) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src/renderer/src/i18n/locales', `${l}.json`), 'utf8'));
const keys = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' ? keys(v, `${p}${k}.`) : [`${p}${k}`]));

test('every devices string exists, non-empty, in all three locales', () => {
  const want = [...keys(read('en').devices, 'devices.'), 'settings.nav.devices'];
  assert.ok(want.length >= 25, `only ${want.length} keys`);
  for (const l of LOCALES) {
    const loc = read(l);
    for (const k of want) {
      const v = k.split('.').reduce((o, part) => o?.[part], loc);
      assert.equal(typeof v === 'string' && v.length > 0, true, `${l}: ${k}`);
    }
  }
});

test('the {{path}} and {{device}} placeholders survive translation', () => {
  for (const l of LOCALES) {
    const d = read(l).devices;
    assert.ok(d.items.folder.includes('{{path}}'), `${l}: devices.items.folder`);
    assert.ok(d.runsOnHint.includes('{{device}}'), `${l}: devices.runsOnHint`);
  }
});

test('a device in use cannot be removed; a card greys unless its device is online', () => {
  assert.equal(deviceInUse([{ device: 'my-lap' }, {}], 'my-lap'), true);
  assert.equal(deviceInUse([{ device: 'other' }], 'my-lap'), false);
  const states = { 'my-lap': { id: 'my-lap', state: 'online' }, b: { id: 'b', state: 'connecting' } };
  assert.equal(deviceOffline(undefined, states), false, 'an agent on this laptop is never "offline"');
  assert.equal(deviceOffline('my-lap', states), false);
  assert.equal(deviceOffline('b', states), true);
  assert.equal(deviceOffline('unknown', states), true);
});

// Source-level checks: comments stripped so prose naming a call cannot pass
// for the call itself.
const src = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

test('the move and add errors exist in all three locales', () => {
  for (const l of LOCALES) {
    const d = read(l).devices;
    for (const k of ['errOffline', 'errUser']) assert.ok(typeof d[k] === 'string' && d[k].length > 0, `${l}: devices.${k}`);
    assert.ok(d.errOffline.includes('{{device}}'), `${l}: devices.errOffline keeps {{device}}`);
  }
});

test('Edit Agent offers "Runs on" to Claude agents only and refuses a move to a device that is not online', () => {
  const code = src('src/renderer/src/components/EditAgentModal.tsx');
  assert.match(code, /isClaudeProvider\(provider\)\s*&&\s*\(config\?\.devices \?\? \[\]\)\.length > 0/, 'picker gated on Claude');
  const save = code.slice(code.indexOf('const save = '));
  const guard = save.search(/deviceOffline\(device \|\| undefined, useDeviceStates\.getState\(\)\.states\)/);
  assert.ok(guard > 0, 'save checks the target device state');
  assert.match(save.slice(guard, guard + 300), /setMoveError\(t\('devices\.errOffline'[\s\S]*?return;/, 'refuses with the localized error');
  assert.ok(guard < save.indexOf('updateAgent('), 'refuses before anything is stored');
  assert.ok(guard < save.indexOf('restartAgentProcess('), 'refuses before the agent is restarted');
});

test('Settings → Devices validates the user and shows a failed save', () => {
  const code = src('src/renderer/src/components/DevicesSettings.tsx');
  assert.match(code, /user && !isValidDeviceUser\(user\)\) \{ setError\(t\('devices\.errUser'\)\); return; \}/);
  assert.match(code, /catch \(e\) \{\s*setError\(/, 'a rejected updateConfig lands in the error line');
});

test('restart and restore carry the agent\'s device to main', () => {
  assert.match(src('src/renderer/src/workspace/agents/restartAgent.ts'), /device: a\.device \?\? ''/);
  assert.match(src('src/renderer/src/hooks/useRestoreTeam.ts'), /device: a\.device \?\? ''/);
});
