// App shell: event routing, sidebar, panel, keyboard, view controls, file ops.
import {
  state, COLORS, setOnChanged, beginChange, changed, undo, redo, newId,
  deleteSelection, selectionSingle, byId, newDoc, loadDocJSON, restoreAutosave,
  isSemantic, resolveColor, resolveLabel, reorder, pruneGroups,
} from './model.js';
import { GRID, mergePaths, rot90, flipPt, snapHalf } from './geom.js';
import {
  render, screenToWorld, contentBBox, elementBBox, exportSVGString, CAPS,
} from './render.js';
import { tools, cancelActive, isDragging, cardContents } from './tools.js';

const $ = id => document.getElementById(id);
const svg = $('canvas');
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// ---- refresh pipeline ----

function refresh() {
  render();
  // panels are DOM-heavy; while a drag is live only the canvas needs frames
  if (!isDragging()) {
    renderPanel();
    renderSidebar();
  }
  $('undoBtn').disabled = !state.history.length;
  $('redoBtn').disabled = !state.future.length;
  $('zoomLabel').textContent = `${Math.round(state.view.s * 100)}%`;
}
setOnChanged(refresh);

// ---- tool switching ----

const TOOL_KEYS = {
  v: 'select', l: 'path', s: 'segment', e: 'edit', c: 'card', a: 'arrow',
  d: 'draw', t: 'text', o: 'ellipse', b: 'rect', n: 'aline', r: 'aarrow', h: 'hand',
};

