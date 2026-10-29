'use strict';
/**
 * Devices phase 2, item 8: the control page's two config keys, sanitised on
 * write, and its strings in every locale.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'md-remote-floor-config-'));
const electron = require.resolve('electron');
require.cache[electron] = {
  id: electron, filename: electron, loaded: true,
  exports: { app: { getPath: () => userData }, Notification: class { show() {} static isSupported() { return false; } } }
};
test.after(() => fs.rmSync(userData, { recursive: true, force: true }));
const { writeConfig, readConfig } = loadTs('src/main/config.ts');

test('off by default; the toggle and a good port survive a round trip', () => {
  writeConfig({});
  assert.notEqual(readConfig().remoteFloorEnabled, true);
  writeConfig({ remoteFloorEnabled: true, remoteFloorPort: 47981 });
  assert.equal(readConfig().remoteFloorEnabled, true);
  assert.equal(readConfig().remoteFloorPort, 47981);
});

test('a bad port is dropped, which means the default', () => {
  for (const bad of [80, 70000, 1.5, '47980', null]) {
    writeConfig({ remoteFloorPort: 47981 });
    writeConfig({ remoteFloorPort: bad });
    assert.equal(readConfig().remoteFloorPort, undefined, String(bad));
  }
  writeConfig({ remoteFloorEnabled: 'yes' });
  assert.equal(readConfig().remoteFloorEnabled, false, 'only true turns it on');
});

test('the control page strings exist in every locale, {{url}} kept', () => {
  for (const l of ['en', 'ar', 'zh-CN']) {
    const r = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src/renderer/src/i18n/locales', `${l}.json`), 'utf8')).remoteFloor;
    for (const k of ['toggle', 'hint', 'address', 'waiting']) assert.equal(typeof r?.[k], 'string', `${l}: remoteFloor.${k}`);
    assert.ok(r.address.includes('{{url}}'), `${l}: {{url}}`);
  }
});
