/**
 * The Stapler's contract — shared by main (src/main/features/stapler.ts), the
 * preload (src/preload/features/stapler.ts), the Stapler's own windows
 * (src/renderer/src/stapler) and the meetings library in the main window
 * (workspace/screens/StaplerScreen.tsx). Owned by the `stapler` unit.
 *
 * Pure: types, limits, validators for everything that crosses IPC, and the
 * small amount of math both sides of a screenshot need (the overlay draws a
 * region in CSS pixels, main crops the captured image in physical pixels).
 * Tested by test/stapler-shared.test.cjs.
 */
import type { DeliverTarget } from './deliver';

// ─── State (every window) ───────────────────────────────────────────────────

export type StaplerRecording = null | 'message' | 'meeting' | 'dictation';

export interface MeetingShortcutStatus {
  /** Electron accelerator, e.g. 'Shift+Command+Space'. */
  accelerator: string;
  registered: boolean;
  /** Why it is not registered (taken by another app, Wayland, …). */
  error?: string;
}

/**
 * Stapler state as seen by every window (the titlebar toggle, the sidebar row,
 * the puck itself). Other units read `enabled`, `invisible` and `recording`;
 * the rest is the Stapler's own.
 */
export interface StaplerState {
  /** The puck is shown (the titlebar toggle). */
  enabled: boolean;
  /** The user's "Make invisible" switch (persisted). */
  invisible: boolean;
  /** What, if anything, is recording right now. */
  recording: StaplerRecording;
  /** Content protection actually applied now: the switch, OR automatically
   *  while a message or meeting records. */
  hiddenFromCapture: boolean;
  /** This OS can exclude a window from captures (macOS, Windows). */
  canHide: boolean;
  /** The Start/stop meeting global shortcut, while the Stapler is on. */
  meetingShortcut: MeetingShortcutStatus | null;
  /** The meeting being recorded right now. */
  meeting: { id: string; startedAt: string } | null;
  /** Unsent shots and files in the puck's tray. */
  pendingAttachments: number;
  /** Where meeting folders are written. */
  meetingsDir: string | null;
}

export const DEFAULT_STAPLER_STATE: StaplerState = {
  enabled: false,
  invisible: false,
  recording: null,
  hiddenFromCapture: false,
  canHide: false,
  meetingShortcut: null,
  meeting: null,
  pendingAttachments: 0,
  meetingsDir: null
};

// ─── The puck window ────────────────────────────────────────────────────────

/** The flow panels the puck window can expand into. */
export type StaplerPanel = 'compose' | 'meeting' | 'settings' | 'to';
export const STAPLER_PANELS: readonly StaplerPanel[] = ['compose', 'meeting', 'settings', 'to'];

/** puck: the creature alone · ring: the ring of actions around it · panel: a
 *  flow panel (the window grows out of the puck's corner). */
export type StaplerMode = 'puck' | 'ring' | 'panel';

export interface StaplerLayout {
  mode: StaplerMode;
  panel?: StaplerPanel;
  width: number;
  height: number;
}

/** main → puck: something outside the puck asked it to act (the global
 *  shortcut, the library's "Stapler settings" link, a finished screenshot). */
export type StaplerCommand =
  | { type: 'openPanel'; panel: StaplerPanel }
  | { type: 'toggleMeeting' }
  | { type: 'collapse' };

export function isStaplerPanel(v: unknown): v is StaplerPanel {
  return typeof v === 'string' && (STAPLER_PANELS as readonly string[]).includes(v);
}

export function isStaplerMode(v: unknown): v is StaplerMode {
  return v === 'puck' || v === 'ring' || v === 'panel';
}

// ─── Targets ────────────────────────────────────────────────────────────────

/** "Everything it catches goes to your orchestrator, or to the agent you
 *  pick" — the same target shape every feature delivers to. */
export type StaplerTarget = DeliverTarget;

export const ORCHESTRATOR_TARGET: StaplerTarget = { kind: 'orchestrator' };

export function isStaplerTarget(v: unknown): v is StaplerTarget {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  if (r.kind === 'orchestrator') return true;
  return r.kind === 'agent' && typeof r.agentId === 'string' && r.agentId.length > 0 && r.agentId.length <= 200;
}

/** A target reduced to its own keys. */
export function cleanTarget(t: StaplerTarget): StaplerTarget {
  return t.kind === 'agent' ? { kind: 'agent', agentId: t.agentId } : { kind: 'orchestrator' };
}

export function sameTarget(a: StaplerTarget, b: StaplerTarget): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind === 'orchestrator' || a.agentId === (b as { agentId: string }).agentId;
}

// ─── The tray (shots and files waiting to be sent) ──────────────────────────

