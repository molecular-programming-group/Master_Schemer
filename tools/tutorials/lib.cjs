// Tutorial recorder: drives the app in headless Chromium with a visible fake
// cursor and caption bar, records a video, converts it to a GIF.
//   node tools/tutorials/<script>.cjs          record → $TUT_OUT/<name>.gif
//   node tools/tutorials/<script>.cjs dry      fast run, PNG snapshots in $TUT_OUT/dry-<name>/
// Needs the dev server (python3 tools/serve.py 8123) and ffmpeg.
const { chromium } = require(process.env.HOME + '/.claude/skills/playwright-skill/node_modules/playwright');
const fs = require('fs');
const { execSync } = require('child_process');

const OUT = process.env.TUT_OUT ||
  `${process.env.HOME}/Insync/ian.hoffecker@gmail.com/Google Drive/_PROJECTS_/2026 Master_Schemer/screenshots/tutorials`;
const URL = process.env.TUT_URL || 'http://localhost:8123/';
const W = 1280, H = 720;

async function run(name, story, { hide = ['library', 'notes'] } = {}) {
  const DRY = process.argv[2] === 'dry';
  const dir = DRY ? `${OUT}/dry-${name}` : `${OUT}/.vid-${name}`;
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: W, height: H }, ...(DRY ? {} : { recordVideo: { dir, size: { width: W, height: H } } }) });
  const pg = await ctx.newPage();
  const errs = [];
  pg.on('pageerror', e => errs.push('PAGEERR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  await pg.addInitScript(hide => {
    if (!sessionStorage.getItem('tut-init')) { // first load only: a clean app, chosen panels
      localStorage.clear();
      localStorage.setItem('master-schemer-hidden-panels', JSON.stringify(hide));
      sessionStorage.setItem('tut-init', '1');
    }
    addEventListener('DOMContentLoaded', () => {
      const c = document.createElement('div');
      c.id = 'fakecursor';
      c.innerHTML = '<svg width="22" height="22" viewBox="0 0 22 22"><path d="M2 1 L2 17 L6.5 13 L9.5 20 L12 19 L9 12 L15 12 Z" fill="#111" stroke="#fff" stroke-width="1.3"/></svg>';
      Object.assign(c.style, { position: 'fixed', left: '0', top: '0', zIndex: 99999, pointerEvents: 'none', transform: 'translate(-2px,-1px)' });
      document.body.appendChild(c);
      addEventListener('mousemove', e => { c.style.left = e.clientX + 'px'; c.style.top = e.clientY + 'px'; }, true);
      const cap = document.createElement('div');
      cap.id = 'tutcap';
      Object.assign(cap.style, { position: 'fixed', left: '50%', bottom: '34px', transform: 'translateX(-50%)', zIndex: 99998,
        background: 'rgba(40,36,32,.92)', color: '#fff', font: '600 15px system-ui, sans-serif', padding: '8px 15px',
        borderRadius: '7px', pointerEvents: 'none', display: 'none', whiteSpace: 'nowrap' });
      document.body.appendChild(cap);
      const title = document.createElement('div');
      title.id = 'tuttitle';
      Object.assign(title.style, { position: 'fixed', inset: '0', zIndex: 99997, display: 'none', alignItems: 'center',
        justifyContent: 'center', flexDirection: 'column', gap: '10px', background: 'rgba(250,248,244,.94)',
        font: '700 34px system-ui, sans-serif', color: '#2b2622', pointerEvents: 'none', textAlign: 'center' });
      document.body.appendChild(title);
    });
  }, hide);
  await pg.goto(URL);
  await pg.waitForTimeout(700);

  let shot = 0, cur = [W / 2, H / 2];
  const t = {
    pg, W, H, DRY, errs,
    wait: ms => pg.waitForTimeout(DRY ? Math.min(ms, 300) : ms), // (dry: still long enough for deferred clicks)
    snap: async label => { if (DRY) await pg.screenshot({ path: `${dir}/${String(++shot).padStart(2, '0')}_${label}.png` }); },
    // run fn(model, app-ish globals) in the page; args are JSON
    m: (fn, arg) => pg.evaluate(async ([src, arg]) => {
      const m = await import('/js/model.js');
      return (0, eval)(`(${src})`)(m, arg);
    }, [fn.toString(), arg ?? null]),
    cur: () => cur,
  };
  t.cap = async (text, ms = 1700) => {
    await pg.evaluate(x => { const c = document.getElementById('tutcap'); c.textContent = x; c.style.display = x ? '' : 'none'; }, text);
    if (text) await t.snap('cap');
    await t.wait(ms);
  };
  t.title = async (text, sub = '', ms = 2200) => {
    await pg.evaluate(([x, s]) => {
      const c = document.getElementById('tuttitle');
      c.innerHTML = x ? `<div>${x}</div><div style="font:500 17px system-ui;color:#6b635b">${s}</div>` : '';
      c.style.display = x ? 'flex' : 'none';
    }, [text, sub]);
    if (text) await t.snap('title');
    await t.wait(ms);
    await pg.evaluate(() => { document.getElementById('tuttitle').style.display = 'none'; });
  };
  t.move = async (x, y, steps = 18) => { await pg.mouse.move(x, y, { steps: DRY ? Math.min(steps, 4) : steps }); cur = [x, y]; };
  t.center = async sel => { const bx = await pg.locator(sel).first().boundingBox(); if (!bx) throw new Error('no box: ' + sel); return [bx.x + bx.width / 2, bx.y + bx.height / 2]; };
  t.click = async (sel, pause = 350) => { const [x, y] = await t.center(sel); await t.move(x, y); await t.wait(200); await pg.mouse.click(x, y); await t.wait(pause); };
  t.dbl = async (sel, pause = 400) => { const [x, y] = await t.center(sel); await t.move(x, y); await t.wait(200); await pg.mouse.dblclick(x, y); await t.wait(pause); };
  t.clickAt = async (x, y, pause = 350, opts = {}) => { await t.move(x, y); await t.wait(150); await pg.mouse.click(x, y, opts); await t.wait(pause); };
  t.hover = async (sel, ms = 500) => { const [x, y] = await t.center(sel); await t.move(x, y, 12); await t.wait(ms); };
  t.menu = async (title, item, hover = 650) => {
    await t.click(`.menu-title:text-is("${title}")`, hover);
    await t.snap('menu-' + title);
    await t.click(item, 500);
  };
  t.key = async (k, pause = 250) => { await pg.keyboard.press(k); await t.wait(pause); };
  t.type = async (s, delay = 40) => { await pg.keyboard.type(s, { delay: DRY ? 0 : delay }); };
  t.blur = () => pg.evaluate(() => document.activeElement?.blur?.());
  t.tool = async k => { await t.blur(); await t.key(k, 250); };
  // world ↔ screen
  t.W2S = (wx, wy) => pg.evaluate(async ([wx, wy]) => { const m = await import('/js/model.js'); const r = document.getElementById('canvas').getBoundingClientRect(); const v = m.state.view; return [r.left + v.tx + wx * v.s, r.top + v.ty + wy * v.s]; }, [wx, wy]);
  t.at = async (wx, wy, pause) => t.clickAt(...await t.W2S(wx, wy), pause);
  t.view = (s, wx, wy) => t.m((m, [s, wx, wy]) => {
    const r = document.getElementById('canvas').getBoundingClientRect();
    m.state.view = { s, tx: r.width / 2 - wx * s, ty: r.height / 2 - wy * s }; m.changed();
  }, [s, wx, wy]);
  t.zoomTo = (s, wx, wy, frames = 14) => pg.evaluate(async ([s, wx, wy, frames]) => {
    const m = await import('/js/model.js');
    const r = document.getElementById('canvas').getBoundingClientRect();
    const v = m.state.view, s0 = v.s, cx = (r.width / 2 - v.tx) / v.s, cy = (r.height / 2 - v.ty) / v.s;
    for (let i = 1; i <= frames; i++) {
      const f = i / frames, e = f * f * (3 - 2 * f), si = s0 * Math.pow(s / s0, e);
      v.s = si; v.tx = r.width / 2 - (cx + (wx - cx) * e) * si; v.ty = r.height / 2 - (cy + (wy - cy) * e) * si;
      m.changed(); await new Promise(res => setTimeout(res, 60));
    }
  }, [s, wx, wy, DRY ? 1 : frames]);
  t.deselect = () => t.m(m => { m.state.selection = []; m.changed(); });
  t.select = refs => t.m((m, refs) => { m.state.selection = refs; m.changed(); }, refs);
  t.load = doc => t.m((m, d) => { m.loadDocJSON(JSON.stringify(d)); }, doc);
  t.reveal = async sel => { // scroll just the panel holding sel, never the page
    const loc = pg.locator(sel).first();
    if (!await loc.count()) return;
    await loc.evaluate(n => {
      let p = n.parentElement;
      while (p && !(p.scrollHeight > p.clientHeight && /auto|scroll/.test(getComputedStyle(p).overflowY))) p = p.parentElement;
      if (!p) return;
      const r = n.getBoundingClientRect(), q = p.getBoundingClientRect();
      if (r.top < q.top + 20 || r.bottom > q.bottom - 60) p.scrollTop += r.top - q.top - 120;
    });
  };
  t.drag = async (pts, steps = 14, mods = []) => {
    await t.move(...pts[0]); await t.wait(250);
    for (const k of mods) await pg.keyboard.down(k);
    await pg.mouse.down();
    for (const p of pts.slice(1)) await t.move(...p, steps);
    await t.wait(500); await t.snap('drag'); await pg.mouse.up();
    for (const k of mods) await pg.keyboard.up(k);
    await t.wait(400);
  };
  t.wdrag = async (wpts, steps, mods) => { const s = []; for (const p of wpts) s.push(await t.W2S(...p)); await t.drag(s, steps, mods); };
  t.ctx = async (wx, wy, pause = 900) => { const [x, y] = await t.W2S(wx, wy); await t.move(x, y); await t.wait(200); await pg.mouse.click(x, y, { button: 'right' }); await t.wait(pause); await t.snap('ctx'); };
  t.ctxItem = async (text, pause = 500) => t.click(`#ctxMenu button:has-text("${text}"), .ctx-menu button:has-text("${text}")`, pause);
  t.field = async (sel, value, delay = 45) => { await t.reveal(sel); await t.click(sel, 150); await pg.keyboard.press('Control+A'); await t.type(value, delay); await t.wait(300); await t.blur(); };
  t.F = name => `#panel label.field:has(> span:text-is("${name}"))`; // a properties-panel row
  t.pick = async (name, value, pause = 900) => { // choose in a panel <select>, visibly
    const sel = `${t.F(name)} select`;
    await t.reveal(sel); await t.hover(sel, 300);
    await pg.selectOption(sel, value); await t.wait(pause);
  };
  t.check = async (name, pause = 700) => { const s = `#panel label:has-text("${name}") input[type=checkbox]`; await t.reveal(s); await t.click(s, pause); };
  t.fill = async (name, value, delay) => t.field(`${t.F(name)} input, ${t.F(name)} textarea`, value, delay);
  t.slot = async i => { const s = `#panel .swatch.slot >> nth=${i}`; await t.reveal(s); await t.click(s, 400); };
  t.swatch = async i => { const s = `.swatches:not(:has(.slot)) .swatch >> nth=${i}`; await t.reveal(s); await t.click(s, 350); };

  try {
    await story(t);
  } catch (e) {
    errs.push('STORY ' + e.message);
    await pg.screenshot({ path: `${OUT}/fail-${name}.png` });
  }
  await ctx.close(); await b.close();
  if (!DRY) {
    const vid = fs.readdirSync(dir).find(f => f.endsWith('.webm'));
    const gif = `${OUT}/${name}.gif`;
    execSync(`ffmpeg -v error -y -i "${dir}/${vid}" -vf "fps=10,scale=1120:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle" "${gif}"`);
    // contact sheet for a quick look: 12 frames
    const dur = +execSync(`ffprobe -v error -show_entries format=duration -of csv=p=0 "${dir}/${vid}"`).toString();
    execSync(`ffmpeg -v error -y -i "${dir}/${vid}" -vf "fps=${(12 / dur).toFixed(4)},scale=420:-1,tile=4x3" -frames:v 1 "${OUT}/.sheet-${name}.png"`);
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`${gif}  ${(fs.statSync(gif).size / 1e6).toFixed(1)} MB  ${dur.toFixed(0)} s`);
  }
  console.log('errors', JSON.stringify(errs));
}

module.exports = { run, W, H };
