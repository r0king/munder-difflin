/**
 * Recording sessions on disk: `<root>/<sessionId>/{mic,system}.wav` plus a
 * `session.json` with its timestamps.
 *
 * The renderer streams PCM chunks (≈1 s, 32 KB) as it records; each is
 * appended to the track's WAV straight away, so memory stays flat however long
 * the meeting runs and a crash loses at most the last second. The header is
 * written first with zero sizes and patched on finalize — a file that never
 * got patched still decodes (wav.ts reads "0" as "to the end").
 *
 * Every session belongs to the webContents that began it: only that renderer
 * may append to, finalize or cancel it, and when it goes away (crash, reload,
 * window closed) its open sessions are finalized, never left holding the mic
 * gate open.
 */
import {
  closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync,
  statSync, writeFileSync, writeSync
} from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import {
  PCM_SAMPLE_RATE,
  isValidSessionId,
  type BeginSessionRequest,
  type CapturePurpose,
  type FinalizeResult,
  type TranscribeTrack
} from '../../../shared/features/transcribe';
import { WAV_HEADER_BYTES, wavHeader, wavSizeFields } from './wav';
import { selectExpired, type SessionRecord } from './retention';

const BYTES_PER_SECOND = PCM_SAMPLE_RATE * 2;
/** One append is at most 8 s of audio; the renderer sends ~1 s. */
export const MAX_CHUNK_BYTES = BYTES_PER_SECOND * 8;
/** A track stops growing after 6 hours (≈ 690 MB) — a forgotten recording
 *  must not fill the disk. */
export const MAX_TRACK_BYTES = BYTES_PER_SECOND * 6 * 60 * 60;
const TRACKS: readonly TranscribeTrack[] = ['mic', 'system'];
const PURPOSES: readonly CapturePurpose[] = ['message', 'meeting', 'dictation'];

interface TrackWriter {
  fd: number;
  path: string;
  bytes: number;
  truncated: boolean;
}

interface OpenSession {
  id: string;
  dir: string;
  ownerId: number;
  createdAt: number;
  purpose: CapturePurpose;
  wants: Record<TranscribeTrack, boolean>;
  writers: Partial<Record<TranscribeTrack, TrackWriter>>;
}

interface SessionMeta extends SessionRecord {
  purpose?: CapturePurpose;
  finalizedAt?: number;
  durationMs?: number;
}

export class SessionStore {
  readonly root: string;
  private open = new Map<string, OpenSession>();
  /** Who recorded each session closed during this run, so that renderer can
   *  still discard its own recording after stopping it (review → cancel). */
  private closedOwners = new Map<string, number>();
  private onChange: () => void;

  constructor(root: string, onChange: () => void = () => {}) {
    this.root = root;
    this.onChange = onChange;
    mkdirSync(root, { recursive: true });
  }

  anyOpen(): boolean {
    return this.open.size > 0;
  }

  isOpen(id: string): boolean {
    return this.open.has(id);
  }

  ownerOf(id: string): number | null {
    return this.open.get(id)?.ownerId ?? null;
  }

  /** Open sessions owned by a webContents (to finalize when it goes away). */
  ownedBy(ownerId: number): string[] {
    return [...this.open.values()].filter((s) => s.ownerId === ownerId).map((s) => s.id);
  }

  begin(req: BeginSessionRequest, ownerId: number, now = Date.now()): { ok: boolean; error?: string } {
    if (!isValidSessionId(req.sessionId)) return { ok: false, error: 'invalid session id' };
    if (!req.mic && !req.system) return { ok: false, error: 'nothing to record' };
    if (this.open.has(req.sessionId)) return { ok: false, error: 'session already open' };
    const dir = join(this.root, req.sessionId);
    if (existsSync(dir)) return { ok: false, error: 'session id already used' };
    try {
      mkdirSync(dir, { recursive: false });
    } catch (e) {
      return { ok: false, error: `cannot create session folder: ${errMsg(e)}` };
    }
    const purpose = req.purpose && PURPOSES.includes(req.purpose) ? req.purpose : req.system ? 'meeting' : 'message';
    const s: OpenSession = {
      id: req.sessionId,
      dir,
      ownerId,
      createdAt: now,
      purpose,
      wants: { mic: !!req.mic, system: !!req.system },
      writers: {}
    };
    this.open.set(s.id, s);
    this.writeMeta(s.dir, { id: s.id, createdAt: now, purpose });
    this.onChange();
    return { ok: true };
  }

