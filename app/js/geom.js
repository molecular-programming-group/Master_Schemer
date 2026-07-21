// Pure geometry helpers. All coordinates are world units; GRID is the lattice pitch.
export const GRID = 20;

export const snap = v => Math.round(v / GRID) * GRID || 0; // || 0 normalizes -0
export const snapPt = p => [snap(p[0]), snap(p[1])];
// Half-grid lattice: segment boundaries live at 2x the resolution of the main grid.
export const snapHalf = v => Math.round(v / (GRID / 2)) * (GRID / 2) || 0;
export const snapHalfPt = p => [snapHalf(p[0]), snapHalf(p[1])];
export const eq = (a, b) => a[0] === b[0] && a[1] === b[1];
export const dist = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);

// Direction sign pair of segment a→b, e.g. [1,0] or [1,-1]. [0,0] if degenerate.
export const dirOf = (a, b) => [Math.sign(b[0] - a[0]), Math.sign(b[1] - a[1])];

// Project q (relative to anchor a) onto the nearest of the 8 compass directions,
// quantized to whole `step` increments along that direction (default: grid).
// Never goes behind the anchor.
export function snap8(a, q, step = GRID) {
  const dx = q[0] - a[0], dy = q[1] - a[1];
  if (dx === 0 && dy === 0) return [a[0], a[1]];
  const oct = Math.round(Math.atan2(dy, dx) / (Math.PI / 4));
  const ux = Math.round(Math.cos(oct * Math.PI / 4));
  const uy = Math.round(Math.sin(oct * Math.PI / 4));
  const t = (dx * ux + dy * uy) / (ux * ux + uy * uy);
  const n = Math.max(0, Math.round(t / step));
  return [(a[0] + n * step * ux) || 0, (a[1] + n * step * uy) || 0];
}

// Rotate p 90° about c. dir > 0 = clockwise in screen coords (y down).
export const rot90 = (p, c, dir) => dir > 0
  ? [c[0] - (p[1] - c[1]), c[1] + (p[0] - c[0])]
  : [c[0] + (p[1] - c[1]), c[1] - (p[0] - c[0])];

// Mirror p about c along an axis: 'h' flips left-right, 'v' flips top-bottom.
export const flipPt = (p, c, axis) => axis === 'h'
  ? [2 * c[0] - p[0], p[1]] : [p[0], 2 * c[1] - p[1]];

// Vertex index at which to insert a point that sits at arc length t.
export function insertIndex(pts, t) {
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    acc += dist(pts[i - 1], pts[i]);
    if (t < acc) return i;
  }
  return pts.length - 1;
}

// Drop consecutive duplicates and collinear middle points. Sign-based collinearity
// is exact only for 8-direction paths, which is the invariant of the path tool.
export function simplify(pts) {
  const out = [];
  for (const p of pts) {
    if (out.length && eq(p, out[out.length - 1])) continue;
    while (out.length >= 2) {
      const a = out[out.length - 2], b = out[out.length - 1];
      const d1 = dirOf(a, b), d2 = dirOf(b, p);
      if (d1[0] === d2[0] && d1[1] === d2[1]) out.pop(); else break;
    }
    out.push([p[0], p[1]]);
  }
  return out;
}

export function polylineLength(pts) {
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += dist(pts[i - 1], pts[i]);
  return len;
}

// Point at absolute arc length t along the polyline (clamped to the ends).
export function pointAt(pts, t) {
  if (t <= 0) return [pts[0][0], pts[0][1]];
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const d = dist(pts[i - 1], pts[i]);
    if (acc + d >= t && d > 0) {
      const f = (t - acc) / d;
      return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * f,
              pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * f];
    }
    acc += d;
  }
  const last = pts[pts.length - 1];
  return [last[0], last[1]];
}

// Nearest point on the polyline to p → { t: arc length, d: distance }.
export function nearestOnPath(pts, p) {
  let best = { t: 0, d: Infinity };
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const len = dist(a, b);
    if (len === 0) continue;
    let f = ((p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1])) / (len * len);
    f = Math.max(0, Math.min(1, f));
    const q = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
    const d = dist(p, q);
    if (d < best.d) best = { t: acc + f * len, d };
    acc += len;
  }
  return best;
}

