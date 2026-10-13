'use strict';

/**
 * The puck's tray (main-owned) and the Stapler's persisted settings. "Up to
 * eight shots go in one send"; screenshots, PDFs, videos and folders ride one
 * message; nothing read back from disk can put the puck off screen.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const d = loadTs('src/main/features/stapler/draft.ts');
const st = loadTs('src/main/features/stapler/settings.ts');
const { MAX_SHOTS, MAX_ATTACHMENTS } = loadTs('src/shared/features/stapler.ts');

const shot = (i) => ({ id: `s${i}`, kind: 'shot', path: `/shots/shot-${i}.png`, name: `shot-${i}.png` });
const file = (i, name = `f${i}.pdf`) => ({ id: `f${i}`, kind: 'pdf', path: `/docs/${name}`, name });

test('classifyAttachment by extension; directories are folders', () => {
  assert.equal(d.classifyAttachment('Spec.PDF', false), 'pdf');
  assert.equal(d.classifyAttachment('demo.mov', false), 'video');
  assert.equal(d.classifyAttachment('screen.webp', false), 'image');
  assert.equal(d.classifyAttachment('notes.txt', false), 'file');
  assert.equal(d.classifyAttachment('Makefile', false), 'file');
  assert.equal(d.classifyAttachment('photos.png', true), 'folder');
});

test('the ninth shot is refused; other attachments still fit', () => {
  let draft = d.emptyDraft();
  for (let i = 0; i < MAX_SHOTS; i++) draft = d.addAttachments(draft, [shot(i)], 'linux').draft;
  const res = d.addAttachments(draft, [shot(99), file(1)], 'linux');
  assert.deepEqual(res.rejected, [{ path: '/shots/shot-99.png', reason: 'shot-limit' }]);
  assert.equal(res.added.length, 1);
  assert.equal(d.shotCount(res.draft), MAX_SHOTS);
});

test('total attachments are capped, duplicates dropped (case-insensitive off Linux)', () => {
  let draft = d.emptyDraft();
  const many = Array.from({ length: MAX_ATTACHMENTS + 3 }, (_, i) => file(i));
  const res = d.addAttachments(draft, many, 'linux');
  assert.equal(res.draft.attachments.length, MAX_ATTACHMENTS);
  assert.equal(res.rejected.filter((r) => r.reason === 'attachment-limit').length, 3);

  draft = d.addAttachments(d.emptyDraft(), [file(1, 'A.pdf')], 'darwin').draft;
  assert.equal(d.addAttachments(draft, [file(2, 'a.pdf')], 'darwin').rejected[0].reason, 'duplicate');
  assert.equal(d.addAttachments(draft, [file(2, 'a.pdf')], 'linux').added.length, 1);
});

test('removeAttachment returns what it removed', () => {
  const draft = d.addAttachments(d.emptyDraft(), [shot(1), file(2)], 'linux').draft;
  const res = d.removeAttachment(draft, 's1');
  assert.equal(res.removed.kind, 'shot');
  assert.deepEqual(res.draft.attachments.map((a) => a.id), ['f2']);
  assert.equal(d.removeAttachment(draft, 'nope').removed, null);
});

test('sanitizeDraft keeps only well-formed items whose files still exist', () => {
  const raw = {
    attachments: [
      { ...shot(1), thumb: 'data:image/png;base64,AAAA', width: 10, height: 10 },
      { ...file(2), thumb: 'data:image/png;base64,AAAA' },
      { ...file(3) },
      { id: 'x', kind: 'exe', path: '/x', name: 'x' },
      'junk'
    ]
  };
  const out = d.sanitizeDraft(raw, (p) => p !== '/docs/f3.pdf');
  assert.deepEqual(out.attachments.map((a) => a.id), ['s1', 'f2']);
  assert.equal(out.attachments[0].thumb, 'data:image/png;base64,AAAA');
  assert.equal(out.attachments[1].thumb, undefined);
  assert.deepEqual(d.sanitizeDraft(null, () => true), { attachments: [] });
});

test('settings: defaults for garbage, nested values re-validated', () => {
  assert.deepEqual(st.sanitizeSettings(null), st.DEFAULT_SETTINGS);
  const s = st.sanitizeSettings({
    enabled: 'yes',
    invisible: true,
    placement: { positions: { '1': { dx: 10, dy: 20 }, '2': 'bad' }, lastDisplayId: '1' },
    lastTarget: { kind: 'agent', agentId: 'jim', sneaky: true },
    regions: { '1': { x: 10, y: 10, width: 300, height: 200 }, '2': { x: 0, y: 0, width: 1, height: 1 } }
  });
  assert.equal(s.enabled, false);
  assert.equal(s.invisible, true);
  assert.deepEqual(s.placement, { positions: { '1': { dx: 10, dy: 20 } }, lastDisplayId: '1' });
  assert.deepEqual(s.lastTarget, { kind: 'agent', agentId: 'jim' });
  assert.deepEqual(Object.keys(s.regions), ['1']);
  assert.deepEqual(st.sanitizeSettings({ lastTarget: { kind: 'all' } }).lastTarget, { kind: 'orchestrator' });
});
