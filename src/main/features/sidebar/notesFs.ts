/**
 * The sidebar's notes on disk — `<harnessHome>/hive/notes/<slug>.md`.
 *
 * Split from ../sidebar.ts (the IPC + watcher + floors module) so the file
 * logic has no Electron import and node:test can drive it against a temp
 * folder (test/ws-sidebar-notes-fs.test.cjs).
 *
 * The rules every function here keeps:
 *   - The renderer names a note by SLUG only, and a slug is validated
 *     (isValidNoteSlug: lower-case ASCII and hyphens) before it is joined to
 *     anything, then the joined path is asserted to sit directly in the folder.
 *   - Nothing is followed through a symlink: not the notes folder (an agent can
 *     write anywhere in the hive, including swapping `notes/` for a link to
 *     somewhere else), and not a note file (its target could be any file).
 *   - Writes are atomic (temp file + rename, like hive.ts), so an agent reading
 *     a note, or the hive's git commit, sees the old note or the new one.
 *   - Writes are versioned by mtime: a save carrying the mtime the editor
 *     loaded is refused as a `conflict` when the file changed since — an agent's
 *     edit is never silently overwritten.
 */
import {
  existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync,
  renameSync, unlinkSync, writeFileSync, type Stats
} from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  MAX_NOTES,
  NOTE_BODY_MAX,
  NOTE_QUERY_MAX,
  cleanNoteTitle,
  isNoteRenameRequest,
  isNoteWriteRequest,
  isValidNoteSlug,
  noteExcerpt,
  parseNoteFile,
  rankNotes,
  serializeNote,
  slugifyNoteTitle,
  uniqueSlug,
  type NoteDeleteResult,
  type NoteDoc,
  type NoteErrorCode,
  type NoteMeta,
  type NoteReadResult,
  type NotesListResult,
  type NotesSearchResult,
  type NoteWriteResult,
  type SearchableNote
} from '../../../shared/workspace/sidebarNotes';

/** `<harnessHome>/hive` and `<harnessHome>/hive/notes`. */
export interface NoteDirs {
  hive: string;
  notes: string;
}

