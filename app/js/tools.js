// Tool state machines. app.js routes pointer events here with world coords.
import {
  state, byId, beginChange, changed, addElement, isSelected, cloneElements, resolveColor,
  byGroup, groupElementMembers, cutPath,
} from './model.js';
import {
  GRID, snap, snapPt, snapHalf, snapHalfPt, eq, dirOf, snap8, simplify, polylineLength,
  nearestOnPath, pointAt, subPath, dist, rectsIntersect, insertIndex, bladeCross,
  resizeEndSegments,
} from './geom.js';
import { svgEl, SEL, inkD, worldToScreen, elementBBox } from './render.js';

const $ = id => document.getElementById(id);
const preview = () => $('layer-preview');
export const clearPreview = () => preview().replaceChildren();

let drag = null;
const r1 = v => Math.round(v * 10) / 10;
const ptsAttr = pts => pts.map(p => `${p[0]},${p[1]}`).join(' ');

// Annotation snapping (toggleable): grid-anchor a point unless snap is off.
const annSnap = p => (state.snap ? snapHalfPt(p) : [r1(p[0]), r1(p[1])]);
// Constrain a drag box to a square (Shift while drawing ellipse/rectangle).
const squareOff = (a, b) => {
  const d = Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
  return [a[0] + Math.sign(b[0] - a[0] || 1) * d, a[1] + Math.sign(b[1] - a[1] || 1) * d];
};

// Snapshot-once-per-drag: history entry is pushed on the first real mutation.
function began() {
  if (!drag.began) { beginChange(); drag.began = true; }
}

// Escape / tool-switch cancel. Rolls back any in-drag mutation.
export function cancelActive() {
  if (drag?.began) {
    state.doc = JSON.parse(state.history.pop());
  }
  drag = null;
  clearPreview();
  changed();
}

export const isDragging = () => drag !== null;

// ---- inline text editing (HTML overlay over the canvas) ----

export function startInlineEdit(el, opts) {
  // opts: { field, multiline, size, world, weight, onDone(value) }
  const wrap = $('canvasWrap');
  wrap.querySelector('.inline-edit')?.remove();
  const s = state.view.s;
  const sp = worldToScreen(opts.world);
  const node = document.createElement(opts.multiline ? 'textarea' : 'input');
  node.className = 'inline-edit';
  node.value = opts.value ?? el[opts.field] ?? '';
  node.style.left = `${sp[0] - 4}px`;
  node.style.top = `${sp[1] - 4}px`;
  if (opts.width) node.style.width = `${opts.width * s + 8}px`;
  node.style.fontSize = `${opts.size * s}px`;
  node.style.fontWeight = opts.weight || 400;
  node.style.color = opts.color || '#2b2622';
  if (opts.multiline) node.rows = (node.value.match(/\n/g)?.length ?? 0) + 1;
  wrap.appendChild(node);
  // hide the SVG twin while editing
  const twin = el.id && document.querySelector(`#world [data-id="${el.id}"]`);
  if (twin) twin.style.opacity = 0.15;

  let done = false;
  const finish = commit => {
    if (done) return;
    done = true;
    const value = node.value;
    node.remove();
    if (twin) twin.style.opacity = '';
    opts.onDone(commit ? value : null);
  };
  node.addEventListener('blur', () => finish(true));
  node.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Escape') finish(false);
    if (e.key === 'Enter' && (!opts.multiline || e.ctrlKey || e.metaKey)) finish(true);
  });
  node.focus();
  node.select();
}

export function editElementText(el) {
  if (el.type === 'text') {
    startInlineEdit(el, {
      field: 'text', multiline: true, size: el.size, color: resolveColor(el.color),
      world: [el.x, el.y - el.size], width: el.w,
      onDone: v => {
        if (v === null || v === el.text) return changed();
        beginChange();
        if (v.trim() === '') {
          state.doc.elements = state.doc.elements.filter(x => x.id !== el.id);
          state.selection = [];
        } else el.text = v;
        changed();
      },
    });
  } else if (el.type === 'card') {
    startInlineEdit(el, {
      field: 'title', size: 13.5, weight: 600,
      world: [el.x + 14, el.y + 25 - 13.5],
      onDone: v => {
        if (v === null || v === el.title) return changed();
        beginChange();
        el.title = v;
        changed();
      },
    });
  }
}

function createTextAt(wp, w) {
  const el = { type: 'text', x: wp[0], y: wp[1], text: '', size: 14, color: state.color };
  if (w) el.w = w; // wrap box: text folds at this width
  startInlineEdit(el, {
    field: 'text', multiline: true, size: el.size, color: resolveColor(el.color),
    world: [el.x, el.y - el.size], value: '', width: w,
    onDone: v => {
      if (!v || v.trim() === '') return;
      beginChange();
      el.text = v;
      addElement(el);
      state.selection = [{ id: el.id }];
      changed();
    },
  });
}