function setTool(name) {
  if (isDragging()) cancelActive();
  state.tool = name;
  document.body.dataset.tool = name;
  document.querySelectorAll('[data-tool]').forEach(b =>
    b.setAttribute('aria-pressed', b.dataset.tool === name));
  $('hint').textContent = name === 'hand' ? 'Drag to pan the canvas' : tools[name].hint;
  refresh();
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

// ---- selection helpers shared by transforms, alignment, CSV ----

const selectedElements = () => state.selection
  .filter(s => s.seg === undefined)
  .map(s => byId(s.id))
  .filter(el => el && el.type !== 'arrow');

function shiftEl(el, dx, dy) {
  if (el.pts) el.pts = el.pts.map(p => [p[0] + dx, p[1] + dy]);
  else if (el.cx !== undefined) { el.cx += dx; el.cy += dy; }
  else if (el.x !== undefined) { el.x += dx; el.y += dy; }
}

function combinedBBox(els) {
  let box = null;
  for (const el of els) {
    const b = elementBBox(el);
    box = box ? [Math.min(box[0], b[0]), Math.min(box[1], b[1]),
                 Math.max(box[2], b[2]), Math.max(box[3], b[3])] : b;
  }
  return box;
}

// Rotate (90° steps) or mirror the selection about its collective center.
// Text keeps its glyphs upright — only its anchor moves.
function transformSelection(op) { // 'cw' | 'ccw' | 'h' | 'v'
  const els = selectedElements();
  if (!els.length) return;
  const box = combinedBBox(els);
  const c = [snapHalf((box[0] + box[2]) / 2), snapHalf((box[1] + box[3]) / 2)];
  const rot = op === 'cw' || op === 'ccw';
  const pt = p => rot ? rot90(p, c, op === 'cw' ? 1 : -1) : flipPt(p, c, op);
  beginChange();
  for (const el of els) {
    if (el.type === 'ellipse') {
      [el.cx, el.cy] = pt([el.cx, el.cy]);
      if (rot) [el.rx, el.ry] = [el.ry, el.rx];
    } else if (el.type === 'card' || el.type === 'rect') {
      const ctr = pt([el.x + el.w / 2, el.y + el.h / 2]);
      if (rot) [el.w, el.h] = [el.h, el.w];
      el.x = ctr[0] - el.w / 2;
      el.y = ctr[1] - el.h / 2;
    } else if (el.pts) {
      el.pts = el.pts.map(pt);
    } else if (el.x !== undefined) {
      [el.x, el.y] = pt([el.x, el.y]);
    }
  }
  changed();
}

function alignSelection(mode) {
  const els = selectedElements();
  if (els.length < 2) return;
  const boxes = els.map(el => ({ el, b: elementBBox(el) }));
  const box = combinedBBox(els);
  const target = {
    left: box[0], right: box[2], top: box[1], bottom: box[3],
    hcenter: (box[0] + box[2]) / 2, vcenter: (box[1] + box[3]) / 2,
  }[mode];
  beginChange();
  for (const { el, b } of boxes) {
    let dx = 0, dy = 0;
    if (mode === 'left') dx = target - b[0];
    else if (mode === 'right') dx = target - b[2];
    else if (mode === 'hcenter') dx = target - (b[0] + b[2]) / 2;
    else if (mode === 'top') dy = target - b[1];
    else if (mode === 'bottom') dy = target - b[3];
    else if (mode === 'vcenter') dy = target - (b[1] + b[3]) / 2;
    // ponytail: grid lines keep their lattice — alignment lands within half a cell
    if (el.type === 'path') { dx = snapHalf(dx); dy = snapHalf(dy); }
    shiftEl(el, dx, dy);
  }
  changed();
}

// ---- groups ----

function groupSelection() {
  const els = selectedElements();
  if (els.length < 2) return;
  beginChange();
  const g = { id: newId(), name: `group ${state.doc.groups.length + 1}` };
  state.doc.groups.push(g);
  for (const el of els) el.group = g.id;
  pruneGroups(); // members stolen from other groups may leave them empty
  changed();
}

function ungroupSelection() {
  const gids = new Set(state.selection.map(s => byId(s.id)?.group).filter(Boolean));
  if (!gids.size) return;
  beginChange();
  for (const el of state.doc.elements) if (gids.has(el.group)) delete el.group;
  pruneGroups();
  changed();
}

// ---- keyboard ----

window.addEventListener('keydown', e => {
  const t = e.target;
  if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return;
  if (e.key === ' ') { spaceHeld = true; document.body.classList.add('panning'); e.preventDefault(); return; }
  if ((e.ctrlKey || e.metaKey)) {
    const k = e.key.toLowerCase();
    if (k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if (k === 'y') { e.preventDefault(); redo(); }
    else if (k === 's') { e.preventDefault(); saveJSON(e.shiftKey); }
    else if (k === 'e') { e.preventDefault(); exportSVG(); }
    else if (k === 'o') { e.preventDefault(); openFile(); }
    else if (k === 'g') { e.preventDefault(); e.shiftKey ? ungroupSelection() : groupSelection(); }
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
      for (const el of items) shiftEl(el, dx, dy);
      changed();
      break;
    }
  }
});
window.addEventListener('keyup', e => {
  if (e.key === ' ') { spaceHeld = false; if (!panning) document.body.classList.remove('panning'); }
});

// ---- shared label plumbing ----

// Writing through a shared-label reference edits the slot, so every element
// pointing at it updates too.
function setLabel(target, v) {
  const l = target.label;
  if (typeof l === 'string' && l.startsWith('slot:')) {
    const slot = state.doc.labelSlots.find(s => s.id === l.slice(5));
    if (slot) { slot.text = v; return; }
  }
  target.label = v;
}

// ---- object sidebar (semantic registry) ----

function displayName(el, i) {
  if (el.type === 'card') return el.title || 'Untitled card';
  const label = resolveLabel(el.label || '');
  if (el.type === 'text') return label || el.text.split('\n')[0].slice(0, 24) || 'note';
  const names = {
    path: 'line', ink: 'freehand', ellipse: 'ellipse', rect: 'rectangle',
    aline: 'line note', aarrow: 'arrow',
  };
  return label || `${names[el.type] || el.type} ${i + 1}`;
}

// Inline rename on double-click; single click selects.
function sideItem({ depth, name, color, selected, onSelect, onRename }) {
  const row = document.createElement('div');
  row.className = 'side-item';
  row.style.paddingLeft = `${8 + depth * 14}px`;
  if (selected) row.setAttribute('aria-current', 'true');
  if (color) {
    const dot = document.createElement('span');
    dot.className = 'seg-dot';
    dot.style.background = color;
    row.appendChild(dot);
  }
  const label = document.createElement('span');
  label.className = 'side-name';
  label.textContent = name;
  row.appendChild(label);
  row.addEventListener('click', onSelect);
  if (onRename) {
    row.title = 'Double-click to rename';
    row.addEventListener('dblclick', () => {
      const input = document.createElement('input');
      input.className = 'side-rename';
      input.value = name;
      label.replaceWith(input);
      input.focus();
      input.select();
      let done = false;
      const finish = commit => {
        if (done) return;
        done = true;
        const v = input.value;
        if (commit && v !== name) { beginChange(); onRename(v); changed(); }
        else refresh();
      };
      input.addEventListener('blur', () => finish(true));
      input.addEventListener('keydown', ev => {
        ev.stopPropagation();
        if (ev.key === 'Enter') finish(true);
        if (ev.key === 'Escape') finish(false);
      });
    });
  }
  return row;
}

function segItems(el, depth, into) {
  (el.segments || []).forEach((seg, i) => {
    into.appendChild(sideItem({
      depth, name: resolveLabel(seg.label || '') || `segment ${i + 1}`, color: resolveColor(seg.color),
      selected: state.selection.some(s => s.id === el.id && s.seg === i),
      onSelect: () => { state.selection = [{ id: el.id, seg: i }]; refresh(); },
      onRename: v => { setLabel(seg, v); },
    }));
  });
}

function objectItems(els, depth, into) {
  els.forEach(el => {
    const i = state.doc.elements.indexOf(el);
    into.appendChild(sideItem({
      depth, name: displayName(el, i),
      color: el.color !== undefined ? resolveColor(el.color) : null,
      selected: state.selection.some(s => s.id === el.id && s.seg === undefined),
      onSelect: () => { state.selection = [{ id: el.id }]; refresh(); },
      onRename: v => { setLabel(el, v); },
    }));
    if (el.type === 'path') segItems(el, depth + 1, into);
  });
}

function renderSidebar() {
  const body = $('sidebarBody');
  if (body.contains(document.activeElement)) return; // mid-rename
  body.replaceChildren();
  const els = state.doc.elements;
  const cards = els.filter(el => el.type === 'card');
  const tracked = els.filter(el => el.type !== 'card' && el.type !== 'arrow' && isSemantic(el));
  const placed = new Set();

  // user groups first: they are the explicit hierarchy
  for (const g of state.doc.groups) {
    const members = els.filter(el => el.group === g.id);
    if (!members.length) continue;
    body.appendChild(sideItem({
      depth: 0, name: g.name || 'group', color: null,
      selected: members.every(m => state.selection.some(s => s.id === m.id && s.seg === undefined)),
      onSelect: () => { state.selection = members.map(m => ({ id: m.id })); refresh(); },
      onRename: v => { g.name = v; },
    })).classList.add('side-card');
    members.forEach(el => placed.add(el.id));
    objectItems(members, 1, body);
  }

  for (const card of cards) {
    if (placed.has(card.id)) continue;
    body.appendChild(sideItem({
      depth: 0, name: displayName(card), color: null,
      selected: state.selection.some(s => s.id === card.id),
      onSelect: () => { state.selection = [{ id: card.id }]; refresh(); },
      onRename: v => { card.title = v; },
    })).classList.add('side-card');
    const inside = cardContents(card).filter(el => tracked.includes(el) && !placed.has(el.id));
    inside.forEach(el => placed.add(el.id));
    objectItems(inside, 1, body);
  }
  const loose = tracked.filter(el => !placed.has(el.id));
  if (loose.length && (cards.length || state.doc.groups.length)) {
    const h = document.createElement('div');
    h.className = 'side-group';
    h.textContent = 'Canvas';
    body.appendChild(h);
  }
  objectItems(loose, cards.length || state.doc.groups.length ? 1 : 0, body);
  if (!cards.length && !tracked.length && !state.doc.groups.length) {
    const p = document.createElement('p');
    p.className = 'muted side-empty';
    p.textContent = 'Objects you draw with the model tools appear here. Promote an annotation to track it too.';
    body.appendChild(p);
  }
  renderLibrary();
}

// ---- asset library (persists across sessions, transferable as a file) ----

const LIB_KEY = 'master-schemer-library';
let library = [];
try { library = JSON.parse(localStorage.getItem(LIB_KEY) || '[]'); } catch { library = []; }
const saveLibrary = () => {
  try { localStorage.setItem(LIB_KEY, JSON.stringify(library)); } catch { /* full/blocked */ }
};

function assetFromSelection() {
  const ids = new Set();
  for (const s of state.selection) {
    if (s.seg !== undefined) continue;
    const el = byId(s.id);
    if (!el) continue;
    ids.add(el.id);
    if (el.type === 'card') for (const c of cardContents(el)) ids.add(c.id);
    if (el.group) for (const m of state.doc.elements) if (m.group === el.group) ids.add(m.id);
  }
  if (!ids.size) {
    $('hint').textContent = 'Select something first, then save it to the library.';
    return;
  }
  const els = state.doc.elements.filter(el => ids.has(el.id))
    .map(el => JSON.parse(JSON.stringify(el)));
  // freeze palette/label slot refs — another document won't have these slots
  for (const el of els) {
    if (el.color !== undefined) el.color = resolveColor(el.color);
    if (el.label) el.label = resolveLabel(el.label);
    for (const seg of el.segments || []) {
      seg.color = resolveColor(seg.color);
      seg.label = resolveLabel(seg.label);
    }
  }
  const groups = state.doc.groups.filter(g => els.some(el => el.group === g.id))
    .map(g => ({ ...g }));
  library.push({ id: newId(), name: `asset ${library.length + 1}`, elements: els, groups });
  saveLibrary();
  refresh();
  $('hint').textContent = 'Saved to library — double-click its entry to rename it.';
}

function placeAsset(asset) {
  beginChange();
  const els = JSON.parse(JSON.stringify(asset.elements));
  const idMap = new Map();
  for (const el of els) { const nid = newId(); idMap.set(el.id, nid); el.id = nid; }
  const groupMap = new Map();
  for (const g of asset.groups || []) {
    const ng = { id: newId(), name: g.name };
    state.doc.groups.push(ng);
    groupMap.set(g.id, ng.id);
  }
  const placed = els.filter(el => {
    if (el.group) el.group = groupMap.get(el.group);
    if (!el.group) delete el.group;
    if (el.type !== 'arrow') return true;
    if (!idMap.has(el.from) || !idMap.has(el.to)) return false;
    el.from = idMap.get(el.from);
    el.to = idMap.get(el.to);
    return true;
  });
  state.doc.elements.push(...placed);
  const solid = placed.filter(el => el.type !== 'arrow');
  const box = combinedBBox(solid);
  if (box) {
    const c = screenToWorld([svg.clientWidth / 2, svg.clientHeight / 2]);
    const dx = snapHalf(c[0] - (box[0] + box[2]) / 2);
    const dy = snapHalf(c[1] - (box[1] + box[3]) / 2);
    for (const el of solid) shiftEl(el, dx, dy);
  }
  pruneGroups();
  state.selection = solid.map(el => ({ id: el.id }));
  changed();
}

async function exportLibrary() {
  const text = JSON.stringify({ masterSchemerLibrary: 1, assets: library }, null, 1);
  try {
    if (TAURI) {
      const path = await TAURI.dialog.save({
        defaultPath: 'schemer-library.json',
        filters: [{ name: 'Master Schemer library', extensions: ['json'] }],
      });
      if (!path) return;
      await TAURI.fs.writeTextFile(path, text);
    } else {
      download('schemer-library.json', text, 'application/json');
    }
    $('hint').textContent = 'Library exported.';
  } catch (err) {
    if (err?.name !== 'AbortError') $('hint').textContent = `Export failed: ${err.message || err}`;
  }
}

function mergeLibraryJSON(text) {
  const data = JSON.parse(text);
  if (!Array.isArray(data.assets)) throw new Error('not a library file');
  library.push(...data.assets);
  saveLibrary();
  refresh();
  $('hint').textContent = `Imported ${data.assets.length} asset${data.assets.length === 1 ? '' : 's'}.`;
}

async function importLibrary() {
  try {
    if (TAURI) {
      const path = await TAURI.dialog.open({
        multiple: false,
        filters: [{ name: 'Master Schemer library', extensions: ['json'] }],
      });
      if (!path) return;
      mergeLibraryJSON(await TAURI.fs.readTextFile(path));
    } else {
      $('libInput').click();
    }
  } catch (err) {
    $('hint').textContent = `Could not import library: ${err.message || err}`;
  }
}

function renderLibrary() {
  const body = $('libraryBody');
  if (body.contains(document.activeElement)) return; // mid-rename
  body.replaceChildren();
  for (const asset of library) {
    const row = sideItem({
      depth: 0, name: asset.name || 'asset', color: null, selected: false,
      onSelect: () => placeAsset(asset),
      onRename: v => { asset.name = v; saveLibrary(); },
    });
    row.title = 'Click to place · double-click to rename';
    const del = document.createElement('button');
    del.className = 'side-del';
    del.textContent = '×';
    del.title = 'Remove from library';
    del.addEventListener('click', e => {
      e.stopPropagation();
      library = library.filter(a => a !== asset);
      saveLibrary();
      refresh();
    });
    row.appendChild(del);
    body.appendChild(row);
  }
  const actions = document.createElement('div');
  actions.className = 'lib-actions';
  actions.append(
    smallButton('＋ Save selection', assetFromSelection, 'Store the selected objects as a reusable asset'),
    smallButton('Import', importLibrary, 'Merge a library file from another machine'),
    smallButton('Export', exportLibrary, 'Write the library to a file you can move to another machine'),
  );
  body.appendChild(actions);
}

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
  node.addEventListener('blur', () => {
    if (edited) { edited = false; changed(); } // commit: autosave + sidebar refresh
  });
  return node;
}