/** "up to eight shots go in one send" */
export const MAX_SHOTS = 8;
/** Shots + files in one message (well under MAX_DELIVER_ATTACHMENTS). */
export const MAX_ATTACHMENTS = 24;
/** One message's text (the transcript or the typed note). */
export const MAX_NOTE_CHARS = 50_000;

export type AttachmentKind = 'shot' | 'image' | 'pdf' | 'video' | 'folder' | 'file';

export interface DraftAttachment {
  id: string;
  kind: AttachmentKind;
  /** Absolute path (main-owned; the renderer only displays it). */
  path: string;
  name: string;
  /** Bytes; absent for folders. */
  size?: number;
  /** Shots only: a small PNG data URL for the tray. */
  thumb?: string;
  /** Shots only: the cropped size in physical pixels. */
  width?: number;
  height?: number;
}

export interface StaplerDraft {
  attachments: DraftAttachment[];
}

export interface StaplerSendRequest {
  target: StaplerTarget;
  text: string;
}

export interface StaplerResult {
  ok: boolean;
  error?: string;
}

export function isStaplerSendRequest(v: unknown): v is StaplerSendRequest {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  return isStaplerTarget(r.target) && typeof r.text === 'string' && r.text.length <= MAX_NOTE_CHARS;
}

// ─── Screenshot regions ─────────────────────────────────────────────────────

/** A region in CSS (DIP) pixels, relative to the captured display's top-left. */
export interface Region { x: number; y: number; width: number; height: number }

/** Smaller than this (either side) is a click, not a drag. */
export const MIN_REGION = 8;

export interface ScreenshotStart {
  ok: boolean;
  /** 'permission' — macOS has not granted Screen Recording. */
  error?: 'permission' | 'busy' | 'capture-failed' | 'no-display' | 'limit';
  detail?: string;
}

/** What the overlay window asks main for when it loads. */
export interface OverlayInit {
  ok: boolean;
  /** The frozen screen as an image URL (data:). */
  image?: string;
  /** The display's size in CSS pixels (the overlay's viewport). */
  width?: number;
  height?: number;
  /** The region used last time on this display, already fitted to it. */
  remembered?: Region | null;
  /** Shots already in the tray, for the "n of 8" hint. */
  shotCount?: number;
  error?: string;
}

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

/** The normalised rectangle between two drag points, clamped to the
 *  viewport. Integers (CSS px). */
