// SVG rendering with a per-element node cache: only elements whose data
// changed since the last frame rebuild their DOM, everything else is re-slotted
// in document order (which is what gives us z-order for free).
import { state, byId, resolveColor, resolveLabel, groupElementMembers } from './model.js';
import {
  GRID, bboxOfPts, subPath, pointAt, polylineLength, rectEdgePoint, basePairRungs, defaultBases,
  convexHull, ellipsePoints, roundedPathD,
} from './geom.js';
import {
  drawBrush, brushPath, strandLayout, midline, naturalBases, uAt, styleGroup, DEFAULT_BPG, naturalD,
  gridPitch, randomBase, BASE_COLORS, COMPLEMENT,
} from './dna.js';

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
      const b = bboxOfPts(el.pts), m = el.dna ? diam(el) * 0.75 + 4 : (el.width || 2) + 4;
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

// A segment's drawn thickness: its own width if tuned, else a touch above the
// parent line (the historical +2.5). Shared by the segment stroke, the cap
// alignment, and the selection highlight.
export const segWidth = (seg, lineW) => seg.width ?? (lineW + 2.5);

// ---- pattern fills ----
// Patterns paint `fg` marks on a `bg` tile — bg defaults to transparent so the
// canvas shows through, but any second colour can be chosen. The lattice size
// scales from a base 8-unit tile (scale slider). One <pattern> per
// (kind,fg,bg,tile) is built on demand and cached in the live <defs> (which
// export clones, so exports keep them). ponytail: never evicted — bounded by
// the combinations actually used.
export const PATTERNS = {
  none: 'Solid', horizontal: 'Horizontal stripes', vertical: 'Vertical stripes',
  diagonal: 'Diagonal stripes ╱', 'diagonal-alt': 'Diagonal stripes ╲',
  dots: 'Dots', checker: 'Checkerboard',
};
const patternCache = new Set();

function buildPattern(id, kind, fg, bg, tile) {
  const p = svgEl('pattern', { id, patternUnits: 'userSpaceOnUse', width: tile, height: tile });
  const add = (tag, attrs) => svgEl(tag, attrs, p);
  const u = tile / 8; // marks are defined on an 8-unit grid, scaled to the tile
  if (bg) add('rect', { x: 0, y: 0, width: tile, height: tile, fill: bg });
  if (kind === 'horizontal') add('rect', { x: 0, y: 0, width: tile, height: 3 * u, fill: fg });
  else if (kind === 'vertical') add('rect', { x: 0, y: 0, width: 3 * u, height: tile, fill: fg });
  else if (kind === 'diagonal' || kind === 'diagonal-alt') {
    p.setAttribute('patternTransform', kind === 'diagonal' ? 'rotate(45)' : 'rotate(-45)');
    add('rect', { x: 0, y: 0, width: tile, height: 3 * u, fill: fg });
  } else if (kind === 'dots') add('circle', { cx: tile / 2, cy: tile / 2, r: 1.8 * u, fill: fg });
  else if (kind === 'checker') {
    add('rect', { x: 0, y: 0, width: tile / 2, height: tile / 2, fill: fg });
    add('rect', { x: tile / 2, y: tile / 2, width: tile / 2, height: tile / 2, fill: fg });
  }
  return p;
}

function patternRef(kind, fg, bg, scale) {
  if (!kind || kind === 'none') return null;
  const tile = Math.max(2, Math.round(8 * (scale || 1)));
  const id = `pat-${kind}-${fg.replace('#', '')}-${(bg || 'none').replace('#', '')}-${tile}`;
  if (!patternCache.has(id)) {
    const defs = document.querySelector('#canvas defs');
    if (defs && !document.getElementById(id)) defs.appendChild(buildPattern(id, kind, fg, bg, tile));
    patternCache.add(id);
  }
  return `url(#${id})`;
}

// Paint (color or pattern) for any object carrying .pattern/.patternBg/.patternScale.
// `fg` is the object's own colour (fill for shapes, stroke colour for lines).
export const paintOf = (obj, fg) =>
  (obj.pattern && obj.pattern !== 'none' &&
    patternRef(obj.pattern, fg, obj.patternBg && resolveColor(obj.patternBg), obj.patternScale)) || fg;

