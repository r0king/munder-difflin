'use strict';

// Workspace sidebar notes, the disk half (src/main/features/sidebar/notesFs.ts)
// against a real temp hive: create/read/rename/delete/search, the mtime
// conflict that protects an agent's concurrent edit, and the containment rules
// (slug-only names, no symlinks followed) that keep the renderer inside
// <harnessHome>/hive/notes.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const notesFs = loadTs('src/main/features/sidebar/notesFs.ts');

const temps = [];
test.after(() => {
  for (const dir of temps) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

function tempHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ws sidebar notes '));
  temps.push(home);
  fs.mkdirSync(path.join(home, 'hive'));
  return home;
}

function canSymlink(dir) {
  try {
    const target = path.join(dir, 'probe-target');
    fs.writeFileSync(target, 'x');
    fs.symlinkSync(target, path.join(dir, 'probe-link'));
    fs.unlinkSync(path.join(dir, 'probe-link'));
    fs.unlinkSync(target);
    return true;
  } catch {
    return false;
  }
}

test('no hive open → no-hive, for every operation', () => {
  assert.equal(notesFs.noteDirsFor(null), null);
  const missing = notesFs.noteDirsFor(path.join(os.tmpdir(), 'definitely-not-a-hive-home-xyz'));
  assert.equal(missing, null);
  assert.deepEqual(notesFs.listNotes(null), { ok: false, error: 'no-hive' });
  assert.equal(notesFs.writeNote(null, { title: 't', body: '' }).error, 'no-hive');
  assert.equal(notesFs.searchNotes(null, 'x').error, 'no-hive');
});

test('an empty hive lists no notes without creating the folder', () => {
  const home = tempHome();
  const dirs = notesFs.noteDirsFor(home);
  const res = notesFs.listNotes(dirs);
  assert.equal(res.ok, true);
  assert.deepEqual(res.notes, []);
  assert.equal(fs.existsSync(dirs.notes), false);
});

test('create → read → list → search → rename → delete, on a path with spaces', () => {
  const home = tempHome();
  const dirs = notesFs.noteDirsFor(home);
  const seen = [];
  const created = notesFs.writeNote(dirs, { title: 'Standup notes', body: 'Ship the login fix.' }, { onDir: (d) => seen.push(d) });
  assert.equal(created.ok, true);
  assert.equal(created.note.slug, 'standup-notes');
  assert.equal(fs.readFileSync(path.join(dirs.notes, 'standup-notes.md'), 'utf8'), '# Standup notes\n\nShip the login fix.\n');
  assert.equal(seen.length, 1, 'the watcher hook learns the folder');

  // Same title again → numbered, not overwritten.
  const second = notesFs.writeNote(dirs, { title: 'Standup notes', body: 'Second.' });
  assert.equal(second.note.slug, 'standup-notes-2');

  const read = notesFs.readNote(dirs, 'standup-notes');
  assert.equal(read.ok, true);
  assert.equal(read.note.body, 'Ship the login fix.\n');
  assert.ok(path.isAbsolute(read.note.path));

  const list = notesFs.listNotes(dirs);
  assert.deepEqual(list.notes.map((n) => n.slug).sort(), ['standup-notes', 'standup-notes-2']);

  const search = notesFs.searchNotes(dirs, 'login');
  assert.deepEqual(search.hits.map((h) => h.slug), ['standup-notes']);

  const renamed = notesFs.renameNote(dirs, { slug: 'standup-notes', title: 'Monday standup' });
  assert.equal(renamed.ok, true);
  assert.equal(renamed.note.slug, 'monday-standup');
  assert.equal(renamed.note.body, 'Ship the login fix.\n');
  assert.equal(fs.existsSync(path.join(dirs.notes, 'standup-notes.md')), false);

  // A title with no Latin letters renames the heading and keeps the file.
  const zh = notesFs.renameNote(dirs, { slug: 'monday-standup', title: '周一站会' });
  assert.equal(zh.note.slug, 'monday-standup');
  assert.equal(zh.note.title, '周一站会');

  assert.deepEqual(notesFs.deleteNote(dirs, 'monday-standup'), { ok: true });
  assert.equal(notesFs.readNote(dirs, 'monday-standup').error, 'not-found');
  assert.equal(notesFs.deleteNote(dirs, 'monday-standup').error, 'not-found');
});

test('a save that lost a race to an agent is a conflict carrying the version on disk', () => {
  const home = tempHome();
  const dirs = notesFs.noteDirsFor(home);
  const { note } = notesFs.writeNote(dirs, { title: 'Plan', body: 'v1' });
  // An agent edits the file behind the editor's back.
  const file = path.join(dirs.notes, 'plan.md');
  fs.writeFileSync(file, '# Plan\n\nagent edit\n');
  const later = new Date(note.updatedAt + 5000);
  fs.utimesSync(file, later, later);

  const res = notesFs.writeNote(dirs, { slug: 'plan', title: 'Plan', body: 'my edit', expectedUpdatedAt: note.updatedAt });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'conflict');
  assert.equal(res.current.body, 'agent edit\n');
  assert.equal(fs.readFileSync(file, 'utf8'), '# Plan\n\nagent edit\n', 'nothing was overwritten');

  // Saving against the version now on disk succeeds.
  const ok = notesFs.writeNote(dirs, { slug: 'plan', title: 'Plan', body: 'merged', expectedUpdatedAt: res.current.updatedAt });
  assert.equal(ok.ok, true);
  assert.equal(ok.note.body, 'merged\n');
});

