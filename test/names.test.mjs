// Run: node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { state, displayName, clearNameCache } from '../app/js/model.js';

test('default names count per kind, follow caps, and name links by their ends', () => {
  state.doc = {
    groups: [], palette: [], labelSlots: [{ id: 'L', text: 'a*' }],
    elements: [
      { id: 't', type: 'text', text: 'input: <i>w</i><sub>1,2</sub>\nsecond line' },
      { id: 's1', type: 'path', segments: [{ t0: 0, t1: 1, label: 'a' }, { t0: 1, t1: 2 }] },
      { id: 'l1', type: 'aline' },
      { id: 's2', type: 'path', label: 'slot:L' },
      { id: 'l2', type: 'aline', cap1: 'barb' },
      { id: 's3', type: 'path' },
      { id: 'k1', type: 'link', a: { id: 's1', seg: 0 }, b: { id: 's2' } },
      { id: 'k2', type: 'link', a: { id: 's1', seg: 1 }, b: { id: 's3' } },
      { id: 'k3', type: 'link', a: { id: 's1' }, b: { id: 'gone' } },
      { id: 'n', type: 'rect', name: 'chip' },
    ],
  };
  clearNameCache();
  const name = id => displayName(state.doc.elements.find(e => e.id === id));
  assert.equal(name('t'), 'input: <i>w</i><sub>1,2</sub>'); // first line whole, never cut mid-tag
  assert.equal(name('s1'), 'strand 1');
  assert.equal(name('s3'), 'strand 3');
  assert.equal(name('l1'), 'line 1');
  assert.equal(name('l2'), 'arrow 1');
  assert.equal(name('k1'), 'a ↔ a*');
  assert.equal(name('k2'), 'strand 1 ↔ strand 3'); // unlabelled domain → its strand
  assert.equal(name('k3'), 'link 3');
  assert.equal(name('n'), 'chip');
});