  /** Append one PCM chunk. Returns false (and drops it) when the chunk is not
   *  acceptable: unknown session, wrong owner, track not requested, odd size. */
  append(id: string, ownerId: number, track: TranscribeTrack, bytes: Uint8Array): boolean {
    const s = this.open.get(id);
    if (!s || s.ownerId !== ownerId || !TRACKS.includes(track) || !s.wants[track]) return false;
    if (bytes.byteLength === 0 || bytes.byteLength % 2 !== 0 || bytes.byteLength > MAX_CHUNK_BYTES) return false;
    let w = s.writers[track];
    try {
      if (!w) {
        const path = join(s.dir, `${track}.wav`);
        const fd = openSync(path, 'w');
        writeSync(fd, wavHeader(0, PCM_SAMPLE_RATE, 1, 16));
        w = { fd, path, bytes: 0, truncated: false };
        s.writers[track] = w;
      }
      if (w.truncated) return false;
      const room = MAX_TRACK_BYTES - w.bytes;
      const n = Math.min(room, bytes.byteLength);
      if (n > 0) {
        writeSync(w.fd, bytes, 0, n);
        w.bytes += n;
      }
      if (n < bytes.byteLength) w.truncated = true;
      return true;
    } catch (e) {
      console.error('[transcribe] append failed:', errMsg(e));
      return false;
    }
  }

  /** Close the session's files (patching the WAV headers). Safe to call for a
   *  session that is already closed: it reports what is on disk. */
  finalize(id: string, ownerId?: number, now = Date.now()): FinalizeResult {
    if (!isValidSessionId(id)) return { ok: false, sessionId: String(id), durationMs: 0, error: 'invalid session id' };
    const s = this.open.get(id);
    if (!s) return this.describe(id);
    if (ownerId !== undefined && s.ownerId !== ownerId) {
      return { ok: false, sessionId: id, durationMs: 0, error: 'not your session' };
    }
    this.open.delete(id);
    this.rememberOwner(id, s.ownerId);
    let maxBytes = 0;
    const out: FinalizeResult = { ok: true, sessionId: id, durationMs: 0 };
    for (const track of TRACKS) {
      const w = s.writers[track];
      if (!w) continue;
      try {
        for (const f of wavSizeFields(w.bytes)) writeSync(w.fd, f.value, 0, 4, f.offset);
      } catch (e) {
        console.error('[transcribe] header fix-up failed:', errMsg(e));
      }
      try { closeSync(w.fd); } catch { /* already closed */ }
      if (w.bytes > 0) {
        if (track === 'mic') out.micWav = w.path;
        else out.systemWav = w.path;
        maxBytes = Math.max(maxBytes, w.bytes);
      }
    }
    out.durationMs = Math.round((maxBytes / BYTES_PER_SECOND) * 1000);
    if (!out.micWav && !out.systemWav) {
      out.ok = false;
      out.error = 'no audio was recorded';
    }
    const meta = this.readMeta(id) ?? { id, createdAt: s.createdAt };
    this.writeMeta(s.dir, { ...meta, purpose: s.purpose, finalizedAt: now, durationMs: out.durationMs });
    this.onChange();
    return out;
  }

  /** Close and delete. */
  cancel(id: string, ownerId?: number): boolean {
    if (!isValidSessionId(id)) return false;
    const s = this.open.get(id);
    if (s) {
      if (ownerId !== undefined && s.ownerId !== ownerId) return false;
      this.open.delete(id);
      for (const track of TRACKS) {
        const w = s.writers[track];
        if (w) try { closeSync(w.fd); } catch { /* closed */ }
      }
      this.onChange();
    } else if (ownerId !== undefined && this.closedOwners.get(id) !== ownerId) {
      // A renderer may only delete its own recordings; anything else is
      // main's (retention) to delete.
      return false;
    }
    this.closedOwners.delete(id);
    this.removeDir(id);
    return true;
  }

  private rememberOwner(id: string, ownerId: number): void {
    this.closedOwners.set(id, ownerId);
    // Bounded: only recent recordings need it.
    if (this.closedOwners.size > 200) {
      const oldest = this.closedOwners.keys().next().value;
      if (oldest !== undefined) this.closedOwners.delete(oldest);
    }
  }

