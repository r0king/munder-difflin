/**
 * Where the Stapler's windows go — pure rectangle math, no Electron.
 *
 * The puck is a small always-on-top window that the user drags anywhere. Three
 * promises from the spec live here: the drag follows the pointer (main moves the
 * window to `cursor - grabOffset`, see stapler.ts), Reset puts it in the middle
 * of the screen, and it never ends up off screen — clamped on drag end, at
 * startup and whenever a display is added, removed or rescaled.
 *
 * Positions are remembered PER DISPLAY and stored relative to that display's
 * work area, not as absolute desktop coordinates: rearranging monitors in the
 * OS moves every absolute coordinate, while "48 px from the right edge of the
 * laptop screen" stays true.
 *
 * Everything takes plain `{ id, bounds, workArea }` objects so it is tested
 * with node:test (test/stapler-geometry.test.cjs) without an Electron runtime.
 */

export interface Point { x: number; y: number }
export interface Size { width: number; height: number }
export interface Rect extends Point, Size {}

export interface DisplayLike {
  id: number | string;
  bounds: Rect;
  workArea: Rect;
}

/** A remembered puck spot: the window's top-left, relative to the work area. */
export interface SavedSpot { dx: number; dy: number }

export interface SavedPlacement {
  /** Keyed by String(display.id). */
  positions: Record<string, SavedSpot>;
  /** The display the puck was last on. */
  lastDisplayId?: string;
}

/** The puck window in its resting state: the 56 px creature + room for its
 *  recording badge and hard shadow. */
export const PUCK_WINDOW: Size = { width: 80, height: 80 };
/** The ring: eight 40 px buttons on a 100 px radius around the puck. */
export const RING_WINDOW: Size = { width: 288, height: 288 };
/** A flow panel (shots tray, message, meeting, settings, To). */
export const PANEL_WINDOW: Size = { width: 400, height: 560 };
export const PANEL_WINDOW_TALL: Size = { width: 440, height: 640 };

const int = (n: number): number => (Number.isFinite(n) ? Math.round(n) : 0);

