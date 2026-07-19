// Pure geometry helpers. All coordinates are world units; GRID is the lattice pitch.
export const GRID = 20;

export const snap = v => Math.round(v / GRID) * GRID || 0; // || 0 normalizes -0
export const snapPt = p => [snap(p[0]), snap(p[1])];
export const eq = (a, b) => a[0] === b[0] && a[1] === b[1];
export const dist = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);

// Direction sign pair of segment a→b, e.g. [1,0] or [1,-1]. [0,0] if degenerate.
export const dirOf = (a, b) => [Math.sign(b[0] - a[0]), Math.sign(b[1] - a[1])];

// Project q (relative to anchor a) onto the nearest of the 8 compass directions,
// quantized to whole grid steps along that direction. Never goes behind the anchor.
export function snap8(a, q) {
  const dx = q[0] - a[0], dy = q[1] - a[1];
  if (dx === 0 && dy === 0) return [a[0], a[1]];
  const oct = Math.round(Math.atan2(dy, dx) / (Math.PI / 4));
  const ux = Math.round(Math.cos(oct * Math.PI / 4));
  const uy = Math.round(Math.sin(oct * Math.PI / 4));
  const t = (dx * ux + dy * uy) / (ux * ux + uy * uy);
  const n = Math.max(0, Math.round(t / GRID));
  return [(a[0] + n * GRID * ux) || 0, (a[1] + n * GRID * uy) || 0];
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

export function bboxOfPts(pts) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) {
    if (x < x0) x0 = x; if (y < y0) y0 = y;
    if (x > x1) x1 = x; if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
}

export const rectsIntersect = (a, b) =>
  a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];

// Where the ray from the rect's center toward (tx,ty) exits the rect border.
export function rectEdgePoint(cx, cy, w, h, tx, ty) {
  const dx = tx - cx, dy = ty - cy;
  if (dx === 0 && dy === 0) return [cx, cy];
  const sx = dx !== 0 ? (w / 2) / Math.abs(dx) : Infinity;
  const sy = dy !== 0 ? (h / 2) / Math.abs(dy) : Infinity;
  const s = Math.min(sx, sy, 1);
  return [cx + dx * s, cy + dy * s];
}
