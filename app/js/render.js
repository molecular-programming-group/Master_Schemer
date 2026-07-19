// SVG rendering: full redraw of the document + selection overlay.
import { state, byId } from './model.js';
import { GRID, bboxOfPts, subPath, pointAt, polylineLength, rectEdgePoint } from './geom.js';

const NS = 'http://www.w3.org/2000/svg';
export const SEL = '#b57f1d'; // honey selection accent (matches --primary)
const CARD_STROKE = '#ded7ca';
const FONT = 'ui-sans-serif, system-ui, sans-serif';

export function svgEl(tag, attrs = {}, parent = null) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (parent) parent.appendChild(el);
  return el;
}

const $ = id => document.getElementById(id);

export const screenToWorld = p => [
  (p[0] - state.view.tx) / state.view.s,
  (p[1] - state.view.ty) / state.view.s,
];
export const worldToScreen = p => [
  p[0] * state.view.s + state.view.tx,
  p[1] * state.view.s + state.view.ty,
];

// ---- element bounding boxes (world units) ----

export function elementBBox(el) {
  switch (el.type) {
    case 'card': return [el.x, el.y, el.x + el.w, el.y + el.h];
    case 'path': case 'ink': {
      const b = bboxOfPts(el.pts), m = (el.width || 2) + 4;
      return [b[0] - m, b[1] - m, b[2] + m, b[3] + m];
    }
    case 'text': {
      const lines = el.text.split('\n');
      const w = Math.max(...lines.map(l => l.length)) * el.size * 0.6;
      return [el.x, el.y - el.size, el.x + w, el.y - el.size + lines.length * el.size * 1.3];
    }
    case 'arrow': {
      const a = byId(el.from), b = byId(el.to);
      if (!a || !b) return [0, 0, 0, 0];
      const [x0, y0] = [a.x + a.w / 2, a.y + a.h / 2];
      const [x1, y1] = [b.x + b.w / 2, b.y + b.h / 2];
      return [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];
    }
  }
  return [0, 0, 0, 0];
}

export function contentBBox() {
  const els = state.doc.elements;
  if (!els.length) return null;
  let box = null;
  for (const el of els) {
    const b = elementBBox(el);
    box = box ? [Math.min(box[0], b[0]), Math.min(box[1], b[1]),
                 Math.max(box[2], b[2]), Math.max(box[3], b[3])] : b;
  }
  return box;
}

// ---- element renderers ----

function haloText(parent, x, y, text, size, color, weight = 500, extra = {}) {
  const t = svgEl('text', {
    x, y, 'font-size': size, 'font-family': FONT, 'font-weight': weight,
    fill: color, stroke: '#ffffff', 'stroke-width': size * 0.28,
    'paint-order': 'stroke', 'stroke-linejoin': 'round', ...extra,
  }, parent);
  t.textContent = text;
  return t;
}

const ptsAttr = pts => pts.map(p => `${p[0]},${p[1]}`).join(' ');

// Label anchor beside the path at arc length t: offset along the local normal
// so labels never sit on top of vertical or diagonal strokes. side: -1 = the
// upward-ish side, 1 = the opposite side.
function labelPos(pts, t, off, side) {
  const a = pointAt(pts, Math.max(0, t - 4)), b = pointAt(pts, t + 4);
  let nx = b[1] - a[1], ny = -(b[0] - a[0]);
  const n = Math.hypot(nx, ny);
  if (n === 0) { nx = 0; ny = -1; } else { nx /= n; ny /= n; }
  if (ny > 0) { nx = -nx; ny = -ny; } // normalize to the upward-ish side
  const m = pointAt(pts, t);
  return [m[0] + nx * off * -side, m[1] + ny * off * -side];
}

function renderCard(el, parent) {
  const g = svgEl('g', { 'data-id': el.id }, parent);
  svgEl('rect', {
    x: el.x, y: el.y, width: el.w, height: el.h, rx: 10,
    fill: '#ffffff', stroke: CARD_STROKE, 'stroke-width': 1.25,
    filter: 'url(#cardShadow)',
  }, g);
  const title = el.title || 'Untitled';
  const t = svgEl('text', {
    x: el.x + 14, y: el.y + 25, 'font-size': 13.5, 'font-family': FONT,
    'font-weight': 600, fill: el.title ? '#2b2622' : '#a49d91',
    'data-role': 'card-title',
  }, g);
  if (!el.title) t.setAttribute('data-ph', '1');
  t.textContent = title;
  return g;
}

