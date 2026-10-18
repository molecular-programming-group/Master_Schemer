// Run: node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { smoothSpans, smoothD, smoothPts, drawnPts, polylineLength, nearestOnPath, rotatePt } from '../app/js/geom.js';

test('smooth curve passes through every vertex, uniform spacing = classic Catmull-Rom', () => {
  const pts = [[0, 0], [10, 0], [20, 0], [30, 0]];
  const sp = smoothSpans(pts);
  assert.equal(sp.length, 3);
  // evenly spaced: c1 = p1 + (p2 - p0)/6 → straight line stays straight
  assert.deepEqual(sp[1][1].map(v => +v.toFixed(6)), [+(10 + 20 / 6).toFixed(6), 0]);
  const zz = [[0, 0], [40, 40], [80, 0], [120, 40]];
  const dense = smoothPts(zz);
  for (const v of zz) assert.ok(nearestOnPath(dense, v).d < 1e-6, `passes through ${v}`);
  assert.ok(polylineLength(dense) > polylineLength(zz)); // bends add length
  assert.match(smoothD(zz), /^M0 0 C.* 120 40$/);
});

test('closed curve wraps around; drawnPts only smooths when asked', () => {
  const sq = [[0, 0], [100, 0], [100, 100], [0, 100]];
  assert.equal(smoothSpans(sq, true).length, 4);
  const ring = smoothPts(sq, true);
  assert.deepEqual(ring[0], ring[ring.length - 1]);
  assert.ok(smoothD(sq, true).endsWith(' Z'));
  assert.equal(drawnPts({ pts: sq }), sq);
  assert.notEqual(drawnPts({ pts: sq, smooth: true }), sq);
  // duplicate neighbours must not produce NaN
  assert.ok(smoothPts([[0, 0], [0, 0], [10, 10]]).every(p => p.every(Number.isFinite)));
});

test('rotatePt turns about a centre, y down = clockwise', () => {
  assert.deepEqual(rotatePt([10, 0], [0, 0], 90).map(Math.round), [0, 10]);
  assert.deepEqual(rotatePt([5, 5], [5, 5], 33), [5, 5]);
});
