/**
 * Meetings library — the pure half: folder naming, the meeting.json shape,
 * transcript.md rendering, search, and the text an agent receives. No fs, no
 * Electron (meetingStore.ts does the disk; test/stapler-meetings.test.cjs
 * covers this file).
 *
 * "One folder per meeting, searchable and editable": each meeting is a folder
 * `<root>/meetings/YYYY-MM-DD HHmm <slug>/` holding meeting.json (the source of
 * truth the app reads and writes) and transcript.md (a readable copy rewritten
 * on every save, so an agent or a person can open the folder and just read).
 * The folder name is the meeting's id and never changes after creation —
 * renaming the meeting edits the title inside, not the path an agent may
 * already have been sent.
 */
import {
  MAX_DESCRIPTION_CHARS,
  MAX_TITLE_CHARS,
  formatDuration,
  sanitizeSegments,
  type MeetingRecord,
  type MeetingSegment,
  type MeetingStatus,
  type MeetingSummary
} from '../../../shared/features/stapler';

export const MEETING_JSON = 'meeting.json';
export const TRANSCRIPT_MD = 'transcript.md';
export const MAX_SLUG = 48;

const STATUSES: readonly MeetingStatus[] = ['recording', 'transcribing', 'ready', 'failed', 'interrupted'];

/**
 * A folder-safe slug: letters (any script) and digits, everything else
 * collapsed to single dashes, lower-cased, at most MAX_SLUG characters.
 * Unicode letters are kept on purpose — a Chinese or Arabic title should not
 * become "meeting" — and every OS accepts them in a path. Nothing here can
 * produce a separator, a dot, or a Windows-reserved trailing space.
 */
export function slugify(title: string, fallback = 'meeting'): string {
  const slug = title
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  const cut = Array.from(slug).slice(0, MAX_SLUG).join('').replace(/-+$/g, '');
  return cut || fallback;
}

const pad = (n: number, w = 2): string => String(n).padStart(w, '0');

/** `YYYY-MM-DD HHmm <slug>` in LOCAL time — the user reads these in a file
 *  browser next to their calendar, not in UTC. */
export function meetingFolderName(date: Date, title: string): string {
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}${pad(date.getMinutes())}`;
  return `${stamp} ${slugify(title)}`;
}

/** The first of `base`, `base 2`, `base 3`… that `taken` says is free. */
export function uniqueFolderName(base: string, taken: (name: string) => boolean): string {
  if (!taken(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const name = `${base} ${i}`;
    if (!taken(name)) return name;
  }
  return `${base} ${Date.now().toString(36)}`;
}

/**
 * Is this a meeting id we could have minted? The only way a renderer names a
 * folder, so it is the path-containment gate: no separators, no dots, no
 * leading/trailing space — `join(root, id)` cannot leave `root`.
 */
const MEETING_ID = /^\d{4}-\d{2}-\d{2} \d{4} [\p{L}\p{N}\p{M}]+(?:-[\p{L}\p{N}\p{M}]+)*(?: [0-9a-z]{1,12})?$/u;
export function isMeetingId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 96 && MEETING_ID.test(value);
}

/** Default title for a new meeting: "Meeting 12 Oct, 14:30" style, built by
 *  the caller's locale-free formatter so files stay readable everywhere. */
export function defaultMeetingTitle(date: Date): string {
  return `Meeting ${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Parse a meeting.json body (untrusted: a person may have edited it). The id
 *  always comes from the folder, never from the file. Null if unusable. */
export function parseMeetingRecord(raw: unknown, id: string): MeetingRecord | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const startedAt = typeof r.startedAt === 'string' && !Number.isNaN(Date.parse(r.startedAt)) ? r.startedAt : null;
  if (!startedAt) return null;
  const status = STATUSES.includes(r.status as MeetingStatus) ? (r.status as MeetingStatus) : 'ready';
  const rec: MeetingRecord = {
    id,
    title: typeof r.title === 'string' && r.title.trim() ? r.title.slice(0, MAX_TITLE_CHARS) : defaultMeetingTitle(new Date(startedAt)),
    description: typeof r.description === 'string' ? r.description.slice(0, MAX_DESCRIPTION_CHARS) : '',
    startedAt,
    durationMs: typeof r.durationMs === 'number' && Number.isFinite(r.durationMs) && r.durationMs >= 0 ? Math.round(r.durationMs) : 0,
    status,
    segments: sanitizeSegments(r.segments),
    updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : startedAt
  };
  if (typeof r.engine === 'string' && r.engine.length <= 40) rec.engine = r.engine;
  if (typeof r.error === 'string') rec.error = r.error.slice(0, 2000);
  const audio = r.audio as Record<string, unknown> | undefined;
  if (audio && typeof audio === 'object') {
    const a: { micWav?: string; systemWav?: string } = {};
    if (typeof audio.micWav === 'string' && audio.micWav.length < 4096) a.micWav = audio.micWav;
    if (typeof audio.systemWav === 'string' && audio.systemWav.length < 4096) a.systemWav = audio.systemWav;
    if (a.micWav || a.systemWav) rec.audio = a;
  }
  return rec;
}

