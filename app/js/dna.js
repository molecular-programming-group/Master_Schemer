// DNA brush: a line drawn as a rendered B-DNA molecule, Affinity-style — a fixed
// head cap (5'), a repeating one-turn body, and a tail cap (3') — mapped along
// the line in affine slices. Textures are baked from the Blender library's B-DNA
// model by tools/bake_dna_brush.py; they are grayscale and tinted per piece.
//
// Everything runs in "base units": u = base index along the strand. A strand's
// drawn length and its base count are independent — u(t) is piecewise linear in
// arc length t, so a domain with more bases than fit naturally compresses the
// texture and one with fewer stretches it.
import TEX from './dna-tex.js';

const NS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs, parent) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (parent) parent.appendChild(n);
  return n;
};

// World units per base at natural B-DNA proportions, per unit of diameter.
export const PITCH = TEX.rise / TEX.diameter;
export const DEFAULT_DIAMETER = 20; // one grid: strands drawn a grid apart pair into a duplex that spans them
export const naturalBases = (len, D) => Math.max(1, Math.round(len / (D * PITCH)));
// Spacing relative to natural B-DNA: >1 stretched, <1 compressed.
export const spacing = (len, n, D) => len / Math.max(n, 1e-9) / (D * PITCH);

// A strand's base layout along arc length [0, L].
//   fixed: [{ t0, t1, count, paired }] — base-paired domains and segments with
//          their own count; all other length ("free") shares `freeBases`, or
//          natural spacing when that is unset.
// Returns { knots: [[t, u]...], n, free, freeLen, skips: [[t0, t1]] }; skips
// are the paired spans, drawn by the duplex instead of the strand.
export function strandLayout(L, D, fixed, freeBases) {
  const spans = [];
  for (const f of [...fixed].sort((a, b) => a.t0 - b.t0)) {
    const t0 = Math.max(0, f.t0), t1 = Math.min(L, f.t1);
    if (t1 - t0 < 0.5 || (spans.length && t0 < spans[spans.length - 1].t1 - 0.5)) continue; // overlaps lose
    spans.push({ ...f, t0, t1 });
  }
  const gaps = [];
  let at = 0;
  for (const s of spans) { if (s.t0 - at >= 0.5) gaps.push([at, s.t0]); at = s.t1; }
  if (L - at >= 0.5) gaps.push([at, L]);
  const freeLen = gaps.reduce((a, [g0, g1]) => a + g1 - g0, 0);
  const free = freeLen ? Math.max(0, Math.round(freeBases ?? naturalBases(freeLen, D))) : 0;
  const parts = [
    ...spans.map(s => ({ t0: s.t0, t1: s.t1, count: s.count })),
    ...gaps.map(([t0, t1]) => ({ t0, t1, count: free * (t1 - t0) / freeLen })),
  ].sort((a, b) => a.t0 - b.t0);
  const knots = [[0, 0]];
  let u = 0;
  for (const p of parts) {
    if (p.t0 > knots[knots.length - 1][0]) knots.push([p.t0, u]); // sub-0.5 slivers: no bases
    u += p.count;
    knots.push([p.t1, u]);
  }
  if (knots[knots.length - 1][0] < L) knots.push([L, u]);
  const n = Math.round(u);
  knots[knots.length - 1][1] = n; // free shares are fractional; the total is whole
  return { knots, n, free, freeLen, skips: spans.filter(s => s.paired).map(s => [s.t0, s.t1]) };
}

// Piecewise-linear lookups along a knot list (extrapolating past the ends).
function interp(knots, x, i, j) {
  let k = 1;
  while (k < knots.length - 1 && knots[k][i] < x) k++;
  const a = knots[k - 1], b = knots[k];
  const d = b[i] - a[i];
  return d ? a[j] + (b[j] - a[j]) * (x - a[i]) / d : a[j];
}
export const uAt = (knots, t) => interp(knots, t, 0, 1);
export const tAt = (knots, u) => interp(knots, u, 1, 0);

// The polyline the brush runs along: corners filleted (a DNA molecule can't
// turn on a point), arcs sampled into short chords. Each vertex carries the
// arc length t it corresponds to on the ORIGINAL polyline, so segment bounds
// and base knots (defined on the original) still line up.
export function brushPath(pts, radius) {
  const out = [{ p: pts[0], t: 0 }];
  let T = 0;
  for (let i = 1; i < pts.length; i++) {
    const A = pts[i - 1], V = pts[i];
    const lin = Math.hypot(V[0] - A[0], V[1] - A[1]);
    T += lin;
    const C = pts[i + 1];
    if (!C || lin === 0) { if (lin) out.push({ p: V, t: T }); continue; }
    const lout = Math.hypot(C[0] - V[0], C[1] - V[1]);
    const din = [(V[0] - A[0]) / lin, (V[1] - A[1]) / lin];
    const dout = lout ? [(C[0] - V[0]) / lout, (C[1] - V[1]) / lout] : din;
    const delta = Math.acos(Math.max(-1, Math.min(1, din[0] * dout[0] + din[1] * dout[1])));
    const tt = Math.min(radius * Math.tan(delta / 2), lin / 2, lout / 2);
    if (delta < 1e-3 || tt < 0.5) { out.push({ p: V, t: T }); continue; }
    const P1 = [V[0] - din[0] * tt, V[1] - din[1] * tt], P2 = [V[0] + dout[0] * tt, V[1] + dout[1] * tt];
    const m = Math.max(2, Math.ceil(delta / (Math.PI / 24)));
    for (let k = 0; k <= m; k++) { // quadratic Bézier through the corner: tangent-continuous fillet
      const s = k / m, a = (1 - s) ** 2, b = 2 * s * (1 - s), c = s * s;
      out.push({ p: [a * P1[0] + b * V[0] + c * P2[0], a * P1[1] + b * V[1] + c * P2[1]], t: T - tt + 2 * tt * s, arc: true });
    }
  }
  return out;
}

