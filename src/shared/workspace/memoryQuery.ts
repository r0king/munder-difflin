/**
 * Exact-match search over the floor's text: query parsing, scoring and
 * snippets. Pure — no fs, no DOM — so main (which scans the files) and the
 * tests share one implementation.
 *
 * "Exact" means the user's own words, literally, case-insensitive: every bare
 * term and every "quoted phrase" must appear in a unit (a ticket, one section
 * of a memory file, one note) for it to match at all. Ranking then prefers a
 * hit in the title, the whole query appearing as typed, whole-word hits over
 * mid-word ones, and a short focused section over a long one that merely
 * contains the words somewhere.
 */
import { MEMORY_QUERY_MAX, type MemorySnippet } from './memoryTypes';

export interface ParsedQuery {
  /** The query as typed, trimmed, whitespace-collapsed and capped. */
  raw: string;
  /** Case-folded raw query without quote marks — the "as typed" bonus needle. */
  whole: string;
  /** Case-folded "quoted phrases" — each required. */
  phrases: string[];
  /** Case-folded bare terms — each required. */
  terms: string[];
}

/** Text prepared once for repeated matching: the original (for display) and a
 *  case-folded copy of EXACTLY the same length (so an index found in one is an
 *  index into the other). */
export interface Prepared {
  text: string;
  folded: string;
}

const MAX_TERMS = 12;
/** Punctuation trimmed off the ends of a bare term. Inner punctuation stays:
 *  `bmt-12`, `auth.ts` and `C++` are all things people search for verbatim. */
const EDGE_PUNCT = /^[\s,.;:!?()[\]{}<>'"“”‘’«»「」『』、。，；：！？]+|[\s,.;:!?()[\]{}<>'"“”‘’«»「」『』、。，；：！？]+$/g;
const QUOTED = /["“”«»「」]([^"“”«»「」]+)["“”«»「」]/g;
const WORD_CHAR = /[\p{L}\p{N}_]/u;

/**
 * Lower-case without ever changing the string's length. `toLowerCase` can
 * (U+0130 'İ' becomes two code units), which would shift every match offset
 * after it; those rare characters are left as they are instead.
 */
export function fold(s: string): string {
  const lower = s.toLowerCase();
  if (lower.length === s.length) return lower;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const l = c.toLowerCase();
    out += l.length === 1 ? l : c;
  }
  return out;
}

export function prepare(text: string): Prepared {
  return { text, folded: fold(text) };
}

/** A term is worth searching for when it has two characters, or one that is
 *  not ASCII (a single CJK character is a word). */
function usableTerm(t: string): boolean {
  if (!t) return false;
  if (t.length >= 2) return true;
  return t.charCodeAt(0) > 0x7f;
}

