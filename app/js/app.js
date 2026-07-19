// App shell: event routing, sidebar, panel, keyboard, view controls, file ops.
import {
  state, COLORS, setOnChanged, beginChange, changed, undo, redo, newId,
  deleteSelection, selectionSingle, byId, newDoc, loadDocJSON, restoreAutosave,
  isSemantic, resolveColor, reorder,
} from './model.js';
import { GRID, mergePaths } from './geom.js';
import { render, screenToWorld, contentBBox, exportSVGString, CAPS } from './render.js';
import { tools, cancelActive, isDragging, cardContents } from './tools.js';

const $ = id => document.getElementById(id);
const svg = $('canvas');
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// ---- refresh pipeline ----

function refresh() {
  render();
  renderPanel();
  renderSidebar();
  $('undoBtn').disabled = !state.history.length;
  $('redoBtn').disabled = !state.future.length;
  $('zoomLabel').textContent = `${Math.round(state.view.s * 100)}%`;
}
setOnChanged(refresh);

// ---- tool switching ----

const TOOL_KEYS = {
  v: 'select', l: 'path', s: 'segment', e: 'edit', c: 'card', a: 'arrow',
  d: 'draw', t: 'text', o: 'ellipse', n: 'aline', r: 'aarrow', h: 'hand',
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
        else if (el.cx !== undefined) { el.cx += dx; el.cy += dy; }
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

// ---- object sidebar (semantic registry) ----

function displayName(el, i) {
  if (el.type === 'card') return el.title || 'Untitled card';
  if (el.type === 'text') return el.label || el.text.split('\n')[0].slice(0, 24) || 'note';
  const names = { path: 'line', ink: 'freehand', ellipse: 'ellipse', aline: 'line note', aarrow: 'arrow' };
  return el.label || `${names[el.type] || el.type} ${i + 1}`;
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
      depth, name: seg.label || `segment ${i + 1}`, color: resolveColor(seg.color),
      selected: state.selection.some(s => s.id === el.id && s.seg === i),
      onSelect: () => { state.selection = [{ id: el.id, seg: i }]; refresh(); },
      onRename: v => { seg.label = v; },
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
      onRename: v => { el.label = v; },
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

  for (const card of cards) {
    body.appendChild(sideItem({
      depth: 0, name: displayName(card), color: null,
      selected: state.selection.some(s => s.id === card.id),
      onSelect: () => { state.selection = [{ id: card.id }]; refresh(); },
      onRename: v => { card.title = v; },
    })).classList.add('side-card');
    const inside = cardContents(card).filter(el => tracked.includes(el));
    inside.forEach(el => placed.add(el.id));
    objectItems(inside, 1, body);
  }
  const loose = tracked.filter(el => !placed.has(el.id));
  if (loose.length && cards.length) {
    const h = document.createElement('div');
    h.className = 'side-group';
    h.textContent = 'Canvas';
    body.appendChild(h);
  }
  objectItems(loose, cards.length ? 1 : 0, body);
  if (!cards.length && !tracked.length) {
    const p = document.createElement('p');
    p.className = 'muted side-empty';
    p.textContent = 'Objects you draw with the model tools appear here. Promote an annotation to track it too.';
    body.appendChild(p);
  }
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

  const pick = document.createElement('input');
  pick.type = 'color';
  pick.className = 'color-pick';
  const cur = resolveColor(currentColor());
  pick.value = /^#[0-9a-f]{6}$/i.test(cur) ? cur : '#2b2622';
  let picked = false;
  pick.addEventListener('input', () => {
    // live-preview while the native picker is open; one history entry
    if (!picked) { beginChange(); picked = true; }
    state.color = pick.value;
    for (const t of colorTargets()) t.color = pick.value;
    render();
  });
  pick.addEventListener('change', () => { picked = false; changed(); });
  sec.appendChild(fieldRow('Custom color', pick));

  // memory slots: elements store slot:<id>, so editing a slot recolors them all
  const slotsWrap = document.createElement('div');
  slotsWrap.className = 'swatches';
  for (const slot of state.doc.palette) {
    const b = document.createElement('button');
    b.className = 'swatch slot';
    b.style.background = slot.color;
    b.title = `${slot.name || 'slot'} — click to apply, click again to edit`;
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
    const cInput = document.createElement('input');
    cInput.type = 'color';
    cInput.value = slot.color;
    let editing = false;
    cInput.addEventListener('input', () => {
      if (!editing) { beginChange(); editing = true; }
      slot.color = cInput.value;
      render(); // every element referencing this slot recolors live
    });
    cInput.addEventListener('change', () => { editing = false; changed(); });
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
    ed.append(fieldRow('Slot color', cInput), fieldRow('Slot name', nInput), del);
    sec.appendChild(ed);
  }
  return sec;
}

function widthControl(get, set, touchesDoc) {
  const node = document.createElement('input');
  node.type = 'range';
  node.min = 1; node.max = GRID; node.step = 0.5; // GRID-wide strokes tile the lattice
  node.value = get();
  let editing = false;
  node.addEventListener('input', () => {
    if (touchesDoc && !editing) { beginChange(); editing = true; }
    set(+node.value);
    if (touchesDoc) render();
  });
  node.addEventListener('change', () => {
    if (editing) { editing = false; changed(); }
  });
  return node;
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

function joinSelectedPaths() {
  const els = state.selection.filter(s => s.seg === undefined).map(s => byId(s.id));
  if (els.length !== 2 || els.some(el => el?.type !== 'path')) return null;
  const [a, b] = els;
  return mergePaths(a.pts, a.segments || [], b.pts, b.segments || []) && { a, b };
}

function renderPanel() {
  const panel = $('panelBody');
  // don't rebuild under the user's cursor while they type or drag a slider
  const ae = document.activeElement;
  if (panel.contains(ae) &&
      (ae.tagName === 'TEXTAREA' || (ae.tagName === 'INPUT' && ae.type !== 'color'))) return;
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
  if (single && ['path', 'aline', 'ellipse', 'ink'].includes(single.el.type) && single.seg === undefined) {
    const el = single.el;
    styleSec.appendChild(fieldRow('Line style', selectControl(
      ['solid', 'dashed', 'dotted'], () => el.dash || 'solid', v => { el.dash = v; })));
    if (el.type === 'path' || el.type === 'aline') {
      styleSec.appendChild(fieldRow('Start cap', selectControl(
        CAPS, () => el.cap0 || 'none', v => { el.cap0 = v; })));
      styleSec.appendChild(fieldRow('End cap', selectControl(
        CAPS, () => el.cap1 || 'none', v => { el.cap1 = v; })));
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
    const join = joinSelectedPaths();
    if (join) {
      sec.appendChild(smallButton('Join lines', () => {
        const merged = mergePaths(join.a.pts, join.a.segments || [], join.b.pts, join.b.segments || []);
        beginChange();
        join.a.pts = merged.pts;
        join.a.segments = merged.segments;
        state.doc.elements = state.doc.elements.filter(el => el !== join.b);
        state.selection = [{ id: join.a.id }];
        changed();
      }, 'Fuse two lines whose ends meet on the same grid point'));
    }
    sec.appendChild(deleteButton('Delete selection'));
  } else if (single.seg !== undefined) {
    const el = single.el, seg = el.segments[single.seg];
    sec.appendChild(sectionTitle('Segment'));
    sec.appendChild(fieldRow('Label', boundInput(
      () => seg.label, v => { seg.label = v; }, { placeholder: 'e.g. domain a' })));
    sec.appendChild(fieldRow('Data (not displayed)', boundInput(
      () => seg.notes || '', v => { seg.notes = v; }, { textarea: true, placeholder: 'notes, metadata…' })));
    sec.appendChild(deleteButton('Delete segment'));
  } else {
    const el = single.el;
    const titles = {
      path: 'Line', card: 'Card', arrow: 'Connection', text: 'Note',
      ink: 'Freehand', ellipse: 'Ellipse', aline: 'Line note', aarrow: 'Arrow note',
    };
    sec.appendChild(sectionTitle(titles[el.type] || el.type));
    if (el.type === 'card') {
      sec.appendChild(fieldRow('Title', boundInput(
        () => el.title, v => { el.title = v; }, { placeholder: 'section title' })));
    } else if (el.type !== 'text' || isSemantic(el)) {
      sec.appendChild(fieldRow('Label', boundInput(
        () => el.label || '', v => { el.label = v; }, { placeholder: 'name this object' })));
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
    sec.appendChild(fieldRow('Data (not displayed)', boundInput(
      () => el.notes || '', v => { el.notes = v; }, { textarea: true, placeholder: 'notes, metadata…' })));
    if (!isSemantic(el)) {
      sec.appendChild(smallButton('Promote to object', () => {
        beginChange();
        el.semantic = true;
        changed();
      }, 'Track this annotation in the object list'));
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

  // z-order controls for any element selection
  if (n && state.selection.some(s => s.seg === undefined)) {
    const arr = document.createElement('div');
    arr.className = 'panel-section';
    arr.appendChild(sectionTitle('Arrange'));
    const row = document.createElement('div');
    row.className = 'btn-row';
    row.append(
      smallButton('Front', () => reorder('front')),
      smallButton('Raise', () => reorder('up')),
      smallButton('Lower', () => reorder('down')),
      smallButton('Back', () => reorder('back')),
    );
    arr.appendChild(row);
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
$('saveBtn').addEventListener('click', () => saveJSON(false));
$('saveAsBtn').addEventListener('click', () => saveJSON(true));
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
