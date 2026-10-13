'use strict';

// Workspace Tasks — moving cards with the keyboard. Arrows move focus;
// Shift+Left/Right stages a move at once; Space lifts, arrows carry, Space or
// Enter drops, Escape cancels. Left/Right are visual (mirrored in RTL).

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const k = loadTs('src/shared/workspace/tasksKeys.ts');

const layout = {
  columns: [
    { column: 'todo', ids: ['a', 'b'] },
    { column: 'doing', ids: ['c'] },
    { column: 'blocked', ids: [] },
    { column: 'done', ids: ['d', 'e', 'f'] }
  ]
};
const press = (state, key, extra = {}, rtl = false) => k.boardKeyReducer(state, { key, ...extra }, layout, rtl);
const at = (id) => ({ focusId: id, lifted: null });

test('with nothing focused, an arrow lands on the first card', () => {
  const r = press(k.INITIAL_BOARD_KEYS, 'ArrowDown');
  assert.deepEqual(r.effect, { kind: 'focus', id: 'a' });
  assert.equal(r.handled, true);
  assert.equal(press(k.INITIAL_BOARD_KEYS, 'x').handled, false);
});

test('Up/Down move within a column and stop at its ends', () => {
  assert.deepEqual(press(at('a'), 'ArrowDown').effect, { kind: 'focus', id: 'b' });
  assert.equal(press(at('b'), 'ArrowDown').effect, null);
  assert.equal(press(at('b'), 'ArrowDown').handled, true);
  assert.deepEqual(press(at('e'), 'ArrowUp').effect, { kind: 'focus', id: 'd' });
  assert.deepEqual(press(at('d'), 'End').effect, { kind: 'focus', id: 'f' });
  assert.deepEqual(press(at('f'), 'Home').effect, { kind: 'focus', id: 'd' });
});

test('Left/Right jump to the nearest card in the next non-empty column', () => {
  assert.deepEqual(press(at('b'), 'ArrowRight').effect, { kind: 'focus', id: 'c' });
  // Blocked is empty, so Right from Doing skips to Done.
  assert.deepEqual(press(at('c'), 'ArrowRight').effect, { kind: 'focus', id: 'd' });
  assert.deepEqual(press(at('f'), 'ArrowLeft').effect, { kind: 'focus', id: 'c' });
  assert.equal(press(at('a'), 'ArrowLeft').effect, null);
});

test('RTL mirrors Left and Right', () => {
  assert.deepEqual(press(at('b'), 'ArrowLeft', {}, true).effect, { kind: 'focus', id: 'c' });
  assert.deepEqual(press(at('c'), 'ArrowLeft', { shiftKey: true }, true).effect, { kind: 'stage', id: 'c', to: 'blocked' });
});

test('Shift+arrow stages a move one column over, even into an empty column', () => {
  assert.deepEqual(press(at('c'), 'ArrowRight', { shiftKey: true }).effect, { kind: 'stage', id: 'c', to: 'blocked' });
  assert.deepEqual(press(at('c'), 'ArrowLeft', { shiftKey: true }).effect, { kind: 'stage', id: 'c', to: 'todo' });
  // At the edge it does nothing, but still owns the key.
  const edge = press(at('a'), 'ArrowLeft', { shiftKey: true });
  assert.equal(edge.effect, null);
  assert.equal(edge.handled, true);
});

test('Space lifts, arrows carry, Space drops and stages', () => {
  let r = press(at('c'), ' ');
  assert.deepEqual(r.state.lifted, { id: 'c', origin: 'doing', column: 'doing' });
  r = press(r.state, 'ArrowRight');
  assert.deepEqual(r.effect, { kind: 'announce-lift', id: 'c', column: 'blocked' });
  r = press(r.state, 'ArrowRight');
  r = press(r.state, 'ArrowRight'); // clamps at Done
  assert.equal(r.state.lifted.column, 'done');
  assert.equal(r.effect, null);
  r = press(r.state, ' ');
  assert.deepEqual(r.effect, { kind: 'stage', id: 'c', to: 'done' });
  assert.deepEqual(r.state, { focusId: 'c', lifted: null });
});

test('dropping where it was lifted, or Escape, stages nothing', () => {
  let r = press(at('c'), ' ');
  r = press(r.state, 'Enter');
  assert.equal(r.effect, null);
  assert.equal(r.state.lifted, null);
  r = press(at('c'), ' ');
  r = press(r.state, 'ArrowRight');
  r = press(r.state, 'Escape');
  assert.deepEqual(r.effect, { kind: 'announce-cancel', id: 'c' });
  assert.equal(r.state.lifted, null);
});

test('Enter opens; chords with Ctrl/Cmd/Alt are left to the app', () => {
  assert.deepEqual(press(at('d'), 'Enter').effect, { kind: 'open', id: 'd' });
  assert.equal(press(at('d'), 'ArrowRight', { metaKey: true }).handled, false);
  assert.equal(press(at('d'), 'ArrowRight', { altKey: true }).handled, false);
});