/** Parse what the user typed. Null when there is nothing searchable in it. */
export function parseQuery(input: string): ParsedQuery | null {
  if (typeof input !== 'string') return null;
  const raw = input.replace(/\s+/g, ' ').trim().slice(0, MEMORY_QUERY_MAX).trim();
  if (!raw) return null;
  const phrases: string[] = [];
  const rest = raw.replace(QUOTED, (_m, inner: string) => {
    const p = fold(inner.replace(/\s+/g, ' ').trim());
    if (p && usableTerm(p) && !phrases.includes(p)) phrases.push(p);
    return ' ';
  });
  const terms: string[] = [];
  for (const piece of rest.split(' ')) {
    const t = fold(piece.replace(EDGE_PUNCT, ''));
    if (!usableTerm(t) || terms.includes(t) || phrases.includes(t)) continue;
    terms.push(t);
    if (terms.length + phrases.length >= MAX_TERMS) break;
  }
  if (!phrases.length && !terms.length) return null;
  const whole = fold(raw.replace(/["“”«»「」]/g, '').replace(/\s+/g, ' ').trim());
  return { raw, whole, phrases: phrases.slice(0, MAX_TERMS), terms };
}

/** Every needle that must match, phrases first. */
export function needlesOf(q: ParsedQuery): string[] {
  return [...q.phrases, ...q.terms];
}

function isWordAt(s: string, i: number): boolean {
  return i >= 0 && i < s.length && WORD_CHAR.test(s[i]);
}

/** Count occurrences of `needle` in `hay` (up to `cap`), and whether at least
 *  one of them sits on word boundaries at both ends. */
export function occurrences(hay: string, needle: string, cap: number): { count: number; whole: boolean; first: number } {
  let count = 0;
  let whole = false;
  let first = -1;
  if (!needle) return { count, whole, first };
  let from = 0;
  while (count < cap) {
    const i = hay.indexOf(needle, from);
    if (i < 0) break;
    if (first < 0) first = i;
    count += 1;
    if (!whole && !isWordAt(hay, i - 1) && !isWordAt(hay, i + needle.length)) whole = true;
    from = i + Math.max(1, needle.length);
  }
  return { count, whole, first };
}

/**
 * Score a unit against the query. 0 means it does not match (some required
 * needle is missing); anything above 0 is comparable across units of every
 * kind, which is what lets tickets, notes and agents be ranked together.
 */
export function scoreUnit(q: ParsedQuery, title: Prepared | null, body: Prepared | null): number {
  const t = title?.folded ?? '';
  const b = body?.folded ?? '';
  if (!t && !b) return 0;
  let score = 0;
  for (const needle of needlesOf(q)) {
    const inTitle = t ? occurrences(t, needle, 3) : { count: 0, whole: false, first: -1 };
    const inBody = b ? occurrences(b, needle, 8) : { count: 0, whole: false, first: -1 };
    if (inTitle.count + inBody.count === 0) return 0;
    let s = (inTitle.count > 0 ? 4 : 0) + Math.log2(1 + inBody.count) * 2;
    // A whole-word hit beats a mid-word one ("log" in "log rotation" over
    // "login"). Never a penalty to zero: scripts without spaces (Chinese)
    // have no word boundaries at all and must still rank by frequency.
    s *= inTitle.whole || inBody.whole ? 1 : 0.7;
    // A phrase the user bothered to quote counts for more than a loose term.
    if (q.phrases.includes(needle)) s *= 1.5;
    score += s;
  }
  const many = q.phrases.length + q.terms.length > 1;
  if (many && q.whole) {
    if (t.includes(q.whole)) score += 6;
    else if (b.includes(q.whole)) score += 3;
  }
  // Gentle length normalisation: a 300-character note that says it beats a
  // 40 KB file that happens to contain the words.
  const len = b.length + t.length;
  score /= 1 + Math.log10(1 + len / 4000);
  return Math.round(score * 1000) / 1000;
}

// ─── Snippets ───────────────────────────────────────────────────────────────

export interface SnippetOptions {
  /** Characters of context on each side of the anchor match. */
  radius?: number;
  /** Hard cap on the snippet's length. */
  max?: number;
}

/** Merge overlapping/adjacent [start, end) ranges. */
export function mergeMarks(marks: Array<[number, number]>): Array<[number, number]> {
  const sorted = marks.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const out: Array<[number, number]> = [];
  for (const m of sorted) {
    const last = out[out.length - 1];
    if (last && m[0] <= last[1]) last[1] = Math.max(last[1], m[1]);
    else out.push([m[0], m[1]]);
  }
  return out;
}

/** Find every needle in `folded`, as merged ranges. */
export function findMarks(folded: string, needles: string[], cap = 24): Array<[number, number]> {
  const marks: Array<[number, number]> = [];
  for (const n of needles) {
    if (!n) continue;
    let from = 0;
    while (marks.length < cap * 4) {
      const i = folded.indexOf(n, from);
      if (i < 0) break;
      marks.push([i, i + n.length]);
      from = i + n.length;
    }
  }
  return mergeMarks(marks).slice(0, cap);
}

/** Choose where the snippet should centre: the position whose neighbourhood
 *  contains the most distinct needles (ties: earliest). -1 when none match. */
function anchorFor(folded: string, needles: string[], radius: number): { at: number; len: number } {
  const candidates: Array<{ at: number; len: number }> = [];
  for (const n of needles) {
    let from = 0;
    for (let k = 0; k < 5; k++) {
      const i = folded.indexOf(n, from);
      if (i < 0) break;
      candidates.push({ at: i, len: n.length });
      from = i + n.length;
    }
  }
  if (!candidates.length) return { at: -1, len: 0 };
  let best = candidates[0];
  let bestCount = -1;
  for (const c of candidates) {
    const lo = Math.max(0, c.at - radius);
    const hi = Math.min(folded.length, c.at + c.len + radius);
    const win = folded.slice(lo, hi);
    let count = 0;
    for (const n of needles) if (win.includes(n)) count += 1;
    if (count > bestCount || (count === bestCount && c.at < best.at)) {
      best = c;
      bestCount = count;
    }
  }
  return best;
}

const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;

/**
 * Cut a readable excerpt around the best match and report where the needles
 * fall inside it. Markdown noise (heading hashes, emphasis stars, backticks,
 * quote markers) is dropped and whitespace collapsed, in one pass that keeps
 * the folded copy aligned, so the marks are exact offsets into `text`.
 */
export function makeSnippet(source: Prepared, needles: string[], opts: SnippetOptions = {}): MemorySnippet {
  const radius = Math.max(16, opts.radius ?? 90);
  const max = Math.max(32, opts.max ?? 260);
  const { text, folded } = source;
  if (!text) return { text: '', marks: [] };
  const anchor = anchorFor(folded, needles, radius);
  let start: number;
  let end: number;
  if (anchor.at < 0) {
    start = 0;
    end = Math.min(text.length, max);
  } else {
    start = Math.max(0, anchor.at - radius);
    end = Math.min(text.length, anchor.at + anchor.len + radius);
    // Snap outwards to a space so the excerpt does not open mid-word, but
    // never by more than a few characters (CJK has no spaces to find).
    for (let k = 0; start > 0 && k < 16 && !/\s/.test(text[start - 1]); k++) start -= 1;
    for (let k = 0; end < text.length && k < 16 && !/\s/.test(text[end]); k++) end += 1;
  }
  if (start > 0 && isLowSurrogate(text.charCodeAt(start))) start -= 1;
  if (end < text.length && isLowSurrogate(text.charCodeAt(end))) end += 1;

  let out = '';
  let outFolded = '';
  let lineStart = start === 0 || text[start - 1] === '\n';
  for (let i = start; i < end; i++) {
    const c = text[i];
    if (c === '\n' || c === '\r' || c === '\t' || c === ' ') {
      if (c === '\n') lineStart = true;
      if (out && !out.endsWith(' ')) { out += ' '; outFolded += ' '; }
      continue;
    }
    if (lineStart && (c === '#' || c === '>')) continue;
    if (c === '*' || c === '`') { lineStart = false; continue; }
    if (lineStart && (c === '-' || c === '+') && (text[i + 1] === ' ' || text[i + 1] === '\t')) { lineStart = false; continue; }
    lineStart = false;
    out += c;
    outFolded += folded[i];
  }
  let body = out.trim();
  let bodyFolded = outFolded.slice(out.length - out.trimStart().length, out.length - out.trimStart().length + body.length);
  if (body.length > max) {
    body = body.slice(0, max);
    bodyFolded = bodyFolded.slice(0, max);
  }
  const head = start > 0 ? '… ' : '';
  const tail = end < text.length || out.trim().length > max ? ' …' : '';
  const marks = findMarks(bodyFolded, needles).map(([a, b]) => [a + head.length, b + head.length] as [number, number]);
  return { text: head + body + tail, marks };
}

/** The opening of a text as a snippet, no matching. */
export function leadSnippet(text: string, max = 200): MemorySnippet {
  return makeSnippet(prepare(text), [], { max });
}
