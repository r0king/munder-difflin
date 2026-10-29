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
