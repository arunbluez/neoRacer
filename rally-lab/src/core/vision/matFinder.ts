// Finds the race mat in every camera frame, so a hand-held phone needs no
// fixed calibration. The mat is a dark rectangle on a lighter floor: the
// largest dark region gives a rough quadrilateral, its four edges are refitted
// robustly (people's shoes or bags touching the mat are rejected as outliers)
// and then refined to sub-pixel accuracy on the full frame. Corner order is
// clockwise on screen starting nearest the frame's top-left; which corner is
// which mat corner is a separate choice (see quadToMat and orientation.ts).

import { solveHomography } from './homography';
import type { Mat3, Pt } from './linalg';
import type { ImageBuf } from './rectify';

export type Quad = [Pt, Pt, Pt, Pt];

export type MatFinderOpts = {
  /** Width the frame is reduced to for the region search. Default 320. */
  workWidth?: number;
  /** Smallest mat area as a fraction of the frame. Default 0.04. */
  minAreaFrac?: number;
  /** Refine the edges on the full frame (sub-pixel). Default true. */
  refine?: boolean;
  /** Last frame's corners: prefer the dark region around them. */
  prev?: Quad;
  /** Why a frame was rejected, for diagnostics. */
  onReject?: (reason: string) => void;
};

export type MatQuad = {
  /** Frame pixels, clockwise on screen, first corner nearest the frame's top-left. */
  corners: Quad;
  /** Brightness threshold (max channel, 0..255) that separated mat and floor. */
  threshold: number;
  /** Quad area / frame area. */
  areaFrac: number;
  /** RMS distance of the edge points from their fitted lines, frame px. */
  edgeRms: number;
  /** Edge points that agreed with the fitted lines, 0..1. */
  edgeSupport: number;
  /** A corner is at or beyond the frame edge: the mat is not fully in view. */
  touchesBorder: boolean;
};

