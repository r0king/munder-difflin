/**
 * The sidebar's notes — the user's own quick markdown notes, one file each at
 * `<harnessHome>/hive/notes/<slug>.md` so every agent on the floor can read
 * them by path.
 *
 * Everything here is shared by main (which owns the files and validates every
 * name that crosses IPC) and the renderer (which slugs a new title the same way
 * main will, and ranks nothing itself — search runs in main over the files).
 *
 * The file format is plain markdown an agent can read without knowing about
 * this module: an optional `# Title` first line, then the body. A note an agent
 * or a person drops into the folder by hand, with no heading, still lists — its
 * title falls back to the slug.
 *
 * Pure and import-free so node:test can load it.
 */

/** Longest slug (the filename without `.md`). Far under every OS's limit even
 *  with the hive's path in front of it. */
export const NOTE_SLUG_MAX = 64;
/** Longest title. */
export const NOTE_TITLE_MAX = 120;
/** Largest note body we will write, in characters (~256 KB of ASCII). A note,
 *  not a document store. */
export const NOTE_BODY_MAX = 256_000;
/** Most notes listed or searched. */
export const MAX_NOTES = 500;
/** Longest search query. */
export const NOTE_QUERY_MAX = 200;

/** Windows reserves these device names in ANY folder, with or without an
 *  extension — `con.md` cannot be created there. */
const WINDOWS_RESERVED = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9'
]);

/**
 * A slug main will accept as a filename: lower-case ASCII letters and digits
 * separated by single hyphens. That alphabet alone rules out every traversal
 * and separator trick (`..`, `/`, `\`, `:`, NUL), and lower case means two
 * notes can never collide on a case-insensitive disk (macOS, Windows).
 */
export function isValidNoteSlug(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (value.length < 1 || value.length > NOTE_SLUG_MAX) return false;
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) return false;
  return !WINDOWS_RESERVED.has(value);
}

/**
 * A title → a slug candidate. Accents fold to their base letter (`Café` →
 * `cafe`); anything else outside [a-z0-9] becomes a hyphen. A title with no
 * Latin letters at all (Chinese, Arabic) slugs to `note` — the title itself is
 * kept in the file's heading, so nothing the user wrote is lost, and
 * `uniqueSlug` numbers the collisions.
 */
