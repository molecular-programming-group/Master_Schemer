// Document model, selection, history, persistence.

import { polylineLength, subPath, splitSegments } from './geom.js';
import { defaultPalette } from './themes.js';
import { seqOf, seqLetters } from './dna.js';

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

// ---- domains by name ----
// A domain is a name: every line or segment labelled "a" is domain a, and "a*"
// (or $x^*$) its complement. A colour set on a name (doc.domains[name]) paints
// every use — the complement a lighter shade of it — unless a use opts out
// (ownColor). syncDomains writes that colour onto the uses on every change, so
// rendering, export and copy/paste just see ordinary colours.

// A label read as a domain name: { name, comp } plus the parts a rename keeps.
export function domainKey(label) {
  const t = (resolveLabel(label) || '').trim();
  if (!t) return null;
  const m = t.match(/^(.+?)(\^\{\*\}|\^\*|\*)(\$?)$/);
  return m ? { name: m[1] + m[3], comp: true, pre: m[1], suf: m[2], end: m[3] } : { name: t, comp: false };
}

// Every line and segment that is a domain, with its key: [{ el, obj, seg?, key }].
export function domainUses() {
  const out = [];
  for (const el of state.doc.elements) {
    if (el.type !== 'path') continue;
    const k = domainKey(el.label);
    if (k) out.push({ el, obj: el, key: k });
    (el.segments || []).forEach((sg, i) => { const ks = domainKey(sg.label); if (ks) out.push({ el, obj: sg, seg: i, key: ks }); });
  }
  return out;
}

// A colour mixed toward white by k (the complement's lighter shade).
const lighter = (hex, k = 0.45) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return '#' + [16, 8, 0].map(sh => Math.round(((n >> sh) & 255) * (1 - k) + 255 * k).toString(16).padStart(2, '0')).join('');
};

const PATTERN_KEYS = ['pattern', 'patternBg', 'patternScale'];
export function syncDomains() {
  const doms = state.doc.domains;
  if (!doms || !Object.keys(doms).length) return;
  for (const { obj, key } of domainUses()) {
    const d = doms[key.name];
    if (!d?.color || obj.ownColor) continue;
    const c = key.comp ? lighter(resolveColor(d.color)) : d.color;
    if (obj.color !== c) obj.color = c;
    for (const k of PATTERN_KEYS) if (d[k] === undefined) delete obj[k]; else obj[k] = d[k];
  }
}

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
  doc: { version: 3, elements: [], palette: defaultPalette(), groups: [], labelSlots: [], domains: {}, notes: '' },
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

const HISTORY_MAX = 100;
let idCounter = 0;
let onChanged = () => {};

export const setOnChanged = fn => { onChanged = fn; };

export const newId = () => `e${Date.now().toString(36)}${(idCounter++).toString(36)}`;

export const byId = id => state.doc.elements.find(el => el.id === id);

// Call before mutating the doc; snapshots current state for undo.
export function beginChange() {
  state.history.push(JSON.stringify(state.doc));
  if (state.history.length > HISTORY_MAX) state.history.shift();
  state.future = [];
  state.dirty = true;
}

// Mark the doc dirty WITHOUT triggering a re-render, for changes that repaint
// themselves (notes typing) and so skip history. load/new/save clear dirty again.
export function touch() {
  state.dirty = true;
}

// Call after mutating the doc (or the selection); beginChange marks it dirty.
export function changed() {
  // the drawing colour can't point at a slot this doc no longer has (new, open, undo)
  if (String(state.color).startsWith('slot:') && !state.doc.palette.some(sl => `slot:${sl.id}` === state.color)) state.color = INK;
  syncDomains();
  onChanged();
}

