// SVG rendering with a per-element node cache: only elements whose data
// changed since the last frame rebuild their DOM, everything else is re-slotted
// in document order (which is what gives us z-order for free).
import { state, byId, resolveColor, resolveLabel, groupElementMembers } from './model.js';
import {
  GRID, bboxOfPts, subPath, pointAt, polylineLength, rectEdgePoint,
  convexHull, ellipsePoints,
} from './geom.js';

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

// ---- KaTeX / rich text ----
// Math and wrapped text render as HTML divs in #mathLayer, a plain HTML layer
// that pans/zooms via one CSS transform. SVG foreignObject would be simpler,
// but WebKitGTK (the Tauri webview on Linux) ignores ancestor SVG transforms
// on foreignObject content — notes drifted and refused to zoom.

const texCache = new Map();
function katexHTML(tex) {
  if (!texCache.has(tex)) {
    let html = tex;
    try { html = window.katex.renderToString(tex, { throwOnError: false }); } catch { /* raw */ }
    texCache.set(tex, html);
  }
  return texCache.get(tex);
}

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const hasMath = text => text.includes('$') && !!window.katex;

// A text element is "rich" (HTML-rendered) when it has math or a wrap box.
export const isRichText = el => hasMath(el.text) || !!el.w;

export function richHTML(text) {
  return text.split('\n').map(line =>
    line.split(/\$([^$]+)\$/)
      .map((part, i) => i % 2 ? katexHTML(part) : esc(part))
      .join('') || '&nbsp;'
  ).map(h => `<div>${h}</div>`).join('');
}

// Measured world-unit sizes of rich text elements, filled after first paint.
const richBoxes = new Map();

// ---- element bounding boxes (world units) ----

