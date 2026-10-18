// Document model, selection, history, persistence.

import { polylineLength, subPath, splitSegments } from './geom.js';
import { defaultPalette } from './themes.js';
import MOLS from './mol-tex.js';

export const COLORS = [
  { name: 'Ink',     hex: '#2b2622' },
  { name: 'Red',     hex: '#c8352e' },
  { name: 'Orange',  hex: '#e0701f' },
  { name: 'Amber',   hex: '#d59c12' },
  { name: 'Green',   hex: '#3a8a3e' },
  { name: 'Teal',    hex: '#1f8fa0' },
  { name: 'Blue',    hex: '#2f6fd0' },
  { name: 'Violet',  hex: '#7a4fd0' },
  { name: 'Magenta', hex: '#c03a8c' },
  { name: 'Gray',    hex: '#8a857c' },
];

export const INK = COLORS[0].hex;

// Semantic objects are the tracked vocabulary of a scheme; everything else is
// annotation until the user promotes it (el.semantic = true).
export const isSemantic = el =>
  el.type === 'path' || el.type === 'card' || el.type === 'arrow' || !!el.semantic;

// Colors are either a literal '#rrggbb' or a palette reference 'slot:<id>'.
// References resolve at render time, so editing a slot recolors every user.
export function resolveColor(c) {
  if (typeof c === 'string' && c.startsWith('slot:')) {
    const slot = state.doc.palette?.find(s => s.id === c.slice(5));
    return slot ? slot.color : '#8a857c';
  }
  return c;
}

// Labels use the same trick: 'slot:<id>' points into doc.labelSlots, so
// editing a shared label retitles every element that references it.
export function resolveLabel(l) {
  if (typeof l === 'string' && l.startsWith('slot:')) {
    const slot = state.doc.labelSlots?.find(s => s.id === l.slice(5));
    return slot ? slot.text : '';
  }
  return l;
}

export const groupMembers = gid =>
  state.doc.elements.filter(el => el.group === gid);

// Groups nest: a group carries an optional `parent` group id. These walk the
// tree — child groups of gid, and every element that lives anywhere under gid.
export const byGroup = gid => state.doc.groups.find(g => g.id === gid);
export const childGroups = gid => state.doc.groups.filter(g => g.parent === gid);
export const topLevelGroups = () => state.doc.groups.filter(g => !g.parent || !byGroup(g.parent));

export function groupElementMembers(gid) {
  const out = state.doc.elements.filter(el => el.group === gid);
  for (const cg of childGroups(gid)) out.push(...groupElementMembers(cg.id));
  return out;
}

// A group is "empty" once it holds no elements and no child groups anywhere
// beneath it — those get swept away.
export function groupIsEmpty(gid) {
  if (state.doc.elements.some(el => el.group === gid)) return false;
  return childGroups(gid).every(cg => groupIsEmpty(cg.id));
}

export const state = {
  doc: { version: 3, elements: [], palette: defaultPalette(), groups: [], labelSlots: [], notes: '' },
  // selection entries: { id } for an element, { id, seg: i } for a path segment
  selection: [],
  tool: 'select',
  color: INK,
  textDefaults: {}, // formatting for new notes, set from the text toolbar with no note selected
  width: 2,
  drawLook: 'line', // what the Strand tool draws: line | dna | seq (a remembered drawing default)
  snap: true, // annotation shapes snap to the half-grid (toggle in the status bar)
  view: { tx: 0, ty: 0, s: 1 },
  history: [],
  future: [],
  dirty: false, // unsaved changes since the last file save (drives the close prompt)
};

const AUTOSAVE_KEY = 'master-schemer-doc';
const HISTORY_MAX = 100;
let idCounter = 0;
let onChanged = () => {};
let autosaveTimer = null;

export const setOnChanged = fn => { onChanged = fn; };

export const newId = () => `e${Date.now().toString(36)}${(idCounter++).toString(36)}`;

export const byId = id => state.doc.elements.find(el => el.id === id);

// Call before mutating the doc; snapshots current state for undo.
export function beginChange() {
  state.history.push(JSON.stringify(state.doc));
  if (state.history.length > HISTORY_MAX) state.history.shift();
  state.future = [];
}