const NOTE_FILE = /^([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/;
/** A note file larger than this on disk (written by hand or by an agent) is
 *  listed under its slug but its body is not loaded — UTF-8 is up to 4 bytes
 *  per character. */
const NOTE_FILE_BYTES_MAX = NOTE_BODY_MAX * 4;

type NoteFailure = { ok: false; error: NoteErrorCode; message?: string };

const fail = (error: NoteErrorCode, message?: string): NoteFailure =>
  (message ? { ok: false, error, message } : { ok: false, error });

const errMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** `<home>/hive` + its notes folder, or null when there is no hive to keep
 *  notes in. The hive folder must already exist — creating one is hive.ts's job. */
export function noteDirsFor(harnessHome: string | null | undefined): NoteDirs | null {
  if (!harnessHome) return null;
  const hive = join(harnessHome, 'hive');
  if (!existsSync(hive)) return null;
  return { hive, notes: join(hive, 'notes') };
}

/**
 * The notes folder as a REAL path inside the real hive, or an error. Missing
 * is fine for reads (an empty list) and created for writes.
 */
function realNotesDir(dirs: NoteDirs, create: boolean): { dir: string; exists: boolean } | NoteFailure {
  try {
    if (!existsSync(dirs.notes)) {
      if (!create) return { dir: dirs.notes, exists: false };
      mkdirSync(dirs.notes, { recursive: true });
    }
    const st = lstatSync(dirs.notes);
    if (st.isSymbolicLink() || !st.isDirectory()) return fail('io', 'hive/notes is not a folder');
    const realHive = realpathSync(dirs.hive);
    const realNotes = realpathSync(dirs.notes);
    if (!realNotes.startsWith(realHive + sep)) return fail('io', 'hive/notes points outside the hive');
    return { dir: realNotes, exists: true };
  } catch (e) {
    return fail('io', errMessage(e));
  }
}

/** The file for a validated slug, asserted to sit directly in `dir`. */
function notePath(dir: string, slug: string): string | null {
  if (!isValidNoteSlug(slug)) return null;
  const p = resolve(dir, `${slug}.md`);
  return p.startsWith(resolve(dir) + sep) ? p : null;
}

/** lstat, or null for missing / not a regular file / a symlink. */
function regularFile(p: string): Stats | null {
  try {
    const st = lstatSync(p);
    return st.isFile() && !st.isSymbolicLink() ? st : null;
  } catch {
    return null;
  }
}

/** Parsed-file cache keyed by path, invalidated by mtime + size. Search reads
 *  every note on each (debounced) keystroke; this keeps that to one stat per
 *  unchanged file. */
const cache = new Map<string, { mtimeMs: number; size: number; title: string; body: string }>();

function loadNote(dir: string, slug: string): NoteDoc | null {
  const p = notePath(dir, slug);
  if (!p) return null;
  const st = regularFile(p);
  if (!st) { cache.delete(p); return null; }
  let entry = cache.get(p);
  if (!entry || entry.mtimeMs !== st.mtimeMs || entry.size !== st.size) {
    if (st.size > NOTE_FILE_BYTES_MAX) {
      entry = { mtimeMs: st.mtimeMs, size: st.size, title: slug, body: '' };
    } else {
      const parsed = parseNoteFile(slug, readFileSync(p, 'utf8'));
      entry = { mtimeMs: st.mtimeMs, size: st.size, title: parsed.title, body: parsed.body };
    }
    cache.set(p, entry);
  }
  return {
    slug,
    title: entry.title,
    body: entry.body,
    updatedAt: entry.mtimeMs,
    excerpt: noteExcerpt(entry.body),
    path: p
  };
}

/** Every slug with a regular `.md` file in `dir`. */
function allSlugs(dir: string): Array<{ slug: string; mtime: number }> {
  if (!existsSync(dir)) return [];
  const found: Array<{ slug: string; mtime: number }> = [];
  for (const name of readdirSync(dir)) {
    const m = NOTE_FILE.exec(name);
    if (!m || !isValidNoteSlug(m[1])) continue;
    const st = regularFile(join(dir, name));
    if (st) found.push({ slug: m[1], mtime: st.mtimeMs });
  }
  return found;
}

/** Note slugs, newest first, capped at MAX_NOTES. */
function listSlugs(dir: string): { slugs: string[]; truncated: boolean } {
  const found = allSlugs(dir);
  found.sort((a, b) => b.mtime - a.mtime || a.slug.localeCompare(b.slug));
  return { slugs: found.slice(0, MAX_NOTES).map((f) => f.slug), truncated: found.length > MAX_NOTES };
}

/** Every name a new note must not take: any `<slug>.md` entry, file or not. */
function takenSlugs(dir: string, except?: string): Set<string> {
  const out = new Set<string>();
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const m = NOTE_FILE.exec(name);
    if (m && m[1] !== except) out.add(m[1]);
  }
  return out;
}

/** Temp file + rename. On Windows `renameSync` replaces an existing target
 *  (MoveFileEx with REPLACE_EXISTING), so this is the same everywhere. */
function atomicWrite(dir: string, slug: string, content: string): void {
  const final = join(dir, `${slug}.md`);
  const tmp = join(dir, `.${slug}.md.tmp-${randomBytes(4).toString('hex')}`);
  try {
    writeFileSync(tmp, content, 'utf8');
    renameSync(tmp, final);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* never created */ }
    throw e;
  }
}

/** The mtime the editor loaded vs. the one on disk. A 1ms slack absorbs
 *  filesystems that round mtimes on the way back out. */
function versionMatches(expected: number | undefined, actual: number): boolean {
  return expected === undefined || Math.abs(expected - actual) <= 1;
}

// ─── Operations ─────────────────────────────────────────────────────────────

/** `onDir` is told the real folder whenever one is resolved (the IPC module
 *  points its watcher at it). */
export interface NoteOpsOptions {
  onDir?: (dir: string) => void;
}

export function listNotes(dirs: NoteDirs | null, opts: NoteOpsOptions = {}): NotesListResult {
  if (!dirs) return fail('no-hive');
  const real = realNotesDir(dirs, false);
  if ('error' in real) return real;
  try {
    if (real.exists) opts.onDir?.(real.dir);
    const { slugs, truncated } = listSlugs(real.dir);
    const notes: NoteMeta[] = [];
    for (const slug of slugs) {
      const n = loadNote(real.dir, slug);
      if (n) notes.push({ slug: n.slug, title: n.title, updatedAt: n.updatedAt, excerpt: n.excerpt });
    }
    return { ok: true, notes, dir: real.dir, truncated };
  } catch (e) {
    return fail('io', errMessage(e));
  }
}

export function readNote(dirs: NoteDirs | null, slug: unknown): NoteReadResult {
  if (!isValidNoteSlug(slug)) return fail('invalid');
  if (!dirs) return fail('no-hive');
  const real = realNotesDir(dirs, false);
  if ('error' in real) return real;
  try {
    const note = loadNote(real.dir, slug);
    return note ? { ok: true, note } : fail('not-found');
  } catch (e) {
    return fail('io', errMessage(e));
  }
}

