// Run: node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GRID, snap, snapHalf, snap8, simplify, polylineLength, pointAt, nearestOnPath,
  subPath, rectEdgePoint, mergePaths,
} from '../app/js/geom.js';

test('snap rounds to grid', () => {
  assert.equal(snap(29), 20);
  assert.equal(snap(31), 40);
  assert.equal(snap(-9), 0);
  assert.equal(snap(-11), -20);
});

test('snap8 quantizes to 8 directions on the grid', () => {
  const a = [0, 0];
  assert.deepEqual(snap8(a, [67, 3]), [60, 0]);        // east
  assert.deepEqual(snap8(a, [3, -67]), [0, -60]);      // north
  assert.deepEqual(snap8(a, [50, 46]), [40, 40]);      // south-east diagonal
  assert.deepEqual(snap8(a, [-45, 41]), [-40, 40]);    // south-west diagonal
  assert.deepEqual(snap8(a, [-66, -5]), [-60, 0]);     // west
  assert.deepEqual(snap8(a, [0, 0]), [0, 0]);          // degenerate
  // never behind the anchor: projection would be negative
  assert.deepEqual(snap8([100, 100], [100, 100]), [100, 100]);
});

test('simplify drops duplicates and collinear points', () => {
  assert.deepEqual(
    simplify([[0, 0], [20, 0], [40, 0], [40, 0], [40, 20], [40, 40]]),
    [[0, 0], [40, 0], [40, 40]]);
  assert.deepEqual(simplify([[0, 0], [0, 0]]), [[0, 0]]);
});

test('arc length parametrization', () => {
  const pts = [[0, 0], [100, 0], [100, 50]];
  assert.equal(polylineLength(pts), 150);
  assert.deepEqual(pointAt(pts, 0), [0, 0]);
  assert.deepEqual(pointAt(pts, 50), [50, 0]);
  assert.deepEqual(pointAt(pts, 125), [100, 25]);
  assert.deepEqual(pointAt(pts, 999), [100, 50]); // clamped
});

test('nearestOnPath projects onto the closest segment', () => {
  const pts = [[0, 0], [100, 0]];
  const n = nearestOnPath(pts, [40, 10]);
  assert.equal(n.t, 40);
  assert.equal(n.d, 10);
  const corner = nearestOnPath([[0, 0], [100, 0], [100, 100]], [110, 50]);
  assert.equal(corner.t, 150);
  assert.equal(corner.d, 10);
});

test('subPath interpolates endpoints and keeps interior corners', () => {
  const pts = [[0, 0], [100, 0], [100, 100]];
  assert.deepEqual(subPath(pts, 50, 150), [[50, 0], [100, 0], [100, 50]]);
});

test('rectEdgePoint exits through the correct border', () => {
  assert.deepEqual(rectEdgePoint(50, 50, 100, 100, 200, 50), [100, 50]);
  assert.deepEqual(rectEdgePoint(50, 50, 100, 100, 50, -200), [50, 0]);
  // target inside the rect: clamps at the target
  assert.deepEqual(rectEdgePoint(50, 50, 100, 100, 60, 50), [60, 50]);
});

test('GRID is the lattice pitch everything assumes', () => {
  assert.equal(GRID, 20);
});

test('snapHalf rounds to the half-grid lattice', () => {
  assert.equal(snapHalf(13), 10);
  assert.equal(snapHalf(16), 20);
  assert.equal(snapHalf(-4), 0);
  assert.equal(snapHalf(-6), -10);
});

test('mergePaths fuses at a shared endpoint and re-bases segments', () => {
  const A = [[0, 0], [100, 0]];
  const B = [[100, 0], [100, 50]];
  const segA = [{ t0: 10, t1: 30, color: '#111', label: 'a' }];
  const segB = [{ t0: 5, t1: 25, color: '#222', label: 'b' }];

  // head-to-tail
  let m = mergePaths(A, segA, B, segB);
  assert.deepEqual(m.pts, [[0, 0], [100, 0], [100, 50]]);
  assert.deepEqual(m.segments.map(s => [s.t0, s.t1]), [[10, 30], [105, 125]]);

  // tail-to-tail: B gets reversed, so its segment range flips before shifting
  m = mergePaths(A, segA, [[100, 50], [100, 0]], segB);
  assert.deepEqual(m.pts, [[0, 0], [100, 0], [100, 50]]);
  assert.deepEqual(m.segments.map(s => [s.t0, s.t1]), [[10, 30], [125, 145]]);

  // B ends where A starts: B comes first, A's segments shift by B's length
  m = mergePaths(A, segA, [[0, -50], [0, 0]], segB);
  assert.deepEqual(m.pts, [[0, -50], [0, 0], [100, 0]]);
  assert.deepEqual(m.segments.map(s => [s.t0, s.t1]), [[5, 25], [60, 80]]);

  // no shared endpoint
  assert.equal(mergePaths(A, [], [[500, 500], [600, 500]], []), null);

  // inputs are not mutated
  assert.deepEqual(segB, [{ t0: 5, t1: 25, color: '#222', label: 'b' }]);
});
