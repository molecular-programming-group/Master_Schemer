// App shell: event routing, sidebar, panel, keyboard, view controls, file ops.
import {
  state, COLORS, setOnChanged, beginChange, changed, touch, undo, redo, newId, addElement,
  deleteSelection, selectionSingle, byId, newDoc, loadDocJSON,
  isSemantic, resolveColor, resolveLabel, reorder, pruneGroups,
  byGroup, childGroups, topLevelGroups, groupElementMembers, remapSegLinks, domainKey, domainUses, syncDomains,
  displayName, kindWord, clearNameCache,
} from './model.js';
import { GRID, mergePaths, rot90, flipPt, snapHalf, polylineLength, subPath, resizeEndSegments, drawnPts } from './geom.js';
import {
  render, renderNow, screenToWorld, contentBBox, elementBBox, exportSVGString, CAPS, POINTED_CAPS, PATTERNS, dataView, alineD, alineMid,
  linkStrand, rungSeqs, refSeq, duplexLink, duplexBases, dnaLayout, diam, dnaBpg, strandView, lookOf, dnaView, invalidateRenderCache,
  FONTS, LINE_H, INLINE_TAGS, inlineHTML, toon, outlined, LABEL_STYLE_KEYS, labelStyleOf, anchorFrac, textWidth,
} from './render.js';
import { DEFAULT_BPG, seqOf, spacing, tintRef, uAt, worldPerA, gridPitch, naturalBases, seqLetters } from './dna.js';
import MOLS from './mol-tex.js';
import { tools, cancelActive, isDragging, cardContents } from './tools.js';
import { THEMES } from './themes.js';

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
  clearNameCache();
  render();
  // panels are DOM-heavy; while a drag is live only the canvas needs frames
  if (!isDragging()) {
    renderPanel();
    renderSidebar();
    if (slotModal) renderSlotModal(); // popup lives outside the panel; keep it live too
  }
  $('undoBtn').disabled = !state.history.length;
  updateCtrlbar();
  updateTextbar();
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

function fitView(box) {
  // draw everything first: a note's real size (KaTeX math especially) is only
  // known once laid out, and a just-opened file hasn't been drawn yet
  if (!box) { renderNow(false); box = contentBBox(); }
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
$('zoomFit').addEventListener('click', () => fitView());
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
    if (!rot && el.rot) el.rot = -el.rot; // a mirrored turned shape turns the other way
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

// Space the selection evenly along an axis: the outermost two stay put and the
// gaps between neighbouring bounding boxes become equal.
function distributeSelection(axis) { // 'h' | 'v'
  const els = selectedElements();
  if (els.length < 3) return;
  const [lo, hi] = axis === 'h' ? [0, 2] : [1, 3];
  const items = els.map(el => ({ el, b: elementBBox(el) }))
    .sort((p, q) => (p.b[lo] + p.b[hi]) - (q.b[lo] + q.b[hi]));
  const span = items.at(-1).b[hi] - items[0].b[lo];
  const gap = (span - items.reduce((s, { b }) => s + b[hi] - b[lo], 0)) / (items.length - 1);
  beginChange();
  let at = items[0].b[hi] + gap;
  for (const { el, b } of items.slice(1, -1)) {
    let d = at - b[lo];
    if (el.type === 'path') d = snapHalf(d); // same lattice rule as alignSelection
    if (axis === 'h') shiftEl(el, d, 0); else shiftEl(el, 0, d);
    at += b[hi] - b[lo] + gap;
  }
  changed();
}

$('ctrlbar').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.xf) transformSelection(b.dataset.xf);
  else if (b.dataset.align) alignSelection(b.dataset.align);
  else if (b.dataset.dist) distributeSelection(b.dataset.dist);
});
function updateCtrlbar() {
  const n = selectedElements().length;
  for (const b of $('ctrlbar').querySelectorAll('button[data-xf], button[data-align], button[data-dist]'))
    b.disabled = n < (b.dataset.dist ? 3 : b.dataset.align ? 2 : 1);
}
$('textbarToggle').addEventListener('click', () => togglePanel('textbar'));

// ---- text formatting (text toolbar + Text menu) ----
// Whole-note formatting lives on the element (font, size, bold, italic,
// underline, strike, align, lh). Superscript/subscript — and bold etc. on part
// of a note — are inline tags wrapped around the selection in the note editor.
// With no note selected, the toolbar sets the formatting for new notes.

const FLAG = { b: 'bold', i: 'italic', u: 'underline', s: 'strike' };
const SIZES = [6, 8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 40, 44, 48, 54, 60, 66, 72, 80, 96, 120, 144];
const FMT_KEYS = ['font', 'size', 'bold', 'italic', 'underline', 'strike', 'align', 'anchored', 'lh'];
const textTargets = () => selectedElements().filter(el => el.type === 'text');
// A field holding a note's or label's source: the canvas editor, or the
// panel's Text / Label fields (marked .fmt-src).
const noteEditor = () => {
  const ae = document.activeElement;
  return ae?.matches?.('textarea.inline-edit, .fmt-src') ? ae : null;
};

// Inside $…$ the toolbar writes LaTeX; tags there would render literally.
const TEX_WRAP = {
  sup: ['^{', '}'], sub: ['_{', '}'], b: ['\\mathbf{', '}'], i: ['\\mathit{', '}'],
  u: ['\\underline{', '}'], s: ['\\sout{', '}'],
};
// $…$ spans (dollars included), paired left to right like richHTML's split
const mathSpans = v => [...v.matchAll(/\$([^$]+)\$/g)].map(m => [m.index, m.index + m[0].length]);

// Wrap the editor's selection in <tag>…</tag> (LaTeX inside math), or unwrap
// it if it already is. A selection that cuts into a $…$ grows to take the
// whole math, so the dollars stay paired. execCommand keeps the change on the
// field's own undo stack.
function wrapInEditor(ed, tag) {
  const v = ed.value;
  let a = ed.selectionStart, z = ed.selectionEnd, inner;
  const spans = mathSpans(v);
  const inMath = spans.some(([s, e]) => a > s && z < e);
  if (!inMath) {
    for (const [s, e] of spans) if (a < e && z > s) { a = Math.min(a, s); z = Math.max(z, e); }
  }
  const [o, c] = inMath ? TEX_WRAP[tag] : [`<${tag}>`, `</${tag}>`];
  if (v.slice(a - o.length, a) === o && v.slice(z, z + c.length) === c) {
    inner = v.slice(a, z); a -= o.length; z += c.length;
  } else if (z - a >= o.length + c.length && v.slice(a, a + o.length) === o && v.slice(z - c.length, z) === c) {
    inner = v.slice(a + o.length, z - c.length);
  }
  const text = inner ?? o + v.slice(a, z) + c;
  ed.setSelectionRange(a, z);
  if (!document.execCommand('insertText', false, text)) ed.setRangeText(text, a, z, 'end');
  const start = inner === undefined ? a + o.length : a;
  ed.setSelectionRange(start, start + (inner ?? v.slice(a, z)).length);
  ed.rows = Math.max(ed.rows, (ed.value.match(/\n/g)?.length ?? 0) + 1);
}

function textHint(msg) {
  $('textbarHint').textContent = msg;
  $('hint').textContent = msg;
}

// Move a note's x from its current anchor to fraction k of its width, along
// its (possibly rotated) baseline, so the text itself doesn't move.
function reanchor(o, k) {
  const dx = (k - anchorFrac(o)) * textWidth(o), r = (o.rotate || 0) * Math.PI / 180;
  o.x = +(o.x + dx * Math.cos(r)).toFixed(2);
  o.y = +(o.y + dx * Math.sin(r)).toFixed(2);
}

function applyFormat(f) {
  const [cmd, arg] = f.split(':');
  const ed = noteEditor();
  // in the canvas editor an empty selection means the whole note; panel fields always wrap
  const partial = ed && (ed.selectionStart !== ed.selectionEnd || !ed.matches('.inline-edit'));
  if (ed && (cmd === 'sup' || cmd === 'sub' || (FLAG[cmd] && partial))) {
    wrapInEditor(ed, cmd);
    return;
  }
  if (cmd === 'sup' || cmd === 'sub') {
    textHint('Double-click a note and select the text to raise or lower.');
    return;
  }
  ed?.blur(); // commits the edit, so its note is selected below
  const els = textTargets();
  const first = els[0] || state.textDefaults;
  const set = (o, k, v, dflt) => { if (v === dflt || v === undefined) delete o[k]; else o[k] = v; };
  const update = o => {
    if (FLAG[cmd]) set(o, FLAG[cmd], !first[FLAG[cmd]] || undefined);
    else if (cmd === 'align') {
      // the note's x becomes the alignment anchor (left edge, centre, right
      // edge); a placed note shifts its x so it stays where it is on screen
      if (o.type === 'text') reanchor(o, { center: 0.5, right: 1 }[arg] || 0);
      set(o, 'align', arg, 'left');
      set(o, 'anchored', arg !== 'left' || undefined, undefined);
    }
    else if (cmd === 'font') set(o, 'font', arg, 'sans');
    else if (cmd === 'lh') set(o, 'lh', +arg, LINE_H);
    else if (cmd === 'size') o.size = clamp(+arg || 14, 6, 144);
    else if (cmd === 'bigger' || cmd === 'smaller') {
      const cur = o.size || 14;
      o.size = cmd === 'bigger' ? SIZES.find(n => n > cur) ?? 144 : SIZES.findLast(n => n < cur) ?? 6;
    } else if (cmd === 'clear') {
      if (o.anchored) reanchor(o, 0); // back to a left-anchored note, without moving it
      for (const k of FMT_KEYS) if (k !== 'size') delete o[k];
      if (typeof o.text === 'string') o.text = o.text.replace(new RegExp(`</?(${INLINE_TAGS.join('|')})>`, 'g'), '');
    }
  };
  if (!els.length) {
    update(state.textDefaults);
    if (state.textDefaults.size === 14) delete state.textDefaults.size;
    textHint('No note selected — new notes will use this formatting.');
    updateTextbar();
    return;
  }
  beginChange();
  els.forEach(update);
  textHint('');
  changed();
}

{
  const opts = Object.entries(FONTS).map(([k, [name, css]]) => {
    const o = new Option(name, k);
    o.style.fontFamily = css;
    return o;
  });
  $('tbFont').append(...opts);
  // Text menu: one radio item per font, before Clear Formatting
  $('fontsAfter').before(document.createElement('hr'));
  for (const [k, [name, css]] of Object.entries(FONTS)) {
    const b = document.createElement('button');
    b.setAttribute('role', 'menuitemradio');
    b.dataset.fmt = `font:${k}`;
    b.style.fontFamily = css;
    b.textContent = name;
    $('fontsAfter').before(b);
  }
}
// mousedown would move focus off the note editor and commit it mid-format
$('textbar').addEventListener('mousedown', e => { if (e.target.closest('button')) e.preventDefault(); });
$('textbar').addEventListener('click', e => {
  const b = e.target.closest('button[data-fmt]');
  if (b) applyFormat(b.dataset.fmt);
});
$('tbFont').addEventListener('change', e => applyFormat(`font:${e.target.value}`));
$('tbLh').addEventListener('change', e => applyFormat(`lh:${e.target.value}`));
$('tbSize').addEventListener('change', e => applyFormat(`size:${e.target.value}`));
$('tbSize').addEventListener('keydown', e => { if (e.key === 'Enter') e.target.blur(); });

// Pressed states mirror the first selected note (or the new-note defaults).
function fmtState(f) {
  const [cmd, arg] = f.split(':');
  const o = textTargets()[0] || state.textDefaults;
  if (FLAG[cmd]) return !!o[FLAG[cmd]];
  if (cmd === 'align') return (o.align || 'left') === arg;
  if (cmd === 'font') return (o.font || 'sans') === arg;
  return null;
}
function updateTextbar() {
  const o = textTargets()[0] || state.textDefaults;
  for (const b of $('textbar').querySelectorAll('button[data-fmt]')) {
    const on = fmtState(b.dataset.fmt);
    if (on !== null) b.setAttribute('aria-pressed', String(on));
  }
  $('tbFont').value = o.font || 'sans';
  $('tbLh').value = String(o.lh || LINE_H);
  if (document.activeElement !== $('tbSize')) $('tbSize').value = o.size || 14;
  if (textTargets().length) $('textbarHint').textContent = '';
}

// Shortcuts work on selected notes and inside the note editor (whose own
// keydown stops propagation, hence the capture phase).
window.addEventListener('keydown', e => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
  const t = e.target, ed = noteEditor();
  if (!ed && (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement ||
    t instanceof HTMLSelectElement || (t instanceof HTMLElement && t.isContentEditable))) return;
  if (!ed && !textTargets().length) return;
  const k = e.key.toLowerCase();
  let f = null;
  if (!e.shiftKey && FLAG[k] && k !== 's') f = k; // Ctrl+S stays Save
  else if (e.code === 'Equal') f = e.shiftKey ? 'sup' : 'sub';
  else if (e.shiftKey && e.code === 'Period') f = 'bigger';
  else if (e.shiftKey && e.code === 'Comma') f = 'smaller';
  if (!f) return;
  e.preventDefault();
  e.stopPropagation();
  applyFormat(f);
}, true);

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

// The selection is exactly one group (as a click on a grouped object makes it).
const isOneGroup = () => state.selection.some(s => s.seg === undefined) &&
  [...whollySelectedGroups()].some(gid => groupElementMembers(gid).length === state.selection.length);

function groupSelection() {
  const els = selectedElements();
  if (els.length < 2 || isOneGroup()) return; // regrouping one group would only wrap it
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
  if (entries.some(s => ['link', 'arrow'].includes(byId(s.id)?.type))) return null; // links join things, not links
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

function createLink(targets, style) {
  if (findLink(targets[0], targets[1])) return; // never stack a second link on the same pair
  beginChange();
  const el = addElement({
    type: 'link', a: targets[0], b: targets[1],
    fill: resolveColor(currentColor()) || '#8a857c', opacity: 0.45,
  });
  // two DNA strands pair up as a duplex rather than a filled area
  if (style) el.style = style;
  else if (targets.every(t => byId(t.id) && lookOf(byId(t.id)) === 'dna') && linkStrand(el.a) && linkStrand(el.b)) el.style = 'bases';
  state.selection = [{ id: el.id }];
  changed();
}

// ---- keyboard ----

function selectAll() {
  state.selection = state.doc.elements.filter(el => el.type !== 'arrow').map(el => ({ id: el.id }));
  refresh();
}

function invertSelection() {
  const sel = new Set(state.selection.filter(s => s.seg === undefined).map(s => s.id));
  state.selection = state.doc.elements
    .filter(el => el.type !== 'arrow' && !sel.has(el.id)).map(el => ({ id: el.id }));
  refresh();
}

function zoomToSelection() {
  const els = selectedElements();
  if (els.length) fitView(combinedBBox(els));
}

// grid visibility is a UI pref (localStorage), not part of the file
const GRID_HIDDEN_KEY = 'master-schemer-grid-hidden';
function toggleGrid() {
  const hidden = document.body.classList.toggle('hide-grid');
  try { localStorage.setItem(GRID_HIDDEN_KEY, hidden ? '1' : ''); } catch { /* full */ }
}
try { document.body.classList.toggle('hide-grid', localStorage.getItem(GRID_HIDDEN_KEY) === '1'); } catch { /* shown */ }
// Grid → Show Base Ticks / Draw Strands in Whole Bases: UI prefs too
const TICKS_HIDDEN_KEY = 'master-schemer-ticks-hidden', BASE_SNAP_KEY = 'master-schemer-base-snap';
function toggleTicks() {
  const hidden = document.body.classList.toggle('hide-ticks');
  try { localStorage.setItem(TICKS_HIDDEN_KEY, hidden ? '1' : ''); } catch { /* full */ }
}
function setBaseSnap(on, remember) {
  state.baseSnap = on;
  if (remember) try { localStorage.setItem(BASE_SNAP_KEY, on ? '1' : ''); } catch { /* full */ }
}
try {
  document.body.classList.toggle('hide-ticks', localStorage.getItem(TICKS_HIDDEN_KEY) === '1');
  setBaseSnap(localStorage.getItem(BASE_SNAP_KEY) === '1', false);
} catch { /* defaults */ }

window.addEventListener('keydown', e => {
  const t = e.target;
  // Save works from anywhere, mid-typing included (else the browser saves the page)
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveJSON(e.shiftKey); return; }
  if (document.querySelector('.modal-overlay')) return; // a dialog is up: its own keys only
  if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return;
  if (t instanceof HTMLElement && t.isContentEditable) return; // notes editor owns its keys
  if (e.key === ' ') { spaceHeld = true; document.body.classList.add('panning'); e.preventDefault(); return; }
  if ((e.ctrlKey || e.metaKey)) {
    const k = e.key.toLowerCase();
    if (k === 'z') { e.preventDefault(); e.shiftKey ? redoDoc() : undoDoc(); }
    else if (k === 'y') { e.preventDefault(); redoDoc(); }
    else if (k === 'c') { e.preventDefault(); copySelection(); }
    else if (k === 'v') { e.preventDefault(); pasteClipboard(); }
    else if (k === 'e') { e.preventDefault(); showExport(e.shiftKey ? 'png' : 'svg'); }
    else if (k === 'x') { e.preventDefault(); cutSelection(); }
    else if (k === 'd') { e.preventDefault(); duplicateSelection(); }
    else if (k === 'i' && e.shiftKey) { e.preventDefault(); invertSelection(); }
    else if (e.key === "'") { e.preventDefault(); toggleGrid(); }
    else if (k === 'o') { e.preventDefault(); e.shiftKey ? showRecent() : openFile(); }
    else if (k === 'g') { e.preventDefault(); e.shiftKey ? ungroupSelection() : groupSelection(); }
    else if (k === 'a') { e.preventDefault(); selectAll(); }
    // physical bracket keys, so the shortcut works on layouts where ] needs AltGr
    else if (e.code === 'BracketRight') { e.preventDefault(); reorder(e.shiftKey ? 'front' : 'up'); }
    else if (e.code === 'BracketLeft') { e.preventDefault(); reorder(e.shiftKey ? 'back' : 'down'); }
    return;
  }
  const tool = !e.altKey && TOOL_KEYS[e.key.toLowerCase()];
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
    case '2': zoomToSelection(); break;
    case '0': $('zoomLabel').click(); break;
    case 'ArrowLeft': case 'ArrowRight': case 'ArrowUp': case 'ArrowDown': {
      const items = state.selection.filter(s => s.seg === undefined).map(s => byId(s.id)).filter(Boolean);
      if (!items.length) break;
      e.preventDefault();
      const dx = (e.key === 'ArrowLeft' ? -GRID : e.key === 'ArrowRight' ? GRID : 0);
      const dy = (e.key === 'ArrowUp' ? -GRID : e.key === 'ArrowDown' ? GRID : 0);
      if (!e.repeat) beginChange(); // a held arrow key is one move
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

// Sidebar rows and the badge draw a name at row size, so KaTeX size commands
// (`$\huge A$`) are dropped; truncation is left to CSS on the rendered text.
const rowHTML = s => inlineHTML(s.split('\n')[0]
  .replace(/\\(tiny|scriptsize|footnotesize|small|normalsize|large|Large|LARGE|huge|Huge)(?![a-zA-Z])/g, ''));

// A line's domain string: its segments' `string` fields concatenated in path
// order. Derived (never stored), so it always reflects the current segments.
const domainString = el => (el.segments || [])
  .slice().sort((a, b) => a.t0 - b.t0).map(s => s.string || '').join('');

// Inline rename on double-click; single click selects.
function sideItem({ depth, name, color, selected, onSelect, onRename, collapsible, collapsed, onToggle, dragRef, ctx, docEdit = true }) {
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
  if (ctx) { // object, segment and group rows: the canvas's right-click menu
    row.addEventListener('contextmenu', e => {
      e.preventDefault();
      if (!selected) onSelect();
      openCtx(e.clientX, e.clientY);
    });
  }
  const label = document.createElement('span');
  label.className = 'side-name';
  label.innerHTML = rowHTML(name); // drawn as on canvas; rename edits the source
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
      input.blur(); // else the sidebar, seeing a focused field, skips the redraw (mid-rename guard)
      if (commit && v !== name && !docEdit) { onRename(v); refresh(); } // library names aren't document data
      else if (commit && v !== name) { beginChange(); onRename(v); changed(); }
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
const saveCollapsed = () => {
  try { localStorage.setItem('master-schemer-collapsed', JSON.stringify([...sideCollapsed])); } catch { /* full */ }
  renderSidebar();
};
function toggleCollapse(key) {
  if (sideCollapsed.has(key)) sideCollapsed.delete(key); else sideCollapsed.add(key);
  saveCollapsed();
}
// Every parent row the sidebar can draw: groups, cards, and paths with segments.
function collapseAll() {
  for (const g of state.doc.groups) sideCollapsed.add(`g:${g.id}`);
  for (const el of state.doc.elements) {
    if (el.type === 'card') sideCollapsed.add(`c:${el.id}`);
    else if (el.segments?.length) sideCollapsed.add(`p:${el.id}`);
  }
  saveCollapsed();
}
function expandAll() { sideCollapsed.clear(); saveCollapsed(); }
$('collapseAll').addEventListener('click', collapseAll);
$('expandAll').addEventListener('click', expandAll);

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
      depth, name: resolveLabel(seg.label || '') || `domain ${i + 1}`, color: resolveColor(seg.color),
      selected: state.selection.some(s => s.id === el.id && s.seg === i),
      onSelect: () => { state.selection = [{ id: el.id, seg: i }]; refresh(); },
      onRename: v => { setLabel(seg, v); }, ctx: true,
    }));
  });
}