// Mark the doc dirty and schedule an autosave, WITHOUT triggering a re-render.
// Used for changes that repaint themselves (notes typing), so a keystroke
// doesn't rebuild the whole canvas/panel. load/new/save clear dirty again.
export function touch() {
  state.dirty = true;
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    try { localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(state.doc)); } catch { /* full/blocked */ }
  }, 300);
}

// Call after mutating the doc.
export function changed() {
  touch();
  onChanged();
}

export function undo() {
  if (!state.history.length) return;
  state.future.push(JSON.stringify(state.doc));
  state.doc = JSON.parse(state.history.pop());
  state.selection = [];
  changed();
}

export function redo() {
  if (!state.future.length) return;
  state.history.push(JSON.stringify(state.doc));
  state.doc = JSON.parse(state.future.pop());
  state.selection = [];
  changed();
}

export function addElement(el) {
  el.id = el.id || newId();
  state.doc.elements.push(el);
  return el;
}

export function deleteSelection() {
  if (!state.selection.length) return;
  beginChange();
  // Segment selections remove just the segment; element selections remove the
  // element plus any arrows referencing a deleted card.
  const segSel = state.selection.filter(s => s.seg !== undefined);
  for (const s of segSel) {
    const el = byId(s.id);
    if (el?.segments) el.segments.splice(s.seg, 1);
  }
  const ids = new Set(state.selection.filter(s => s.seg === undefined).map(s => s.id));
  // arrows to a deleted card, and links touching a deleted element, go too
  state.doc.elements = state.doc.elements.filter(el =>
    !ids.has(el.id) &&
    !(el.type === 'arrow' && (ids.has(el.from) || ids.has(el.to))) &&
    !(el.type === 'link' && (ids.has(el.a?.id) || ids.has(el.b?.id))));
  pruneGroups();
  state.selection = [];
  changed();
}

// Groups with no remaining members (elements or child groups) disappear;
// repeats until nothing more collapses, so orphaned parents go too.
export function pruneGroups() {
  const groups = state.doc.groups || [];
  let changedAny = true;
  while (changedAny) {
    changedAny = false;
    for (let i = groups.length - 1; i >= 0; i--) {
      if (groupIsEmpty(groups[i].id)) { groups.splice(i, 1); changedAny = true; }
    }
  }
  // heal dangling parent pointers
  for (const g of groups) if (g.parent && !groups.some(p => p.id === g.parent)) delete g.parent;
  state.doc.groups = groups;
}

export const isSelected = (id, seg) =>
  state.selection.some(s => s.id === id && s.seg === seg);

// The single selected entry, or null if empty/multiple.
export function selectionSingle() {
  if (state.selection.length !== 1) return null;
  const s = state.selection[0];
  const el = byId(s.id);
  if (!el) return null;
  return { el, seg: s.seg };
}

// Clone elements (deep copy, fresh ids). Arrows between cloned cards are
// re-pointed at the clones; arrows to un-cloned cards are dropped.
export function cloneElements(ids) {
  const idMap = new Map();
  const clones = [];
  for (const id of ids) {
    const el = byId(id);
    if (!el) continue;
    const copy = JSON.parse(JSON.stringify(el));
    copy.id = newId();
    idMap.set(el.id, copy.id);
    clones.push(copy);
  }
  const out = clones.filter(c => {
    if (c.type === 'arrow') {
      if (!idMap.has(c.from) || !idMap.has(c.to)) return false;
      c.from = idMap.get(c.from); c.to = idMap.get(c.to);
    } else if (c.type === 'link') {
      // keep a link only if both ends were cloned too (group ends survive as-is)
      if (c.a?.id && !idMap.has(c.a.id)) return false;
      if (c.b?.id && !idMap.has(c.b.id)) return false;
      if (c.a?.id) c.a = { ...c.a, id: idMap.get(c.a.id) };
      if (c.b?.id) c.b = { ...c.b, id: idMap.get(c.b.id) };
    }
    return true;
  });
  // cloned group members land in fresh groups, whole nested chain copied
  const groupMap = new Map();
  const cloneGroupChain = gid => {
    if (!gid) return undefined;
    if (groupMap.has(gid)) return groupMap.get(gid);
    const src = byGroup(gid);
    const ng = { id: newId(), name: src ? `${src.name} copy` : 'group' };
    groupMap.set(gid, ng.id); // set before recursing so cycles can't loop
    if (src?.parent) ng.parent = cloneGroupChain(src.parent);
    state.doc.groups.push(ng);
    return ng.id;
  };
  for (const c of out) if (c.group) c.group = cloneGroupChain(c.group);
  state.doc.elements.push(...out);
  return out;
}