test('writes leave no temp files behind', () => {
  const home = tempHome();
  const dirs = notesFs.noteDirsFor(home);
  for (let i = 0; i < 5; i++) notesFs.writeNote(dirs, { title: `n ${i}`, body: 'x' });
  assert.deepEqual(fs.readdirSync(dirs.notes).filter((f) => f.includes('.tmp-')), []);
});

test('renderer-supplied names never leave the notes folder', () => {
  const home = tempHome();
  const dirs = notesFs.noteDirsFor(home);
  fs.writeFileSync(path.join(home, 'secret.md'), '# secret\n');
  for (const slug of ['../secret', '..', '../../etc/passwd', 'a/b', 'C:\\x', '', 'Secret']) {
    assert.equal(notesFs.readNote(dirs, slug).error, 'invalid', slug);
    assert.equal(notesFs.deleteNote(dirs, slug).error, 'invalid', slug);
    assert.equal(notesFs.writeNote(dirs, { slug, title: 't', body: 'b' }).error, 'invalid', slug);
  }
  assert.equal(fs.existsSync(path.join(home, 'secret.md')), true);
  // A title is never a path either.
  const res = notesFs.writeNote(dirs, { title: '../../secret', body: 'b' });
  assert.equal(res.note.slug, 'secret');
  assert.ok(res.note.path.startsWith(fs.realpathSync(dirs.notes)));
});

test('files that are not notes are ignored by the list', () => {
  const home = tempHome();
  const dirs = notesFs.noteDirsFor(home);
  fs.mkdirSync(dirs.notes);
  fs.writeFileSync(path.join(dirs.notes, 'Upper.md'), 'x');
  fs.writeFileSync(path.join(dirs.notes, 'image.png'), 'x');
  fs.writeFileSync(path.join(dirs.notes, '.plan.md.tmp-abcd'), 'x');
  fs.mkdirSync(path.join(dirs.notes, 'folder.md'));
  fs.writeFileSync(path.join(dirs.notes, 'real-note.md'), 'hand written, no heading');
  const list = notesFs.listNotes(dirs);
  assert.deepEqual(list.notes.map((n) => [n.slug, n.title]), [['real-note', 'real-note']]);
});

test('symlinks are never followed: not the folder, not a note', (t) => {
  const home = tempHome();
  if (!canSymlink(home)) { t.skip('symlinks need privileges on this machine'); return; }
  const dirs = notesFs.noteDirsFor(home);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-outside-'));
  temps.push(outside);
  fs.writeFileSync(path.join(outside, 'private.md'), '# private\n');

  // notes/ replaced by a link to somewhere else.
  fs.symlinkSync(outside, dirs.notes, 'dir');
  assert.equal(notesFs.listNotes(dirs).error, 'io');
  assert.equal(notesFs.writeNote(dirs, { title: 'x', body: 'y' }).error, 'io');
  assert.equal(fs.readdirSync(outside).length, 1, 'nothing was written outside the hive');
  fs.unlinkSync(dirs.notes);

  // A note that is a link to a file outside.
  fs.mkdirSync(dirs.notes);
  fs.symlinkSync(path.join(outside, 'private.md'), path.join(dirs.notes, 'leak.md'));
  assert.deepEqual(notesFs.listNotes(dirs).notes, []);
  assert.equal(notesFs.readNote(dirs, 'leak').error, 'not-found');
  assert.equal(notesFs.searchNotes(dirs, 'private').hits.length, 0);
});