// Midline of two paired strands, sampled at matching fractions. B is read in
// whichever direction pairs the ends (antiparallel strands drawn running
// opposite ways), the same rule the base-pair rungs use. Collinear runs merge
// so a straight duplex is one piece. Returns { pts, f, rev }.
export function midline(A, B, LA, LB, at, m = 64) {
  const pa = [], pb = [];
  for (let i = 0; i <= m; i++) { pa.push(at(A, LA * i / m)); pb.push(at(B, LB * i / m)); }
  const cost = q => pa.reduce((s, p, i) => s + Math.hypot(p[0] - q[i][0], p[1] - q[i][1]), 0);
  const rb = [...pb].reverse();
  const rev = cost(rb) < cost(pb);
  const qb = rev ? rb : pb;
  const pts = [], f = [];
  pa.forEach((p, i) => {
    const q = [(p[0] + qb[i][0]) / 2, (p[1] + qb[i][1]) / 2];
    if (pts.length >= 2) {
      const a = pts[pts.length - 2], b = pts[pts.length - 1];
      const cross = (b[0] - a[0]) * (q[1] - a[1]) - (b[1] - a[1]) * (q[0] - a[0]);
      if (Math.abs(cross) < 0.05 * Math.hypot(q[0] - a[0], q[1] - a[1])) { pts.pop(); f.pop(); }
    }
    pts.push(q); f.push(i / m);
  });
  return { pts, f, rev };
}

// ---- SVG ----

const defsDone = new Set();
function ensureDefs(id, build) {
  if (defsDone.has(id)) return;
  const defs = document.querySelector('#canvas defs');
  if (!defs) return;
  if (!document.getElementById(id)) defs.appendChild(build());
  defsDone.add(id);
}

const HH = TEX.halfH / TEX.ppb; // texture half-height in base units

// One <pattern> per texture piece, in base units: body repeats every 10 bases;
// a cap pattern is exactly its image, and pieces never reach outside it.
function texRef(layer, part, k) {
  const id = `dna-${layer}-${part}${part === 'tail' ? k : ''}`;
  ensureDefs(id, () => {
    const L = TEX.layers[layer];
    const img = part === 'body' ? { src: L.tile, x: 0, w: 10 } : part === 'head' ? L.head : { ...L.tail[k], x: -TEX.cap };
    const p = el('pattern', { id, patternUnits: 'userSpaceOnUse', x: img.x, y: -HH, width: img.w, height: 2 * HH });
    // pattern content is laid out from the tile's own origin, not user-space 0
    el('image', { href: img.src, x: 0, y: 0, width: img.w, height: 2 * HH, preserveAspectRatio: 'none' }, p);
    return p;
  });
  return `url(#${id})`;
}

// Grayscale → colour: 85% multiply by the colour, 15% the plain shading, so
// even near-black strands keep visible form.
function tintRef(hex) {
  const id = `dna-tint-${hex.replace('#', '')}`;
  ensureDefs(id, () => {
    const f = el('filter', { id, 'color-interpolation-filters': 'sRGB', x: '-5%', y: '-5%', width: '110%', height: '110%' });
    el('feFlood', { 'flood-color': hex }, f);
    el('feComposite', { in2: 'SourceGraphic', operator: 'arithmetic', k1: 0.85, k2: 0, k3: 0.15, k4: 0 }, f);
    return f;
  });
  return `url(#${id})`;
}

