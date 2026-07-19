// Tool state machines. app.js routes pointer events here with world coords.
import {
  state, byId, beginChange, changed, addElement, isSelected,
} from './model.js';
import {
  GRID, snap, snapPt, eq, dirOf, snap8, simplify, polylineLength,
  nearestOnPath, subPath, dist, rectsIntersect,
} from './geom.js';
import { svgEl, SEL, inkD, worldToScreen, elementBBox } from './render.js';

const $ = id => document.getElementById(id);
const preview = () => $('layer-preview');
export const clearPreview = () => preview().replaceChildren();

let drag = null;
const r1 = v => Math.round(v * 10) / 10;
const ptsAttr = pts => pts.map(p => `${p[0]},${p[1]}`).join(' ');

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
      field: 'text', multiline: true, size: el.size, color: el.color,
      world: [el.x, el.y - el.size],
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

function createTextAt(wp) {
  const el = { type: 'text', x: wp[0], y: wp[1], text: '', size: 14, color: state.color };
  startInlineEdit(el, {
    field: 'text', multiline: true, size: el.size, color: el.color,
    world: [el.x, el.y - el.size], value: '',
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

function origOf(el) {
  if (el.type === 'card') return { x: el.x, y: el.y };
  if (el.type === 'text') return { x: el.x, y: el.y };
  if (el.pts) return { pts: el.pts.map(p => [p[0], p[1]]) };
  return null;
}

function applyDelta(el, orig, dx, dy) {
  if (!orig) return;
  if (orig.pts) el.pts = orig.pts.map(p => [p[0] + dx, p[1] + dy]);
  else { el.x = orig.x + dx; el.y = orig.y + dy; }
}

// ---- tools ----

export const tools = {

  select: {
    hint: 'Click to select · drag to move · drag empty space for marquee · double-click text to edit',
    down(e, wp) {
      const handle = e.target.closest('[data-handle]');
      if (handle) {
        const el = byId(handle.getAttribute('data-id'));
        drag = { mode: 'resize', el, handle: handle.getAttribute('data-handle'),
                 orig: { x: el.x, y: el.y, w: el.w, h: el.h } };
        return;
      }
      const group = e.target.closest('[data-id]');
      if (group) {
        const id = group.getAttribute('data-id');
        const segAttr = e.target.getAttribute('data-seg');
        const entry = segAttr !== null ? { id, seg: +segAttr } : { id };
        if (e.shiftKey) {
          const i = state.selection.findIndex(s => s.id === entry.id && s.seg === entry.seg);
          if (i >= 0) state.selection.splice(i, 1); else state.selection.push(entry);
        } else if (!isSelected(entry.id, entry.seg)) {
          state.selection = [entry];
        }
        changed();
        // move drag applies to element selections only (segments ride along)
        const movables = state.selection.filter(s => s.seg === undefined);
        if (!e.shiftKey && movables.length) {
          drag = {
            mode: 'move', start: wp,
            items: movables.map(s => ({ el: byId(s.id), orig: origOf(byId(s.id)) })),
          };
        }
        return;
      }
      if (!e.shiftKey) { state.selection = []; changed(); }
      drag = { mode: 'marquee', start: wp, add: e.shiftKey };
    },
    move(e, wp) {
      if (!drag) return;
      if (drag.mode === 'move') {
        const dx = snap(wp[0] - drag.start[0]), dy = snap(wp[1] - drag.start[1]);
        if (dx === 0 && dy === 0 && !drag.began) return;
        began();
        for (const it of drag.items) applyDelta(it.el, it.orig, dx, dy);
        changed();
      } else if (drag.mode === 'resize') {
        const o = drag.orig, h = drag.handle;
        let x0 = o.x, y0 = o.y, x1 = o.x + o.w, y1 = o.y + o.h;
        const p = snapPt(wp);
        if (h.includes('w')) x0 = Math.min(p[0], x1 - 2 * GRID);
        if (h.includes('e')) x1 = Math.max(p[0], x0 + 2 * GRID);
        if (h.includes('n')) y0 = Math.min(p[1], y1 - 2 * GRID);
        if (h.includes('s')) y1 = Math.max(p[1], y0 + 2 * GRID);
        began();
        Object.assign(drag.el, { x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
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
      if (drag.mode === 'marquee' && drag.end) {
        const box = [
          Math.min(drag.start[0], drag.end[0]), Math.min(drag.start[1], drag.end[1]),
          Math.max(drag.start[0], drag.end[0]), Math.max(drag.start[1], drag.end[1]),
        ];
        const hits = state.doc.elements
          .filter(el => el.type !== 'arrow' && rectsIntersect(elementBBox(el), box))
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
    hint: 'Click and drag along the grid — turns commit corners automatically · release to finish',
    down(e, wp) {
      const a = snapPt(wp);
      drag = { pts: [a, [a[0], a[1]]] };
    },
    move(e, wp) {
      if (!drag) return;
      const pts = drag.pts;
      const a = pts[pts.length - 2], prov = pts[pts.length - 1];
      const p = snap8(a, wp);
      const dNew = dirOf(a, p), dProv = dirOf(a, prov);
      if (eq(prov, a) || eq(p, a) || (dNew[0] === dProv[0] && dNew[1] === dProv[1])) {
        pts[pts.length - 1] = p;
      } else {
        // direction changed: the provisional point becomes a committed corner
        const q = snap8(prov, wp);
        if (!eq(q, prov)) pts.push(q);
      }
      clearPreview();
      svgEl('polyline', {
        points: ptsAttr(pts), fill: 'none', stroke: state.color,
        'stroke-width': state.width, 'stroke-linejoin': 'round', 'stroke-linecap': 'round',
      }, preview());
      svgEl('circle', {
        cx: pts[0][0], cy: pts[0][1], r: 3 / state.view.s, fill: state.color,
      }, preview());
    },
    up() {
      if (!drag) return;
      const pts = simplify(drag.pts);
      drag = null;
      clearPreview();
      if (pts.length < 2 || polylineLength(pts) === 0) { changed(); return; }
      beginChange();
      const el = addElement({
        type: 'path', pts, color: state.color, width: state.width, label: '', segments: [],
      });
      state.selection = [{ id: el.id }];
      changed();
    },
  },

  segment: {
    hint: 'Press on a line and drag along it to define a colored segment · release to apply',
    down(e, wp) {
      const hit = nearestPath(wp);
      if (!hit) return;
      drag = { el: hit.el, t0: hit.t, t1: hit.t };
    },
    move(e, wp) {
      if (!drag) return;
      drag.t1 = nearestOnPath(drag.el.pts, wp).t;
      clearPreview();
      const sp = subPath(drag.el.pts, Math.min(drag.t0, drag.t1), Math.max(drag.t0, drag.t1));
      svgEl('polyline', {
        points: ptsAttr(sp), fill: 'none', stroke: state.color,
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
        d: inkD(drag.pts), fill: 'none', stroke: state.color,
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

  text: {
    hint: 'Click to place a note · Ctrl+Enter or click away to finish',
    // editor opens on pointerup: opening on pointerdown gets blurred by the
    // browser's default mousedown focus handling before typing can start
    down() {},
    move() {},
    up(e, wp) {
      createTextAt(snapPt(wp));
    },
  },
};