function objectItems(els, depth, into) {
  els.forEach(el => {
    const opts = {
      depth, name: displayName(el),
      color: el.color !== undefined ? resolveColor(el.color) : null,
      selected: state.selection.some(s => s.id === el.id && s.seg === undefined),
      onSelect: () => { state.selection = [{ id: el.id }]; refresh(); },
      // a card's name is its title; anything else gets its own `name`, cleared back to the default
      onRename: v => { if (el.type === 'card') { el.title = v; delete el.name; } else if (v.trim()) el.name = v; else delete el.name; },
      dragRef: { kind: 'el', id: el.id }, ctx: true,
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
    dragRef: { kind: 'grp', id: gid }, ctx: true,
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
  const q = $('objFilter').value.trim().toLowerCase();
  if (q) { renderFiltered(body, q); renderLibrary(); return; }
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
      onRename: v => { card.title = v; delete card.name; },
      dragRef: { kind: 'el', id: card.id }, ctx: true,
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
  renderDomains();
  renderLibrary();
}

// ---- domains (named lines and segments, see model.domainKey) ----
// One row per name: its colour, every use. Clicking selects all its uses (so the
// palette colours the domain); double-click renames them all.
function renderDomains() {
  const body = $('domainsBody');
  if (body.contains(document.activeElement)) return; // mid-rename
  body.replaceChildren();
  const byName = new Map();
  for (const u of domainUses()) {
    if (!byName.has(u.key.name)) byName.set(u.key.name, []);
    byName.get(u.key.name).push(u);
  }
  document.body.classList.toggle('no-domains', !byName.size);
  const plain = n => n.replace(/[$\\{}^_]/g, ''); // sort as read: $\alpha$ by "alpha"
  for (const [name, uses] of [...byName].sort((p, q) => plain(p[0]).localeCompare(plain(q[0]), undefined, { numeric: true }))) {
    const shared = state.doc.domains[name];
    const base = uses.find(u => !u.key.comp) || uses[0];
    const refs = uses.map(u => (u.seg !== undefined ? { id: u.el.id, seg: u.seg } : { id: u.el.id }));
    const row = sideItem({
      depth: 0, name,
      color: resolveColor(shared?.color ?? base.obj.color ?? base.el.color),
      selected: refs.every(r => state.selection.some(s => s.id === r.id && s.seg === r.seg)),
      onSelect: () => { state.selection = refs; refresh(); },
      onRename: v => renameDomain(name, v.trim()),
    });
    const comp = uses.find(u => u.key.comp);
    if (comp) {
      const c = document.createElement('span');
      c.className = 'dom-comp';
      c.innerHTML = `/ ${inlineHTML(resolveLabel(comp.obj.label))}`;
      row.querySelector('.side-name').after(c);
    }
    const own = uses.filter(u => u.obj.ownColor).length;
    if (own) {
      const o = document.createElement('span');
      o.className = 'dom-own';
      o.textContent = `${own} own`;
      o.title = `${own} use${own > 1 ? 's keep their' : ' keeps its'} own colour`;
      row.appendChild(o);
    }
    const n = document.createElement('span');
    n.className = 'lib-count';
    n.textContent = uses.length;
    row.appendChild(n);
    row.title = `${shared ? 'Shared colour' : 'No shared colour yet'} — click to select every use, then pick a colour · double-click to rename all`;
    body.appendChild(row);
  }
}

// Rename every use of a domain (a* stays the complement of the new name); its
// shared colour goes along, or gives way to the colour of a name it merges into.
function renameDomain(from, to) {
  if (!to || to === from) return;
  for (const { obj, key } of domainUses()) {
    if (key.name !== from) continue;
    obj.label = !key.comp ? to : key.end && to.endsWith('$') ? to.slice(0, -1) + key.suf + '$' : `${to}*`;
  }
  const doms = state.doc.domains;
  if (doms[from]) { doms[to] ??= doms[from]; delete doms[from]; }
}
// Filter box: a flat list of the groups and objects (cards, tracked objects,
// group members) whose name, label or text matches, matched on both the source
// and its plain text (tags and $ dropped). A strand also matches by a domain label.
function renderFiltered(body, q) {
  const hit = s => !!s && (s.toLowerCase().includes(q) || s.replace(/<\/?\w+>|\$/g, '').toLowerCase().includes(q));
  for (const g of state.doc.groups) {
    if (!hit(g.name || 'group')) continue;
    const members = groupElementMembers(g.id);
    body.appendChild(sideItem({
      depth: 0, name: g.name || 'group', color: null,
      selected: members.length > 0 && members.every(m => state.selection.some(s => s.id === m.id && s.seg === undefined)),
      onSelect: () => { state.selection = members.map(m => ({ id: m.id })); refresh(); },
      onRename: v => { g.name = v; }, dragRef: { kind: 'grp', id: g.id }, ctx: true,
    }));
  }
  const shown = state.doc.elements.filter(el => (el.type === 'card' || el.group || (el.type !== 'arrow' && isSemantic(el))) &&
    (hit(displayName(el)) || hit(resolveLabel(el.label || '')) || hit(el.text) ||
     (el.segments || []).some(seg => hit(resolveLabel(seg.label || '')))));
  objectItems(shown, 0, body);
  if (!body.childElementCount) {
    const p = document.createElement('p');
    p.className = 'muted side-empty';
    p.textContent = 'No objects match.';
    body.appendChild(p);
  }
}
$('objFilter').addEventListener('input', renderSidebar);
$('objFilter').addEventListener('keydown', e => {
  if (e.key === 'Escape') { e.target.value = ''; renderSidebar(); e.target.blur(); }
});

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

// Stock proteins (tools/bake_molecules.py), to scale with DNA drawn on the
// default grid. A DNA-binding protein comes threaded on a strand (a duplex, or
// one strand for SSB), grouped with it; the DNA is a subgroup, so a second
// click selects all of it, to delete. The protein goes last so its near side
// paints over the strands; a bound part (Cas9's sgRNA: m.part) is its own
// object on the same box, after the protein, so it stacks over it.
const MOL_COLORS = { taq: '#e0701f', phi29: '#1f8fa0', ecori: '#c8352e', ligase: '#3a8a3e', igg: '#2f6fd0', ssb: '#d59c12', cas9: '#7a4fd0', sgrna: '#e0701f' };
const DNA_GRAY = '#8a857c';
const molAsset = key => {
  const m = MOLS[key], s = worldPerA(DEFAULT_BPG);
  const w = Math.round(m.w * s), h = Math.round(m.h * s);
  const mol = k => ({
    type: 'rect', id: newId(), x: 0, y: 0, w, h,
    mol: k, color: MOL_COLORS[k] || '#8a857c', width: 0, dnaToon: true, dnaOutline: true,
  });
  const parts = Object.keys(MOLS).filter(k => MOLS[k].part === key);
  const protein = [mol(key), ...parts.map(mol)];
  const name = [m.name, ...parts.map(k => MOLS[k].name)].join(' + ');
  if (!m.front) return { id: newId(), stock: true, name: `${name} (${m.pdb})`, elements: protein, groups: [] };
  const gid = newId(), did = newId(), y = m.axis * w / m.w;
  const L = Math.ceil(w / GRID + 4) * GRID, x0 = (w - L) / 2, x1 = x0 + L; // whole turns, centred
  const strand = pts => ({
    type: 'path', id: newId(), pts, color: DNA_GRAY, width: 2, segments: [], linecap: 'butt',
    dna: true, dnaToon: true, dnaOutline: true, group: did,
  });
  const dna = m.strand === 'ss' ? [strand([[x0, y], [x1, y]])] : [
    strand([[x0, y - 5], [x1, y - 5]]),
    strand([[x1, y + 5], [x0, y + 5]]),
  ];
  if (dna.length === 2) dna.push({ type: 'link', id: newId(), a: { id: dna[0].id }, b: { id: dna[1].id }, style: 'bases', fill: '#2b2622', group: did });
  return {
    id: newId(), stock: true, name: `${name} on DNA (${m.pdb})`,
    elements: [...dna, ...protein.map(el => ({ ...el, group: gid }))],
    groups: [{ id: gid, name: m.name }, { id: did, name: 'DNA', parent: gid }],
  };
};
try {
  const SEED_KEY = 'master-schemer-lib-seeded-mol4'; // bump to reissue the stock set
  if (!localStorage.getItem(SEED_KEY)) {
    // ponytail: replaces the previous stock set wholesale (user edits to it included);
    // sets before `stock` tags are recognised by a protein named "… (PDB)"
    library = library.filter(a => !(a.stock || (a.elements.some(e => e.mol) && /\([0-9A-Z]{4}\)$/.test(a.name))));
    for (const a of library) if (!a.category && /^fluorophore/.test(a.name)) a.category = 'Fluorophores';
    const keys = Object.keys(MOLS).filter(k => !MOLS[k].part);
    library.push(
      ...keys.map(k => ({ ...molAsset(k), category: 'Proteins' })),
      ...keys.map(k => {
        const a = molAsset(k);
        for (const el of a.elements) if (el.mol) { el.molIcon = true; delete el.dnaToon; }
        return { ...a, name: a.name.replace(/ \(\w{4}\)$/, ''), category: 'Protein icons' };
      }),
    );
    localStorage.setItem(SEED_KEY, '1');
    saveLibrary();
  }
} catch { /* storage blocked — skip seeding */ }

// Stock shapes: closed line notes (polygons), so every vertex stays editable.
try {
  const SEED_KEY = 'master-schemer-lib-seeded-shapes1';
  if (!localStorage.getItem(SEED_KEY)) {
    const poly = (name, pts, fill) => ({
      id: newId(), category: 'Shapes', name, groups: [], // (not `stock`: a protein-set reissue drops those)
      elements: [{ type: 'aline', id: newId(), pts, closed: true, color: '#2b2622', width: 1.5, cap0: 'none', cap1: 'none', ...(fill ? { fill } : {}) }],
    });
    const arrow = [[0, 10], [50, 10], [50, 0], [80, 20], [50, 40], [50, 30], [0, 30]];
    library.push(
      poly('block arrow', arrow, '#c9c2b6'),
      poly('block arrow (hollow)', arrow),
      poly('double block arrow (hollow)', [[0, 20], [25, 0], [25, 10], [75, 10], [75, 0], [100, 20], [75, 40], [75, 30], [25, 30], [25, 40]]),
      poly('chevron', [[0, 0], [60, 0], [80, 20], [60, 40], [0, 40], [20, 20]], '#c9c2b6'),
    );
    localStorage.setItem(SEED_KEY, '1');
    saveLibrary();
  }
} catch { /* storage blocked — skip seeding */ }

// Memory-slot refs ('slot:<id>' colours and labels) resolved to plain values, for
// copies leaving the document or a slot going away: read from `palette`/`labels`;
// refs to ids in `keep` stay live.
function freezeRefs(objs, palette = state.doc.palette, labels = state.doc.labelSlots, keep = new Set()) {
  const live = r => typeof r === 'string' && r.startsWith('slot:') && !keep.has(r.slice(5));
  for (const o of objs.flatMap(el => [el, ...(el.segments || [])])) {
    for (const k of ['color', 'fill', 'patternBg', 'labelColor'])
      if (live(o[k])) o[k] = palette.find(sl => `slot:${sl.id}` === o[k])?.color ?? resolveColor(o[k]);
    if (live(o.label)) o.label = labels.find(sl => `slot:${sl.id}` === o.label)?.text ?? '';
  }
}

function assetFromSelection() {
  const c = collectSelection();
  if (!c) {
    $('hint').textContent = 'Select something first, then save it to the library.';
    return;
  }
  const { elements: els, groups } = c;
  freezeRefs(els); // another document won't have these slots
  // the document's label look goes along, baked onto each label
  for (const o of els.flatMap(el => [el, ...(el.segments || [])])) if (o.label) Object.assign(o, labelStyleOf(o));
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
  const added = (srcGroups || []).map(g => {
    const ng = { id: newId(), name: g.name };
    state.doc.groups.push(ng);
    groupMap.set(g.id, ng.id);
    return [g, ng];
  });
  for (const [g, ng] of added) if (groupMap.has(g.parent)) ng.parent = groupMap.get(g.parent); // nesting
  const placed = els.filter(el => {
    if (el.group) el.group = groupMap.get(el.group);
    if (!el.group) delete el.group;
    if (el.type === 'arrow') {
      if (!idMap.has(el.from) || !idMap.has(el.to)) return false;
      el.from = idMap.get(el.from);
      el.to = idMap.get(el.to);
    } else if (el.type === 'link') {
      // keep only if both endpoints came along, then point it at the copies
      for (const k of ['a', 'b']) {
        const r = el[k];
        if (!(r?.id ? idMap.has(r.id) : groupMap.has(r?.group))) return false;
        el[k] = r.id ? { ...r, id: idMap.get(r.id) } : { group: groupMap.get(r.group) };
      }
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

// The selection as standalone copies: cards bring their contents, grouped
// elements bring their whole group (and the groups it nests in), and links
// whose ends all came along come too (a duplex between two copied strands).
function collectSelection() {
  const ids = new Set();
  for (const s of state.selection) {
    if (s.seg !== undefined) continue;
    const el = byId(s.id);
    if (!el) continue;
    ids.add(el.id);
    if (el.type === 'card') for (const c of cardContents(el)) ids.add(c.id);
    if (el.group) for (const m of state.doc.elements) if (m.group === el.group) ids.add(m.id);
  }
  const gids = new Set();
  for (const el of state.doc.elements) if (ids.has(el.id))
    for (let g = el.group && byGroup(el.group); g && !gids.has(g.id); g = g.parent && byGroup(g.parent)) gids.add(g.id);
  const along = r => (r?.id ? ids.has(r.id) : gids.has(r?.group));
  for (const l of state.doc.elements) if (l.type === 'link' && along(l.a) && along(l.b)) ids.add(l.id);
  const els = state.doc.elements.filter(el => ids.has(el.id))
    .map(el => JSON.parse(JSON.stringify(el)));
  if (!els.some(el => el.type !== 'link' && el.type !== 'arrow')) return null; // nothing that pastes on its own
  const groups = state.doc.groups.filter(g => gids.has(g.id)).map(g => ({ ...g }));
  return { elements: els, groups, palette: structuredClone(state.doc.palette), labels: structuredClone(state.doc.labelSlots) };
}

function copySelection() {
  const c = collectSelection();
  if (!c) { $('hint').textContent = 'Select something first, then copy it.'; return false; }
  clipboard = c;
  pasteCount = 0;
  $('hint').textContent = `Copied ${c.elements.length} object${c.elements.length === 1 ? '' : 's'}.`;
  return true;
}

function cutSelection() {
  if (!copySelection()) return;
  // remove what was copied (a group member brings its whole group)
  state.selection = clipboard.elements.filter(el => el.type !== 'link').map(el => ({ id: el.id }));
  deleteSelection();
  pasteCount = -1; // paste lands where the cut was
}

function duplicateSelection() {
  const c = collectSelection();
  if (!c) return;
  beginChange();
  insertElements(c.elements, c.groups, solid => { for (const el of solid) shiftEl(el, GRID, GRID); });
  $('hint').textContent = 'Duplicated.';
}

function pasteClipboard() {
  if (!clipboard) return;
  beginChange();
  const off = GRID * ++pasteCount; // each paste steps further so copies don't stack
  // slots this doc lacks (copied from another one) paste as their copied values
  const els = structuredClone(clipboard.elements);
  freezeRefs(els, clipboard.palette, clipboard.labels,
    new Set([...state.doc.palette, ...state.doc.labelSlots].map(sl => sl.id)));
  insertElements(els, clipboard.groups, solid => {
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
  library.push(...data.assets.map(a => ({ ...a, id: newId() }))); // importing twice mustn't share ids
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
    const stroke = el.color || '#55504a', sw = el.width ?? 2;
    if (el.type === 'ellipse') {
      acc(el.cx - el.rx, el.cy - el.ry); acc(el.cx + el.rx, el.cy + el.ry);
      mk({ tag: 'ellipse', cx: el.cx, cy: el.cy, rx: el.rx, ry: el.ry,
        fill: el.glow ? (el.fill || stroke) : (el.fill || 'none'), stroke: el.glow ? 'none' : stroke, 'stroke-width': sw });
    } else if (MOLS[el.mol]) {
      acc(el.x, el.y); acc(el.x + el.w, el.y + el.h);
      mk({ tag: 'image', href: MOLS[el.mol][el.molIcon ? 'icon' : 'src'], x: el.x, y: el.y, width: el.w, height: el.h,
        filter: tintRef(resolveColor(el.color) || '#8a857c', !!el.dnaToon) });
    } else if (el.type === 'rect' || el.type === 'card') {
      acc(el.x, el.y); acc(el.x + el.w, el.y + el.h);
      mk({ tag: 'rect', x: el.x, y: el.y, width: el.w, height: el.h, rx: el.r || 0,
        fill: el.type === 'card' ? (el.fill || '#ffffff') : (el.fill || 'none'), stroke, 'stroke-width': sw });
    } else if (Array.isArray(el.pts) && el.pts.length) {
      for (const p of el.pts) acc(p[0], p[1]);
      if (el.type === 'aline') mk({ tag: 'path', d: alineD(el), fill: el.closed && el.fill || 'none', stroke, 'stroke-width': sw });
      else mk({ tag: 'polyline', points: drawnPts(el).map(p => p.join(',')).join(' '), fill: 'none', stroke, 'stroke-width': sw });
    }
  }
  if (!isFinite(x0)) { x0 = 0; y0 = 0; x1 = 1; y1 = 1; }
  const pad = Math.max(4, (x1 - x0 + y1 - y0) * 0.08);
  svgt.setAttribute('viewBox', `${x0 - pad} ${y0 - pad} ${x1 - x0 + 2 * pad} ${y1 - y0 + 2 * pad}`);
  return svgt;
}

// Library categories, collapsible; an asset without one is the user's own.
// Drag an entry onto a heading to move it there; double-click a heading to rename it.
const MY_ASSETS = 'My assets';
const catOf = a => a.category || MY_ASSETS;
let libOpen = new Set([MY_ASSETS]);
try { libOpen = new Set(JSON.parse(localStorage.getItem('master-schemer-lib-open')) || [MY_ASSETS]); } catch { /* defaults */ }
function toggleLibCat(cat) {
  if (libOpen.has(cat)) libOpen.delete(cat); else libOpen.add(cat);
  try { localStorage.setItem('master-schemer-lib-open', JSON.stringify([...libOpen])); } catch { /* full */ }
  renderLibrary();
}

function renderLibrary() {
  const body = $('libraryBody');
  if (body.contains(document.activeElement)) return; // mid-rename
  body.replaceChildren();
  const cats = [...new Set([MY_ASSETS, ...library.map(catOf)])];
  for (const cat of cats) {
    const assets = library.filter(a => catOf(a) === cat);
    const head = sideItem({
      depth: 0, name: cat, color: null, selected: false,
      collapsible: true, collapsed: !libOpen.has(cat), onToggle: () => toggleLibCat(cat),
      onSelect: () => toggleLibCat(cat),
      onRename: v => {
        for (const a of assets) { if (v.trim() && v !== MY_ASSETS) a.category = v.trim(); else delete a.category; }
        if (libOpen.delete(cat)) libOpen.add(v.trim() || MY_ASSETS);
        saveLibrary();
      },
      docEdit: false,
    });
    head.classList.add('lib-cat');
    const count = document.createElement('span');
    count.className = 'lib-count';
    count.textContent = assets.length;
    head.appendChild(count);
    head.title = 'Click to open or close · double-click to rename · drop an entry here to move it';
    head.addEventListener('dragover', e => {
      if (e.dataTransfer.types.includes('text/asset-id')) { e.preventDefault(); head.classList.add('lib-drop'); }
    });
    head.addEventListener('dragleave', () => head.classList.remove('lib-drop'));
    head.addEventListener('drop', e => {
      e.preventDefault();
      const a = library.find(x => x.id === e.dataTransfer.getData('text/asset-id'));
      if (!a) return;
      if (cat === MY_ASSETS) delete a.category; else a.category = cat;
      saveLibrary();
      renderLibrary();
    });
    body.appendChild(head);
    if (!libOpen.has(cat)) continue;
    if (!assets.length) {
      const p = document.createElement('p');
      p.className = 'muted side-empty';
      p.textContent = 'Save a selection to keep it here.';
      body.appendChild(p);
    }
    for (const asset of assets) {
      const row = sideItem({
        depth: 1, name: asset.name || 'asset', color: null, selected: false,
        onSelect: () => placeAsset(asset),
        onRename: v => { asset.name = v; saveLibrary(); }, docEdit: false,
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

// A view of el whose `color` is its fill, for the palette to paint (patterns pass through).
const asFill = el => new Proxy(el, {
  get: (o, k) => o[k === 'color' ? 'fill' : k],
  set: (o, k, v) => { o[k === 'color' ? 'fill' : k] = v; return true; },
});

// A named domain's colour, for the palette to paint: writes go to the name
// (doc.domains), so every use follows; reads fall back to this use. A new name
// starts from this use's pattern, so colouring it doesn't strip one.
function domainTarget(use) {
  const name = domainKey(use.label).name, doms = state.doc.domains;
  return new Proxy(use, {
    get: (o, k) => (k === 'domain' ? name : doms[name]?.[k] ?? (k === 'color' || !doms[name] ? o[k] : undefined)),
    set: (o, k, v) => {
      doms[name] ||= Object.fromEntries(['pattern', 'patternBg', 'patternScale'].filter(p => o[p] !== undefined).map(p => [p, o[p]]));
      doms[name][k] = v;
      return true;
    },
    deleteProperty: (o, k) => { delete doms[name]?.[k]; return true; },
  });
}
// a line or segment labelled as a domain is coloured through its name
const viaDomain = o => (o && domainKey(o.label) && !o.ownColor && (o.type === 'path' || o.type === undefined) ? domainTarget(o) : o);

// Every color target in the current selection (elements and segments).
function colorTargets() {
  const out = [];
  for (const s of state.selection) {
    const el = byId(s.id);
    if (!el) continue;
    if (s.seg !== undefined) { const seg = el.segments?.[s.seg]; if (seg) out.push(viaDomain(seg)); }
    else if (duplexLink(el)) {
      // a duplex wears its strands' colours; with one backbone's picker open, just that one
      const one = openPicker?.key.match(`^bb:${el.id}:([ab])$`)?.[1];
      out.push(...[...new Set(one ? [backbone(el[one])] : [backbone(el.a), backbone(el.b)])].map(viaDomain));
    }
    else if (el.type === 'path') out.push(viaDomain(el));
    else if (el.color !== undefined) out.push(el);
    else if (el.type === 'link') out.push(asFill(el)); // a link's colour is its fill
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
    // an open backbone picker follows the swatch it just took
    if (openPicker?.key.startsWith('bb:')) Object.assign(openPicker, hexToHsv(resolveColor(c)) || {});
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
  for (const d of Object.values(state.doc.domains)) push(d); // their uses take it from there
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
  sec.className = 'panel-section sec-color';
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
      syncDomains(); // a domain's other uses follow live
      render();
    }, { begin: () => { if (colorTargets().length) beginChange(); } }), // no selection: just the pen colour
    changed);
  sec.appendChild(fieldRow('Custom color', mainPick));

  // memory slots: elements store slot:<id>, so editing a slot recolors them all.
  // Click applies the slot (to the selection, else to what you draw next);
  // double-click opens its editor. Slots are draggable to reorder.
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
    b.title = `${slot.name || 'slot'} — click to apply, double-click to edit, drag to reorder`;
    if (currentColor() === `slot:${slot.id}`) b.setAttribute('aria-pressed', 'true');
    b.addEventListener('click', () => { activeSlot = slot.id; applyColor(`slot:${slot.id}`, slot); });
    b.addEventListener('dblclick', () => openSlotEditor(slot.id));
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
  const themes = smallButton('Themes…', showThemes, 'Recolor the memory slots from a color theme');
  themes.classList.add('themes-btn');
  sec.appendChild(themes);

  const slot = state.doc.palette.find(s => s.id === activeSlot);
  if (slot) {
    sec.appendChild(fieldRow(`Slot: ${slot.name || 'slot'}`, smallButton('Edit slot…', () => openSlotEditor(slot.id),
      'Change this slot’s colour + pattern — everything using it follows')));
  }
  // say when a colour goes to whole domains, not just the selected pieces
  const names = [...new Set(colorTargets().map(t => t.domain).filter(Boolean))];
  if (names.length) {
    const p = document.createElement('p');
    p.className = 'muted domain-note';
    p.innerHTML = `Colours every domain named ${names.slice(0, 3).map(n => `<b>${inlineHTML(n)}</b>`).join(', ')}` +
      `${names.length > 3 ? '…' : ''} (complements a lighter shade).`;
    sec.appendChild(p);
  }
  return sec;
}

// ---- color themes popup ----
// Applying a theme recolors the slots in order (so everything drawn with slot
// colors re-themes at once) and adds slots when the theme has more colors.
// Slots beyond the theme's length keep their color.
function applyTheme(t) {
  beginChange();
  t.colors.forEach((color, i) => {
    const slot = state.doc.palette[i];
    if (slot) slot.color = color;
    else state.doc.palette.push({ id: newId(), name: `slot ${i + 1}`, color });
  });
  changed();
}
function closeThemes() { $('themes-modal')?.remove(); }
function showThemes() {
  closeThemes();
  const overlay = document.createElement('div');
  overlay.id = 'themes-modal';
  overlay.className = 'modal-overlay';
  overlay.addEventListener('pointerdown', e => { if (e.target === overlay) closeThemes(); });
  const card = document.createElement('div');
  card.className = 'modal-card themes-card';
  const head = document.createElement('div');
  head.className = 'modal-head';
  const h = document.createElement('h2');
  h.textContent = 'Color themes';
  const x = document.createElement('button');
  x.className = 'modal-close';
  x.textContent = '✕';
  x.title = 'Close';
  x.addEventListener('click', closeThemes);
  head.append(h, x);
  const note = document.createElement('p');
  note.className = 'muted';
  note.textContent = 'Recolors the memory slots in order. Anything drawn with a slot color updates; extra slots keep theirs.';
  const list = document.createElement('div');
  list.className = 'themes-list';
  for (const t of THEMES) {
    const b = document.createElement('button');
    b.className = 'theme-tile';
    const name = document.createElement('span');
    name.className = 'theme-name';
    name.textContent = `${t.name} · ${t.colors.length}`;
    const strip = document.createElement('span');
    strip.className = 'theme-strip';
    for (const c of t.colors) {
      const sw = document.createElement('span');
      sw.style.background = c;
      sw.title = c;
      strip.appendChild(sw);
    }
    b.append(name, strip);
    b.addEventListener('click', () => { applyTheme(t); closeThemes(); });
    list.appendChild(b);
  }
  card.append(head, note, list);
  overlay.appendChild(card);
  document.body.appendChild(overlay);
  list.querySelector('.theme-tile')?.focus();
}
window.addEventListener('keydown', e => { if (e.key === 'Escape' && $('themes-modal')) closeThemes(); });
window.addEventListener('keydown', e => { if (e.key === 'Escape' && slotModal) closeSlotEditor(); });

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
    Object.assign(hexv => { slot.color = hexv; syncDomains(); render(); }, { begin: beginChange }),
    changed, renderSlotModal);
  const del = document.createElement('button');
  del.className = 'btn danger';
  del.textContent = 'Remove slot';
  del.addEventListener('click', () => {
    beginChange();
    // freeze current colour into every user of the slot before removing it
    const frozen = slot.color;
    freezeRefs([...state.doc.elements, ...state.doc.palette, ...Object.values(state.doc.domains)], undefined, undefined,
      new Set([...state.doc.palette, ...state.doc.labelSlots].map(sl => sl.id).filter(id => id !== slot.id)));
    for (const l of state.doc.labelSlots) if (l.colorSlot === slot.id) delete l.colorSlot;
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

// What class of thing is selected: primary (strands and their domains),
// structure (cards, connections, links), annotation, or a group.
const KIND = {
  path: ['primary', 'Strand'], card: ['structure', 'Section card'], arrow: ['structure', 'Connection'],
  link: ['structure', 'Link'], text: ['annotation', 'Text note'], ellipse: ['annotation', 'Ellipse'],
  rect: ['annotation', 'Rectangle'], ink: ['annotation', 'Freehand'],
};
const kindOf = el => MOLS[el.mol] ? ['annotation', `${MOLS[el.mol].name} · PDB ${MOLS[el.mol].pdb}`] : el.type === 'aline'
  ? ['annotation', kindWord(el) === 'arrow' ? 'Arrow' : 'Line']
  : KIND[el.type] || ['annotation', el.type];
const CLASS_NAME = { primary: 'Primary object', structure: 'Structure', annotation: 'Annotation', group: 'Group' };

function selectedGroup(n) {
  const wholly = whollySelectedGroups();
  const tops = [...wholly].filter(gid => !wholly.has(byGroup(gid).parent));
  return tops.length === 1 && groupElementMembers(tops[0]).length === n ? byGroup(tops[0]) : null;
}

function kindBadge(single, n) {
  if (!n) return null;
  let cls, kind, detail = '';
  const name = displayName;
  const grp = !single || single.seg === undefined ? selectedGroup(n) : null;
  if (grp) {
    cls = 'group'; kind = grp.name; detail = `${n} object${n === 1 ? '' : 's'}`;
  } else if (single?.seg !== undefined) {
    cls = 'primary'; kind = 'Domain';
    detail = `domain ${single.seg + 1} of ${name(single.el)}`;
  } else if (single) {
    [cls, kind] = kindOf(single.el);
    detail = name(single.el);
    if (cls === 'annotation' && isSemantic(single.el)) detail += ' · tracked';
  } else {
    const counts = {};
    for (const el of selectedElements()) { const c = kindOf(el)[0]; counts[c] = (counts[c] || 0) + 1; }
    const keys = Object.keys(counts);
    cls = keys.length === 1 ? keys[0] : 'mixed';
    kind = `${n} objects`;
    detail = keys.map(k => `${counts[k]} ${k}`).join(' · ');
  }
  const box = document.createElement('div');
  box.className = `kind-badge kind-${cls}`;
  const tag = document.createElement('span');
  tag.className = 'kind-class';
  tag.textContent = cls === 'mixed' ? 'Mixed selection' : CLASS_NAME[cls];
  const k = document.createElement('strong');
  k.textContent = kind;
  const d = document.createElement('span');
  d.className = 'kind-detail';
  d.innerHTML = rowHTML(detail);
  box.append(tag, k, d);
  return box;
}

function sectionTitle(text) {
  const h = document.createElement('h2');
  h.textContent = text;
  return h;
}

// Label editor with shared-label slots: attach the element to a slot and one
// edit renames every element pointing at it.
// domain: the target is a line or segment, so its label names a domain (see domainKey)
function labelFields(target, placeholder, domain = false) {
  const frag = document.createDocumentFragment();
  const src = boundInput(() => resolveLabel(target.label || ''), v => setLabel(target, v), { placeholder });
  src.classList.add('fmt-src'); // the text toolbar formats its selection
  frag.appendChild(fieldRow('Label', src));
  const key = domain && domainKey(target.label);
  if (!key) return frag;
  frag.appendChild(checkboxRow('Colour shared by name', () => !target.ownColor, v => {
    if (v) delete target.ownColor; else target.ownColor = true;
  }));
  const p = document.createElement('p');
  p.className = 'muted';
  p.innerHTML = target.ownColor ? 'This one keeps its own colour.'
    : `Every <b>${inlineHTML(key.name)}</b> shares one colour, its complements a lighter shade — listed under Domains.`;
  frag.appendChild(p);
  return frag;
}

// A fill's colour: the picker, plus the document's memory slots, so a fill can
// follow a slot (and so a theme) the way a stroke does. A slot's pattern comes
// along where the fill takes patterns.
function fillPicker(el, def, pattern = true) {
  const box = document.createElement('div');
  box.appendChild(colorPicker(`fill:${el.id}`,
    () => { const h = resolveColor(el.fill); return /^#[0-9a-f]{6}$/i.test(h || '') ? h : def; },
    Object.assign(hex => { el.fill = hex; render(); }, { begin: beginChange }),
    changed));
  if (!state.doc.palette.length) return box;
  const row = document.createElement('div');
  row.className = 'swatches fill-slots';
  for (const slot of state.doc.palette) {
    const b = document.createElement('button');
    b.className = 'swatch';
    paintSwatch(b, slot);
    b.title = `${slot.name || 'Memory slot'} — follows the slot`;
    b.setAttribute('aria-label', b.title);
    if (el.fill === `slot:${slot.id}`) b.setAttribute('aria-pressed', 'true');
    b.addEventListener('click', () => {
      beginChange();
      el.fill = `slot:${slot.id}`;
      if (pattern && slot.pattern && slot.pattern !== 'none') {
        el.pattern = slot.pattern;
        if (slot.patternBg) el.patternBg = slot.patternBg; else delete el.patternBg;
        if (slot.patternScale != null) el.patternScale = slot.patternScale; else delete el.patternScale;
      }
      changed();
    });
    row.appendChild(b);
  }
  box.appendChild(row);
  return box;
}

// Fill toggle + colour for closed shapes (rect/ellipse) and links.
function fillControl(el, { label = 'Fill', optional = true, pattern = true } = {}) {
  const frag = document.createDocumentFragment();
  if (optional) {
    frag.appendChild(checkboxRow(label, () => !!el.fill, v => {
      if (v) el.fill = el.color || currentColor() || '#c9c2b6'; // a slot ref stays one: the fill follows the slot
      else delete el.fill;
    }));
  }
  if (el.fill || !optional) {
    frag.appendChild(fieldRow(`${label} colour`, fillPicker(el, '#c9c2b6', pattern)));
    if (pattern) frag.appendChild(patternControls(el, `fill:${el.id}`));
  }
  return frag;
}

// A flip checkbox for each end cap that has a side or a direction: a harpoon's
// barb goes to the other side (capNflip), a pointed head turns around (capNrev). Then the head size
// (el.capSize, both ends; 0 = from the line width).
function capOptions(el) {
  const frag = document.createDocumentFragment();
  for (const [k, end] of [['cap0', 'start'], ['cap1', 'end']]) {
    const cap = el[k], f = cap === 'harpoon' ? `${k}flip` : `${k}rev`;
    if (cap !== 'harpoon' && !POINTED_CAPS.includes(cap)) continue;
    frag.appendChild(checkboxRow(cap === 'harpoon' ? `Flip ${end} harpoon` : `Reverse ${end} head`, () => !!el[f], v => {
      if (v) el[f] = true; else delete el[f];
    }));
  }
  if ((el.cap0 || 'none') !== 'none' || (el.cap1 || 'none') !== 'none') {
    frag.appendChild(fieldRow('Cap size (0 = auto)', sliderNum(
      () => el.capSize || 0,
      v => { if (v) el.capSize = v; else delete el.capSize; },
      { min: 0, max: 60, step: 0.5 })));
  }
  return frag;
}

// Fill opacity for a filled shape (el.fillOpacity; absent = opaque).
const fillOpacityRow = el => fieldRow('Fill opacity', rangeControl(
  () => el.fillOpacity ?? 1,
  v => { if (v >= 1) delete el.fillOpacity; else el.fillOpacity = v; },
  { min: 0, max: 1, step: 0.05 }));

// Smooth (curve through the vertices) on/off. A strand's domains keep their
// place in proportion, since the curve is longer than the polyline; a line
// note's single bend handle becomes a vertex on the curve and back.
function setSmooth(el, v) {
  if (el.type === 'aline' && el.pts.length === 3 && !el.closed) {
    const [a, m, b] = el.pts, r1 = x => Math.round(x * 10) / 10;
    el.pts = v ? [a, alineMid(el.pts).map(r1), b] // control → the curve's midpoint
      : [a, [r1(2 * m[0] - (a[0] + b[0]) / 2), r1(2 * m[1] - (a[1] + b[1]) / 2)], b];
  }
  const L0 = polylineLength(drawnPts(el));
  if (v) el.smooth = true; else delete el.smooth;
  const k = polylineLength(drawnPts(el)) / L0;
  if (el.type === 'path' && L0 && k !== 1) {
    for (const sg of el.segments || []) { sg.t0 = Math.round(sg.t0 * k * 10) / 10; sg.t1 = Math.round(sg.t1 * k * 10) / 10; }
  }
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

// Label size, weight and colour. `get` gives the style in effect, `put(k, v)`
// stores one key and `reset` (offered when `own` says there is something to
// clear) clears them; dflt is the built-in look (size, colour).
const WEIGHTS = { 400: 'Regular', 600: 'Semibold', 700: 'Bold' };
function labelStyleControls(key, get, put, own, reset, dflt) {
  const frag = document.createDocumentFragment();
  frag.appendChild(fieldRow('Label size', numberControl(() => get().labelSize || dflt.size, v => put('labelSize', v),
    { min: 4, max: 144, step: 0.5 })));
  frag.appendChild(fieldRow('Label weight', mappedSelect(WEIGHTS, () => String(get().labelWeight || 600),
    v => put('labelWeight', +v))));
  frag.appendChild(fieldRow('Label colour', colorPicker(key,
    () => (get().labelColor ? resolveColor(get().labelColor) : dflt.color),
    Object.assign(hex => { put('labelColor', hex); render(); }, { begin: beginChange }), changed)));
  if (own()) {
    frag.appendChild(smallButton('Reset label style', () => { beginChange(); reset(); changed(); },
      'Clear this label style'));
  }
  return frag;
}

// One element's or segment's label style.
function labelStyleFields(owner, key, dflt) {
  if (!resolveLabel(owner.label || '')) return document.createDocumentFragment();
  return labelStyleControls(key, () => labelStyleOf(owner), (k, v) => { owner[k] = v; },
    () => LABEL_STYLE_KEYS.some(k => owner[k] !== undefined),
    () => { for (const k of LABEL_STYLE_KEYS) delete owner[k]; }, dflt);
}

// The document-wide label style (doc.labelStyle): every label without its own.
function docLabelStyleFields() {
  const st = () => state.doc.labelStyle || {};
  return labelStyleControls('lab:doc', st,
    (k, v) => { (state.doc.labelStyle ||= {})[k] = v; },
    () => !!state.doc.labelStyle, () => { delete state.doc.labelStyle; }, { size: 12, color: '#2b2622' });
}

// ---- DNA strands ----

// What a duplex backbone takes its colour from: the paired segment, or the
// whole line when the link is to the line.
const backbone = ref => {
  const st = byId(ref.id);
  return ref.seg !== undefined && st.segments?.[ref.seg] ? st.segments[ref.seg] : st;
};
// A DNA line's size is its diameter (world units); its bases are counted per
// span: paired domains take the duplex's count, segments may carry their own,
// and the rest of the strand shares el.bases (unset = natural B-DNA spacing).

// Turn lines into DNA strands (or back). A new strand takes its base-pair
// partner's diameter (so the duplex between them comes out round), else
// follows the DNA grid.
// What the Strand tool draws: any Draw as look (LOOKS). A drawing default
// (like width), so it changes no document and makes no undo step.
const NEW_LOOK_KEY = 'master-schemer-new-strand-look';
try { state.drawLook = localStorage.getItem(NEW_LOOK_KEY) || 'line'; } catch { /* lines */ }
function newStrandSelect() {
  const node = document.createElement('select');
  for (const [v, t] of Object.entries(LOOKS)) node.add(new Option(t, v));
  node.value = state.drawLook;
  node.addEventListener('change', () => {
    state.drawLook = node.value;
    try { localStorage.setItem(NEW_LOOK_KEY, node.value); } catch { /* full */ }
  });
  return node;
}

function setDNA(els, on) {
  for (const el of els) {
    if (!on) { delete el.dna; continue; }
    if (el.dna) continue;
    const l = state.doc.elements.find(x => x.type === 'link' && x.style === 'bases' &&
      (x.a?.id === el.id || x.b?.id === el.id));
    const other = l && byId(l.a.id === el.id ? l.b.id : l.a.id);
    el.dna = typeof other?.dna === 'number' ? other.dna : true;
    el.dnaToon ??= true; el.dnaOutline ??= true; // new strands start toon + outline; a past choice stays
  }
}

// A strand's own Draw as (what View → Draw Strands → As Each Strand Is Set shows).
const ownLook = el => (el.seqLook ? 'seq' : el.dna ? 'dna' : 'line');
const LOOKS = { line: 'Line', dna: 'DNA molecule', seq: 'Sequence (letters)' };
function setLook(els, look) {
  for (const el of els) {
    if (look === 'seq') { el.seqLook = true; delete el.dna; continue; }
    delete el.seqLook;
    setDNA([el], look === 'dna');
  }
}
// Per-strand drawing toggles (one strand or several): junction ticks (plain lines
// only) and labels that follow the strand's contour.
function strandToggles(paths, lines) {
  const frag = document.createDocumentFragment();
  const toggle = (text, key) => frag.appendChild(checkboxRow(text, () => paths.every(p => p[key]), v => {
    for (const p of paths) { if (v) p[key] = true; else delete p[key]; }
  }));
  if (lines) toggle('Ticks at domain junctions', 'ticks');
  toggle('Labels follow the strand', 'labelsFollow');
  return frag;
}
// While View → Draw Strands overrides every strand, say so where its own setting is edited.
function lookNote() {
  const p = document.createElement('p');
  p.className = 'muted';
  p.textContent = `Shown as ${{ line: 'lines', dna: 'DNA molecules', seq: 'sequences' }[strandView.mode]} for now: View → Draw Strands is set to all strands.`;
  return p;
}

// Back onto the DNA grid: grid diameter, and every count — the strands' own,
// their segments', their duplexes' — back to what the drawn length gives.
function snapDNA(els) {
  beginChange();
  for (const el of els) {
    el.dna = true;
    delete el.bases;
    for (const sg of el.segments || []) delete sg.bases;
    for (const l of state.doc.elements) {
      if (l.type === 'link' && (l.a?.id === el.id || l.b?.id === el.id)) delete l.bases;
    }
  }
  changed();
}

// A strand's own sequence (5′→3′, domains' sequences override it where they
// sit), with how its base count compares to what the drawn length holds.
function sequenceField(el) {
  const frag = document.createDocumentFragment();
  const note = document.createElement('p');
  note.className = 'muted';
  const say = () => {
    const n = dnaLayout(el).n, fit = naturalBases(polylineLength(drawnPts(el)), gridPitch(dnaBpg()));
    const bad = (el.seq || '').trim() && !seqLetters(el.seq);
    note.textContent = bad ? 'Not a sequence (A C G T U N only) — kept as text.'
      : n === fit ? `${n} nt — fits the drawn length.`
        : `${n} nt — the drawn length holds ${fit}. Grid → Resize Strands to Grid.`;
  };
  frag.appendChild(fieldRow('Sequence', boundInput(() => el.seq || '', v => {
    if (v.trim()) el.seq = v; else delete el.seq;
    say();
  }, { textarea: true, placeholder: '5′→3′, e.g. ATGCATGATCG' })));
  say();
  frag.appendChild(note);
  return frag;
}

// Grid → Resize Strands to Grid: lengthen or shorten each selected strand (or,
// with nothing selected, every strand with a sequence) at its 3′ end so its
// bases sit at the grid's spacing: n bases = n / (bases per square) squares.
// The 5′ end and corners stay — unless the change is more than the last leg can
// take (e.g. after changing the scale), when the whole shape scales about its 5′ end.
// ponytail: fits the whole strand; a domain with its own count stays as squeezed as it was.
function fitToSequence() {
  const sel = selectedElements();
  const els = sel.length ? sel.filter(el => el.type === 'path')
    : state.doc.elements.filter(el => el.type === 'path' && dnaLayout(el).n !== naturalBases(polylineLength(drawnPts(el)), gridPitch(dnaBpg()))
      && (seqLetters(el.seq) || (el.segments || []).some(s => seqOf(s.string))));
  if (!els.length) return;
  beginChange();
  for (const el of els) {
    const L = polylineLength(drawnPts(el)), want = dnaLayout(el).n * gridPitch(dnaBpg());
    if (Math.abs(want - L) < 0.01) continue;
    const z = el.pts[el.pts.length - 1], y = el.pts[el.pts.length - 2];
    const leg = Math.hypot(z[0] - y[0], z[1] - y[1]), r3 = v => Math.round(v * 1000) / 1000;
    if (Math.abs(want - L) >= leg || el.smooth) { // (a smooth curve scales exactly: always this way) // more than the last leg can take: scale the whole shape about its 5′ end
      const k = want / L, o = el.pts[0];
      el.pts = el.pts.map(p => [r3(o[0] + (p[0] - o[0]) * k), r3(o[1] + (p[1] - o[1]) * k)]);
      el.segments = (el.segments || []).map(sg => ({ ...sg, t0: sg.t0 * k, t1: sg.t1 * k }));
      continue;
    }
    if (want < L) el.pts = subPath(el.pts, 0, want);
    else el.pts[el.pts.length - 1] = [r3(z[0] + (z[0] - y[0]) * (want - L) / leg), r3(z[1] + (z[1] - y[1]) * (want - L) / leg)];
    const n0 = (el.segments || []).length;
    el.segments = resizeEndSegments(el.segments, L, polylineLength(el.pts), 1);
    if (el.segments.kept.length < n0) remapSegLinks(el.id, el.segments.kept);
  }
  changed();
}

// Grid → scale: the document's bases per grid square.
function setBpg(n) {
  if (n === dnaBpg()) return;
  beginChange();
  if (n === DEFAULT_BPG) delete state.doc.dnaBpg; else state.doc.dnaBpg = n;
  changed();
}

const BPG_CHOICES = [1, 2, 4, 5, 6, 8, 10, 12, 15, 20];
{
  const after = $('bpgAfter');
  for (const n of [...BPG_CHOICES].reverse()) {
    const b = document.createElement('button');
    b.setAttribute('role', 'menuitemradio');
    b.dataset.bpg = n;
    b.textContent = `${n} ${n === 1 ? 'Base' : 'Bases'} per Square${n === 10 ? ' (1 Turn)' : n === 20 ? ' (2 Turns)' : ''}`;
    after.after(b);
  }
}
// The document's DNA grid: how many bases one grid square holds.
function dnaGridControl() {
  const map = Object.fromEntries(BPG_CHOICES.map(n =>
    [n, `${n} bp per square${n === 10 ? ' (1 turn)' : n === 20 ? ' (2 turns)' : n === 5 ? ' (½ turn)' : ''}`]));
  return fieldRow('DNA grid', mappedSelect(map, () => String(dnaBpg()), v => {
    if (+v === DEFAULT_BPG) delete state.doc.dnaBpg; else state.doc.dnaBpg = +v;
  }));
}

// Look of one or more DNA strands: shading, outline, and what the colour means.
function dnaStyleControls(els) {
  const frag = document.createDocumentFragment();
  const first = els[0];
  const setAll = (k, v) => { for (const el of els) { if (v) el[k] = v; else delete el[k]; } };
  frag.appendChild(fieldRow('Model', mappedSelect({ space: 'Space-filling', ribbon: 'Ribbon + bases' },
    () => first.dnaSkin || 'space', v => setAll('dnaSkin', v === 'space' ? null : v))));
  frag.appendChild(fieldRow('Shading', mappedSelect({ soft: 'Soft (rendered)', toon: 'Toon (flat bands)' },
    () => (toon(first) ? 'toon' : 'soft'), v => { for (const el of els) el.dnaToon = v === 'toon'; })));
  frag.appendChild(checkboxRow('Black outline', () => outlined(first), v => { for (const el of els) el.dnaOutline = v; }));
  frag.appendChild(fieldRow('Colour by', mappedSelect(
    { strand: 'Strand colour', bases: 'Backbone + bases', sequence: 'Sequence (A C G T)' },
    () => first.dnaColor || 'strand', v => setAll('dnaColor', v === 'strand' ? null : v))));
  if (first.dnaColor === 'bases') {
    frag.appendChild(fieldRow('Base colour', colorPicker(`bases:${first.id}`,
      () => (/^#[0-9a-f]{6}$/i.test(first.baseColor || '') ? first.baseColor : '#f1ece2'),
      Object.assign(hex => { for (const el of els) el.baseColor = hex; render(); }, { begin: beginChange }),
      changed)));
  }
  if (first.dnaColor === 'sequence') {
    frag.appendChild(fieldRow('Unsequenced', mappedSelect({ plain: 'Base colour', random: 'Random bases' },
      () => first.seqUnknown || 'plain', v => setAll('seqUnknown', v === 'random' ? v : null))));
    if (first.seqUnknown !== 'random') {
      frag.appendChild(fieldRow('Base colour', colorPicker(`bases:${first.id}`,
        () => (/^#[0-9a-f]{6}$/i.test(first.baseColor || '') ? first.baseColor : '#f1ece2'),
        Object.assign(hex => { for (const el of els) el.baseColor = hex; render(); }, { begin: beginChange }),
        changed)));
    }
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = 'A green · C blue · G amber · T red. A segment whose String is a sequence (ACGT/U, '
      + '4+ letters; N = unknown) shows it and gets exactly that many bases. Paired bases without '
      + 'their own sequence show their partner’s complement.';
    frag.appendChild(p);
  }
  return frag;
}

// Base-count field; clearing it returns to auto (the DNA grid's count).
function basesInput(get, set, { auto = false, readOnly = false } = {}) {
  const n = document.createElement('input');
  n.type = 'number'; n.min = 1; n.max = 10000; n.step = 1;
  n.value = get();
  n.readOnly = readOnly;
  if (auto) n.classList.add('auto');
  n.title = readOnly ? 'Set by the strand’s domains' : 'Number of bases — clear to go back to the DNA grid';
  n.addEventListener('change', () => {
    beginChange();
    set(n.value === '' ? null : clamp(Math.round(+n.value) || 1, 1, 10000));
    changed();
  });
  return n;
}

// How a span's count relates to the grid and to natural B-DNA proportions,
// plus a one-click way back to the grid.
function spacingNote(len, n, D, auto, reset, what = 'bases') {
  const frag = document.createDocumentFragment();
  const p = document.createElement('p');
  p.className = 'muted';
  const s = spacing(len, n, D);
  const look = Math.abs(s - 1) < 0.04 ? 'natural B-DNA proportions'
    : `${s.toFixed(2)}× natural spacing (${s > 1 ? 'stretched' : 'compressed'})`;
  p.textContent = auto ? `Auto from the DNA grid (${dnaBpg()} bp per square) — ${look}.` : `${n} ${what} — ${look}.`;
  frag.appendChild(p);
  if (!auto) frag.appendChild(smallButton('Back to grid count', () => { beginChange(); reset(); changed(); },
    'Let the drawn length decide the base count again'));
  return frag;
}

function dnaControls(el) {
  const frag = document.createDocumentFragment();
  frag.appendChild(fieldRow('Diameter', sliderNum(() => +diam(el).toFixed(1),
    v => { el.dna = v; }, { min: 4, max: 80, step: 0.5 })));
  const lay = dnaLayout(el);
  const fixedN = lay.n - lay.free;
  frag.appendChild(fieldRow('Bases', basesInput(() => lay.n,
    v => { if (v === null) delete el.bases; else el.bases = Math.max(0, v - fixedN); },
    { auto: el.bases === undefined, readOnly: !lay.freeLen || (el.bases === undefined && !!seqLetters(el.seq)) })));
  if (lay.freeLen && el.bases === undefined && seqLetters(el.seq)) {
    frag.appendChild(seqNote());
  } else if (!lay.freeLen) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = `All ${lay.n} bases are set by its domains and base pairing.`;
    frag.appendChild(p);
  } else {
    frag.appendChild(spacingNote(lay.freeLen, lay.free, diam(el), el.bases === undefined, () => delete el.bases,
      fixedN ? 'unpaired bases' : 'bases'));
    if (fixedN) {
      const p = document.createElement('p');
      p.className = 'muted';
      p.textContent = `${fixedN} of them set by domains and base pairing.`;
      frag.appendChild(p);
    }
  }
  frag.appendChild(dnaGridRow([el]));
  frag.appendChild(dnaStyleControls([el]));
  return frag;
}

// DNA grid setting + the snap button that puts strands back on it.
function dnaGridRow(els) {
  const frag = document.createDocumentFragment();
  frag.appendChild(dnaGridControl());
  const off = els.some(el => typeof el.dna === 'number' || el.bases !== undefined ||
    (el.segments || []).some(sg => sg.bases) ||
    state.doc.elements.some(l => l.type === 'link' && l.bases && duplexLink(l) && (l.a.id === el.id || l.b.id === el.id)));
  const b = smallButton(off ? 'Snap to DNA grid' : 'On the DNA grid ✓', () => snapDNA(els),
    'Grid diameter, and base counts from the drawn length (this strand, its domains and its duplexes)');
  b.disabled = !off;
  frag.appendChild(b);
  return frag;
}

// A segment of a DNA strand is a domain: paired, it shows (and edits) the
// duplex's base pairs; otherwise it may carry its own count.
function segmentBases(el, i) {
  const seg = el.segments[i];
  const frag = document.createDocumentFragment();
  const link = state.doc.elements.find(l => duplexLink(l) &&
    [l.a, l.b].some(r => r.id === el.id && (r.seg === i || r.seg === undefined)));
  if (link) {
    if (linkSeq(link)) {
      frag.appendChild(fieldRow('Base pairs', basesInput(() => duplexBases(link), () => {}, { readOnly: true })));
      frag.appendChild(seqNote());
      return frag;
    }
    frag.appendChild(fieldRow('Base pairs', basesInput(() => duplexBases(link),
      v => { if (v === null) delete link.bases; else link.bases = v; }, { auto: !link.bases })));
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = 'Paired: the count is shared with the partner strand (edit it here or on the link).';
    frag.appendChild(p);
    return frag;
  }
  const lay = dnaLayout(el);
  const n = Math.round(uAt(lay.knots, seg.t1) - uAt(lay.knots, seg.t0));
  if (seqOf(seg.string)) {
    frag.appendChild(fieldRow('Bases', basesInput(() => n, () => {}, { readOnly: true })));
    frag.appendChild(seqNote());
    return frag;
  }
  frag.appendChild(fieldRow('Bases', basesInput(() => seg.bases ?? n,
    v => { if (v === null) delete seg.bases; else seg.bases = v; }, { auto: !seg.bases })));
  if (seg.bases) frag.appendChild(spacingNote(seg.t1 - seg.t0, seg.bases, diam(el), false, () => delete seg.bases));
  return frag;
}

// Shown where a sequence, not the user, sets the base count.
function seqNote() {
  const p = document.createElement('p');
  p.className = 'muted';
  p.textContent = 'Set by the sequence (a domain String or the strand Sequence) — edit or clear it to change the count.';
  return p;
}
const linkSeq = l => refSeq(l.a, byId(l.a.id)) || refSeq(l.b, byId(l.b.id));

// Where along each end a base-pair link pairs: from/to as % of that end's domain
// (or line), so a short domain can pair with part of a longer one. A fraction
// like 6/13 is read as one. Both full = the old whole-domain pairing.
function pairRangeRows(l) {
  const frag = document.createDocumentFragment();
  for (const [ref, name] of [[l.a, 'A'], [l.b, 'B']]) {
    const row = document.createElement('div');
    row.className = 'width-row';
    const box = (k, dflt) => {
      const node = document.createElement('input');
      node.type = 'text'; node.size = 5;
      node.value = +((ref[k] ?? dflt) * 100).toFixed(1);
      node.title = 'Percent of the domain from its start, or a fraction such as 6/13';
      node.addEventListener('change', () => {
        const m = node.value.match(/^\s*([\d.]+)\s*\/\s*([\d.]+)\s*$/);
        const v = clamp(m ? m[1] / m[2] : parseFloat(node.value) / 100, 0, 1);
        const f0 = k === 'f0' ? v : ref.f0 ?? 0, f1 = k === 'f1' ? v : ref.f1 ?? 1;
        if (!(f1 - f0 > 0.001)) { node.value = +((ref[k] ?? dflt) * 100).toFixed(1); return; }
        beginChange();
        if (v === dflt) delete ref[k]; else ref[k] = v;
        changed();
      });
      return node;
    };
    const to = document.createElement('span');
    to.className = 'muted'; to.textContent = 'to';
    row.append(box('f0', 0), to, box('f1', 1));
    const label = resolveLabel(backbone(ref).label || ''); // math/markup labels read badly here
    frag.appendChild(fieldRow(`Pairs ${label && !/[$<]/.test(label) ? label : name} over (%)`, row));
  }
  return frag;
}

function duplexBasesControls(l) {
  const frag = document.createDocumentFragment();
  if (linkSeq(l)) {
    frag.appendChild(fieldRow('Base pairs', basesInput(() => duplexBases(l), () => {}, { readOnly: true })));
    frag.appendChild(seqNote());
    return frag;
  }
  frag.appendChild(fieldRow('Base pairs', basesInput(() => duplexBases(l),
    v => { if (v === null) delete l.bases; else l.bases = v; }, { auto: !l.bases })));
  const A = linkStrand(l.a), B = linkStrand(l.b);
  const D = (diam(byId(l.a.id)) + diam(byId(l.b.id))) / 2;
  frag.appendChild(spacingNote(Math.min(polylineLength(A), polylineLength(B)), duplexBases(l), D,
    !l.bases, () => delete l.bases));
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

function joinLines({ a, b }) {
  const merged = mergePaths(a.pts, a.segments || [], b.pts, b.segments || []);
  beginChange();
  // domain links follow their segments into the joined line; whole-line links to b go
  const na = a.segments?.length || 0, nb = b.segments?.length || 0;
  state.doc.elements = state.doc.elements.filter(l => !(l.type === 'link' && [l.a, l.b].some(r => r?.id === b.id && r.seg === undefined)));
  for (const l of state.doc.elements) if (l.type === 'link') for (const k of ['a', 'b']) {
    const r = l[k];
    if (r?.seg === undefined) continue;
    if (r.id === a.id && merged.bFirst) l[k] = { ...r, seg: r.seg + nb };
    else if (r.id === b.id) l[k] = { ...r, id: a.id, seg: r.seg + (merged.bFirst ? 0 : na) };
  }
  a.pts = merged.pts;
  a.segments = merged.segments;
  state.doc.elements = state.doc.elements.filter(el => el !== b);
  state.selection = [{ id: a.id }];
  changed();
}

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

  const badge = kindBadge(single, n);
  if (badge) panel.appendChild(badge);
  // every element can carry its own name (Objects panel, badge, note refs); a card's is its title
  if (single && single.seg === undefined && single.el.type !== 'card') {
    const el = single.el, sec = document.createElement('div');
    sec.className = 'panel-section sec-prop';
    sec.appendChild(fieldRow('Name', boundInput(() => el.name || '', v => { if (v.trim()) el.name = v; else delete el.name; },
      { placeholder: 'default (shown above)' })));
    panel.appendChild(sec);
  }
  panel.appendChild(paletteSection());

  const styleSec = document.createElement('div');
  styleSec.className = 'panel-section sec-prop';
  let styled = false;
  if (single?.el.mol) {
    const el = single.el;
    styleSec.appendChild(fieldRow('Shading', mappedSelect({ soft: 'Soft (rendered)', toon: 'Toon (flat bands)', cartoon: 'Cartoon (icon)' },
      () => (el.molIcon ? 'cartoon' : el.dnaToon ? 'toon' : 'soft'), v => {
        delete el.dnaToon; delete el.molIcon;
        if (v === 'toon') el.dnaToon = true;
        if (v === 'cartoon') el.molIcon = true;
      })));
    styleSec.appendChild(checkboxRow('Black outline', () => !!el.dnaOutline, v => { if (v) el.dnaOutline = true; else delete el.dnaOutline; }));
    styled = true;
  } else if (!single || (single.el.width !== undefined && !single.el.dna)) {
    styleSec.appendChild(fieldRow('Width', widthControl(
      () => (single?.el.width) ?? state.width,
      v => {
        state.width = v;
        if (single && single.el.width !== undefined) single.el.width = v;
      },
      !!(single && single.el.width !== undefined))));
    if (!n) styleSec.appendChild(fieldRow('New strands', newStrandSelect()));
    styled = true;
  }
  if (single && !single.el.mol && ['path', 'aline', 'ellipse', 'ink', 'rect'].includes(single.el.type) && single.seg === undefined) {
    const el = single.el;
    const look = el.type === 'path' ? ownLook(el) : 'line';
    if (el.type === 'path') {
      styleSec.appendChild(fieldRow('Draw as', mappedSelect(LOOKS, () => look, v => setLook([el], v))));
      if (strandView.mode !== 'own') styleSec.appendChild(lookNote());
      styleSec.appendChild(sequenceField(el));
      if (look === 'seq') styleSec.appendChild(fieldRow('Letters', mappedSelect(
        { strand: 'Strand colour', sequence: 'A C G T colours' },
        () => (el.dnaColor === 'sequence' ? 'sequence' : 'strand'),
        v => { if (v === 'sequence') el.dnaColor = v; else delete el.dnaColor; })));
      if (look === 'seq') styleSec.appendChild(fieldRow('Letter size', sliderNum(() => el.seqScale || 1,
        v => { if (v === 1) delete el.seqScale; else el.seqScale = v; }, { min: 0.4, max: 3, step: 0.1 })));
      if (look === 'line') {
        styleSec.appendChild(fieldRow('Base ticks', mappedSelect(
          { none: 'None', left: 'One side', right: 'Other side', both: 'Both sides' },
          () => el.comb || 'none', v => { if (v === 'none') delete el.comb; else el.comb = v; })));
        if (el.comb) {
          styleSec.appendChild(fieldRow('Tick length', sliderNum(() => el.combLen ?? 6,
            v => { if (v === 6) delete el.combLen; else el.combLen = v; }, { min: 1, max: 30, step: 0.5 })));
          styleSec.appendChild(fieldRow('Tick spacing', sliderNum(() => el.combStep || 6,
            v => { if (v === 6) delete el.combStep; else el.combStep = v; }, { min: 2, max: 30, step: 0.5 })));
        }
      }
    }
    if (look === 'dna') styleSec.appendChild(dnaControls(el));
    else if (look === 'line') styleSec.appendChild(fieldRow('Line style', selectControl(
      ['solid', 'dashed', 'dotted'], () => el.dash || 'solid', v => { el.dash = v; })));
    if (look !== 'line') { /* caps, ends and patterns don't apply to a molecule or letters */ } else if (['path', 'aline', 'ink'].includes(el.type)) {
      styleSec.appendChild(fieldRow('Line ends', selectControl(
        ['rounded', 'flat', 'square'],
        () => LINECAP_NAMES[el.linecap || 'round'],
        v => { el.linecap = LINECAP_VALUES[v]; })));
    }
    if (((el.type === 'path' && look === 'line') || el.type === 'aline') && !el.closed) {
      styleSec.appendChild(fieldRow('Start cap', selectControl(
        CAPS, () => el.cap0 || 'none', v => { el.cap0 = v; })));
      styleSec.appendChild(fieldRow('End cap', selectControl(
        CAPS, () => el.cap1 || 'none', v => { el.cap1 = v; })));
      styleSec.appendChild(capOptions(el));
    }
    if (el.type === 'path' || el.type === 'aline') {
      styleSec.appendChild(checkboxRow('Smooth curve through the points', () => !!el.smooth, v => setSmooth(el, v)));
    }
    if (el.type === 'aline') { // a closed line note is a polygon: fillable, outline optional
      styleSec.appendChild(checkboxRow('Closed shape', () => !!el.closed, v => {
        if (v) el.closed = true; else delete el.closed;
      }));
      if (el.closed) {
        styleSec.appendChild(checkboxRow('Outline', () => !el.noStroke, v => {
          if (v) delete el.noStroke; else el.noStroke = true;
        }));
        styleSec.appendChild(fillControl(el));
        if (el.fill) styleSec.appendChild(fillOpacityRow(el));
      }
    }
    if (el.type === 'path') {
      if (look === 'line') styleSec.appendChild(patternControls(el, `line:${el.id}`));
      if (!el.smooth) styleSec.appendChild(fieldRow('Corner radius', sliderNum(
        () => el.corner || 0,
        v => { if (v) el.corner = v; else delete el.corner; },
        { min: 0, max: 8 * GRID, step: GRID / 2 })));
      styleSec.appendChild(strandToggles([el], look === 'line'));
    }
    if (el.type === 'rect') {
      styleSec.appendChild(fieldRow('Corner radius', numberControl(
        () => el.r || 0,
        v => { el.r = v; },
        { min: 0, max: Math.floor(Math.min(el.w, el.h) / 2), step: 1 })));
    }
    if (el.type === 'rect' || el.type === 'ellipse') {
      styleSec.appendChild(fieldRow('Rotation (°)', sliderNum(
        () => el.rot || 0,
        v => { if (v) el.rot = v; else delete el.rot; },
        { min: -180, max: 180, step: 1 })));
      styleSec.appendChild(fillControl(el));
      if (el.fill && !el.glow) styleSec.appendChild(fillOpacityRow(el));
    }
    styled = true;
  }
  if (styled) {
    styleSec.prepend(sectionTitle(single || n ? 'Style' : 'Drawing style'));
    panel.appendChild(styleSec);
  }

  const sec = document.createElement('div');
  sec.className = 'panel-section sec-prop';

  if (n === 0) {
    sec.appendChild(sectionTitle('Canvas'));
    const p = document.createElement('p');
    p.className = 'muted';
    const count = state.doc.elements.length;
    p.textContent = count
      ? `${count} object${count === 1 ? '' : 's'} in this scheme. Select one to edit its label and color.`
      : 'An empty canvas. Pick the Strand tool (L) and drag on the grid to draw your first path, or frame a section with the Card tool (C).';
    sec.appendChild(p);
    if (state.doc.elements.some(e => e.dna)) sec.appendChild(dnaGridControl());
    sec.appendChild(fieldRow('Background', colorPicker('bg',
      () => (/^#[0-9a-f]{6}$/i.test(state.doc.bg || '') ? state.doc.bg : '#ffffff'),
      Object.assign(hex => { state.doc.bg = hex; render(); }, { begin: beginChange }),
      changed)));
    if (state.doc.bg && state.doc.bg !== '#ffffff') {
      sec.appendChild(smallButton('Reset background', () => {
        beginChange(); delete state.doc.bg; changed();
      }, 'Back to white'));
    }
    sec.appendChild(sectionTitle('Labels'));
    const lp = document.createElement('p');
    lp.className = 'muted';
    lp.textContent = 'For every domain and object label that has no style of its own.';
    sec.appendChild(lp);
    sec.appendChild(docLabelStyleFields());
  } else if (!single) {
    sec.appendChild(sectionTitle(`${n} objects`));
    const row = document.createElement('div');
    row.className = 'btn-row';
    const oneGroup = isOneGroup();
    if (!oneGroup) row.append(smallButton('Group', groupSelection, 'Bundle the selection into a named group (Ctrl+G)'));
    if (whollySelectedGroups().size) {
      row.append(smallButton('Ungroup', ungroupSelection, 'Dissolve the selected group(s) (Ctrl+Shift+G)'));
    }
    const linkT = !oneGroup && linkTargetsFromSelection();
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
    const paths = state.selection.filter(s => s.seg === undefined).map(s => byId(s.id)).filter(p => p?.type === 'path');
    if (paths.length) {
      const looks = new Set(paths.map(ownLook));
      sec.appendChild(fieldRow(paths.length === n ? 'Draw as' : `Draw the ${paths.length} strands as`,
        mappedSelect(looks.size > 1 ? { '': 'Mixed', ...LOOKS } : LOOKS, () => (looks.size > 1 ? '' : [...looks][0]),
          v => { if (v) setLook(paths, v); })));
      if (strandView.mode !== 'own') sec.appendChild(lookNote());
      sec.appendChild(strandToggles(paths, paths.some(p => ownLook(p) === 'line')));
      if (paths.every(p => p.dna)) {
        sec.appendChild(fieldRow('Diameter', sliderNum(() => +diam(paths[0]).toFixed(1),
          v => { for (const p of paths) p.dna = v; }, { min: 4, max: 80, step: 0.5 })));
        sec.appendChild(dnaGridRow(paths));
        sec.appendChild(dnaStyleControls(paths));
      }
    }
    const join = joinSelectedPaths();
    if (join) {
      row.append(smallButton('Join lines', () => joinLines(join),
        'Fuse two lines whose ends meet on the same grid point'));
    }
    sec.appendChild(row);
    sec.appendChild(deleteButton('Delete selection'));
  } else if (single.seg !== undefined) {
    const el = single.el, seg = el.segments[single.seg];
    sec.appendChild(sectionTitle('Segment'));
    if (el.dna) sec.appendChild(segmentBases(el, single.seg));
    else {
      sec.appendChild(fieldRow('Thickness', widthControl(
        () => seg.width ?? ((el.width ?? 2) + 2.5),
        v => { seg.width = v; },
        true)));
      sec.appendChild(fieldRow('Line ends', selectControl(
        ['rounded', 'flat', 'square'],
        () => LINECAP_NAMES[seg.linecap || 'round'],
        v => { seg.linecap = LINECAP_VALUES[v]; })));
      sec.appendChild(patternControls(seg, `seg:${el.id}.${single.seg}`));
    }
    sec.appendChild(labelFields(seg, 'e.g. domain a', true));
    sec.appendChild(labelDisplayFields(seg));
    sec.appendChild(labelStyleFields(seg, `lab:${el.id}.${single.seg}`, { size: 12, color: resolveColor(seg.color) }));
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
    info.textContent = duplexLink(el)
      ? 'A double helix between two DNA strands (shown dashed). Click it again to select the strands themselves.'
      : el.style === 'bases'
        ? 'Base pairs drawn between two strands — they follow them as they move.'
        : 'A filled area spanning two objects — it follows them as they move.';
    sec.appendChild(info);
    // Base pairs need a strand on both ends: two lines or two segments.
    const A = linkStrand(el.a), B = A && linkStrand(el.b);
    const bases = el.style === 'bases' && B;
    sec.appendChild(fieldRow('Style', mappedSelect({ fill: 'Fill', bases: 'Base pairs' },
      () => el.style || 'fill',
      v => {
        el.style = v;
      })));
    if (el.style === 'bases' && !B) {
      const warn = document.createElement('p');
      warn.className = 'muted';
      warn.textContent = 'Base pairs need two lines or segments at the ends — drawn as a fill meanwhile.';
      sec.appendChild(warn);
    }
    if (bases && duplexLink(el)) {
      sec.appendChild(duplexBasesControls(el));
      sec.appendChild(pairRangeRows(el));
      // the duplex has no colour of its own: each backbone is its strand's paired
      // segment (or line), hidden inside it — so edit them from here
      const nameOf = ref => resolveLabel(backbone(ref).label || '') || resolveLabel(byId(ref.id).label || '')
        || (ref === el.a ? 'Strand A' : 'Strand B');
      for (const ref of [el.a, el.b]) {
        const t = viaDomain(backbone(ref));
        sec.appendChild(fieldRow(`${nameOf(ref)} backbone`, colorPicker(`bb:${el.id}:${ref === el.a ? 'a' : 'b'}`,
          () => (/^#[0-9a-f]{6}$/i.test(resolveColor(t.color) || '') ? resolveColor(t.color) : '#8a857c'),
          Object.assign(hex => { t.color = hex; syncDomains(); render(); }, { begin: beginChange }), changed)));
      }
      const look = [byId(el.a.id), byId(el.b.id)].filter((x, i, a) => a.indexOf(x) === i);
      sec.appendChild(sectionTitle(look.length > 1 ? 'Look (both strands)' : 'Look'));
      sec.appendChild(dnaStyleControls(look));
      const pick = ids => () => { state.selection = ids.map(id => ({ id })); refresh(); };
      const row = document.createElement('div');
      row.className = 'btn-row';
      row.append(
        smallButton('Both strands', pick([el.a.id, el.b.id]), 'Select the two strands this duplex joins (or click the duplex again)'),
        smallButton(resolveLabel(byId(el.a.id).label || '') || 'Strand A', pick([el.a.id])),
        smallButton(resolveLabel(byId(el.b.id).label || '') || 'Strand B', pick([el.b.id])));
      sec.appendChild(sectionTitle('Strands'));
      sec.appendChild(row);
      sec.appendChild(deleteButton());
      panel.appendChild(sec);
      return;
    }
    if (bases) {
      const rs = rungSeqs(el);
      const n = document.createElement('input');
      n.type = 'number'; n.min = 1; n.max = 1000; n.step = 1;
      n.value = rs.n;
      n.readOnly = rs.fromSeq;
      n.addEventListener('change', () => {
        const v = clamp(Math.round(+n.value) || 1, 1, 1000); n.value = v;
        beginChange(); el.bases = v; changed();
      });
      sec.appendChild(fieldRow('Bases', n));
      if (rs.fromSeq) sec.appendChild(seqNote());
      sec.appendChild(fieldRow('Base pair look', mappedSelect(
        { line: 'Rung', dot: 'Dot', tick: 'Tick with gap' },
        () => el.rung || 'line', v => { if (v === 'line') delete el.rung; else el.rung = v; })));
      if (el.rung === 'dot') sec.appendChild(fieldRow('Dot size', sliderNum(() => el.rungSize || 1.6,
        v => { if (v === 1.6) delete el.rungSize; else el.rungSize = v; }, { min: 0.5, max: 8, step: 0.1 })));
      else sec.appendChild(fieldRow('Rung width', sliderNum(() => el.rungWidth ?? 1.5,
        v => { if (v === 1.5) delete el.rungWidth; else el.rungWidth = v; }, { min: 0.25, max: 8, step: 0.25 })));
      sec.appendChild(fieldRow('Rungs', mappedSelect(
        { auto: 'Auto', straight: 'Straight (from the shorter strand)', spread: 'Spread over both strands' },
        () => el.rungAlign || 'auto', v => { if (v === 'auto') delete el.rungAlign; else el.rungAlign = v; })));
      sec.appendChild(pairRangeRows(el));
      sec.appendChild(fieldRow('Colour by', mappedSelect(
        { fill: 'One colour', strands: 'Strand colours (two-tone)', sequence: 'Sequence (A C G T)' },
        () => el.rungColor || 'fill', v => { if (v === 'fill') delete el.rungColor; else el.rungColor = v; })));
      if (el.rungColor !== 'strands') sec.appendChild(fillControl(el,
        { optional: false, label: el.rungColor ? 'Unsequenced' : 'Base pair', pattern: false }));
      sec.appendChild(deleteButton());
      panel.appendChild(sec);
      return;
    }
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
    sec.appendChild(sectionTitle(MOLS[el.mol]?.name || titles[el.type] || el.type));
    if (el.type === 'card') {
      sec.appendChild(fieldRow('Title', boundInput(
        () => el.title, v => { el.title = v; }, { placeholder: 'section title' })));
      sec.appendChild(fieldRow('Card color', fillPicker(el, '#ffffff', false)));
      if (el.fill && el.fill !== '#ffffff') {
        sec.appendChild(smallButton('Reset card color', () => {
          beginChange(); delete el.fill; changed();
        }, 'Back to white'));
      }
    } else if (el.type !== 'text' || isSemantic(el)) {
      sec.appendChild(labelFields(el, 'name this object', el.type === 'path'));
      if (el.type !== 'text') {
        sec.appendChild(labelDisplayFields(el));
        sec.appendChild(labelStyleFields(el, `lab:${el.id}`, { size: 12.5, color: resolveColor(el.color) || '#2b2622' }));
      }
    }
    if (el.type === 'text') {
      const src = boundInput(() => el.text, v => { el.text = v; }, { textarea: true });
      src.classList.add('fmt-src'); // the text toolbar formats its selection
      sec.appendChild(fieldRow('Text', src));
      const sizeInput = document.createElement('input');
      sizeInput.type = 'number';
      sizeInput.min = 6; sizeInput.max = 144;
      sizeInput.value = el.size;
      sizeInput.addEventListener('change', () => {
        beginChange();
        el.size = clamp(+sizeInput.value || 14, 6, 144);
        changed();
      });
      sec.appendChild(fieldRow('Size', sizeInput));
      // alignment goes through the text toolbar's command, which keeps the note in place
      const alignSel = document.createElement('select');
      for (const [v, t] of Object.entries({ left: 'Left', center: 'Centre', right: 'Right' })) alignSel.add(new Option(t, v));
      alignSel.value = el.align || 'left';
      alignSel.addEventListener('change', () => applyFormat(`align:${alignSel.value}`));
      sec.appendChild(fieldRow('Align', alignSel));
      sec.appendChild(fieldRow('Rotation (°, clockwise)', numberControl(
        () => el.rotate || 0,
        v => { v = ((v % 360) + 540) % 360 - 180; if (v) el.rotate = v; else delete el.rotate; },
        { min: -360, max: 360, step: 15 })));
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
        name.innerHTML = rowHTML(resolveLabel(seg.label || '') || `domain ${i + 1}`);
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

  // arrange: z-order (transforms and alignment live in the toolbar)
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
    panel.appendChild(arr);
  }
}

// ---- file operations ----

const TAURI = window.__TAURI__;
let currentFile = null; // Tauri: path string · browser: FileSystemFileHandle
let docName = null; // the opened file's name, as Save's suggestion when there's no handle to it

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
          suggestedName: docName || 'scheme.schemer.json',
          types: [{ description: 'Master Schemer', accept: { 'application/json': ['.schemer.json', '.json'] } }],
        });
      }
      const w = await handle.createWritable();
      await w.write(text);
      await w.close();
      currentFile = handle;
    } else {
      download(docName || 'scheme.schemer.json', text, 'application/json');
    }
    state.dirty = false;
    rememberRecent(TAURI ? currentFile : null, currentFile?.name || 'scheme.schemer.json');
    $('hint').textContent = 'Saved.';
    toast('Saved ✓');
  } catch (err) {
    if (err?.name !== 'AbortError') $('hint').textContent = `Save failed: ${err.message || err}`;
  }
}

function openPath(text, path) {
  loadDocJSON(text);
  currentFile = path;
  state.dirty = false;
  renderNotes();
  fitView();
  rememberRecent(path, path.split(/[\\/]/).pop());
}

async function openFile() {
  try {
    if (TAURI) {
      const path = await TAURI.dialog.open({ multiple: false, filters: FILE_FILTER });
      if (!path) return;
      openPath(await TAURI.fs.readTextFile(path), path);
    } else {
      $('fileInput').click();
    }
  } catch (err) {
    $('hint').textContent = `Could not open file: ${err.message || err}`;
  }
}

// ---- export: a dialog for format, name, size and look; then the system save
// dialog (or the browser's) picks where the file goes ----

const EXPORT_KEY = 'master-schemer-export';
const FORMATS = {
  png: { label: 'PNG image', ext: 'png', mime: 'image/png' },
  svg: { label: 'SVG image', ext: 'svg', mime: 'image/svg+xml' },
  csv: { label: 'CSV table', ext: 'csv', mime: 'text/csv' },
};
const PNG_SCALES = [1, 2, 3, 4, 6, 8];
const PNG_MAX = 8000; // px per side; bigger canvases fail in some webviews
let exportOpts = { format: 'png', scale: 2, grid: false, transparent: false, only: false };
try { Object.assign(exportOpts, JSON.parse(localStorage.getItem(EXPORT_KEY) || '{}')); } catch { /* defaults */ }
let exportName = null; // { base, name }: the name typed last time for this scheme, offered again
let exportDir = null; // where the last export went: folder path (desktop) or file handle (browser)

// The selected elements, plus everything on a selected card and the links and
// arrows running between them. Empty when nothing is selected.
function selectedIds() {
  const ids = new Set();
  for (const s of state.selection) {
    const el = s.seg === undefined && byId(s.id);
    if (!el) continue;
    ids.add(el.id);
    if (el.type === 'card') for (const c of cardContents(el)) ids.add(c.id);
  }
  return ids;
}
function withConnectors(ids) {
  for (const el of state.doc.elements) {
    const [a, b] = el.type === 'arrow' ? [el.from, el.to] : el.type === 'link' ? [el.a?.id, el.b?.id] : [];
    if (a && ids.has(a) && ids.has(b)) ids.add(el.id);
  }
  return ids;
}

// Write a blob where the user chooses: the native dialog on the desktop, the
// browser's save picker where it has one, else a plain download.
async function saveBlob(name, blob, f) {
  if (TAURI) {
    const path = await TAURI.dialog.save({
      defaultPath: exportDir ? `${exportDir}/${name}` : name, filters: [{ name: f.label, extensions: [f.ext] }],
    });
    if (!path) return false;
    await TAURI.fs.writeFile(path, new Uint8Array(await blob.arrayBuffer()));
    exportDir = path.replace(/[\\/][^\\/]*$/, '');
  } else if (window.showSaveFilePicker) {
    const handle = await window.showSaveFilePicker({
      suggestedName: name, ...(exportDir && { startIn: exportDir }),
      types: [{ description: f.label, accept: { [f.mime]: ['.' + f.ext] } }],
    });
    const w = await handle.createWritable();
    await w.write(blob);
    await w.close();
    exportDir = handle;
  } else download(name, blob, f.mime);
  return true;
}

// Rasterize the export SVG at `scale` px per unit, capped at PNG_MAX a side.
// Returns a PNG blob, null for nothing to export, or undefined if the webview
// tainted the canvas (WebKit does for math foreignObjects).
async function rasterizePNG(o, plain) {
  const svgText = await exportSVGString({ ...o, plain, flat: !plain }); // flat: math as SVG, so the canvas takes it
  render(); // export rendered unculled; restore the culled view
  if (!svgText) return null;
  const url = URL.createObjectURL(new Blob([svgText], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const k = Math.min(o.scale, PNG_MAX / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * k);
    c.height = Math.round(img.naturalHeight * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return await new Promise(res => c.toBlob(res, 'image/png'));
  } catch { return undefined; } finally { URL.revokeObjectURL(url); }
}

async function runExport(o, name) {
  exportOpts = o;
  try { localStorage.setItem(EXPORT_KEY, JSON.stringify(o)); } catch { /* full */ }
  const f = FORMATS[o.format];
  const sel = selectedIds();
  if (!state.doc.elements.length) {
    $('hint').textContent = 'Nothing to export yet — the canvas is empty.';
    return;
  }
  let blob, note = '';
  if (o.format === 'csv') blob = new Blob([csvText()], { type: f.mime }); // a selection scopes the table
  else {
    const opts = { ...o, only: o.only && sel.size ? withConnectors(sel) : null };
    const keep = state.selection;
    state.selection = []; // no selection styling in the picture
    refresh();
    $('hint').textContent = `Building ${o.format.toUpperCase()}…`;
    if (o.format === 'svg') blob = new Blob([await exportSVGString(opts)], { type: f.mime });
    else {
      blob = await rasterizePNG(opts, false);
      if (blob === undefined) {
        blob = await rasterizePNG(opts, true);
        note = ' Math labels and wrapped notes were left out — export SVG to keep them.';
      }
    }
    state.selection = keep;
    refresh();
    if (!blob) { $('hint').textContent = 'PNG export failed.'; return; }
  }
  try {
    if (await saveBlob(`${name}.${f.ext}`, blob, f)) $('hint').textContent = `${f.label} exported.${note}`;
  } catch (err) {
    if (err?.name !== 'AbortError') $('hint').textContent = `Export failed: ${err.message || err}`;
  }
}

function closeExport() { $('export-modal')?.remove(); }

function showExport(format = exportOpts.format) {
  closeExport();
  const o = { ...exportOpts, format };
  const sel = selectedIds();
  const base = (typeof currentFile === 'string' ? currentFile.split(/[\\/]/).pop() : currentFile?.name || 'scheme')
    .replace(/(\.schemer)?\.json$/i, '');
  const overlay = document.createElement('div');
  overlay.id = 'export-modal';
  overlay.className = 'modal-overlay';
  overlay.addEventListener('pointerdown', e => { if (e.target === overlay) closeExport(); });
  const card = document.createElement('form');
  card.className = 'modal-card export-card';
  const head = document.createElement('div');
  head.className = 'modal-head';
  const h = document.createElement('h2');
  h.textContent = 'Export';
  const x = document.createElement('button');
  x.type = 'button';
  x.className = 'modal-close';
  x.textContent = '✕';
  x.title = 'Close';
  x.addEventListener('click', closeExport);
  head.append(h, x);
  const body = document.createElement('div');
  body.className = 'export-body';
  const nameIn = document.createElement('input');
  nameIn.value = exportName?.base === base ? exportName.name : base;
  nameIn.spellcheck = false;
  const select = (map, val, set) => {
    const n = document.createElement('select');
    for (const [v, l] of Object.entries(map)) n.add(new Option(l, v));
    n.value = String(val);
    n.addEventListener('change', () => { set(n.value); build(); });
    return n;
  };
  const check = (text, key, disabled = false) => {
    const lab = document.createElement('label');
    lab.className = 'check-row';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = o[key] && !disabled;
    cb.disabled = disabled;
    cb.addEventListener('change', () => { o[key] = cb.checked; build(); });
    lab.append(cb, document.createTextNode(text));
    return lab;
  };
  const note = text => { const p = document.createElement('p'); p.className = 'muted'; p.textContent = text; return p; };
  function build() {
    const nameRow = document.createElement('div');
    nameRow.className = 'export-name';
    const ext = document.createElement('span');
    ext.textContent = `.${FORMATS[o.format].ext}`;
    nameRow.append(nameIn, ext);
    body.replaceChildren(
      fieldRow('Format', select(Object.fromEntries(Object.entries(FORMATS).map(([k, f]) => [k, f.label])), o.format, v => { o.format = v; })),
      fieldRow('File name', nameRow));
    if (o.format === 'csv') {
      body.append(note(sel.size ? 'One row per selected object (and segment), with its hidden data.'
        : 'One row per object (and segment), with its hidden data. Select objects first to export just those.'));
      return;
    }
    body.append(
      check(sel.size ? `Only the selection (${sel.size} object${sel.size > 1 ? 's' : ''})` : 'Only the selection (nothing selected)', 'only', !sel.size),
      check('Show the grid', 'grid'),
      check('Transparent background', 'transparent'));
    if (o.format === 'png') {
      const box = contentBBox(o.only && sel.size ? state.doc.elements.filter(el => withConnectors(new Set(sel)).has(el.id)) : undefined);
      body.append(fieldRow('Resolution', select(Object.fromEntries(PNG_SCALES.map(k => [k, `${k}× (${k * 96} dpi)`])), o.scale, v => { o.scale = +v; })));
      if (box) {
        const w = box[2] - box[0] + 80, hh = box[3] - box[1] + 80; // the export's 40-unit margin
        const k = Math.min(o.scale, PNG_MAX / Math.max(w, hh));
        body.append(note(`${Math.round(w * k)} × ${Math.round(hh * k)} px${k < o.scale ? ` — capped at ${PNG_MAX} px a side` : ''}`));
      }
    }
  }
  build();
  const row = document.createElement('div');
  row.className = 'btn-row export-actions';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'btn outline';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', closeExport);
  const go = document.createElement('button');
  go.className = 'btn';
  go.textContent = TAURI || window.showSaveFilePicker ? 'Export…' : 'Download';
  row.append(cancel, go);
  card.addEventListener('submit', e => {
    e.preventDefault();
    const name = nameIn.value.trim().replace(/[\\/:*?"<>|]/g, '-') || 'scheme';
    exportName = { base, name };
    closeExport();
    runExport(o, name);
  });
  card.append(head, body, row);
  overlay.appendChild(card);
  document.body.appendChild(overlay);
  go.focus();
}
window.addEventListener('keydown', e => { if (e.key === 'Escape' && $('export-modal')) closeExport(); });

// ---- open recent (last 50 files ever opened/saved, with thumbnails) ----
// Kept in localStorage (the Tauri webview persists it per app). Under Tauri an
// entry reopens by path; in a browser there is no path, so it falls back to the picker.

const RECENT_KEY = 'master-schemer-recent';
const RECENT_MAX = 50;
let recent = [];
try { recent = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch { recent = []; }
function saveRecent() {
  // ponytail: on quota errors shed the oldest half; IndexedDB if thumbs ever outgrow localStorage
  for (;;) {
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(recent)); return; }
    catch { if (recent.length <= 1) return; recent = recent.slice(0, Math.ceil(recent.length / 2)); }
  }
}

// Rasterize the plain export SVG to a small JPEG data URL (~10 KB).
async function makeThumb() {
  const svg = await exportSVGString({ plain: true });
  render(); // export rendered unculled; restore the culled view
  if (!svg) return null;
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const W = 320, H = 200;
    const k = Math.min(W / img.naturalWidth, H / img.naturalHeight);
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d');
    g.fillStyle = state.doc.bg || '#ffffff';
    g.fillRect(0, 0, W, H);
    const w = img.naturalWidth * k, h = img.naturalHeight * k;
    g.drawImage(img, (W - w) / 2, (H - h) / 2, w, h);
    return c.toDataURL('image/jpeg', 0.75);
  } catch { return null; } finally { URL.revokeObjectURL(url); }
}

async function rememberRecent(path, name) {
  const key = path || name;
  const thumb = await makeThumb();
  recent = [{ path, name, when: Date.now(), thumb }, ...recent.filter(r => (r.path || r.name) !== key)].slice(0, RECENT_MAX);
  saveRecent();
}

async function openRecentEntry(r) {
  closeRecent();
  if (!TAURI || !r.path) {
    $('hint').textContent = `Pick ${r.name} in the file dialog — the browser can't reopen files by path.`;
    openFile();
    return;
  }
  let text;
  try { text = await TAURI.fs.readTextFile(r.path); }
  catch {
    recent = recent.filter(x => x !== r); saveRecent();
    $('hint').textContent = `${r.path} is gone — removed it from Open Recent.`;
    return;
  }
  try { openPath(text, r.path); }
  catch (err) { $('hint').textContent = `Could not open ${r.name}: ${err.message || err}`; }
}

function closeRecent() { $('recent-modal')?.remove(); }

function showRecent() {
  closeRecent();
  const overlay = document.createElement('div');
  overlay.id = 'recent-modal';
  overlay.className = 'modal-overlay';
  overlay.addEventListener('pointerdown', e => { if (e.target === overlay) closeRecent(); });
  const card = document.createElement('div');
  card.className = 'modal-card recent-card';
  const head = document.createElement('div');
  head.className = 'modal-head';
  const h = document.createElement('h2');
  h.textContent = 'Open Recent';
  const x = document.createElement('button');
  x.className = 'modal-close';
  x.textContent = '✕';
  x.title = 'Close';
  x.addEventListener('click', closeRecent);
  head.append(h, x);
  const grid = document.createElement('div');
  grid.className = 'recent-grid';
  if (!recent.length) grid.textContent = 'Nothing yet — schemes you open or save will appear here.';
  for (const r of recent) {
    const tile = document.createElement('button');
    tile.className = 'recent-tile';
    tile.title = r.path || r.name;
    const thumb = document.createElement(r.thumb ? 'img' : 'div');
    thumb.className = 'recent-thumb';
    if (r.thumb) { thumb.src = r.thumb; thumb.alt = ''; }
    const name = document.createElement('span');
    name.className = 'recent-name';
    name.textContent = r.name;
    const meta = document.createElement('span');
    meta.className = 'recent-meta';
    const dir = r.path ? r.path.slice(0, -r.name.length).replace(/[\\/]$/, '') : '';
    meta.textContent = [dir, new Date(r.when).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })].filter(Boolean).join(' · ');
    const rm = document.createElement('span');
    rm.className = 'recent-remove';
    rm.textContent = '✕';
    rm.title = 'Remove from list';
    rm.addEventListener('click', e => {
      e.stopPropagation();
      recent = recent.filter(y => y !== r); saveRecent(); showRecent();
    });
    tile.append(thumb, name, meta, rm);
    tile.addEventListener('click', () => openRecentEntry(r));
    grid.appendChild(tile);
  }
  card.append(head, grid);
  if (recent.length) {
    const clear = document.createElement('button');
    clear.className = 'btn recent-clear';
    clear.textContent = 'Clear list';
    clear.addEventListener('click', () => { recent = []; saveRecent(); showRecent(); });
    card.appendChild(clear);
  }
  overlay.appendChild(card);
  document.body.appendChild(overlay);
  grid.querySelector('.recent-tile')?.focus();
}
window.addEventListener('keydown', e => { if (e.key === 'Escape' && $('recent-modal')) closeRecent(); });

// ---- CSV export (objects + their hidden data; selection scopes it) ----

const csvEscape = v => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function csvText() {
  const selIds = selectedIds();
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

$('newBtn').addEventListener('click', () => {
  if (!state.doc.elements.length || confirm('Replace the current scheme with a blank canvas? (Undo can bring it back.)')) {
    newDoc();
    currentFile = docName = null;
    state.dirty = false;
    renderNotes();
  }
});
$('openBtn').addEventListener('click', openFile);
$('fileInput').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try { loadDocJSON(await file.text()); currentFile = null; docName = file.name; state.dirty = false; renderNotes(); fitView(); rememberRecent(null, file.name); }
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
$('exportBtn').addEventListener('click', () => showExport('svg'));
$('csvBtn').addEventListener('click', () => showExport('csv'));
// undo/redo bring back the notes too, so the editor shows what the doc now says
const undoDoc = () => { undo(); renderNotes(); };
const redoDoc = () => { redo(); renderNotes(); };
$('undoBtn').addEventListener('click', undoDoc);
$('redoBtn').addEventListener('click', redoDoc);

// Menu bar: click a title to open; while one is open, hovering another title
// switches to it. Items either carry the action's own id, proxy a click to an
// existing control (data-click), or name an action (data-act).
const MENU_ACTS = {
  recent: () => showRecent(), delete: deleteSelection, selectAll, group: groupSelection, ungroup: ungroupSelection,
  showPanels: () => setHiddenPanels([]), hidePanels: () => setHiddenPanels(PANELS),
  cut: cutSelection, duplicate: duplicateSelection, invertSel: invertSelection,
  selectNone: () => { state.selection = []; refresh(); },
  zoomSel: zoomToSelection, grid: toggleGrid, keys: () => setKeyHints(!document.body.classList.contains('show-keys')), exportPng: () => showExport('png'),
  dnaEnds: () => setDNAEnds(!dnaView.ends, true),
  collapseAll, expandAll, themes: () => showThemes(),
  ticks: toggleTicks, baseSnap: () => setBaseSnap(!state.baseSnap, true),
  fitSeq: fitToSequence,
};
// checkbox items whose state isn't mirrored by a toolbar button
const MENU_CHECKS = {
  grid: () => !document.body.classList.contains('hide-grid'),
  ticks: () => !document.body.classList.contains('hide-ticks'),
  baseSnap: () => !!state.baseSnap,
  dnaEnds: () => dnaView.ends,
  keys: () => document.body.classList.contains('show-keys'),
};

const KEY_HINTS_KEY = 'master-schemer-key-hints';
function setKeyHints(on) {
  document.body.classList.toggle('show-keys', on);
  try { localStorage.setItem(KEY_HINTS_KEY, on ? '1' : '0'); } catch { /* full */ }
}
try { document.body.classList.toggle('show-keys', localStorage.getItem(KEY_HINTS_KEY) === '1'); } catch { /* off */ }

// Tools menu mirrors the tool rail (so tools stay reachable when the rail is hidden)
{
  const keyOf = Object.fromEntries(Object.entries(TOOL_KEYS).map(([k, t]) => [t, k.toUpperCase()]));
  for (const n of $('toolrail').children) {
    if (!n.dataset.tool) { $('toolsMenu').append(document.createElement('hr')); continue; }
    const b = document.createElement('button');
    b.setAttribute('role', 'menuitemradio');
    b.dataset.pickTool = n.dataset.tool;
    b.append(n.getAttribute('aria-label').replace(/ tool$/, ''));
    const kbd = document.createElement('kbd');
    kbd.textContent = keyOf[n.dataset.tool];
    b.append(kbd);
    n.dataset.key = keyOf[n.dataset.tool]; // badge for View ▸ Tool Hotkeys
    $('toolsMenu').append(b);
  }
}
const menubar = $('menubar');
let openMenu = null;
function setMenu(m) {
  if (openMenu) { openMenu.classList.remove('open'); openMenu.firstElementChild.setAttribute('aria-expanded', 'false'); }
  openMenu = m;
  if (!m) return;
  m.classList.add('open');
  m.firstElementChild.setAttribute('aria-expanded', 'true');
  for (const it of m.querySelectorAll('[data-sel]'))
    it.disabled = selectedElements().length < +it.dataset.sel;
  for (const it of m.querySelectorAll('[data-click]')) {
    const target = $(it.dataset.click);
    it.disabled = target.disabled;
    if (it.getAttribute('role') === 'menuitemcheckbox') it.setAttribute('aria-checked', target.getAttribute('aria-pressed'));
  }
  for (const it of m.querySelectorAll('[data-check]'))
    it.setAttribute('aria-checked', String(MENU_CHECKS[it.dataset.check]()));
  for (const it of m.querySelectorAll('[data-look]'))
    it.setAttribute('aria-checked', String(it.dataset.look === strandView.mode));
  for (const it of m.querySelectorAll('[data-bpg]'))
    it.setAttribute('aria-checked', String(+it.dataset.bpg === dnaBpg()));
  for (const it of m.querySelectorAll('[data-pick-tool]'))
    it.setAttribute('aria-checked', String(state.tool === it.dataset.pickTool));
  for (const it of m.querySelectorAll('[data-panel]'))
    it.setAttribute('aria-checked', String(!hiddenPanels.includes(it.dataset.panel)));
  for (const it of m.querySelectorAll('[data-fmt]')) {
    const on = fmtState(it.dataset.fmt);
    if (on !== null) it.setAttribute('aria-checked', String(on));
  }
}
// clicking a menu must not steal focus from the note editor (Text menu acts on its selection)
menubar.addEventListener('mousedown', e => { if (document.querySelector('.inline-edit')) e.preventDefault(); });
menubar.addEventListener('click', e => {
  const title = e.target.closest('.menu-title');
  if (title) { setMenu(openMenu === title.parentElement ? null : title.parentElement); return; }
  const item = e.target.closest('[role^="menuitem"]');
  if (!item) return;
  setMenu(null);
  if (item.dataset.click) $(item.dataset.click).click();
  else if (item.dataset.act) MENU_ACTS[item.dataset.act]();
  else if (item.dataset.panel) togglePanel(item.dataset.panel);
  else if (item.dataset.pickTool) setTool(item.dataset.pickTool);
  else if (item.dataset.bpg) setBpg(+item.dataset.bpg);
  else if (item.dataset.look) setStrandView(item.dataset.look, true);
  else if (item.dataset.fmt) applyFormat(item.dataset.fmt);
});
menubar.addEventListener('pointerover', e => {
  const title = e.target.closest('.menu-title');
  if (openMenu && title && title.parentElement !== openMenu) setMenu(title.parentElement);
});
document.addEventListener('pointerdown', e => { if (openMenu && !menubar.contains(e.target)) setMenu(null); });
window.addEventListener('keydown', e => { if (e.key === 'Escape' && openMenu) setMenu(null); }, true);

// Object menu: the properties panel's Arrange buttons
Object.assign(MENU_ACTS, {
  front: () => reorder('front'), raise: () => reorder('up'), lower: () => reorder('down'), back: () => reorder('back'),
  rotCcw: () => transformSelection('ccw'), rotCw: () => transformSelection('cw'),
  flipH: () => transformSelection('h'), flipV: () => transformSelection('v'),
  alignLeft: () => alignSelection('left'), alignHcenter: () => alignSelection('hcenter'), alignRight: () => alignSelection('right'),
  alignTop: () => alignSelection('top'), alignVcenter: () => alignSelection('vcenter'), alignBottom: () => alignSelection('bottom'),
  distH: () => distributeSelection('h'), distV: () => distributeSelection('v'),
});

// ---- right-click menu ----
// Built fresh from the selection each time, showing only what applies to it.
// Right-clicking something unselected selects it first (a grouped object
// selects its whole top-level group, as a left click does); right-clicking
// empty canvas clears the selection and offers canvas-wide commands.
// Items: { label, act, kbd?, checked?, disabled?, sub? } or '-' (separator).

const edit = fn => () => { beginChange(); fn(); changed(); };
const linksOn = (id, seg) => state.doc.elements.filter(l => l.type === 'link' &&
  [l.a, l.b].some(r => r?.id === id && (seg === undefined || r.seg === seg)));
const topGroup = el => { let g = byGroup(el.group); while (g?.parent && byGroup(g.parent)) g = byGroup(g.parent); return g; };

function ctxItems() {
  const sel = state.selection, els = selectedElements(), n = els.length;
  const items = [], add = (label, act, o = {}) => items.push({ label, act, ...o }), sep = () => items.push('-');
  const pressed = id => $(id).getAttribute('aria-pressed') === 'true';
  if (!sel.length) {
    add('Paste', pasteClipboard, { kbd: 'Ctrl+V', disabled: !clipboard });
    add('Select All', selectAll, { kbd: 'Ctrl+A', disabled: !state.doc.elements.length });
    sep();
    add('Fit Scheme', () => $('zoomFit').click(), { kbd: '1' });
    add('Show Grid', toggleGrid, { checked: MENU_CHECKS.grid() });
    add('DNA Molecules', () => $('dnaToggle').click(), { checked: pressed('dnaToggle') });
    add('Show Data Boxes', () => $('dataToggle').click(), { checked: pressed('dataToggle') });
    return items;
  }
  const single = sel.length === 1 ? sel[0] : null;
  const segOnly = sel.every(s => s.seg !== undefined);
  const linksOnly = n > 0 && els.every(e => e.type === 'link');
  // the selection is exactly one group (as a click on a grouped object makes it)
  const oneGroup = isOneGroup();

  // a domain: back to its line
  if (single?.seg !== undefined) {
    add('Select Whole Line', () => { state.selection = [{ id: single.id }]; refresh(); });
    sep();
  }

  // links between two items, or the links on one item
  const linkT = !oneGroup && linkTargetsFromSelection();
  if (linkT) {
    const existing = findLink(linkT[0], linkT[1]);
    const strands = linkT.every(t => !t.group && linkStrand(t));
    const dna = linkT.every(t => byId(t.id) && lookOf(byId(t.id)) === 'dna');
    if (existing) add('Unlink', edit(() => { state.doc.elements = state.doc.elements.filter(e => e !== existing); }));
    else if (dna && strands) add('Pair as Duplex', () => createLink(linkT));
    else {
      if (strands) add('Pair with Base Pairs', () => createLink(linkT, 'bases'));
      add(strands ? 'Link with Fill' : 'Link', () => createLink(linkT));
    }
  }
  const lone = single && byId(single.id);
  if (lone?.type === 'link') {
    const strands = linkStrand(lone.a) && linkStrand(lone.b);
    if (duplexLink(lone)) add('Select Both Strands', () => { state.selection = [{ id: lone.a.id }, { id: lone.b.id }]; refresh(); });
    if (strands && !duplexLink(lone)) {
      add(lone.style === 'bases' ? 'Show as Fill' : 'Show as Base Pairs',
        edit(() => { lone.style = lone.style === 'bases' ? 'fill' : 'bases'; }));
    }
    add('Unlink', deleteSelection);
  } else if (lone) {
    const attached = linksOn(lone.id, single.seg);
    if (attached.length) {
      add(attached.length === 1 ? 'Remove Link' : `Remove ${attached.length} Links`,
        edit(() => { state.doc.elements = state.doc.elements.filter(e => !attached.includes(e)); }));
    }
  }
  if (items.length && items[items.length - 1] !== '-') sep();

  // lines and DNA
  const join = joinSelectedPaths();
  if (join) add('Join Lines', () => joinLines(join));
  const paths = els.filter(e => e.type === 'path');
  if (paths.length) {
    const allDNA = paths.every(p => lookOf(p) === 'dna');
    add('Draw As', null, {
      sub: Object.entries(LOOKS).map(([k, label]) => ({
        label, act: edit(() => setLook(paths, k)), checked: paths.every(p => ownLook(p) === k),
      })),
    });
    if (allDNA) {
      const toggle = (k, v) => edit(() => { for (const p of paths) { if (v) p[k] = v; else delete p[k]; } });
      const flip = (k, is) => { const v = !paths.every(is); return edit(() => { for (const p of paths) p[k] = v; }); };
      add('DNA Look', null, {
        sub: [
          { label: 'Space-filling', act: toggle('dnaSkin', null), checked: !paths.some(p => p.dnaSkin) },
          { label: 'Ribbon + bases', act: toggle('dnaSkin', 'ribbon'), checked: paths.every(p => p.dnaSkin === 'ribbon') },
          '-',
          { label: 'Toon Shading', act: flip('dnaToon', toon), checked: paths.every(toon) },
          { label: 'Black Outline', act: flip('dnaOutline', outlined), checked: paths.every(outlined) },
          '-',
          { label: 'Colour by Strand', act: toggle('dnaColor', null), checked: !paths.some(p => p.dnaColor) },
          { label: 'Backbone + Bases', act: toggle('dnaColor', 'bases'), checked: paths.every(p => p.dnaColor === 'bases') },
          { label: 'Sequence (A C G T)', act: toggle('dnaColor', 'sequence'), checked: paths.every(p => p.dnaColor === 'sequence') },
        ],
      });
      add('Snap to DNA Grid', () => snapDNA(paths));
    }
  }
  if (items.length && items[items.length - 1] !== '-') sep();

  // groups
  if (n >= 2 && !oneGroup) add('Group', groupSelection, { kbd: 'Ctrl+G' });
  if (whollySelectedGroups().size) add('Ungroup', ungroupSelection, { kbd: 'Ctrl+Shift+G' });
  if (lone && single.seg === undefined && lone.group) {
    const g = byGroup(lone.group), top = topGroup(lone);
    if (top) add(`Select Group “${top.name || 'group'}”`, () => { state.selection = groupElementMembers(top.id).map(x => ({ id: x.id })); refresh(); });
    if (g && g !== top) add(`Select Group “${g.name || 'group'}”`, () => { state.selection = groupElementMembers(g.id).map(x => ({ id: x.id })); refresh(); });
    add('Remove from Group', () => removeFromGroup(lone));
  }
  if (items.length && items[items.length - 1] !== '-') sep();

  // the object itself
  if (lone && single.seg === undefined && !linksOnly && !isSemantic(lone)) add('Promote to Object', edit(() => { lone.semantic = true; }));
  if (n) {
    if (!linksOnly) add('Save to Library', assetFromSelection);
    add('Zoom to Selection', zoomToSelection, { kbd: '2' });
    add('Arrange', null, {
      sub: [
        { label: 'Bring to Front', act: () => reorder('front'), kbd: 'Ctrl+Shift+]' },
        { label: 'Bring Forward', act: () => reorder('up'), kbd: 'Ctrl+]' },
        { label: 'Send Backward', act: () => reorder('down'), kbd: 'Ctrl+[' },
        { label: 'Send to Back', act: () => reorder('back'), kbd: 'Ctrl+Shift+[' },
        '-',
        { label: 'Rotate 90° Left', act: () => transformSelection('ccw') },
        { label: 'Rotate 90° Right', act: () => transformSelection('cw') },
        { label: 'Flip Horizontal', act: () => transformSelection('h') },
        { label: 'Flip Vertical', act: () => transformSelection('v') },
      ],
    });
  }
  if (n >= 2) {
    add('Align', null, {
      sub: [
        ...['Left', 'Hcenter', 'Right', 'Top', 'Vcenter', 'Bottom'].map(k => ({
          label: { Hcenter: 'Center', Vcenter: 'Middle' }[k] || k, act: MENU_ACTS[`align${k}`],
        })),
        ...(n >= 3 ? ['-', { label: 'Distribute Horizontally', act: MENU_ACTS.distH },
          { label: 'Distribute Vertically', act: MENU_ACTS.distV }] : []),
      ],
    });
  }
  if (items.length && items[items.length - 1] !== '-') sep();

  // clipboard
  if (n) {
    add('Cut', cutSelection, { kbd: 'Ctrl+X' });
    add('Copy', copySelection, { kbd: 'Ctrl+C' });
    if (!linksOnly) add('Duplicate', duplicateSelection, { kbd: 'Ctrl+D' });
  }
  add('Paste', pasteClipboard, { kbd: 'Ctrl+V', disabled: !clipboard });
  add(segOnly ? (sel.length > 1 ? 'Delete Segments' : 'Delete Segment') : 'Delete', deleteSelection, { kbd: 'Del' });
  return items;
}

let ctxMenu = null;
function closeCtx() { ctxMenu?.remove(); ctxMenu = null; }
function ctxList(items) {
  const list = document.createElement('div');
  list.className = 'menu-list';
  list.setAttribute('role', 'menu');
  items.forEach((it, i) => {
    if (it === '-') { // no leading, trailing or doubled separators
      if (i && i < items.length - 1 && items[i - 1] !== '-') list.appendChild(document.createElement('hr'));
      return;
    }
    const b = document.createElement('button');
    b.setAttribute('role', it.checked === undefined ? 'menuitem' : 'menuitemcheckbox');
    if (it.checked !== undefined) b.setAttribute('aria-checked', String(!!it.checked));
    b.disabled = !!it.disabled;
    b.append(it.label);
    if (it.kbd || it.sub) {
      const k = document.createElement('kbd');
      k.textContent = it.sub ? '▸' : it.kbd;
      b.append(k);
    }
    if (!it.sub) {
      b.addEventListener('click', () => { closeCtx(); it.act(); });
      list.appendChild(b);
      return;
    }
    b.setAttribute('aria-haspopup', 'true');
    const wrap = document.createElement('div');
    wrap.className = 'ctx-sub';
    wrap.append(b, ctxList(it.sub));
    list.appendChild(wrap);
  });
  return list;
}
function openCtx(x, y) {
  closeCtx();
  setMenu(null);
  ctxMenu = ctxList(ctxItems());
  ctxMenu.classList.add('ctx-menu');
  document.body.appendChild(ctxMenu);
  // keep it on screen; submenus open leftwards near the right edge
  const r = ctxMenu.getBoundingClientRect();
  ctxMenu.style.left = `${Math.max(4, Math.min(x, innerWidth - r.width - 4))}px`;
  ctxMenu.style.top = `${Math.max(4, Math.min(y, innerHeight - r.height - 4))}px`;
  if (x + r.width * 2 > innerWidth) ctxMenu.classList.add('flip');
  ctxMenu.querySelector('button:not(:disabled)')?.focus();
}
// Right-click target → selection. hit: { id, seg } or null for empty canvas.
function ctxSelect(hit) {
  if (!hit) { state.selection = []; refresh(); return; }
  const has = r => state.selection.some(s => s.id === r?.id && (s.seg === r.seg || s.seg === undefined));
  const el = byId(hit.id);
  // a duplex is drawn over its strands: with both strands selected, the click meant them
  if (has(hit) || (el?.type === 'link' && has(el.a) && has(el.b))) return;
  const top = hit.seg === undefined && el?.group && topGroup(el);
  state.selection = top ? groupElementMembers(top.id).map(x => ({ id: x.id })) : [hit];
  refresh();
}
svg.addEventListener('contextmenu', e => {
  if (e.target.closest?.('.inline-edit')) return; // the text editor keeps the native menu (spelling)
  e.preventDefault();
  if (isDragging()) return;
  const g = e.target.closest?.('[data-id]');
  const seg = e.target.getAttribute?.('data-seg') ?? g?.getAttribute('data-segi');
  ctxSelect(g && byId(g.getAttribute('data-id'))
    ? { id: g.getAttribute('data-id'), ...(seg != null ? { seg: +seg } : {}) } : null);
  openCtx(e.clientX, e.clientY);
});
document.addEventListener('pointerdown', e => { if (ctxMenu && !ctxMenu.contains(e.target)) closeCtx(); }, true);
window.addEventListener('blur', closeCtx);
window.addEventListener('resize', closeCtx);
svg.addEventListener('wheel', closeCtx, { passive: true });
window.addEventListener('keydown', e => {
  if (!ctxMenu) return;
  if (e.key === 'Escape') { closeCtx(); e.stopPropagation(); e.preventDefault(); return; }
  // any other shortcut acts on the canvas as it stands: the menu would be stale
  if (!['ArrowDown', 'ArrowUp', 'Enter', ' ', 'Tab', 'Shift'].includes(e.key)) { closeCtx(); return; }
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  e.preventDefault(); e.stopPropagation();
  const list = document.activeElement?.closest('.menu-list') || ctxMenu;
  const btns = [...list.children].map(c => (c.matches('.ctx-sub') ? c.firstElementChild : c))
    .filter(b => b.tagName === 'BUTTON' && !b.disabled);
  const i = btns.indexOf(document.activeElement);
  btns[(i + (e.key === 'ArrowDown' ? 1 : -1) + btns.length) % btns.length]?.focus();
}, true);

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
  return el ? displayName(el) : '(deleted)';
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

// A burst of typing (no pause over a second) is one undo step; Ctrl+Z inside
// the editor is still the editor's own.
let notesTyped = 0;
notesEditor.addEventListener('input', () => {
  if (Date.now() - notesTyped > 1000) { beginChange(); $('undoBtn').disabled = false; } // snapshot still has the old notes
  notesTyped = Date.now();
  state.doc.notes = serializeNotes();
  updateNotesPlaceholder();
  touch(); // no full re-render on every keystroke
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

// ---- panel visibility (Window menu; a UI pref, kept in localStorage not the file) ----

const PANELS = ['toolbar', 'textbar', 'tools', 'objects', 'library', 'color', 'props', 'notes'];
const PANELS_HIDDEN_KEY = 'master-schemer-hidden-panels';
let hiddenPanels = [];
function setHiddenPanels(list) {
  hiddenPanels = PANELS.filter(p => list.includes(p));
  for (const p of PANELS) document.body.classList.toggle(`hide-${p}`, hiddenPanels.includes(p));
  $('notesToggle').setAttribute('aria-pressed', String(!hiddenPanels.includes('notes')));
  $('textbarToggle').setAttribute('aria-pressed', String(!hiddenPanels.includes('textbar')));
  try { localStorage.setItem(PANELS_HIDDEN_KEY, JSON.stringify(hiddenPanels)); } catch { /* full */ }
  render(); // canvas width changed → refit the grid rect on the next frame
}
function togglePanel(p) {
  setHiddenPanels(hiddenPanels.includes(p) ? hiddenPanels.filter(q => q !== p) : [...hiddenPanels, p]);
}
$('notesHide').addEventListener('click', () => setHiddenPanels([...hiddenPanels, 'notes']));
$('notesToggle').addEventListener('click', () => togglePanel('notes'));
// Shift+Tab: hide every panel for a clean canvas, press again to restore the layout
let layoutBeforeHide = [];
window.addEventListener('keydown', e => {
  if (e.key !== 'Tab' || !e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
  // only from the canvas/body, so Shift+Tab still steps focus back through the UI
  if (e.target !== document.body && !$('canvasWrap').contains(e.target)) return;
  e.preventDefault();
  if (hiddenPanels.length === PANELS.length) setHiddenPanels(layoutBeforeHide);
  else { layoutBeforeHide = hiddenPanels; setHiddenPanels(PANELS); }
});

// ---- appearance (a UI pref, like the notes panel) ----
// Unset follows the OS; once toggled, the choice sticks.

// View → Draw Strands: each as set, or all as lines / molecules / sequences.
// A display preference (remembered per browser), not a document edit. The
// status bar's DNA button flips between all-lines and each-as-set.
const STRAND_VIEW_KEY = 'master-schemer-strand-view';
function setStrandView(mode, remember) {
  strandView.mode = mode;
  $('dnaToggle').setAttribute('aria-pressed', String(mode !== 'line'));
  if (remember) try { localStorage.setItem(STRAND_VIEW_KEY, mode); } catch { /* full */ }
  invalidateRenderCache();
  refresh();
}
$('dnaToggle').addEventListener('click', () => setStrandView(strandView.mode === 'line' ? 'own' : 'line', true));
{
  let saved = null;
  try {
    // ponytail: the old on/off DNA pref carries over once; drop after a release or two
    saved = localStorage.getItem(STRAND_VIEW_KEY) ?? (localStorage.getItem('master-schemer-dna-view') === 'off' ? 'line' : null);
  } catch { /* blocked */ }
  if (['line', 'dna', 'seq'].includes(saved)) setStrandView(saved, false);
}
// View → Mark 3′ Ends: a small chevron past every DNA strand's 3' end (display only)
const DNA_ENDS_KEY = 'master-schemer-dna-ends';
function setDNAEnds(on, remember) {
  dnaView.ends = on;
  if (remember) try { localStorage.setItem(DNA_ENDS_KEY, on ? 'on' : 'off'); } catch { /* full */ }
  invalidateRenderCache();
  refresh();
}
try { if (localStorage.getItem(DNA_ENDS_KEY) === 'on') setDNAEnds(true, false); } catch { /* blocked */ }

const THEME_KEY = 'master-schemer-theme';
function setTheme(dark, remember) {
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  $('themeToggle').setAttribute('aria-pressed', String(dark));
  if (remember) try { localStorage.setItem(THEME_KEY, dark ? 'dark' : 'light'); } catch { /* full */ }
}
$('themeToggle').addEventListener('click', () =>
  setTheme(document.documentElement.dataset.theme !== 'dark', true));
{
  let saved = null;
  try { saved = localStorage.getItem(THEME_KEY); } catch { /* blocked */ }
  setTheme(saved ? saved === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches, false);
}

// ---- boot ----

// Start every session on a fresh blank canvas (autosave still writes, so a
// future "recover last" could read it, but we no longer reopen it on launch).
{
  let saved = [];
  try {
    saved = JSON.parse(localStorage.getItem(PANELS_HIDDEN_KEY) || 'null')
      // ponytail: one-time carry-over of the old notes-only pref; drop after a release or two
      ?? (localStorage.getItem('master-schemer-notes-hidden') === '1' ? ['notes'] : []);
  } catch { /* default: all shown */ }
  setHiddenPanels(saved);
}
renderNotes();
setTool('select');
refresh();
state.view.tx = 80; state.view.ty = 80;
refresh();
