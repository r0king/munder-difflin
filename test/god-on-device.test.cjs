'use strict';
/**
 * Devices phase 2, item 4: god may run on a device. Moving it warns that
 * the floor has no god while that device is offline.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (l) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src/renderer/src/i18n/locales', `${l}.json`), 'utf8'));

test('the god warning names the device in every locale', () => {
  for (const l of ['en', 'ar', 'zh-CN']) {
    const w = read(l).devices.godWarning;
    assert.equal(typeof w, 'string', `${l}: devices.godWarning`);
    assert.ok(w.includes('{{device}}'), `${l}: {{device}} kept`);
  }
});

test('god is offered no Auto, and the main process refuses it too', () => {
  const modal = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/src/components/EditAgentModal.tsx'), 'utf8');
  assert.match(modal, /!agent\.isGod && <option value=\{AUTO_DEVICE\}>/);
  const main = fs.readFileSync(path.join(__dirname, '..', 'src/main/index.ts'), 'utf8');
  assert.match(main, /requested === AUTO_DEVICE && opts\.hive\?\.isGod/);
});