function renderArrow(el, parent) {
  const a = byId(el.from), b = byId(el.to);
  if (!a || !b) return;
  const c1 = [a.x + a.w / 2, a.y + a.h / 2], c2 = [b.x + b.w / 2, b.y + b.h / 2];
  const p1 = rectEdgePoint(c1[0], c1[1], a.w, a.h, c2[0], c2[1]);
  let p2 = rectEdgePoint(c2[0], c2[1], b.w, b.h, c1[0], c1[1]);
  const d = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
  if (d > 8) { // back off so the arrowhead tip meets the card edge
    p2 = [p2[0] - (p2[0] - p1[0]) / d * 3, p2[1] - (p2[1] - p1[1]) / d * 3];
  }
  const g = svgEl('g', { 'data-id': el.id }, parent);
  svgEl('line', {
    x1: p1[0], y1: p1[1], x2: p2[0], y2: p2[1],
    stroke: 'transparent', 'stroke-width': 14, 'data-hit': '1',
  }, g);
  svgEl('line', {
    x1: p1[0], y1: p1[1], x2: p2[0], y2: p2[1],
    stroke: '#55504a', 'stroke-width': 1.75, 'marker-end': 'url(#arrowHead)',
  }, g);
  if (el.label) {
    haloText(g, (p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2 - 8, el.label, 12.5, '#55504a',
      500, { 'text-anchor': 'middle' });
  }
}

function renderPath(el, parent) {
  const g = svgEl('g', { 'data-id': el.id }, parent);
  const pts = ptsAttr(el.pts);
  const w = el.width || 2;
  svgEl('polyline', {
    points: pts, fill: 'none', stroke: 'transparent',
    'stroke-width': Math.max(12, w + 8), 'data-hit': '1',
  }, g);
  svgEl('polyline', {
    points: pts, fill: 'none', stroke: el.color, 'stroke-width': w,
    'stroke-linejoin': 'round', 'stroke-linecap': 'round',
  }, g);
  const len = polylineLength(el.pts);
  (el.segments || []).forEach((seg, i) => {
    const sp = subPath(el.pts, seg.t0, seg.t1);
    const sa = ptsAttr(sp);
    svgEl('polyline', {
      points: sa, fill: 'none', stroke: 'transparent',
      'stroke-width': Math.max(12, w + 8), 'data-hit': '1', 'data-seg': i,
    }, g);
    svgEl('polyline', {
      points: sa, fill: 'none', stroke: seg.color, 'stroke-width': w + 2.5,
      'stroke-linejoin': 'round', 'stroke-linecap': 'round', 'data-seg': i,
    }, g);
    if (seg.label) {
      const m = labelPos(el.pts, (seg.t0 + seg.t1) / 2, 16, 1);
      haloText(g, m[0], m[1], seg.label, 12, seg.color, 600,
        { 'text-anchor': 'middle', 'dominant-baseline': 'middle' });
    }
  });
  if (el.label) {
    const m = labelPos(el.pts, len / 2, 14, -1);
    haloText(g, m[0], m[1], el.label, 12.5, el.color, 600,
      { 'text-anchor': 'middle', 'dominant-baseline': 'middle' });
  }
}

// Freehand ink: quadratic smoothing through midpoints.
export function inkD(pts) {
  if (pts.length < 3) return `M${pts.map(p => p.join(' ')).join(' L')}`;
  let d = `M${pts[0][0]} ${pts[0][1]}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i][0] + pts[i + 1][0]) / 2, my = (pts[i][1] + pts[i + 1][1]) / 2;
    d += ` Q${pts[i][0]} ${pts[i][1]} ${mx} ${my}`;
  }
  const last = pts[pts.length - 1];
  d += ` L${last[0]} ${last[1]}`;
  return d;
}

function renderInk(el, parent) {
  const g = svgEl('g', { 'data-id': el.id }, parent);
  const d = inkD(el.pts);
  svgEl('path', {
    d, fill: 'none', stroke: 'transparent',
    'stroke-width': Math.max(12, (el.width || 2) + 8), 'data-hit': '1',
  }, g);
  svgEl('path', {
    d, fill: 'none', stroke: el.color, 'stroke-width': el.width || 2,
    'stroke-linejoin': 'round', 'stroke-linecap': 'round',
  }, g);
}

function renderText(el, parent) {
  const g = svgEl('g', { 'data-id': el.id }, parent);
  const t = svgEl('text', {
    x: el.x, y: el.y, 'font-size': el.size, 'font-family': FONT,
    fill: el.color, 'data-role': 'text-body',
  }, g);
  el.text.split('\n').forEach((line, i) => {
    const span = svgEl('tspan', { x: el.x, dy: i === 0 ? 0 : el.size * 1.3 }, t);
    span.textContent = line || ' ';
  });
}

// ---- selection overlay ----

function renderSelection(overlay) {
  const s = state.view.s;
  for (const sel of state.selection) {
    const el = byId(sel.id);
    if (!el) continue;
    if (sel.seg !== undefined) {
      const seg = el.segments?.[sel.seg];
      if (!seg) continue;
      svgEl('polyline', {
        points: ptsAttr(subPath(el.pts, seg.t0, seg.t1)), fill: 'none',
        stroke: SEL, 'stroke-width': (el.width || 2) + 12 / s, opacity: 0.35,
        'stroke-linecap': 'round', 'stroke-linejoin': 'round',
      }, overlay);
      continue;
    }
    if (el.type === 'path' || el.type === 'ink') {
      const attrs = {
        fill: 'none', stroke: SEL, 'stroke-width': (el.width || 2) + 10 / s,
        opacity: 0.3, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
      };
      if (el.type === 'ink') svgEl('path', { d: inkD(el.pts), ...attrs }, overlay);
      else svgEl('polyline', { points: ptsAttr(el.pts), ...attrs }, overlay);
    }
    const b = elementBBox(el);
    svgEl('rect', {
      x: b[0], y: b[1], width: b[2] - b[0], height: b[3] - b[1],
      fill: 'none', stroke: SEL, 'stroke-width': 1.5 / s,
      'stroke-dasharray': `${5 / s} ${4 / s}`, rx: 3 / s,
    }, overlay);
    // corner handles for a single selected card
    if (el.type === 'card' && state.selection.length === 1) {
      const hs = 9 / s;
      for (const [hx, hy, name] of [
        [el.x, el.y, 'nw'], [el.x + el.w, el.y, 'ne'],
        [el.x, el.y + el.h, 'sw'], [el.x + el.w, el.y + el.h, 'se'],
      ]) {
        svgEl('rect', {
          x: hx - hs / 2, y: hy - hs / 2, width: hs, height: hs,
          fill: '#ffffff', stroke: SEL, 'stroke-width': 1.5 / s,
          'data-handle': name, 'data-id': el.id,
          style: `cursor:${name === 'nw' || name === 'se' ? 'nwse' : 'nesw'}-resize`,
        }, overlay);
      }
    }
  }
}

// ---- main render ----

export function render() {
  const { tx, ty, s } = state.view;
  $('world').setAttribute('transform', `translate(${tx} ${ty}) scale(${s})`);

  // grid: cover the visible world rect, fade out when zoomed far away
  const svg = $('canvas');
  const vw = svg.clientWidth, vh = svg.clientHeight;
  const grid = $('gridRect');
  const gx = Math.floor(-tx / s / GRID) * GRID - GRID;
  const gy = Math.floor(-ty / s / GRID) * GRID - GRID;
  grid.setAttribute('x', gx);
  grid.setAttribute('y', gy);
  grid.setAttribute('width', vw / s + 3 * GRID);
  grid.setAttribute('height', vh / s + 3 * GRID);
  grid.setAttribute('opacity', s < 0.4 ? 0 : Math.min(1, (s - 0.4) / 0.2 + 0.35));

  const layers = { cards: $('layer-cards'), arrows: $('layer-arrows'), draw: $('layer-draw') };
  for (const l of Object.values(layers)) l.replaceChildren();
  for (const el of state.doc.elements) {
    if (el.type === 'card') renderCard(el, layers.cards);
    else if (el.type === 'arrow') renderArrow(el, layers.arrows);
    else if (el.type === 'path') renderPath(el, layers.draw);
    else if (el.type === 'ink') renderInk(el, layers.draw);
    else if (el.type === 'text') renderText(el, layers.draw);
  }
  const overlay = $('layer-overlay');
  overlay.replaceChildren();
  renderSelection(overlay);
}

// ---- SVG export ----

export function exportSVGString() {
  const box = contentBBox();
  if (!box) return null;
  const m = 40;
  const [x0, y0, x1, y1] = [box[0] - m, box[1] - m, box[2] + m, box[3] + m];
  const out = document.createElementNS(NS, 'svg');
  out.setAttribute('xmlns', NS);
  out.setAttribute('viewBox', `${x0} ${y0} ${x1 - x0} ${y1 - y0}`);
  out.setAttribute('width', x1 - x0);
  out.setAttribute('height', y1 - y0);
  svgEl('rect', { x: x0, y: y0, width: x1 - x0, height: y1 - y0, fill: '#ffffff' }, out);
  out.appendChild(document.querySelector('#canvas defs').cloneNode(true));
  for (const id of ['layer-cards', 'layer-arrows', 'layer-draw']) {
    out.appendChild($(id).cloneNode(true));
  }
  out.querySelectorAll('[data-hit], [data-ph]').forEach(n => n.remove());
  return new XMLSerializer().serializeToString(out);
}