/** Signed area, positive when clockwise on screen (y down). */
export function quadArea(q: Pt[]): number {
  let s = 0;
  for (let i = 0; i < q.length; i++) {
    const a = q[i], b = q[(i + 1) % q.length];
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

/** Clockwise on screen, starting at the corner with the smallest x + y. */
export function orderCorners(pts: Pt[]): Quad {
  const q = pts.slice(0, 4);
  if (quadArea(q) < 0) q.reverse();
  let k = 0;
  for (let i = 1; i < 4; i++) if (q[i].x + q[i].y < q[k].x + q[k].y) k = i;
  return [q[k], q[(k + 1) % 4], q[(k + 2) % 4], q[(k + 3) % 4]];
}

/** The rotation of `next` that best matches `prev` corner by corner (keeps identities while the phone moves). */
export function matchCorners(prev: Quad, next: Quad): Quad {
  let best = 0, bestD = Infinity;
  for (let s = 0; s < 4; s++) {
    let d = 0;
    for (let i = 0; i < 4; i++) d += Math.hypot(prev[i].x - next[(i + s) % 4].x, prev[i].y - next[(i + s) % 4].y);
    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }
  return [next[best], next[(best + 1) % 4], next[(best + 2) % 4], next[(best + 3) % 4]];
}

/**
 * Homography frame px → mat cm. Mat corners are (0,0), (W,0), (W,H), (0,H)
 * (clockwise on a y-down mat); frame corner (i + rot) % 4 is mat corner i.
 */
export function quadToMat(corners: Quad, rot: number, matWidthCm: number, matHeightCm: number): Mat3 {
  const r = ((rot % 4) + 4) % 4;
  const src = [0, 1, 2, 3].map((i) => corners[(i + r) % 4]);
  return solveHomography(src, [{ x: 0, y: 0 }, { x: matWidthCm, y: 0 }, { x: matWidthCm, y: matHeightCm }, { x: 0, y: matHeightCm }]);
}

// ---------------------------------------------------------------- helpers

type Line = { nx: number; ny: number; c: number }; // nx·x + ny·y = c, |n| = 1

/** Total least squares line through points (null if fewer than 2). */
function fitLine(pts: Pt[]): Line | null {
  const n = pts.length;
  if (n < 2) return null;
  let mx = 0, my = 0;
  for (const p of pts) {
    mx += p.x;
    my += p.y;
  }
  mx /= n;
  my /= n;
  let sxx = 0, syy = 0, sxy = 0;
  for (const p of pts) {
    const dx = p.x - mx, dy = p.y - my;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  // Direction = principal eigenvector; normal is perpendicular.
  const th = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const nx = -Math.sin(th), ny = Math.cos(th);
  return { nx, ny, c: nx * mx + ny * my };
}

function intersect(a: Line, b: Line): Pt | null {
  const det = a.nx * b.ny - a.ny * b.nx;
  if (Math.abs(det) < 1e-9) return null;
  return { x: (a.c * b.ny - a.ny * b.c) / det, y: (a.nx * b.c - a.c * b.nx) / det };
}

const dist = (l: Line, p: Pt) => l.nx * p.x + l.ny * p.y - l.c;

function median(a: number[]): number {
  if (a.length === 0) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Line fit that drops outliers (residual above 2.5 robust sigmas) twice. */
function robustLine(pts: Pt[], minSigma: number): { line: Line; inliers: Pt[]; rms: number } | null {
  let cur = pts;
  let line = fitLine(cur);
  if (!line) return null;
  for (let it = 0; it < 3; it++) {
    const l = line;
    const res = cur.map((p) => Math.abs(dist(l, p)));
    const sigma = Math.max(minSigma, 1.4826 * median(res));
    const keep = cur.filter((_, i) => res[i] <= 2.5 * sigma);
    if (keep.length < 2 || keep.length === cur.length) break;
    cur = keep;
    line = fitLine(cur);
    if (!line) return null;
  }
  const l = line;
  const rms = Math.sqrt(cur.reduce((s, p) => s + dist(l, p) ** 2, 0) / cur.length);
  return { line: l, inliers: cur, rms };
}

/** Convex hull (Andrew's monotone chain), clockwise on screen. */
function convexHull(points: Pt[]): Pt[] {
  const p = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (p.length < 3) return p;
  const cross = (o: Pt, a: Pt, b: Pt) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Pt[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: Pt[] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  const hull = lower.slice(0, -1).concat(upper.slice(0, -1));
  // Monotone chain gives counter-clockwise in y-up terms, i.e. anticlockwise on
  // a y-down screen; flip to clockwise.
  return quadArea(hull) < 0 ? hull.reverse() : hull;
}

/** Drop the vertex that loses the least area until four remain. */
function reduceToQuad(hull: Pt[]): Pt[] {
  const p = [...hull];
  const tri = (a: Pt, b: Pt, c: Pt) => Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) / 2;
  while (p.length > 4) {
    let k = 0, best = Infinity;
    for (let i = 0; i < p.length; i++) {
      const a = tri(p[(i + p.length - 1) % p.length], p[i], p[(i + 1) % p.length]);
      if (a < best) {
        best = a;
        k = i;
      }
    }
    p.splice(k, 1);
  }
  return p;
}

/** Otsu's threshold on a 256-bin histogram. */
function otsu(hist: Uint32Array, total: number): number {
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, t = 128;
  for (let i = 0; i < 256; i++) {
    wB += hist[i];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += i * hist[i];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) {
      best = between;
      t = i;
    }
  }
  return t + 0.5;
}

/** Max channel at a continuous point (bilinear), or NaN outside the frame. */
function valueAt(img: ImageBuf, x: number, y: number): number {
  const w = img.width, h = img.height;
  const fx = x - 0.5, fy = y - 0.5;
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  if (x0 < 0 || y0 < 0 || x0 + 1 >= w || y0 + 1 >= h) return NaN;
  const tx = fx - x0, ty = fy - y0;
  const d = img.data;
  const v = (i: number, j: number) => {
    const o = (j * w + i) * 4;
    const r = d[o], g = d[o + 1], b = d[o + 2];
    return r > g ? (r > b ? r : b) : g > b ? g : b;
  };
  return (v(x0, y0) * (1 - tx) + v(x0 + 1, y0) * tx) * (1 - ty) + (v(x0, y0 + 1) * (1 - tx) + v(x0 + 1, y0 + 1) * tx) * ty;
}

// ---------------------------------------------------------------- finder

/** The mat's corners in this frame, or null when no mat-like dark quadrilateral is found. */
export function findMat(img: ImageBuf, opts: MatFinderOpts = {}): MatQuad | null {
  const W = img.width, H = img.height, d = img.data;
  const reject = (why: string): null => {
    opts.onReject?.(why);
    return null;
  };
  const step = Math.max(1, Math.round(W / (opts.workWidth ?? 320)));
  const ws = Math.floor(W / step), hs = Math.floor(H / step);
  if (ws < 8 || hs < 8) return reject('frame too small');

  // 1. Brightness (max channel) per work cell: the mean of a few pixels of
  //    each step×step block (the darkest pixel would make edges grow).
  const val = new Uint8Array(ws * hs);
  const hist = new Uint32Array(256);
  const offs = step >= 3 ? [Math.floor(step / 4), Math.floor((3 * step) / 4)] : Array.from({ length: step }, (_, k) => k);
  const nOff = offs.length * offs.length;
  for (let j = 0; j < hs; j++) {
    for (let i = 0; i < ws; i++) {
      let s = 0;
      for (const oy of offs) {
        const row = (j * step + oy) * W + i * step;
        for (const ox of offs) {
          const o = (row + ox) * 4;
          const r = d[o], g = d[o + 1], b = d[o + 2];
          s += r > g ? (r > b ? r : b) : g > b ? g : b;
        }
      }
      const v = Math.round(s / nOff);
      val[j * ws + i] = v;
      hist[v]++;
    }
  }
  const threshold = Math.max(35, Math.min(150, otsu(hist, ws * hs)));

  // 2. Dark mask with its holes filled: anything bright the floor can't reach
  //    (the lane, white lines, cones, a robot) is enclosed by the mat's black
  //    margin and belongs to the mat.
  const mask = new Uint8Array(ws * hs);
  for (let p = 0; p < mask.length; p++) mask[p] = val[p] < threshold ? 1 : 0;
  const queue = new Int32Array(ws * hs);
  {
    const outside = new Uint8Array(ws * hs);
    let head = 0, tail = 0;
    const seed = (p: number) => {
      if (!mask[p] && !outside[p]) {
        outside[p] = 1;
        queue[tail++] = p;
      }
    };
    for (let i = 0; i < ws; i++) {
      seed(i);
      seed((hs - 1) * ws + i);
    }
    for (let j = 0; j < hs; j++) {
      seed(j * ws);
      seed(j * ws + ws - 1);
    }
    while (head < tail) {
      const p = queue[head++];
      const x = p % ws;
      if (x > 0) seed(p - 1);
      if (x < ws - 1) seed(p + 1);
      if (p >= ws) seed(p - ws);
      if (p < mask.length - ws) seed(p + ws);
    }
    for (let p = 0; p < mask.length; p++) if (!outside[p]) mask[p] = 1;
  }

  // 3. Connected components (4-connected).
  const labels = new Int32Array(ws * hs);
  const areas: number[] = [0];
  for (let p0 = 0; p0 < mask.length; p0++) {
    if (!mask[p0] || labels[p0]) continue;
    const id = areas.length;
    let head = 0, tail = 0;
    queue[tail++] = p0;
    labels[p0] = id;
    while (head < tail) {
      const p = queue[head++];
      const x = p % ws;
      if (x > 0 && mask[p - 1] && !labels[p - 1]) { labels[p - 1] = id; queue[tail++] = p - 1; }
      if (x < ws - 1 && mask[p + 1] && !labels[p + 1]) { labels[p + 1] = id; queue[tail++] = p + 1; }
      if (p >= ws && mask[p - ws] && !labels[p - ws]) { labels[p - ws] = id; queue[tail++] = p - ws; }
      if (p < mask.length - ws && mask[p + ws] && !labels[p + ws]) { labels[p + ws] = id; queue[tail++] = p + ws; }
    }
    areas.push(tail);
  }
  if (areas.length < 2) return reject('nothing dark');
  const largest = Math.max(...areas);
  if (largest < (opts.minAreaFrac ?? 0.04) * ws * hs * 0.5) return reject('dark region too small');

  // 4. Candidates: the big components, and all of them together. Each one's
  //    outer boundary (extreme pixels per row and column), hull and rough
  //    quad. If the black margin is broken somewhere (the far end, an object
  //    lying across it) the mat falls apart into a ring and the infield, or
  //    into halves; the whole mat is then the biggest well-filled quad, or when
  //    tracking the quad nearest the previous one.
  const ids = areas.map((a, id) => ({ a, id })).filter((c) => c.id > 0 && c.a >= 0.25 * largest)
    .sort((x, y) => y.a - x.a).slice(0, 4).map((c) => c.id);
  const atBorder = (id: number) => {
    for (let i = 0; i < ws; i++) if (labels[i] === id || labels[(hs - 1) * ws + i] === id) return true;
    for (let j = 0; j < hs; j++) if (labels[j * ws] === id || labels[j * ws + ws - 1] === id) return true;
    return false;
  };
  type Cand = { bpts: Pt[]; hull: Pt[]; fit: EdgeFit; area: number; fill: number; cover: number; border: boolean };
  const cands: Cand[] = [];
  const groups = ids.map((id) => [id]);
  // Dark clutter at the frame edge (tables, bags, people) is not part of the mat.
  const inner = ids.filter((id) => !atBorder(id));
  if (inner.length > 1) groups.push(inner);
  for (const group of groups) {
    const bpts = group.flatMap((id) => boundaryPoints(labels, id, ws, hs));
    if (bpts.length < 8) continue;
    const hull = convexHull(bpts);
    if (hull.length < 4) continue;
    const fit = fitEdges(bpts, reduceToQuad(hull));
    if (!fit) continue;
    const area = quadArea(fit.quad);
    if (!(area > 0)) continue;
    cands.push({ bpts, hull, fit, area, fill: fillRatio(mask, ws, hs, fit.quad), cover: edgeCover(bpts, fit.quad), border: group.some(atBorder) });
  }
  if (cands.length === 0) return reject('no quad');
  let cand = cands[0];
  // Big, solidly dark, straight-edged, and preferably not cut by the frame edge.
  const score = (c: Cand) => c.area * c.fill * c.fill * c.cover * c.cover * (c.border ? 0.25 : 1);
  if (opts.prev) {
    const prev = opts.prev.map((p) => ({ x: p.x / step, y: p.y / step })) as Quad;
    let bestD = Infinity;
    for (const c of cands) {
      if (c.fill < 0.45 || c.cover < 0.5) continue;
      const q = matchCorners(prev, orderCorners(c.fit.quad));
      const dd = q.reduce((s2, p, i) => s2 + Math.hypot(p.x - prev[i].x, p.y - prev[i].y), 0);
      if (dd < bestD) {
        bestD = dd;
        cand = c;
      }
    }
  } else {
    for (const c of cands) if (score(c) > score(cand)) cand = c;
  }
  const { hull } = cand;
  const quad = cand.fit.quad;
  let rms = cand.fit.rms * step;
  const support = cand.cover;
  let corners = quad.map((p) => ({ x: p.x * step, y: p.y * step }));

  // 6. Sub-pixel refinement on the full frame: along each edge, find the
  //    dark → bright step across it and refit the lines.
  if ((opts.refine ?? true) && step > 1) {
    const refined = refineEdges(img, corners, step, threshold);
    if (refined) {
      corners = refined.corners;
      rms = refined.rms;
    }
  }

  const ordered = orderCorners(corners);
  const area = quadArea(ordered);
  if (!(area > (opts.minAreaFrac ?? 0.04) * W * H)) return reject('quad too small');
  // Convex: every turn has the same sign.
  for (let k = 0; k < 4; k++) {
    const a = ordered[k], b = ordered[(k + 1) % 4], c = ordered[(k + 2) % 4];
    if ((b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x) <= 0) return reject('quad not convex');
  }
  const margin = 1.5 * step;
  const touchesBorder = ordered.some((p) => p.x < margin || p.y < margin || p.x > W - margin || p.y > H - margin) ||
    hull.some((p) => p.x <= 0.5 || p.y <= 0.5 || p.x >= ws - 0.5 || p.y >= hs - 0.5);
  return { corners: ordered, threshold, areaFrac: area / (W * H), edgeRms: rms, edgeSupport: support, touchesBorder };
}

type EdgeFit = { quad: Pt[]; rms: number };

/** Each edge of a rough quad refitted (twice) from the boundary points near it. */
function fitEdges(bpts: Pt[], rough: Pt[]): EdgeFit | null {
  let quad = rough;
  let rms = 0;
  for (let pass = 0; pass < 2; pass++) {
    const lines: Line[] = [];
    let sumSq = 0, nIn = 0;
    for (let k = 0; k < 4; k++) {
      const a = quad[k], b = quad[(k + 1) % 4];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len < 4) return null;
      const ux = (b.x - a.x) / len, uy = (b.y - a.y) / len;
      const base: Line = { nx: -uy, ny: ux, c: -uy * a.x + ux * a.y };
      const tol = Math.max(2, 0.04 * len);
      const near = bpts.filter((p) => {
        const t = ((p.x - a.x) * ux + (p.y - a.y) * uy) / len;
        return t > 0.08 && t < 0.92 && Math.abs(dist(base, p)) < tol;
      });
      const fit = robustLine(near, 0.7);
      if (!fit) return null;
      lines.push(fit.line);
      sumSq += fit.rms * fit.rms * fit.inliers.length;
      nIn += fit.inliers.length;
    }
    const q: Pt[] = [];
    for (let k = 0; k < 4; k++) {
      const p = intersect(lines[(k + 3) % 4], lines[k]);
      if (!p) return null;
      q.push(p);
    }
    quad = q;
    rms = Math.sqrt(sumSq / Math.max(1, nIn));
  }
  return { quad, rms };
}

/** Fraction of boundary points within 1.5 work px of the quad's edges. */
function edgeCover(bpts: Pt[], quad: Pt[]): number {
  let n = 0;
  for (const p of bpts) {
    for (let k = 0; k < 4; k++) {
      const a = quad[k], b = quad[(k + 1) % 4];
      const dx = b.x - a.x, dy = b.y - a.y;
      const L2 = dx * dx + dy * dy;
      const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2));
      if (Math.hypot(a.x + t * dx - p.x, a.y + t * dy - p.y) <= 1.5) {
        n++;
        break;
      }
    }
  }
  return bpts.length ? n / bpts.length : 0;
}

