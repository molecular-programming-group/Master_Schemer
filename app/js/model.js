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

export const state = {
  doc: { version: 1, elements: [] },
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

export function newDoc() {
  beginChange();
  state.doc = { version: 1, elements: [] };
  state.selection = [];
  changed();
}

export function loadDocJSON(text) {
  const doc = JSON.parse(text);
  if (!Array.isArray(doc.elements)) throw new Error('not a Master Schemer document');
  beginChange();
  state.doc = doc;
  state.selection = [];
  changed();
}

export function restoreAutosave() {
  try {
    const text = localStorage.getItem(AUTOSAVE_KEY);
    if (text) state.doc = JSON.parse(text);
  } catch { /* corrupt autosave: start fresh */ }
}