  /** What a closed session left on disk. */
  describe(id: string): FinalizeResult {
    const dir = join(this.root, id);
    const out: FinalizeResult = { ok: false, sessionId: id, durationMs: 0 };
    if (!isValidSessionId(id) || !existsSync(dir)) return { ...out, error: 'unknown session' };
    let maxBytes = 0;
    for (const track of TRACKS) {
      const p = join(dir, `${track}.wav`);
      const size = fileSize(p);
      if (size > WAV_HEADER_BYTES) {
        if (track === 'mic') out.micWav = p;
        else out.systemWav = p;
        maxBytes = Math.max(maxBytes, size - WAV_HEADER_BYTES);
      }
    }
    out.durationMs = Math.round((maxBytes / BYTES_PER_SECOND) * 1000);
    out.ok = !!(out.micWav || out.systemWav);
    if (!out.ok) out.error = 'no audio was recorded';
    return out;
  }

  /** The session a WAV path belongs to, if it lies inside our root. */
  sessionOfPath(p: string): string | null {
    if (!isAbsolute(p)) return null;
    let real: string;
    let root: string;
    try {
      real = realpathSync(p);
      root = realpathSync(this.root);
    } catch {
      return null;
    }
    const rel = relative(root, real);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
    const id = rel.split(sep)[0];
    return isValidSessionId(id) ? id : null;
  }

  markTranscribed(id: string, now = Date.now()): void {
    const meta = this.readMeta(id);
    if (!meta) return;
    this.writeMeta(join(this.root, id), { ...meta, transcribedAt: now });
  }

  /** Delete recordings past their retention. Returns the ids removed. */
  sweep(now = Date.now()): string[] {
    let names: string[] = [];
    try {
      names = readdirSync(this.root);
    } catch {
      return [];
    }
    const records: SessionRecord[] = [];
    for (const name of names) {
      if (!isValidSessionId(name)) continue;
      const meta = this.readMeta(name);
      if (meta) {
        records.push({ id: name, createdAt: meta.createdAt, transcribedAt: meta.transcribedAt });
        continue;
      }
      // No (or unreadable) session.json: age it by the folder itself.
      try {
        records.push({ id: name, createdAt: statSync(join(this.root, name)).mtimeMs });
      } catch { /* vanished */ }
    }
    const expired = selectExpired(records, now, (id) => this.open.has(id));
    for (const id of expired) this.removeDir(id);
    return expired;
  }

  /** Close everything (app quit): finalize so nothing is half-written. */
  closeAll(): void {
    for (const id of [...this.open.keys()]) this.finalize(id);
  }

  private removeDir(id: string): void {
    if (!isValidSessionId(id)) return;
    try {
      rmSync(join(this.root, id), { recursive: true, force: true });
    } catch (e) {
      console.error('[transcribe] could not delete session', id, errMsg(e));
    }
  }

  private readMeta(id: string): SessionMeta | null {
    if (!isValidSessionId(id)) return null;
    try {
      const raw = JSON.parse(readFileSync(join(this.root, id, 'session.json'), 'utf8')) as Partial<SessionMeta>;
      if (typeof raw.createdAt !== 'number' || !Number.isFinite(raw.createdAt)) return null;
      return {
        id,
        createdAt: raw.createdAt,
        ...(typeof raw.transcribedAt === 'number' ? { transcribedAt: raw.transcribedAt } : {}),
        ...(typeof raw.finalizedAt === 'number' ? { finalizedAt: raw.finalizedAt } : {}),
        ...(typeof raw.durationMs === 'number' ? { durationMs: raw.durationMs } : {}),
        ...(raw.purpose && PURPOSES.includes(raw.purpose) ? { purpose: raw.purpose } : {})
      };
    } catch {
      return null;
    }
  }

  private writeMeta(dir: string, meta: SessionMeta): void {
    const file = join(dir, 'session.json');
    try {
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify(meta, null, 2), 'utf8');
      renameSync(tmp, file);
    } catch (e) {
      console.error('[transcribe] could not write session.json:', errMsg(e));
    }
  }
}

function fileSize(p: string): number {
  try {
    const st = statSync(p);
    return st.isFile() ? st.size : -1;
  } catch {
    return -1;
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
