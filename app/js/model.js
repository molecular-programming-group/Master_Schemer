// Document model, selection, history, persistence.

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

export const state = {
  doc: { version: 2, elements: [], palette: [] },
  // selection entries: { id } for an element, { id, seg: i } for a path segment
  selection: [],
  tool: 'select',
  color: INK,
  width: 2,
  view: { tx: 0, ty: 0, s: 1 },
  history: [],
  future: [],
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

// Call after mutating the doc.
export function changed() {
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    try { localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(state.doc)); } catch { /* full/blocked */ }
  }, 300);
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
  state.doc.elements = state.doc.elements.filter(el =>
    !ids.has(el.id) && !(el.type === 'arrow' && (ids.has(el.from) || ids.has(el.to))));
  state.selection = [];
  changed();
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
    if (c.type !== 'arrow') return true;
    if (!idMap.has(c.from) || !idMap.has(c.to)) return false;
    c.from = idMap.get(c.from); c.to = idMap.get(c.to);
    return true;
  });
  state.doc.elements.push(...out);
  return out;
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
  doc.version = 2;
  return doc;
}

export function newDoc() {
  beginChange();
  state.doc = { version: 2, elements: [], palette: [] };
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