// ---- shared hit helpers ----

function hitCard(wp) {
  const els = state.doc.elements;
  for (let i = els.length - 1; i >= 0; i--) {
    const el = els[i];
    if (el.type === 'card' &&
        wp[0] >= el.x && wp[0] <= el.x + el.w &&
        wp[1] >= el.y && wp[1] <= el.y + el.h) return el;
  }
  return null;
}

function nearestPath(wp) {
  const threshold = Math.max(12 / state.view.s, 8);
  let best = null;
  for (const el of state.doc.elements) {
    if (el.type !== 'path') continue;
    const n = nearestOnPath(el.pts, wp);
    if (n.d <= threshold && (!best || n.d < best.d)) best = { el, t: n.t, d: n.d };
  }
  return best;
}

// Arc length on el nearest to wp, snapped to the half-grid lattice.
function halfSnapT(el, wp) {
  const n = nearestOnPath(el.pts, wp);
  const q = snapHalfPt(pointAt(el.pts, n.t));
  const n2 = nearestOnPath(el.pts, q);
  return n2.d < 1 ? n2.t : n.t; // lattice point off the path: keep the raw hit
}

function origOf(el) {
  if (el.x !== undefined) return { x: el.x, y: el.y };
  if (el.cx !== undefined) return { cx: el.cx, cy: el.cy };
  if (el.pts) return { pts: el.pts.map(p => [p[0], p[1]]) };
  return null;
}

function applyDelta(el, orig, dx, dy) {
  if (!orig) return;
  if (orig.pts) el.pts = orig.pts.map(p => [p[0] + dx, p[1] + dy]);
  else if (orig.cx !== undefined) { el.cx = orig.cx + dx; el.cy = orig.cy + dy; }
  else { el.x = orig.x + dx; el.y = orig.y + dy; }
}

// Elements riding along with a card: bbox center inside the card rect.
export function cardContents(card) {
  return state.doc.elements.filter(el => {
    if (el === card || el.type === 'card' || el.type === 'arrow') return false;
    const b = elementBBox(el);
    const cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2;
    return cx >= card.x && cx <= card.x + card.w && cy >= card.y && cy <= card.y + card.h;
  });
}

// Group ids from the top-level group down to the element's immediate group.
function groupChain(el) {
  const chain = [];
  let gid = el.group;
  while (gid) { chain.unshift(gid); gid = byGroup(gid)?.parent; }
  return chain;
}

// Move-drag items for the current selection: cards carry their contents, and a
// selected segment moves its whole parent line (grabbing a segment behaves like
// grabbing the object).
function moveItems() {
  const map = new Map();
  for (const s of state.selection) {
    const el = byId(s.id);
    if (!el || el.type === 'arrow' || el.type === 'link') continue;
    map.set(el.id, el);
    if (el.type === 'card') for (const c of cardContents(el)) map.set(c.id, c);
  }
  return [...map.values()].map(el => ({ el, orig: origOf(el) }));
}

// ---- path extension (drag an endpoint to keep laying down line) ----

function beginExtend(el, end) {
  const p = end ? el.pts[el.pts.length - 1] : el.pts[0];
  drag = { mode: 'extend', el, end, pts: [[p[0], p[1]], [p[0], p[1]]] };
}

function moveExtend(wp) {
  const pts = drag.pts;
  const a = pts[pts.length - 2], prov = pts[pts.length - 1];
  const p = snap8(a, wp, GRID / 2);
  const dNew = dirOf(a, p), dProv = dirOf(a, prov);
  if (eq(prov, a) || eq(p, a) || (dNew[0] === dProv[0] && dNew[1] === dProv[1])) {
    pts[pts.length - 1] = p;
  } else {
    const q = snap8(prov, wp, GRID / 2);
    if (!eq(q, prov)) pts.push(q);
  }
  clearPreview();
  svgEl('polyline', {
    points: ptsAttr(pts), fill: 'none', stroke: resolveColor(drag.el.color),
    'stroke-width': drag.el.width || 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round',
  }, preview());
}

function endExtend() {
  const { el, end } = drag;
  const ext = simplify(drag.pts);
  drag = null;
  clearPreview();
  if (ext.length < 2 || polylineLength(ext) === 0) { changed(); return; }
  beginChange();
  if (end) {
    el.pts = simplify([...el.pts, ...ext.slice(1)]);
  } else {
    // prepended length shifts every segment's arc-length range
    const add = polylineLength(ext);
    el.pts = simplify([...ext.slice(1).reverse(), ...el.pts]);
    for (const seg of el.segments || []) { seg.t0 += add; seg.t1 += add; }
  }
  state.selection = [{ id: el.id }];
  changed();
}

// ---- tools ----

