// 12 — scene: a small Rothemund-style DNA origami: a scaffold rastered over four helices, staples
// running antiparallel to it and crossing over between neighbouring helices.
// Layout (world units, grid 20): scaffold rows y = 0, 40, 80, 120, x 0..250, running → ← → ←.
// Staple legs sit half a grid beside the row they pair with and run the other way.
const { run } = require('./lib.cjs');
// every 20 units along the legs: corners commit reliably even with dry mode's coarse mouse steps
const dense = pts => pts.flatMap((p, i) => {
  if (!i) return [p];
  const q = pts[i - 1], n = Math.max(1, Math.round(Math.hypot(p[0] - q[0], p[1] - q[1]) / 20));
  return Array.from({ length: n }, (_, k) => [q[0] + (p[0] - q[0]) * (k + 1) / n, q[1] + (p[1] - q[1]) * (k + 1) / n]);
});
const draw = async (t, color, pts) => {
  await t.select([]); await t.swatch(color);
  await t.click('[data-tool="path"]', 200);
  await t.wdrag(dense(pts), 2);
  await t.pick('End cap', 'harpoon', 500);
};
const shiftPick = async (t, pts) => {
  await t.at(...pts[0], 150);
  await t.pg.keyboard.down('Shift');
  for (const p of pts.slice(1)) await t.at(...p, 150);
  await t.pg.keyboard.up('Shift');
};
run('12-mini-origami', async t => {
  await t.view(2.2, 125, 70);
  await t.move(640, 360, 1);
  await t.title('12 · Scene: a small DNA origami', 'a long scaffold folded by short staple strands', 1800);
  await t.cap('One long scaffold rasters back and forth across four helices (to turn, drag past the corner, then back)', 400);
  await draw(t, 0, [[0, 0], [250, 0], [250, 110], [250, 40], [0, 40], [0, 150], [0, 80], [250, 80], [250, 190], [250, 120], [0, 120]]);
  await t.field(`${t.F('Corner radius')} input[type=number]`, '10');
  await t.cap('The harpoon marks its 3′ end: each helix runs the opposite way to the one above', 1800);
  await t.select([]);
  await t.cap('A staple pairs antiparallel: rightward on helix 2, a crossover, leftward on helix 1', 400);
  await draw(t, 2, [[10, 30], [40, 30], [40, 10], [10, 10]]);
  await t.tool('v');
  await t.cap('Ctrl+drag a copy, then flip it both ways: still antiparallel, crossover facing the first', 400);
  await t.wdrag([[25, 10], [55, 10]], 14, ['Control']); // +30: the flips pivot on the box incl. the harpoon
  await t.menu('Object', '[role=menuitem][data-act="flipH"]');
  await t.menu('Object', '[role=menuitem][data-act="flipV"]');
  await t.wait(600);
  await t.cap('Copy the pair along the helices', 400);
  await shiftPick(t, [[25, 10], [65, 10]]);
  await t.wdrag([[25, 10], [185, 10]], 18, ['Control']);
  await t.cap('Between helices 2 and 3 the scaffold directions swap: copy the pair and flip it vertically', 400);
  await shiftPick(t, [[25, 10], [65, 10]]);
  await t.wdrag([[25, 10], [105, 50]], 18, ['Control']);
  await t.menu('Object', '[role=menuitem][data-act="flipV"]');
  await t.swatch(5);
  await t.wait(600);
  await t.cap('Helices 3 and 4 repeat helices 1 and 2', 400);
  await shiftPick(t, [[25, 10], [65, 10], [185, 10], [225, 10]]);
  await t.wdrag([[25, 10], [25, 90]], 18, ['Control']);
  await t.cap('Edge staples cover the rest of the outer helices', 400);
  await draw(t, 1, [[160, -10], [90, -10]]);
  await draw(t, 1, [[90, 130], [160, 130]]);
  await t.tool('v');
  await t.select([]);
  await t.cap('Mark a staple leg and the scaffold beside it with the Domain tool…', 400);
  await t.swatch(2);
  await t.click('[data-tool="segment"]', 150);
  await t.wdrag([[10, 30], [40, 30]], 10);
  await t.select([]); await t.swatch(0);
  await t.wdrag([[40, 40], [10, 40]], 10);
  await t.tool('v');
  await t.select([]);
  await t.cap('…and pair them with base pairs', 400);
  await t.at(25, 30, 200);
  await t.pg.keyboard.down('Shift'); await t.at(25, 40, 200); await t.pg.keyboard.up('Shift');
  await t.ctx(25, 40, 600);
  await t.ctxItem('Pair with Base Pairs', 900);
  await t.select([]);
  await t.cap('The remaining legs, paired the same way', 400);
  await t.m(m => {
    const els = m.state.doc.elements, scaf = els.find(e => e.type === 'path' && e.pts.length === 8);
    const old = els.find(e => e.type === 'link');
    const len = (pts, i) => pts.slice(0, i).reduce((s, p, k) => s + Math.hypot(pts[k + 1][0] - p[0], pts[k + 1][1] - p[1]), 0);
    const scafT = (y, x) => { // arc length of (x, y) on the scaffold row y
      const i = scaf.pts.findIndex((p, k) => p[1] === y && scaf.pts[k + 1]?.[1] === y);
      return len(scaf.pts, i) + Math.abs(x - scaf.pts[i][0]);
    };
    const segProps = sg => { const { t0, t1, ...rest } = sg; return rest; };
    const scafProps = segProps(scaf.segments[0]);
    const pairs = [];
    for (const st of els.filter(e => e.type === 'path' && e !== scaf)) {
      const stProps = st.segments[0] ? segProps(st.segments[0]) : { color: st.color, label: '' };
      st.segments = [];
      st.pts.forEach((p, k) => {
        const q = st.pts[k + 1];
        if (!q || p[1] !== q[1]) return;
        const y = [0, 40, 80, 120].find(r => Math.abs(r - p[1]) === 10);
        const a = len(st.pts, k);
        st.segments.push({ t0: a, t1: a + Math.abs(q[0] - p[0]), ...stProps });
        const s0 = scafT(y, p[0]), s1 = scafT(y, q[0]);
        pairs.push({ st, seg: st.segments.length - 1, t0: Math.min(s0, s1), t1: Math.max(s0, s1) });
      });
    }
    pairs.sort((u, v) => u.t0 - v.t0);
    scaf.segments = pairs.map(p => ({ t0: p.t0, t1: p.t1, ...scafProps }));
    const { id, a, b, ...look } = old;
    m.state.doc.elements = els.filter(e => e.type !== 'link');
    pairs.forEach((p, i) => m.state.doc.elements.push({ ...look, id: m.newId(), a: { id: p.st.id, seg: p.seg }, b: { id: scaf.id, seg: i } }));
    m.changed();
  });
  await t.wait(1200);
  await t.cap('Draw As → DNA molecule turns the routing diagram into helices', 400);
  await t.key('Control+a', 300);
  await t.ctx(25, 30);
  await t.hover('.ctx-menu button:has-text("Draw As")', 500);
  await t.click('.ctx-menu button:has-text("DNA molecule")', 1400);
  await t.select([]);
  await t.wait(600);
  await t.cap('Select a staple: chevrons and 5′ / 3′ tags show which way it runs', 400);
  await t.zoomTo(5, 125, 60);
  await t.at(120, 60, 1700);
  await t.snap('sel');
  await t.select([]);
  await t.zoomTo(2.2, 125, 70);
  await t.cap('A scaffold, staples and crossovers, all from plain strands, domains and links', 2200);
  await t.cap('', 300);
  if (t.DRY) { // routing check: legs half a grid beside a row, antiparallel to it, no two on one stretch
    const [scaf, ...staples] = await t.m(m => m.state.doc.elements.filter(e => e.type === 'path').map(e => e.pts));
    const rowDir = {}, used = {}, bad = [];
    scaf.forEach((p, i) => { const q = scaf[i + 1]; if (q && p[1] === q[1]) rowDir[p[1]] = Math.sign(q[0] - p[0]); });
    staples.forEach((pts, k) => pts.forEach((p, i) => {
      const q = pts[i + 1];
      if (!q || p[1] !== q[1]) return;
      const row = Object.keys(rowDir).map(Number).find(r => Math.abs(r - p[1]) === 10);
      if (row === undefined) return bad.push(`staple ${k}: leg y=${p[1]} not beside a row`);
      if (Math.sign(q[0] - p[0]) !== -rowDir[row]) bad.push(`staple ${k}: leg y=${p[1]} parallel to row ${row}`);
      for (let x = Math.min(p[0], q[0]); x < Math.max(p[0], q[0]); x++) {
        if (used[row + ',' + x] !== undefined) { bad.push(`staple ${k} overlaps staple ${used[row + ',' + x]} on row ${row} at x=${x}`); break; }
        used[row + ',' + x] = k;
      }
    }));
    console.log('scaffold', JSON.stringify(scaf), 'rows', JSON.stringify(rowDir), staples.length, 'staples; problems:', bad.length ? bad : 'none');
  }
});