/** The meeting.json body (the id is the folder; it is not repeated inside). */
export function serializeMeetingRecord(rec: MeetingRecord): string {
  const { id: _id, ...body } = rec;
  void _id;
  return JSON.stringify({ version: 1, ...body }, null, 2) + '\n';
}

/** [mm:ss] or [h:mm:ss] from the start of the meeting. */
export function timestamp(ms: number): string {
  return formatDuration(ms);
}

const SPEAKER_LABEL: Record<MeetingSegment['speaker'], string> = { you: 'You', them: 'Them' };

/**
 * transcript.md — written for a reader (person or agent) opening the folder.
 * English labels on purpose: this file is what agents are sent, and every
 * agent prompt in this app is English.
 */
export function renderTranscriptMarkdown(rec: MeetingRecord): string {
  const lines: string[] = [`# ${rec.title}`, ''];
  const started = new Date(rec.startedAt);
  lines.push(`- Started: ${Number.isNaN(started.getTime()) ? rec.startedAt : started.toISOString()}`);
  lines.push(`- Duration: ${formatDuration(rec.durationMs)}`);
  if (rec.engine) lines.push(`- Transcribed by: ${rec.engine}`);
  lines.push('');
  if (rec.description.trim()) {
    lines.push('## Description', '', rec.description.trim(), '');
  }
  lines.push('## Transcript', '');
  if (!rec.segments.length) {
    lines.push(rec.status === 'ready' ? '_Nothing was said._' : `_No transcript yet (${rec.status})._`);
  } else {
    for (const s of rec.segments) {
      const text = s.text.replace(/\s*\n\s*/g, ' ').trim();
      if (!text) continue;
      lines.push(`**${SPEAKER_LABEL[s.speaker]}** [${timestamp(s.startMs)}]: ${text}`, '');
    }
  }
  return lines.join('\n').replace(/\n+$/, '\n');
}

/** Plain transcript text, one line per segment ("You: …"). */
export function transcriptPlainText(segments: readonly MeetingSegment[]): string {
  return segments
    .map((s) => `${SPEAKER_LABEL[s.speaker]}: ${s.text.replace(/\s*\n\s*/g, ' ').trim()}`)
    .filter((l) => !/^(You|Them):\s*$/.test(l))
    .join('\n');
}

/** Above this the transcript is attached only (as transcript.md), not inlined. */
export const INLINE_TRANSCRIPT_LIMIT = 20_000;

/**
 * The message an agent receives for "send it to any of your agents": the
 * title, when and how long, the description, and the transcript inline when
 * it is short. transcript.md always rides along as an attachment, so a long
 * meeting is one Read away rather than a 100k-character prompt.
 */
