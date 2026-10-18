// 06 — rendering styles: Draw as, DNA looks, colour by sequence, View overrides, themes, export.
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
run('06-rendering-styles', async t => {
  await t.view(2.6, 80, 20);
  await t.m((m, d) => { d.palette = m.state.doc.palette; m.loadDocJSON(JSON.stringify(d)); }, doc);
  await t.move(640, 360, 1);
  await t.title('6 · Rendering styles', 'line, DNA molecule, sequence; shading, colour, themes, export');
  await t.cap('A duplex with a toehold, and an invader strand, drawn as lines', 1800);
  await t.cap('Colour the domains from memory slots: click a name under Domains, then a slot', 400);
  await t.click('#domainsBody .side-name:text-is("a")', 500);
  await t.slot(4);
  await t.click('#domainsBody .side-name:text-is("t")', 500);
  await t.slot(5);
  await t.select([]);
  await t.cap('Select all, right-click → Draw As → DNA molecule', 400);
  await t.key('Control+a', 300);
  await t.ctx(100, 40);
  await t.hover('.ctx-menu button:has-text("Draw As")', 500);
  await t.click('.ctx-menu button:has-text("DNA molecule")', 1500);
  await t.select([]);
  await t.wait(1200);
  await t.cap('Each molecule has its own look. Select the long strand', 400);
  await t.click('#sidebar .side-name:text-is("strand 1")', 700);
  await t.cap('Shading: Soft (rendered) or Toon (flat bands)', 400);
  await t.pick('Shading', 'soft', 1500);
  await t.pick('Shading', 'toon', 900);
  await t.cap('Black outline on or off', 400);
  await t.check('Black outline', 1200);
  await t.check('Black outline', 800);
  await t.cap('Colour by Sequence: A green, C blue, G amber, T red — from the strand’s Sequence', 400);
  await t.pick('Colour by', 'sequence', 2000);
  await t.cap('Model: Ribbon + bases', 400);
  await t.pick('Model', 'ribbon', 2000);
  await t.pick('Model', 'space', 600);
  await t.pick('Colour by', 'strand', 600);
  await t.cap('Or Draw as → Sequence: the letters themselves', 400);
  await t.pick('Draw as', 'seq', 600);
  await t.select([]);
  await t.zoomTo(7, 20, 40);
  await t.wait(1500);
  await t.zoomTo(2.6, 80, 20);
  await t.cap('View → Draw Strands switches all strands at once, without changing them', 400);
  await t.menu('View', '[data-look="line"]'); await t.wait(1200);
  await t.menu('View', '[data-look="dna"]'); await t.wait(1400);
  await t.menu('View', '[data-look="own"]'); await t.wait(800);
  await t.cap('View → Color Themes… recolours every memory slot at once — and all that uses them', 400);
  await t.menu('View', '[role=menuitem][data-act="themes"]');
  await t.wait(500);
  await t.hover('.theme-tile:has-text("Tol bright")', 400);
  await t.click('.theme-tile:has-text("Tol bright")', 1500);
  await t.menu('View', '[role=menuitem][data-act="themes"]');
  await t.click('.theme-tile:has-text("Tol vibrant")', 1500);
  await t.cap('Dark mode is a view setting (status bar → Dark); exports keep the page colour', 400);
  await t.click('#themeToggle', 1800);
  await t.click('#themeToggle', 600);
  await t.cap('Export (Ctrl+Shift+E for PNG): format, size, selection only, grid, transparency', 400);
  await t.key('Control+Shift+e', 2600);
  await t.click('.modal-card button:has-text("Cancel")', 500);
  await t.cap('Math labels, notes and DNA looks export exactly as drawn', 2200);
  await t.cap('', 300);
});