/** Fraction of the work pixels inside a convex quad that are mat (mask 1). */
function fillRatio(mask: Uint8Array, ws: number, hs: number, quad: Pt[]): number {
  let ys = Infinity, ye = -Infinity;
  for (const p of quad) {
    ys = Math.min(ys, p.y);
    ye = Math.max(ye, p.y);
  }
  let inside = 0, on = 0;
  for (let j = Math.max(0, Math.floor(ys)); j < Math.min(hs, Math.ceil(ye)); j++) {
    const y = j + 0.5;
    // Span of the convex quad on this row.
    let x0 = Infinity, x1 = -Infinity;
    for (let k = 0; k < quad.length; k++) {
      const a = quad[k], b = quad[(k + 1) % quad.length];
      if ((a.y <= y && b.y > y) || (b.y <= y && a.y > y)) {
        const x = a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x);
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
      }
    }
    if (!(x1 > x0)) continue;
    for (let i = Math.max(0, Math.ceil(x0 - 0.5)); i < Math.min(ws, Math.floor(x1 - 0.5) + 1); i++) {
      inside++;
      on += mask[j * ws + i];
    }
  }
  return inside ? on / inside : 0;
}

/** Outer boundary of one component: its extreme pixels per row and per column (work px, edges). */
function boundaryPoints(labels: Int32Array, id: number, ws: number, hs: number): Pt[] {
  const pts: Pt[] = [];
  const colMin = new Int32Array(ws).fill(-1), colMax = new Int32Array(ws).fill(-1);
  for (let j = 0; j < hs; j++) {
    let lo = -1, hi = -1;
    for (let i = 0; i < ws; i++) {
      if (labels[j * ws + i] !== id) continue;
      if (lo < 0) lo = i;
      hi = i;
      if (colMin[i] < 0) colMin[i] = j;
      colMax[i] = j;
    }
    if (lo >= 0) pts.push({ x: lo, y: j + 0.5 }, { x: hi + 1, y: j + 0.5 });
  }
  for (let i = 0; i < ws; i++) {
    if (colMin[i] >= 0) pts.push({ x: i + 0.5, y: colMin[i] }, { x: i + 0.5, y: colMax[i] + 1 });
  }
  return pts;
}