// Fill for closed shapes (rect/ellipse): a pattern, a color ref, or 'none'.
const fillOf = el => (el.fill ? paintOf(el, resolveColor(el.fill)) : 'none');

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
    // one-sided barb whose flat edge lies flush with the stroke's outer edge
    // (offset half the line width, opposite the barb) so tip → base runs down
    // one side of the line, not its center — no discontinuity at the tip. The
    // offset tracks the line weight.
    const side = flip ? -1 : 1;
    const o = -side * w / 2;
    poly([P(s * 0.9, o), P(-s * 0.5, s * 0.92 * side + o), P(-s * 0.12, o)]);
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

// Object/segment label at anchor + user offset. Draggable via data-labelfor.
// Math labels render as overlay divs (pointer-events:none), so they get an
// invisible SVG twin carrying data-labelfor so the same drag machinery moves them.
function drawLabel(g, divs, measures, owner, anchor, opts) {
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
    const hit = svgEl('rect', {
      fill: 'transparent', 'data-labelfor': opts.id, style: 'cursor:move',
      ...(opts.segi !== undefined ? { 'data-segi': opts.segi } : {}),
    }, g);
    measures.push(() => { // div is centered on p (translate -50% -50%)
      const w = div.offsetWidth, h = div.offsetHeight;
      hit.setAttribute('x', p[0] - w / 2); hit.setAttribute('y', p[1] - h / 2);
      hit.setAttribute('width', w); hit.setAttribute('height', h);
    });
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
    fill: resolveColor(el.fill) || '#ffffff', stroke: CARD_STROKE, 'stroke-width': 1.25,
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
  const divs = [], measures = [];
  const pts = ptsAttr(el.pts);
  const w = el.width || 2;
  const color = resolveColor(el.color);
  const hitW = el.dna ? Math.max(12, diam(el)) : Math.max(12, w + 8);
  // inside a duplex a strand doesn't catch clicks: the duplex does (click it
  // again for its strands), so what you click is what you see
  const runs = el.dna ? dnaRuns(el, dnaLayout(el)) : [{ t0: 0, t1: Infinity }];
  const unpaired = (t0, t1) => runs.some(r => (t0 + t1) / 2 >= r.t0 && (t0 + t1) / 2 <= r.t1);
  for (const r of runs) {
    svgEl('polyline', {
      points: el.dna ? ptsAttr(subPath(el.pts, r.t0, r.t1)) : pts,
      fill: 'none', stroke: 'transparent', 'stroke-width': hitW, 'data-hit': '1',
    }, g);
  }
  if (el.dna) drawDNAStrand(g, el);
  else svgEl('path', { d: roundedPathD(el.pts, el.corner || 0), ...strokeAttrs(el), stroke: paintOf(el, color) }, g);
  const len = polylineLength(el.pts);
  const labelOff = el.dna ? diam(el) / 2 + 9 : 16;
  (el.segments || []).forEach((seg, i) => {
    const sp = subPath(el.pts, seg.t0, seg.t1);
    const sa = ptsAttr(sp);
    const segColor = resolveColor(seg.color);
    const scap = seg.linecap || 'round';
    if (unpaired(seg.t0, seg.t1)) {
      svgEl('polyline', {
        points: sa, fill: 'none', stroke: 'transparent', 'stroke-width': hitW, 'data-hit': '1', 'data-seg': i,
      }, g);
    }
    if (!el.dna) svgEl('path', {
      d: roundedPathD(sp, el.corner || 0), fill: 'none', stroke: paintOf(seg, segColor),
      'stroke-width': segWidth(seg, w),
      'stroke-linejoin': scap === 'round' ? 'round' : 'miter', 'stroke-linecap': scap, 'data-seg': i,
    }, g);
    drawLabel(g, divs, measures, seg, labelPos(el.pts, (seg.t0 + seg.t1) / 2, labelOff, 1),
      { size: 12, color: segColor, id: el.id, segi: i });
  });
  // a cap at an endpoint covered by a segment takes that segment's width (so it
  // aligns with the thicker segment edge, no tip discontinuity) AND its paint —
  // an end-reaching coloured or patterned segment carries into its arrowhead/harpoon
  const capStyle = end => {
    const seg = (el.segments || []).find(s => (end ? s.t1 >= len - 0.5 : s.t0 <= 0.5));
    return seg
      ? { w: segWidth(seg, w), paint: paintOf(seg, resolveColor(seg.color)) }
      : { w, paint: color };
  };
  const c0 = capStyle(0), c1 = capStyle(1);
  if (!el.dna) { // a DNA strand ends in its own molecular caps
    capGlyph(g, el.pts[0], endDir(el.pts, 0), el.cap0, c0.paint, c0.w, el.cap0flip);
    capGlyph(g, el.pts[el.pts.length - 1], endDir(el.pts, 1), el.cap1, c1.paint, c1.w, el.cap1flip);
  }
  drawLabel(g, divs, measures, el, labelPos(el.pts, len / 2, el.dna ? labelOff - 2 : 14, -1),
    { size: 12.5, color, id: el.id });
  return { node: g, divs, measures };
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
  const divs = [], measures = [];
  const d = inkD(el.pts);
  svgEl('path', {
    d, fill: 'none', stroke: 'transparent',
    'stroke-width': Math.max(12, (el.width || 2) + 8), 'data-hit': '1',
  }, g);
  svgEl('path', { d, ...strokeAttrs(el) }, g);
  drawLabel(g, divs, measures, el, bboxLabelAnchor(el), { size: 12.5, color: resolveColor(el.color), id: el.id });
  return { node: g, divs, measures };
}

