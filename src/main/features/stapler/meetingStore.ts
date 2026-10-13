/**
 * Meetings library — the disk half. One folder per meeting under a root that
 * main resolves on every call (`<harnessHome>/meetings` once a hive is open,
 * else `<userData>/features/stapler/meetings`), so switching hives switches
 * libraries without a restart.
 *
 * Path safety: a renderer only ever names a meeting by id, the id must pass
 * `isMeetingId` (no separators, no dots), and the resolved folder must be a
 * real directory — not a symlink — directly inside the root. Nothing here
 * takes a path from IPC.
 *
 * No Electron imports: test/stapler-meetings.test.cjs drives it on a temp dir.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep, isAbsolute } from 'node:path';
import {
  sanitizeMeetingPatch,
  sanitizeSegments,
  type MeetingRecord,
  type MeetingSegment,
  type MeetingSummary
} from '../../../shared/features/stapler';
import {
  MEETING_JSON,
  TRANSCRIPT_MD,
  defaultMeetingTitle,
  isMeetingId,
  meetingFolderName,
  parseMeetingRecord,
  renderTranscriptMarkdown,
  searchMeetings,
  serializeMeetingRecord,
  toSummary,
  uniqueFolderName,
  compareNewestFirst
} from './meetings';

/** Write-then-rename, so a crash mid-save leaves the previous file whole. */
function writeAtomic(file: string, body: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, body, 'utf8');
  renameSync(tmp, file);
}

export interface MeetingStart {
  startedAt: Date;
  title?: string;
  /** The capture session the audio goes into, so a meeting cut off while
   *  recording (quit, crash) can still be transcribed from the library. */
  sessionId?: string;
}

export interface MeetingFinish {
  durationMs: number;
  segments: MeetingSegment[];
  engine?: string;
  error?: string;
}

export class MeetingStore {
  /** id → parsed record, keyed by meeting.json's mtime so a search across a
   *  long library re-reads only what changed (including hand edits). */
  private cache = new Map<string, { root: string; mtimeMs: number; size: number; rec: MeetingRecord }>();

  constructor(private readonly rootFn: () => string) {}

  /** The library root, created on demand. */
  root(): string {
    const r = resolve(this.rootFn());
    mkdirSync(r, { recursive: true });
    return r;
  }

  /** The folder for `id`, or null when the id is invalid or the folder is not
   *  a plain directory inside the root. */
  dirFor(id: unknown, mustExist = true): string | null {
    if (!isMeetingId(id)) return null;
    const root = this.root();
    const dir = resolve(root, id);
    const rel = relative(root, dir);
    if (!rel || rel.startsWith('..') || isAbsolute(rel) || rel.includes(sep)) return null;
    if (!mustExist) return dir;
    try {
      const st = lstatSync(dir);
      if (!st.isDirectory() || st.isSymbolicLink()) return null;
    } catch {
      return null;
    }
    return dir;
  }