function refineEdges(img: ImageBuf, corners: Pt[], step: number, threshold: number): { corners: Pt[]; rms: number } | null {
  const cx = (corners[0].x + corners[1].x + corners[2].x + corners[3].x) / 4;
  const cy = (corners[0].y + corners[1].y + corners[2].y + corners[3].y) / 4;
  const R = 2.5 * step;
  const lines: Line[] = [];
  let sumSq = 0, n = 0;
  for (let k = 0; k < 4; k++) {
    const a = corners[k], b = corners[(k + 1) % 4];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const ux = (b.x - a.x) / len, uy = (b.y - a.y) / len;
    let nx = -uy, ny = ux;
    // outward normal: away from the centre
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    if (nx * (mx - cx) + ny * (my - cy) < 0) {
      nx = -nx;
      ny = -ny;
    }
    const samples = Math.max(12, Math.min(80, Math.round(len / 6)));
    const pts: Pt[] = [];
    const prof: number[] = [];
    const ds = 0.5;
    for (let s = 0; s < samples; s++) {
      const t = 0.08 + (0.84 * (s + 0.5)) / samples;
      const px = a.x + (b.x - a.x) * t, py = a.y + (b.y - a.y) * t;
      prof.length = 0;
      let ok = true;
      for (let o = -R; o <= R; o += ds) {
        const v = valueAt(img, px + nx * o, py + ny * o);
        if (Number.isNaN(v)) {
          ok = false;
          break;
        }
        prof.push(v);
      }
      if (!ok || prof.length < 5) continue;
      // Smooth a little, then the steepest rise going outwards.
      let best = -Infinity, bi = -1;
      for (let i = 2; i < prof.length - 2; i++) {
        const g = prof[i + 2] + prof[i + 1] - prof[i - 1] - prof[i - 2];
        if (g > best) {
          best = g;
          bi = i;
        }
      }
      const inside = prof[0], outside = prof[prof.length - 1];
      if (bi < 0 || outside - inside < 20 || inside > threshold + 10) continue;
      // Parabolic peak of the gradient for sub-sample accuracy.
      const g = (i: number) => prof[i + 2] + prof[i + 1] - prof[i - 1] - prof[i - 2];
      let off = 0;
      if (bi > 2 && bi < prof.length - 3) {
        const g0 = g(bi - 1), g1 = g(bi), g2 = g(bi + 1);
        const den = g0 - 2 * g1 + g2;
        if (den < 0) off = (0.5 * (g0 - g2)) / den;
      }
      const o = -R + (bi + off) * ds;
      pts.push({ x: px + nx * o, y: py + ny * o });
    }
    if (pts.length < 6) return null;
    const fit = robustLine(pts, 0.4);
    if (!fit || fit.inliers.length < 5) return null;
    lines.push(fit.line);
    sumSq += fit.rms * fit.rms * fit.inliers.length;
    n += fit.inliers.length;
  }
  const out: Pt[] = [];
  for (let k = 0; k < 4; k++) {
    const p = intersect(lines[(k + 3) % 4], lines[k]);
    if (!p) return null;
    // Refinement must stay near the coarse corner.
    if (Math.hypot(p.x - corners[k].x, p.y - corners[k].y) > 4 * step) return null;
    out.push(p);
  }
  return { corners: out, rms: Math.sqrt(sumSq / Math.max(1, n)) };
}
