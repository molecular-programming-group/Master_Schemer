// 06 — rendering styles: Draw as for a whole scene, DNA looks, View overrides,
// drawing as DNA from the start, colour by sequence while typing, duplexes, themes, export.
const { run } = require('./lib.cjs');
let r = 7; const rnd = () => (r = (r * 16807) % 2147483647) / 2147483647;
const seq = Array.from({ length: 100 }, () => 'ACGT'[Math.floor(rnd() * 4)]).join('');
const doc = { version: 3, groups: [], labelSlots: [], notes: '', domains: {}, elements: [
  { type: 'path', id: 'B', pts: [[0, 40], [200, 40]], color: '#2b2622', width: 2, label: '', linecap: 'butt', seq,
    segments: [{ t0: 0, t1: 40, label: 't*' }, { t0: 40, t1: 200, label: 'a*' }] },
  { type: 'path', id: 'T', pts: [[200, 30], [40, 30]], color: '#2b2622', width: 2, label: 'a', linecap: 'butt', segments: [] },
  { type: 'path', id: 'I', pts: [[40, -20], [-40, -20]], color: '#2b2622', width: 2, label: 't', linecap: 'butt', segments: [] },
  { type: 'link', id: 'L', a: { id: 'T' }, b: { id: 'B', seg: 1 }, style: 'bases', fill: '#2b2622' },
] };
const SEQ = 'ATGCGTACCAGTTCAGGATCCTAGCATGCA'; // 30 nt
const MORE = 'GATTACAGGC'; // +10
const Y = 140; // the second scene, below the first

run('06-rendering-styles', async t => {
  await t.view(2.6, 80, 20);
  await t.m((m, d) => { // domains a and t coloured from memory slots 5 and 6
    const p = d.palette = m.state.doc.palette;
    d.domains = { a: { color: `slot:${p[4].id}` }, t: { color: `slot:${p[5].id}` } };
    m.loadDocJSON(JSON.stringify(d));
  }, doc);
  await t.move(640, 360, 1);
  await t.title('6 · Rendering styles', 'lines, DNA molecules, sequences; colour by sequence, duplexes, themes, export', 1900);

  // --- approach 1: draw as lines, then switch the whole scene
  await t.cap('A duplex with a toehold and an invader strand, drawn as lines', 1800);
  await t.cap('Select all, right-click → Draw As → DNA molecule', 400);
  await t.key('Control+a', 300);
  await t.ctx(100, 40);
  await t.hover('.ctx-menu button:has-text("Draw As")', 500);
  await t.click('.ctx-menu button:has-text("DNA molecule")', 900);
  await t.cap('Every strand switches together; the base-pair link becomes a double helix', 1600);
  await t.cap('With all selected, the panel styles every molecule at once — Shading: Soft or Toon', 400);
  await t.pick('Shading', 'soft', 1500); await t.snap('soft');
  await t.pick('Shading', 'toon', 800);
  await t.cap('Black outline off and on', 400);
  await t.check('Black outline', 900);
  await t.check('Black outline', 400);
  await t.cap('Model: Ribbon + bases, or Space-filling', 400);
  await t.pick('Model', 'ribbon', 1500); await t.snap('ribbon');
  await t.pick('Model', 'space', 400);
  await t.cap('Colour by: Backbone + bases', 400);
  await t.pick('Colour by', 'bases', 1200);
  await t.cap('Colour by: Sequence — the long strand has one; its partner shows the complement', 400);
  await t.pick('Colour by', 'sequence', 1000);
  await t.deselect();
  await t.wait(1600); await t.snap('byseq');
  await t.cap('View → Draw Strands shows all strands one way, without changing them', 400);
  await t.menu('View', '[data-look="line"]'); await t.wait(900);
  await t.menu('View', '[data-look="seq"]');
  await t.zoomTo(8, 30, 35, 10); await t.wait(900); await t.snap('seq-view');
  await t.zoomTo(2.6, 80, 20, 10);
  await t.menu('View', '[data-look="own"]'); await t.wait(500);

  // --- approach 2: set the look first, then draw
  await t.zoomTo(5, 40, Y + 10);
  await t.cap('Or choose the look first: with nothing selected, New strands → DNA molecule', 400);
  await t.pick('New strands', 'dna', 900);
  await t.cap('Now the Strand tool draws molecules straight away', 400);
  await t.click('[data-tool="path"]', 300);
  await t.swatch(0);
  await t.wdrag([[0, Y], [60, Y]], 18);
  await t.cap('Model → Ribbon + bases, Colour by → Sequence. No sequence yet: plain bases', 400);
  await t.pick('Model', 'ribbon', 700);
  await t.pick('Colour by', 'sequence', 1000);
  await t.cap('The Sequence field sets the base count: 30 Ns are 30 unknown bases…', 400);
  await t.fill('Sequence', 'N'.repeat(SEQ.length), 0);
  await t.wait(400);
  await t.cap('…type over them, and each base takes its letter’s colour: A green, C blue, G amber, T red', 300);
  const ta = `${t.F('Sequence')} textarea`;
  await t.click(ta, 200);
  await t.key('Control+Home', 100);
  for (const ch of SEQ) {
    await t.pg.keyboard.press('Shift+ArrowRight');
    await t.type(ch, 0);
    await t.wait(110);
  }
  await t.snap('typed');
  await t.wait(500);
  await t.cap('Keep typing: every letter adds a base…', 300);
  await t.key('Control+End', 100);
  await t.type(MORE, 130);
  await t.blur();
  await t.wait(600); await t.snap('more');
  await t.cap('…and Grid → Resize Strands to Grid grows the strand to hold them', 400);
  await t.menu('Grid', '[data-act="fitSeq"]');
  await t.wait(1200); await t.snap('grown');
  await t.cap('Draw a partner below it, the other way — a molecule too — and give it a colour', 400);
  await t.wdrag([[80, Y + 20], [0, Y + 20]], 20);
  await t.swatch(7);
  await t.tool('v');
  await t.cap('Select both, right-click → Pair as Duplex', 400);
  await t.at(25, Y, 250);
  await t.pg.keyboard.down('Shift'); await t.at(25, Y + 20, 300); await t.pg.keyboard.up('Shift');
  await t.ctx(25, Y + 20);
  await t.ctxItem('Pair as Duplex', 1100);
  await t.cap('A double helix forms. The duplex panel styles both strands at once', 400);
  await t.pick('Model', 'ribbon', 700);
  await t.cap('Colour by → Sequence: the partner shows the complementary bases', 400);
  await t.pick('Colour by', 'sequence', 2000); await t.snap('duplex');
  await t.cap('Right-click → Unlink: the strands come apart…', 400);
  await t.ctx(25, Y + 10);
  await t.ctxItem('Unlink', 1500); await t.snap('unlinked');
  await t.cap('…and Ctrl+Z pairs them up again', 400);
  await t.key('Control+z', 1500);
  await t.deselect();
  await t.wait(600);

  // --- the whole page
  await t.zoomTo(2.1, 80, 72);
  await t.cap('View → Color Themes… recolours every memory slot — and all that uses them', 400);
  await t.menu('View', '[role=menuitem][data-act="themes"]');
  await t.wait(400);
  await t.click('.theme-tile:has-text("Tol bright")', 1300);
  await t.cap('Export (Ctrl+Shift+E): format, size, selection only, grid, transparency', 400);
  await t.key('Control+Shift+e', 2100);
  await t.click('.modal-card button:has-text("Cancel")', 400);
  await t.cap('DNA looks, sequences and math labels export exactly as drawn', 1800);
  await t.cap('', 300);
});
