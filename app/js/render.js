// SVG rendering with a per-element node cache: only elements whose data
// changed since the last frame rebuild their DOM, everything else is re-slotted
// in document order (which is what gives us z-order for free).
import { state, byId, resolveColor, resolveLabel, groupElementMembers } from './model.js';
import {
  GRID, bboxOfPts, subPath, pointAt, polylineLength, rectEdgePoint, basePairRungs, defaultBases,
  convexHull, ellipsePoints, roundedPathD, smoothPolyline, extendPolyline, drawnPts, smoothD, smoothPts, rotatePt,
} from './geom.js';
import {
  drawBrush, brushPath, strandLayout, midline, naturalBases, uAt, outlineOf, DEFAULT_BPG, naturalD,
  gridPitch, randomBase, BASE_COLORS, COMPLEMENT, seqOf, seqLetters, tAt, tintRef, DIAMETER_A,
} from './dna.js';
import MOLS from './mol-tex.js';

const NS = 'http://www.w3.org/2000/svg';
export const SEL = '#b57f1d'; // honey selection accent (matches --primary)
const CARD_STROKE = '#ded7ca';
const FONT = 'ui-sans-serif, system-ui, sans-serif';

// Text-note font choices (el.font). Generic fallbacks last, so a missing face
// still lands in the right family on every OS.
export const FONTS = {
  sans: ['Sans (system)', FONT],
  helvetica: ['Helvetica / Arial', 'Helvetica, Arial, "Liberation Sans", sans-serif'],
  times: ['Times', '"Times New Roman", Times, "Liberation Serif", serif'],
  georgia: ['Georgia', 'Georgia, "DejaVu Serif", serif'],
  mono: ['Monospace', 'ui-monospace, Menlo, "DejaVu Sans Mono", monospace'],
};
export const LINE_H = 1.3; // default line spacing (el.lh overrides)
const fontOf = el => FONTS[el.font]?.[1] || FONT;
const lhOf = el => el.lh || LINE_H;
const decoOf = el => [el.underline && 'underline', el.strike && 'line-through'].filter(Boolean).join(' ');

// CSS for a text note's whole-element formatting (live overlay, export, editor).
export function textStyle(el) {
  return {
    fontFamily: fontOf(el), fontSize: `${el.size}px`, fontWeight: el.bold ? 700 : 400,
    fontStyle: el.italic ? 'italic' : 'normal', textDecoration: decoOf(el) || 'none',
    textAlign: el.align || 'left', lineHeight: lhOf(el),
  };
}
const cssText = o => Object.entries(o).map(([k, v]) => `${k.replace(/[A-Z]/g, c => '-' + c.toLowerCase())}:${v}`).join(';');

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
    // throwOnError:false already turns parse errors into a red .katex-error span;
    // anything else KaTeX throws (e.g. no font metrics for \textsf{\textbf{\textit…}})
    // gets the same red mark instead of passing for plain text
    try { html = window.katex.renderToString(tex, { throwOnError: false }); } catch (e) {
      html = `<span class="katex-error" title="${esc(String(e.message)).replace(/"/g, '&quot;')}" style="color:#cc0000">${esc(tex)}</span>`;
    }
    texCache.set(tex, html);
  }
  return texCache.get(tex);
}

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const hasMath = text => text.includes('$') && !!window.katex;

// Inline formatting is a few HTML tags typed (or inserted by the text toolbar)
// into the text itself: <b> <i> <u> <s> <sup> <sub>. Anything else stays literal.
export const INLINE_TAGS = ['b', 'i', 'u', 's', 'sup', 'sub'];
const TAG_SPLIT = /<(\/?)(b|i|u|s|sup|sub)>/;
const stripTags = t => t.replace(new RegExp(TAG_SPLIT.source, 'g'), '');

// A text element is "rich" (HTML-rendered) when it has math or a wrap box.
export const isRichText = el => hasMath(el.text) || !!el.w;

// Inline tags → tspans, so plain notes and labels stay pure SVG (WebKit drops
// HTML overlays from PNG export). Raised/lowered runs shift with dy, so a
// line's tspans need absolute y, not dy, to start each line clean.
function appendRuns(parent, line, size) {
  if (!TAG_SPLIT.test(line)) { parent.textContent = line || ' '; return; }
  const on = new Set(), parts = line.split(TAG_SPLIT);
  let shift = 0;
  for (let i = 0; i < parts.length; i += 3) {
    if (parts[i]) {
      const want = on.has('sup') ? -0.38 : on.has('sub') ? 0.22 : 0, attrs = {};
      if (want !== shift) { attrs.dy = (want - shift) * size; shift = want; }
      if (on.has('b')) attrs['font-weight'] = 700;
      if (on.has('i')) attrs['font-style'] = 'italic';
      const deco = [on.has('u') && 'underline', on.has('s') && 'line-through'].filter(Boolean).join(' ');
      if (deco) attrs['text-decoration'] = deco;
      if (want) attrs['font-size'] = size * 0.7;
      svgEl('tspan', attrs, parent).textContent = parts[i];
    }
    if (i + 2 < parts.length) parts[i + 1] ? on.delete(parts[i + 2]) : on.add(parts[i + 2]);
  }
}

// ponytail: tags are per line (each line is its own <div>), so a tag left open
// at a line end closes there; reopen it on the next line to carry it over.
// el (a note) carries its whole-note formatting into the math too, since
// KaTeX uses its own fonts: bold → \boldsymbol, Helvetica → \mathsf,
// Monospace → \mathtt. The default font keeps classic math type.
function noteTex(tex, el) {
  if (el?.font === 'helvetica') tex = `\\mathsf{${tex}}`;
  else if (el?.font === 'mono') tex = `\\mathtt{${tex}}`;
  return el?.bold ? `\\boldsymbol{${tex}}` : tex;
}

// One line as HTML: $…$ through KaTeX, inline tags kept, everything else escaped.
export const inlineHTML = (line, el) => line.split(/\$([^$]+)\$/)
  .map((part, i) => i % 2 ? katexHTML(noteTex(part, el))
    : esc(part).replace(/&lt;(\/?)(b|i|u|s|sup|sub)&gt;/g, '<$1$2>'))
  .join('');

export function richHTML(text, el) {
  return text.split('\n').map(line => inlineHTML(line, el) || '&nbsp;').map(h => `<div>${h}</div>`).join('');
}

// Measured world-unit sizes of text notes, filled after first paint: [w, h] of
// a rich note's box, or [x0, y0, x1, y1] of a plain note's unrotated text
// relative to its (x, y), so a box survives moving the note.
const richBoxes = new Map();

// A note's alignment anchor. Notes with `anchored` hang off x by their
// alignment — x is the left edge, centre or right edge of every line, so a
// centred caption needs no guessed width. Older notes (no `anchored`) keep x
// as the left edge and align lines within the widest one.
export const anchorFrac = el => (el.anchored ? { center: 0.5, right: 1 }[el.align] || 0 : 0);

// A note's unrotated box: measured once drawn, estimated before that.
function textBox(el) {
  const box = richBoxes.get(el.id);
  if (box?.length === 4) return [el.x + box[0], el.y + box[1], el.x + box[2], el.y + box[3]];
  const top = el.y - el.size * 1.15;
  if (box) { const x0 = el.x - anchorFrac(el) * box[0]; return [x0, top, x0 + box[0], top + box[1]]; }
  const lines = el.text.split('\n');
  const w = el.w || Math.max(...lines.map(l => stripTags(l).length)) * el.size * 0.6;
  const x0 = el.x - anchorFrac(el) * w;
  return [x0, el.y - el.size, x0 + w, el.y - el.size + lines.length * el.size * lhOf(el)];
}
export const textWidth = el => { const b = textBox(el); return b[2] - b[0]; };

// ---- element bounding boxes (world units) ----