// Radial gradient (bright core → object colour) for glowing dots, cached in the
// live <defs> like patterns. ponytail: never evicted — bounded by colours used.
const glowCache = new Set();
function glowRef(color) {
  const id = `glow-${color.replace('#', '')}`;
  if (!glowCache.has(id)) {
    const defs = document.querySelector('#canvas defs');
    if (defs && !document.getElementById(id)) {
      const grad = svgEl('radialGradient', { id });
      svgEl('stop', { offset: '0%', 'stop-color': '#ffffff', 'stop-opacity': 0.95 }, grad);
      svgEl('stop', { offset: '35%', 'stop-color': color }, grad);
      svgEl('stop', { offset: '100%', 'stop-color': color }, grad);
      defs.appendChild(grad);
    }
    glowCache.add(id);
  }
  return `url(#${id})`;
}

function renderEllipse(el) {
  const g = svgEl('g', { 'data-id': el.id });
  const divs = [], measures = [];
  const base = { cx: el.cx, cy: el.cy, rx: el.rx, ry: el.ry };
  svgEl('ellipse', {
    ...base, fill: 'none', stroke: 'transparent',
    'stroke-width': Math.max(12, (el.width || 2) + 8), 'data-hit': '1',
  }, g);
  if (el.glow) {
    // a blurred oversized halo, then a bright-cored gradient body on top
    const c = resolveColor(el.fill) || resolveColor(el.color) || '#3ad13a';
    svgEl('ellipse', {
      cx: el.cx, cy: el.cy, rx: el.rx * 1.7, ry: el.ry * 1.7,
      fill: c, 'fill-opacity': 0.55, filter: 'url(#glowBlur)', stroke: 'none',
    }, g);
    svgEl('ellipse', { ...base, fill: glowRef(c), stroke: 'none' }, g);
    drawLabel(g, divs, measures, el, bboxLabelAnchor(el), { size: 12.5, color: resolveColor(el.color), id: el.id });
    return { node: g, divs, measures };
  }
  svgEl('ellipse', { ...base, ...strokeAttrs(el), fill: fillOf(el) }, g);
  drawLabel(g, divs, measures, el, bboxLabelAnchor(el), { size: 12.5, color: resolveColor(el.color), id: el.id });
  return { node: g, divs, measures };
}

function renderRect(el) {
  const g = svgEl('g', { 'data-id': el.id });
  const divs = [], measures = [];
  const base = { x: el.x, y: el.y, width: el.w, height: el.h, rx: el.r || 0 };
  svgEl('rect', {
    ...base, fill: 'none', stroke: 'transparent',
    'stroke-width': Math.max(12, (el.width || 2) + 8), 'data-hit': '1',
  }, g);
  svgEl('rect', { ...base, ...strokeAttrs(el), fill: fillOf(el) }, g);
  drawLabel(g, divs, measures, el, bboxLabelAnchor(el), { size: 12.5, color: resolveColor(el.color), id: el.id });
  return { node: g, divs, measures };
}