export function elementBBox(el) {
  switch (el.type) {
    case 'card': return [el.x, el.y, el.x + el.w, el.y + el.h];
    case 'rect': {
      const m = (el.width || 2) + 2;
      return [el.x - m, el.y - m, el.x + el.w + m, el.y + el.h + m];
    }
    case 'path': case 'ink': case 'aline': {
      const b = bboxOfPts(el.pts), m = (el.width || 2) + 4;
      return [b[0] - m, b[1] - m, b[2] + m, b[3] + m];
    }
    case 'ellipse': {
      const m = (el.width || 2) + 2;
      return [el.cx - el.rx - m, el.cy - el.ry - m, el.cx + el.rx + m, el.cy + el.ry + m];
    }
    case 'text': {
      const top = el.y - el.size * 1.15;
      const box = richBoxes.get(el.id);
      if (box) return [el.x, top, el.x + box[0], top + box[1]];
      const lines = el.text.split('\n');
      const w = el.w || Math.max(...lines.map(l => l.length)) * el.size * 0.6;
      return [el.x, el.y - el.size, el.x + w, el.y - el.size + lines.length * el.size * 1.3];
    }
    case 'arrow': {
      const a = byId(el.from), b = byId(el.to);
      if (!a || !b) return [0, 0, 0, 0];
      const [x0, y0] = [a.x + a.w / 2, a.y + a.h / 2];
      const [x1, y1] = [b.x + b.w / 2, b.y + b.h / 2];
      return [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];
    }
    case 'link': {
      const pts = [...linkTargetPoints(el.a), ...linkTargetPoints(el.b)];
      return pts.length ? bboxOfPts(pts) : [0, 0, 0, 0];
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

export const LINECAPS = ['round', 'butt', 'square'];

// Fill for closed shapes (rect/ellipse): a color ref or 'none'.
const fillOf = el => (el.fill ? resolveColor(el.fill) : 'none');

function strokeAttrs(el) {
  // dotted strokes need round caps or the dots vanish
  const cap = el.dash === 'dotted' ? 'round' : (el.linecap || 'round');
  const attrs = {
    fill: 'none', stroke: resolveColor(el.color), 'stroke-width': el.width || 2,
    'stroke-linejoin': cap === 'round' ? 'round' : 'miter', 'stroke-linecap': cap,
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

export const CAPS = ['none', 'arrow', 'harpoon', 'barb', 'square', 'circle'];

// End-cap glyph at p pointing along outward unit dir d. `flip` mirrors the
// (one-sided) harpoon barb to the other side of the line.
function capGlyph(parent, p, d, cap, color, w, flip) {
  if (!cap || cap === 'none') return;
  const s = Math.max(7, w * 2.1);
  const n = [-d[1], d[0]];
  const P = (a, b) => [p[0] + d[0] * a + n[0] * b, p[1] + d[1] * a + n[1] * b];
  const poly = pts => svgEl('polygon', {
    points: pts.map(q => `${q[0]},${q[1]}`).join(' '), fill: color, stroke: 'none',
  }, parent);
  if (cap === 'arrow') poly([P(s * 0.75, 0), P(-s * 0.55, s * 0.55), P(-s * 0.55, -s * 0.55)]);
  else if (cap === 'barb') { // swept-back barbed head
    poly([P(s * 0.8, 0), P(-s * 0.75, s * 0.7), P(-s * 0.3, 0), P(-s * 0.75, -s * 0.7)]);
  } else if (cap === 'harpoon') {
    // one-sided barb whose flat edge lies on the line axis (tip → base runs
    // straight down the centerline) so it reads as a seamless continuation of
    // the stroke rather than a glued-on triangle.
    const side = flip ? -1 : 1;
    poly([P(s * 0.9, 0), P(-s * 0.5, s * 0.92 * side), P(-s * 0.12, 0)]);
  } else if (cap === 'square') {
    const h = s * 0.42;
    poly([P(h, h), P(h, -h), P(-h, -h), P(-h, h)]);
  } else if (cap === 'circle') {
    svgEl('circle', { cx: p[0], cy: p[1], r: s * 0.42, fill: color, stroke: 'none' }, parent);
  }
}

// ---- element renderers ----
// Each returns { node, divs?, measure? }. divs go in #mathLayer; measure runs
// once after the fresh nodes are attached (rich text needs layout to size its
// hit target).

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

// Object/segment label at anchor + user offset. Draggable via data-labelfor;
// math labels render as overlay divs instead (ponytail: those aren't
// draggable on canvas — move them from the panel offset if needed).
function drawLabel(g, divs, owner, anchor, opts) {
  if (owner.labelHide) return;
  const text = resolveLabel(owner.label);
  if (!text) return;
  const off = owner.labelOff || [0, 0];
  const p = [anchor[0] + off[0], anchor[1] + off[1]];
  if (hasMath(text)) {
    const div = document.createElement('div');
    div.className = 'math-label';
    div.style.left = `${p[0]}px`;
    div.style.top = `${p[1]}px`;
    div.style.font = `600 ${opts.size}px ${FONT}`;
    div.style.color = opts.color;
    div.innerHTML = richHTML(text);
    divs.push(div);
    return;
  }
  haloText(g, p[0], p[1], text, opts.size, opts.color, 600, {
    'text-anchor': 'middle', 'dominant-baseline': 'middle',
    'data-labelfor': opts.id, ...(opts.segi !== undefined ? { 'data-segi': opts.segi } : {}),
    style: 'cursor:move',
  });
}

function renderCard(el) {
  const g = svgEl('g', { 'data-id': el.id });
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
  return { node: g };
}

function renderArrow(el) {
  const g = svgEl('g', { 'data-id': el.id });
  const a = byId(el.from), b = byId(el.to);
  if (!a || !b) return { node: g };
  const c1 = [a.x + a.w / 2, a.y + a.h / 2], c2 = [b.x + b.w / 2, b.y + b.h / 2];
  const p1 = rectEdgePoint(c1[0], c1[1], a.w, a.h, c2[0], c2[1]);
  let p2 = rectEdgePoint(c2[0], c2[1], b.w, b.h, c1[0], c1[1]);
  const d = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
  if (d > 8) { // back off so the arrowhead tip meets the card edge
    p2 = [p2[0] - (p2[0] - p1[0]) / d * 3, p2[1] - (p2[1] - p1[1]) / d * 3];
  }
  svgEl('line', {
    x1: p1[0], y1: p1[1], x2: p2[0], y2: p2[1],
    stroke: 'transparent', 'stroke-width': 14, 'data-hit': '1',
  }, g);
  svgEl('line', {
    x1: p1[0], y1: p1[1], x2: p2[0], y2: p2[1],
    stroke: '#55504a', 'stroke-width': 1.75, 'marker-end': 'url(#arrowHead)',
  }, g);
  if (el.label && !el.labelHide) {
    const off = el.labelOff || [0, 0];
    haloText(g, (p1[0] + p2[0]) / 2 + off[0], (p1[1] + p2[1]) / 2 - 8 + off[1],
      resolveLabel(el.label), 12.5, '#55504a', 500,
      { 'text-anchor': 'middle', 'data-labelfor': el.id, style: 'cursor:move' });
  }
  return { node: g };
}

function renderPath(el) {
  const g = svgEl('g', { 'data-id': el.id });
  const divs = [];
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
    drawLabel(g, divs, seg, labelPos(el.pts, (seg.t0 + seg.t1) / 2, 16, 1),
      { size: 12, color: segColor, id: el.id, segi: i });
  });
  capGlyph(g, el.pts[0], endDir(el.pts, 0), el.cap0, color, w, el.cap0flip);
  capGlyph(g, el.pts[el.pts.length - 1], endDir(el.pts, 1), el.cap1, color, w, el.cap1flip);
  drawLabel(g, divs, el, labelPos(el.pts, len / 2, 14, -1),
    { size: 12.5, color, id: el.id });
  return { node: g, divs };
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

// Anchor for the label of a bbox-shaped element: top-center, just above.
const bboxLabelAnchor = el => {
  const b = elementBBox(el);
  return [(b[0] + b[2]) / 2, b[1] - 9];
};

function renderInk(el) {
  const g = svgEl('g', { 'data-id': el.id });
  const divs = [];
  const d = inkD(el.pts);
  svgEl('path', {
    d, fill: 'none', stroke: 'transparent',
    'stroke-width': Math.max(12, (el.width || 2) + 8), 'data-hit': '1',
  }, g);
  svgEl('path', { d, ...strokeAttrs(el) }, g);
  drawLabel(g, divs, el, bboxLabelAnchor(el), { size: 12.5, color: resolveColor(el.color), id: el.id });
  return { node: g, divs };
}

function renderEllipse(el) {
  const g = svgEl('g', { 'data-id': el.id });
  const divs = [];
  const base = { cx: el.cx, cy: el.cy, rx: el.rx, ry: el.ry };
  svgEl('ellipse', {
    ...base, fill: 'none', stroke: 'transparent',
    'stroke-width': Math.max(12, (el.width || 2) + 8), 'data-hit': '1',
  }, g);
  svgEl('ellipse', { ...base, ...strokeAttrs(el), fill: fillOf(el) }, g);
  drawLabel(g, divs, el, bboxLabelAnchor(el), { size: 12.5, color: resolveColor(el.color), id: el.id });
  return { node: g, divs };
}

function renderRect(el) {
  const g = svgEl('g', { 'data-id': el.id });
  const divs = [];
  const base = { x: el.x, y: el.y, width: el.w, height: el.h, rx: el.r || 0 };
  svgEl('rect', {
    ...base, fill: 'none', stroke: 'transparent',
    'stroke-width': Math.max(12, (el.width || 2) + 8), 'data-hit': '1',
  }, g);
  svgEl('rect', { ...base, ...strokeAttrs(el), fill: fillOf(el) }, g);
  drawLabel(g, divs, el, bboxLabelAnchor(el), { size: 12.5, color: resolveColor(el.color), id: el.id });
  return { node: g, divs };
}

function renderALine(el) {
  const g = svgEl('g', { 'data-id': el.id });
  const divs = [];
  const [a, b] = el.pts;
  const color = resolveColor(el.color);
  svgEl('line', {
    x1: a[0], y1: a[1], x2: b[0], y2: b[1],
    stroke: 'transparent', 'stroke-width': Math.max(12, (el.width || 2) + 8), 'data-hit': '1',
  }, g);
  svgEl('line', { x1: a[0], y1: a[1], x2: b[0], y2: b[1], ...strokeAttrs(el) }, g);
  capGlyph(g, a, endDir(el.pts, 0), el.cap0, color, el.width || 2, el.cap0flip);
  capGlyph(g, b, endDir(el.pts, 1), el.cap1, color, el.width || 2, el.cap1flip);
  drawLabel(g, divs, el, bboxLabelAnchor(el), { size: 12.5, color, id: el.id });
  return { node: g, divs };
}

function renderText(el) {
  const g = svgEl('g', { 'data-id': el.id });
  const color = resolveColor(el.color);
  if (isRichText(el)) {
    const top = el.y - el.size * 1.15;
    const div = document.createElement('div');
    div.className = 'math-note';
    div.style.left = `${el.x}px`;
    div.style.top = `${top}px`;
    div.style.font = `${el.size}px ${FONT}`;
    div.style.color = color;
    div.style.width = el.w ? `${el.w}px` : 'max-content';
    div.innerHTML = richHTML(el.text);
    // invisible SVG twin so clicks and marquees still find the note
    const hit = svgEl('rect', {
      x: el.x, y: top, width: el.w || el.size, height: el.size * 1.3,
      fill: 'transparent', 'data-hit': '1',
    }, g);
    const measure = () => {
      const w = el.w || div.offsetWidth, h = div.offsetHeight || el.size * 1.3;
      richBoxes.set(el.id, [w, h]);
      hit.setAttribute('width', w);
      hit.setAttribute('height', h);
    };
    return { node: g, divs: [div], measure };
  }
  richBoxes.delete(el.id);
  const t = svgEl('text', {
    x: el.x, y: el.y, 'font-size': el.size, 'font-family': FONT,
    fill: color, 'data-role': 'text-body',
  }, g);
  el.text.split('\n').forEach((line, i) => {
    const span = svgEl('tspan', { x: el.x, dy: i === 0 ? 0 : el.size * 1.3 }, t);
    span.textContent = line || ' ';
  });
  return { node: g };
}

// ---- links (filled area spanning two objects/segments/groups) ----

// Boundary points of one element, in world units.
function elOutline(el) {
  switch (el.type) {
    case 'path': case 'ink': case 'aline': return el.pts;
    case 'ellipse': return ellipsePoints(el.cx, el.cy, el.rx, el.ry);
    case 'rect': case 'card':
      return [[el.x, el.y], [el.x + el.w, el.y], [el.x + el.w, el.y + el.h], [el.x, el.y + el.h]];
    default: {
      const b = elementBBox(el);
      return [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]];
    }
  }
}

// Points contributed by a link endpoint reference: an element, a path segment,
// or a whole group.
export function linkTargetPoints(ref) {
  if (!ref) return [];
  if (ref.group) return groupElementMembers(ref.group).flatMap(elOutline);
  const el = byId(ref.id);
  if (!el) return [];
  if (ref.seg !== undefined && el.segments?.[ref.seg]) {
    const s = el.segments[ref.seg];
    return subPath(el.pts, s.t0, s.t1);
  }
  return elOutline(el);
}

const linkHull = el => convexHull([...linkTargetPoints(el.a), ...linkTargetPoints(el.b)]);

function renderLink(el) {
  const g = svgEl('g', { 'data-id': el.id });
  const hull = linkHull(el);
  if (hull.length >= 3) {
    svgEl('polygon', {
      points: ptsAttr(hull), fill: resolveColor(el.fill) || '#8a857c',
      'fill-opacity': el.opacity ?? 0.45, stroke: 'none',
    }, g);
  }
  return { node: g };
}

const RENDERERS = {
  card: renderCard, arrow: renderArrow, path: renderPath, ink: renderInk,
  ellipse: renderEllipse, rect: renderRect, aline: renderALine, text: renderText,
  link: renderLink,
};

// ---- node cache ----

const nodeCache = new Map(); // id → { key, node, divs }

// Cache key: the element's full JSON, plus whatever external data its pixels
// depend on (palette/label slots for 'slot:' refs, endpoint cards for arrows).
function elKey(el, salt) {
  let key = JSON.stringify(el);
  if (key.includes('slot:')) key += salt;
  if (el.type === 'arrow') {
    const a = byId(el.from), b = byId(el.to);
    key += a && b ? `|${a.x},${a.y},${a.w},${a.h}|${b.x},${b.y},${b.w},${b.h}` : '|x';
  }
  // links trace live geometry: rekey when either endpoint's outline moves
  if (el.type === 'link') key += '|' + ptsAttr([...linkTargetPoints(el.a), ...linkTargetPoints(el.b)]);
  return key;
}

export const invalidateRenderCache = () => nodeCache.clear();

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
    // corner handles resize a single card / rectangle / ellipse. For cards,
    // dragging the border moves it (contents ride along); the squares resize.
    if (single && (el.type === 'card' || el.type === 'rect' || el.type === 'ellipse')) {
      const box = el.type === 'ellipse'
        ? [el.cx - el.rx, el.cy - el.ry, el.cx + el.rx, el.cy + el.ry]
        : [el.x, el.y, el.x + el.w, el.y + el.h];
      const hs = 9 / s;
      for (const [hx, hy, name] of [
        [box[0], box[1], 'nw'], [box[2], box[1], 'ne'],
        [box[0], box[3], 'sw'], [box[2], box[3], 'se'],
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
  $('canvasWrap').style.background = state.doc.bg || '';
  const mathLayer = $('mathLayer');
  mathLayer.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`;
  const dataLayer = $('dataLayer');
  dataLayer.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`;

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
  const salt = JSON.stringify(state.doc.palette) + JSON.stringify(state.doc.labelSlots || []);
  const cardNodes = [], linkNodes = [], drawNodes = [], divs = [], measures = [];
  const seen = new Set();
  for (const el of state.doc.elements) {
    const renderer = RENDERERS[el.type];
    if (!renderer) continue;
    seen.add(el.id);
    const key = elKey(el, salt);
    let entry = nodeCache.get(el.id);
    if (!entry || entry.key !== key) {
      entry = renderer(el);
      entry.key = key;
      nodeCache.set(el.id, entry);
      if (entry.measure) measures.push(entry.measure);
    }
    const bucket = el.type === 'card' ? cardNodes : el.type === 'link' ? linkNodes : drawNodes;
    bucket.push(entry.node);
    if (entry.divs) divs.push(...entry.divs);
  }
  for (const id of [...nodeCache.keys()]) {
    if (!seen.has(id)) { nodeCache.delete(id); richBoxes.delete(id); }
  }
  $('layer-cards').replaceChildren(...cardNodes);
  $('layer-links').replaceChildren(...linkNodes);
  $('layer-draw').replaceChildren(...drawNodes);
  mathLayer.replaceChildren(...divs);
  for (const m of measures) m(); // rich text sizes its hit rect post-layout
  renderDataBoxes(dataLayer);

  const overlay = $('layer-overlay');
  overlay.replaceChildren();
  renderSelection(overlay);
}

// ---- data boxes (show each object's hidden notes, always or on hover) ----

export const dataView = { show: false, hover: false, hoverId: null };

function dataBox(el) {
  const b = elementBBox(el);
  const div = document.createElement('div');
  div.className = 'data-box';
  div.style.left = `${b[2] + 6}px`;
  div.style.top = `${b[1]}px`;
  const name = resolveLabel(el.label || '') || (el.title || '');
  div.innerHTML =
    (name ? `<b>${esc(name)}</b>` : '') +
    (el.notes ? `<span>${esc(el.notes).replace(/\n/g, '<br>')}</span>` : '');
  return div;
}

function renderDataBoxes(layer) {
  const boxes = [];
  const has = el => el && (el.notes || resolveLabel(el.label || ''));
  if (dataView.show) {
    for (const el of state.doc.elements) if (el.notes) boxes.push(dataBox(el));
  } else if (dataView.hover && dataView.hoverId) {
    const el = byId(dataView.hoverId);
    if (has(el)) boxes.push(dataBox(el));
  }
  layer.replaceChildren(...boxes);
}

// ---- SVG export ----

// Rich text lives in the HTML overlay at runtime; exports rebuild it as
// foreignObject, which browsers render fine (Tauri's WebKitGTK quirk is a
// live-transform problem, not a file-format one).
function exportRichText(el) {
  const g = svgEl('g');
  const box = richBoxes.get(el.id);
  const fo = svgEl('foreignObject', {
    x: el.x, y: el.y - el.size * 1.15,
    width: el.w || box?.[0] || 2000, height: (box?.[1] || 1000) + 4,
    style: 'overflow:visible',
  }, g);
  const div = document.createElement('div');
  div.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
  div.style.cssText = `font:${el.size}px ${FONT};color:${resolveColor(el.color)};` +
    `line-height:1.3;${el.w ? '' : 'width:max-content;'}`;
  div.innerHTML = richHTML(el.text);
  fo.appendChild(div);
  return g;
}

// Math label → centered foreignObject at the element's label anchor.
function exportMathLabel(el) {
  const b = elementBBox(el);
  const off = el.labelOff || [0, 0];
  const cx = (b[0] + b[2]) / 2 + off[0], top = b[1] - 9 + off[1];
  const fo = svgEl('foreignObject', {
    x: cx - 150, y: top - 12, width: 300, height: 40, style: 'overflow:visible',
  });
  const div = document.createElement('div');
  div.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
  div.style.cssText =
    `display:flex;justify-content:center;font:600 12.5px ${FONT};color:${resolveColor(el.color) || '#2b2622'};`;
  div.innerHTML = richHTML(resolveLabel(el.label));
  fo.appendChild(div);
  return fo;
}

// KaTeX CSS with its woff2 fonts baked in as data: URIs, so exported SVGs render
// math anywhere without needing the stylesheet or font files alongside them.
// ponytail: embeds the full ~300KB font set once per export; subset by used
// glyphs only if file size ever becomes a complaint.
let katexInlineCSS;
async function katexCSS() {
  if (katexInlineCSS !== undefined) return katexInlineCSS;
  try {
    const base = 'vendor/katex/';
    let css = await (await fetch(base + 'katex.min.css')).text();
    const fonts = [...new Set([...css.matchAll(/url\(([^)]+\.woff2)\)/g)].map(m => m[1]))];
    for (const ref of fonts) {
      const buf = new Uint8Array(await (await fetch(base + ref)).arrayBuffer());
      let bin = '';
      for (let i = 0; i < buf.length; i += 8192) bin += String.fromCharCode(...buf.subarray(i, i + 8192));
      css = css.split(`url(${ref})`).join(`url(data:font/woff2;base64,${btoa(bin)})`);
    }
    katexInlineCSS = css;
  } catch { katexInlineCSS = ''; }
  return katexInlineCSS;
}

export async function exportSVGString() {
  const box = contentBBox();
  if (!box) return null;
  const m = 40;
  const [x0, y0, x1, y1] = [box[0] - m, box[1] - m, box[2] + m, box[3] + m];
  const out = document.createElementNS(NS, 'svg');
  out.setAttribute('xmlns', NS);
  out.setAttribute('viewBox', `${x0} ${y0} ${x1 - x0} ${y1 - y0}`);
  out.setAttribute('width', x1 - x0);
  out.setAttribute('height', y1 - y0);

  const needsMath = state.doc.elements.some(el =>
    (el.type === 'text' && isRichText(el)) ||
    (el.label && !el.labelHide && hasMath(resolveLabel(el.label))));
  if (needsMath) {
    const css = await katexCSS();
    if (css) {
      const style = svgEl('style', {}, out);
      style.textContent = css;
    }
  }

  svgEl('rect', { x: x0, y: y0, width: x1 - x0, height: y1 - y0, fill: state.doc.bg || '#ffffff' }, out);
  out.appendChild(document.querySelector('#canvas defs').cloneNode(true));
  for (const id of ['layer-cards', 'layer-links', 'layer-draw']) {
    out.appendChild($(id).cloneNode(true));
  }
  for (const el of state.doc.elements) {
    const clone = out.querySelector(`[data-id="${el.id}"]`);
    if (!clone) continue;
    if (el.type === 'text' && isRichText(el)) {
      clone.replaceChildren(...exportRichText(el).childNodes);
    } else if (el.label && !el.labelHide && hasMath(resolveLabel(el.label))) {
      clone.appendChild(exportMathLabel(el));
    }
  }
  out.querySelectorAll('[data-hit], [data-ph]').forEach(n => n.remove());
  return new XMLSerializer().serializeToString(out);
}