export function elementBBox(el) {
  switch (el.type) {
    case 'card': return [el.x, el.y, el.x + el.w, el.y + el.h];
    case 'rect': {
      const m = (el.width ?? 2) + 2;
      if (el.rot) { // the turned corners' box
        const b = bboxOfPts(elOutline(el));
        return [b[0] - m, b[1] - m, b[2] + m, b[3] + m];
      }
      return [el.x - m, el.y - m, el.x + el.w + m, el.y + el.h + m];
    }
    case 'path': case 'ink': case 'aline': {
      const b = bboxOfPts(el.type === 'aline' ? alinePts(el) : el.type === 'path' ? drawnPts(el) : el.pts);
      const m = shownDNA(el) ? diam(el) * 0.75 + 4 : Math.max((el.width ?? 2) + 4 + (el.comb ? el.combLen ?? 6 : 0), el.capSize || 0);
      return [b[0] - m, b[1] - m, b[2] + m, b[3] + m];
    }
    case 'ellipse': {
      const m = (el.width ?? 2) + 2;
      // a turned ellipse's half extents: √(rx²cos² + ry²sin²) across, likewise down
      const a = (el.rot || 0) * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
      const hx = Math.hypot(el.rx * c, el.ry * s), hy = Math.hypot(el.rx * s, el.ry * c);
      return [el.cx - hx - m, el.cy - hy - m, el.cx + hx + m, el.cy + hy + m];
    }
    case 'text': {
      const b = textBox(el);
      if (!el.rotate) return b;
      // rotated (el.rotate degrees, clockwise) about the anchor point (x, y)
      const r = el.rotate * Math.PI / 180, c = Math.cos(r), sn = Math.sin(r);
      return bboxOfPts([[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]].map(([x, y]) =>
        [el.x + (x - el.x) * c - (y - el.y) * sn, el.y + (x - el.x) * sn + (y - el.y) * c]));
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

export function contentBBox(els = state.doc.elements) {
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

// Fill for closed shapes (rect/ellipse/closed line note): a pattern, a color
// ref, or 'none' — plus its opacity (el.fillOpacity) when set.
const fillOf = el => (el.fill ? paintOf(el, resolveColor(el.fill)) : 'none');
const fillAttrs = el => ({ fill: fillOf(el), ...(el.fill && el.fillOpacity !== undefined ? { 'fill-opacity': el.fillOpacity } : {}) });

// A rect/ellipse turned by el.rot degrees about its centre: its body goes in
// a rotated group (the label stays upright outside it).
const shapeCenter = el => (el.type === 'ellipse' ? [el.cx, el.cy] : [el.x + el.w / 2, el.y + el.h / 2]);
const rotGroup = (g, el) => (el.rot ? svgEl('g', { transform: `rotate(${el.rot} ${shapeCenter(el).join(' ')})` }, g) : g);

function strokeAttrs(el) {
  // dotted strokes need round caps or the dots vanish
  const cap = el.dash === 'dotted' ? 'round' : (el.linecap || 'round');
  const attrs = {
    fill: 'none', stroke: resolveColor(el.color), 'stroke-width': el.width ?? 2,
    'stroke-linejoin': cap === 'round' ? 'round' : 'miter', 'stroke-linecap': cap,
  };
  const da = dashArray(el.dash, el.width ?? 2);
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

export const CAPS = ['none', 'arrow', 'hollow', 'vee', 'harpoon', 'barb', 'square', 'circle', 'dot'];
// Caps with a direction, which el.cap0rev / el.cap1rev turn around to point back
// along the line. (Separate from capNflip, which only ever moved a harpoon's
// barb: old documents carry capNflip on arrows too, where it did nothing.)
export const POINTED_CAPS = ['arrow', 'hollow', 'vee', 'barb'];

// End-cap glyph at p pointing along outward unit dir d. `flip` mirrors the
// (one-sided) harpoon barb to the other side of the line; `rev` turns a pointed
// head around. `size` (el.capSize) overrides the stroke-derived head size.
function capGlyph(parent, p, d, cap, color, w, flip, size, rev) {
  if (!cap || cap === 'none') return;
  const s = size || Math.max(7, w * 2.1);
  if (rev && POINTED_CAPS.includes(cap)) d = [-d[0], -d[1]];
  const n = [-d[1], d[0]];
  const P = (a, b) => [p[0] + d[0] * a + n[0] * b, p[1] + d[1] * a + n[1] * b];
  const poly = pts => svgEl('polygon', {
    points: pts.map(q => `${q[0]},${q[1]}`).join(' '), fill: color, stroke: 'none',
  }, parent);
  if (cap === 'arrow') poly([P(s * 0.75, 0), P(-s * 0.55, s * 0.55), P(-s * 0.55, -s * 0.55)]);
  else if (cap === 'hollow') { // open triangle: outlined, filled with the page so the line stops at its base
    poly([P(s * 0.75, 0), P(-s * 0.55, s * 0.55), P(-s * 0.55, -s * 0.55)]).setAttribute('fill', state.doc.bg || '#ffffff');
    const t = parent.lastChild, sw = Math.max(1, Math.min(w, s * 0.16));
    t.setAttribute('stroke', color); t.setAttribute('stroke-width', sw); t.setAttribute('stroke-linejoin', 'miter');
  } else if (cap === 'vee') { // open V / stick head: two strokes meeting at the tip
    svgEl('polyline', {
      points: [P(-s * 0.6, s * 0.6), P(w / 2, 0), P(-s * 0.6, -s * 0.6)].map(q => `${q[0]},${q[1]}`).join(' '),
      fill: 'none', stroke: color, 'stroke-width': w, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
    }, parent);
  } else if (cap === 'barb') { // swept-back barbed head
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
  } else if (cap === 'circle' || cap === 'dot') { // dot: a bigger blob (dye, bead)
    svgEl('circle', { cx: p[0], cy: p[1], r: s * (cap === 'dot' ? 0.75 : 0.42), fill: color, stroke: 'none' }, parent);
  }
}

// ---- element renderers ----
// Each returns { node, divs?, measure? }. divs go in #mathLayer; measure runs
// once after the fresh nodes are attached (rich text needs layout to size its
// hit target).

// The halo behind a label: white, unless the label itself is light (a white
// label on a dark fill), which then gets a dark halo so it still reads.
export function haloOf(color) {
  const m = /^#([0-9a-f]{6})$/i.exec(color || '');
  if (!m) return '#ffffff';
  const [r, g, b] = [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16) / 255)
    .map(c => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.6 ? '#2b2622' : '#ffffff';
}

function haloText(parent, x, y, text, size, color, weight = 500, extra = {}) {
  const t = svgEl('text', {
    x, y, 'font-size': size, 'font-family': FONT, 'font-weight': weight,
    fill: color, stroke: haloOf(color), 'stroke-width': size * 0.28,
    'paint-order': 'stroke', 'stroke-linejoin': 'round', ...extra,
  }, parent);
  appendRuns(t, text, size);
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

// Label look (size, colour, weight). Each key comes from the first of: the
// owner (element or segment) itself, its shared label slot, the document-wide
// default (doc.labelStyle), else the built-in look. Style rides on the slot
// because a slot is one label shown in many places — the panel writes there
// when the owner is on a shared label, so every copy changes together.
export const LABEL_STYLE_KEYS = ['labelSize', 'labelColor', 'labelWeight'];
export function labelStyleOf(owner) {
  const l = owner.label;
  const slot = typeof l === 'string' && l.startsWith('slot:') ? state.doc.labelSlots?.find(s => s.id === l.slice(5)) : null;
  const doc = state.doc.labelStyle || {};
  const o = {};
  for (const k of LABEL_STYLE_KEYS) {
    const v = owner[k] ?? slot?.[k] ?? doc[k];
    if (v !== undefined) o[k] = v;
  }
  return o;
}

// Object/segment label at anchor + user offset. Draggable via data-labelfor.
// Math labels render as overlay divs (pointer-events:none), so they get an
// invisible SVG twin carrying data-labelfor so the same drag machinery moves them.
function drawLabel(g, divs, measures, owner, anchor, opts) {
  if (owner.labelHide) return;
  const text = resolveLabel(owner.label);
  if (!text) return;
  const st = labelStyleOf(owner);
  opts = { ...opts, size: st.labelSize || opts.size, weight: st.labelWeight || 600,
    color: st.labelColor ? resolveColor(st.labelColor) : opts.color };
  const off = owner.labelOff || [0, 0];
  const p = [anchor[0] + off[0], anchor[1] + off[1]];
  if (opts.follow && !hasMath(text)) { contourLabel(g, text, p, opts); return; }
  if (hasMath(text)) {
    const div = document.createElement('div');
    div.className = 'math-label';
    div.dataset.id = opts.id; // export finds the element's math labels by this
    div.style.left = `${p[0]}px`;
    div.style.top = `${p[1]}px`;
    div.style.font = `${opts.weight} ${opts.size}px ${FONT}`;
    div.style.color = opts.color;
    // (a \color inside the math overrides opts.color, so then keep the white halo)
    const halo = text.includes('\\color') ? '#ffffff' : haloOf(opts.color);
    if (halo !== '#ffffff') div.style.textShadow = `0 0 3px ${halo}, 0 0 3px ${halo}, 0 0 4px ${halo}`;
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
  haloText(g, p[0], p[1], text, opts.size, opts.color, opts.weight, {
    'text-anchor': 'middle', 'dominant-baseline': 'middle',
    'data-labelfor': opts.id, ...(opts.segi !== undefined ? { 'data-segi': opts.segi } : {}),
    style: 'cursor:move',
  });
}

// A copy of a polyline shifted sideways by d (along the same normal labelPos uses).
function offsetPolyline(pts, d) {
  const nrm = (a, b) => { const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; return [(b[1] - a[1]) / l, -(b[0] - a[0]) / l]; };
  return pts.map((p, i) => {
    const n0 = i > 0 && nrm(pts[i - 1], p), n1 = i < pts.length - 1 && nrm(p, pts[i + 1]);
    const n = n0 && n1 ? [n0[0] + n1[0], n0[1] + n1[1]] : n0 || n1;
    const l = Math.hypot(n[0], n[1]) || 1;
    return [p[0] + n[0] / l * d, p[1] + n[1] / l * d];
  });
}

// A label that follows its strand (el.labelsFollow): the text rides a copy of the
// strand's path (opts.follow) set off by the label's distance from it, centred,
// so it bends with the strand. Dragging the label moves that distance. Math
// labels are HTML overlays and stay straight. The path is smoothed over about a
// letter height either way (a zigzag domain gives a calm line, a corner a
// curve) and runs on past both ends, so text longer than its domain spills over
// instead of being cut off. It reads left to right where the text sits.
function contourLabel(g, text, p, opts) {
  // two passes: one leaves ripples that the sideways offset blows up into loops
  const pts = smoothPolyline(smoothPolyline(opts.follow, opts.size), opts.size);
  const L = polylineLength(pts), m = pointAt(pts, L / 2);
  const a = pointAt(pts, Math.max(0, L / 2 - 4)), b = pointAt(pts, L / 2 + 4);
  const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  const d = ((p[0] - m[0]) * (b[1] - a[1]) - (p[1] - m[1]) * (b[0] - a[0])) / l;
  const tl = stripTags(text).length * opts.size * 0.6; // ponytail: estimated text length
  const c0 = pointAt(pts, Math.max(0, L / 2 - tl / 2)), c1 = pointAt(pts, Math.min(L, L / 2 + tl / 2));
  let line = extendPolyline(offsetPolyline(pts, d), tl);
  if (c1[0] - c0[0] < -1e-6) line = line.reverse(); // read left to right
  const id = `lp-${opts.id}-${opts.segi ?? 'el'}`;
  svgEl('path', { id, d: 'M' + line.map(q => `${q[0]} ${q[1]}`).join(' L'), fill: 'none', stroke: 'none' }, g);
  const t = haloText(g, 0, 0, '', opts.size, opts.color, opts.weight, {
    'text-anchor': 'middle', 'dominant-baseline': 'middle',
    'data-labelfor': opts.id, ...(opts.segi !== undefined ? { 'data-segi': opts.segi } : {}),
    style: 'cursor:move',
  });
  t.textContent = '';
  appendRuns(svgEl('textPath', { href: `#${id}`, startOffset: '50%' }, t), text, opts.size);
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
  const P = drawnPts(el); // the smooth curve's samples, or the vertices
  const pts = ptsAttr(P);
  const w = el.width ?? 2;
  const color = resolveColor(el.color);
  const dna = shownDNA(el), seq = seqStrand(el), plain = !dna && !seq;
  const hitW = dna ? Math.max(12, diam(el)) : Math.max(12, w + 8);
  // inside a duplex a strand doesn't catch clicks: the duplex does (click it
  // again for its strands), so what you click is what you see
  const runs = dna ? dnaRuns(el, dnaLayout(el)) : [{ t0: 0, t1: Infinity }];
  const unpaired = (t0, t1) => runs.some(r => (t0 + t1) / 2 >= r.t0 && (t0 + t1) / 2 <= r.t1);
  for (const r of runs) {
    svgEl('polyline', {
      points: dna ? ptsAttr(subPath(P, r.t0, r.t1)) : pts,
      fill: 'none', stroke: 'transparent', 'stroke-width': hitW, 'data-hit': '1',
    }, g);
  }
  const under = dna ? drawDNAStrand(g, el) : null;
  if (seq) drawSeqStrand(g, el);
  // a segment thinner than its strand would show the strand as an outline round it
  const thin = plain ? (el.segments || []).filter(sg => segWidth(sg, w) < w) : [];
  if (plain) svgEl('path', { d: el.smooth ? smoothD(el.pts) : roundedPathD(el.pts, el.corner || 0), ...strokeAttrs(el), stroke: paintOf(el, color),
    ...(thin.length ? { mask: underMask(g, el, thin, w) } : {}) }, g);
  const len = polylineLength(P);
  const labelOff = dna ? diam(el) / 2 + 9 : 16;
  (el.segments || []).forEach((seg, i) => {
    const sp = subPath(P, seg.t0, seg.t1);
    const sa = ptsAttr(sp);
    const segColor = resolveColor(seg.color);
    const scap = seg.linecap || 'round';
    if (unpaired(seg.t0, seg.t1)) {
      svgEl('polyline', {
        points: sa, fill: 'none', stroke: 'transparent', 'stroke-width': hitW, 'data-hit': '1', 'data-seg': i,
      }, g);
    }
    if (plain) svgEl('path', {
      d: roundedPathD(sp, el.smooth ? 0 : el.corner || 0), fill: 'none', stroke: paintOf(seg, segColor),
      'stroke-width': segWidth(seg, w),
      'stroke-linejoin': scap === 'round' ? 'round' : 'miter', 'stroke-linecap': scap, 'data-seg': i,
    }, g);
    drawLabel(g, divs, measures, seg, labelPos(P, (seg.t0 + seg.t1) / 2, labelOff, 1),
      { size: 12, color: segColor, id: el.id, segi: i, follow: el.labelsFollow && sp });
  });
  if (plain && el.ticks) { // a short grey dash across the strand at each domain junction
    const ts = new Set();
    for (const s of el.segments || []) for (const t of [s.t0, s.t1]) if (t > 0.5 && t < len - 0.5) ts.add(+t.toFixed(2));
    for (const t of ts) {
      const [x, y] = pointAt(P, t), a = pointAt(P, Math.max(0, t - 2)), b = pointAt(P, t + 2);
      const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, h = w + 2;
      const nx = (b[1] - a[1]) / l * h, ny = -(b[0] - a[0]) / l * h;
      svgEl('line', { x1: x - nx, y1: y - ny, x2: x + nx, y2: y + ny, stroke: '#8f8f8f', 'stroke-width': Math.max(1, w * 0.45) }, g);
    }
  }
  if (plain && el.comb) drawComb(g, el, w, len);
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
  if (plain) { // a DNA strand ends in its own molecular caps
    capGlyph(g, P[0], endDir(P, 0), el.cap0, c0.paint, c0.w, el.cap0flip, el.capSize, el.cap0rev);
    capGlyph(g, P[P.length - 1], endDir(P, 1), el.cap1, c1.paint, c1.w, el.cap1flip, el.capSize, el.cap1rev);
  } else if (dna && dnaView.ends) { // View → Mark 3′ Ends: a low-key chevron just past the 3' cap
    const d = endDir(P, 1), D = diam(el), z = P[P.length - 1];
    chevron(g, [z[0] + d[0] * (D * 0.55 + 3), z[1] + d[1] * (D * 0.55 + 3)], d, Math.max(2.5, D * 0.22),
      { stroke: c1.paint, 'stroke-width': Math.max(1.2, D * 0.08), opacity: 0.7 });
  }
  drawLabel(g, divs, measures, el, labelPos(P, len / 2, dna ? labelOff - 2 : 14, -1),
    { size: 12.5, color, id: el.id, follow: el.labelsFollow && P });
  return { node: g, divs, measures, under };
}

// A mask hiding a strand's line under the segments thinner than it. Past a
// strand end it runs on a little, so the line's own end cap goes too.
function underMask(g, el, segs, w) {
  const P = drawnPts(el), id = `under-${el.id}`, b = bboxOfPts(P), m = 2 * w + 20, L = polylineLength(P);
  const box = { x: b[0] - m, y: b[1] - m, width: b[2] - b[0] + 2 * m, height: b[3] - b[1] + 2 * m };
  const mask = svgEl('mask', { id, maskUnits: 'userSpaceOnUse', ...box }, g);
  svgEl('rect', { ...box, fill: '#fff' }, mask);
  for (const sg of segs) {
    const sp = subPath(P, sg.t0, sg.t1);
    const past = (end, q) => { const d = endDir(P, end); return [q[0] + d[0] * w, q[1] + d[1] * w]; };
    if (sg.t0 <= 0.5) sp.unshift(past(0, sp[0]));
    if (sg.t1 >= L - 0.5) sp.push(past(1, sp[sp.length - 1]));
    svgEl('path', { d: roundedPathD(sp, el.corner || 0), fill: 'none', stroke: '#000', 'stroke-width': w + 1,
      'stroke-linecap': 'butt', 'stroke-linejoin': 'round' }, mask);
  }
  return `url(#${id})`;
}

// Spans of a strand that base-pair links pair: [[t0, t1]…], as far as their
// rungs reach (a straight-rung link pairs only part of the longer strand).
// ponytail: scans every element per combed strand; index links by strand if docs get big.
function pairedSpans(el) {
  const out = [];
  for (const l of state.doc.elements) {
    const A = l.type === 'link' && l.style === 'bases' && linkStrand(l.a), B = A && linkStrand(l.b);
    if (!B || (l.a.id !== el.id && l.b.id !== el.id)) continue;
    const { n } = rungSeqs(l), rungs = basePairRungs(A, B, n, l.rungAlign);
    for (const [ref, k] of [[l.a, 2], [l.b, 3]]) {
      if (ref.id !== el.id) continue;
      const sp = linkSpan(ref), ts = rungs.map(r => r[k]), h = n > 1 ? (Math.max(...ts) - Math.min(...ts)) / (n - 1) / 2 : (sp.t1 - sp.t0) / 2;
      out.push([sp.t0 + Math.max(0, Math.min(...ts) - h), sp.t0 + Math.min(sp.t1 - sp.t0, Math.max(...ts) + h)]);
    }
  }
  return out.sort((a, b) => a[0] - b[0]);
}

// Base ticks (a comb) along a plain strand's single-stranded stretches, el.comb
// = 'left', 'right' or 'both' sides of its 5′→3′ run: el.combLen long, about one
// per el.combStep (default 6, a base-pair link's default spacing), centred in
// their stretch like rungs, in the colour of the domain under them. Stretches a
// base-pair link pairs are skipped: they have rungs.
function drawComb(g, el, w, L) {
  const P = drawnPts(el), step = el.combStep || 6, tl = el.combLen ?? 6, sides = { left: [1], right: [-1], both: [1, -1] }[el.comb] || [1];
  const runs = [];
  let at = 0;
  for (const [t0, t1] of pairedSpans(el)) { if (t0 > at) runs.push([at, t0]); at = Math.max(at, t1); }
  if (L > at) runs.push([at, L]);
  const ticks = svgEl('g', { 'stroke-width': Math.max(1, w * 0.6), 'stroke-linecap': 'butt' }, g);
  for (const [r0, r1] of runs) {
    const n = Math.round((r1 - r0) / step);
    for (let i = 0; i < n; i++) {
      const t = r0 + (i + 0.5) * (r1 - r0) / n;
      const [x, y] = pointAt(P, t), a = pointAt(P, Math.max(0, t - 1)), b = pointAt(P, Math.min(L, t + 1));
      const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, nx = (b[1] - a[1]) / l, ny = -(b[0] - a[0]) / l; // left of the run
      for (const s of sides) {
        const o = s * w / 2, e = s * (w / 2 + tl);
        svgEl('line', { x1: x + nx * o, y1: y + ny * o, x2: x + nx * e, y2: y + ny * e, stroke: strandColor(el, t) }, ticks);
      }
    }
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
    'stroke-width': Math.max(12, (el.width ?? 2) + 8), 'data-hit': '1',
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
  const body = rotGroup(g, el);
  svgEl('ellipse', {
    ...base, fill: 'none', stroke: 'transparent',
    'stroke-width': Math.max(12, (el.width ?? 2) + 8), 'data-hit': '1',
  }, body);
  if (el.glow) {
    // a blurred oversized halo, then a bright-cored gradient body on top
    const c = resolveColor(el.fill) || resolveColor(el.color) || '#3ad13a';
    svgEl('ellipse', {
      cx: el.cx, cy: el.cy, rx: el.rx * 1.7, ry: el.ry * 1.7,
      fill: c, 'fill-opacity': 0.55, filter: 'url(#glowBlur)', stroke: 'none',
    }, body);
    svgEl('ellipse', { ...base, fill: glowRef(c), stroke: 'none' }, body);
    drawLabel(g, divs, measures, el, bboxLabelAnchor(el), { size: 12.5, color: resolveColor(el.color), id: el.id });
    return { node: g, divs, measures };
  }
  svgEl('ellipse', { ...base, ...strokeAttrs(el), ...fillAttrs(el) }, body);
  drawLabel(g, divs, measures, el, bboxLabelAnchor(el), { size: 12.5, color: resolveColor(el.color), id: el.id });
  return { node: g, divs, measures };
}

// A stock protein (el.mol, baked by tools/bake_molecules.py): a grayscale
// surface render, tinted, toon-banded and outlined with the DNA brush's filters.
// A DNA-binding protein with a DNA strand across its binding axis is drawn in two
// layers: the whole protein beneath all DNA (layer-back), and only what lies in
// front of the DNA over it — so the strand threads through.
const molFit = (el, m) => {
  const sc = Math.min(el.w / m.w, el.h / m.h); // preserveAspectRatio meet
  return { sc, ox: el.x + (el.w - m.w * sc) / 2, oy: el.y + (el.h - m.h * sc) / 2 };
};
// ponytail: bbox test of every DNA strand against the binding band; a strand
// crossing the protein at an angle also counts — fine for straddling schematics
function molThreaded(el, m) {
  if (!m.front) return false;
  const { sc, ox, oy } = molFit(el, m);
  const y = oy + m.axis * sc, r = DIAMETER_A / 2 * sc;
  return state.doc.elements.some(d => {
    if (d.type !== 'path' || !d.dna) return false;
    const b = elementBBox(d);
    return b[0] < ox + m.w * sc && b[2] > ox && b[1] < y + r && b[3] > y - r;
  });
}

function renderMol(el, m) {
  const g = svgEl('g', { 'data-id': el.id });
  const divs = [], measures = [];
  const filter = tintRef(resolveColor(el.color) || '#8a857c', !!el.dnaToon);
  // outline as thick as a DNA strand's drawn at this molecule's Å scale
  const D = DIAMETER_A * molFit(el, m).sc;
  const layer = (parent, href) => {
    const body = svgEl('g', { filter });
    svgEl('image', { href, x: el.x, y: el.y, width: el.w, height: el.h, preserveAspectRatio: 'xMidYMid meet' }, body);
    if (el.dnaOutline) parent.appendChild(outlineOf(body, D));
    parent.appendChild(body);
  };
  // outlines ride with each layer, not beneath every molecule as DNA's do: a
  // protein sits in front of what it overlaps, and a part (sgRNA) in front of its protein
  let back = null;
  if (molThreaded(el, m)) {
    back = svgEl('g', { 'data-id': el.id });
    layer(back, el.molIcon ? m.icon : m.src);
    layer(g, el.molIcon ? m.iconFront : m.front);
  } else layer(g, el.molIcon ? m.icon : m.src);
  drawLabel(g, divs, measures, el, bboxLabelAnchor(el), { size: 12.5, color: resolveColor(el.color), id: el.id });
  return { node: g, divs, measures, back };
}

function renderRect(el) {
  if (MOLS[el.mol]) return renderMol(el, MOLS[el.mol]);
  const g = svgEl('g', { 'data-id': el.id });
  const divs = [], measures = [];
  const base = { x: el.x, y: el.y, width: el.w, height: el.h, rx: el.r || 0 };
  const body = rotGroup(g, el);
  svgEl('rect', {
    ...base, fill: 'none', stroke: 'transparent',
    'stroke-width': Math.max(12, (el.width ?? 2) + 8), 'data-hit': '1',
  }, body);
  svgEl('rect', { ...base, ...strokeAttrs(el), ...fillAttrs(el) }, body);
  drawLabel(g, divs, measures, el, bboxLabelAnchor(el), { size: 12.5, color: resolveColor(el.color), id: el.id });
  return { node: g, divs, measures };
}

// A line note is straight [a, b], a quadratic curve [a, control, b] (its bend
// handle), or a polyline through 4+ points. el.smooth draws the smooth curve
// through all its points instead; el.closed joins the last back to the first
// (a polygon, which can take a fill).
export const alineQuad = el => el.pts.length === 3 && !el.smooth && !el.closed;
const alineSmooth = el => el.smooth && el.pts.length > 2;
export function alineD(el) {
  const p = el.pts;
  if (alineQuad(el)) { const [a, c, b] = p; return `M${a[0]} ${a[1]} Q${c[0]} ${c[1]} ${b[0]} ${b[1]}`; }
  if (alineSmooth(el)) return smoothD(p, el.closed);
  return `M${p.map(q => q.join(' ')).join(' L')}${el.closed ? ' Z' : ''}`;
}
// Points along the line (for bounding boxes, link outlines and caps).
export function alinePts(el) {
  const pts = el.pts;
  if (alineQuad(el)) {
    const [a, c, b] = pts, q = (t, i) => (1 - t) ** 2 * a[i] + 2 * (1 - t) * t * c[i] + t * t * b[i];
    return Array.from({ length: 17 }, (_, k) => [q(k / 16, 0), q(k / 16, 1)]);
  }
  if (alineSmooth(el)) return smoothPts(pts, el.closed);
  return el.closed ? [...pts, pts[0]] : pts;
}
// The curve's midpoint: where its bend handle sits.
export const alineMid = ([a, c, b]) => b
  ? [(a[0] + 2 * c[0] + b[0]) / 4, (a[1] + 2 * c[1] + b[1]) / 4] : [(a[0] + c[0]) / 2, (a[1] + c[1]) / 2];

function renderALine(el) {
  const g = svgEl('g', { 'data-id': el.id });
  const divs = [], measures = [];
  const a = el.pts[0], b = el.pts[el.pts.length - 1];
  const color = resolveColor(el.color);
  const d = alineD(el), P = alinePts(el);
  // a filled polygon is clickable inside too
  svgEl('path', {
    d, fill: el.closed && el.fill ? 'transparent' : 'none', stroke: 'transparent',
    'stroke-width': Math.max(12, (el.width ?? 2) + 8), 'data-hit': '1',
  }, g);
  svgEl('path', { d, ...strokeAttrs(el), ...(el.closed ? fillAttrs(el) : {}), ...(el.noStroke ? { stroke: 'none' } : {}) }, g);
  if (!el.closed) { // a closed outline has no ends to cap
    const T = alineQuad(el) ? el.pts : P; // a quadratic's end tangents point exactly at its control point
    capGlyph(g, a, endDir(T, 0), el.cap0, color, el.width ?? 2, el.cap0flip, el.capSize, el.cap0rev);
    capGlyph(g, b, endDir(T, 1), el.cap1, color, el.width ?? 2, el.cap1flip, el.capSize, el.cap1rev);
  }
  drawLabel(g, divs, measures, el, bboxLabelAnchor(el), { size: 12.5, color, id: el.id });
  return { node: g, divs, measures };
}

function renderText(el) {
  const g = svgEl('g', { 'data-id': el.id });
  if (el.rotate) g.setAttribute('transform', `rotate(${el.rotate} ${el.x} ${el.y})`);
  const color = resolveColor(el.color), k = anchorFrac(el);
  if (isRichText(el)) {
    const top = el.y - el.size * 1.15;
    const div = document.createElement('div');
    div.className = 'math-note';
    div.style.left = `${el.x}px`;
    div.style.top = `${top}px`;
    Object.assign(div.style, textStyle(el));
    div.style.color = color;
    if (k || el.rotate) { // hang off the anchor, and turn about it like the SVG twin
      div.style.transformOrigin = `${k * 100}% ${el.size * 1.15}px`;
      div.style.transform = `translateX(${-k * 100}%) rotate(${el.rotate || 0}deg)`;
    }
    div.style.width = el.w ? `${el.w}px` : 'max-content';
    div.innerHTML = richHTML(el.text, el);
    // invisible SVG twin so clicks and marquees still find the note
    const hit = svgEl('rect', {
      x: el.x, y: top, width: el.w || el.size, height: el.size * 1.3,
      fill: 'transparent', 'data-hit': '1',
    }, g);
    const measure = () => {
      const w = el.w || div.offsetWidth, h = div.offsetHeight || el.size * 1.3;
      richBoxes.set(el.id, [w, h]);
      hit.setAttribute('x', el.x - k * w);
      hit.setAttribute('width', w);
      hit.setAttribute('height', h);
    };
    return { node: g, divs: [div], measure };
  }
  const t = svgEl('text', {
    x: el.x, y: el.y, 'font-size': el.size, 'font-family': fontOf(el),
    'font-weight': el.bold ? 700 : 400, 'font-style': el.italic ? 'italic' : 'normal',
    fill: color, 'data-role': 'text-body', ...(decoOf(el) ? { 'text-decoration': decoOf(el) } : {}),
    ...(k ? { 'text-anchor': k === 1 ? 'end' : 'middle' } : {}),
  }, g);
  const spans = el.text.split('\n').map((line, i) => {
    const span = svgEl('tspan', { x: el.x, y: el.y + i * el.size * lhOf(el) }, t);
    appendRuns(span, line, el.size);
    return span;
  });
  // the real ink box, so Fit and the selection frame the note as drawn
  const fit = () => {
    const b = t.getBBox();
    if (b.width) richBoxes.set(el.id, [b.x - el.x, b.y - el.y, b.x + b.width - el.x, b.y + b.height - el.y]);
  };
  if (el.anchored || !el.align || el.align === 'left' || spans.length < 2) return { node: g, measure: fit };
  // old centre/right: shift each line within the widest one (needs layout to measure)
  const measure = () => {
    const ws = spans.map(sp => sp.getComputedTextLength());
    const max = Math.max(...ws), f = el.align === 'center' ? 0.5 : 1;
    spans.forEach((sp, i) => sp.setAttribute('x', el.x + (max - ws[i]) * f));
    fit();
  };
  return { node: g, measure };
}

// ---- links (filled area spanning two objects/segments/groups) ----

// Boundary points of one element, in world units.
function elOutline(el) {
  switch (el.type) {
    case 'path': return drawnPts(el);
    case 'ink': return el.pts;
    case 'aline': return alinePts(el);
    case 'ellipse': return ellipsePoints(el.cx, el.cy, el.rx, el.ry).map(p => rotatePt(p, [el.cx, el.cy], el.rot));
    case 'rect': case 'card':
      return [[el.x, el.y], [el.x + el.w, el.y], [el.x + el.w, el.y + el.h], [el.x, el.y + el.h]]
        .map(p => rotatePt(p, shapeCenter(el), el.rot));
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
  if ((ref.seg !== undefined && el.segments?.[ref.seg]) || hasRange(ref)) return linkStrand(ref) || elOutline(el);
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
  const sp = linkSpan(ref);
  if (!sp) return null;
  return sp.whole ? strandPts(sp.el) : subPath(strandPts(sp.el), sp.t0, sp.t1);
}
// The points a strand-like element is drawn along (a smooth curve's samples).
const strandPts = el => (el.type === 'path' ? drawnPts(el) : el.type === 'aline' ? alinePts(el) : el.pts);
// A link end may pair only part of its domain (or line): ref.f0..ref.f1, as
// fractions of it from its start (unset = 0..1).
export const hasRange = ref => ref?.f0 !== undefined || ref?.f1 !== undefined;
const narrow = (ref, t0, t1) => [t0 + (ref.f0 ?? 0) * (t1 - t0), t0 + (ref.f1 ?? 1) * (t1 - t0)];
// The stretch of its strand a link end runs along: { el, t0, t1, whole }, or null.
export function linkSpan(ref) {
  const el = ref && !ref.group && byId(ref.id);
  if (!el || !['path', 'aline', 'ink'].includes(el.type)) return null;
  const s = ref.seg !== undefined && el.segments?.[ref.seg];
  const [t0, t1] = narrow(ref, s ? s.t0 : 0, s ? s.t1 : polylineLength(strandPts(el)));
  return { el, t0, t1, whole: !s && !hasRange(ref) };
}

// ---- DNA strands (lines with .dna set, drawn by the DNA brush) ----
// el.dna is true (follow the document's DNA grid) or an explicit diameter in
// world units. The grid — doc.dnaBpg bases per grid square — sets every auto
// base count, and the diameter that looks natural at that spacing.

export const dnaBpg = () => state.doc.dnaBpg || DEFAULT_BPG;
// How strands are drawn: 'own' follows each strand's Draw as (el.seqLook →
// its letters, el.dna → a molecule, else its line); 'line', 'dna' and 'seq'
// draw every strand that way (View → Draw Strands). Display only: the
// document keeps each strand's own setting.
export const strandView = { mode: 'own' };
export const lookOf = el => {
  if (el.type !== 'path') return 'line';
  if (strandView.mode !== 'own') return strandView.mode;
  return el.seqLook ? 'seq' : el.dna ? 'dna' : 'line';
};
export const seqStrand = el => lookOf(el) === 'seq';
const shownDNA = el => lookOf(el) === 'dna';
// View → Mark 3′ Ends (display only).
export const dnaView = { ends: false };
// a plain line shown as a molecule by View → Draw Strands looks like a new one: toon + outline
const toon = el => (el.dna ? !!el.dnaToon : true);
const outlined = el => (el.dna ? !!el.dnaOutline : true);
export const diam = el => (typeof el.dna === 'number' ? el.dna : naturalD(dnaBpg()));

const dnaEnd = ref => {
  const e = ref && !ref.group && byId(ref.id);
  return e?.type === 'path' && shownDNA(e) ? e : null;
};
// A base-pair link between two DNA strands draws as one double helix.
export const duplexLink = l => l.type === 'link' && l.style === 'bases' && !!dnaEnd(l.a) && !!dnaEnd(l.b);
// The sequence a link end carries (U read as T): its segment's, or for a whole
// line, all its segments' joined when they tile it end to end, else the
// strand's own Sequence.
export function refSeq(ref, e) {
  if (!e) return '';
  const q = ref.seg !== undefined ? seqOf(e.segments?.[ref.seg]?.string) : lineSeq(e) || seqLetters(e.seq);
  const [i, j] = narrow(ref, 0, q.length).map(Math.round);
  return q.slice(i, j).replace(/U/g, 'T');
}
function lineSeq(e) {
  const segs = (e.segments || []).slice().sort((a, b) => a.t0 - b.t0);
  let at = 0, seq = '';
  for (const s of segs) {
    const q = seqOf(s.string);
    if (!q || s.t0 - at > 0.5) return '';
    seq += q; at = s.t1;
  }
  return segs.length && polylineLength(drawnPts(e)) - at <= 0.5 ? seq : '';
}
const refSpan = (ref, e) => {
  const s = ref.seg !== undefined && e.segments?.[ref.seg];
  return narrow(ref, ...(s ? [s.t0, s.t1] : [0, polylineLength(drawnPts(e))]));
};
// The duplex's base pairs: a paired domain's sequence length, else the link's
// own count, else the grid's count.
export function duplexBases(l) {
  const A = dnaEnd(l.a), B = dnaEnd(l.b);
  const seq = refSeq(l.a, A) || refSeq(l.b, B);
  if (seq) return seq.length;
  if (l.bases) return l.bases;
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
  // a domain's sequence fixes its count (a short String like "a" is a name, not
  // bases — see seqOf), else the domain's own count
  for (const s of el.segments || []) {
    const count = seqOf(s.string).length || s.bases;
    if (count) fixed.push({ t0: s.t0, t1: s.t1, count });
  }
  return fixed;
}
// A strand's own count, else its sequence's: the free bases are what the
// sequence leaves after the fixed spans.
export function dnaLayout(el) {
  const L = polylineLength(drawnPts(el)), pitch = gridPitch(dnaBpg()), fixed = dnaFixed(el);
  const lay = strandLayout(L, pitch, fixed, el.bases);
  const seq = seqLetters(el.seq).length;
  if (el.bases !== undefined || !seq || !lay.freeLen) return lay;
  return strandLayout(L, pitch, fixed, Math.max(0, seq - (lay.n - lay.free)));
}

// Letter of strand e at base index i (as written: U and N kept): its domain's
// sequence where one covers i, else the strand's own, else ''.
function seqAt(e, lay, i) {
  for (const s of e.segments || []) {
    const seq = seqOf(s.string);
    if (!seq) continue;
    const j = i - Math.round(uAt(lay.knots, s.t0));
    if (j >= 0 && j < Math.round(uAt(lay.knots, s.t1) - uAt(lay.knots, s.t0))) return seq[j % seq.length];
  }
  return seqLetters(e.seq)[i] || '';
}

// The unpaired stretches of a strand: [{ t0, t1, before, after }], with the
// paired spans (duplexes) they run on from / into.
function dnaRuns(el, lay) {
  const L = polylineLength(drawnPts(el)), runs = [];
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

// Base letter of strand e at base index i for the molecule's colours (U read
// as T), or null where none is known. A whole-line sequence (segments tiling
// the line) is read straight through when the strand has exactly that many
// bases — a duplex over the whole line spaces its bases evenly, not per segment.
function baseLetter(e, lay, i) {
  const line = lineSeq(e);
  const b = (line.length === lay.n ? line[i] : seqAt(e, lay, i)) || '';
  return b && b !== 'N' ? b.replace('U', 'T') : null;
}
const baseColor = e => resolveColor(e.baseColor) || '#f1ece2';
// Colour of a base whose letter is unknown: the strand's base colour, or a fixed
// random base (placeholder / UMI look). `rand` is the letter to use for that.
const unknownBase = (e, rand) => (e.seqUnknown === 'random' ? BASE_COLORS[rand] : baseColor(e));
const letterColor = (letter, e, rand) => (letter ? BASE_COLORS[letter] : unknownBase(e, rand));

// A strand's paint layers on texture `tex` ('ss', 'ssB', 'ds1'…): the whole
// strand in its colour, then its bases per its colour mode. seqColor(i) is the
// colour of the base in the brush's base slot i, in sequence mode.
function strandLayers(e, tex, btex, tOf, seqColor) {
  const layers = tex ? [{ tex, colorAt: t => strandColor(e, tOf(t)) }] : [];
  if (e.dnaColor === 'bases') layers.push({ tex: btex, colorAt: () => baseColor(e) });
  if (e.dnaColor === 'sequence') layers.push({ tex: btex, base: true, colorAt: (t, i) => seqColor(i) });
  return layers;
}

// A duplex's shape: the midline between its two strands' paired spans.
function duplexGeom(l) {
  const A = dnaEnd(l.a), B = dnaEnd(l.b);
  const [a0, a1] = refSpan(l.a, A), [b0, b1] = refSpan(l.b, B);
  const mid = midline(subPath(drawnPts(A), a0, a1), subPath(drawnPts(B), b0, b1), a1 - a0, b1 - b0, pointAt);
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

// Draws the strand into g; returns its outline node (or null), which the
// caller layers under all molecules.
function drawDNAStrand(g, el) {
  const D = diam(el), lay = dnaLayout(el), P = drawnPts(el);
  const target = svgEl('g', {}, g);
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
    verts.push({ p: pointAt(P, t0 + dS), t: t0 + dS });
    let acc = 0;
    for (let i = 1; i < P.length - 1; i++) {
      acc += Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]);
      if (acc > t0 + dS && acc < t1 - dE) verts.push({ p: P[i], t: acc });
    }
    verts.push({ p: pointAt(P, t1 - dE), t: t1 - dE });
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
      knots: knots.map(([t, u]) => [t * sgn, u]), D, caps, toon: toon(el), skin: el.dnaSkin,
      layers: strandLayers(el, tex, `${tex}b`, tOf, i => {
        const j = strandIndex(i);
        return letterColor(baseLetter(el, lay, j), el, randomBase(el.id, j));
      }),
      breaks: (el.segments || []).flatMap(s => [s.t0 * sgn, s.t1 * sgn]),
    });
  }
  return outlined(el) ? outlineOf(target, D) : null;
}

// A strand in sequence view: one letter per base at its place along the line,
// turned to the line but kept upright (on a run steeper than 60° they stand
// unturned, stacked). Letters keep their natural size (times el.seqScale) on a
// stretched strand and shrink on a compressed one; a strand whose sequence
// doesn't match its drawn length says by how many bases at its 3′ end.
// The plain line stands in when zoomed out too far to read (renderNow's data-seq).
function drawSeqStrand(g, el) {
  const P = drawnPts(el), lay = dnaLayout(el), pitch = gridPitch(dnaBpg()), L = polylineLength(P), k = el.seqScale || 1; // letter size
  svgEl('polyline', { class: 'seq-far', points: ptsAttr(P), fill: 'none', stroke: resolveColor(el.color),
    'stroke-width': el.width ?? 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, g);
  const near = svgEl('g', { class: 'seq-near', 'font-family': 'ui-monospace, Menlo, Consolas, monospace',
    'font-weight': 600, 'text-anchor': 'middle', 'dominant-baseline': 'central' }, g);
  // the ghost trace: a faint band behind the letters, broken at every base boundary
  const trace = svgEl('g', { fill: 'none', 'stroke-opacity': 0.16, 'stroke-linecap': 'butt', 'stroke-linejoin': 'round' }, near);
  for (let i = 0; i < lay.n; i++) {
    const t0 = tAt(lay.knots, i), t1 = tAt(lay.knots, i + 1), gap = Math.min((t1 - t0) * 0.1, pitch * 0.12);
    svgEl('polyline', { points: ptsAttr(subPath(P, t0 + gap, t1 - gap)), stroke: strandColor(el, (t0 + t1) / 2),
      'stroke-width': +(Math.min(t1 - t0, pitch) * 1.3 * k).toFixed(2) }, trace); // as tall as its letter
  }
  for (let i = 0; i < lay.n; i++) {
    const t0 = tAt(lay.knots, i), t1 = tAt(lay.knots, i + 1), t = (t0 + t1) / 2;
    const [x, y] = pointAt(P, t), a = pointAt(P, t - 0.01), b = pointAt(P, t + 0.01);
    let deg = Math.atan2(b[1] - a[1], b[0] - a[0]) * 180 / Math.PI;
    if (deg > 90.5 || deg <= -89.5) deg += 180; // upright: leftward and upward runs read flipped
    if (Math.abs(deg) > 60) deg = 0; // a steep run stacks its letters upright
    const ch = seqAt(el, lay, i);
    const fill = el.dnaColor === 'sequence' && BASE_COLORS[ch.replace('U', 'T')] || strandColor(el, t);
    svgEl('text', { x: 0, y: 0, 'font-size': +(Math.min(t1 - t0, pitch) * 1.6 * k).toFixed(2), fill,
      transform: `translate(${+x.toFixed(2)} ${+y.toFixed(2)}) rotate(${+deg.toFixed(1)})` }, near)
      .textContent = ch || '·';
  }
  const off = lay.n - naturalBases(L, pitch);
  if (off) {
    const d = endDir(P, 1), z = P[P.length - 1];
    svgEl('text', { x: z[0] + d[0] * pitch * 1.5, y: z[1] + d[1] * pitch * 1.5, 'font-size': pitch * 1.2, 'font-weight': 600,
      'text-anchor': d[0] < -0.5 ? 'end' : d[0] > 0.5 ? 'start' : 'middle', 'dominant-baseline': 'central',
      fill: '#b5561d' }, g)
      .textContent = `${off > 0 ? '+' : '−'}${Math.abs(off)} nt`;
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
  // pair slot i: A's base uA0 + i, and B's partner (B read back to front when
  // drawn antiparallel). Each side shows its own letter, else its partner's
  // complement; unknown pairs share one random pair so they still match.
  const layA = dnaLayout(A), uA0 = Math.round(uAt(layA.knots, a0));
  const layB = dnaLayout(B), uB0 = Math.round(uAt(layB.knots, b0)), uB1 = Math.round(uAt(layB.knots, b1));
  const la = i => baseLetter(A, layA, uA0 + i);
  const lb = i => baseLetter(B, layB, mid.rev ? uB1 - 1 - i : uB0 + i);
  const rand = i => randomBase(A.id, uA0 + i);
  const layers = [
    { tex: 'ds', colorAt: t => strandColor(B, tB(t)) },
    { tex: 'ds1', colorAt: t => strandColor(A, tA(t)) },
    ...strandLayers(A, null, 'dsbA', tA, i => letterColor(la(i) || COMPLEMENT[lb(i)], A, rand(i))),
    ...strandLayers(B, null, 'dsbB', tB, i => letterColor(lb(i) || COMPLEMENT[la(i)], B, COMPLEMENT[rand(i)])),
  ];
  const body = svgEl('g', {}, g);
  drawBrush(body, {
    path: brushPath(mid.pts, fillet(D)), knots: [[0, 0], [Lm, n]], D, layers, breaks,
    caps: { head: true, tail: true }, toon: toon(A) || toon(B), skin: A.dnaSkin || B.dnaSkin,
  });
  return outlined(A) || outlined(B) ? outlineOf(body, D) : null;
}

// Everything a DNA strand's or duplex's pixels depend on beyond its own JSON.
function dnaKey(el) {
  const links = el.type === 'link' ? [el] : dnaFixed(el).filter(f => f.link).map(f => f.link);
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
    if (duplexLink(el)) return { node: g, under: drawDuplex(g, el) };
    const color = resolveColor(el.fill) || '#2b2622';
    const { n, sa, sb } = rungSeqs(el);
    const rungs = basePairRungs(A, B, n, el.rungAlign);
    // by sequence: each half of a rung is its strand's base (or the partner's
    // complement); bases known on neither side keep the link's colour.
    // by strands: each half takes the colour of the strand (domain) it meets.
    const byseq = el.rungColor === 'sequence', bystrand = el.rungColor === 'strands';
    const spA = linkSpan(el.a), spB = linkSpan(el.b);
    const half = (mine, other) => BASE_COLORS[mine || COMPLEMENT[other]] || color;
    // a strand drawn as letters keeps its rungs clear of them
    const clear = sp => (seqStrand(sp.el) ? gridPitch(dnaBpg()) * 0.8 * (sp.el.seqScale || 1) : 0);
    const clearA = clear(spA), clearB = clear(spB);
    rungs.forEach(([p, q, ta, tb], i) => {
      const x = sa[i], y = sb[rungs.rev ? n - 1 - i : i];
      const ca = byseq ? half(x, y) : bystrand ? strandColor(spA.el, spA.t0 + ta) : color;
      const cb = byseq ? half(y, x) : bystrand ? strandColor(spB.el, spB.t0 + tb) : color;
      if (el.rung === 'dot') { // one dot midway: a base pair in dotted duplex notation
        svgEl('circle', { cx: (p[0] + q[0]) / 2, cy: (p[1] + q[1]) / 2, r: el.rungSize || 1.6, fill: ca }, g);
        return;
      }
      // 'tick': alignment-style dash, a quarter of the gap clear of each strand
      const k = el.rung === 'tick' ? 0.25 : 0;
      const len = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
      const k0 = Math.max(k, clearA / len), k1 = Math.min(1 - k, 1 - clearB / len);
      if (k0 >= k1) return;
      const at = f => [p[0] + (q[0] - p[0]) * f, p[1] + (q[1] - p[1]) * f];
      const seg = (f0, f1, stroke) => {
        const [x1, y1] = at(f0), [x2, y2] = at(f1);
        svgEl('line', { x1, y1, x2, y2, stroke, 'stroke-width': el.rungWidth ?? 1.5, 'stroke-linecap': 'butt' }, g);
      };
      const m = Math.min(k1, Math.max(k0, 0.5));
      if (ca === cb) seg(k0, k1, ca);
      else { seg(k0, m, ca); seg(m, k1, cb); }
    });
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

// A base-pair link's rung count and its two strands' letters (null = unknown):
// a sequence on either end sets the count, else the link's own, else ~6 px each.
export function rungSeqs(l) {
  const ea = byId(l.a.id), eb = byId(l.b.id);
  const qa = refSeq(l.a, ea), qb = refSeq(l.b, eb);
  const n = qa.length || qb.length || l.bases || defaultBases(linkStrand(l.a), linkStrand(l.b));
  const letters = q => Array.from({ length: n }, (_, i) => (q[i] && q[i] !== 'N' ? q[i] : null));
  return { n, sa: letters(qa), sb: letters(qb), fromSeq: !!(qa || qb) };
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
  if (state.doc.labelStyle) key += JSON.stringify(state.doc.labelStyle); // document-wide label look
  if (key.includes('"hollow"')) key += state.doc.bg; // hollow heads are filled with the page
  if (el.type === 'arrow') {
    const a = byId(el.from), b = byId(el.to);
    key += a && b ? `|${a.x},${a.y},${a.w},${a.h}|${b.x},${b.y},${b.w},${b.h}` : '|x';
  }
  // links trace live geometry: rekey when either endpoint's outline moves
  if (el.type === 'link') key += '|' + ptsAttr([...linkTargetPoints(el.a), ...linkTargetPoints(el.b)]);
  // base-pair rungs also count and colour by the strands' sequences
  if (el.type === 'link' && el.style === 'bases') key += `|${refSeq(el.a, byId(el.a.id))}|${refSeq(el.b, byId(el.b.id))}`;
  // …and may take the strands' colours, and keep clear of their letters
  if (el.type === 'link' && el.style === 'bases') {
    const ends = [byId(el.a.id), byId(el.b.id)];
    if (el.rungColor === 'strands' || ends.some(e => e && seqStrand(e))) key += JSON.stringify(ends) + dnaBpg();
  }
  // DNA strands and duplexes depend on each other (shape, counts, colours) and the DNA grid
  if (shownDNA(el) || (el.type === 'link' && duplexLink(el))) key += dnaKey(el);
  if (seqStrand(el)) key += '|seq' + dnaBpg();
  if (el.comb && lookOf(el) === 'line') key += JSON.stringify(pairedSpans(el));
  if (MOLS[el.mol]) key += molThreaded(el, MOLS[el.mol]);
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

// An open chevron at p pointing along unit dir d, arms `r` long.
function chevron(parent, p, d, r, attrs) {
  const n = [-d[1], d[0]];
  const q = (a, b) => `${p[0] + d[0] * a + n[0] * b},${p[1] + d[1] * a + n[1] * b}`;
  return svgEl('polyline', { points: [q(-r * 0.6, r), q(r * 0.4, 0), q(-r * 0.6, -r)].join(' '), fill: 'none',
    'stroke-linecap': 'round', 'stroke-linejoin': 'round', ...attrs }, parent);
}

// A selected DNA strand's 5'→3' sense (its points run 5' → 3'): chevrons along
// the line and 5′ / 3′ at its ends, haloed so they read over the molecule.
function polarityGhost(overlay, el, s, color = SEL) {
  const P = drawnPts(el), len = polylineLength(P), step = 48 / s, r = 5 / s;
  const off = diam(el) * 0.6 + 8 / s;
  for (const w of [[4.5 / s, '#ffffff', 0.9], [1.75 / s, color, 1]]) {
    const at = { stroke: w[1], 'stroke-width': w[0], opacity: w[2] };
    for (let t = (len % step) / 2 || step / 2; t < len; t += step) {
      const a = pointAt(P, Math.max(0, t - 1)), b = pointAt(P, Math.min(len, t + 1));
      const d = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      chevron(overlay, pointAt(P, t), [(b[0] - a[0]) / d, (b[1] - a[1]) / d], r, at);
    }
  }
  for (const end of [0, 1]) {
    const p = P[end ? P.length - 1 : 0], d = endDir(P, end);
    svgEl('text', {
      x: p[0] + d[0] * off, y: p[1] + d[1] * off, 'font-size': 12 / s, 'font-weight': 700,
      'text-anchor': 'middle', 'dominant-baseline': 'central', fill: color,
      stroke: '#ffffff', 'stroke-width': 3 / s, 'paint-order': 'stroke',
    }, overlay).textContent = end ? '3′' : '5′';
  }
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
        points: ptsAttr(subPath(drawnPts(el), seg.t0, seg.t1)), fill: 'none',
        stroke: SEL, 'stroke-width': segWidth(seg, el.width ?? 2) + 9 / s, opacity: 0.35,
        'stroke-linecap': 'round', 'stroke-linejoin': 'round',
      }, overlay);
      // draggable segment boundaries
      if (single) {
        const p0 = pointAt(drawnPts(el), seg.t0), p1 = pointAt(drawnPts(el), seg.t1);
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
          points: ptsAttr(drawnPts(st)), fill: 'none', stroke: resolveColor(st.color), 'stroke-width': 2 / s,
          'stroke-dasharray': `${6 / s} ${4 / s}`, opacity: 0.9, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
        }, overlay);
        polarityGhost(overlay, st, s, resolveColor(st.color));
      }
    }
    if (el.type === 'path' || el.type === 'ink') {
      const attrs = {
        fill: 'none', stroke: SEL, 'stroke-width': (el.width ?? 2) + 10 / s,
        opacity: 0.3, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
      };
      if (el.type === 'ink') svgEl('path', { d: inkD(el.pts), ...attrs }, overlay);
      else svgEl('polyline', { points: ptsAttr(drawnPts(el)), ...attrs }, overlay);
      if (shownDNA(el)) polarityGhost(overlay, el, s);
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
        const [qx, qy] = el.rot ? rotatePt([hx, hy], shapeCenter(el), el.rot) : [hx, hy]; // a turned shape's corners
        svgEl('rect', {
          x: qx - hs / 2, y: qy - hs / 2, width: hs, height: hs,
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
    // (a line through more points, smooth or closed: a dot on every point)
    const bendable = el.type === 'aline' && (el.pts.length === 2 || alineQuad(el));
    if (el.type === 'aline' && single && state.tool !== 'edit') {
      (bendable ? [0, el.pts.length - 1] : el.pts.map((p, i) => i)).forEach(i =>
        handleDot(overlay, el.pts[i][0], el.pts[i][1], s, { 'data-aend': i, 'data-id': el.id }));
    }
    if (bendable && single && state.tool !== 'edit') {
      // middle handle: drag to bend the line into a curve, back to straight to undo
      const m = alineMid(el.pts);
      svgEl('rect', {
        x: m[0] - 4.5 / s, y: m[1] - 4.5 / s, width: 9 / s, height: 9 / s,
        transform: `rotate(45 ${m[0]} ${m[1]})`,
        fill: '#ffffff', stroke: SEL, 'stroke-width': 2 / s,
        'data-abend': '1', 'data-id': el.id, style: 'cursor:move',
      }, overlay);
    }
    // vertex handles for the line-edit tool
    if ((el.type === 'path' || el.type === 'aline') && single && state.tool === 'edit') {
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

// The tick tile: one grid square with a tick at every base along its top and
// left edges (and their copies on the far edges, which the tile clips).
function buildTicks(rect, bpg, pitch) {
  rect.dataset.bpg = String(bpg);
  const pat = $('gridTicks'), h = pitch * 0.35;
  pat.replaceChildren();
  const tick = (x1, y1, x2, y2) => svgEl('line', { x1, y1, x2, y2, stroke: '#cfc8bb', 'stroke-width': pitch * 0.1 }, pat);
  for (let i = 1; i < bpg; i++) {
    const v = i * pitch;
    for (const e of [0, GRID]) { tick(v, e - h, v, e + h); tick(e - h, v, e + h, v); }
  }
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
  // base ticks: one per base along the grid lines, fading in once they're 4px apart
  const pitch = gridPitch(dnaBpg()), ticks = $('gridTickRect');
  if (ticks.dataset.bpg !== String(dnaBpg())) buildTicks(ticks, dnaBpg(), pitch);
  for (const k of ['x', 'y', 'width', 'height']) ticks.setAttribute(k, grid.getAttribute(k));
  ticks.setAttribute('opacity', Math.max(0, Math.min(1, (pitch * s - 4) / 4)));
  // sequence letters: drawn only once they're legible (about 6px)
  $('world').dataset.seq = pitch * s * 1.6 >= 6 ? 'near' : 'far';

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

  // cards sit below everything; all other elements paint in doc order (z-order),
  // except that a link paints just beneath the lower of its two ends when it comes
  // after them: the strands still cover its rung ends, but a shape behind them no
  // longer hides it. Sent further back (Object menu), it stays there.
  const salt = JSON.stringify(state.doc.palette) + JSON.stringify(state.doc.labelSlots || []);
  const cardNodes = [], backNodes = [], underNodes = [], drawNodes = [], divs = [], measures = [];
  const seen = new Set();
  const order = new Map(state.doc.elements.map((el, i) => [el.id, i]));
  const endZ = ref => (ref?.group ? Math.min(...groupElementMembers(ref.group).map(m => order.get(m.id)))
    : order.get(ref?.id) ?? Infinity);
  const zOf = (el, i) => (el.type === 'link' ? Math.min(i, endZ(el.a), endZ(el.b)) - 0.5 : i);
  for (const [i, el] of state.doc.elements.entries()) {
    const renderer = RENDERERS[el.type];
    if (!renderer) continue;
    seen.add(el.id); // keep every live element's cache entry; only cull from the DOM
    if (cull && !onScreen(el) && !selected(el.id)) continue;
    const key = elKey(el, salt);
    let entry = nodeCache.get(el.id);
    if (!entry || entry.key !== key) {
      entry = renderer(el);
      entry.key = key;
      entry.under?.setAttribute('data-id', el.id); // so a selection-only export can drop it
      nodeCache.set(el.id, entry);
      if (entry.measure) measures.push(entry.measure);
      if (entry.measures) measures.push(...entry.measures);
    }
    if (el.type === 'card') cardNodes.push(entry.node);
    else drawNodes.push({ z: zOf(el, i), node: entry.node });
    if (entry.back) backNodes.push(entry.back); // threaded proteins' far side, beneath all DNA
    if (entry.under) underNodes.push(entry.under); // molecule outlines, beneath every molecule
    if (entry.divs) divs.push(...entry.divs);
  }
  for (const id of [...nodeCache.keys()]) {
    if (!seen.has(id)) { nodeCache.delete(id); richBoxes.delete(id); }
  }
  $('layer-cards').replaceChildren(...cardNodes);
  $('layer-back').replaceChildren(...backNodes);
  $('layer-under').replaceChildren(...underNodes);
  $('layer-draw').replaceChildren(...drawNodes.sort((a, b) => a.z - b.z).map(d => d.node));
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
  const fo = svgEl('foreignObject', { // the clone keeps the note's rotate() transform
    x: el.x - anchorFrac(el) * (el.w || box?.[0] || 0), y: el.y - el.size * 1.15,
    width: el.w || box?.[0] || 2000, height: (box?.[1] || 1000) + 4,
    style: 'overflow:visible',
  }, g);
  const div = document.createElement('div');
  div.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
  div.style.cssText = `${cssText(textStyle(el))};color:${resolveColor(el.color)};` +
    `${el.w ? '' : 'width:max-content;'}`;
  div.innerHTML = richHTML(el.text, el);
  fo.appendChild(div);
  return g;
}

// Math labels → foreignObjects where the live overlay draws them (centred on
// their anchor), with the same font, colour and halo — segment labels included.
function exportMathLabel(d) {
  const w = d.offsetWidth, h = d.offsetHeight;
  const fo = svgEl('foreignObject', {
    x: parseFloat(d.style.left) - w / 2, y: parseFloat(d.style.top) - h / 2, width: w, height: h, style: 'overflow:visible',
  });
  const div = document.createElement('div');
  div.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
  div.style.cssText = `white-space:nowrap;font:${d.style.font};color:${d.style.color};` +
    `text-shadow:${d.style.textShadow || '0 0 3px #fff, 0 0 3px #fff, 0 0 4px #fff'}`;
  div.innerHTML = d.innerHTML;
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
// Options: `only` (a Set of ids) exports just those elements, framed to them;
// `grid` draws the dot grid; `transparent` leaves out the background.
export async function exportSVGString({ plain = false, only = null, grid = false, transparent = false } = {}) {
  renderNow(false); // export clones the live layers — force every element in, unculled
  const box = contentBBox(only ? state.doc.elements.filter(el => only.has(el.id)) : undefined);
  if (!box) return null;
  const m = 40;
  const [x0, y0, x1, y1] = [box[0] - m, box[1] - m, box[2] + m, box[3] + m];
  const out = document.createElementNS(NS, 'svg');
  out.setAttribute('xmlns', NS);
  out.setAttribute('viewBox', `${x0} ${y0} ${x1 - x0} ${y1 - y0}`);
  out.setAttribute('width', x1 - x0);
  out.setAttribute('height', y1 - y0);

  const needsMath = !plain && (state.doc.elements.some(el => el.type === 'text' && isRichText(el)) ||
    !!$('mathLayer').querySelector('.math-label'));
  if (needsMath) {
    const css = await katexCSS();
    if (css) {
      const style = svgEl('style', {}, out);
      style.textContent = css;
    }
  }

  if (!transparent) svgEl('rect', { x: x0, y: y0, width: x1 - x0, height: y1 - y0, fill: state.doc.bg || '#ffffff' }, out);
  out.appendChild(document.querySelector('#canvas defs').cloneNode(true));
  if (grid) svgEl('rect', { x: x0, y: y0, width: x1 - x0, height: y1 - y0, fill: 'url(#gridDots)' }, out);
  for (const id of ['layer-cards', 'layer-back', 'layer-under', 'layer-draw']) {
    out.appendChild($(id).cloneNode(true));
  }
  const mathLabels = new Map(); // element id → its math label overlays
  for (const d of $('mathLayer').querySelectorAll('.math-label')) {
    if (!mathLabels.has(d.dataset.id)) mathLabels.set(d.dataset.id, []);
    mathLabels.get(d.dataset.id).push(d);
  }
  for (const el of plain ? [] : state.doc.elements) {
    const clone = out.querySelector(`[data-id="${el.id}"]`);
    if (!clone) continue;
    if (el.type === 'text' && isRichText(el)) {
      clone.replaceChildren(...exportRichText(el).childNodes);
    } else clone.append(...(mathLabels.get(el.id) || []).map(exportMathLabel));
  }
  out.querySelectorAll('[data-hit], [data-ph]').forEach(n => n.remove());
  if (only) out.querySelectorAll('[data-id]').forEach(n => { if (!only.has(n.dataset.id)) n.remove(); });
  return new XMLSerializer().serializeToString(out);
}
