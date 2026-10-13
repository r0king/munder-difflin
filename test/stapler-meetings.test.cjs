'use strict';

/**
 * The meetings library: "one folder per meeting, searchable and editable".
 * Folder naming and the id gate (the id is the ONLY way a renderer names a
 * folder, so it is the path-containment boundary), transcript.md, search, the
 * text an agent receives, and the store against a real temp directory.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const m = loadTs('src/main/features/stapler/meetings.ts');
const { MeetingStore } = loadTs('src/main/features/stapler/meetingStore.ts');

const rec = (over = {}) => ({
  id: '2026-10-12 1430 meeting',
  title: 'Weekly sync',
  description: '',
  startedAt: '2026-10-12T14:30:00.000Z',
  durationMs: 65_000,
  status: 'ready',
  segments: [],
  updatedAt: '2026-10-12T15:00:00.000Z',
  ...over
});

test('slugify keeps letters of any script, collapses the rest, caps the length', () => {
  assert.equal(m.slugify('Weekly Sync: Q4 / ARR!'), 'weekly-sync-q4-arr');
  assert.equal(m.slugify('周会 计划'), '周会-计划');
  assert.equal(m.slugify('اجتماع الفريق'), 'اجتماع-الفريق');
  assert.equal(m.slugify('...///'), 'meeting');
  assert.equal(m.slugify(''), 'meeting');
  assert.ok(Array.from(m.slugify('a'.repeat(200))).length <= m.MAX_SLUG);
  assert.doesNotMatch(m.slugify('../../etc/passwd'), /[./\\]/);
});

test('meetingFolderName is YYYY-MM-DD HHmm slug in local time', () => {
  const d = new Date(2026, 9, 3, 9, 5);
  assert.equal(m.meetingFolderName(d, 'Design review'), '2026-10-03 0905 design-review');
});

test('uniqueFolderName appends a counter when taken', () => {
  const taken = new Set(['2026-10-03 0905 meeting', '2026-10-03 0905 meeting 2']);
  assert.equal(m.uniqueFolderName('2026-10-03 0905 meeting', (n) => taken.has(n)), '2026-10-03 0905 meeting 3');
  assert.equal(m.uniqueFolderName('x', () => false), 'x');
});

test('isMeetingId accepts what we mint and nothing that could leave the root', () => {
  for (const ok of ['2026-10-03 0905 meeting', '2026-10-03 0905 design-review 2', '2026-10-03 0905 周会-计划']) {
    assert.equal(m.isMeetingId(ok), true, ok);
  }
  for (const bad of ['..', '../2026-10-03 0905 meeting', '2026-10-03 0905 a/b', '2026-10-03 0905 a\\b',
    '2026-10-03 0905 .hidden', '2026-10-03 0905 meeting ', ' 2026-10-03 0905 meeting', 'meeting', '', null, 5]) {
    assert.equal(m.isMeetingId(bad), false, String(bad));
  }
});

test('parseMeetingRecord is tolerant of hand edits but needs a start time', () => {
  assert.equal(m.parseMeetingRecord({ title: 'x' }, 'id'), null);
  const r = m.parseMeetingRecord({ startedAt: '2026-10-12T14:30:00Z', status: 'weird', durationMs: -4, sessionId: 'stapler-mtg-abc-123456' }, 'the-id');
  assert.equal(r.id, 'the-id');
  assert.equal(r.status, 'ready');
  assert.equal(r.durationMs, 0);
  assert.equal(r.sessionId, 'stapler-mtg-abc-123456');
  assert.match(r.title, /^Meeting /);
  const evil = m.parseMeetingRecord({ startedAt: '2026-10-12T14:30:00Z', sessionId: '../../x' }, 'id');
  assert.equal(evil.sessionId, undefined);
});

test('serialize → parse round-trips, and the id is never stored inside', () => {
  const r = rec({ segments: [{ speaker: 'them', startMs: 0, endMs: 900, text: 'Hi' }], engine: 'local' });
  const body = m.serializeMeetingRecord(r);
  assert.equal(JSON.parse(body).id, undefined);
  assert.deepEqual(m.parseMeetingRecord(JSON.parse(body), r.id), r);
});

test('transcript.md says You and Them with timestamps', () => {
  const md = m.renderTranscriptMarkdown(rec({
    description: 'Planning Q4',
    segments: [
      { speaker: 'you', startMs: 0, endMs: 2000, text: 'Shall we start?' },
      { speaker: 'them', startMs: 62_000, endMs: 64_000, text: 'Yes,\nlet us.' }
    ]
  }));
  assert.match(md, /^# Weekly sync\n/);
  assert.match(md, /## Description\n\nPlanning Q4/);
  assert.match(md, /\*\*You\*\* \[0:00\]: Shall we start\?/);
  assert.match(md, /\*\*Them\*\* \[1:02\]: Yes, let us\./);
  assert.match(m.renderTranscriptMarkdown(rec({ status: 'failed' })), /No transcript yet \(failed\)/);
});

test('meetingDeliveryText inlines a short transcript and points at the file for a long one', () => {
  const short = m.meetingDeliveryText(rec({ description: 'd', segments: [{ speaker: 'you', startMs: 0, endMs: 1, text: 'hello' }] }));
  assert.match(short, /^Meeting: Weekly sync/);
  assert.match(short, /Description:\nd/);
  assert.match(short, /Transcript:\nYou: hello/);
  const long = m.meetingDeliveryText(rec({ segments: [{ speaker: 'them', startMs: 0, endMs: 1, text: 'x'.repeat(m.INLINE_TRANSCRIPT_LIMIT + 1) }] }));
  assert.match(long, /attached \(transcript\.md\)/);
  assert.doesNotMatch(long, /xxxxxxxxxx/);
  assert.match(m.meetingDeliveryText(rec()), /no transcript/);
});

test('searchMeetings: AND across title, description and transcript; title hits rank first', () => {
  const a = rec({ id: '2026-10-01 1000 a', title: 'Budget review', startedAt: '2026-10-01T10:00:00Z' });
  const b = rec({ id: '2026-10-05 1000 b', title: 'Standup', description: 'talked budget', startedAt: '2026-10-05T10:00:00Z' });
  const c = rec({ id: '2026-10-09 1000 c', title: 'Sync', startedAt: '2026-10-09T10:00:00Z',
    segments: [{ speaker: 'them', startMs: 0, endMs: 1, text: 'The budget for Kubernetes is tight this quarter' }] });
  const all = [a, b, c];
  assert.deepEqual(m.searchMeetings(all, '').map((x) => x.id), [c.id, b.id, a.id]);
  assert.deepEqual(m.searchMeetings(all, 'BUDGET').map((x) => x.id), [a.id, b.id, c.id]);
  assert.deepEqual(m.searchMeetings(all, 'budget kubernetes').map((x) => x.id), [c.id]);
  assert.deepEqual(m.searchMeetings(all, 'nothing-here'), []);
  const hit = m.searchMeetings(all, 'kubernetes')[0];
  assert.match(hit.snippet, /Kubernetes is tight/);
});

test('MeetingStore: create, finish, edit, search, delete — on disk', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stapler-meetings-'));
  const store = new MeetingStore(() => path.join(root, 'meetings'));
  const created = store.create({ startedAt: new Date(2026, 9, 12, 14, 30) });
  assert.equal(created.id, '2026-10-12 1430 meeting');
  assert.equal(created.status, 'recording');
  const dir = path.join(root, 'meetings', created.id);
  assert.ok(fs.existsSync(path.join(dir, 'meeting.json')));
  assert.ok(fs.existsSync(path.join(dir, 'transcript.md')));

  // A second meeting in the same minute gets its own folder.
  const second = store.create({ startedAt: new Date(2026, 9, 12, 14, 30), sessionId: 'stapler-mtg-xyz-654321' });
  assert.equal(second.id, '2026-10-12 1430 meeting 2');
  // The capture session is known from the start, so a meeting cut off while
  // recording can still be transcribed from the library.
  assert.equal(store.get(second.id).sessionId, 'stapler-mtg-xyz-654321');
  store.markInterrupted();
  assert.equal(store.get(second.id).status, 'interrupted');
  assert.equal(store.get(second.id).sessionId, 'stapler-mtg-xyz-654321');

  store.markTranscribing(created.id, 90_000, 'stapler-mtg-abc-123456');
  assert.equal(store.get(created.id).status, 'transcribing');
  assert.equal(store.get(created.id).sessionId, 'stapler-mtg-abc-123456');

  store.finish(created.id, { durationMs: 90_000, segments: [{ speaker: 'them', startMs: 0, endMs: 5, text: 'Ship it on Friday' }], engine: 'local' });
  const done = store.get(created.id);
  assert.equal(done.status, 'ready');
  assert.equal(done.engine, 'local');
  assert.match(fs.readFileSync(path.join(dir, 'transcript.md'), 'utf8'), /\*\*Them\*\* \[0:00\]: Ship it on Friday/);

  const edited = store.update(created.id, { title: 'Launch call', description: 'Go/no-go', segments: [{ speaker: 'you', startMs: 0, endMs: 5, text: 'Ship it on Monday' }] });
  assert.equal(edited.title, 'Launch call');
  assert.equal(store.get(created.id).segments[0].text, 'Ship it on Monday');
  // The folder name does not change with the title.
  assert.ok(fs.existsSync(dir));

  assert.deepEqual(store.list('monday').map((x) => x.id), [created.id]);
  assert.deepEqual(store.list('').map((x) => x.id).sort(), [created.id, second.id].sort());

  // A failure keeps the old segments and says why.
  store.finish(second.id, { durationMs: 1000, segments: [], error: 'model missing' });
  assert.equal(store.get(second.id).status, 'failed');
  assert.equal(store.get(second.id).error, 'model missing');

  assert.equal(store.remove(second.id), true);
  assert.equal(store.get(second.id), null);
  assert.equal(store.remove('../meetings'), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('MeetingStore picks up a hand edit of meeting.json (mtime cache)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stapler-meetings-'));
  const store = new MeetingStore(() => root);
  const r = store.create({ startedAt: new Date(2026, 0, 2, 3, 4), title: 'Edit me' });
  assert.equal(r.id, '2026-01-02 0304 edit-me');
  assert.equal(store.list('')[0].title, 'Edit me');
  const file = path.join(root, r.id, 'meeting.json');
  const body = JSON.parse(fs.readFileSync(file, 'utf8'));
  body.title = 'Edited by hand';
  fs.writeFileSync(file, JSON.stringify(body) + '\n   ');
  assert.equal(store.list('')[0].title, 'Edited by hand');
  fs.rmSync(root, { recursive: true, force: true });
});

test('MeetingStore refuses symlinked folders and bad ids', { skip: process.platform === 'win32' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stapler-meetings-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'stapler-outside-'));
  fs.writeFileSync(path.join(outside, 'meeting.json'), JSON.stringify({ startedAt: '2026-10-12T14:30:00Z', title: 'secret' }));
  const store = new MeetingStore(() => root);
  fs.symlinkSync(outside, path.join(root, '2026-10-12 1430 linked'));
  assert.equal(store.get('2026-10-12 1430 linked'), null);
  assert.equal(store.remove('2026-10-12 1430 linked'), false);
  assert.ok(fs.existsSync(path.join(outside, 'meeting.json')));
  assert.equal(store.dirFor('../x'), null);
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

test('markInterrupted: what was recording at a crash says so; in-flight ids are spared', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stapler-meetings-'));
  const store = new MeetingStore(() => root);
  const a = store.create({ startedAt: new Date(2026, 0, 1, 1, 1) });
  const b = store.create({ startedAt: new Date(2026, 0, 1, 2, 2) });
  assert.equal(store.markInterrupted(new Set([b.id])), 1);
  assert.equal(store.get(a.id).status, 'interrupted');
  assert.equal(store.get(b.id).status, 'recording');
  fs.rmSync(root, { recursive: true, force: true });
});
