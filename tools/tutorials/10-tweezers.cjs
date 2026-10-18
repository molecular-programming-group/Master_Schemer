// 10 — scene: DNA tweezers (cf. Yurke 2000): a hinge strand, two arm strands, a fuel strand that closes them.
const { run } = require('./lib.cjs');
const pair = async (t, a, b) => { // shift-select two points, right-click → Pair with Base Pairs
  await t.at(...a, 200);
  await t.pg.keyboard.down('Shift'); await t.at(...b, 200); await t.pg.keyboard.up('Shift');
  await t.ctx(...b, 700);
  await t.ctxItem('Pair with Base Pairs', 800);
};
const domain = async (t, from, to, label) => {
  await t.click('[data-tool="segment"]', 150);
  await t.wdrag([from, to], 10);
  await t.fill('Label', label, 60);
};
run('10-tweezers', async t => {
  await t.view(2.1, 85, 25);
  await t.move(640, 360, 1);
  await t.title('10 · Scene: DNA tweezers', 'a structure that is not a simple duplex: hinge, arms, fuel');
  await t.cap('Strand A is the hinge: one strand bent into a U', 400);
  await t.select([]); await t.swatch(0);
  await t.click('[data-tool="path"]', 300);
  await t.wdrag([[0, 0], [0, 100], [80, 100], [80, 0]], 14);
  await t.cap('Its two arms are domains x and y', 400);
  await domain(t, [0, 0], [0, 100], 'x');
  await domain(t, [80, 100], [80, 0], 'y');
  await t.select([]);
  await t.cap('Arm strands B and C pair with them and carry single-stranded tails b and c', 400);
  await t.click('[data-tool="path"]', 300);
  await t.wdrag([[-10, 100], [-10, -50]], 12);
  await domain(t, [-10, 100], [-10, 0], 'x*');
  await domain(t, [-10, 0], [-10, -50], 'b');
  await t.select([]);
  await t.click('[data-tool="path"]', 300);
  await t.wdrag([[90, -50], [90, 100]], 12);
  await domain(t, [90, -50], [90, 0], 'c');
  await domain(t, [90, 0], [90, 100], 'y*');
  await t.tool('v');
  await t.cap('Pair each arm with its half of the hinge', 400);
  await pair(t, [-10, 85], [0, 85]);
  await pair(t, [90, 85], [80, 85]);
  await t.select([]);
  await t.cap('Colour by domain name, from the Domains panel', 400);
  for (const [n, i] of [['x', 6], ['y', 3], ['b', 2], ['c', 7]]) {
    await t.click(`#domainsBody .side-name:text-is("${n}")`, 400);
    await t.swatch(i);
  }
  await t.select([]);
  await t.cap('The fuel strand F: b* and c* to grab both tails, and a toehold f', 400);
  await t.click('[data-tool="path"]', 300);
  await t.wdrag([[150, -50], [150, -10], [170, -10], [170, -70]], 12);
  await domain(t, [150, -50], [150, -10], 'b*');
  await domain(t, [170, -10], [170, -50], 'c*');
  await domain(t, [170, -50], [170, -70], 'f');
  await t.tool('v');
  await t.select([]);
  await t.cap('Step 2, drawn the same way: F bridges the tails and pulls the arms shut', 400);
  await t.m(m => {
    const P = (id, pts, segments) => ({ type: 'path', id, pts, color: '#2b2622', width: 2, label: '', linecap: 'butt', segments });
    const X = 330, el = m.state.doc.elements, by = l => m.state.doc.domains[l]?.color;
    const s = (t0, t1, label) => ({ t0, t1, label, color: by(label.replace('*', '')) });
    el.push(
      P('A2', [[X, 0], [X, 100], [X + 20, 100], [X + 20, 0]], [s(0, 100, 'x'), s(120, 220, 'y')]),
      P('B2', [[X - 10, 100], [X - 10, -50]], [s(0, 100, 'x*'), s(100, 150, 'b')]),
      P('C2', [[X + 30, -50], [X + 30, 100]], [s(0, 50, 'c'), s(50, 150, 'y*')]),
      P('F2', [[X, -50], [X, -10], [X + 20, -10], [X + 20, -70]], [s(0, 40, 'b*'), s(60, 100, 'c*'), s(100, 120, 'f')]),
    );
    const L = (a, sa, b, sb) => ({ type: 'link', id: m.newId(), a: { id: a, seg: sa }, b: { id: b, seg: sb }, style: 'bases', fill: '#2b2622' });
    el.push(L('B2', 0, 'A2', 0), L('C2', 1, 'A2', 1), L('F2', 0, 'B2', 1), L('F2', 1, 'C2', 0));
    m.changed();
  });
  await t.zoomTo(1.35, 210, 25);
  await t.wait(1200);
  await t.cap('Cards and an arrow make it a two-state scheme', 400);
  await t.click('[data-tool="card"]', 200);
  await t.wdrag([[-40, -90], [200, 140]], 10);
  await t.tool('v'); await t.fill('Title', 'open + fuel');
  await t.click('[data-tool="card"]', 200);
  await t.wdrag([[260, -90], [420, 140]], 10);
  await t.tool('v'); await t.fill('Title', 'closed');
  await t.tool('a');
  await t.wdrag([[195, 30], [265, 30]], 12);
  await t.fill('Label', '+ F');
  await t.tool('v'); await t.select([]);
  await t.cap('Draw As → DNA molecule: the same design as double helices', 400);
  await t.key('Control+a', 300);
  await t.ctx(0, 85);
  await t.hover('.ctx-menu button:has-text("Draw As")', 500);
  await t.click('.ctx-menu button:has-text("DNA molecule")', 1800);
  await t.select([]);
  await t.zoomTo(1.55, 190, 25);
  await t.cap('Open and closed tweezers: four strands, six domains, all editable', 2600);
  await t.cap('', 300);
});