function renderALine(el) {
  const g = svgEl('g', { 'data-id': el.id });
  const divs = [], measures = [];
  const [a, b] = el.pts;
  const color = resolveColor(el.color);
  svgEl('line', {
    x1: a[0], y1: a[1], x2: b[0], y2: b[1],
    stroke: 'transparent', 'stroke-width': Math.max(12, (el.width || 2) + 8), 'data-hit': '1',
  }, g);
  svgEl('line', { x1: a[0], y1: a[1], x2: b[0], y2: b[1], ...strokeAttrs(el) }, g);
  capGlyph(g, a, endDir(el.pts, 0), el.cap0, color, el.width || 2, el.cap0flip);
  capGlyph(g, b, endDir(el.pts, 1), el.cap1, color, el.width || 2, el.cap1flip);
  drawLabel(g, divs, measures, el, bboxLabelAnchor(el), { size: 12.5, color, id: el.id });
  return { node: g, divs, measures };
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

const subPathD = h => (h.length >= 3 ? ` M${h.map(p => p.join(' ')).join(' L')} Z` : '');

// Line-of-sight fill: the merged convex hull of both endpoints minus each
// endpoint's own convex hull, punched out with the even-odd rule. What's left
// is the "webbing" visible between the two objects — never the area behind
// them. ponytail: overlapping endpoints double-punch (parity 3 → fills the
// overlap); acceptable for a visual link, revisit if it looks wrong in use.
// The polyline a link end runs along — a path segment or a whole line — or
// null for ends (groups, shapes) that have no strand to space base pairs on.
export { defaultBases };
export function linkStrand(ref) {
  const el = ref && !ref.group && byId(ref.id);
  if (!el || !['path', 'aline', 'ink'].includes(el.type)) return null;
  if (ref.seg !== undefined && el.segments?.[ref.seg]) {
    const s = el.segments[ref.seg];
    return subPath(el.pts, s.t0, s.t1);
  }
  return el.pts;
}

// ---- DNA strands (lines with .dna set, drawn by the DNA brush) ----
// el.dna is true (follow the document's DNA grid) or an explicit diameter in
// world units. The grid — doc.dnaBpg bases per grid square — sets every auto
// base count, and the diameter that looks natural at that spacing.

export const dnaBpg = () => state.doc.dnaBpg || DEFAULT_BPG;
export const diam = el => (typeof el.dna === 'number' ? el.dna : naturalD(dnaBpg()));

const dnaEnd = ref => {
  const e = ref && !ref.group && byId(ref.id);
  return e?.type === 'path' && e.dna ? e : null;
};
// A base-pair link between two DNA strands draws as one double helix.
export const duplexLink = l => l.type === 'link' && l.style === 'bases' && !!dnaEnd(l.a) && !!dnaEnd(l.b);
const refSpan = (ref, e) => {
  const s = ref.seg !== undefined && e.segments?.[ref.seg];
  return s ? [s.t0, s.t1] : [0, polylineLength(e.pts)];
};
// The duplex's base pairs: the link's own count, else the grid's count.
export function duplexBases(l) {
  if (l.bases) return l.bases;
  const A = dnaEnd(l.a), B = dnaEnd(l.b);
  const [a0, a1] = refSpan(l.a, A), [b0, b1] = refSpan(l.b, B);
  return naturalBases(Math.min(a1 - a0, b1 - b0), gridPitch(dnaBpg()));
}
// Spans of a strand with a fixed base count: paired domains (from duplex links,
// listed first so they win over a segment's own count) and counted segments.
// ponytail: scans every element per DNA strand; index links by strand if docs get big.
function dnaFixed(el) {
  const fixed = [];
  for (const l of state.doc.elements) {
    if (!duplexLink(l)) continue;
    for (const role of ['a', 'b']) {
      if (l[role].id !== el.id) continue;
      const [t0, t1] = refSpan(l[role], el);
      fixed.push({ t0, t1, count: duplexBases(l), paired: true, link: l, role });
    }
  }
  for (const s of el.segments || []) if (s.bases) fixed.push({ t0: s.t0, t1: s.t1, count: s.bases });
  return fixed;
}
export const dnaLayout = el =>
  strandLayout(polylineLength(el.pts), gridPitch(dnaBpg()), dnaFixed(el), el.bases);

// The unpaired stretches of a strand: [{ t0, t1, before, after }], with the
// paired spans (duplexes) they run on from / into.
function dnaRuns(el, lay) {
  const L = polylineLength(el.pts), runs = [];
  let at = 0, before = null;
  for (const sp of lay.spans.filter(x => x.paired)) {
    if (sp.t0 - at >= 0.5) runs.push({ t0: at, t1: sp.t0, before, after: sp });
    at = sp.t1; before = sp;
  }
  if (L - at >= 0.5) runs.push({ t0: at, t1: L, before, after: null });
  return runs;
}

const strandColor = (e, t) =>
  resolveColor((e.segments || []).find(s => t >= s.t0 && t <= s.t1)?.color ?? e.color);
const fillet = D => D * 1.5; // tightest turn a strand takes without its texture visibly smearing

// Base letter of strand e at base index i: its segment's sequence (the string
// field, when it is one) or a fixed random base.
function baseLetter(e, lay, i) {
  for (const s of e.segments || []) {
    const seq = (s.string || '').toUpperCase().replace(/U/g, 'T').replace(/[^ACGT]/g, '');
    if (!seq) continue;
    const j = i - Math.round(uAt(lay.knots, s.t0));
    if (j >= 0 && j < Math.round(uAt(lay.knots, s.t1) - uAt(lay.knots, s.t0))) return seq[j % seq.length];
  }
  return randomBase(e.id, i);
}
const baseColor = e => resolveColor(e.baseColor) || '#f1ece2';

// A strand's paint layers on texture `tex` ('ss', 'ssB', 'ds1'…): the whole
// strand in its colour, then its bases per its colour mode. letterAt(i) maps
// the brush's base slot i to the base letter shown there.
function strandLayers(e, tex, btex, tOf, letterAt) {
  const layers = tex ? [{ tex, colorAt: t => strandColor(e, tOf(t)) }] : [];
  if (e.dnaColor === 'bases') layers.push({ tex: btex, colorAt: () => baseColor(e) });
  if (e.dnaColor === 'sequence') layers.push({ tex: btex, base: true, colorAt: (t, i) => BASE_COLORS[letterAt(i)] });
  return layers;
}

// A duplex's shape: the midline between its two strands' paired spans.
function duplexGeom(l) {
  const A = dnaEnd(l.a), B = dnaEnd(l.b);
  const [a0, a1] = refSpan(l.a, A), [b0, b1] = refSpan(l.b, B);
  const mid = midline(subPath(A.pts, a0, a1), subPath(B.pts, b0, b1), a1 - a0, b1 - b0, pointAt);
  return { A, B, a0, a1, b0, b1, mid, D: (diam(A) + diam(B)) / 2, n: duplexBases(l) };
}

// Where a strand meets a duplex, at the start (atStart) or end of its paired
// span: the duplex end there, its outward axis, the duplex u at it, and how
// the strand runs in that u (A runs with it; antiparallel B against it). The
// single-stranded continuation uses the matching lone-strand texture in the
// duplex's own u frame, so its backbone carries straight on in phase.
function junction(sp, atStart) {
  const G = duplexGeom(sp.link), m = G.mid.pts;
  const low = sp.role === 'a' ? atStart : (G.mid.rev ? !atStart : atStart); // the u = 0 end?
  const p = low ? m[0] : m[m.length - 1], q = low ? m[1] : m[m.length - 2];
  const d = Math.hypot(p[0] - q[0], p[1] - q[1]) || 1;
  return {
    p, out: [(p[0] - q[0]) / d, (p[1] - q[1]) / d], u: low ? 0 : G.n,
    dir: sp.role === 'a' || !G.mid.rev ? 1 : -1, tex: sp.role === 'a' ? 'ss' : 'ssB',
  };
}

function drawDNAStrand(g, el) {
  const D = diam(el), lay = dnaLayout(el);
  const target = styleGroup(g, D, el.dnaOutline);
  for (const run of dnaRuns(el, lay)) {
    const { t0, t1 } = run;
    const uS = t => uAt(lay.knots, t);
    const jS = run.before && junction(run.before, false), jE = run.after && junction(run.after, true);
    const ref = jS || jE;
    const dir = ref ? ref.dir : 1, tex = ref ? ref.tex : 'ss';
    // run u = c + dir · strand u, pinned to the duplex u at a junction
    const c = jS ? jS.u - dir * uS(t0) : jE ? jE.u - dir * uS(t1) : -uS(t0);
    // geometry: the strand's own line, but a junction end starts on the duplex
    // axis and peels off to the line over about one diameter
    const both = jS && jE;
    const dS = jS ? Math.min(D * 0.9, (t1 - t0) / (both ? 3 : 2)) : 0;
    const dE = jE ? Math.min(D * 0.9, (t1 - t0) / (both ? 3 : 2)) : 0;
    const verts = [];
    if (jS) verts.push({ p: jS.p, t: t0 });
    verts.push({ p: pointAt(el.pts, t0 + dS), t: t0 + dS });
    let acc = 0;
    for (let i = 1; i < el.pts.length - 1; i++) {
      acc += Math.hypot(el.pts[i][0] - el.pts[i - 1][0], el.pts[i][1] - el.pts[i - 1][1]);
      if (acc > t0 + dS && acc < t1 - dE) verts.push({ p: el.pts[i], t: acc });
    }
    verts.push({ p: pointAt(el.pts, t1 - dE), t: t1 - dE });
    if (jE) verts.push({ p: jE.p, t: t1 });
    let knots = [[t0, c + dir * uS(t0)], ...lay.knots.filter(([t]) => t > t0 && t < t1).map(([t, u]) => [t, c + dir * u]), [t1, c + dir * uS(t1)]];
    let caps = { head: !jS, tail: !jE };
    // the brush wants u increasing: a strand running against the duplex u is drawn back to front
    const sgn = dir;
    if (sgn < 0) {
      verts.reverse(); knots.reverse(); caps = { head: caps.tail, tail: caps.head };
    }
    const tOf = t => t * sgn;
    const strandIndex = i => Math.round(dir > 0 ? i - c : c - i - 1); // brush base slot → strand base
    drawBrush(target, {
      path: brushPath(verts.map(v => v.p), fillet(D), verts.map(v => v.t * sgn)),
      knots: knots.map(([t, u]) => [t * sgn, u]), D, caps, toon: el.dnaToon,
      layers: strandLayers(el, tex, `${tex}b`, tOf, i => baseLetter(el, lay, strandIndex(i))),
      breaks: (el.segments || []).flatMap(s => [s.t0 * sgn, s.t1 * sgn]),
    });
  }
}

// The double helix of a duplex link, laid along the midline between its two
// strands. Strand A is the texture's strand 1 (5'→3' along A), B the other;
// each backbone takes its own strand's (segment) colour, and each strand's
// bases follow its own colour mode — B's sequence is A's complement.
function drawDuplex(g, l) {
  const { A, B, a0, a1, b0, b1, mid, D, n } = duplexGeom(l);
  let acc = 0;
  const fk = mid.pts.map((p, i) => [acc += i ? Math.hypot(p[0] - mid.pts[i - 1][0], p[1] - mid.pts[i - 1][1]) : 0, mid.f[i]]);
  const Lm = acc;
  const lerp = (k, x, i, j) => { // knot lookup, f ↔ t along the midline
    let q = 1;
    while (q < k.length - 1 && k[q][i] < x) q++;
    const a = k[q - 1], b = k[q], d = b[i] - a[i];
    return d ? a[j] + (b[j] - a[j]) * (x - a[i]) / d : a[j];
  };
  const tA = t => a0 + lerp(fk, t, 0, 1) * (a1 - a0);
  const tB = t => { const f = lerp(fk, t, 0, 1); return mid.rev ? b1 - f * (b1 - b0) : b0 + f * (b1 - b0); };
  const breaks = [
    ...(A.segments || []).flatMap(s => [s.t0, s.t1]).map(t => (t - a0) / (a1 - a0)),
    ...(B.segments || []).flatMap(s => [s.t0, s.t1]).map(t => (t - b0) / (b1 - b0)).map(f => (mid.rev ? 1 - f : f)),
  ].filter(f => f > 0 && f < 1).map(f => lerp(fk, f, 1, 0));
  const layA = dnaLayout(A), uA0 = Math.round(uAt(layA.knots, a0));
  const letterA = i => baseLetter(A, layA, uA0 + i);
  const layers = [
    { tex: 'ds', colorAt: t => strandColor(B, tB(t)) },
    { tex: 'ds1', colorAt: t => strandColor(A, tA(t)) },
    ...strandLayers(A, null, 'dsbA', tA, letterA),
    ...strandLayers(B, null, 'dsbB', tB, i => COMPLEMENT[letterA(i)]),
  ];
  drawBrush(styleGroup(g, D, A.dnaOutline || B.dnaOutline), {
    path: brushPath(mid.pts, fillet(D)), knots: [[0, 0], [Lm, n]], D, layers, breaks,
    caps: { head: true, tail: true }, toon: A.dnaToon || B.dnaToon,
  });
}

// Everything a DNA strand's or duplex's pixels depend on beyond its own JSON.
function dnaKey(el) {
  const links = el.type === 'link' ? [el] : dnaFixed(el).map(f => f.link);
  return dnaBpg() + JSON.stringify(links.map(l => [l, byId(l.a.id), byId(l.b.id)]));
}

function renderLink(el) {
  const g = svgEl('g', { 'data-id': el.id });
  const ptsA = linkTargetPoints(el.a), ptsB = linkTargetPoints(el.b);
  const merged = convexHull([...ptsA, ...ptsB]);
  const A = el.style === 'bases' && linkStrand(el.a), B = A && linkStrand(el.b);
  if (B) {
    // invisible hull keeps the gaps between rungs clickable (data-hit: dropped from exports)
    if (merged.length >= 3) {
      svgEl('path', { d: `M${merged.map(p => p.join(' ')).join(' L')} Z`, fill: 'transparent', 'data-hit': '1' }, g);
    }
    if (duplexLink(el)) { drawDuplex(g, el); return { node: g }; }
    const color = resolveColor(el.fill) || '#2b2622';
    for (const [p, q] of basePairRungs(A, B, el.bases || defaultBases(A, B))) {
      svgEl('line', {
        x1: p[0], y1: p[1], x2: q[0], y2: q[1],
        stroke: color, 'stroke-width': 1.5, 'stroke-linecap': 'butt',
      }, g);
    }
    return { node: g };
  }
  if (merged.length >= 3) {
    const color = resolveColor(el.fill) || '#8a857c';
    const fill = paintOf(el, color);
    const d = `M${merged.map(p => p.join(' ')).join(' L')} Z`
      + subPathD(convexHull(ptsA)) + subPathD(convexHull(ptsB));
    svgEl('path', {
      d, 'fill-rule': 'evenodd', fill,
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
  // DNA strands and duplexes depend on each other (shape, counts, colours) and the DNA grid
  if (el.dna || (el.type === 'link' && duplexLink(el))) key += dnaKey(el);
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
        stroke: SEL, 'stroke-width': segWidth(seg, el.width || 2) + 9 / s, opacity: 0.35,
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
    // a duplex hides its strands: show them as ghosts while it is selected
    if (el.type === 'link' && duplexLink(el)) {
      for (const ref of [el.a, el.b]) {
        const st = byId(ref.id);
        svgEl('polyline', {
          points: ptsAttr(st.pts), fill: 'none', stroke: resolveColor(st.color), 'stroke-width': 2 / s,
          'stroke-dasharray': `${6 / s} ${4 / s}`, opacity: 0.9, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
        }, overlay);
      }
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
    // text notes resize horizontally: the wrap width follows the handle and the
    // height flows from the wrapped content (no vertical handle — nothing to set)
    if (single && el.type === 'text') {
      const my = (b[1] + b[3]) / 2, hs = 9 / s;
      for (const [hx, name] of [[b[0], 'w'], [b[2], 'e']]) {
        svgEl('rect', {
          x: hx - hs / 2, y: my - hs / 2, width: hs, height: hs,
          fill: '#ffffff', stroke: SEL, 'stroke-width': 1.5 / s,
          'data-handle': name, 'data-id': el.id, style: 'cursor:ew-resize',
        }, overlay);
      }
    }
    // path endpoints: drag to keep laying down line (select tool)
    if (el.type === 'path' && single && state.tool === 'select') {
      const a = el.pts[0], z = el.pts[el.pts.length - 1];
      handleDot(overlay, a[0], a[1], s, { 'data-pend': '0', 'data-id': el.id });
      handleDot(overlay, z[0], z[1], s, { 'data-pend': '1', 'data-id': el.id });
    }
    // annotation line/arrow endpoints: drag to reshape (like resizing a shape)
    if (el.type === 'aline' && single) {
      el.pts.forEach((p, i) =>
        handleDot(overlay, p[0], p[1], s, { 'data-aend': i, 'data-id': el.id }));
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

// render() coalesces to one paint per animation frame: a drag or pan fires many
// pointermove → changed() → render() calls, but only the last one before the
// frame paints does real work. renderNow() forces an immediate synchronous
// render (used by SVG export, which reads the live DOM right after).
let rafPending = false;
export function render() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => { rafPending = false; renderNow(); });
}

export function renderNow(cull = true) {
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

  // Viewport culling: only elements whose bbox meets the visible world rect
  // (plus a margin, so labels/caps just off-screen don't pop) are keyed, built,
  // and inserted. This bounds per-frame stringify + DOM node count to what's on
  // screen instead of the whole document. cull=false forces everything (export).
  let vx0 = -Infinity, vy0 = -Infinity, vx1 = Infinity, vy1 = Infinity;
  if (cull) {
    const m = 150 / s;
    vx0 = -tx / s - m; vy0 = -ty / s - m;
    vx1 = (vw - tx) / s + m; vy1 = (vh - ty) / s + m;
  }
  const onScreen = el => {
    const b = elementBBox(el);
    return b[2] >= vx0 && b[0] <= vx1 && b[3] >= vy0 && b[1] <= vy1;
  };
  const selected = id => state.selection.some(sel => sel.id === id);

  // cards sit below everything; all other elements paint in doc order (z-order)
  const salt = JSON.stringify(state.doc.palette) + JSON.stringify(state.doc.labelSlots || []);
  const cardNodes = [], linkNodes = [], drawNodes = [], divs = [], measures = [];
  const seen = new Set();
  for (const el of state.doc.elements) {
    const renderer = RENDERERS[el.type];
    if (!renderer) continue;
    seen.add(el.id); // keep every live element's cache entry; only cull from the DOM
    if (cull && !onScreen(el) && !selected(el.id)) continue;
    const key = elKey(el, salt);
    let entry = nodeCache.get(el.id);
    if (!entry || entry.key !== key) {
      entry = renderer(el);
      entry.key = key;
      nodeCache.set(el.id, entry);
      if (entry.measure) measures.push(entry.measure);
      if (entry.measures) measures.push(...entry.measures);
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

// plain: skip KaTeX CSS + math foreignObjects — a lighter SVG for thumbnails
// that a canvas can rasterize without being tainted (WebKit taints on foreignObject).
export async function exportSVGString({ plain = false } = {}) {
  renderNow(false); // export clones the live layers — force every element in, unculled
  const box = contentBBox();
  if (!box) return null;
  const m = 40;
  const [x0, y0, x1, y1] = [box[0] - m, box[1] - m, box[2] + m, box[3] + m];
  const out = document.createElementNS(NS, 'svg');
  out.setAttribute('xmlns', NS);
  out.setAttribute('viewBox', `${x0} ${y0} ${x1 - x0} ${y1 - y0}`);
  out.setAttribute('width', x1 - x0);
  out.setAttribute('height', y1 - y0);

  const needsMath = !plain && state.doc.elements.some(el =>
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
  for (const el of plain ? [] : state.doc.elements) {
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
