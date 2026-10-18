// 07 — Objects panel, groups, adaptive right-click menus, the library.
const { run } = require('./lib.cjs');
const doc = { version: 3, groups: [], labelSlots: [], notes: '', domains: { p: { color: '#c8352e' } }, elements: [
  { type: 'path', id: 'B', pts: [[0, 60], [200, 60]], color: '#2b2622', width: 2, label: '', linecap: 'butt',
    segments: [{ t0: 120, t1: 200, label: 'p*' }] },
  { type: 'path', id: 'P', pts: [[200, 50], [120, 50]], color: '#2b2622', width: 2, label: 'p', linecap: 'butt', segments: [], cap1: 'harpoon' },
  { type: 'link', id: 'L', a: { id: 'P' }, b: { id: 'B', seg: 0 }, style: 'bases', fill: '#2b2622' },
] };
run('07-objects-library', async t => {
  await t.view(1.8, 150, 45);
  await t.m((m, d) => { d.palette = m.state.doc.palette; m.loadDocJSON(JSON.stringify(d)); }, doc);
  await t.move(640, 360, 1);
  await t.title('7 · Objects, groups, menus and the library', 'find, name, group and reuse what you draw');
  await t.cap('The Objects panel lists everything you draw, with names made from labels', 400);
  for (const n of ['strand 1', 'p*', 'p']) await t.hover(`#sidebarBody .side-name:text-is("${n}")`, 600);
  await t.cap('Double-click a row to rename it', 400);
  await t.dbl('#sidebarBody .side-name:text-is("strand 1")', 400);
  await t.key('Control+a', 100);
  await t.type('template', 60);
  await t.key('Enter', 700);
  await t.cap('The filter box finds objects by name, label or domain', 400);
  await t.click('#objFilter', 200);
  await t.type('temp', 120);
  await t.wait(1200);
  await t.key('Escape', 600);
  await t.cap('Select both strands and press Ctrl+G to group them', 400);
  await t.key('Control+a', 300);
  await t.key('Control+g', 900);
  await t.cap('Clicking any member selects the whole group; click again to reach one object', 400);
  await t.select([]);
  await t.at(30, 60, 900);
  await t.at(30, 60, 900);
  await t.select([]);
  await t.cap('The Library: stock proteins, shapes, fluorophores, and your own assets', 400);
  await t.click('#libraryBody .side-name:text-is("Shapes")', 600);
  await t.hover('#libraryBody .side-name:text-is("surface block")', 500);
  await t.cap('Click an asset to place it: a surface block…', 400);
  await t.click('#libraryBody .side-name:text-is("surface block")', 900);
  await t.wdrag([await t.selCenter(), [100, 90]]);
  await t.click('#libraryBody .side-name:text-is("Shapes")', 300);
  await t.cap('…and a polymerase from the stock proteins', 400);
  await t.click('#libraryBody .side-name:text-is("Proteins")', 600);
  await t.click('#libraryBody .side-name:has-text("Taq polymerase")', 900);
  await t.wdrag([await t.selCenter(), [255, 5]]);
  await t.click('#libraryBody .side-name:text-is("Proteins")', 300);
  await t.select([]);
  await t.cap('Right-click menus offer what fits what you clicked: a protein…', 400);
  await t.ctx(255, 5, 1500);
  await t.key('Escape', 300);
  await t.cap('…a duplex…', 400);
  await t.ctx(160, 55, 1500);
  await t.key('Escape', 300);
  await t.cap('…or empty canvas', 400);
  await t.ctx(-40, 0, 1300);
  await t.key('Escape', 300);
  await t.cap('Select a group, right-click → Save to Library: it joins My assets', 400);
  await t.at(30, 60, 400);
  await t.ctx(30, 60, 900);
  await t.ctxItem('Save to Library', 900);
  await t.dbl('#libraryBody .side-name:text-matches("^asset [0-9]+$")', 300);
  await t.key('Control+a', 100);
  await t.type('primed template', 50);
  await t.key('Enter', 700);
  await t.select([]);
  await t.cap('Click it to stamp a copy. The library is kept between sessions and can be exported as a file', 400);
  await t.click('#libraryBody .side-name:text-is("primed template")', 900);
  await t.wdrag([await t.selCenter(), [100, -30]]);
  await t.select([]);
  await t.cap('', 1500);
}, { hide: ['notes'] });
