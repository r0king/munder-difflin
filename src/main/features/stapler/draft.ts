/**
 * The puck's tray — shots and files waiting to go out in one message. Pure
 * state transitions (main holds the draft; the renderer only displays it, so
 * an attachment path never comes FROM a renderer). Tested by
 * test/stapler-draft.test.cjs.
 *
 * Limits from the spec: up to eight shots per send; screenshots, PDFs, videos
 * and folders can all ride one message. Duplicates (the same path picked
 * twice) are dropped rather than listed twice.
 */
import {
  MAX_ATTACHMENTS,
  MAX_SHOTS,
  type AttachmentKind,
  type DraftAttachment,
  type StaplerDraft
} from '../../../shared/features/stapler';

const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'heif', 'bmp', 'tif', 'tiff', 'svg']);
const VIDEO = new Set(['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi', 'wmv', 'mpg', 'mpeg']);

/** What kind of attachment a picked path is, from its name and whether it is
 *  a directory. Shots are only ever made by the overlay, never inferred. */
export function classifyAttachment(name: string, isDirectory: boolean): Exclude<AttachmentKind, 'shot'> {
  if (isDirectory) return 'folder';
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(name);
  const ext = m ? m[1].toLowerCase() : '';
  if (ext === 'pdf') return 'pdf';
  if (IMAGE.has(ext)) return 'image';
  if (VIDEO.has(ext)) return 'video';
  return 'file';
}

export type RejectReason = 'shot-limit' | 'attachment-limit' | 'duplicate';

export interface AddResult {
  draft: StaplerDraft;
  added: DraftAttachment[];
  rejected: Array<{ path: string; reason: RejectReason }>;
}

export const emptyDraft = (): StaplerDraft => ({ attachments: [] });

export const shotCount = (d: StaplerDraft): number => d.attachments.filter((a) => a.kind === 'shot').length;

/** Case-insensitive on Windows and macOS (their default filesystems are), so
 *  `C:\\A.pdf` and `c:\\a.pdf` count as one file. */
export function samePath(a: string, b: string, platform: string = process.platform): boolean {
  return platform === 'linux' ? a === b : a.toLowerCase() === b.toLowerCase();
}

/** Add attachments in order, stopping each kind at its limit. */
export function addAttachments(draft: StaplerDraft, items: readonly DraftAttachment[], platform: string = process.platform): AddResult {
  const attachments = [...draft.attachments];
  const added: DraftAttachment[] = [];
  const rejected: AddResult['rejected'] = [];
  for (const item of items) {
    if (attachments.some((a) => samePath(a.path, item.path, platform))) {
      rejected.push({ path: item.path, reason: 'duplicate' });
      continue;
    }
    if (item.kind === 'shot' && attachments.filter((a) => a.kind === 'shot').length >= MAX_SHOTS) {
      rejected.push({ path: item.path, reason: 'shot-limit' });
      continue;
    }
    if (attachments.length >= MAX_ATTACHMENTS) {
      rejected.push({ path: item.path, reason: 'attachment-limit' });
      continue;
    }
    attachments.push(item);
    added.push(item);
  }
  return { draft: { attachments }, added, rejected };
}

export function removeAttachment(draft: StaplerDraft, id: string): { draft: StaplerDraft; removed: DraftAttachment | null } {
  const removed = draft.attachments.find((a) => a.id === id) ?? null;
  return { draft: { attachments: draft.attachments.filter((a) => a.id !== id) }, removed };
}

/** Validate a draft read back from disk (draft.json). `exists` decides which
 *  attachments survived a restart; thumbnails are kept only for shots. */
export function sanitizeDraft(value: unknown, exists: (path: string) => boolean): StaplerDraft {
  const out = emptyDraft();
  if (!value || typeof value !== 'object') return out;
  const list = (value as { attachments?: unknown }).attachments;
  if (!Array.isArray(list)) return out;
  const kinds: AttachmentKind[] = ['shot', 'image', 'pdf', 'video', 'folder', 'file'];
  const items: DraftAttachment[] = [];
  for (const raw of list.slice(0, MAX_ATTACHMENTS)) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.id !== 'string' || typeof r.path !== 'string' || typeof r.name !== 'string') continue;
    if (!kinds.includes(r.kind as AttachmentKind) || r.id.length > 64 || r.path.length > 4096) continue;
    if (!exists(r.path)) continue;
    const item: DraftAttachment = { id: r.id, kind: r.kind as AttachmentKind, path: r.path, name: r.name.slice(0, 260) };
    if (typeof r.size === 'number' && Number.isFinite(r.size)) item.size = r.size;
    if (item.kind === 'shot') {
      if (typeof r.thumb === 'string' && r.thumb.startsWith('data:image/') && r.thumb.length < 400_000) item.thumb = r.thumb;
      if (typeof r.width === 'number') item.width = r.width;
      if (typeof r.height === 'number') item.height = r.height;
    }
    items.push(item);
  }
  return addAttachments(out, items).draft;
}