// Draw a brush stroke into g.
//   path:   brushPath() vertices ({p, t})
//   knots:  [[t, u]...] base layout over the same t; n = total bases
//   layers: [{ tex: 'ss'|'ds'|'ds1', colorAt: t => '#hex' | null }] — null skips
//   breaks: extra t values where a layer's colour (or skip) changes
//   caps:   { head, tail } — molecular end caps (false where a strand runs on)
export function drawBrush(g, { path, knots, n, D, layers, breaks = [], caps }) {
  if (path.length < 2 || n < 1) return;
  const sy = D * PITCH; // world units per base unit across the strand
  const ov = TEX.layers[layers[0].tex].overhang;
  // caps hang past the end bases (the surface bulges beyond the last atom):
  // extend the path straight out, with u running on at the end spacing
  const P = path.map(v => ({ ...v })), K = knots.map(k => [...k]);
  const extend = (end, bases) => {
    const [a, b] = end ? [P[P.length - 2], P[P.length - 1]] : [P[1], P[0]];
    const [ka, kb] = end ? [K[K.length - 2], K[K.length - 1]] : [K[1], K[0]];
    const len = Math.hypot(b.p[0] - a.p[0], b.p[1] - a.p[1]) || 1;
    const w = bases * Math.abs((kb[0] - ka[0]) / ((kb[1] - ka[1]) || 1)) || bases * sy;
    const q = { p: [b.p[0] + (b.p[0] - a.p[0]) / len * w, b.p[1] + (b.p[1] - a.p[1]) / len * w], t: b.t + (end ? w : -w) };
    const kq = [kb[0] + (end ? w : -w), kb[1] + (end ? bases : -bases)];
    if (end) { P.push(q); K.push(kq); } else { P.unshift(q); K.unshift(kq); }
  };
  if (caps.head) extend(0, ov[0]);
  if (caps.tail) extend(1, ov[1]);

  // where the head cap ends and the tail cap begins (they split a short strand)
  const both = caps.head && caps.tail;
  const headEnd = caps.head ? Math.min(TEX.cap, both ? n / 2 : n) : -Infinity;
  const tailStart = caps.tail ? Math.max(n - TEX.cap, both ? n / 2 : 0) : Infinity;
  const tMin = P[0].t, tMax = P[P.length - 1].t;
  const cuts = [...new Set([
    ...P.map(v => v.t), ...K.map(k => k[0]), ...breaks,
    ...(caps.head ? [tAt(K, headEnd)] : []), ...(caps.tail ? [tAt(K, tailStart)] : []),
  ])].filter(t => t >= tMin && t <= tMax).sort((a, b) => a - b);

  const buckets = layers.map(() => new Map()); // per layer: colour → <g>
  let e = 1; // P edge holding the current piece
  for (let i = 1; i < cuts.length; i++) {
    const ta = cuts[i - 1], tb = cuts[i];
    if (tb - ta < 1e-6) continue;
    while (e < P.length - 1 && P[e].t <= ta + 1e-9) e++;
    const A = P[e - 1], B = P[e];
    const span = B.t - A.t || 1;
    const pos = t => [A.p[0] + (B.p[0] - A.p[0]) * (t - A.t) / span, A.p[1] + (B.p[1] - A.p[1]) * (t - A.t) / span];
    const pa = pos(ta), pb = pos(tb);
    const len = Math.hypot(pb[0] - pa[0], pb[1] - pa[1]);
    const ua = uAt(K, ta), ub = uAt(K, tb);
    if (len < 1e-6 || ub - ua < 1e-6) continue;
    const um = (ua + ub) / 2;
    const part = um < headEnd ? 'head' : um > tailStart ? 'tail' : 'body';
    const shift = part === 'tail' ? n : 0;
    const T = [(pb[0] - pa[0]) / len, (pb[1] - pa[1]) / len], N = [-T[1], T[0]];
    const sx = len / (ub - ua);
    // overlap neighbours slightly: hides antialiasing seams, and on a fillet
    // covers the wedge that opens on the outside of each chord
    const eps = (0.35 + (A.arc && B.arc ? D * 0.04 : 0)) / sx;
    let x0 = ua - shift - eps, x1 = ub - shift + eps;
    // stay a hair inside a cap image: the pattern wraps, and sampling at its
    // outer edge would bleed the opposite (opaque) edge in as a hairline
    if (part === 'head') { const h = TEX.layers[layers[0].tex].head; x0 = Math.max(x0, h.x + 0.05); x1 = Math.min(x1, h.x + h.w - 0.05); }
    if (part === 'tail') { x0 = Math.max(x0, -TEX.cap + 0.05); }
    const m = [T[0] * sx, T[1] * sx, N[0] * sy, N[1] * sy];
    const tf = `matrix(${[...m, pa[0] - m[0] * (ua - shift), pa[1] - m[1] * (ua - shift)].map(v => +v.toFixed(4)).join(' ')})`;
    const tmid = (ta + tb) / 2;
    const k = n % 10; // tail phase
    layers.forEach((L, li) => {
      const color = L.colorAt(Math.max(0, tmid));
      if (!color) return;
      const xr = part === 'tail' ? Math.min(x1, -TEX.cap + TEX.layers[L.tex].tail[k].w - 0.05) : x1;
      let grp = buckets[li].get(color);
      if (!grp) buckets[li].set(color, grp = el('g', { filter: tintRef(color) }));
      el('rect', { x: x0, y: -HH, width: xr - x0, height: 2 * HH, transform: tf, fill: texRef(L.tex, part, k) }, grp);
    });
  }
  for (const b of buckets) for (const grp of b.values()) g.appendChild(grp);
}
