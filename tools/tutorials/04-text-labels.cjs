// 04 — notes with rich text and math, label styles, domain strings, hidden data.
const { run } = require('./lib.cjs');
const strand = {
  type: 'path', id: 'S', pts: [[0, 170], [80, 170], [120, 130], [240, 130]], smooth: true, color: '#2b2622', width: 3, label: '', linecap: 'butt',
  segments: [
    { t0: 0, t1: 70, color: '#c8352e', label: 't' },
    { t0: 70, t1: 160, color: '#2f6fd0', label: 'a' },
    { t0: 160, t1: 250, color: '#1f8f5f', label: 'b' },
  ],
};
run('04-text-labels', async t => {
  await t.view(1.9, 165, 90);
  await t.move(640, 360, 1);
  await t.title('4 · Text, labels and data', 'notes, math, label styles, domain strings, hidden data');
  await t.cap('The Note tool (T): drag a box to set the wrap width, then type', 400);
  await t.click('[data-tool="text"]', 300);
  await t.wdrag([[0, -20], [200, -10]]);
  await t.type('Toehold-mediated strand displacement. The invader binds $t^*$ and branch-migrates through $a$, releasing the output.', 25);
  await t.wait(600);
  await t.cap('Ctrl+Enter finishes. Math between $…$ is typeset', 400);
  await t.key('Control+Enter', 900);
  await t.cap('Double-click to edit; select text and use the text bar for bold, italic, sub/superscript', 400);
  await t.tool('v');
  const [nx, ny] = await t.W2S(20, -14);
  await t.move(nx, ny); await t.pg.mouse.dblclick(nx, ny); await t.wait(500);
  await t.key('Control+Home', 100);
  for (let i = 0; i < 'Toehold-mediated strand displacement.'.length; i++) await t.pg.keyboard.press('Shift+ArrowRight');
  await t.wait(400);
  await t.click('#textbar button[title^="Bold"], #textbar [data-cmd="b"], #textbar button:has-text("B")', 600);
  await t.key('Control+Enter', 900);
  if (0) console.log('NOTE', await t.pg.evaluate(() => [...document.querySelectorAll('#panel label, #panel button')].map(n => (n.textContent || '').trim().slice(0, 40)).filter(Boolean).join(' | ')));
  await t.select([]);
  await t.cap('A strand with three domains, each labelled', 400);
  await t.m((m, s) => { m.state.doc.elements.push(s); m.changed(); }, strand);
  await t.wait(1200);
  await t.cap('Labels follow the strand: text runs along its contour', 400);
  await t.click('#sidebar .side-name:text-is("strand 1")', 500);
  await t.check('Labels follow the strand', 1500);
  await t.select([]);
  await t.cap('With nothing selected, the Labels section styles every label in the document', 400);
  await t.reveal(`${t.F('Label size')} input`);
  await t.field(`${t.F('Label size')} input`, '15');
  await t.pick('Label weight', '700', 1200);
  await t.cap('A single label can still differ: select a domain, set its own colour or size', 400);
  await t.click('#domainsBody .side-name:text-is("b")', 500);
  await t.reveal(`${t.F('Label size')} input`);
  await t.field(`${t.F('Label size')} input`, '20');
  await t.wait(800);
  await t.cap('A domain’s String holds its sequence; the strand reads them end to end', 400);
  await t.fill('String', 'GCTAGCTTGA', 50);
  await t.click('#domainsBody .side-name:text-is("a")', 500);
  await t.fill('String', 'ACGT', 50);
  await t.cap('Data: notes that never draw — stock, concentration, a citation…', 400);
  await t.click('#sidebar .side-name:text-is("strand 1")', 500);
  await t.fill('Data (not displayed)', 'IDT, 100 µM stock; Zhang & Winfree 2009', 30);
  await t.select([]);
  await t.cap('Status bar → Data shows every object’s data beside it', 400);
  await t.click('#dataToggle', 2200);
  await t.click('#dataToggle', 600);
  await t.cap('Data on hover reveals it only for the object under the cursor', 400);
  await t.click('#hoverToggle', 400);
  await t.move(...await t.W2S(30, 170), 20); await t.wait(1600);
  await t.click('#hoverToggle', 400);
  await t.cap('Notes, math and labels all export to SVG and PNG as drawn', 2400);
  await t.cap('', 300);
});
