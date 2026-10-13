'use strict';

/**
 * Where the Stapler's puck goes. Three promises from the release notes are
 * pinned here: Reset puts it in the middle of the screen, it never ends up off
 * screen (startup, drag end, display unplugged or rescaled), and the drag
 * follows the pointer (window = cursor − grab offset, no drift).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const g = loadTs('src/main/features/stapler/geometry.ts');

const laptop = { id: 1, bounds: { x: 0, y: 0, width: 1440, height: 900 }, workArea: { x: 0, y: 25, width: 1440, height: 875 } };
const external = { id: 2, bounds: { x: 1440, y: -200, width: 2560, height: 1440 }, workArea: { x: 1440, y: -200, width: 2560, height: 1400 } };
const left = { id: 3, bounds: { x: -1920, y: 0, width: 1920, height: 1080 }, workArea: { x: -1920, y: 0, width: 1920, height: 1040 } };
const P = g.PUCK_WINDOW;

const inside = (r, a) => r.x >= a.x && r.y >= a.y && r.x + r.width <= a.x + a.width && r.y + r.height <= a.y + a.height;

test('clampRect keeps a rect that fits, moves one that spills, shrinks one too big', () => {
  const wa = laptop.workArea;
  assert.deepEqual(g.clampRect({ x: 100, y: 100, width: 80, height: 80 }, wa), { x: 100, y: 100, width: 80, height: 80 });
  assert.deepEqual(g.clampRect({ x: 1400, y: 880, width: 80, height: 80 }, wa), { x: 1360, y: 820, width: 80, height: 80 });
  assert.deepEqual(g.clampRect({ x: -50, y: -50, width: 80, height: 80 }, wa), { x: 0, y: 25, width: 80, height: 80 });
  const huge = g.clampRect({ x: 10, y: 10, width: 4000, height: 4000 }, wa);
  assert.deepEqual(huge, { x: 0, y: 25, width: 1440, height: 875 });
});

test('clampRect returns integers (no 1px creep per drag)', () => {
  const r = g.clampRect({ x: 10.6, y: 30.4, width: 80, height: 80 }, laptop.workArea);
  assert.ok(Number.isInteger(r.x) && Number.isInteger(r.y));
});

test('centerIn: Reset puts it in the middle of the work area', () => {
  const r = g.centerIn(laptop.workArea, P);
  assert.equal(r.x, (1440 - 80) / 2);
  assert.equal(r.y, Math.round(25 + (875 - 80) / 2));
});

test('displayForRect prefers the display with the most overlap; nearest when on none', () => {
  const displays = [laptop, external];
  assert.equal(g.displayForRect(displays, { x: 1420, y: 100, width: 80, height: 80 }).id, 2);
  assert.equal(g.displayForRect(displays, { x: 1300, y: 100, width: 80, height: 80 }).id, 1);
  assert.equal(g.displayForRect(displays, { x: 5000, y: 100, width: 80, height: 80 }).id, 2);
  assert.equal(g.displayNearestPoint([], { x: 0, y: 0 }), null);
});

test('spots are relative to the work area, so rearranging monitors keeps the spot', () => {
  const spot = g.spotFromRect(external, { x: 1440 + 2000, y: -200 + 600, width: 80, height: 80 });
  assert.deepEqual(spot, { dx: 2000, dy: 600 });
  const moved = { ...external, bounds: { ...external.bounds, x: -2560 }, workArea: { ...external.workArea, x: -2560 } };
  assert.deepEqual(g.rectFromSpot(moved, spot, P), { x: -560, y: 400, width: 80, height: 80 });
});

test('initialPuckRect: last display, then the primary spot, then the middle of the primary', () => {
  const displays = [laptop, external];
  const saved = { positions: { '2': { dx: 100, dy: 100 }, '1': { dx: 10, dy: 10 } }, lastDisplayId: '2' };
  assert.deepEqual(g.initialPuckRect(displays, 1, saved), { rect: { x: 1540, y: -100, width: 80, height: 80 }, displayId: '2' });
  // External unplugged: falls back to the primary's own remembered spot.
  assert.deepEqual(g.initialPuckRect([laptop], 1, saved), { rect: { x: 10, y: 35, width: 80, height: 80 }, displayId: '1' });
  // Nothing saved: the middle of the primary.
  const fresh = g.initialPuckRect([laptop], 1, { positions: {} });
  assert.deepEqual(fresh.rect, g.centerIn(laptop.workArea, P));
  assert.equal(g.initialPuckRect([], 1, { positions: {} }), null);
});

test('initialPuckRect never starts off screen, whatever the file says', () => {
  const saved = { positions: { '1': { dx: 99999, dy: -99999 } }, lastDisplayId: '1' };
  const r = g.initialPuckRect([laptop], 1, saved).rect;
  assert.ok(inside(r, laptop.workArea));
});

test('reclampPuckRect: a resolution drop pulls it back inside; an unplug moves it to the primary', () => {
  const smaller = { ...laptop, bounds: { x: 0, y: 0, width: 1280, height: 800 }, workArea: { x: 0, y: 25, width: 1280, height: 775 } };
  const r = g.reclampPuckRect([smaller], 1, { x: 1350, y: 820, width: 80, height: 80 }, { positions: {} });
  assert.ok(inside(r.rect, smaller.workArea));
  assert.equal(r.displayId, '1');

  const onExternal = { x: 3000, y: 200, width: 80, height: 80 };
  const gone = g.reclampPuckRect([laptop], 1, onExternal, { positions: { '1': { dx: 40, dy: 40 } }, lastDisplayId: '2' });
  assert.deepEqual(gone.rect, { x: 40, y: 65, width: 80, height: 80 });
});

test('a puck in the gap between two monitors counts as off screen', () => {
  const displays = [left, laptop];
  assert.equal(g.isOnSomeDisplay(displays, { x: 0, y: 2000, width: 80, height: 80 }), false);
  const r = g.reclampPuckRect(displays, 1, { x: 0, y: 2000, width: 80, height: 80 }, { positions: {} });
  assert.ok(inside(r.rect, laptop.workArea));
});

test('ringRect centres on the puck, and slides inward at an edge', () => {
  const wa = laptop.workArea;
  const mid = { x: 600, y: 400, width: 80, height: 80 };
  assert.deepEqual(g.ringRect(mid, wa), { x: 640 - 144, y: 440 - 144, width: 288, height: 288 });
  const corner = g.ringRect({ x: 1360, y: 25, width: 80, height: 80 }, wa);
  assert.ok(inside(corner, wa));
  assert.equal(corner.x + corner.width, 1440);
  assert.equal(corner.y, 25);
});

test('panelRect grows out of the corner facing the middle of the screen', () => {
  const wa = laptop.workArea;
  const S = g.PANEL_WINDOW;
  // Top-left puck: panel shares its top-left corner.
  assert.deepEqual(g.panelRect({ x: 40, y: 60, width: 80, height: 80 }, wa), { x: 40, y: 60, ...S });
  // Bottom-right puck: panel shares its bottom-right corner.
  const br = g.panelRect({ x: 1300, y: 780, width: 80, height: 80 }, wa);
  assert.equal(br.x + br.width, 1380);
  assert.equal(br.y + br.height, 860);
  // Tiny screen: still fully on it.
  const tiny = { x: 0, y: 0, width: 360, height: 480 };
  assert.ok(inside(g.panelRect({ x: 10, y: 10, width: 80, height: 80 }, tiny), tiny));
});

test('dragPosition: the window follows the cursor exactly, offset by where it was grabbed', () => {
  assert.deepEqual(g.dragPosition({ x: 500, y: 300 }, { x: 30, y: 20 }), { x: 470, y: 280 });
  assert.deepEqual(g.dragPosition({ x: -10, y: 5 }, { x: 40, y: 40 }), { x: -50, y: -35 });
});

test('sanitizePlacement drops garbage and caps the map', () => {
  assert.deepEqual(g.sanitizePlacement(null), { positions: {} });
  const big = { positions: {} };
  for (let i = 0; i < 100; i++) big.positions[String(i)] = { dx: i, dy: i };
  big.positions.bad = { dx: 'x', dy: 1 };
  big.lastDisplayId = '7';
  const out = g.sanitizePlacement(big);
  assert.equal(Object.keys(out.positions).length, 32);
  assert.equal(out.lastDisplayId, '7');
  assert.equal(out.positions.bad, undefined);
});