  /** Every meeting in the library, newest first. Unreadable folders are
   *  skipped (a half-copied folder must not break the list). */
  all(): MeetingRecord[] {
    const root = this.root();
    let names: string[] = [];
    try {
      names = readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory() && isMeetingId(d.name))
        .map((d) => d.name);
    } catch {
      return [];
    }
    const seen = new Set(names);
    for (const id of [...this.cache.keys()]) if (!seen.has(id)) this.cache.delete(id);
    const out: MeetingRecord[] = [];
    for (const id of names) {
      const rec = this.readRecord(root, id);
      if (rec) out.push(rec);
    }
    return out.sort(compareNewestFirst);
  }

  private readRecord(root: string, id: string): MeetingRecord | null {
    const file = join(root, id, MEETING_JSON);
    try {
      const st = statSync(file);
      const hit = this.cache.get(id);
      if (hit && hit.root === root && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.rec;
      if (st.size > 64 * 1024 * 1024) return null; // not a meeting.json we wrote
      const rec = parseMeetingRecord(JSON.parse(readFileSync(file, 'utf8')), id);
      if (rec) this.cache.set(id, { root, mtimeMs: st.mtimeMs, size: st.size, rec });
      return rec;
    } catch {
      return null;
    }
  }

  get(id: unknown): MeetingRecord | null {
    const dir = this.dirFor(id);
    if (!dir) return null;
    return this.readRecord(this.root(), id as string);
  }

  list(query = ''): MeetingSummary[] {
    return searchMeetings(this.all(), query);
  }

  /** Persist a record: meeting.json and the transcript.md beside it. */
  private save(rec: MeetingRecord): MeetingRecord {
    const dir = this.dirFor(rec.id);
    if (!dir) throw new Error(`meeting folder missing: ${rec.id}`);
    const next = { ...rec, updatedAt: new Date().toISOString() };
    writeAtomic(join(dir, MEETING_JSON), serializeMeetingRecord(next));
    writeAtomic(join(dir, TRANSCRIPT_MD), renderTranscriptMarkdown(next));
    this.cache.delete(rec.id);
    return next;
  }

  /** Create the folder the moment recording starts, status 'recording', so a
   *  crash mid-meeting still leaves a folder that says what happened. */
  create(start: MeetingStart): MeetingRecord {
    const root = this.root();
    const title = start.title?.trim() || defaultMeetingTitle(start.startedAt);
    const id = uniqueFolderName(meetingFolderName(start.startedAt, start.title?.trim() || 'meeting'), (n) => existsSync(join(root, n)));
    mkdirSync(join(root, id));
    const rec: MeetingRecord = {
      id,
      title,
      description: '',
      startedAt: start.startedAt.toISOString(),
      durationMs: 0,
      status: 'recording',
      segments: [],
      updatedAt: start.startedAt.toISOString()
    };
    if (start.sessionId) rec.sessionId = start.sessionId;
    return this.save(rec);
  }

  /** Mark a meeting as being transcribed (after the capture stopped, or on a
   *  retry), remembering the capture session for the next retry. */
  markTranscribing(id: string, durationMs: number, sessionId?: string): MeetingRecord | null {
    const rec = this.get(id);
    if (!rec) return null;
    const next: MeetingRecord = { ...rec, status: 'transcribing', durationMs: Math.max(rec.durationMs, Math.round(durationMs)) };
    if (sessionId) next.sessionId = sessionId;
    delete next.error;
    return this.save(next);
  }

  /** The transcript is in (or failed). */
  finish(id: string, f: MeetingFinish): MeetingRecord | null {
    const rec = this.get(id);
    if (!rec) return null;
    const ok = !f.error;
    const next: MeetingRecord = {
      ...rec,
      durationMs: Math.max(rec.durationMs, Math.round(f.durationMs)),
      status: ok ? 'ready' : 'failed',
      segments: ok ? sanitizeSegments(f.segments) : rec.segments
    };
    if (f.engine) next.engine = f.engine;
    if (ok) delete next.error; else next.error = f.error;
    return this.save(next);
  }

  /** A library edit (title, description, segments). */
  update(id: unknown, patch: unknown): MeetingRecord | null {
    const rec = this.get(id);
    const clean = sanitizeMeetingPatch(patch);
    if (!rec || !clean) return null;
    const next: MeetingRecord = { ...rec };
    if (clean.title !== undefined) next.title = clean.title || rec.title;
    if (clean.description !== undefined) next.description = clean.description;
    if (clean.segments !== undefined) next.segments = clean.segments;
    return this.save(next);
  }

  remove(id: unknown): boolean {
    const dir = this.dirFor(id);
    if (!dir) return false;
    rmSync(dir, { recursive: true, force: true });
    this.cache.delete(id as string);
    return true;
  }

  /**
   * At startup nothing can be recording: a meeting still marked 'recording' or
   * 'transcribing' was cut off by a quit or a crash. Say so instead of
   * showing a spinner forever. Also used when the puck's renderer goes away
   * mid-recording; `except` names meetings still legitimately in flight (a
   * transcription main is running). Returns how many were marked.
   */
  markInterrupted(except: ReadonlySet<string> = new Set()): number {
    let n = 0;
    for (const rec of this.all()) {
      if (except.has(rec.id)) continue;
      if (rec.status === 'recording' || rec.status === 'transcribing') {
        try {
          this.save({ ...rec, status: 'interrupted' });
          n++;
        } catch { /* read-only volume — leave it */ }
      }
    }
    return n;
  }

  summary(id: string): MeetingSummary | null {
    const rec = this.get(id);
    return rec ? toSummary(rec) : null;
  }

  transcriptPath(id: string): string | null {
    const dir = this.dirFor(id);
    return dir ? join(dir, TRANSCRIPT_MD) : null;
  }
}