// Undo/redo swap whole docs (notes included: the notes editor re-reads them).
function swapDoc(from, to) {
  if (!from.length) return;
  to.push(JSON.stringify(state.doc));
  state.doc = JSON.parse(from.pop());
  state.selection = [];
  state.dirty = true;
  changed();
}
export const undo = () => swapDoc(state.history, state.future);
export const redo = () => swapDoc(state.future, state.history);

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
  for (const id of new Set(segSel.map(s => s.id))) {
    const el = byId(id);
    if (!el?.segments) continue;
    const gone = new Set(segSel.filter(s => s.id === id).map(s => s.seg));
    const kept = el.segments.map((_, i) => i).filter(i => !gone.has(i));
    el.segments = kept.map(i => el.segments[i]);
    remapSegLinks(id, kept);
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

// Links name segments by index: after a strand's segment list is edited, `kept`
// lists the old index of each surviving segment in its new order. Links to a
// segment that went are removed; the rest follow their segment.
export function remapSegLinks(id, kept) {
  const to = new Map(kept.map((o, n) => [o, n]));
  const ok = r => r?.id !== id || r.seg === undefined || to.has(r.seg);
  state.doc.elements = state.doc.elements.filter(x => x.type !== 'link' || (ok(x.a) && ok(x.b)));
  for (const x of state.doc.elements) if (x.type === 'link') for (const k of ['a', 'b'])
    if (x[k]?.id === id && x[k].seg !== undefined) x[k] = { ...x[k], seg: to.get(x[k].seg) };
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
  // and links between groups go with their groups
  state.doc.elements = state.doc.elements.filter(l => !(l.type === 'link' &&
    [l.a, l.b].some(r => r?.group && !groups.some(g => g.id === r.group))));
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
// A strand Sequence is shared out at base index k (the caller's DNA layout; by
// default in proportion to length), a domain sequence straddling the cut likewise.
export function cutPath(el, tc, k) {
  if (el?.type !== 'path') return null;
  const total = polylineLength(el.pts);
  if (tc <= 0.5 || tc >= total - 0.5) return null;
  beginChange();
  const [segsA, segsB] = splitSegments(el.segments, tc, total);
  const mid = (el.segments || []).find(s => s.t0 < tc && tc < s.t1);
  if (mid && segsA.length && segsB.length) {
    splitString(segsA[segsA.length - 1], mid, (tc - mid.t0) / (mid.t1 - mid.t0), true);
    splitString(segsB[0], mid, (tc - mid.t0) / (mid.t1 - mid.t0), false);
  }
  const q = seqLetters(el.seq);
  k ??= Math.round(q.length * tc / total);
  const mk = (pts, segments, seq) => {
    const c = JSON.parse(JSON.stringify(el)); // deep-copy so children never share refs
    delete c.bases; // a DNA strand's free base count doesn't split meaningfully: back to auto
    if (q) c.seq = seq;
    return Object.assign(c, { id: newId(), pts, segments });
  };
  const a = mk(subPath(el.pts, 0, tc), segsA, q.slice(0, k));
  const b = mk(subPath(el.pts, tc, total), segsB, q.slice(k));
  const i = state.doc.elements.indexOf(el);
  state.doc.elements.splice(i, 1, a, b); // children take the parent's paint slot
  state.doc.elements = state.doc.elements.filter(x =>
    !(x.type === 'link' && (x.a?.id === el.id || x.b?.id === el.id)));
  state.selection = [{ id: a.id }, { id: b.id }];
  changed();
  return [a, b];
}

// Half h of domain s split at fraction f takes its share of a sequence String;
// a half too short to read as a sequence (seqOf) keeps its count in `bases`,
// and a set base count is shared out the same way.
function splitString(h, s, f, first) {
  const q = seqOf(s.string);
  if (!q) {
    if (s.bases !== undefined) { const k = Math.round(s.bases * f); h.bases = first ? k : s.bases - k; }
    return;
  }
  const k = Math.round(q.length * f);
  h.string = first ? q.slice(0, k) : q.slice(k);
  if (h.string.length < 4) h.bases = h.string.length; else delete h.bases;
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
    if (s.label) h.label = resolveLabel(s.label) + n;
    splitString(h, s, (tc - s.t0) / (s.t1 - s.t0), n === 1);
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

// An element with the geometry its type needs (a damaged or hand-made file may lack it).
const num = (...v) => v.every(Number.isFinite);
function drawable(el) {
  if (!el || typeof el !== 'object') return false;
  switch (el.type) {
    case 'path': case 'ink': case 'aline':
      return Array.isArray(el.pts) && el.pts.length >= 2 && el.pts.every(p => Array.isArray(p) && num(p[0], p[1]));
    case 'card': case 'rect': return num(el.x, el.y, el.w, el.h);
    case 'ellipse': return num(el.cx, el.cy, el.rx, el.ry);
    case 'text': return num(el.x, el.y) && typeof el.text === 'string';
    default: return true;
  }
}

function migrate(doc) {
  doc.palette ||= [];
  doc.groups ||= [];
  doc.labelSlots ||= [];
  doc.domains ||= {};
  doc.notes ||= '';
  // shared labels (older files) become plain names, which now share by themselves;
  // a shared label's colour slot becomes its domain's colour
  const text = l => doc.labelSlots.find(sl => `slot:${sl.id}` === l)?.text ?? '';
  for (const sl of doc.labelSlots) {
    const k = sl.colorSlot && domainKey(sl.text);
    if (k && !doc.domains[k.name]) doc.domains[k.name] = { color: `slot:${sl.colorSlot}` };
  }
  for (const o of doc.elements.flatMap(el => [el, ...(el.segments || [])]))
    if (typeof o.label === 'string' && o.label.startsWith('slot:')) o.label = text(o.label);
  doc.labelSlots = [];
  doc.elements = doc.elements.filter(drawable); // a damaged element is dropped, not loaded to break the app
  for (const el of doc.elements) { // fields the editor assumes, missing from hand-made files
    if (el.type === 'path') el.segments ||= [];
    if (el.type === 'text') el.size ||= 14;
  }
  doc.version = 3;
  return doc;
}

export function newDoc() {
  beginChange();
  state.doc = { version: 3, elements: [], palette: defaultPalette(), groups: [], labelSlots: [], domains: {}, notes: '' };
  state.selection = [];
  changed();
}

export function loadDocJSON(text) {
  const doc = JSON.parse(text);
  if (!Array.isArray(doc.elements)) throw new Error('not a Master Schemer document');
  // a fresh history: undoing into the previous doc would let Save write it over this file
  const prev = { doc: state.doc, history: state.history, future: state.future, selection: state.selection };
  Object.assign(state, { doc: migrate(doc), history: [], future: [], selection: [] });
  try { changed(); } catch (e) { // a file that can't be drawn: put the old doc back
    Object.assign(state, prev);
    changed();
    throw e;
  }
}
