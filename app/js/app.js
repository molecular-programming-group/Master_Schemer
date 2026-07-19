// App shell: event routing, panel, keyboard, view controls, file ops.
import {
  state, COLORS, setOnChanged, beginChange, changed, undo, redo,
  deleteSelection, selectionSingle, byId, newDoc, loadDocJSON, restoreAutosave,
} from './model.js';
import { GRID } from './geom.js';
import { render, screenToWorld, contentBBox, exportSVGString } from './render.js';
import { tools, cancelActive, isDragging } from './tools.js';

const $ = id => document.getElementById(id);
const svg = $('canvas');
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// ---- refresh pipeline ----

function refresh() {
  render();
  renderPanel();
  $('undoBtn').disabled = !state.history.length;
  $('redoBtn').disabled = !state.future.length;
  $('zoomLabel').textContent = `${Math.round(state.view.s * 100)}%`;
}
setOnChanged(refresh);

// ---- tool switching ----

const TOOL_KEYS = { v: 'select', l: 'path', s: 'segment', c: 'card', a: 'arrow', d: 'draw', t: 'text', h: 'hand' };

function setTool(name) {
  if (isDragging()) cancelActive();
  state.tool = name;
  document.body.dataset.tool = name;
  document.querySelectorAll('[data-tool]').forEach(b =>
    b.setAttribute('aria-pressed', b.dataset.tool === name));
  $('hint').textContent = name === 'hand' ? 'Drag to pan the canvas' : tools[name].hint;
  renderPanel();
}
document.querySelectorAll('#toolrail [data-tool]').forEach(b =>
  b.addEventListener('click', () => setTool(b.dataset.tool)));

// ---- pointer routing ----

let panning = null;      // {sx, sy, tx, ty}
let spaceHeld = false;

function eventScreen(e) {
  const r = svg.getBoundingClientRect();
  return [e.clientX - r.left, e.clientY - r.top];
}

svg.addEventListener('pointerdown', e => {
  if (e.button === 2) return;
  svg.setPointerCapture(e.pointerId);
  const sp = eventScreen(e);
  if (e.button === 1 || spaceHeld || state.tool === 'hand') {
    panning = { sx: sp[0], sy: sp[1], tx: state.view.tx, ty: state.view.ty };
    document.body.classList.add('panning');
    return;
  }
  tools[state.tool]?.down?.(e, screenToWorld(sp), sp);
});

svg.addEventListener('pointermove', e => {
  const sp = eventScreen(e);
  const wp = screenToWorld(sp);
  $('coords').textContent = `${Math.round(wp[0] / GRID)}, ${Math.round(wp[1] / GRID)}`;
  if (panning) {
    state.view.tx = panning.tx + sp[0] - panning.sx;
    state.view.ty = panning.ty + sp[1] - panning.sy;
    render();
    return;
  }
  tools[state.tool]?.move?.(e, wp, sp);
});

svg.addEventListener('pointerup', e => {
  if (panning) {
    panning = null;
    document.body.classList.remove('panning');
    return;
  }
  tools[state.tool]?.up?.(e, screenToWorld(eventScreen(e)));
});

svg.addEventListener('dblclick', e => {
  if (state.tool === 'select') tools.select.dbl(e);
});

svg.addEventListener('contextmenu', e => e.preventDefault());

// ---- zoom ----

function zoomAt(sp, factor) {
  const v = state.view;
  const s2 = clamp(v.s * factor, 0.1, 8);
  v.tx = sp[0] - (sp[0] - v.tx) * (s2 / v.s);
  v.ty = sp[1] - (sp[1] - v.ty) * (s2 / v.s);
  v.s = s2;
  refresh();
}

svg.addEventListener('wheel', e => {
  e.preventDefault();
  zoomAt(eventScreen(e), Math.pow(1.0015, -e.deltaY));
}, { passive: false });

function zoomCenter(factor) {
  zoomAt([svg.clientWidth / 2, svg.clientHeight / 2], factor);
}

function fitView() {
  const box = contentBBox();
  const v = state.view;
  if (!box) { v.tx = 80; v.ty = 80; v.s = 1; refresh(); return; }
  const w = Math.max(box[2] - box[0], GRID), h = Math.max(box[3] - box[1], GRID);
  v.s = clamp(Math.min((svg.clientWidth - 120) / w, (svg.clientHeight - 120) / h), 0.1, 2);
  v.tx = (svg.clientWidth - w * v.s) / 2 - box[0] * v.s;
  v.ty = (svg.clientHeight - h * v.s) / 2 - box[1] * v.s;
  refresh();
}

$('zoomIn').addEventListener('click', () => zoomCenter(1.25));
$('zoomOut').addEventListener('click', () => zoomCenter(0.8));
$('zoomFit').addEventListener('click', fitView);
$('zoomLabel').addEventListener('click', () => {
  const v = state.view;
  const c = screenToWorld([svg.clientWidth / 2, svg.clientHeight / 2]);
  v.s = 1;
  v.tx = svg.clientWidth / 2 - c[0];
  v.ty = svg.clientHeight / 2 - c[1];
  refresh();
});