export const tools = {

  select: {
    hint: 'Click to select · drag to move · Ctrl+drag to clone · drag a line end to extend it',
    down(e, wp) {
      const t = e.target;
      const handle = t.closest?.('[data-handle]');
      if (handle) {
        const el = byId(handle.getAttribute('data-id'));
        let orig;
        if (el.type === 'ellipse') orig = { x: el.cx - el.rx, y: el.cy - el.ry, w: 2 * el.rx, h: 2 * el.ry };
        else if (el.type === 'text') { const b = elementBBox(el); orig = { x: el.x, w: b[2] - b[0] }; }
        else orig = { x: el.x, y: el.y, w: el.w, h: el.h };
        drag = { mode: 'resize', el, handle: handle.getAttribute('data-handle'), orig };
        return;
      }
      // grabbing a line's end handle resizes it (moves that endpoint), consuming
      // or extruding line without shifting the segments. To keep laying down new
      // line instead, pick the Line tool (L) and drag from the end.
      const pend = t.closest?.('[data-pend]');
      if (pend) {
        const el = byId(pend.getAttribute('data-id'));
        const end = +pend.getAttribute('data-pend'); // 0 = first vertex, 1 = last
        drag = {
          mode: 'endresize', el, end, i: end ? el.pts.length - 1 : 0,
          origSegs: JSON.parse(JSON.stringify(el.segments || [])),
          origTotal: polylineLength(el.pts),
        };
        return;
      }
      const aend = t.closest?.('[data-aend]');
      if (aend) {
        drag = { mode: 'aend', el: byId(aend.getAttribute('data-id')), i: +aend.getAttribute('data-aend') };
        return;
      }
      const segh = t.closest?.('[data-seghandle]');
      if (segh) {
        drag = {
          mode: 'segadj', el: byId(segh.getAttribute('data-id')),
          i: +segh.getAttribute('data-segi'), end: +segh.getAttribute('data-seghandle'),
        };
        return;
      }
      // dragging a selected object's label repositions the label, not the object
      const lab = t.closest?.('[data-labelfor]');
      if (lab) {
        const id = lab.getAttribute('data-labelfor');
        const segAttr = lab.getAttribute('data-segi');
        const owner = byId(id);
        if (owner && (isSelected(id, undefined) || (segAttr !== null && isSelected(id, +segAttr)))) {
          const target = segAttr !== null ? owner.segments?.[+segAttr] : owner;
          if (target) {
            drag = { mode: 'label', target, start: wp, orig: target.labelOff || [0, 0] };
            return;
          }
        }
      }
      const group = t.closest?.('[data-id]');
      if (group) {
        const id = group.getAttribute('data-id');
        const el = byId(id);
        const segAttr = t.getAttribute('data-seg');
        const entry = segAttr !== null ? { id, seg: +segAttr } : { id };
        // A card's interior is transparent to the pointer: a press that isn't on
        // the title or the border starts a marquee, so objects sitting on the card
        // can be boxed without grabbing the card itself. Select/move the card by
        // its title, border, or corner handles.
        if (el?.type === 'card' && segAttr === null &&
            t.getAttribute?.('data-role') !== 'card-title') {
          const m = Math.max(10 / state.view.s, 6);
          const nearBorder =
            Math.abs(wp[0] - el.x) < m || Math.abs(wp[0] - (el.x + el.w)) < m ||
            Math.abs(wp[1] - el.y) < m || Math.abs(wp[1] - (el.y + el.h)) < m;
          if (!nearBorder) {
            if (!e.shiftKey) { state.selection = []; changed(); }
            drag = { mode: 'marquee', start: wp, add: e.shiftKey };
            return;
          }
        }
        if (e.shiftKey) {
          const i = state.selection.findIndex(s => s.id === entry.id && s.seg === entry.seg);
          if (i >= 0) state.selection.splice(i, 1); else state.selection.push(entry);
          changed();
          return;
        }
        // Grouped object: the first click selects the whole (top-level) group;
        // clicking again — without dragging — drills one level down the group
        // hierarchy, and finally to the object itself. Dragging always moves the
        // current selection, so a group stays draggable as a single unit.
        const grouped = entry.seg === undefined && el?.group;
        if (grouped) {
          const chain = groupChain(el); // [top … innermost]
          const selIds = new Set(state.selection.filter(s => s.seg === undefined).map(s => s.id));
          const isLevel = i => {
            const m = groupElementMembers(chain[i]);
            return m.length && m.length === selIds.size && m.every(x => selIds.has(x.id));
          };
          let level = -1;
          for (let i = 0; i < chain.length; i++) if (isLevel(i)) level = i;
          const objSelected = selIds.size === 1 && selIds.has(entry.id);
          if (level === -1 && !objSelected) {
            state.selection = groupElementMembers(chain[0]).map(x => ({ id: x.id }));
          }
          changed();
          if (e.ctrlKey || e.metaKey) {
            beginChange();
            const clones = cloneElements(state.selection.filter(s => s.seg === undefined).map(s => s.id));
            state.selection = clones.map(c => ({ id: c.id }));
            drag = { mode: 'move', start: wp, began: true, items: clones.map(c => ({ el: c, orig: origOf(c) })) };
            changed();
            return;
          }
          // drill (on pointer-up if no drag happens) only while a group level is selected
          drag = { mode: 'move', start: wp, items: moveItems(), drill: objSelected ? null : { chain, level, entry } };
          return;
        }
        if (!isSelected(entry.id, entry.seg)) state.selection = [entry];
        changed();
        // Ctrl+drag clones the selection and moves the copies
        if (e.ctrlKey || e.metaKey) {
          beginChange();
          const ids = state.selection.filter(s => s.seg === undefined).map(s => s.id);
          const withContents = new Set(ids);
          for (const cid of ids) {
            const c = byId(cid);
            if (c?.type === 'card') for (const inner of cardContents(c)) withContents.add(inner.id);
          }
          const clones = cloneElements([...withContents]);
          state.selection = clones.map(c => ({ id: c.id }));
          drag = {
            mode: 'move', start: wp, began: true,
            items: clones.map(c => ({ el: c, orig: origOf(c) })),
          };
          changed();
          return;
        }
        // cards move only by their border, so clicks inside don't fight the
        // objects sitting on them
        if (el?.type === 'card' && entry.seg === undefined) {
          const m = Math.max(10 / state.view.s, 6);
          const nearBorder =
            Math.abs(wp[0] - el.x) < m || Math.abs(wp[0] - (el.x + el.w)) < m ||
            Math.abs(wp[1] - el.y) < m || Math.abs(wp[1] - (el.y + el.h)) < m;
          if (!nearBorder) return;
        }
        const items = moveItems();
        if (items.length) drag = { mode: 'move', start: wp, items };
        return;
      }
      if (!e.shiftKey) { state.selection = []; changed(); }
      drag = { mode: 'marquee', start: wp, add: e.shiftKey };
    },
    move(e, wp) {
      if (!drag) return;
      if (drag.mode === 'extend') { moveExtend(wp); return; }
      if (drag.mode === 'endresize') {
        began();
        const el = drag.el;
        el.pts[drag.i] = snapHalfPt(wp);
        el.segments = resizeEndSegments(drag.origSegs, drag.origTotal, polylineLength(el.pts), drag.end);
        changed();
        return;
      }
      if (drag.mode === 'aend') {
        began();
        drag.el.pts[drag.i] = annSnap(wp);
        changed();
        return;
      }
      if (drag.mode === 'segadj') {
        const el = drag.el, seg = el.segments[drag.i];
        if (!seg) return;
        began();
        const t = r1(halfSnapT(el, wp));
        if (drag.end === 0) seg.t0 = t; else seg.t1 = t;
        if (seg.t0 > seg.t1) { [seg.t0, seg.t1] = [seg.t1, seg.t0]; drag.end = 1 - drag.end; }
        changed();
        return;
      }
      if (drag.mode === 'label') {
        began();
        drag.target.labelOff = [
          r1(drag.orig[0] + wp[0] - drag.start[0]),
          r1(drag.orig[1] + wp[1] - drag.start[1]),
        ];
        changed();
        return;
      }
      if (drag.mode === 'move') {
        const dx = snapHalf(wp[0] - drag.start[0]), dy = snapHalf(wp[1] - drag.start[1]);
        if (dx === 0 && dy === 0 && !drag.began) return;
        began();
        drag.moved = true;
        for (const it of drag.items) applyDelta(it.el, it.orig, dx, dy);
        changed();
      } else if (drag.mode === 'resize') {
        // text: only the wrap width is adjustable — set el.w (and shift x on the
        // west handle); the box becomes a wrapping note once it has a width
        if (drag.el.type === 'text') {
          const o = drag.orig, h = drag.handle, p = annSnap(wp);
          let x0 = o.x, x1 = o.x + o.w;
          if (h.includes('w')) x0 = Math.min(p[0], x1 - GRID);
          if (h.includes('e')) x1 = Math.max(p[0], x0 + GRID);
          began();
          drag.el.x = r1(x0);
          drag.el.w = r1(x1 - x0);
          changed();
          return;
        }
        const o = drag.orig, h = drag.handle, el = drag.el;
        let x0 = o.x, y0 = o.y, x1 = o.x + o.w, y1 = o.y + o.h;
        // cards keep the whole-grid lattice; rect/ellipse follow the snap toggle
        const p = el.type === 'card' ? snapPt(wp) : annSnap(wp);
        const min = el.type === 'card' ? 2 * GRID : GRID / 2;
        if (h.includes('w')) x0 = Math.min(p[0], x1 - min);
        if (h.includes('e')) x1 = Math.max(p[0], x0 + min);
        if (h.includes('n')) y0 = Math.min(p[1], y1 - min);
        if (h.includes('s')) y1 = Math.max(p[1], y0 + min);
        began();
        if (el.type === 'ellipse') {
          el.rx = r1((x1 - x0) / 2); el.ry = r1((y1 - y0) / 2);
          el.cx = r1(x0 + (x1 - x0) / 2); el.cy = r1(y0 + (y1 - y0) / 2);
        } else {
          Object.assign(el, { x: r1(x0), y: r1(y0), w: r1(x1 - x0), h: r1(y1 - y0) });
        }
        changed();
      } else if (drag.mode === 'marquee') {
        clearPreview();
        const [a, b] = [drag.start, wp];
        svgEl('rect', {
          x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]),
          width: Math.abs(b[0] - a[0]), height: Math.abs(b[1] - a[1]),
          fill: SEL, 'fill-opacity': 0.08, stroke: SEL,
          'stroke-width': 1 / state.view.s, 'stroke-dasharray': `${4 / state.view.s}`,
        }, preview());
        drag.end = wp;
      }
    },
    up(e, wp) {
      if (!drag) return;
      if (drag.mode === 'extend') { endExtend(); return; }
      if (drag.mode === 'endresize') {
        const el = drag.el;
        drag = null;
        el.pts = el.pts.filter((p, i) => i === 0 || !eq(p, el.pts[i - 1])); // drop dup neighbours
        changed();
        return;
      }
      // a click (no drag) on an already-group-selected object drills one level in
      if (drag.mode === 'move' && drag.drill && !drag.moved) {
        const { chain, level, entry } = drag.drill;
        const next = level + 1;
        state.selection = next < chain.length
          ? groupElementMembers(chain[next]).map(x => ({ id: x.id }))
          : [entry];
      }
      if (drag.mode === 'marquee' && drag.end) {
        const box = [
          Math.min(drag.start[0], drag.end[0]), Math.min(drag.start[1], drag.end[1]),
          Math.max(drag.start[0], drag.end[0]), Math.max(drag.start[1], drag.end[1]),
        ];
        // cards are excluded: a marquee drawn to grab objects sitting on a card
        // would otherwise scoop up the card too. Select/move a card by clicking
        // its body/border or title instead.
        const hits = state.doc.elements
          .filter(el => el.type !== 'arrow' && el.type !== 'card' && rectsIntersect(elementBBox(el), box))
          .map(el => ({ id: el.id }));
        state.selection = drag.add
          ? [...state.selection, ...hits.filter(h => !isSelected(h.id, undefined))]
          : hits;
      }
      clearPreview();
      drag = null;
      changed();
    },
    dbl(e) {
      const group = e.target.closest('[data-id]');
      if (!group) return;
      const el = byId(group.getAttribute('data-id'));
      if (el) editElementText(el);
    },
  },

  path: {
    hint: 'Click and drag along the grid — turns commit corners automatically · start on a line end to extend it',
    down(e, wp) {
      // starting on an existing path's endpoint continues that path
      const threshold = Math.max(12 / state.view.s, 8);
      for (const el of state.doc.elements) {
        if (el.type !== 'path') continue;
        if (dist(wp, el.pts[0]) <= threshold) return beginExtend(el, 0);
        if (dist(wp, el.pts[el.pts.length - 1]) <= threshold) return beginExtend(el, 1);
      }
      const a = snapHalfPt(wp); // lines live on the half-grid lattice
      drag = { pts: [a, [a[0], a[1]]] };
    },
    move(e, wp) {
      if (!drag) return;
      if (drag.mode === 'extend') { moveExtend(wp); return; }
      const pts = drag.pts;
      const a = pts[pts.length - 2], prov = pts[pts.length - 1];
      const p = snap8(a, wp, GRID / 2);
      const dNew = dirOf(a, p), dProv = dirOf(a, prov);
      if (eq(prov, a) || eq(p, a) || (dNew[0] === dProv[0] && dNew[1] === dProv[1])) {
        pts[pts.length - 1] = p;
      } else {
        // direction changed: the provisional point becomes a committed corner
        const q = snap8(prov, wp, GRID / 2);
        if (!eq(q, prov)) pts.push(q);
      }
      clearPreview();
      svgEl('polyline', {
        points: ptsAttr(pts), fill: 'none', stroke: resolveColor(state.color),
        'stroke-width': state.width, 'stroke-linejoin': 'round', 'stroke-linecap': 'round',
      }, preview());
      svgEl('circle', {
        cx: pts[0][0], cy: pts[0][1], r: 3 / state.view.s, fill: resolveColor(state.color),
      }, preview());
    },
    up() {
      if (!drag) return;
      if (drag.mode === 'extend') { endExtend(); return; }
      const pts = simplify(drag.pts);
      drag = null;
      clearPreview();
      if (pts.length < 2 || polylineLength(pts) === 0) { changed(); return; }
      beginChange();
      const el = addElement({
        type: 'path', pts, color: state.color, width: state.width, label: '', segments: [],
        linecap: 'butt', // line objects default to flat ends
      });
      state.selection = [{ id: el.id }];
      changed();
    },
  },

  segment: {
    hint: 'Press on a line and drag along it to define a colored segment · snaps to half-grid',
    down(e, wp) {
      const hit = nearestPath(wp);
      if (!hit) return;
      drag = { el: hit.el, t0: halfSnapT(hit.el, wp), t1: halfSnapT(hit.el, wp) };
    },
    move(e, wp) {
      if (!drag) return;
      drag.t1 = halfSnapT(drag.el, wp);
      clearPreview();
      const sp = subPath(drag.el.pts, Math.min(drag.t0, drag.t1), Math.max(drag.t0, drag.t1));
      svgEl('polyline', {
        points: ptsAttr(sp), fill: 'none', stroke: resolveColor(state.color),
        'stroke-width': (drag.el.width || 2) + 2.5, opacity: 0.85,
        'stroke-linejoin': 'round', 'stroke-linecap': 'round',
      }, preview());
    },
    up() {
      if (!drag) return;
      const { el, t0, t1 } = drag;
      drag = null;
      clearPreview();
      if (Math.abs(t1 - t0) < 6) { changed(); return; }
      beginChange();
      el.segments.push({
        t0: r1(Math.min(t0, t1)), t1: r1(Math.max(t0, t1)),
        color: state.color, label: '',
      });
      state.selection = [{ id: el.id, seg: el.segments.length - 1 }];
      changed();
    },
  },

  edit: {
    hint: 'Click a line to select it · drag a square handle to reshape · click the selected line to add a vertex',
    down(e, wp) {
      const v = e.target.closest?.('[data-vertex]');
      if (v) {
        drag = { mode: 'vertex', el: byId(v.getAttribute('data-id')), i: +v.getAttribute('data-vertex') };
        return;
      }
      const hit = nearestPath(wp);
      // clicking the already-selected line inserts a vertex there and grabs it
      if (hit && isSelected(hit.el.id, undefined)) {
        beginChange();
        const t = nearestOnPath(hit.el.pts, wp).t;
        const i = insertIndex(hit.el.pts, t);
        hit.el.pts.splice(i, 0, snapHalfPt(pointAt(hit.el.pts, t)));
        drag = { mode: 'vertex', el: hit.el, i, began: true };
        changed();
        return;
      }
      state.selection = hit ? [{ id: hit.el.id }] : [];
      changed();
    },
    move(e, wp) {
      if (!drag) return;
      began();
      drag.el.pts[drag.i] = snapHalfPt(wp);
      changed();
    },
    up() {
      if (!drag) return;
      // ponytail: segment arc-length ranges are not remapped when a vertex
      // moves — re-drag segment ends afterwards if they shifted
      const el = drag.el;
      drag = null;
      // drop exact duplicate neighbors created by dragging onto a neighbor
      el.pts = el.pts.filter((p, i) => i === 0 || !eq(p, el.pts[i - 1]));
      changed();
    },
  },

  card: {
    hint: 'Drag to frame a section card · release to create',
    down(e, wp) {
      drag = { a: snapPt(wp) };
    },
    move(e, wp) {
      if (!drag) return;
      drag.b = snapPt(wp);
      clearPreview();
      const [a, b] = [drag.a, drag.b];
      svgEl('rect', {
        x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]),
        width: Math.abs(b[0] - a[0]), height: Math.abs(b[1] - a[1]), rx: 10,
        fill: '#ffffff', 'fill-opacity': 0.7, stroke: SEL,
        'stroke-width': 1.5 / state.view.s, 'stroke-dasharray': `${5 / state.view.s}`,
      }, preview());
    },
    up(e, wp) {
      if (!drag) return;
      const a = drag.a, b = drag.b || snapPt(wp);
      drag = null;
      clearPreview();
      let x = Math.min(a[0], b[0]), y = Math.min(a[1], b[1]);
      let w = Math.abs(b[0] - a[0]), h = Math.abs(b[1] - a[1]);
      if (w < 2 * GRID || h < 2 * GRID) { [w, h] = [12 * GRID, 8 * GRID]; [x, y] = a; }
      beginChange();
      const el = addElement({ type: 'card', x, y, w, h, title: '' });
      state.selection = [{ id: el.id }];
      changed();
      editElementText(el);
    },
  },

  arrow: {
    hint: 'Drag from one card to another to connect them',
    down(e, wp) {
      const src = hitCard(wp);
      if (src) drag = { src };
    },
    move(e, wp) {
      if (!drag) return;
      clearPreview();
      const s = drag.src;
      const from = [s.x + s.w / 2, s.y + s.h / 2];
      svgEl('line', {
        x1: from[0], y1: from[1], x2: wp[0], y2: wp[1],
        stroke: SEL, 'stroke-width': 1.75 / state.view.s,
        'stroke-dasharray': `${6 / state.view.s}`, 'marker-end': 'url(#arrowHeadSel)',
      }, preview());
      const dst = hitCard(wp);
      if (dst && dst !== s) {
        svgEl('rect', {
          x: dst.x, y: dst.y, width: dst.w, height: dst.h, rx: 10,
          fill: 'none', stroke: SEL, 'stroke-width': 2 / state.view.s,
        }, preview());
      }
    },
    up(e, wp) {
      if (!drag) return;
      const src = drag.src, dst = hitCard(wp);
      drag = null;
      clearPreview();
      if (!dst || dst === src) { changed(); return; }
      const dup = state.doc.elements.some(el =>
        el.type === 'arrow' && el.from === src.id && el.to === dst.id);
      if (dup) { changed(); return; }
      beginChange();
      const el = addElement({ type: 'arrow', from: src.id, to: dst.id, label: '' });
      state.selection = [{ id: el.id }];
      changed();
    },
  },

  draw: {
    hint: 'Draw freehand — no snapping, just ink',
    down(e, wp) {
      drag = { pts: [[r1(wp[0]), r1(wp[1])]] };
    },
    move(e, wp) {
      if (!drag) return;
      const last = drag.pts[drag.pts.length - 1];
      if (dist(last, wp) < 1.5 / state.view.s) return;
      drag.pts.push([r1(wp[0]), r1(wp[1])]);
      clearPreview();
      svgEl('path', {
        d: inkD(drag.pts), fill: 'none', stroke: resolveColor(state.color),
        'stroke-width': state.width, 'stroke-linejoin': 'round', 'stroke-linecap': 'round',
      }, preview());
    },
    up() {
      if (!drag) return;
      const pts = drag.pts;
      drag = null;
      clearPreview();
      if (pts.length < 2) { changed(); return; }
      beginChange();
      const el = addElement({ type: 'ink', pts, color: state.color, width: state.width });
      state.selection = [{ id: el.id }];
      changed();
    },
  },

  ellipse: {
    hint: 'Drag to draw a circle or ellipse · Shift for a circle · snaps to grid (toggle in the status bar)',
    down(e, wp) {
      drag = { a: annSnap(wp) };
    },
    move(e, wp) {
      if (!drag) return;
      const a = drag.a, b = e.shiftKey ? squareOff(a, annSnap(wp)) : annSnap(wp);
      drag.b = b;
      clearPreview();
      svgEl('ellipse', {
        cx: (a[0] + b[0]) / 2, cy: (a[1] + b[1]) / 2,
        rx: Math.abs(b[0] - a[0]) / 2, ry: Math.abs(b[1] - a[1]) / 2,
        fill: 'none', stroke: resolveColor(state.color), 'stroke-width': state.width,
      }, preview());
    },
    up(e, wp) {
      if (!drag) return;
      const a = drag.a, b = drag.b || (e.shiftKey ? squareOff(a, annSnap(wp)) : annSnap(wp));
      drag = null;
      clearPreview();
      const rx = Math.abs(b[0] - a[0]) / 2, ry = Math.abs(b[1] - a[1]) / 2;
      if (rx < 3 && ry < 3) { changed(); return; }
      beginChange();
      const el = addElement({
        type: 'ellipse', cx: r1((a[0] + b[0]) / 2), cy: r1((a[1] + b[1]) / 2),
        rx: r1(Math.max(rx, 3)), ry: r1(Math.max(ry, 3)),
        color: state.color, width: state.width,
      });
      state.selection = [{ id: el.id }];
      changed();
    },
  },

  rect: {
    hint: 'Drag to draw a rectangle · Shift for a square · round corners from the panel · snaps to grid',
    down(e, wp) {
      drag = { a: annSnap(wp) };
    },
    move(e, wp) {
      if (!drag) return;
      const a = drag.a, b = e.shiftKey ? squareOff(a, annSnap(wp)) : annSnap(wp);
      drag.b = b;
      clearPreview();
      svgEl('rect', {
        x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]),
        width: Math.abs(b[0] - a[0]), height: Math.abs(b[1] - a[1]),
        fill: 'none', stroke: resolveColor(state.color), 'stroke-width': state.width,
      }, preview());
    },
    up(e, wp) {
      if (!drag) return;
      const a = drag.a, b = drag.b || (e.shiftKey ? squareOff(a, annSnap(wp)) : annSnap(wp));
      drag = null;
      clearPreview();
      const w = Math.abs(b[0] - a[0]), h = Math.abs(b[1] - a[1]);
      if (w < 4 && h < 4) { changed(); return; }
      beginChange();
      const el = addElement({
        type: 'rect', x: r1(Math.min(a[0], b[0])), y: r1(Math.min(a[1], b[1])),
        w: r1(Math.max(w, 4)), h: r1(Math.max(h, 4)), r: 0,
        color: state.color, width: state.width,
      });
      state.selection = [{ id: el.id }];
      changed();
    },
  },

  cut: {
    hint: 'Drag a blade across a line — the sliding dot marks where it slices; release to cut',
    down(e, wp) {
      drag = { mode: 'cut', a: wp, b: wp, locked: null, t: null };
    },
    move(e, wp) {
      if (!drag) return;
      drag.b = wp;
      // lock onto the first line the growing blade crosses; then the dot slides
      // along that one line only (never cuts across every object it touches)
      if (!drag.locked) {
        for (let i = state.doc.elements.length - 1; i >= 0; i--) {
          const el = state.doc.elements[i];
          if (el.type !== 'path') continue;
          const tc = bladeCross(el.pts, drag.a, drag.b);
          if (tc !== null) { drag.locked = el; drag.t = tc; break; }
        }
      } else {
        const tc = bladeCross(drag.locked.pts, drag.a, drag.b);
        if (tc !== null) drag.t = tc; // blade off the line: keep the last dot
      }
      clearPreview();
      svgEl('line', {
        x1: drag.a[0], y1: drag.a[1], x2: drag.b[0], y2: drag.b[1],
        stroke: SEL, 'stroke-width': 1.5 / state.view.s, 'stroke-dasharray': `${5 / state.view.s}`,
      }, preview());
      if (drag.locked && drag.t !== null) {
        const p = pointAt(drag.locked.pts, drag.t);
        svgEl('circle', {
          cx: p[0], cy: p[1], r: 6 / state.view.s,
          fill: '#fff', 'fill-opacity': 0.85, stroke: SEL, 'stroke-width': 2 / state.view.s,
        }, preview());
      }
    },
    up() {
      if (!drag) return;
      const { locked, t } = drag;
      drag = null;
      clearPreview();
      if (locked && t !== null) cutPath(locked, t); else changed();
    },
  },

  aline: { hint: 'Drag to draw a straight line annotation · snaps to grid (toggle in the status bar)' },
  aarrow: { hint: 'Drag to draw an arrow annotation · snaps to grid (toggle in the status bar)' },

  text: {
    hint: 'Click to place a note — or drag a box to set its wrap width · $math$ for LaTeX',
    // editor opens on pointerup: opening on pointerdown gets blurred by the
    // browser's default mousedown focus handling before typing can start
    down(e, wp) {
      drag = { a: wp };
    },
    move(e, wp) {
      if (!drag) return;
      drag.b = wp;
      if (Math.abs(wp[0] - drag.a[0]) < GRID) { clearPreview(); return; }
      clearPreview();
      const [a, b] = [drag.a, wp];
      svgEl('rect', {
        x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]),
        width: Math.abs(b[0] - a[0]), height: Math.abs(b[1] - a[1]),
        fill: 'none', stroke: SEL, 'stroke-width': 1 / state.view.s,
        'stroke-dasharray': `${4 / state.view.s}`,
      }, preview());
    },
    up(e, wp) {
      const a = drag?.a, b = drag?.b;
      drag = null;
      clearPreview();
      if (a && b && Math.abs(b[0] - a[0]) >= 2 * GRID) {
        // dragged a box: the note wraps at its width
        const x = snapHalf(Math.min(a[0], b[0]));
        const yTop = snapHalf(Math.min(a[1], b[1]));
        createTextAt([x, yTop + 14], snapHalf(Math.abs(b[0] - a[0])));
      } else {
        createTextAt(snapPt(wp));
      }
    },
  },
};

// aline and aarrow share one state machine; only the arrowhead differs.
for (const [name, cap1] of [['aline', 'none'], ['aarrow', 'barb']]) {
  Object.assign(tools[name], {
    down(e, wp) { const a = annSnap(wp); drag = { a, b: a }; },
    move(e, wp) {
      if (!drag) return;
      drag.b = annSnap(wp);
      clearPreview();
      svgEl('line', {
        x1: drag.a[0], y1: drag.a[1], x2: drag.b[0], y2: drag.b[1],
        stroke: resolveColor(state.color), 'stroke-width': state.width,
        'stroke-linecap': 'round',
      }, preview());
    },
    up(e, wp) {
      if (!drag) return;
      const a = drag.a, b = drag.b || annSnap(wp);
      drag = null;
      clearPreview();
      if (dist(a, b) < 4) { changed(); return; }
      beginChange();
      const el = addElement({
        type: 'aline', pts: [[r1(a[0]), r1(a[1])], [r1(b[0]), r1(b[1])]],
        color: state.color, width: state.width, cap0: 'none', cap1,
      });
      state.selection = [{ id: el.id }];
      changed();
    },
  });
}