function checkboxRow(text, get, set) {
  const lab = document.createElement('label');
  lab.className = 'check-row';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = get();
  cb.addEventListener('change', () => { beginChange(); set(cb.checked); changed(); });
  const span = document.createElement('span');
  span.textContent = text;
  lab.append(cb, span);
  return lab;
}

// Every color target in the current selection (elements and segments).
function colorTargets() {
  const out = [];
  for (const s of state.selection) {
    const el = byId(s.id);
    if (!el) continue;
    if (s.seg !== undefined) { const seg = el.segments?.[s.seg]; if (seg) out.push(seg); }
    else if (el.color !== undefined) out.push(el);
  }
  return out;
}

function applyColor(c) {
  state.color = c;
  const targets = colorTargets();
  if (targets.length) {
    beginChange();
    for (const t of targets) t.color = c;
    changed();
  } else refresh();
  renderPanel();
}

function currentColor() {
  const t = colorTargets();
  return t.length ? t[0].color : state.color;
}

// ---- custom color picker (inline, so nothing can dismiss it) ----

function hsvToHex(h, s, v) {
  const f = n => {
    const k = (n + h / 30) % 12;
    const c = v - v * s * Math.max(0, Math.min(k - 3, 9 - k, 1));
    return Math.round(c * 255).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

function hexToHsv(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = 60 * (((g - b) / d + 6) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  return { h, s: max ? d / max : 0, v: max };
}

let openPicker = null; // { key, h, s, v, began } — survives panel rebuilds

function colorPicker(key, getHex, applyLive, commit) {
  const wrap = document.createElement('div');
  wrap.className = 'picker';
  const well = document.createElement('button');
  well.type = 'button';
  well.className = 'picker-well';
  const chip = document.createElement('span');
  chip.className = 'picker-chip';
  chip.style.background = getHex();
  const caption = document.createElement('span');
  caption.textContent = openPicker?.key === key ? 'close' : getHex();
  well.append(chip, caption);
  well.addEventListener('click', () => {
    openPicker = openPicker?.key === key
      ? null
      : { key, ...(hexToHsv(getHex()) || { h: 40, s: 0.6, v: 0.7 }), began: false };
    renderPanel();
  });
  wrap.appendChild(well);
  if (openPicker?.key !== key) return wrap;

  const st = openPicker;
  const hex = () => hsvToHex(st.h, st.s, st.v);

  const pad = document.createElement('div');
  pad.className = 'picker-pad';
  const dot = document.createElement('div');
  dot.className = 'picker-dot';
  pad.appendChild(dot);
  const hue = document.createElement('input');
  hue.type = 'range';
  hue.className = 'picker-hue';
  hue.min = 0; hue.max = 360; hue.step = 1;
  hue.value = st.h;
  const hexIn = document.createElement('input');
  hexIn.className = 'picker-hex';
  hexIn.value = hex();

  const sync = () => {
    pad.style.backgroundColor = `hsl(${st.h}, 100%, 50%)`;
    dot.style.left = `${st.s * 100}%`;
    dot.style.top = `${(1 - st.v) * 100}%`;
    chip.style.background = hex();
    caption.textContent = 'close';
  };
  const live = () => {
    if (!st.began) { applyLive.begin?.(); st.began = true; }
    applyLive(hex());
    sync();
  };
  const done = () => {
    if (st.began) { st.began = false; commit(); }
  };

  const pick = e => {
    const r = pad.getBoundingClientRect();
    st.s = clamp((e.clientX - r.left) / r.width, 0, 1);
    st.v = clamp(1 - (e.clientY - r.top) / r.height, 0, 1);
    hexIn.value = hex();
    live();
  };
  pad.addEventListener('pointerdown', e => {
    pad.setPointerCapture(e.pointerId);
    pick(e);
    const mv = ev => pick(ev);
    pad.addEventListener('pointermove', mv);
    pad.addEventListener('pointerup', () => {
      pad.removeEventListener('pointermove', mv);
      done();
    }, { once: true });
  });
  hue.addEventListener('input', () => {
    st.h = +hue.value;
    hexIn.value = hex();
    live();
  });
  hue.addEventListener('change', done);
  hexIn.addEventListener('change', () => {
    const parsed = hexToHsv(hexIn.value);
    if (!parsed) { hexIn.value = hex(); return; }
    Object.assign(st, parsed);
    hue.value = st.h;
    live();
    done();
  });
  sync();
  wrap.append(pad, hue, hexIn);
  return wrap;
}

let activeSlot = null; // palette slot id whose editor is open

function paletteSection() {
  const sec = document.createElement('div');
  sec.className = 'panel-section';
  sec.appendChild(sectionTitle('Color'));

  // fixed swatches + free color picker
  const grid = document.createElement('div');
  grid.className = 'swatches';
  for (const c of COLORS) {
    const b = document.createElement('button');
    b.className = 'swatch';
    b.style.background = c.hex;
    b.title = c.name;
    b.setAttribute('aria-label', c.name);
    if (currentColor() === c.hex) b.setAttribute('aria-pressed', 'true');
    b.addEventListener('click', () => applyColor(c.hex));
    grid.appendChild(b);
  }
  sec.appendChild(grid);

  const cur = resolveColor(currentColor());
  const mainPick = colorPicker('main',
    () => (/^#[0-9a-f]{6}$/i.test(cur) ? cur : '#2b2622'),
    Object.assign(hexv => {
      state.color = hexv;
      for (const t of colorTargets()) t.color = hexv;
      render();
    }, { begin: beginChange }),
    changed);
  sec.appendChild(fieldRow('Custom color', mainPick));

  // memory slots: elements store slot:<id>, so editing a slot recolors them all
  const slotsWrap = document.createElement('div');
  slotsWrap.className = 'swatches';
  for (const slot of state.doc.palette) {
    const b = document.createElement('button');
    b.className = 'swatch slot';
    b.style.background = slot.color;
    b.title = `${slot.name || 'slot'} — click to apply, double-click to edit`;
    if (currentColor() === `slot:${slot.id}`) b.setAttribute('aria-pressed', 'true');
    b.addEventListener('click', () => {
      if (state.color === `slot:${slot.id}` || activeSlot === slot.id) activeSlot = slot.id;
      applyColor(`slot:${slot.id}`);
    });
    b.addEventListener('dblclick', () => { activeSlot = slot.id; renderPanel(); });
    slotsWrap.appendChild(b);
  }
  const add = document.createElement('button');
  add.className = 'swatch slot-add';
  add.textContent = '+';
  add.title = 'Store the current color in a new slot';
  add.addEventListener('click', () => {
    beginChange();
    const slot = { id: newId(), name: `slot ${state.doc.palette.length + 1}`, color: resolveColor(currentColor()) };
    state.doc.palette.push(slot);
    activeSlot = slot.id;
    state.color = `slot:${slot.id}`;
    changed();
  });
  slotsWrap.appendChild(add);
  sec.appendChild(fieldRow('Memory slots', slotsWrap));

  const slot = state.doc.palette.find(s => s.id === activeSlot);
  if (slot) {
    const ed = document.createElement('div');
    ed.className = 'slot-editor';
    const slotPick = colorPicker(`slot:${slot.id}`,
      () => slot.color,
      Object.assign(hexv => {
        slot.color = hexv;
        render(); // every element referencing this slot recolors live
      }, { begin: beginChange }),
      changed);
    const nInput = boundInput(() => slot.name || '', v => { slot.name = v; }, { placeholder: 'slot name' });
    const del = document.createElement('button');
    del.className = 'btn danger';
    del.textContent = 'Remove slot';
    del.addEventListener('click', () => {
      beginChange();
      // freeze current color into every user of the slot before removing it
      const frozen = slot.color;
      for (const el of state.doc.elements) {
        if (el.color === `slot:${slot.id}`) el.color = frozen;
        for (const seg of el.segments || []) if (seg.color === `slot:${slot.id}`) seg.color = frozen;
      }
      state.doc.palette = state.doc.palette.filter(s => s !== slot);
      if (state.color === `slot:${slot.id}`) state.color = frozen;
      activeSlot = null;
      changed();
    });
    ed.append(fieldRow('Slot color', slotPick), fieldRow('Slot name', nInput), del);
    sec.appendChild(ed);
  }
  return sec;
}

function widthControl(get, set, touchesDoc) {
  const row = document.createElement('div');
  row.className = 'width-row';
  const range = document.createElement('input');
  range.type = 'range';
  range.min = 1; range.max = GRID; range.step = 0.5; // GRID-wide strokes tile the lattice
  range.value = get();
  const num = document.createElement('input');
  num.type = 'number';
  num.min = 1; num.max = GRID; num.step = 0.5;
  num.value = get();
  let editing = false;
  range.addEventListener('input', () => {
    if (touchesDoc && !editing) { beginChange(); editing = true; }
    set(+range.value);
    num.value = range.value;
    if (touchesDoc) render();
  });
  range.addEventListener('change', () => {
    if (editing) { editing = false; changed(); }
  });
  num.addEventListener('change', () => {
    const v = clamp(+num.value || 2, 1, GRID);
    num.value = v;
    range.value = v;
    if (touchesDoc) beginChange();
    set(v);
    if (touchesDoc) changed();
  });
  row.append(range, num);
  return row;
}

function selectControl(options, get, set) {
  const node = document.createElement('select');
  for (const o of options) {
    const opt = document.createElement('option');
    opt.value = o; opt.textContent = o;
    node.appendChild(opt);
  }
  node.value = get();
  node.addEventListener('change', () => { beginChange(); set(node.value); changed(); });
  return node;
}

function numberControl(get, set, { min = 0, max = 999, step = 1 } = {}) {
  const node = document.createElement('input');
  node.type = 'number';
  node.min = min; node.max = max; node.step = step;
  node.value = get();
  node.addEventListener('change', () => {
    beginChange();
    set(clamp(+node.value || 0, min, max));
    changed();
  });
  return node;
}

function deleteButton(label = 'Delete') {
  const b = document.createElement('button');
  b.className = 'btn danger';
  b.textContent = label;
  b.addEventListener('click', deleteSelection);
  return b;
}

function smallButton(label, onClick, title = '') {
  const b = document.createElement('button');
  b.className = 'btn outline';
  b.textContent = label;
  if (title) b.title = title;
  b.addEventListener('click', onClick);
  return b;
}

function sectionTitle(text) {
  const h = document.createElement('h2');
  h.textContent = text;
  return h;
}

// Label editor with shared-label slots: attach the element to a slot and one
// edit renames every element pointing at it.
function labelFields(target, placeholder) {
  const frag = document.createDocumentFragment();
  frag.appendChild(fieldRow('Label', boundInput(
    () => resolveLabel(target.label || ''),
    v => setLabel(target, v),
    { placeholder })));
  const sel = document.createElement('select');
  const options = [
    ['', '— not shared —'],
    ...state.doc.labelSlots.map(s => [s.id, `“${(s.text || 'empty').slice(0, 22)}”`]),
    ['+', 'new shared label…'],
  ];
  for (const [v, t] of options) {
    const o = document.createElement('option');
    o.value = v; o.textContent = t;
    sel.appendChild(o);
  }
  const ref = typeof target.label === 'string' && target.label.startsWith('slot:')
    ? target.label.slice(5) : '';
  sel.value = ref;
  sel.addEventListener('change', () => {
    beginChange();
    if (sel.value === '+') {
      const slot = { id: newId(), text: resolveLabel(target.label || '') };
      state.doc.labelSlots.push(slot);
      target.label = `slot:${slot.id}`;
    } else if (sel.value === '') {
      target.label = resolveLabel(target.label || ''); // detach: freeze current text
    } else {
      target.label = `slot:${sel.value}`;
    }
    changed();
  });
  frag.appendChild(fieldRow('Shared label', sel));
  return frag;
}

function labelDisplayFields(target) {
  const frag = document.createDocumentFragment();
  frag.appendChild(checkboxRow('Hide label', () => !!target.labelHide, v => {
    if (v) target.labelHide = true; else delete target.labelHide;
  }));
  if (target.labelOff) {
    frag.appendChild(smallButton('Reset label position', () => {
      beginChange();
      delete target.labelOff;
      changed();
    }, 'Put the label back at its automatic spot'));
  }
  return frag;
}

function joinSelectedPaths() {
  const els = state.selection.filter(s => s.seg === undefined).map(s => byId(s.id));
  if (els.length !== 2 || els.some(el => el?.type !== 'path')) return null;
  const [a, b] = els;
  return mergePaths(a.pts, a.segments || [], b.pts, b.segments || []) && { a, b };
}

const LINECAP_NAMES = { round: 'rounded', butt: 'flat', square: 'square' };
const LINECAP_VALUES = { rounded: 'round', flat: 'butt', square: 'square' };

function renderPanel() {
  const panel = $('panelBody');
  // don't rebuild under the user's cursor while they type in a field
  const ae = document.activeElement;
  if (panel.contains(ae) &&
      (ae.tagName === 'TEXTAREA' ||
       (ae.tagName === 'INPUT' && ['text', 'number', 'search'].includes(ae.type)))) return;
  panel.replaceChildren();
  const single = selectionSingle();
  const n = state.selection.length;

  panel.appendChild(paletteSection());

  const styleSec = document.createElement('div');
  styleSec.className = 'panel-section';
  let styled = false;
  if (!single || single.el.width !== undefined) {
    styleSec.appendChild(fieldRow('Width', widthControl(
      () => (single?.el.width) ?? state.width,
      v => {
        state.width = v;
        if (single && single.el.width !== undefined) single.el.width = v;
      },
      !!(single && single.el.width !== undefined))));
    styled = true;
  }
  if (single && ['path', 'aline', 'ellipse', 'ink', 'rect'].includes(single.el.type) && single.seg === undefined) {
    const el = single.el;
    styleSec.appendChild(fieldRow('Line style', selectControl(
      ['solid', 'dashed', 'dotted'], () => el.dash || 'solid', v => { el.dash = v; })));
    if (['path', 'aline', 'ink'].includes(el.type)) {
      styleSec.appendChild(fieldRow('Line ends', selectControl(
        ['rounded', 'flat', 'square'],
        () => LINECAP_NAMES[el.linecap || 'round'],
        v => { el.linecap = LINECAP_VALUES[v]; })));
    }
    if (el.type === 'path' || el.type === 'aline') {
      styleSec.appendChild(fieldRow('Start cap', selectControl(
        CAPS, () => el.cap0 || 'none', v => { el.cap0 = v; })));
      styleSec.appendChild(fieldRow('End cap', selectControl(
        CAPS, () => el.cap1 || 'none', v => { el.cap1 = v; })));
    }
    if (el.type === 'rect') {
      styleSec.appendChild(fieldRow('Corner radius', numberControl(
        () => el.r || 0,
        v => { el.r = v; },
        { min: 0, max: Math.floor(Math.min(el.w, el.h) / 2), step: 1 })));
    }
    styled = true;
  }
  if (styled) {
    styleSec.prepend(sectionTitle(single || n ? 'Style' : 'Drawing style'));
    panel.appendChild(styleSec);
  }

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
    const row = document.createElement('div');
    row.className = 'btn-row';
    row.append(smallButton('Group', groupSelection, 'Bundle the selection into a named group (Ctrl+G)'));
    if (state.selection.some(s => byId(s.id)?.group)) {
      row.append(smallButton('Ungroup', ungroupSelection, 'Dissolve the selected group(s) (Ctrl+Shift+G)'));
    }
    const join = joinSelectedPaths();
    if (join) {
      row.append(smallButton('Join lines', () => {
        const merged = mergePaths(join.a.pts, join.a.segments || [], join.b.pts, join.b.segments || []);
        beginChange();
        join.a.pts = merged.pts;
        join.a.segments = merged.segments;
        state.doc.elements = state.doc.elements.filter(el => el !== join.b);
        state.selection = [{ id: join.a.id }];
        changed();
      }, 'Fuse two lines whose ends meet on the same grid point'));
    }
    sec.appendChild(row);
    sec.appendChild(deleteButton('Delete selection'));
  } else if (single.seg !== undefined) {
    const el = single.el, seg = el.segments[single.seg];
    sec.appendChild(sectionTitle('Segment'));
    sec.appendChild(labelFields(seg, 'e.g. domain a'));
    sec.appendChild(labelDisplayFields(seg));
    sec.appendChild(fieldRow('Data (not displayed)', boundInput(
      () => seg.notes || '', v => { seg.notes = v; }, { textarea: true, placeholder: 'notes, metadata…' })));
    sec.appendChild(deleteButton('Delete segment'));
  } else {
    const el = single.el;
    const titles = {
      path: 'Line', card: 'Card', arrow: 'Connection', text: 'Note', ink: 'Freehand',
      ellipse: 'Ellipse', rect: 'Rectangle', aline: 'Line note', aarrow: 'Arrow note',
    };
    sec.appendChild(sectionTitle(titles[el.type] || el.type));
    if (el.type === 'card') {
      sec.appendChild(fieldRow('Title', boundInput(
        () => el.title, v => { el.title = v; }, { placeholder: 'section title' })));
    } else if (el.type !== 'text' || isSemantic(el)) {
      sec.appendChild(labelFields(el, 'name this object'));
      if (el.type !== 'text') sec.appendChild(labelDisplayFields(el));
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
      sec.appendChild(fieldRow('Wrap width (0 = none)', numberControl(
        () => el.w || 0,
        v => { if (v >= GRID) el.w = v; else delete el.w; },
        { min: 0, max: 2000, step: 10 })));
    }
    sec.appendChild(fieldRow('Data (not displayed)', boundInput(
      () => el.notes || '', v => { el.notes = v; }, { textarea: true, placeholder: 'notes, metadata…' })));
    if (!isSemantic(el)) {
      sec.appendChild(smallButton('Promote to object', () => {
        beginChange();
        el.semantic = true;
        changed();
      }, 'Track this annotation in the object list'));
    }
    if (el.group) {
      sec.appendChild(smallButton('Ungroup', ungroupSelection, 'Remove this object’s group (Ctrl+Shift+G)'));
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
        dot.style.background = resolveColor(seg.color);
        const name = document.createElement('span');
        name.textContent = resolveLabel(seg.label || '') || `segment ${i + 1}`;
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

  // arrange: z-order, transforms, alignment
  if (n && state.selection.some(s => s.seg === undefined)) {
    const arr = document.createElement('div');
    arr.className = 'panel-section';
    arr.appendChild(sectionTitle('Arrange'));
    const zRow = document.createElement('div');
    zRow.className = 'btn-row';
    zRow.append(
      smallButton('Front', () => reorder('front')),
      smallButton('Raise', () => reorder('up')),
      smallButton('Lower', () => reorder('down')),
      smallButton('Back', () => reorder('back')),
    );
    arr.appendChild(zRow);
    const tRow = document.createElement('div');
    tRow.className = 'btn-row';
    tRow.append(
      smallButton('⟲ 90°', () => transformSelection('ccw'), 'Rotate counter-clockwise'),
      smallButton('⟳ 90°', () => transformSelection('cw'), 'Rotate clockwise'),
      smallButton('Flip H', () => transformSelection('h'), 'Mirror left-right'),
      smallButton('Flip V', () => transformSelection('v'), 'Mirror top-bottom'),
    );
    arr.appendChild(tRow);
    if (selectedElements().length >= 2) {
      const aRow = document.createElement('div');
      aRow.className = 'btn-row';
      aRow.append(
        smallButton('⇤ Left', () => alignSelection('left')),
        smallButton('⇹ Center', () => alignSelection('hcenter')),
        smallButton('⇥ Right', () => alignSelection('right')),
        smallButton('⤒ Top', () => alignSelection('top')),
        smallButton('⇳ Middle', () => alignSelection('vcenter')),
        smallButton('⤓ Bottom', () => alignSelection('bottom')),
      );
      arr.appendChild(aRow);
    }
    panel.appendChild(arr);
  }
}

// ---- file operations ----

const TAURI = window.__TAURI__;
let currentFile = null; // Tauri: path string · browser: FileSystemFileHandle

function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

const FILE_FILTER = [{ name: 'Master Schemer', extensions: ['json'] }];

async function saveJSON(saveAs = false) {
  const text = JSON.stringify(state.doc, null, 1);
  try {
    if (TAURI) {
      let path = !saveAs && typeof currentFile === 'string' ? currentFile : null;
      if (!path) {
        path = await TAURI.dialog.save({ defaultPath: 'scheme.schemer.json', filters: FILE_FILTER });
        if (!path) return;
      }
      await TAURI.fs.writeTextFile(path, text);
      currentFile = path;
    } else if (window.showSaveFilePicker) {
      let handle = !saveAs && currentFile ? currentFile : null;
      if (!handle) {
        handle = await window.showSaveFilePicker({
          suggestedName: 'scheme.schemer.json',
          types: [{ description: 'Master Schemer', accept: { 'application/json': ['.schemer.json', '.json'] } }],
        });
      }
      const w = await handle.createWritable();
      await w.write(text);
      await w.close();
      currentFile = handle;
    } else {
      download('scheme.schemer.json', text, 'application/json');
    }
    $('hint').textContent = 'Saved.';
  } catch (err) {
    if (err?.name !== 'AbortError') $('hint').textContent = `Save failed: ${err.message || err}`;
  }
}

async function openFile() {
  try {
    if (TAURI) {
      const path = await TAURI.dialog.open({ multiple: false, filters: FILE_FILTER });
      if (!path) return;
      loadDocJSON(await TAURI.fs.readTextFile(path));
      currentFile = path;
      fitView();
    } else {
      $('fileInput').click();
    }
  } catch (err) {
    $('hint').textContent = `Could not open file: ${err.message || err}`;
  }
}

async function exportSVG() {
  state.selection = [];
  refresh();
  const text = exportSVGString();
  if (!text) { $('hint').textContent = 'Nothing to export yet — the canvas is empty.'; return; }
  try {
    if (TAURI) {
      const path = await TAURI.dialog.save({
        defaultPath: 'scheme.svg', filters: [{ name: 'SVG image', extensions: ['svg'] }],
      });
      if (!path) return;
      await TAURI.fs.writeTextFile(path, text);
      $('hint').textContent = 'SVG exported.';
    } else {
      download('scheme.svg', text, 'image/svg+xml');
    }
  } catch (err) {
    $('hint').textContent = `Export failed: ${err.message || err}`;
  }
}

// ---- CSV export (objects + their hidden data; selection scopes it) ----

const csvEscape = v => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function csvText() {
  const selIds = new Set();
  for (const s of state.selection) {
    if (s.seg !== undefined) continue;
    const el = byId(s.id);
    if (!el) continue;
    selIds.add(el.id);
    // a selected card exports everything on it
    if (el.type === 'card') for (const c of cardContents(el)) selIds.add(c.id);
  }
  const els = selIds.size
    ? state.doc.elements.filter(el => selIds.has(el.id))
    : state.doc.elements;
  const cards = state.doc.elements.filter(el => el.type === 'card');
  const cardOf = el =>
    el.type === 'card' ? '' : (cards.find(c => cardContents(c).includes(el))?.title || '');
  const groupName = el => state.doc.groups.find(g => g.id === el.group)?.name || '';
  const rows = [['id', 'type', 'name', 'group', 'card', 'color', 'width', 'notes']];
  for (const el of els) {
    const name = el.type === 'card' ? (el.title || '')
      : resolveLabel(el.label || '') || (el.type === 'text' ? el.text : '');
    rows.push([el.id, el.type, name, groupName(el), cardOf(el),
      el.color !== undefined ? resolveColor(el.color) : '', el.width ?? '', el.notes || '']);
    (el.segments || []).forEach((seg, i) => {
      rows.push([`${el.id}.s${i + 1}`, 'segment', resolveLabel(seg.label || ''),
        groupName(el), cardOf(el), resolveColor(seg.color), '', seg.notes || '']);
    });
  }
  return rows.map(r => r.map(csvEscape).join(',')).join('\n');
}

async function exportCSV() {
  if (!state.doc.elements.length) {
    $('hint').textContent = 'Nothing to export yet — the canvas is empty.';
    return;
  }
  const text = csvText();
  try {
    if (TAURI) {
      const path = await TAURI.dialog.save({
        defaultPath: 'scheme.csv', filters: [{ name: 'CSV', extensions: ['csv'] }],
      });
      if (!path) return;
      await TAURI.fs.writeTextFile(path, text);
      $('hint').textContent = 'CSV exported.';
    } else {
      download('scheme.csv', text, 'text/csv');
    }
  } catch (err) {
    $('hint').textContent = `Export failed: ${err.message || err}`;
  }
}

$('newBtn').addEventListener('click', () => {
  if (!state.doc.elements.length || confirm('Replace the current scheme with a blank canvas? (Undo can bring it back.)')) {
    newDoc();
    currentFile = null;
  }
});
$('openBtn').addEventListener('click', openFile);
$('fileInput').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try { loadDocJSON(await file.text()); currentFile = null; fitView(); }
  catch { $('hint').textContent = `Could not read ${file.name} — not a Master Schemer file.`; }
});
$('libInput').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try { mergeLibraryJSON(await file.text()); }
  catch { $('hint').textContent = `Could not read ${file.name} — not a library file.`; }
});
$('saveBtn').addEventListener('click', () => saveJSON(false));
$('saveAsBtn').addEventListener('click', () => saveJSON(true));
$('exportBtn').addEventListener('click', exportSVG);
$('csvBtn').addEventListener('click', exportCSV);
$('undoBtn').addEventListener('click', undo);
$('redoBtn').addEventListener('click', redo);

window.addEventListener('resize', render);

// ---- boot ----

restoreAutosave();
setTool('select');
refresh();
if (state.doc.elements.length) fitView();
else { state.view.tx = 80; state.view.ty = 80; refresh(); }
