// App shell: event routing, sidebar, panel, keyboard, view controls, file ops.
import {
  state, COLORS, setOnChanged, beginChange, changed, touch, undo, redo, newId, addElement,
  deleteSelection, selectionSingle, byId, newDoc, loadDocJSON,
  isSemantic, resolveColor, resolveLabel, reorder, pruneGroups,
  byGroup, childGroups, topLevelGroups, groupElementMembers,
} from './model.js';
import { GRID, mergePaths, rot90, flipPt, snapHalf } from './geom.js';
import {
  render, screenToWorld, contentBBox, elementBBox, exportSVGString, CAPS, PATTERNS, dataView,
} from './render.js';
import { tools, cancelActive, isDragging, cardContents } from './tools.js';

const $ = id => document.getElementById(id);
const svg = $('canvas');
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// Brief floating acknowledgement (e.g. after a save), fades on its own.
let toastTimer = null;
function toast(msg) {
  let el = $('toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; document.body.appendChild(el); }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 1600);
}

// ---- refresh pipeline ----

function refresh() {
  render();
  // panels are DOM-heavy; while a drag is live only the canvas needs frames
  if (!isDragging()) {
    renderPanel();
    renderSidebar();
    if (slotModal) renderSlotModal(); // popup lives outside the panel; keep it live too
  }
  $('undoBtn').disabled = !state.history.length;
  $('redoBtn').disabled = !state.future.length;
  $('zoomLabel').textContent = `${Math.round(state.view.s * 100)}%`;
  syncNoteRefs(); // a renamed object updates its live chips in the notes
}
setOnChanged(refresh);

// ---- tool switching ----

const TOOL_KEYS = {
  v: 'select', l: 'path', s: 'segment', e: 'edit', c: 'card', a: 'arrow', x: 'cut',
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
  if (dataView.hover && !dataView.show && !isDragging()) {
    const id = e.target.closest?.('[data-id]')?.getAttribute('data-id') || null;
    if (id !== dataView.hoverId) { dataView.hoverId = id; render(); }
  }
  // dragging a selection out over the notes panel to drop a reference: freeze
  // the object-move so it doesn't chase the cursor off-canvas (rolled back on up)
  if (state.tool === 'select' && isDragging() && overNotesPanel(e)) return;
  tools[state.tool]?.move?.(e, wp, sp);
});

// True when the pointer is over the notes panel (used to route a canvas drag
// into a notes reference instead of an object move).
const overNotesPanel = e =>
  !!document.elementFromPoint(e.clientX, e.clientY)?.closest?.('#notesPanel');

svg.addEventListener('pointerup', e => {
  if (panning) {
    panning = null;
    document.body.classList.remove('panning');
    return;
  }
  // released over the notes panel mid-drag: convert the selection to note refs
  // instead of moving it (undo the tracking move first)
  if (state.tool === 'select' && isDragging() && state.selection.length && overNotesPanel(e)) {
    cancelActive();
    addSelectionToNotes(e.clientX, e.clientY);
    return;
  }
  tools[state.tool]?.up?.(e, screenToWorld(eventScreen(e)));
});

svg.addEventListener('dblclick', e => {
  if (state.tool === 'select') tools.select.dbl(e);
});