export function meetingDeliveryText(rec: MeetingRecord): string {
  const head = [`Meeting: ${rec.title}`, `Started ${rec.startedAt} · ${formatDuration(rec.durationMs)}`];
  const parts = [head.join('\n')];
  if (rec.description.trim()) parts.push(`Description:\n${rec.description.trim()}`);
  const plain = transcriptPlainText(rec.segments);
  if (plain && plain.length <= INLINE_TRANSCRIPT_LIMIT) parts.push(`Transcript:\n${plain}`);
  else if (plain) parts.push('The full transcript is attached (transcript.md).');
  else parts.push('There is no transcript for this meeting yet.');
  return parts.join('\n\n');
}

function firstLines(segments: readonly MeetingSegment[], max = 160): string {
  const text = transcriptPlainText(segments.slice(0, 6));
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function toSummary(rec: MeetingRecord, snippet?: string): MeetingSummary {
  const out: MeetingSummary = {
    id: rec.id,
    title: rec.title,
    description: rec.description,
    startedAt: rec.startedAt,
    durationMs: rec.durationMs,
    status: rec.status,
    segmentCount: rec.segments.length,
    snippet: snippet ?? firstLines(rec.segments)
  };
  if (rec.error) out.error = rec.error;
  return out;
}

/** Newest first; the id (which starts with the date) breaks ties. */
export function compareNewestFirst(a: { startedAt: string; id: string }, b: { startedAt: string; id: string }): number {
  const d = Date.parse(b.startedAt) - Date.parse(a.startedAt);
  if (d !== 0 && Number.isFinite(d)) return d;
  return b.id.localeCompare(a.id);
}

/** Lower-cased, whitespace-split, de-duplicated query terms (max 12). */
export function queryTerms(query: string): string[] {
  return [...new Set(query.toLowerCase().normalize('NFKC').split(/\s+/).filter(Boolean))].slice(0, 12);
}

function snippetAround(text: string, term: string, radius = 70): string {
  const i = text.toLowerCase().indexOf(term);
  if (i < 0) return '';
  const start = Math.max(0, i - radius);
  const end = Math.min(text.length, i + term.length + radius);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ').trim()}${end < text.length ? '…' : ''}`;
}

/**
 * Search across titles, descriptions and transcripts. Every term must appear
 * somewhere in the meeting (AND); hits in the title outrank the description,
 * which outranks the transcript, then newest first. An empty query lists every
 * meeting, newest first. The snippet shows the transcript around the first
 * term found there (or the description's), so the list says WHY it matched.
 */
export function searchMeetings(records: readonly MeetingRecord[], query: string): MeetingSummary[] {
  const terms = queryTerms(query);
  if (!terms.length) return [...records].sort(compareNewestFirst).map((r) => toSummary(r));
  const scored: Array<{ rec: MeetingRecord; score: number; snippet: string }> = [];
  for (const rec of records) {
    const title = rec.title.toLowerCase().normalize('NFKC');
    const desc = rec.description.toLowerCase().normalize('NFKC');
    const transcript = transcriptPlainText(rec.segments);
    const tLower = transcript.toLowerCase().normalize('NFKC');
    let score = 0;
    let ok = true;
    for (const term of terms) {
      const inTitle = title.includes(term);
      const inDesc = desc.includes(term);
      const inText = tLower.includes(term);
      if (!inTitle && !inDesc && !inText) { ok = false; break; }
      score += (inTitle ? 6 : 0) + (inDesc ? 3 : 0) + (inText ? 1 : 0);
    }
    if (!ok) continue;
    let snippet = '';
    for (const term of terms) {
      snippet = snippetAround(transcript, term) || snippetAround(rec.description, term);
      if (snippet) break;
    }
    scored.push({ rec, score, snippet });
  }
  scored.sort((a, b) => (b.score - a.score) || compareNewestFirst(a.rec, b.rec));
  return scored.map(({ rec, snippet }) => toSummary(rec, snippet || undefined));
}
