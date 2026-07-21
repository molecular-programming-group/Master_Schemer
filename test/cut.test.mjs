// Run: node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bladeCross, splitSegments } from '../app/js/geom.js';
import { state, cutPath, byId } from '../app/js/model.js';

test('bladeCross returns arc length of first crossing, null on a miss', () => {
  const pts = [[0, 0], [100, 0]]; // horizontal line, length 100
  // vertical blade at x=30 crosses at arc length 30
  assert.equal(bladeCross(pts, [30, -10], [30, 10]), 30);
  // blade that never reaches the line misses
  assert.equal(bladeCross(pts, [30, 5], [30, 20]), null);
  // corner path: down-leg (x=0) then right-leg (y=50), corner at arc length 50
  const bent = [[0, 0], [0, 50], [50, 50]]; // total length 100
  assert.equal(bladeCross(bent, [-10, 20], [10, 20]), 20);  // horizontal blade hits the down leg
  assert.equal(bladeCross(bent, [30, 40], [30, 60]), 80);   // vertical blade hits the right leg (50 + 30)
});

test('splitSegments clips straddling segments and rebases the far side', () => {
  const [before, after] = splitSegments(
    [{ t0: 10, t1: 80, color: 'red' }], 30, 100);
  assert.deepEqual(before, [{ t0: 10, t1: 30, color: 'red' }]);
  assert.deepEqual(after, [{ t0: 0, t1: 50, color: 'red' }]); // 30..80 rebased to 0..50
});

test('cutPath slices a line into two inheriting children, drops links', () => {
  state.doc = { version: 3, elements: [], palette: [], groups: [], labelSlots: [] };
  state.history = []; state.future = []; state.selection = [];
  const line = {
    type: 'path', id: 'L', pts: [[0, 0], [100, 0]], color: 'slot:s1', width: 6,
    label: 'chain', group: 'g1', cap0: 'harpoon', cap1: 'arrow',
    segments: [{ t0: 20, t1: 90, color: 'blue' }],
  };
  state.doc.elements.push(line, { type: 'link', id: 'K', a: { id: 'L' }, b: { id: 'X' } });

  const [a, b] = cutPath(line, 40);

  // parent replaced by two children in its paint slot; link removed
  assert.deepEqual(state.doc.elements.map(e => e.id), [a.id, b.id]);
  assert.equal(byId('L'), undefined);

  // geometry sliced at 40
  assert.deepEqual(a.pts, [[0, 0], [40, 0]]);
  assert.deepEqual(b.pts, [[40, 0], [100, 0]]);

  // metadata inherited; both children carry the parent's full cap pair
  assert.equal(a.color, 'slot:s1'); assert.equal(a.label, 'chain'); assert.equal(a.group, 'g1');
  assert.equal(a.cap0, 'harpoon'); assert.equal(a.cap1, 'arrow');
  assert.equal(b.cap0, 'harpoon'); assert.equal(b.cap1, 'arrow');

  // segment [20,90] split across the cut and rebased
  assert.deepEqual(a.segments, [{ t0: 20, t1: 40, color: 'blue' }]);
  assert.deepEqual(b.segments, [{ t0: 0, t1: 50, color: 'blue' }]);

  // cutting too close to an end is a no-op
  assert.equal(cutPath(a, 0.2), null);
});