// Sub-polyline between arc lengths t0..t1, with interpolated endpoints.
export function subPath(pts, t0, t1) {
  const out = [pointAt(pts, t0)];
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const d = dist(pts[i - 1], pts[i]);
    const at = acc + d;
    if (at > t0 && at < t1) out.push([pts[i][0], pts[i][1]]);
    acc = at;
  }
  out.push(pointAt(pts, t1));
  return out;
}

// SVG path data for a polyline with every interior vertex filleted by a
// circular arc of `radius` (world units) — the "elbow bend" of the curve tool.
// Endpoints stay sharp, and corners whose adjacent edges are too short for the
// radius round by as much as fits. radius 0 (or <3 pts) gives straight corners.
export function roundedPathD(pts, radius) {
  const r3 = v => Math.round(v * 1000) / 1000; // trim float noise from the path data
  if (!radius || pts.length < 3) return `M${pts.map(p => p.join(' ')).join(' L')}`;
  let d = `M${pts[0][0]} ${pts[0][1]}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const A = pts[i - 1], V = pts[i], C = pts[i + 1];
    let din = [V[0] - A[0], V[1] - A[1]], dout = [C[0] - V[0], C[1] - V[1]];
    const lin = Math.hypot(din[0], din[1]), lout = Math.hypot(dout[0], dout[1]);
    if (lin === 0 || lout === 0) continue;
    din = [din[0] / lin, din[1] / lin]; dout = [dout[0] / lout, dout[1] / lout];
    const delta = Math.acos(Math.max(-1, Math.min(1, din[0] * dout[0] + din[1] * dout[1])));
    if (delta < 1e-3) continue; // straight through: no corner to round
    const half = Math.tan(delta / 2);
    const t = Math.min(radius * half, lin / 2, lout / 2); // clamp so fillets never overlap
    const rEff = r3(t / half);
    const P1 = [r3(V[0] - din[0] * t), r3(V[1] - din[1] * t)];
    const P2 = [r3(V[0] + dout[0] * t), r3(V[1] + dout[1] * t)];
    const sweep = din[0] * dout[1] - din[1] * dout[0] > 0 ? 1 : 0;
    d += ` L${P1[0]} ${P1[1]} A${rEff} ${rEff} 0 0 ${sweep} ${P2[0]} ${P2[1]}`;
  }
  const last = pts[pts.length - 1];
  d += ` L${last[0]} ${last[1]}`;
  return d;
}

export function bboxOfPts(pts) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) {
    if (x < x0) x0 = x; if (y < y0) y0 = y;
    if (x > x1) x1 = x; if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
}

// Fuse two paths that share an endpoint. Returns { pts, segments } with the
// second path's segments re-based onto the merged arc length, or null if no
// endpoint pair coincides. Segment objects are copied, not mutated.
export function mergePaths(aPts, aSegs, bPts, bSegs) {
  const rev = pts => pts.slice().reverse();
  const flipSegs = (segs, len) =>
    segs.map(s => ({ ...s, t0: len - s.t1, t1: len - s.t0 }));
  const shiftSegs = (segs, off) =>
    segs.map(s => ({ ...s, t0: s.t0 + off, t1: s.t1 + off }));
  const lenA = polylineLength(aPts), lenB = polylineLength(bPts);
  let A = aPts, sA = aSegs, B = bPts, sB = bSegs;
  if (eq(A[A.length - 1], B[0])) { /* already head-to-tail */ }
  else if (eq(A[A.length - 1], B[B.length - 1])) { B = rev(B); sB = flipSegs(sB, lenB); }
  else if (eq(A[0], B[0])) { A = rev(A); sA = flipSegs(sA, lenA); }
  else if (eq(A[0], B[B.length - 1])) {
    [A, B] = [B, A]; [sA, sB] = [sB, sA];
    return { pts: simplify([...A, ...B.slice(1)]), segments: [...sA.map(s => ({ ...s })), ...shiftSegs(sB, lenB)] };
  } else return null;
  return { pts: simplify([...A, ...B.slice(1)]), segments: [...sA.map(s => ({ ...s })), ...shiftSegs(sB, lenA)] };
}

// Intersection of segments p1→p2 and p3→p4 → { t, u } params in [0,1], or null
// (parallel or non-crossing). t is the fraction along p1→p2.
export function segSegIntersect(p1, p2, p3, p4) {
  const d1x = p2[0] - p1[0], d1y = p2[1] - p1[1];
  const d2x = p4[0] - p3[0], d2y = p4[1] - p3[1];
  const den = d1x * d2y - d1y * d2x;
  if (den === 0) return null;
  const t = ((p3[0] - p1[0]) * d2y - (p3[1] - p1[1]) * d2x) / den;
  const u = ((p3[0] - p1[0]) * d1y - (p3[1] - p1[1]) * d1x) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { t, u };
}

// Arc length along `pts` where blade A→B first crosses it (smallest arc length,
// so the sliding cut dot is stable), or null if the blade misses.
export function bladeCross(pts, A, B) {
  let acc = 0, best = null;
  for (let i = 1; i < pts.length; i++) {
    const len = dist(pts[i - 1], pts[i]);
    const hit = segSegIntersect(pts[i - 1], pts[i], A, B);
    if (hit) { const at = acc + hit.t * len; if (best === null || at < best) best = at; }
    acc += len;
  }
  return best;
}

// Split a segment list at arc length tc → [before, after]; `after` is rebased so
// its arc lengths start at 0. Segments straddling tc are clipped to each side.
export function splitSegments(segs, tc, total) {
  const before = [], after = [];
  for (const s of segs || []) {
    const a0 = Math.max(s.t0, 0), a1 = Math.min(s.t1, tc);
    if (a1 - a0 > 0.01) before.push({ ...s, t0: a0, t1: a1 });
    const b0 = Math.max(s.t0, tc), b1 = Math.min(s.t1, total);
    if (b1 - b0 > 0.01) after.push({ ...s, t0: b0 - tc, t1: b1 - tc });
  }
  return [before, after];
}

// Re-map a path's segments when one endpoint is dragged (the line resized).
// Segment arc lengths are measured from the start, so:
//  - dragging the END vertex: segments keep their position; one already sitting
//    at the old end grows or shrinks with the new total.
//  - dragging the START vertex: every segment shifts by the length change (the
//    origin moved), except one already anchored at the start, which stays at 0.
// Either way a segment squeezed outside the new bounds is dropped. `end` is
// truthy for the last vertex, falsy for the first.
export function resizeEndSegments(segs, oldTotal, newTotal, end) {
  const d = newTotal - oldTotal;
  const out = [];
  for (const s of segs || []) {
    let t0 = s.t0, t1 = s.t1;
    if (end) {
      if (Math.abs(t1 - oldTotal) < 0.5) t1 = newTotal; // end-anchored: track the end
    } else {
      t1 += d;
      t0 = Math.abs(t0) < 0.5 ? 0 : t0 + d; // start-anchored: stay pinned at 0
    }
    t0 = Math.max(0, Math.min(t0, newTotal));
    t1 = Math.max(0, Math.min(t1, newTotal));
    if (t1 - t0 > 0.01) out.push({ ...s, t0, t1 });
  }
  return out;
}

export const rectsIntersect = (a, b) =>
  a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];

// Convex hull (monotone chain) of a point cloud → CCW-ish boundary polygon.
// Used to fill the area spanning two linked objects.
export function convexHull(pts) {
  const p = [...new Map(pts.map(q => [`${q[0]},${q[1]}`, q])).values()]
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  lower.pop(); upper.pop();
  return lower.concat(upper);
}

// Sample points around an ellipse for hull/bbox math.
export function ellipsePoints(cx, cy, rx, ry, n = 12) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    out.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]);
  }
  return out;
}

// Where the ray from the rect's center toward (tx,ty) exits the rect border.
export function rectEdgePoint(cx, cy, w, h, tx, ty) {
  const dx = tx - cx, dy = ty - cy;
  if (dx === 0 && dy === 0) return [cx, cy];
  const sx = dx !== 0 ? (w / 2) / Math.abs(dx) : Infinity;
  const sy = dy !== 0 ? (h / 2) / Math.abs(dy) : Infinity;
  const s = Math.min(sx, sy, 1);
  return [cx + dx * s, cy + dy * s];
}
