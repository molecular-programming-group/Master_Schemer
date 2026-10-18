import test from 'node:test';
import assert from 'node:assert/strict';
import { strandLayout, uAt, tAt, naturalBases, gridPitch, brushPath, midline, seqLetters } from '../app/js/dna.js';
import { pointAt, snap8 } from '../app/js/geom.js';

test('strandLayout: free length shares the free count, fixed spans keep theirs', () => {
  const D = gridPitch(10); // the DNA grid: 10 bases per 20-unit square
  // no fixed spans, auto: the grid's count
  const auto = strandLayout(200, D, [], undefined);
  assert.equal(auto.n, 100);
  assert.equal(naturalBases(30, D), 15);
  // a 12 bp paired domain in the middle, 30 free bases split by length (50 : 100)
  const lay = strandLayout(200, D, [{ t0: 50, t1: 100, count: 12, paired: true }], 30);
  assert.equal(lay.n, 42);
  assert.deepEqual(lay.spans.map(s => [s.t0, s.t1, s.paired]), [[50, 100, true]]);
  assert.equal(uAt(lay.knots, 50), 10);
  assert.equal(uAt(lay.knots, 100), 22);
  assert.equal(uAt(lay.knots, 200), 42);
  assert.equal(tAt(lay.knots, 16), 75); // linear inside the domain
  // changing the domain's count leaves the free stretches alone (domains are independent)
  const more = strandLayout(200, D, [{ t0: 50, t1: 100, count: 20, paired: true }], 30);
  assert.equal(more.n, 50);
  assert.equal(uAt(more.knots, 50), 10);
  // a wholly fixed strand has no free length; overlapping later spans lose
  const all = strandLayout(100, D, [{ t0: 0, t1: 100, count: 8 }, { t0: 40, t1: 60, count: 99 }], 5);
  assert.equal(all.n, 8);
  assert.equal(all.freeLen, 0);
  // free shares are whole bases even when lengths don't divide evenly
  const odd = strandLayout(100, D, [{ t0: 33, t1: 50, count: 5 }], 10);
  assert.ok(odd.knots.every(([, u]) => Number.isInteger(u)));
  assert.equal(odd.n, 15);
});

test('brushPath fillets corners but keeps original arc length at the ends', () => {
  const p = brushPath([[0, 0], [100, 0], [100, 100]], 20);
  assert.deepEqual(p[0], { p: [0, 0], t: 0 });
  assert.deepEqual(p[p.length - 1], { p: [100, 100], t: 200 });
  // explicit vertex parameters are honoured
  const q = brushPath([[0, 0], [100, 0], [100, 100]], 20, [-5, -3, -1]);
  assert.equal(q[0].t, -5);
  assert.equal(q[q.length - 1].t, -1);
  assert.ok(p.length > 4 && p.some(v => v.arc));
  for (let i = 1; i < p.length; i++) assert.ok(p[i].t >= p[i - 1].t); // t never runs backwards
  assert.ok(!p.some(v => v.p[0] === 100 && v.p[1] === 0)); // the sharp corner is gone
});

test('midline pairs antiparallel strands end to end and merges straight runs', () => {
  const A = [[0, 0], [100, 0]], B = [[100, 20], [0, 20]];
  const m = midline(A, B, 100, 100, pointAt);
  assert.equal(m.rev, true);
  assert.deepEqual(m.pts, [[0, 10], [100, 10]]);
  assert.deepEqual(m.f, [0, 1]);
});

test('seqOf: only whole sequences of 4+ bases count', async () => {
  const { seqOf } = await import('../app/js/dna.js');
  assert.equal(seqOf('gatt aca'), 'GATTACA');
  assert.equal(seqOf('ACGU-NNA'), 'ACGUNNA'); // as written; colours read U as T
  assert.equal(seqOf('a'), '');        // a domain name, not a base
  assert.equal(seqOf('tag'), '');
  assert.equal(seqOf("domain a*"), '');
  assert.equal(seqOf(undefined), '');
});

test('seqLetters reads a sequence field, ignoring spacing and 5′/3′ marks', () => {
  assert.equal(seqLetters("5'-atg cau-3'"), 'ATGCAU');
  assert.equal(seqLetters('ACGT NNN'), 'ACGTNNN');
  assert.equal(seqLetters('domain a*'), '');
  assert.equal(seqLetters(''), '');
});

test('snap8 euclid steps measure along diagonals', () => {
  const p = snap8([0, 0], [30, 30], 2, true);
  assert.ok(Math.abs(Math.hypot(...p) / 2 - Math.round(Math.hypot(...p) / 2)) < 1e-3);
  assert.deepEqual(snap8([0, 0], [31, 2], 10), [30, 0]);
});

test('seqLetters: digits inside a name mean a name, not bases', async () => {
  const { seqLetters } = await import('../app/js/dna.js');
  assert.equal(seqLetters('GATA1'), '');
  assert.equal(seqLetters("5′-ACGT TG-3′"), 'ACGTTG');
});