// Cut a path at arc length tc into two child paths, as if sliced. Both children
// inherit the full parent metadata — colour, width, label, pattern, group, and
// the complete cap pair on both ends. Segments are sliced at tc, and any link
// that referenced the parent is removed. Returns the two children, or null if
// the cut lands too close to an end.
export function cutPath(el, tc) {
  if (el?.type !== 'path') return null;
  const total = polylineLength(el.pts);
  if (tc <= 0.5 || tc >= total - 0.5) return null;
  beginChange();
  const [segsA, segsB] = splitSegments(el.segments, tc, total);
  const mk = (pts, segments) => {
    const c = JSON.parse(JSON.stringify(el)); // deep-copy so children never share refs
    delete c.bases; // a DNA strand's free base count doesn't split meaningfully: back to auto
    return Object.assign(c, { id: newId(), pts, segments });
  };
  const a = mk(subPath(el.pts, 0, tc), segsA);
  const b = mk(subPath(el.pts, tc, total), segsB);
  const i = state.doc.elements.indexOf(el);
  state.doc.elements.splice(i, 1, a, b); // children take the parent's paint slot
  state.doc.elements = state.doc.elements.filter(x =>
    !(x.type === 'link' && (x.a?.id === el.id || x.b?.id === el.id)));
  state.selection = [{ id: a.id }, { id: b.id }];
  changed();
  return [a, b];
}

// Split only the domain under arc length tc and leave the strand whole: a nick's
// partner site, so each half can pair with its own strand. On a bare stretch of
// line, the stretch between neighbouring segments becomes the two domains.
// Links to a split segment drop away; the second half is appended so every
// other segment index (and the links using it) holds. Returns the two halves.
export function splitDomain(el, tc) {
  if (el?.type !== 'path') return null;
  const total = polylineLength(el.pts);
  tc = Math.round(tc * 10) / 10;
  const segs = el.segments ||= [];
  let i = segs.findIndex(s => s.t0 < tc && tc < s.t1);
  const s = i >= 0 ? segs[i] : {
    t0: Math.max(0, ...segs.map(g => g.t1).filter(t => t <= tc)),
    t1: Math.min(total, ...segs.map(g => g.t0).filter(t => t >= tc)),
    color: el.color, label: '',
  };
  if (tc - s.t0 < 1 || s.t1 - tc < 1) return null;
  beginChange();
  const half = (t0, t1, n) => {
    const h = { ...s, t0, t1 };
    delete h.bases; // back to auto, like a cut strand
    if (s.label) h.label = s.label + n;
    if (/^[ACGTU]+$/i.test(s.string || '')) {
      const k = Math.round(s.string.length * (tc - s.t0) / (s.t1 - s.t0));
      h.string = n === 1 ? s.string.slice(0, k) : s.string.slice(k);
    }
    return h;
  };
  const a = half(s.t0, tc, 1), b = half(tc, s.t1, 2);
  if (i >= 0) {
    segs[i] = a;
    const hit = r => r?.id === el.id && r.seg === i;
    state.doc.elements = state.doc.elements.filter(x => !(x.type === 'link' && (hit(x.a) || hit(x.b))));
  } else { segs.push(a); i = segs.length - 1; }
  segs.push(b);
  state.selection = [{ id: el.id, seg: i }, { id: el.id, seg: segs.length - 1 }];
  changed();
  return [a, b];
}

