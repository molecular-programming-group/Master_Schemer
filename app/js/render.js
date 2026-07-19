// SVG rendering: full redraw of the document + selection overlay.
import { state, byId, resolveColor } from './model.js';
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
    case 'path': case 'ink': case 'aline': {
      const b = bboxOfPts(el.pts), m = (el.width || 2) + 4;
      return [b[0] - m, b[1] - m, b[2] + m, b[3] + m];
    }
    case 'ellipse': {
      const m = (el.width || 2) + 2;
      return [el.cx - el.rx - m, el.cy - el.ry - m, el.cx + el.rx + m, el.cy + el.ry + m];
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

// ---- shared stroke styling ----

export function dashArray(dash, w) {
  if (dash === 'dashed') return `${w * 2.6} ${w * 1.9}`;
  if (dash === 'dotted') return `0.1 ${w * 2.2}`; // round linecap turns these into dots
  return null;
}

function strokeAttrs(el) {
  const attrs = {
    fill: 'none', stroke: resolveColor(el.color), 'stroke-width': el.width || 2,
    'stroke-linejoin': 'round', 'stroke-linecap': 'round',
  };
  const da = dashArray(el.dash, el.width || 2);
  if (da) attrs['stroke-dasharray'] = da;
  return attrs;
}

// Outward unit direction at a polyline end (end: 0 = first point, 1 = last).
function endDir(pts, end) {
  const i = end ? pts.length - 1 : 0, step = end ? -1 : 1;
  let j = i + step;
  while (j >= 0 && j < pts.length && pts[j][0] === pts[i][0] && pts[j][1] === pts[i][1]) j += step;
  if (j < 0 || j >= pts.length) return [1, 0];
  const dx = pts[i][0] - pts[j][0], dy = pts[i][1] - pts[j][1];
  const n = Math.hypot(dx, dy) || 1;
  return [dx / n, dy / n];
}

export const CAPS = ['none', 'arrow', 'barb', 'square', 'circle'];

// End-cap glyph at p pointing along outward unit dir d.
function capGlyph(parent, p, d, cap, color, w) {
  if (!cap || cap === 'none') return;
  const s = Math.max(7, w * 2.1);
  const n = [-d[1], d[0]];
  const P = (a, b) => [p[0] + d[0] * a + n[0] * b, p[1] + d[1] * a + n[1] * b];
  const poly = pts => svgEl('polygon', {
    points: pts.map(q => `${q[0]},${q[1]}`).join(' '), fill: color, stroke: 'none',
  }, parent);
  if (cap === 'arrow') poly([P(s * 0.75, 0), P(-s * 0.55, s * 0.55), P(-s * 0.55, -s * 0.55)]);
  else if (cap === 'barb') { // swept-back barbed head
    const path = [P(s * 0.8, 0), P(-s * 0.75, s * 0.7), P(-s * 0.3, 0), P(-s * 0.75, -s * 0.7)];
    poly(path);
  } else if (cap === 'square') {
    const h = s * 0.42;
    poly([P(h, h), P(h, -h), P(-h, -h), P(-h, h)]);
  } else if (cap === 'circle') {
    svgEl('circle', { cx: p[0], cy: p[1], r: s * 0.42, fill: color, stroke: 'none' }, parent);
  }
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
  const color = resolveColor(el.color);
  svgEl('polyline', {
    points: pts, fill: 'none', stroke: 'transparent',
    'stroke-width': Math.max(12, w + 8), 'data-hit': '1',
  }, g);
  svgEl('polyline', { points: pts, ...strokeAttrs(el) }, g);
  const len = polylineLength(el.pts);
  (el.segments || []).forEach((seg, i) => {
    const sp = subPath(el.pts, seg.t0, seg.t1);
    const sa = ptsAttr(sp);
    const segColor = resolveColor(seg.color);
    svgEl('polyline', {
      points: sa, fill: 'none', stroke: 'transparent',
      'stroke-width': Math.max(12, w + 8), 'data-hit': '1', 'data-seg': i,
    }, g);
    svgEl('polyline', {
      points: sa, fill: 'none', stroke: segColor, 'stroke-width': w + 2.5,
      'stroke-linejoin': 'round', 'stroke-linecap': 'round', 'data-seg': i,
    }, g);
    if (seg.label) {
      const m = labelPos(el.pts, (seg.t0 + seg.t1) / 2, 16, 1);
      haloText(g, m[0], m[1], seg.label, 12, segColor, 600,
        { 'text-anchor': 'middle', 'dominant-baseline': 'middle' });
    }
  });
  capGlyph(g, el.pts[0], endDir(el.pts, 0), el.cap0, color, w);
  capGlyph(g, el.pts[el.pts.length - 1], endDir(el.pts, 1), el.cap1, color, w);
  if (el.label) {
    const m = labelPos(el.pts, len / 2, 14, -1);
    haloText(g, m[0], m[1], el.label, 12.5, color, 600,
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
  svgEl('path', { d, ...strokeAttrs(el) }, g);
}

function renderEllipse(el, parent) {
  const g = svgEl('g', { 'data-id': el.id }, parent);
  const base = { cx: el.cx, cy: el.cy, rx: el.rx, ry: el.ry };
  svgEl('ellipse', {
    ...base, fill: 'none', stroke: 'transparent',
    'stroke-width': Math.max(12, (el.width || 2) + 8), 'data-hit': '1',
  }, g);
  const attrs = strokeAttrs(el);
  svgEl('ellipse', { ...base, ...attrs }, g);
}

function renderALine(el, parent) {
  const g = svgEl('g', { 'data-id': el.id }, parent);
  const [a, b] = el.pts;
  const color = resolveColor(el.color);
  svgEl('line', {
    x1: a[0], y1: a[1], x2: b[0], y2: b[1],
    stroke: 'transparent', 'stroke-width': Math.max(12, (el.width || 2) + 8), 'data-hit': '1',
  }, g);
  const attrs = strokeAttrs(el);
  svgEl('line', { x1: a[0], y1: a[1], x2: b[0], y2: b[1], ...attrs }, g);
  capGlyph(g, a, endDir(el.pts, 0), el.cap0, color, el.width || 2);
  capGlyph(g, b, endDir(el.pts, 1), el.cap1, color, el.width || 2);
}

// Math notes: lines containing $…$ render through KaTeX in a foreignObject.
// ponytail: exported SVGs show math correctly in browsers only if KaTeX CSS is
// available; plain-text notes stay portable SVG <text>.
function renderText(el, parent) {
  const g = svgEl('g', { 'data-id': el.id }, parent);
  const color = resolveColor(el.color);
  if (el.text.includes('$') && window.katex) {
    const fo = svgEl('foreignObject', {
      x: el.x, y: el.y - el.size * 1.1, width: 2000, height: 1000,
      style: 'overflow:visible', 'pointer-events': 'none',
    }, g);
    const div = document.createElement('div');
    div.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
    div.style.cssText = `font:${el.size}px ${FONT};color:${color};line-height:1.3;` +
      'white-space:pre-wrap;width:max-content;max-width:1000px;pointer-events:auto';
    div.innerHTML = el.text.split('\n').map(line =>
      line.replace(/\$([^$]+)\$/g, (_, tex) => {
        try { return window.katex.renderToString(tex, { throwOnError: false }); }
        catch { return tex; }
      }) || '&nbsp;'
    ).map(html => `<div>${html}</div>`).join('');
    fo.appendChild(div);
    return;
  }
  const t = svgEl('text', {
    x: el.x, y: el.y, 'font-size': el.size, 'font-family': FONT,
    fill: color, 'data-role': 'text-body',
  }, g);
  el.text.split('\n').forEach((line, i) => {
    const span = svgEl('tspan', { x: el.x, dy: i === 0 ? 0 : el.size * 1.3 }, t);
    span.textContent = line || ' ';
  });
}

// ---- selection overlay ----

function handleDot(overlay, x, y, s, extra = {}) {
  return svgEl('circle', {
    cx: x, cy: y, r: 5.5 / s, fill: '#ffffff', stroke: SEL, 'stroke-width': 2 / s,
    style: 'cursor:crosshair', ...extra,
  }, overlay);
}

function renderSelection(overlay) {
  const s = state.view.s;
  const single = state.selection.length === 1;
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
      // draggable segment boundaries
      if (single) {
        const p0 = pointAt(el.pts, seg.t0), p1 = pointAt(el.pts, seg.t1);
        handleDot(overlay, p0[0], p0[1], s, { 'data-seghandle': '0', 'data-id': el.id, 'data-segi': sel.seg });
        handleDot(overlay, p1[0], p1[1], s, { 'data-seghandle': '1', 'data-id': el.id, 'data-segi': sel.seg });
      }
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
    // corner handles for a single selected card: squares resize, dragging the
    // card border moves it (its contents ride along)
    if (el.type === 'card' && single) {
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
    // path endpoints: drag to keep laying down line (select tool)
    if (el.type === 'path' && single && state.tool === 'select') {
      const a = el.pts[0], z = el.pts[el.pts.length - 1];
      handleDot(overlay, a[0], a[1], s, { 'data-pend': '0', 'data-id': el.id });
      handleDot(overlay, z[0], z[1], s, { 'data-pend': '1', 'data-id': el.id });
    }
    // vertex handles for the line-edit tool
    if (el.type === 'path' && single && state.tool === 'edit') {
      const hs = 8 / s;
      el.pts.forEach((p, i) => {
        svgEl('rect', {
          x: p[0] - hs / 2, y: p[1] - hs / 2, width: hs, height: hs,
          fill: '#ffffff', stroke: SEL, 'stroke-width': 1.75 / s,
          'data-vertex': i, 'data-id': el.id, style: 'cursor:move',
        }, overlay);
      });
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

  // cards sit below everything; all other elements paint in doc order (z-order)
  const cards = $('layer-cards'), draw = $('layer-draw');
  cards.replaceChildren();
  draw.replaceChildren();
  for (const el of state.doc.elements) {
    if (el.type === 'card') renderCard(el, cards);
    else if (el.type === 'arrow') renderArrow(el, draw);
    else if (el.type === 'path') renderPath(el, draw);
    else if (el.type === 'ink') renderInk(el, draw);
    else if (el.type === 'ellipse') renderEllipse(el, draw);
    else if (el.type === 'aline') renderALine(el, draw);
    else if (el.type === 'text') renderText(el, draw);
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
  for (const id of ['layer-cards', 'layer-draw']) {
    out.appendChild($(id).cloneNode(true));
  }
  out.querySelectorAll('[data-hit], [data-ph]').forEach(n => n.remove());
  return new XMLSerializer().serializeToString(out);
}