export function rectCenter(r: Rect): Point {
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

/** Area of the intersection of two rects (0 when they do not overlap). */
export function overlapArea(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

function distanceToRect(p: Point, r: Rect): number {
  const dx = Math.max(r.x - p.x, 0, p.x - (r.x + r.width));
  const dy = Math.max(r.y - p.y, 0, p.y - (r.y + r.height));
  return Math.hypot(dx, dy);
}

/** The display containing `p`, else the one closest to it. Null only when the
 *  list is empty. */
export function displayNearestPoint<D extends DisplayLike>(displays: readonly D[], p: Point): D | null {
  let best: D | null = null;
  let bestD = Infinity;
  for (const d of displays) {
    const dist = distanceToRect(p, d.bounds);
    if (dist < bestD) { best = d; bestD = dist; }
    if (dist === 0) break;
  }
  return best;
}

/** The display a window mostly sits on: largest overlap, ties and no-overlap
 *  resolved by the window's centre. */
export function displayForRect<D extends DisplayLike>(displays: readonly D[], r: Rect): D | null {
  let best: D | null = null;
  let bestArea = 0;
  for (const d of displays) {
    const a = overlapArea(r, d.bounds);
    if (a > bestArea) { best = d; bestArea = a; }
  }
  return best ?? displayNearestPoint(displays, rectCenter(r));
}

/**
 * Move `r` (keeping its size where possible) so it lies entirely inside
 * `area`. A rect larger than the area is shrunk to it — a 400 px panel on a
 * 320 px-tall work area must still fit. Integer output: Electron rounds
 * anyway, and two roundings in a row are how a window creeps 1 px per drag.
 */
export function clampRect(r: Rect, area: Rect): Rect {
  const width = Math.min(int(r.width), int(area.width));
  const height = Math.min(int(r.height), int(area.height));
  const maxX = area.x + area.width - width;
  const maxY = area.y + area.height - height;
  return {
    x: int(Math.min(Math.max(r.x, area.x), maxX)),
    y: int(Math.min(Math.max(r.y, area.y), maxY)),
    width,
    height
  };
}

/** A rect of `size` centred in `area` (then clamped, for tiny areas). */
export function centerIn(area: Rect, size: Size): Rect {
  return clampRect({
    x: area.x + (area.width - size.width) / 2,
    y: area.y + (area.height - size.height) / 2,
    width: size.width,
    height: size.height
  }, area);
}

/** Is any part of `r` on any display? (A window entirely in the gap between
 *  two monitors is "off screen" even if each coordinate looks plausible.) */
export function isOnSomeDisplay(displays: readonly DisplayLike[], r: Rect): boolean {
  return displays.some((d) => overlapArea(r, d.workArea) > 0);
}

/** The remembered spot for `display`, as a clamped absolute rect, or null. */
export function rectFromSpot(display: DisplayLike, spot: SavedSpot | undefined, size: Size): Rect | null {
  if (!spot || !Number.isFinite(spot.dx) || !Number.isFinite(spot.dy)) return null;
  const wa = display.workArea;
  return clampRect({ x: wa.x + spot.dx, y: wa.y + spot.dy, width: size.width, height: size.height }, wa);
}

/** `r` as a spot relative to `display`'s work area. */
export function spotFromRect(display: DisplayLike, r: Rect): SavedSpot {
  return { dx: int(r.x - display.workArea.x), dy: int(r.y - display.workArea.y) };
}

/**
 * Where the puck starts: the display it was last on (if still connected) at
 * its remembered spot, else the primary display's remembered spot, else the
 * middle of the primary display. Always on screen.
 */
export function initialPuckRect(
  displays: readonly DisplayLike[],
  primaryId: number | string,
  saved: SavedPlacement,
  size: Size = PUCK_WINDOW
): { rect: Rect; displayId: string } | null {
  if (!displays.length) return null;
  const byId = (id: string | undefined) => (id === undefined ? undefined : displays.find((d) => String(d.id) === id));
  const last = byId(saved.lastDisplayId);
  if (last) {
    const r = rectFromSpot(last, saved.positions[String(last.id)], size);
    if (r) return { rect: r, displayId: String(last.id) };
  }
  const primary = byId(String(primaryId)) ?? displays[0];
  const r = rectFromSpot(primary, saved.positions[String(primary.id)], size);
  return { rect: r ?? centerIn(primary.workArea, size), displayId: String(primary.id) };
}

/**
 * After the display set changed: keep the puck where it is if that is still
 * on a display (clamped into that display's work area — a resolution change
 * can leave it half off the edge), otherwise fall back to `initialPuckRect`.
 */
export function reclampPuckRect(
  displays: readonly DisplayLike[],
  primaryId: number | string,
  current: Rect,
  saved: SavedPlacement
): { rect: Rect; displayId: string } | null {
  if (!displays.length) return null;
  if (isOnSomeDisplay(displays, current)) {
    const d = displayForRect(displays, current);
    if (d) return { rect: clampRect(current, d.workArea), displayId: String(d.id) };
  }
  // The display it was on is gone: forget it as "last" so the primary wins.
  const fallback: SavedPlacement = { ...saved, lastDisplayId: undefined };
  return initialPuckRect(displays, primaryId, fallback, { width: current.width, height: current.height });
}

/**
 * The ring window: centred on the puck, then clamped. When the puck sits near
 * an edge the clamp moves the whole ring inward, and since the renderer always
 * draws the puck at the ring window's centre, the puck visibly slides in with
 * it and slides back when the ring closes — every button stays on screen.
 */
export function ringRect(puck: Rect, workArea: Rect, size: Size = RING_WINDOW): Rect {
  const c = rectCenter(puck);
  return clampRect({ x: c.x - size.width / 2, y: c.y - size.height / 2, width: size.width, height: size.height }, workArea);
}

/**
 * A flow panel grows out of the puck's corner that faces the middle of the
 * screen: a puck in the right half anchors the panel's right edge to its own,
 * one in the bottom half anchors the bottom edge. Then clamped.
 */
export function panelRect(puck: Rect, workArea: Rect, size: Size = PANEL_WINDOW): Rect {
  const c = rectCenter(puck);
  const mid = rectCenter(workArea);
  const x = c.x >= mid.x ? puck.x + puck.width - size.width : puck.x;
  const y = c.y >= mid.y ? puck.y + puck.height - size.height : puck.y;
  return clampRect({ x, y, width: size.width, height: size.height }, workArea);
}

/** The window's top-left for a drag: the cursor minus where it grabbed. */
export function dragPosition(cursor: Point, grab: Point): Point {
  return { x: int(cursor.x - grab.x), y: int(cursor.y - grab.y) };
}

/** Validate a SavedPlacement read from disk. Never throws. */
export function sanitizePlacement(value: unknown): SavedPlacement {
  const out: SavedPlacement = { positions: {} };
  if (!value || typeof value !== 'object') return out;
  const v = value as Record<string, unknown>;
  const pos = v.positions;
  if (pos && typeof pos === 'object' && !Array.isArray(pos)) {
    let n = 0;
    for (const [k, s] of Object.entries(pos as Record<string, unknown>)) {
      if (n >= 32) break; // a handful of monitors, not an unbounded map
      if (!s || typeof s !== 'object' || k.length > 64) continue;
      const { dx, dy } = s as Record<string, unknown>;
      if (typeof dx === 'number' && typeof dy === 'number' && Number.isFinite(dx) && Number.isFinite(dy)) {
        out.positions[k] = { dx: int(dx), dy: int(dy) };
        n++;
      }
    }
  }
  if (typeof v.lastDisplayId === 'string' && v.lastDisplayId.length <= 64) out.lastDisplayId = v.lastDisplayId;
  return out;
}