// Z-order: element order in doc.elements is paint order within its layer group.
export function reorder(dir) {
  const ids = new Set(state.selection.filter(s => s.seg === undefined).map(s => s.id));
  if (!ids.size) return;
  beginChange();
  const els = state.doc.elements;
  if (dir === 'front' || dir === 'back') {
    const picked = els.filter(el => ids.has(el.id));
    const rest = els.filter(el => !ids.has(el.id));
    state.doc.elements = dir === 'front' ? [...rest, ...picked] : [...picked, ...rest];
  } else if (dir === 'up') {
    for (let i = els.length - 2; i >= 0; i--)
      if (ids.has(els[i].id) && !ids.has(els[i + 1].id))
        [els[i], els[i + 1]] = [els[i + 1], els[i]];
  } else {
    for (let i = 1; i < els.length; i++)
      if (ids.has(els[i].id) && !ids.has(els[i - 1].id))
        [els[i], els[i - 1]] = [els[i - 1], els[i]];
  }
  changed();
}

function migrate(doc) {
  doc.palette ||= [];
  doc.groups ||= [];
  doc.labelSlots ||= [];
  doc.notes ||= '';
  doc.version = 3;
  return doc;
}

export function newDoc() {
  beginChange();
  state.doc = { version: 3, elements: [], palette: defaultPalette(), groups: [], labelSlots: [], notes: '' };
  state.selection = [];
  changed();
}

export function loadDocJSON(text) {
  const doc = JSON.parse(text);
  if (!Array.isArray(doc.elements)) throw new Error('not a Master Schemer document');
  beginChange();
  state.doc = migrate(doc);
  state.selection = [];
  changed();
}

export function restoreAutosave() {
  try {
    const text = localStorage.getItem(AUTOSAVE_KEY);
    if (text) state.doc = migrate(JSON.parse(text));
  } catch { /* corrupt autosave: start fresh */ }
}

// An object's name: its own `name` if the user gave it one, else a default
// built from what it shows (label, title, text, or what a link joins), else a
// per-kind count ("strand 3" is the third strand, whatever lies between).
export function displayName(el) { return el.name || defaultName(el); }

const KIND_WORD = {
  path: 'strand', ink: 'freehand', ellipse: 'ellipse', rect: 'rectangle', aarrow: 'arrow',
  text: 'note', link: 'link', arrow: 'connection', card: 'card',
};
export const kindWord = el => MOLS[el.mol] ? MOLS[el.mol].name
  : el.type === 'aline' ? (el.cap0 && el.cap0 !== 'none') || (el.cap1 && el.cap1 !== 'none') ? 'arrow' : 'line'
  : KIND_WORD[el.type] || el.type;

// ponytail: per-kind counts are one O(n) pass, cached until the next refresh
// (or an element the cache hasn't seen) so a 700-row sidebar stays linear.
let ordCache = null, idCache = null;
export const clearNameCache = () => { ordCache = idCache = null; };
function ordinal(el) {
  if (!ordCache?.has(el)) {
    ordCache = new Map(); idCache = new Map();
    const n = {};
    for (const e of state.doc.elements) {
      const w = kindWord(e); n[w] = (n[w] || 0) + 1; ordCache.set(e, n[w]); idCache.set(e.id, e);
    }
  }
  return ordCache.get(el) || 1;
}
const cachedById = id => { if (!idCache) ordinal(state.doc.elements[0]); return idCache?.get(id) || byId(id); };

// One end of a link or connection: a domain's label, a group's name, or the
// object's own name.
function endName(t) {
  if (!t) return '';
  if (t.group) return byGroup(t.group)?.name || '';
  const el = cachedById(t.id ?? t);
  if (!el || el.type === 'link' || el.type === 'arrow') return '';
  const seg = t.seg !== undefined ? el.segments?.[t.seg] : null;
  return (seg && resolveLabel(seg.label || '')) || displayName(el);
}

export function defaultName(el) {
  if (el.type === 'card') return el.title || 'Untitled card';
  const label = resolveLabel(el.label || '');
  if (label) return label;
  if (el.type === 'text') return el.text.split('\n')[0] || 'note';
  if (MOLS[el.mol]) return MOLS[el.mol].name;
  if (el.type === 'link' || el.type === 'arrow') {
    const [a, b] = el.type === 'link' ? [el.a, el.b] : [el.from, el.to];
    const na = endName(a), nb = endName(b);
    if (na && nb) return `${na} ${el.type === 'link' ? '↔' : '→'} ${nb}`;
  }
  return `${kindWord(el)} ${ordinal(el)}`;
}