export function regionFromPoints(a: { x: number; y: number }, b: { x: number; y: number }, view: { width: number; height: number }): Region {
  const cx = (n: number) => Math.min(Math.max(Math.round(n), 0), Math.round(view.width));
  const cy = (n: number) => Math.min(Math.max(Math.round(n), 0), Math.round(view.height));
  const x1 = cx(Math.min(a.x, b.x));
  const y1 = cy(Math.min(a.y, b.y));
  const x2 = cx(Math.max(a.x, b.x));
  const y2 = cy(Math.max(a.y, b.y));
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

export function isUsableRegion(r: Region | null | undefined): r is Region {
  return !!r && r.width >= MIN_REGION && r.height >= MIN_REGION;
}

/**
 * Fit a region (from IPC, or remembered from another resolution) into a
 * viewport: clamp it inside, shrinking if needed. Null when it is not a
 * region at all or ends up too small to use.
 */
export function fitRegion(value: unknown, view: { width: number; height: number }): Region | null {
  if (!value || typeof value !== 'object') return null;
  const r = value as Record<string, unknown>;
  if (!finite(r.x) || !finite(r.y) || !finite(r.width) || !finite(r.height)) return null;
  if (!(view.width > 0) || !(view.height > 0)) return null;
  const width = Math.min(Math.max(Math.round(r.width), 0), Math.round(view.width));
  const height = Math.min(Math.max(Math.round(r.height), 0), Math.round(view.height));
  const x = Math.min(Math.max(Math.round(r.x), 0), Math.round(view.width) - width);
  const y = Math.min(Math.max(Math.round(r.y), 0), Math.round(view.height) - height);
  const out = { x, y, width, height };
  return isUsableRegion(out) ? out : null;
}

/**
 * CSS-pixel region → the physical-pixel crop rect of the captured image.
 *
 * Scaled per axis by imageSize / viewSize rather than by the display's
 * scaleFactor: the capture is not always exactly bounds × scaleFactor
 * (fractional Windows scaling rounds, Linux portals may hand back another
 * size), and the ratio of what we actually got is what maps the overlay's
 * pixels onto the image. Edges are floored/ceiled outward so a region never
 * loses its last pixel row, then clamped to the image.
 */
export function regionToPixels(
  r: Region,
  view: { width: number; height: number },
  image: { width: number; height: number }
): Region {
  const sx = image.width / view.width;
  const sy = image.height / view.height;
  const left = Math.max(0, Math.floor(r.x * sx));
  const top = Math.max(0, Math.floor(r.y * sy));
  const right = Math.min(image.width, Math.ceil((r.x + r.width) * sx));
  const bottom = Math.min(image.height, Math.ceil((r.y + r.height) * sy));
  return { x: left, y: top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
}

// ─── Meetings ───────────────────────────────────────────────────────────────

export type MeetingSpeaker = 'you' | 'them';

export interface MeetingSegment {
  speaker: MeetingSpeaker;
  startMs: number;
  endMs: number;
  text: string;
}

/** recording → transcribing → ready, or failed (transcription error, with a
 *  retry while the audio is kept), or interrupted (the app stopped mid-way). */
export type MeetingStatus = 'recording' | 'transcribing' | 'ready' | 'failed' | 'interrupted';

export interface MeetingRecord {
  /** The folder name: `YYYY-MM-DD HHmm slug`. */
  id: string;
  title: string;
  description: string;
  /** ISO timestamp. */
  startedAt: string;
  durationMs: number;
  status: MeetingStatus;
  segments: MeetingSegment[];
  /** Which transcription engine produced the segments. */
  engine?: string;
  error?: string;
  updatedAt: string;
  /** Capture files kept (by the transcribe unit) for a retry. */
  audio?: { micWav?: string; systemWav?: string };
}

export interface MeetingSummary {
  id: string;
  title: string;
  description: string;
  startedAt: string;
  durationMs: number;
  status: MeetingStatus;
  segmentCount: number;
  /** The first lines of the transcript, or the text around a search hit. */
  snippet: string;
  error?: string;
}

export interface MeetingPatch {
  title?: string;
  description?: string;
  segments?: MeetingSegment[];
}

export const MAX_TITLE_CHARS = 200;
export const MAX_DESCRIPTION_CHARS = 20_000;
export const MAX_SEGMENT_CHARS = 20_000;
export const MAX_SEGMENTS = 20_000;

/** Validate and trim segments from an untrusted source. Never throws. */
export function sanitizeSegments(value: unknown): MeetingSegment[] {
  if (!Array.isArray(value)) return [];
  const out: MeetingSegment[] = [];
  for (const raw of value.slice(0, MAX_SEGMENTS)) {
    if (!raw || typeof raw !== 'object') continue;
    const s = raw as Record<string, unknown>;
    if (typeof s.text !== 'string') continue;
    const startMs = finite(s.startMs) && s.startMs >= 0 ? Math.round(s.startMs) : 0;
    const endMs = finite(s.endMs) && s.endMs >= startMs ? Math.round(s.endMs) : startMs;
    out.push({
      speaker: s.speaker === 'them' ? 'them' : 'you',
      startMs,
      endMs,
      text: s.text.slice(0, MAX_SEGMENT_CHARS)
    });
  }
  return out;
}

/** Validate a library edit. Null when nothing valid is in it. */
export function sanitizeMeetingPatch(value: unknown): MeetingPatch | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const out: MeetingPatch = {};
  if (typeof v.title === 'string') out.title = v.title.replace(/[\r\n\t]+/g, ' ').trim().slice(0, MAX_TITLE_CHARS);
  if (typeof v.description === 'string') out.description = v.description.slice(0, MAX_DESCRIPTION_CHARS);
  if (Array.isArray(v.segments)) out.segments = sanitizeSegments(v.segments);
  return Object.keys(out).length ? out : null;
}

/** 0:42 · 12:05 · 1:02:03 */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

// ─── Capture sessions ───────────────────────────────────────────────────────

/** A capture session id the Stapler mints: `stapler-<kind>-<base36 time>-<rand>`.
 *  Letters, digits and dashes only, so every unit's id check accepts it. */
export function newSessionId(kind: 'message' | 'meeting', now: number = Date.now(), rand: () => number = Math.random): string {
  const r = Math.floor(rand() * 36 ** 6).toString(36).padStart(6, '0');
  return `stapler-${kind === 'meeting' ? 'mtg' : 'msg'}-${Math.floor(now).toString(36)}-${r}`;
}

/** What the puck hands main after a capture stops, to transcribe. */
export interface StaplerTranscribeRequest {
  kind: 'message' | 'meeting';
  sessionId: string;
  micWav?: string;
  systemWav?: string;
  durationMs: number;
  /** Meetings: the folder created at start. */
  meetingId?: string;
}

export interface StaplerTranscribeResult {
  ok: boolean;
  text: string;
  segments: MeetingSegment[];
  engine?: string;
  error?: string;
  /** Meetings: the saved meeting. */
  meeting?: MeetingSummary;
}