export function slugifyNoteTitle(title: string): string {
  const folded = (title ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  let slug = folded.slice(0, NOTE_SLUG_MAX).replace(/-+$/g, '');
  if (!slug || WINDOWS_RESERVED.has(slug)) slug = slug ? `${slug}-note` : 'note';
  return slug;
}

/** `base`, else `base-2`, `base-3`, … — the first not in `taken`, always a
 *  valid slug (the base is trimmed to leave room for the suffix). */
export function uniqueSlug(base: string, taken: ReadonlySet<string>): string {
  const clean = isValidNoteSlug(base) ? base : slugifyNoteTitle(base);
  if (!taken.has(clean)) return clean;
  for (let n = 2; n < 100_000; n++) {
    const suffix = `-${n}`;
    const head = clean.slice(0, NOTE_SLUG_MAX - suffix.length).replace(/-+$/g, '') || 'note';
    const candidate = `${head}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `note-${Date.now().toString(36)}`;
}

/** One-line, trimmed, length-capped title. Control characters are dropped. */
export function cleanNoteTitle(title: unknown): string {
  if (typeof title !== 'string') return '';
  return title.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, NOTE_TITLE_MAX);
}

export interface ParsedNote {
  title: string;
  body: string;
}

/** Split a note file into its `# Title` line and the body. */
export function parseNoteFile(slug: string, content: string): ParsedNote {
  const text = (content ?? '').replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const m = /^#[ \t]+(.+?)[ \t]*#*[ \t]*(?:\n|$)/.exec(text);
  if (!m) return { title: slug, body: text };
  const body = text.slice(m[0].length).replace(/^\n+/, '');
  return { title: cleanNoteTitle(m[1]) || slug, body };
}

/** The file content for a title and body: `# Title`, a blank line, the body,
 *  one trailing newline. */
export function serializeNote(title: string, body: string): string {
  const t = cleanNoteTitle(title);
  const b = (body ?? '').replace(/\r\n/g, '\n').replace(/\s+$/g, '');
  const head = t ? `# ${t}\n` : '';
  if (!b) return head;
  return head ? `${head}\n${b}\n` : `${b}\n`;
}

/** The first meaningful line of a body, markdown markers stripped, for a list
 *  row's second line. */
export function noteExcerpt(body: string, max = 140): string {
  for (const raw of (body ?? '').split('\n')) {
    const line = raw
      .replace(/^\s{0,3}(?:#{1,6}\s+|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+|>\s?)/, '')
      .replace(/[`*_~]/g, '')
      .trim();
    if (line) return line.length > max ? `${line.slice(0, max - 1)}…` : line;
  }
  return '';
}

// ─── Search ─────────────────────────────────────────────────────────────────

export interface SearchableNote {
  slug: string;
  title: string;
  body: string;
  updatedAt: number;
}

export interface NoteSearchHit {
  slug: string;
  title: string;
  updatedAt: number;
  score: number;
  /** A stretch of body text around the first match ('' when only the title
   *  matched), with `matchStart`/`matchLength` locating the match inside it. */
  snippet: string;
  matchStart: number;
  matchLength: number;
}

/** Lower-case and fold accents, keeping string length stable enough for
 *  snippet offsets (NFKD can lengthen a string, so offsets are recomputed on
 *  the original text, see `findCaseless`). */
function fold(s: string): string {
  return s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** Split a query into terms: whitespace-separated, deduplicated, folded. CJK
 *  text has no spaces, so a Chinese query is one term matched as a substring —
 *  which is the right behaviour for it. */
export function queryTerms(query: string): string[] {
  const terms = fold((query ?? '').slice(0, NOTE_QUERY_MAX)).split(/\s+/).filter(Boolean);
  return [...new Set(terms)];
}

function countOccurrences(hay: string, needle: string, cap: number): number {
  if (!needle) return 0;
  let n = 0;
  let i = hay.indexOf(needle);
  while (i >= 0 && n < cap) {
    n++;
    i = hay.indexOf(needle, i + needle.length);
  }
  return n;
}

/** Index of `term` in `text` ignoring case and accents, on the ORIGINAL text. */
function findCaseless(text: string, term: string): number {
  const lower = text.toLowerCase();
  const direct = lower.indexOf(term);
  if (direct >= 0) return direct;
  // Accent-folded match: walk the original so the offset is real.
  for (let i = 0; i < text.length; i++) {
    if (fold(text.slice(i, i + term.length + 4)).startsWith(term)) return i;
  }
  return -1;
}

function snippetAround(body: string, at: number, length: number, radius = 48): { snippet: string; start: number } {
  const from = Math.max(0, at - radius);
  const to = Math.min(body.length, at + length + radius);
  let snippet = body.slice(from, to).replace(/\s+/g, ' ');
  // Re-find the match in the whitespace-collapsed snippet.
  const prefix = body.slice(from, at).replace(/\s+/g, ' ');
  let start = prefix.length;
  if (from > 0) { snippet = `…${snippet}`; start += 1; }
  if (to < body.length) snippet = `${snippet}…`;
  return { snippet, start };
}

/**
 * Rank notes against a query. Every term must appear in the title or the body
 * (AND), so adding a word narrows the list the way people expect.
 *
 * Score, highest first:
 *   - the whole query is the title                      +100
 *   - the title starts with the whole query              +60
 *   - each term in the title                             +20 (+10 at a word start)
 *   - each term in the body                              +6, +1 per further
 *                                                        occurrence (max +5)
 * Ties go to the most recently updated note. An empty query returns every note,
 * newest first, with score 0 — the list view.
 */
export function rankNotes(notes: readonly SearchableNote[], query: string, limit = 50): NoteSearchHit[] {
  const terms = queryTerms(query);
  const whole = terms.join(' ');
  const hits: NoteSearchHit[] = [];
  for (const n of notes) {
    if (!terms.length) {
      hits.push({ slug: n.slug, title: n.title, updatedAt: n.updatedAt, score: 0, snippet: '', matchStart: 0, matchLength: 0 });
      continue;
    }
    const title = fold(n.title);
    const body = fold(n.body);
    let score = 0;
    let ok = true;
    for (const term of terms) {
      const inTitle = title.indexOf(term);
      const inBody = body.indexOf(term);
      if (inTitle < 0 && inBody < 0) { ok = false; break; }
      if (inTitle >= 0) {
        score += 20;
        if (inTitle === 0 || /[\s\-_/.,:;([]/.test(title[inTitle - 1] ?? '')) score += 10;
      }
      if (inBody >= 0) score += 6 + Math.min(5, countOccurrences(body, term, 6) - 1);
    }
    if (!ok) continue;
    if (title === whole) score += 100;
    else if (title.startsWith(whole)) score += 60;

    // Snippet: the first body match of the first term that has one.
    let snippet = '';
    let matchStart = 0;
    let matchLength = 0;
    for (const term of terms) {
      const at = findCaseless(n.body, term);
      if (at < 0) continue;
      const s = snippetAround(n.body, at, term.length);
      snippet = s.snippet;
      matchStart = s.start;
      matchLength = term.length;
      break;
    }
    hits.push({ slug: n.slug, title: n.title, updatedAt: n.updatedAt, score, snippet, matchStart, matchLength });
  }
  hits.sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt || a.slug.localeCompare(b.slug));
  return hits.slice(0, Math.max(0, limit));
}

// ─── IPC payload validation (main side) ─────────────────────────────────────

export interface NoteWriteRequest {
  /** Existing note to overwrite; omitted to create a new one from `title`. */
  slug?: string;
  title: string;
  body: string;
  /** The file's mtime the editor loaded. A mismatch means someone (an agent)
   *  changed the note since — main refuses with `conflict` instead of
   *  silently overwriting their edit. Omit to force. */
  expectedUpdatedAt?: number;
}

export function isNoteWriteRequest(value: unknown): value is NoteWriteRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  if (r.slug !== undefined && !isValidNoteSlug(r.slug)) return false;
  if (typeof r.title !== 'string' || r.title.length > NOTE_TITLE_MAX * 4) return false;
  if (typeof r.body !== 'string' || r.body.length > NOTE_BODY_MAX) return false;
  if (r.expectedUpdatedAt !== undefined && (typeof r.expectedUpdatedAt !== 'number' || !Number.isFinite(r.expectedUpdatedAt))) return false;
  return true;
}

export interface NoteRenameRequest {
  slug: string;
  title: string;
}

export function isNoteRenameRequest(value: unknown): value is NoteRenameRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  return isValidNoteSlug(r.slug) && typeof r.title === 'string' && r.title.length <= NOTE_TITLE_MAX * 4;
}
