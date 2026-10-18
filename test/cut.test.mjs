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

test('splitDomain splits one domain, keeps the strand and other links', async () => {
  const { splitDomain } = await import('../app/js/model.js');
  state.doc = { version: 3, elements: [], palette: [], groups: [], labelSlots: [] };
  state.history = []; state.future = []; state.selection = [];
  const line = { type: 'path', id: 'L', pts: [[0, 0], [100, 0]], color: 'red',
    segments: [{ t0: 10, t1: 50, label: 'C', string: 'ACGTACGT', bases: 9 }, { t0: 60, t1: 90 }] };
  const other = { type: 'path', id: 'M', pts: [[0, 10], [100, 10]] };
  state.doc.elements.push(line, other,
    { type: 'link', id: 'k1', a: { id: 'L', seg: 0 }, b: { id: 'M' } },
    { type: 'link', id: 'k2', a: { id: 'L', seg: 1 }, b: { id: 'M' } });
  const [a, b] = splitDomain(line, 30);
  assert.deepEqual([a.t0, a.t1, a.label, a.string, a.bases], [10, 30, 'C1', 'ACGT', undefined]);
  assert.deepEqual([b.t0, b.t1, b.label, b.string], [30, 50, 'C2', 'ACGT']);
  assert.deepEqual(line.segments.map(s => [s.t0, s.t1]), [[10, 30], [60, 90], [30, 50]]);
  assert.deepEqual(state.doc.elements.filter(x => x.type === 'link').map(x => x.id), ['k2']);
  // a bare stretch: the gap between neighbours becomes the two domains
  splitDomain(line, 55);
  assert.deepEqual(line.segments.slice(3).map(s => [s.t0, s.t1]), [[50, 55], [55, 60]]);
  assert.equal(splitDomain(line, 50.5), null); // too close to a boundary
});

test('deleting domains removes those and re-points links at the survivors', async () => {
  const { deleteSelection } = await import('../app/js/model.js');
  const seg = (t0, t1, label) => ({ t0, t1, label });
  state.doc = { version: 3, elements: [
    { type: 'path', id: 'L', pts: [[0, 0], [90, 0]], segments: [seg(0, 30, 'A'), seg(30, 60, 'B'), seg(60, 90, 'C')] },
    { type: 'path', id: 'M', pts: [[0, 9], [90, 9]], segments: [] },
    { type: 'link', id: 'kC', a: { id: 'L', seg: 2 }, b: { id: 'M' } },
    { type: 'link', id: 'kA', a: { id: 'L', seg: 0 }, b: { id: 'M' } },
  ], palette: [], groups: [], labelSlots: [] };
  state.selection = [{ id: 'L', seg: 0 }, { id: 'L', seg: 1 }];
  deleteSelection();
  assert.deepEqual(byId('L').segments.map(s => s.label), ['C']);
  assert.deepEqual(byId('kC').a, { id: 'L', seg: 0 }); // follows C to its new index
  assert.equal(byId('kA'), undefined); // its domain went
});

test('cutting a strand shares out its sequences instead of copying them', () => {
  state.doc = { version: 3, elements: [{
    type: 'path', id: 'S', pts: [[0, 0], [100, 0]], seq: 'AAAAACCCCCGGGGGTTTTT',
    segments: [{ t0: 20, t1: 60, string: 'ACGTACGT' }],
  }], palette: [], groups: [], labelSlots: [] };
  const [a, b] = cutPath(byId('S'), 40, 10);
  assert.equal(a.seq + '|' + b.seq, 'AAAAACCCCC|GGGGGTTTTT');
  assert.equal(a.segments[0].string + '|' + b.segments[0].string, 'ACGT|ACGT');
});

test('domains by name: one colour per name, complements lighter, own colours kept', async () => {
  const { changed, domainKey } = await import('../app/js/model.js');
  assert.deepEqual([domainKey('a*').name, domainKey('$x^*$').name, domainKey('$x^*$').comp], ['a', '$x$', true]);
  const seg = (t0, label, extra) => ({ t0, t1: t0 + 10, label, color: '#000000', ...extra });
  state.doc = { version: 3, palette: [], groups: [], labelSlots: [], domains: { a: { color: '#ff0000' } }, elements: [
    { type: 'path', id: 'P', pts: [[0, 0], [90, 0]], segments: [seg(0, 'a'), seg(20, 'a*'), seg(40, 'a', { ownColor: true }), seg(60, 'b')] },
  ] };
  changed();
  assert.deepEqual(byId('P').segments.map(s => s.color), ['#ff0000', '#ff7373', '#000000', '#000000']);
});