// Drop a library asset onto the canvas at the cursor.
svg.addEventListener('dragover', e => {
  if (e.dataTransfer.types.includes('text/asset-id')) e.preventDefault();
});
svg.addEventListener('drop', e => {
  const id = e.dataTransfer.getData('text/asset-id');
  if (!id) return;
  e.preventDefault();
  const asset = library.find(a => a.id === id);
  if (asset) placeAsset(asset, screenToWorld(eventScreen(e)));
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

// ---- groups (hierarchical: a group can contain groups) ----

// Groups whose every element member is in the current selection — these can be
// nested wholesale rather than having their members pulled out individually.
function whollySelectedGroups() {
  const selIds = new Set(selectedElements().map(e => e.id));
  return new Set(state.doc.groups
    .filter(g => {
      const m = groupElementMembers(g.id);
      return m.length && m.every(x => selIds.has(x.id));
    })
    .map(g => g.id));
}

function groupSelection() {
  const els = selectedElements();
  if (els.length < 2) return;
  beginChange();
  const G = { id: newId(), name: `group ${state.doc.groups.length + 1}` };
  state.doc.groups.push(G);
  const wholly = whollySelectedGroups();
  // nest the topmost wholly-selected groups under G; leave their innards intact
  for (const gid of wholly) {
    const g = byGroup(gid);
    if (!g.parent || !wholly.has(g.parent)) g.parent = G.id;
  }
  // loose elements (and elements pulled from partially-selected groups) join G
  for (const el of els) if (!el.group || !wholly.has(el.group)) el.group = G.id;
  pruneGroups();
  changed();
}

function ungroupSelection() {
  const wholly = whollySelectedGroups();
  // dissolve only the topmost fully-selected groups; each releases into its
  // child groups and direct elements, promoted to the dissolved group's parent
  const tops = [...wholly].filter(gid => {
    const g = byGroup(gid);
    return !g.parent || !wholly.has(g.parent);
  });
  if (!tops.length) return;
  beginChange();
  for (const gid of tops) {
    const parent = byGroup(gid).parent;
    for (const el of state.doc.elements) {
      if (el.group !== gid) continue;
      if (parent) el.group = parent; else delete el.group;
    }
    for (const cg of childGroups(gid)) {
      if (parent) cg.parent = parent; else delete cg.parent;
    }
    state.doc.groups = state.doc.groups.filter(x => x.id !== gid);
  }
  pruneGroups();
  changed();
}

// Pull a single element out of its immediate group (up to the parent level).
function removeFromGroup(el) {
  beginChange();
  const parent = byGroup(el.group)?.parent;
  if (parent) el.group = parent; else delete el.group;
  pruneGroups();
  changed();
}

// ---- links (filled area between two objects/segments/groups) ----

// The two endpoints for a link, drawn from the current selection: either two
// explicitly selected entries, or elements that span exactly two groups.
function linkTargetsFromSelection() {
  const entries = state.selection;
  if (entries.length === 2) {
    return entries.map(s => (s.seg !== undefined ? { id: s.id, seg: s.seg } : { id: s.id }));
  }
  const groups = [...new Set(entries.map(s => byId(s.id)?.group).filter(Boolean))];
  if (groups.length === 2 && entries.length && entries.every(s => byId(s.id)?.group)) {
    return groups.map(g => ({ group: g }));
  }
  return null;
}

// Identity of a link endpoint, so we can spot a link that already spans the
// same two targets (in either order).
const linkKey = t => (t.group ? `g:${t.group}` : `e:${t.id}${t.seg !== undefined ? `.${t.seg}` : ''}`);
function findLink(a, b) {
  const ka = linkKey(a), kb = linkKey(b);
  return state.doc.elements.find(el => el.type === 'link' &&
    ((linkKey(el.a) === ka && linkKey(el.b) === kb) ||
     (linkKey(el.a) === kb && linkKey(el.b) === ka)));
}

function createLink(targets) {
  if (findLink(targets[0], targets[1])) return; // never stack a second link on the same pair
  beginChange();
  const el = addElement({
    type: 'link', a: targets[0], b: targets[1],
    fill: resolveColor(currentColor()) || '#8a857c', opacity: 0.45,
  });
  state.selection = [{ id: el.id }];
  changed();
}

// ---- keyboard ----

window.addEventListener('keydown', e => {
  const t = e.target;
  if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return;
  if (t instanceof HTMLElement && t.isContentEditable) return; // notes editor owns its keys
  if (e.key === ' ') { spaceHeld = true; document.body.classList.add('panning'); e.preventDefault(); return; }
  if ((e.ctrlKey || e.metaKey)) {
    const k = e.key.toLowerCase();
    if (k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if (k === 'y') { e.preventDefault(); redo(); }
    else if (k === 's') { e.preventDefault(); saveJSON(e.shiftKey); }
    else if (k === 'c') { e.preventDefault(); copySelection(); }
    else if (k === 'v') { e.preventDefault(); pasteClipboard(); }
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

// A shared label can be bound to a memory colour slot: every element or segment
// carrying the label then paints from that slot, colour and pattern alike. This
// repaints all current users; new ones pick it up as they attach to the label.
function applyLabelColorSlot(labelSlot) {
  if (!labelSlot?.colorSlot) return;
  const labelRef = `slot:${labelSlot.id}`, colorRef = `slot:${labelSlot.colorSlot}`;
  for (const el of state.doc.elements) {
    if (el.label === labelRef && el.color !== undefined) el.color = colorRef;
    for (const seg of el.segments || []) if (seg.label === labelRef) seg.color = colorRef;
  }
  const paletteSlot = state.doc.palette.find(s => s.id === labelSlot.colorSlot);
  if (paletteSlot) propagateSlot(paletteSlot); // push its pattern onto the new users
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

// A line's domain string: its segments' `string` fields concatenated in path
// order. Derived (never stored), so it always reflects the current segments.
const domainString = el => (el.segments || [])
  .slice().sort((a, b) => a.t0 - b.t0).map(s => s.string || '').join('');

// Inline rename on double-click; single click selects.
function sideItem({ depth, name, color, selected, onSelect, onRename, collapsible, collapsed, onToggle, dragRef }) {
  const row = document.createElement('div');
  row.className = 'side-item';
  row.style.paddingLeft = `${8 + depth * 14}px`;
  if (selected) row.setAttribute('aria-current', 'true');
  // draggable into the notes panel: drops a live reference to this object/group
  if (dragRef) {
    row.draggable = true;
    row.addEventListener('dragstart', e => {
      e.dataTransfer.setData('text/scheme-ref', JSON.stringify(dragRef));
      e.dataTransfer.setData('text/plain', name);
      e.dataTransfer.effectAllowed = 'copy';
    });
  }
  // caret column: a toggle for parents, an empty spacer for leaves (keeps labels aligned)
  const caret = document.createElement('span');
  caret.className = 'side-caret';
  if (collapsible) {
    caret.classList.add('is-toggle');
    caret.textContent = collapsed ? '▸' : '▾';
    caret.addEventListener('click', e => { e.stopPropagation(); onToggle(); });
  }
  row.appendChild(caret);
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
  if (!onRename) {
    row.addEventListener('click', onSelect);
    return row;
  }
  // Renamable rows defer the select by one click-interval: a synchronous select
  // rebuilds the sidebar and destroys this node, so the browser never sees the
  // second click as a dblclick. Deferring keeps the node alive long enough.
  row.title = 'Double-click to rename';
  const startRename = () => {
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
  };
  let clickTimer = null;
  row.addEventListener('click', () => {
    if (clickTimer) return; // the second click of a double-click; let dblclick win
    clickTimer = setTimeout(() => { clickTimer = null; onSelect(); }, 220);
  });
  row.addEventListener('dblclick', () => {
    clearTimeout(clickTimer); clickTimer = null;
    startRename();
  });
  return row;
}

// Which sidebar parents are collapsed (persisted, keyed g:/c:/p:<id>).
let sideCollapsed = new Set();
try { sideCollapsed = new Set(JSON.parse(localStorage.getItem('master-schemer-collapsed') || '[]')); }
catch { sideCollapsed = new Set(); }
function toggleCollapse(key) {
  if (sideCollapsed.has(key)) sideCollapsed.delete(key); else sideCollapsed.add(key);
  try { localStorage.setItem('master-schemer-collapsed', JSON.stringify([...sideCollapsed])); } catch { /* full */ }
  renderSidebar();
}

// Append a parent row; return a child container to fill (null when it has no
// children or is collapsed, so callers just skip rendering the subtree).
function parentNode(into, key, opts, hasChildren) {
  if (!hasChildren) { const row = sideItem(opts); into.appendChild(row); return { row, box: null }; }
  const collapsed = sideCollapsed.has(key);
  const row = sideItem({ ...opts, collapsible: true, collapsed, onToggle: () => toggleCollapse(key) });
  into.appendChild(row);
  if (collapsed) return { row, box: null };
  const box = document.createElement('div');
  box.className = 'side-children';
  into.appendChild(box);
  return { row, box };
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
    const opts = {
      depth, name: displayName(el, i),
      color: el.color !== undefined ? resolveColor(el.color) : null,
      selected: state.selection.some(s => s.id === el.id && s.seg === undefined),
      onSelect: () => { state.selection = [{ id: el.id }]; refresh(); },
      onRename: v => { setLabel(el, v); },
      dragRef: { kind: 'el', id: el.id },
    };
    const segs = el.type === 'path' && (el.segments || []).length;
    const { box } = parentNode(into, `p:${el.id}`, opts, segs);
    if (box) segItems(el, depth + 1, box);
  });
}

// One group node and everything beneath it (child groups first, then the
// group's own direct elements), recursing to any depth.
function renderGroupTree(gid, depth, into, placed) {
  const g = byGroup(gid);
  const members = groupElementMembers(gid);
  members.forEach(m => placed.add(m.id)); // claim the whole subtree even when collapsed
  const direct = state.doc.elements.filter(el => el.group === gid);
  const { row, box } = parentNode(into, `g:${gid}`, {
    depth, name: g.name || 'group', color: null,
    selected: members.length > 0 &&
      members.every(m => state.selection.some(s => s.id === m.id && s.seg === undefined)),
    onSelect: () => { state.selection = members.map(m => ({ id: m.id })); refresh(); },
    onRename: v => { g.name = v; },
    dragRef: { kind: 'grp', id: gid },
  }, childGroups(gid).length || direct.length);
  row.classList.add('side-card');
  if (!box) return;
  for (const cg of childGroups(gid)) renderGroupTree(cg.id, depth + 1, box, placed);
  objectItems(direct, depth + 1, box);
}

function renderSidebar() {
  const body = $('sidebarBody');
  if (body.contains(document.activeElement)) return; // mid-rename
  body.replaceChildren();
  const els = state.doc.elements;
  const cards = els.filter(el => el.type === 'card');
  const tracked = els.filter(el => el.type !== 'card' && el.type !== 'arrow' && isSemantic(el));
  const placed = new Set();

  // A top-level group nests under a card when every one of its members lives on
  // that card; a group straddling the card border stays at canvas top level.
  const cardOfGroup = g => {
    const m = groupElementMembers(g.id);
    if (!m.length) return null;
    return cards.find(c => { const inside = cardContents(c); return m.every(x => inside.includes(x)); }) || null;
  };
  const groupsByCard = new Map();
  const looseGroups = [];
  for (const g of topLevelGroups()) {
    const c = cardOfGroup(g);
    if (c) { const arr = groupsByCard.get(c.id) || []; arr.push(g); groupsByCard.set(c.id, arr); }
    else looseGroups.push(g);
  }

  // top-level groups not tied to a card: the explicit hierarchy, nested to any depth
  for (const g of looseGroups) renderGroupTree(g.id, 0, body, placed);

  for (const card of cards) {
    if (placed.has(card.id)) continue;
    const groupsHere = groupsByCard.get(card.id) || [];
    for (const g of groupsHere) groupElementMembers(g.id).forEach(m => placed.add(m.id));
    const inside = cardContents(card).filter(el => tracked.includes(el) && !placed.has(el.id));
    inside.forEach(el => placed.add(el.id)); // claim before the collapse check, so collapsing hides them
    const { row, box } = parentNode(body, `c:${card.id}`, {
      depth: 0, name: displayName(card), color: null,
      selected: state.selection.some(s => s.id === card.id),
      onSelect: () => { state.selection = [{ id: card.id }]; refresh(); },
      onRename: v => { card.title = v; },
      dragRef: { kind: 'el', id: card.id },
    }, groupsHere.length + inside.length);
    row.classList.add('side-card');
    if (box) {
      for (const g of groupsHere) renderGroupTree(g.id, 1, box, placed);
      objectItems(inside, 1, box);
    }
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

// One-time starter assets: glowing fluorophore dots. Seeded once (tracked by a
// flag) so deleting them sticks and they don't reappear on reload.
const fluorAsset = (color, name) => ({
  id: newId(), name,
  elements: [{ type: 'ellipse', id: newId(), cx: 0, cy: 0, rx: 16, ry: 16, glow: true, fill: color, color, width: 0 }],
  groups: [],
});
try {
  const SEED_KEY = 'master-schemer-lib-seeded';
  if (!localStorage.getItem(SEED_KEY)) {
    library.unshift(fluorAsset('#2fd15a', 'fluorophore (green)'), fluorAsset('#ff3b3b', 'fluorophore (red)'));
    localStorage.setItem(SEED_KEY, '1');
    saveLibrary();
  }
} catch { /* storage blocked — skip seeding */ }

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

// Deep-copy a set of elements + their groups into the doc with fresh ids,
// remapping internal arrow/link/group references. `positioner(solidEls)` (run
// after they land, so link bboxes resolve) places the copies. Caller wraps this
// in beginChange(). Selects the placed non-arrow elements.
function insertElements(srcElements, srcGroups, positioner) {
  const els = JSON.parse(JSON.stringify(srcElements));
  const idMap = new Map();
  for (const el of els) { const nid = newId(); idMap.set(el.id, nid); el.id = nid; }
  const groupMap = new Map();
  for (const g of srcGroups || []) {
    const ng = { id: newId(), name: g.name };
    state.doc.groups.push(ng);
    groupMap.set(g.id, ng.id);
  }
  const placed = els.filter(el => {
    if (el.group) el.group = groupMap.get(el.group);
    if (!el.group) delete el.group;
    if (el.type === 'arrow') {
      if (!idMap.has(el.from) || !idMap.has(el.to)) return false;
      el.from = idMap.get(el.from);
      el.to = idMap.get(el.to);
    } else if (el.type === 'link') {
      // keep only if both endpoints came along; remap element refs, drop group refs
      if (el.a?.id && !idMap.has(el.a.id)) return false;
      if (el.b?.id && !idMap.has(el.b.id)) return false;
      if (el.a?.id) el.a = { ...el.a, id: idMap.get(el.a.id) };
      if (el.b?.id) el.b = { ...el.b, id: idMap.get(el.b.id) };
    }
    return true;
  });
  state.doc.elements.push(...placed);
  const solid = placed.filter(el => el.type !== 'arrow');
  positioner(solid);
  pruneGroups();
  state.selection = solid.map(el => ({ id: el.id }));
  changed();
}

function placeAsset(asset, atWorld) {
  beginChange();
  insertElements(asset.elements, asset.groups, solid => {
    const box = combinedBBox(solid);
    if (box) {
      const c = atWorld || screenToWorld([svg.clientWidth / 2, svg.clientHeight / 2]);
      const dx = snapHalf(c[0] - (box[0] + box[2]) / 2);
      const dy = snapHalf(c[1] - (box[1] + box[3]) / 2);
      for (const el of solid) shiftEl(el, dx, dy);
    }
  });
}

// ---- clipboard (copy/paste within the doc, keeps palette/label slot refs) ----

let clipboard = null;
let pasteCount = 0;

function copySelection() {
  const ids = new Set();
  for (const s of state.selection) {
    if (s.seg !== undefined) continue;
    const el = byId(s.id);
    if (!el) continue;
    ids.add(el.id);
    if (el.type === 'card') for (const c of cardContents(el)) ids.add(c.id);
    if (el.group) for (const m of state.doc.elements) if (m.group === el.group) ids.add(m.id);
  }
  if (!ids.size) { $('hint').textContent = 'Select something first, then copy it.'; return; }
  const els = state.doc.elements.filter(el => ids.has(el.id))
    .map(el => JSON.parse(JSON.stringify(el)));
  const groups = state.doc.groups.filter(g => els.some(el => el.group === g.id)).map(g => ({ ...g }));
  clipboard = { elements: els, groups };
  pasteCount = 0;
  $('hint').textContent = `Copied ${els.length} object${els.length === 1 ? '' : 's'}.`;
}

function pasteClipboard() {
  if (!clipboard) return;
  beginChange();
  const off = GRID * ++pasteCount; // each paste steps further so copies don't stack
  insertElements(clipboard.elements, clipboard.groups, solid => {
    for (const el of solid) shiftEl(el, off, off);
  });
  $('hint').textContent = 'Pasted.';
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

// Tiny geometry-only preview of an asset's shapes (no text/link glyphs, flat
// fills — glows show as a solid dot). Scaled to fit a fixed thumbnail box.
const SVGNS = 'http://www.w3.org/2000/svg';
function assetThumbnail(asset) {
  const svgt = document.createElementNS(SVGNS, 'svg');
  svgt.setAttribute('class', 'lib-thumb');
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const acc = (x, y) => { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; };
  const mk = attrs => { const n = document.createElementNS(SVGNS, attrs.tag); for (const k in attrs) if (k !== 'tag') n.setAttribute(k, attrs[k]); svgt.appendChild(n); };
  for (const el of asset.elements) {
    const stroke = el.color || '#55504a', sw = el.width || 2;
    if (el.type === 'ellipse') {
      acc(el.cx - el.rx, el.cy - el.ry); acc(el.cx + el.rx, el.cy + el.ry);
      mk({ tag: 'ellipse', cx: el.cx, cy: el.cy, rx: el.rx, ry: el.ry,
        fill: el.glow ? (el.fill || stroke) : (el.fill || 'none'), stroke: el.glow ? 'none' : stroke, 'stroke-width': sw });
    } else if (el.type === 'rect' || el.type === 'card') {
      acc(el.x, el.y); acc(el.x + el.w, el.y + el.h);
      mk({ tag: 'rect', x: el.x, y: el.y, width: el.w, height: el.h, rx: el.r || 0,
        fill: el.type === 'card' ? (el.fill || '#ffffff') : (el.fill || 'none'), stroke, 'stroke-width': sw });
    } else if (Array.isArray(el.pts) && el.pts.length) {
      for (const p of el.pts) acc(p[0], p[1]);
      mk({ tag: 'polyline', points: el.pts.map(p => p.join(',')).join(' '), fill: 'none', stroke, 'stroke-width': sw });
    }
  }
  if (!isFinite(x0)) { x0 = 0; y0 = 0; x1 = 1; y1 = 1; }
  const pad = Math.max(4, (x1 - x0 + y1 - y0) * 0.08);
  svgt.setAttribute('viewBox', `${x0 - pad} ${y0 - pad} ${x1 - x0 + 2 * pad} ${y1 - y0 + 2 * pad}`);
  return svgt;
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
    row.insertBefore(assetThumbnail(asset), row.querySelector('.side-name'));
    row.draggable = true;
    row.addEventListener('dragstart', e => e.dataTransfer.setData('text/asset-id', asset.id));
    row.title = 'Click or drag onto the canvas to place · double-click to rename';
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

// Apply a colour to the selection. When `slot` carries a pattern combo, the
// slot's pattern (+bg/scale) is applied too, so a slot can be a remembered
// colour+pattern preset. A slot with no pattern leaves the target's pattern be.
function applyColor(c, slot) {
  state.color = c;
  const targets = colorTargets();
  if (targets.length) {
    beginChange();
    for (const t of targets) {
      t.color = c;
      if (slot && slot.pattern) {
        t.pattern = slot.pattern;
        if (slot.patternBg) t.patternBg = slot.patternBg; else delete t.patternBg;
        if (slot.patternScale != null) t.patternScale = slot.patternScale; else delete t.patternScale;
      }
    }
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
    const k = (n + h / 60) % 6;
    const c = v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
    return Math.round(c * 255).toString(16).padStart(2, '0');
  };
  return `#${f(5)}${f(3)}${f(1)}`;
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

function colorPicker(key, getHex, applyLive, commit, rerender = renderPanel) {
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
    rerender();
  });
  // well + eyedropper share a row; the eye is offered only where the platform
  // supports the native EyeDropper API (Chromium/Edge, incl. the web build).
  const head = document.createElement('div');
  head.className = 'picker-head';
  head.appendChild(well);
  if (window.EyeDropper) {
    const eye = document.createElement('button');
    eye.type = 'button';
    eye.className = 'picker-eye';
    eye.textContent = '🎯';
    eye.title = 'Pick a colour from anywhere on screen';
    eye.addEventListener('click', () => {
      new window.EyeDropper().open()
        .then(res => { applyLive.begin?.(); applyLive(res.sRGBHex); commit(); rerender(); })
        .catch(() => {}); // user pressed Escape
    });
    head.appendChild(eye);
  }
  wrap.appendChild(head);
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

let activeSlot = null;  // palette slot id currently selected (target of Apply / Edit)
let slotModal = null;   // { id } while the slot-editor popup is open

// Push a slot's pattern (kind/bg/scale) onto every object that references the
// slot for its colour or fill. Colour already propagates live via the slot:<id>
// reference; pattern is stored per-object, so slot edits must be pushed. Setting
// the slot's pattern to Solid clears it on all its objects.
function propagateSlot(slot) {
  const ref = `slot:${slot.id}`;
  const push = o => {
    if (o.color !== ref && o.fill !== ref) return;
    if (slot.pattern && slot.pattern !== 'none') {
      o.pattern = slot.pattern;
      if (slot.patternBg) o.patternBg = slot.patternBg; else delete o.patternBg;
      if (slot.patternScale != null) o.patternScale = slot.patternScale; else delete o.patternScale;
    } else { delete o.pattern; delete o.patternBg; delete o.patternScale; }
  };
  for (const el of state.doc.elements) {
    push(el);
    for (const seg of el.segments || []) push(seg);
  }
}

// Paint a slot's colour — and, when it carries a pattern, a CSS approximation
// of that pattern — onto a swatch button. ponytail: CSS preview, not the exact
// SVG pattern; the canvas is the source of truth. Add an SVG mini-render if the
// preview ever needs to match pixel-for-pixel.
function paintSwatch(b, slot) {
  const fg = resolveColor(slot.color);
  b.style.background = '';
  b.style.backgroundImage = '';
  if (!slot.pattern || slot.pattern === 'none') { b.style.background = fg; return; }
  const bg = slot.patternBg ? resolveColor(slot.patternBg) : '#ffffff';
  const stripe = deg => `repeating-linear-gradient(${deg}deg, ${fg} 0 2px, transparent 2px 6px)`;
  const img = {
    horizontal: stripe(0), vertical: stripe(90), diagonal: stripe(45), 'diagonal-alt': stripe(-45),
    dots: `radial-gradient(${fg} 1.3px, transparent 1.6px)`,
    checker: `repeating-conic-gradient(${fg} 0 25%, transparent 0 50%)`,
  }[slot.pattern] || 'none';
  b.style.backgroundColor = bg;
  b.style.backgroundImage = img;
  b.style.backgroundSize = slot.pattern === 'dots' ? '6px 6px'
    : slot.pattern === 'checker' ? '8px 8px' : 'auto';
}

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

  // memory slots: elements store slot:<id>, so editing a slot recolors them all.
  // Click selects; Apply pushes the slot onto the selection; Edit opens the popup.
  // Slots are draggable to reorder.
  const slotsWrap = document.createElement('div');
  slotsWrap.className = 'swatches';
  const reorder = (fromId, toId) => {
    const arr = state.doc.palette;
    const from = arr.findIndex(s => s.id === fromId), to = arr.findIndex(s => s.id === toId);
    if (from < 0 || to < 0 || from === to) return;
    beginChange();
    arr.splice(to, 0, arr.splice(from, 1)[0]);
    changed();
  };
  for (const slot of state.doc.palette) {
    const b = document.createElement('button');
    b.className = 'swatch slot';
    paintSwatch(b, slot);
    b.title = `${slot.name || 'slot'} — click to select, drag to reorder`;
    if (activeSlot === slot.id) b.setAttribute('aria-pressed', 'true');
    b.addEventListener('click', () => { activeSlot = slot.id; renderPanel(); });
    b.draggable = true;
    b.addEventListener('dragstart', e => {
      e.dataTransfer.setData('text/slot-id', slot.id); e.dataTransfer.effectAllowed = 'move';
    });
    b.addEventListener('dragover', e => { if (e.dataTransfer.types.includes('text/slot-id')) e.preventDefault(); });
    b.addEventListener('drop', e => {
      e.preventDefault();
      const from = e.dataTransfer.getData('text/slot-id');
      if (from) reorder(from, slot.id);
    });
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
    openSlotEditor(slot.id); // a fresh slot opens straight into its editor
  });
  slotsWrap.appendChild(add);
  sec.appendChild(fieldRow('Memory slots', slotsWrap));

  const slot = state.doc.palette.find(s => s.id === activeSlot);
  if (slot) {
    const row = document.createElement('div');
    row.className = 'btn-row';
    row.append(
      smallButton('Apply', () => applyColor(`slot:${slot.id}`, slot),
        'Apply this slot to the selected object(s)'),
      smallButton('Edit', () => openSlotEditor(slot.id),
        'Open the slot editor to change its colour + pattern'));
    sec.appendChild(fieldRow(`Slot: ${slot.name || 'slot'}`, row));
  }
  return sec;
}

// ---- slot editor popup ----
// A modal (outside the panel) that edits the selected slot's colour + pattern.
// Colour propagates live via the slot:<id> reference; pattern is pushed by
// propagateSlot. refresh() re-renders this while it is open, so every edit
// updates every object using the slot in real time.
function openSlotEditor(id) { slotModal = { id }; renderSlotModal(); }
function closeSlotEditor() { slotModal = null; document.getElementById('slot-modal')?.remove(); }

function renderSlotModal() {
  if (!slotModal) return;
  const slot = state.doc.palette.find(s => s.id === slotModal.id);
  if (!slot) { closeSlotEditor(); return; }
  let overlay = document.getElementById('slot-modal');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'slot-modal';
    overlay.className = 'modal-overlay';
    overlay.addEventListener('pointerdown', e => { if (e.target === overlay) closeSlotEditor(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && slotModal) closeSlotEditor(); });
    document.body.appendChild(overlay);
  }
  overlay.innerHTML = '';
  const card = document.createElement('div');
  card.className = 'modal-card';

  const head = document.createElement('div');
  head.className = 'modal-head';
  const h = document.createElement('h2');
  h.textContent = 'Edit memory slot';
  const x = document.createElement('button');
  x.className = 'modal-close';
  x.textContent = '✕';
  x.title = 'Close';
  x.addEventListener('click', closeSlotEditor);
  head.append(h, x);

  const nInput = boundInput(() => slot.name || '', v => { slot.name = v; }, { placeholder: 'slot name' });
  const slotPick = colorPicker(`slot:${slot.id}`,
    () => slot.color,
    Object.assign(hexv => { slot.color = hexv; render(); }, { begin: beginChange }),
    changed, renderSlotModal);
  const del = document.createElement('button');
  del.className = 'btn danger';
  del.textContent = 'Remove slot';
  del.addEventListener('click', () => {
    beginChange();
    // freeze current colour into every user of the slot before removing it
    const frozen = slot.color;
    for (const el of state.doc.elements) {
      if (el.color === `slot:${slot.id}`) el.color = frozen;
      for (const seg of el.segments || []) if (seg.color === `slot:${slot.id}`) seg.color = frozen;
    }
    state.doc.palette = state.doc.palette.filter(s => s !== slot);
    if (state.color === `slot:${slot.id}`) state.color = frozen;
    activeSlot = null;
    closeSlotEditor();
    changed();
  });
  card.append(head,
    fieldRow('Slot name', nInput),
    fieldRow('Foreground', slotPick),
    patternControls(slot, `slot:${slot.id}`, () => propagateSlot(slot), renderSlotModal),
    del);
  overlay.appendChild(card);
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

// Like selectControl but option values and display labels differ ({value: label}).
function mappedSelect(map, get, set) {
  const node = document.createElement('select');
  for (const [val, label] of Object.entries(map)) {
    const opt = document.createElement('option');
    opt.value = val; opt.textContent = label;
    node.appendChild(opt);
  }
  node.value = get();
  node.addEventListener('change', () => { beginChange(); set(node.value); changed(); });
  return node;
}

// Range slider bound to a live doc value (min/max/step configurable).
function rangeControl(get, set, { min = 0, max = 1, step = 0.1 } = {}) {
  const node = document.createElement('input');
  node.type = 'range';
  node.min = min; node.max = max; node.step = step;
  node.value = get();
  let editing = false;
  node.addEventListener('input', () => {
    if (!editing) { beginChange(); editing = true; }
    set(+node.value);
    render();
  });
  node.addEventListener('change', () => { if (editing) { editing = false; changed(); } });
  return node;
}

// Pattern kind + (when patterned) a second colour and lattice-scale slider.
// Works on any object with .pattern/.patternBg/.patternScale (element or segment).
// `fg` is the object's own colour, shown only via render — the bg defaults to
// transparent (canvas shows through) until a colour is picked.
function patternControls(obj, key, after, rerender = renderPanel) {
  const frag = document.createDocumentFragment();
  frag.appendChild(fieldRow('Pattern', mappedSelect(
    PATTERNS,
    () => obj.pattern || 'none',
    v => { if (v === 'none') delete obj.pattern; else obj.pattern = v; after?.(); })));
  if (obj.pattern && obj.pattern !== 'none') {
    frag.appendChild(fieldRow('Pattern bg', patternBgControl(obj, key, after, rerender)));
    frag.appendChild(fieldRow('Pattern scale', rangeControl(
      () => obj.patternScale ?? 1,
      v => { obj.patternScale = v; after?.(); },
      { min: 0.5, max: 4, step: 0.25 })));
  }
  return frag;
}

// Pattern-background chooser: transparent (the default) + memory-slot swatches +
// a custom picker. Stored as a colour ref (hex or slot:<id>) resolved at paint,
// so a slot-backed bg recolours live when the slot changes.
function patternBgControl(obj, key, after, rerender = renderPanel) {
  const wrap = document.createElement('div');
  const row = document.createElement('div');
  row.className = 'swatches';
  const swatch = (bg, title, active, onPick) => {
    const b = document.createElement('button');
    b.className = bg ? 'swatch slot' : 'swatch swatch-none';
    if (bg) b.style.background = bg;
    b.title = title;
    if (active) b.setAttribute('aria-pressed', 'true');
    b.addEventListener('click', () => { beginChange(); onPick(); after?.(); changed(); });
    return b;
  };
  row.appendChild(swatch(null, 'Transparent', !obj.patternBg, () => { delete obj.patternBg; }));
  for (const slot of state.doc.palette) {
    row.appendChild(swatch(slot.color, slot.name || 'slot',
      obj.patternBg === `slot:${slot.id}`, () => { obj.patternBg = `slot:${slot.id}`; }));
  }
  wrap.appendChild(row);
  wrap.appendChild(colorPicker(`patbg:${key}`,
    () => (/^#[0-9a-f]{6}$/i.test(obj.patternBg || '') ? obj.patternBg : '#ffffff'),
    Object.assign(hex => { obj.patternBg = hex; after?.(); render(); }, { begin: beginChange }),
    changed, rerender));
  return wrap;
}

// Range + number pair bound to a live doc value (e.g. grid-snappy corner radius).
function sliderNum(get, set, { min = 0, max = 100, step = 1 } = {}) {
  const row = document.createElement('div');
  row.className = 'width-row';
  const range = document.createElement('input');
  range.type = 'range';
  range.min = min; range.max = max; range.step = step; range.value = get();
  const num = document.createElement('input');
  num.type = 'number';
  num.min = min; num.max = max; num.step = step; num.value = get();
  let editing = false;
  range.addEventListener('input', () => {
    if (!editing) { beginChange(); editing = true; }
    set(+range.value); num.value = range.value; render();
  });
  range.addEventListener('change', () => { if (editing) { editing = false; changed(); } });
  num.addEventListener('change', () => {
    const v = clamp(+num.value || 0, min, max);
    num.value = v; range.value = v;
    beginChange(); set(v); changed();
  });
  row.append(range, num);
  return row;
}

// Read-only display field (derived values the user can see but not edit).
function readOnlyField(value) {
  const node = document.createElement('input');
  node.type = 'text';
  node.value = value;
  node.readOnly = true;
  node.tabIndex = -1;
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
      applyLabelColorSlot(state.doc.labelSlots.find(s => s.id === sel.value));
    }
    changed();
  });
  frag.appendChild(fieldRow('Shared label', sel));

  // when the target is on a shared label, offer to bind that label to a memory
  // colour slot — every element carrying the label then inherits its colour+pattern
  const labelSlot = ref && state.doc.labelSlots.find(s => s.id === ref);
  if (labelSlot) {
    const csel = document.createElement('select');
    for (const [v, t] of [['', '— none —'], ...state.doc.palette.map(s => [s.id, s.name || 'slot'])]) {
      const o = document.createElement('option');
      o.value = v; o.textContent = t;
      csel.appendChild(o);
    }
    csel.value = labelSlot.colorSlot || '';
    csel.addEventListener('change', () => {
      beginChange();
      if (csel.value) labelSlot.colorSlot = csel.value; else delete labelSlot.colorSlot;
      applyLabelColorSlot(labelSlot);
      changed();
    });
    frag.appendChild(fieldRow('Label color slot', csel));
  }
  return frag;
}

// Fill toggle + colour for closed shapes (rect/ellipse) and links.
function fillControl(el, { label = 'Fill', optional = true } = {}) {
  const frag = document.createDocumentFragment();
  if (optional) {
    frag.appendChild(checkboxRow(label, () => !!el.fill, v => {
      if (v) el.fill = resolveColor(el.color) || resolveColor(currentColor()) || '#c9c2b6';
      else delete el.fill;
    }));
  }
  if (el.fill || !optional) {
    const pick = colorPicker(`fill:${el.id}`,
      () => (/^#[0-9a-f]{6}$/i.test(el.fill || '') ? el.fill : '#c9c2b6'),
      Object.assign(hex => { el.fill = hex; render(); }, { begin: beginChange }),
      changed);
    frag.appendChild(fieldRow(`${label} colour`, pick));
    frag.appendChild(patternControls(el, `fill:${el.id}`));
  }
  return frag;
}

// A "flip harpoon" checkbox appears for whichever end caps are harpoons.
function harpoonFlips(el) {
  const frag = document.createDocumentFragment();
  if (el.cap0 === 'harpoon') {
    frag.appendChild(checkboxRow('Flip start harpoon', () => !!el.cap0flip, v => {
      if (v) el.cap0flip = true; else delete el.cap0flip;
    }));
  }
  if (el.cap1 === 'harpoon') {
    frag.appendChild(checkboxRow('Flip end harpoon', () => !!el.cap1flip, v => {
      if (v) el.cap1flip = true; else delete el.cap1flip;
    }));
  }
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
      styleSec.appendChild(harpoonFlips(el));
    }
    if (el.type === 'path') {
      styleSec.appendChild(patternControls(el, `line:${el.id}`));
      styleSec.appendChild(fieldRow('Corner radius', sliderNum(
        () => el.corner || 0,
        v => { if (v) el.corner = v; else delete el.corner; },
        { min: 0, max: 8 * GRID, step: GRID / 2 })));
    }
    if (el.type === 'rect') {
      styleSec.appendChild(fieldRow('Corner radius', numberControl(
        () => el.r || 0,
        v => { el.r = v; },
        { min: 0, max: Math.floor(Math.min(el.w, el.h) / 2), step: 1 })));
    }
    if (el.type === 'rect' || el.type === 'ellipse') styleSec.appendChild(fillControl(el));
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
    sec.appendChild(fieldRow('Background', colorPicker('bg',
      () => (/^#[0-9a-f]{6}$/i.test(state.doc.bg || '') ? state.doc.bg : '#ffffff'),
      Object.assign(hex => { state.doc.bg = hex; render(); }, { begin: beginChange }),
      changed)));
    if (state.doc.bg && state.doc.bg !== '#ffffff') {
      sec.appendChild(smallButton('Reset background', () => {
        beginChange(); delete state.doc.bg; changed();
      }, 'Back to white'));
    }
  } else if (!single) {
    sec.appendChild(sectionTitle(`${n} objects`));
    const row = document.createElement('div');
    row.className = 'btn-row';
    row.append(smallButton('Group', groupSelection, 'Bundle the selection into a named group (Ctrl+G)'));
    if (state.selection.some(s => byId(s.id)?.group)) {
      row.append(smallButton('Ungroup', ungroupSelection, 'Dissolve the selected group(s) (Ctrl+Shift+G)'));
    }
    const linkT = linkTargetsFromSelection();
    if (linkT) {
      const existing = findLink(linkT[0], linkT[1]);
      if (existing) {
        row.append(smallButton('Unlink', () => {
          beginChange();
          state.doc.elements = state.doc.elements.filter(e => e !== existing);
          changed();
        }, 'Remove the link between these two items'));
      } else {
        row.append(smallButton('Link', () => createLink(linkT),
          'Fill the area spanning the two selected items'));
      }
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
    sec.appendChild(fieldRow('Thickness', widthControl(
      () => seg.width ?? ((el.width || 2) + 2.5),
      v => { seg.width = v; },
      true)));
    sec.appendChild(fieldRow('Line ends', selectControl(
      ['rounded', 'flat', 'square'],
      () => LINECAP_NAMES[seg.linecap || 'round'],
      v => { seg.linecap = LINECAP_VALUES[v]; })));
    sec.appendChild(patternControls(seg, `seg:${el.id}.${single.seg}`));
    sec.appendChild(labelFields(seg, 'e.g. domain a'));
    sec.appendChild(labelDisplayFields(seg));
    sec.appendChild(fieldRow('String', boundInput(
      () => seg.string || '', v => { seg.string = v; },
      { placeholder: 'e.g. domain sequence' })));
    sec.appendChild(fieldRow('Data (not displayed)', boundInput(
      () => seg.notes || '', v => { seg.notes = v; }, { textarea: true, placeholder: 'notes, metadata…' })));
    sec.appendChild(deleteButton('Delete segment'));
  } else if (single.el.type === 'link') {
    const el = single.el;
    sec.appendChild(sectionTitle('Link'));
    const info = document.createElement('p');
    info.className = 'muted';
    info.textContent = 'A filled area spanning two objects — it follows them as they move.';
    sec.appendChild(info);
    sec.appendChild(fillControl(el, { optional: false, label: 'Fill' }));
    const orow = document.createElement('div');
    orow.className = 'width-row';
    const range = document.createElement('input');
    range.type = 'range'; range.min = 0.05; range.max = 1; range.step = 0.05;
    range.value = el.opacity ?? 0.45;
    const num = document.createElement('input');
    num.type = 'number'; num.min = 0.05; num.max = 1; num.step = 0.05;
    num.value = el.opacity ?? 0.45;
    let editing = false;
    range.addEventListener('input', () => {
      if (!editing) { beginChange(); editing = true; }
      el.opacity = +range.value; num.value = range.value; render();
    });
    range.addEventListener('change', () => { if (editing) { editing = false; changed(); } });
    num.addEventListener('change', () => {
      const v = clamp(+num.value || 0.45, 0.05, 1); num.value = v; range.value = v;
      beginChange(); el.opacity = v; changed();
    });
    orow.append(range, num);
    sec.appendChild(fieldRow('Opacity', orow));
    sec.appendChild(deleteButton());
    panel.appendChild(sec);
    return;
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
      sec.appendChild(fieldRow('Card color', colorPicker(`fill:${el.id}`,
        () => (/^#[0-9a-f]{6}$/i.test(el.fill || '') ? el.fill : '#ffffff'),
        Object.assign(hex => { el.fill = hex; render(); }, { begin: beginChange }),
        changed)));
      if (el.fill && el.fill !== '#ffffff') {
        sec.appendChild(smallButton('Reset card color', () => {
          beginChange(); delete el.fill; changed();
        }, 'Back to white'));
      }
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
      sec.appendChild(smallButton('Remove from group', () => removeFromGroup(el),
        'Take this object out of its group'));
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
      const ds = domainString(el);
      if (ds) sec.appendChild(fieldRow('Domain string', readOnlyField(ds)));
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
    state.dirty = false;
    $('hint').textContent = 'Saved.';
    toast('Saved ✓');
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
      state.dirty = false;
      renderNotes();
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
  $('hint').textContent = 'Building SVG…';
  const text = await exportSVGString();
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
  const rows = [['id', 'type', 'name', 'group', 'card', 'color', 'width', 'notes', 'string']];
  for (const el of els) {
    const name = el.type === 'card' ? (el.title || '')
      : resolveLabel(el.label || '') || (el.type === 'text' ? el.text : '');
    rows.push([el.id, el.type, name, groupName(el), cardOf(el),
      el.color !== undefined ? resolveColor(el.color) : '', el.width ?? '', el.notes || '',
      el.type === 'path' ? domainString(el) : '']);
    (el.segments || []).forEach((seg, i) => {
      rows.push([`${el.id}.s${i + 1}`, 'segment', resolveLabel(seg.label || ''),
        groupName(el), cardOf(el), resolveColor(seg.color), '', seg.notes || '', seg.string || '']);
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
    state.dirty = false;
    renderNotes();
  }
});
$('openBtn').addEventListener('click', openFile);
$('fileInput').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try { loadDocJSON(await file.text()); currentFile = null; state.dirty = false; renderNotes(); fitView(); }
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
$('copyBtn').addEventListener('click', copySelection);
$('pasteBtn').addEventListener('click', pasteClipboard);
$('exportBtn').addEventListener('click', exportSVG);
$('csvBtn').addEventListener('click', exportCSV);
$('undoBtn').addEventListener('click', undo);
$('redoBtn').addEventListener('click', redo);

$('snapToggle').addEventListener('click', () => {
  state.snap = !state.snap;
  $('snapToggle').setAttribute('aria-pressed', state.snap);
  $('hint').textContent = `Annotation snapping ${state.snap ? 'on' : 'off'}.`;
});
$('dataToggle').addEventListener('click', () => {
  dataView.show = !dataView.show;
  $('dataToggle').setAttribute('aria-pressed', dataView.show);
  render();
});
$('hoverToggle').addEventListener('click', () => {
  dataView.hover = !dataView.hover;
  $('hoverToggle').setAttribute('aria-pressed', dataView.hover);
  if (!dataView.hover) dataView.hoverId = null;
  render();
});

window.addEventListener('resize', render);

// ---- unsaved-changes guard on close ----
// Tauri: intercept the window close and ask natively. Browser: the standard
// beforeunload prompt (skipped under Tauri so we don't double-prompt).
if (TAURI?.window?.getCurrentWindow) {
  const win = TAURI.window.getCurrentWindow();
  win.onCloseRequested(async event => {
    if (!state.dirty) return; // clean → let it close
    event.preventDefault();   // must be synchronous, before any await
    const leave = await TAURI.dialog.ask(
      'You have unsaved changes. Close without saving?',
      { title: 'Master Schemer', kind: 'warning' });
    if (leave) win.destroy();
  }).catch(() => { /* window API/permission absent: fall through, no guard */ });
} else {
  window.addEventListener('beforeunload', e => {
    if (state.dirty) { e.preventDefault(); e.returnValue = ''; }
  });
}

// ---- notes panel (Markdown scratch page with live object references) ----
// The editor is a contenteditable pad. Object references are non-editable chips
// carrying a {kind,id}; the free text between them is Markdown source. On every
// edit the DOM is serialized back to a token string in state.doc.notes (so it
// saves with the file). When an object is renamed, only the chips' text is
// refreshed (syncNoteRefs), so the caret never jumps. ponytail: token format is
// {{el:ID}} / {{grp:ID}} with no escaping of a literal "{{" typed in prose — add
// a fence only if that collision ever actually bites.

const notesEditor = $('notesEditor');
const REF_RE = /\{\{(el|grp):([^}]+)\}\}/g;

// The live text of a reference: an element's display name, or — for a group —
// the name of its parent-most (outermost) group.
function refLabel(kind, id) {
  if (kind === 'grp') {
    let g = byGroup(id);
    if (!g) return '(deleted group)';
    while (g.parent && byGroup(g.parent)) g = byGroup(g.parent);
    return g.name || 'group';
  }
  const el = byId(id);
  return el ? displayName(el, state.doc.elements.indexOf(el)) : '(deleted)';
}

function makeChip(kind, id) {
  const chip = document.createElement('span');
  chip.className = 'note-ref';
  chip.contentEditable = 'false';
  chip.dataset.kind = kind;
  chip.dataset.ref = id;
  chip.textContent = refLabel(kind, id);
  return chip;
}

// token string → editor DOM (full rebuild; used on load/new only)
function renderNotes() {
  const str = state.doc.notes || '';
  const frag = document.createDocumentFragment();
  const pushText = text => text.split('\n').forEach((line, i) => {
    if (i) frag.appendChild(document.createElement('br'));
    if (line) frag.appendChild(document.createTextNode(line));
  });
  let last = 0, m;
  REF_RE.lastIndex = 0;
  while ((m = REF_RE.exec(str))) {
    if (m.index > last) pushText(str.slice(last, m.index));
    frag.appendChild(makeChip(m[1], m[2]));
    last = m.index + m[0].length;
  }
  if (last < str.length) pushText(str.slice(last));
  notesEditor.replaceChildren(frag);
  updateNotesPlaceholder();
}

// editor DOM → token string
function serializeNotes() {
  let text = '';
  const walk = node => {
    for (const c of node.childNodes) {
      if (c.nodeType === Node.TEXT_NODE) text += c.data;
      else if (c.nodeName === 'BR') text += '\n';
      else if (c.classList?.contains('note-ref')) text += `{{${c.dataset.kind}:${c.dataset.ref}}}`;
      else { // a block wrapper (contenteditable puts each new line in its own <div>)
        if (text && !text.endsWith('\n')) text += '\n';
        walk(c);
      }
    }
  };
  walk(notesEditor);
  return text;
}

// A rename elsewhere: refresh chip text in place, leaving prose and caret alone.
function syncNoteRefs() {
  for (const chip of notesEditor.querySelectorAll('.note-ref')) {
    const t = refLabel(chip.dataset.kind, chip.dataset.ref);
    if (chip.textContent !== t) chip.textContent = t;
  }
}

function updateNotesPlaceholder() {
  notesEditor.classList.toggle('is-empty',
    !notesEditor.textContent.trim() && !notesEditor.querySelector('.note-ref'));
}

notesEditor.addEventListener('input', () => {
  state.doc.notes = serializeNotes();
  updateNotesPlaceholder();
  touch(); // dirty + autosave, but no full re-render on every keystroke
});

// paste as plain text so foreign HTML can't inject stray nodes into the notes
notesEditor.addEventListener('paste', e => {
  e.preventDefault();
  document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
});

function refFromDrag(dt) {
  try { return JSON.parse(dt.getData('text/scheme-ref')); } catch { return null; }
}
notesEditor.addEventListener('dragover', e => {
  if (e.dataTransfer.types.includes('text/scheme-ref')) e.preventDefault();
});
notesEditor.addEventListener('drop', e => {
  const ref = refFromDrag(e.dataTransfer);
  if (!ref) return;
  e.preventDefault();
  insertChipAtPoint(e.clientX, e.clientY, ref.kind, ref.id);
});

function insertChipAtPoint(x, y, kind, id) {
  notesEditor.focus();
  const chip = makeChip(kind, id);
  const space = document.createTextNode(' ');
  const range = document.caretRangeFromPoint?.(x, y);
  if (range && notesEditor.contains(range.startContainer)) {
    range.insertNode(space);
    range.insertNode(chip); // chip lands before the space → "chip␠" order
  } else {
    notesEditor.append(chip, space);
  }
  state.doc.notes = serializeNotes();
  updateNotesPlaceholder();
  touch();
}

// A selection dragged from the canvas onto the notes panel. A whole group (all
// its members selected) becomes one group chip; otherwise one chip per object.
function addSelectionToNotes(x, y) {
  const els = state.selection.filter(s => s.seg === undefined).map(s => byId(s.id)).filter(Boolean);
  if (!els.length) return;
  const gid = els[0].group;
  const asGroup = gid && els.every(el => el.group === gid) &&
    groupElementMembers(gid).length === els.length;
  if (asGroup) insertChipAtPoint(x, y, 'grp', gid);
  else for (const el of els) insertChipAtPoint(x, y, 'el', el.id);
}

// ---- notes panel visibility (a UI pref, kept in localStorage not the file) ----

const NOTES_HIDDEN_KEY = 'master-schemer-notes-hidden';
function setNotesHidden(hidden) {
  document.body.classList.toggle('notes-hidden', hidden);
  $('notesToggle').setAttribute('aria-pressed', String(!hidden));
  try { localStorage.setItem(NOTES_HIDDEN_KEY, hidden ? '1' : ''); } catch { /* full */ }
  render(); // canvas width changed → refit the grid rect on the next frame
}
$('notesHide').addEventListener('click', () => setNotesHidden(true));
$('notesToggle').addEventListener('click', () =>
  setNotesHidden(!document.body.classList.contains('notes-hidden')));

// ---- boot ----

// Start every session on a fresh blank canvas (autosave still writes, so a
// future "recover last" could read it, but we no longer reopen it on launch).
try { setNotesHidden(localStorage.getItem(NOTES_HIDDEN_KEY) === '1'); } catch { /* default: shown */ }
renderNotes();
setTool('select');
refresh();
state.view.tx = 80; state.view.ty = 80;
refresh();