/** Create (no slug: a new file named from the title) or overwrite one note. */
export function writeNote(dirs: NoteDirs | null, req: unknown, opts: NoteOpsOptions = {}): NoteWriteResult {
  if (!isNoteWriteRequest(req)) return fail('invalid');
  if (!dirs) return fail('no-hive');
  const real = realNotesDir(dirs, true);
  if ('error' in real) return real;
  try {
    opts.onDir?.(real.dir);
    let slug = req.slug;
    let title = cleanNoteTitle(req.title);
    if (slug) {
      const p = notePath(real.dir, slug);
      const st = p ? regularFile(p) : null;
      if (!st) return fail('not-found');
      if (!versionMatches(req.expectedUpdatedAt, st.mtimeMs)) {
        return { ok: false, error: 'conflict', current: loadNote(real.dir, slug) ?? undefined };
      }
      if (!title) title = loadNote(real.dir, slug)?.title ?? slug;
    } else {
      if (allSlugs(real.dir).length >= MAX_NOTES) return fail('invalid', `at most ${MAX_NOTES} notes`);
      slug = uniqueSlug(slugifyNoteTitle(title), takenSlugs(real.dir));
    }
    atomicWrite(real.dir, slug, serializeNote(title, req.body));
    const note = loadNote(real.dir, slug);
    return note ? { ok: true, note } : fail('io', 'the note did not land on disk');
  } catch (e) {
    return fail('io', errMessage(e));
  }
}

/**
 * Rename = a new title AND, when the title slugs differently, a new filename,
 * so the file an agent finds still says what it is. The body is re-read from
 * disk here (never sent by the renderer), so a rename cannot revert an edit.
 */
export function renameNote(dirs: NoteDirs | null, req: unknown): NoteWriteResult {
  if (!isNoteRenameRequest(req)) return fail('invalid');
  const title = cleanNoteTitle(req.title);
  if (!title) return fail('invalid');
  if (!dirs) return fail('no-hive');
  const real = realNotesDir(dirs, false);
  if ('error' in real) return real;
  try {
    const current = loadNote(real.dir, req.slug);
    if (!current) return fail('not-found');
    const base = slugifyNoteTitle(title);
    // Keep the filename when the new title slugs to the same name, or only to
    // the generic fallback (a Chinese or Arabic title) — a heading-only rename.
    const nextSlug = base === req.slug || base === 'note' ? req.slug : uniqueSlug(base, takenSlugs(real.dir, req.slug));
    atomicWrite(real.dir, nextSlug, serializeNote(title, current.body));
    if (nextSlug !== req.slug) {
      try { unlinkSync(current.path); } catch { /* the new file is in place; a stale copy is the lesser harm */ }
      cache.delete(current.path);
    }
    const note = loadNote(real.dir, nextSlug);
    return note ? { ok: true, note } : fail('io', 'the note did not land on disk');
  } catch (e) {
    return fail('io', errMessage(e));
  }
}

export function deleteNote(dirs: NoteDirs | null, slug: unknown): NoteDeleteResult {
  if (!isValidNoteSlug(slug)) return fail('invalid');
  if (!dirs) return fail('no-hive');
  const real = realNotesDir(dirs, false);
  if ('error' in real) return real;
  const p = notePath(real.dir, slug);
  if (!p || !regularFile(p)) return fail('not-found');
  try {
    // The hive is a git repo main commits, so a deleted note stays in history.
    unlinkSync(p);
    cache.delete(p);
    return { ok: true };
  } catch (e) {
    return fail('io', errMessage(e));
  }
}

export function searchNotes(dirs: NoteDirs | null, query: unknown): NotesSearchResult {
  if (typeof query !== 'string') return fail('invalid');
  if (!dirs) return fail('no-hive');
  const real = realNotesDir(dirs, false);
  if ('error' in real) return real;
  try {
    const { slugs } = listSlugs(real.dir);
    const all: SearchableNote[] = [];
    for (const slug of slugs) {
      const n = loadNote(real.dir, slug);
      if (n) all.push({ slug: n.slug, title: n.title, body: n.body, updatedAt: n.updatedAt });
    }
    return { ok: true, hits: rankNotes(all, query.slice(0, NOTE_QUERY_MAX)) };
  } catch (e) {
    return fail('io', errMessage(e));
  }
}