// ---- keyboard ----

window.addEventListener('keydown', e => {
  const t = e.target;
  if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return;
  if (e.key === ' ') { spaceHeld = true; document.body.classList.add('panning'); e.preventDefault(); return; }
  if ((e.ctrlKey || e.metaKey)) {
    const k = e.key.toLowerCase();
    if (k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if (k === 'y') { e.preventDefault(); redo(); }
    else if (k === 's') { e.preventDefault(); saveJSON(); }
    else if (k === 'e') { e.preventDefault(); exportSVG(); }
    else if (k === 'o') { e.preventDefault(); $('fileInput').click(); }
    else if (k === 'a') {
      e.preventDefault();
      state.selection = state.doc.elements.filter(el => el.type !== 'arrow').map(el => ({ id: el.id }));
      refresh();
    }
    return;
  }
  const tool = TOOL_KEYS[e.key.toLowerCase()];
  if (tool) { setTool(tool); return; }
  switch (e.key) {
    case 'Delete': case 'Backspace': deleteSelection(); break;
    case 'Escape':
      if (isDragging()) cancelActive();
      else { state.selection = []; refresh(); }
      break;
    case '+': case '=': zoomCenter(1.25); break;
    case '-': zoomCenter(0.8); break;
    case '1': fitView(); break;
    case '0': $('zoomLabel').click(); break;
    case 'ArrowLeft': case 'ArrowRight': case 'ArrowUp': case 'ArrowDown': {
      const items = state.selection.filter(s => s.seg === undefined).map(s => byId(s.id)).filter(Boolean);
      if (!items.length) break;
      e.preventDefault();
      const dx = (e.key === 'ArrowLeft' ? -GRID : e.key === 'ArrowRight' ? GRID : 0);
      const dy = (e.key === 'ArrowUp' ? -GRID : e.key === 'ArrowDown' ? GRID : 0);
      beginChange();
      for (const el of items) {
        if (el.pts) el.pts = el.pts.map(p => [p[0] + dx, p[1] + dy]);
        else if (el.x !== undefined) { el.x += dx; el.y += dy; }
      }
      changed();
      break;
    }
  }
});
window.addEventListener('keyup', e => {
  if (e.key === ' ') { spaceHeld = false; if (!panning) document.body.classList.remove('panning'); }
});

// ---- properties panel ----

function fieldRow(labelText, node) {
  const row = document.createElement('label');
  row.className = 'field';
  const span = document.createElement('span');
  span.textContent = labelText;
  row.append(span, node);
  return row;
}

// Text input that snapshots history once per edit session.
function boundInput(get, set, { textarea = false, placeholder = '' } = {}) {
  const node = document.createElement(textarea ? 'textarea' : 'input');
  node.value = get();
  node.placeholder = placeholder;
  if (textarea) node.rows = 3;
  let edited = false;
  node.addEventListener('focus', () => { edited = false; });
  node.addEventListener('input', () => {
    if (!edited) { beginChange(); edited = true; }
    set(node.value);
    render(); // keep canvas live, but do not rebuild the panel mid-typing
  });
  return node;
}

function swatchGrid(getHex, setHex) {
  const grid = document.createElement('div');
  grid.className = 'swatches';
  for (const c of COLORS) {
    const b = document.createElement('button');
    b.className = 'swatch';
    b.style.background = c.hex;
    b.title = c.name;
    b.setAttribute('aria-label', c.name);
    if (getHex() === c.hex) b.setAttribute('aria-pressed', 'true');
    b.addEventListener('click', () => { setHex(c.hex); renderPanel(); });
    grid.appendChild(b);
  }
  return grid;
}

function widthControl(get, set) {
  const node = document.createElement('input');
  node.type = 'range';
  node.min = 1; node.max = 8; node.step = 0.5;
  node.value = get();
  node.addEventListener('input', () => { set(+node.value); });
  return node;
}

function deleteButton(label = 'Delete') {
  const b = document.createElement('button');
  b.className = 'btn danger';
  b.textContent = label;
  b.addEventListener('click', deleteSelection);
  return b;
}

function sectionTitle(text) {
  const h = document.createElement('h2');
  h.textContent = text;
  return h;
}

function renderPanel() {
  const panel = $('panelBody');
  if (panel.contains(document.activeElement)) return; // don't rebuild under the user's cursor
  panel.replaceChildren();
  const single = selectionSingle();
  const n = state.selection.length;

  // always-visible drawing defaults (color + width for the next stroke)
  const defaults = document.createElement('div');
  defaults.className = 'panel-section';
  defaults.appendChild(sectionTitle(single || n ? 'Style' : 'Drawing style'));
  defaults.appendChild(swatchGrid(
    () => (single && colorTarget(single)?.color) || state.color,
    hex => {
      state.color = hex;
      if (single) {
        const target = colorTarget(single);
        if (target) { beginChange(); target.color = hex; changed(); return; }
      }
      refresh();
    }));
  if (!single || single.el.width !== undefined) {
    defaults.appendChild(fieldRow('Width', widthControl(
      () => (single?.el.width) ?? state.width,
      v => {
        state.width = v;
        if (single && single.el.width !== undefined) { beginChange(); single.el.width = v; changed(); }
      })));
  }
  panel.appendChild(defaults);

  const sec = document.createElement('div');
  sec.className = 'panel-section';

  if (n === 0) {
    sec.appendChild(sectionTitle('Canvas'));
    const p = document.createElement('p');
    p.className = 'muted';
    const count = state.doc.elements.length;
    p.textContent = count
      ? `${count} object${count === 1 ? '' : 's'} in this scheme. Select one to edit its label and color.`
      : 'An empty canvas. Pick the Line tool (L) and drag on the grid to draw your first path, or frame a section with the Card tool (C).';
    sec.appendChild(p);
  } else if (!single) {
    sec.appendChild(sectionTitle(`${n} objects`));
    sec.appendChild(deleteButton('Delete selection'));
  } else if (single.seg !== undefined) {
    const el = single.el, seg = el.segments[single.seg];
    sec.appendChild(sectionTitle('Segment'));
    sec.appendChild(fieldRow('Label', boundInput(
      () => seg.label, v => { seg.label = v; }, { placeholder: 'e.g. domain a' })));
    sec.appendChild(deleteButton('Delete segment'));
  } else {
    const el = single.el;
    const titles = { path: 'Line', card: 'Card', arrow: 'Connection', text: 'Note', ink: 'Freehand' };
    sec.appendChild(sectionTitle(titles[el.type] || el.type));
    if (el.type === 'path' || el.type === 'arrow') {
      sec.appendChild(fieldRow('Label', boundInput(
        () => el.label, v => { el.label = v; }, { placeholder: 'name this object' })));
    }
    if (el.type === 'card') {
      sec.appendChild(fieldRow('Title', boundInput(
        () => el.title, v => { el.title = v; }, { placeholder: 'section title' })));
    }
    if (el.type === 'text') {
      sec.appendChild(fieldRow('Text', boundInput(
        () => el.text, v => { el.text = v; }, { textarea: true })));
      const sizeInput = document.createElement('input');
      sizeInput.type = 'number';
      sizeInput.min = 8; sizeInput.max = 72;
      sizeInput.value = el.size;
      sizeInput.addEventListener('change', () => {
        beginChange();
        el.size = clamp(+sizeInput.value || 14, 8, 72);
        changed();
      });
      sec.appendChild(fieldRow('Size', sizeInput));
    }
    if (el.type === 'path' && el.segments.length) {
      sec.appendChild(sectionTitle('Segments'));
      const list = document.createElement('div');
      list.className = 'seg-list';
      el.segments.forEach((seg, i) => {
        const item = document.createElement('button');
        item.className = 'seg-item';
        const dot = document.createElement('span');
        dot.className = 'seg-dot';
        dot.style.background = seg.color;
        const name = document.createElement('span');
        name.textContent = seg.label || `segment ${i + 1}`;
        item.append(dot, name);
        item.addEventListener('click', () => {
          state.selection = [{ id: el.id, seg: i }];
          refresh();
        });
        list.appendChild(item);
      });
      sec.appendChild(list);
    }
    sec.appendChild(deleteButton());
  }
  panel.appendChild(sec);
}

// what the swatch grid recolors for a given selection
function colorTarget(single) {
  if (single.seg !== undefined) return single.el.segments[single.seg];
  return single.el.color !== undefined ? single.el : null;
}

// ---- file operations ----

function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

function saveJSON() {
  download('scheme.schemer.json', JSON.stringify(state.doc, null, 1), 'application/json');
}

function exportSVG() {
  state.selection = [];
  refresh();
  const text = exportSVGString();
  if (!text) { $('hint').textContent = 'Nothing to export yet — the canvas is empty.'; return; }
  download('scheme.svg', text, 'image/svg+xml');
}

$('newBtn').addEventListener('click', () => {
  if (!state.doc.elements.length || confirm('Replace the current scheme with a blank canvas? (Undo can bring it back.)')) {
    newDoc();
  }
});
$('openBtn').addEventListener('click', () => $('fileInput').click());
$('fileInput').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try { loadDocJSON(await file.text()); fitView(); }
  catch { $('hint').textContent = `Could not read ${file.name} — not a Master Schemer file.`; }
});
$('saveBtn').addEventListener('click', saveJSON);
$('exportBtn').addEventListener('click', exportSVG);
$('undoBtn').addEventListener('click', undo);
$('redoBtn').addEventListener('click', redo);

window.addEventListener('resize', render);

// ---- boot ----

restoreAutosave();
setTool('select');
refresh();
if (state.doc.elements.length) fitView();
else { state.view.tx = 80; state.view.ty = 80; refresh(); }
