// Finds the track by its painted lane, not by the mat's outline: the blue →
// purple → pink lane band is unlike anything else in a busy hall, while the
// black mat merges with dark clothes, bags and chairs around it. The lane's
// edges in the frame are matched to the known lane (from the route) by
// fitting a homography (robust ICP): from the previous frame's fit while
// tracking, else from rough starts (the lane's hull in four ways round, and
// the mat outline when there is one), keeping the best. Only the lane needs
// to be in view, not the whole mat.

import { solveHomography } from './homography';
import { applyH, mat3Inv, type Mat3, type Pt } from './linalg';
import { quadArea, type Quad } from './matFinder';
import type { ImageBuf } from './rectify';

export type LaneModel = {
  /** Points on both edges of the lane (mat cm). */
  pts: Pt[];
  /** For each point, the unit direction into the lane (mat). */
  inward: Pt[];
  /** The hull of the lane band reduced to 4 points, clockwise (mat cm). */
  quad: Pt[];
  matWidthCm: number;
  matHeightCm: number;
};

/** Lane edge points every `stepCm` along the painted centre line (points with a heading). */
export function laneModel(center: { x: number; y: number; headingDeg: number }[], halfLaneCm: number, matWidthCm: number, matHeightCm: number, stepCm = 2): LaneModel {
  const pts: Pt[] = [];
  const inward: Pt[] = [];
  let acc = Infinity;
  let prev: Pt | null = null;
  for (const p of center) {
    if (prev) acc += Math.hypot(p.x - prev.x, p.y - prev.y);
    prev = p;
    if (acc < stepCm) continue;
    acc = 0;
    const th = (p.headingDeg * Math.PI) / 180;
    const nx = -Math.sin(th), ny = Math.cos(th);
    pts.push({ x: p.x + nx * halfLaneCm, y: p.y + ny * halfLaneCm }, { x: p.x - nx * halfLaneCm, y: p.y - ny * halfLaneCm });
    inward.push({ x: -nx, y: -ny }, { x: nx, y: ny });
  }
  return { pts, inward, quad: reduceToQuad(convexHull(pts)), matWidthCm, matHeightCm };
}

/** Lane colour: saturated blue → purple → pink, not dark. */
export function isLaneColor(r: number, g: number, b: number): boolean {
  const max = r > g ? (r > b ? r : b) : g > b ? g : b;
  if (max < 50) return false;
  const min = r < g ? (r < b ? r : b) : g < b ? g : b;
  const d = max - min;
  if (d < 0.22 * max) return false;
  let h: number;
  if (max === r) h = ((g - b) / d + 6) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  return h >= 195 && h <= 355;
}

/** The lane mask of a frame at working resolution, its edges and a nearest-edge map. */
export type LaneFrame = {
  step: number;
  ws: number;
  hs: number;
  mask: Uint8Array;
  /** For every work pixel, the index (y·ws + x) of the nearest lane-edge pixel, or −1. */
  nearest: Int32Array;
  edges: number;
};

export function laneFrame(img: ImageBuf, workWidth = 320): LaneFrame {
  const W = img.width, d = img.data;
  const step = Math.max(1, Math.round(W / workWidth));
  const ws = Math.floor(W / step), hs = Math.floor(img.height / step);
  const mask = new Uint8Array(ws * hs);
  const o1 = step >= 2 ? Math.floor(step / 4) : 0, o2 = step >= 2 ? Math.floor((3 * step) / 4) : 0;
  for (let j = 0; j < hs; j++) {
    for (let i = 0; i < ws; i++) {
      // mean of two pixels per cell keeps edges sharp enough and costs little
      const a = ((j * step + o1) * W + i * step + o1) * 4, b = ((j * step + o2) * W + i * step + o2) * 4;
      mask[j * ws + i] = isLaneColor((d[a] + d[b]) >> 1, (d[a + 1] + d[b + 1]) >> 1, (d[a + 2] + d[b + 2]) >> 1) ? 1 : 0;
    }
  }
  // Drop specks (fewer than 6 pixels) so they don't make edges.
  const seen = new Uint8Array(ws * hs);
  const queue = new Int32Array(ws * hs);
  for (let p0 = 0; p0 < mask.length; p0++) {
    if (!mask[p0] || seen[p0]) continue;
    let head = 0, tail = 0;
    queue[tail++] = p0;
    seen[p0] = 1;
    while (head < tail) {
      const p = queue[head++];
      const x = p % ws;
      if (x > 0 && mask[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; queue[tail++] = p - 1; }
      if (x < ws - 1 && mask[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; queue[tail++] = p + 1; }
      if (p >= ws && mask[p - ws] && !seen[p - ws]) { seen[p - ws] = 1; queue[tail++] = p - ws; }
      if (p + ws < mask.length && mask[p + ws] && !seen[p + ws]) { seen[p + ws] = 1; queue[tail++] = p + ws; }
    }
    if (tail < 6) for (let k = 0; k < tail; k++) mask[queue[k]] = 0;
  }
  // Edge pixels and the nearest-edge map (two passes, propagating the nearest point).
  const nearest = new Int32Array(ws * hs).fill(-1);
  const dist = new Float32Array(ws * hs).fill(Infinity);
  let edges = 0;
  for (let j = 0; j < hs; j++) {
    for (let i = 0; i < ws; i++) {
      const p = j * ws + i;
      if (!mask[p]) continue;
      if ((i > 0 && !mask[p - 1]) || (i < ws - 1 && !mask[p + 1]) || (j > 0 && !mask[p - ws]) || (j < hs - 1 && !mask[p + ws])) {
        nearest[p] = p;
        dist[p] = 0;
        edges++;
      }
    }
  }
  // Inline relaxation (no closures: this runs on every frame).
  for (let y = 0; y < hs; y++) {
    for (let x = 0; x < ws; x++) {
      const p = y * ws + x;
      let best = dist[p], bn = nearest[p];
      for (let k = 0; k < 4; k++) {
        let q: number;
        if (k === 0) { if (x === 0) continue; q = p - 1; }
        else if (k === 1) { if (y === 0) continue; q = p - ws; }
        else if (k === 2) { if (y === 0 || x === 0) continue; q = p - ws - 1; }
        else { if (y === 0 || x === ws - 1) continue; q = p - ws + 1; }
        const n = nearest[q];
        if (n < 0) continue;
        const ex = n % ws - x, ey = ((n / ws) | 0) - y;
        const dd = ex * ex + ey * ey;
        if (dd < best) { best = dd; bn = n; }
      }
      dist[p] = best;
      nearest[p] = bn;
    }
  }
  for (let y = hs - 1; y >= 0; y--) {
    for (let x = ws - 1; x >= 0; x--) {
      const p = y * ws + x;
      let best = dist[p], bn = nearest[p];
      for (let k = 0; k < 4; k++) {
        let q: number;
        if (k === 0) { if (x === ws - 1) continue; q = p + 1; }
        else if (k === 1) { if (y === hs - 1) continue; q = p + ws; }
        else if (k === 2) { if (y === hs - 1 || x === ws - 1) continue; q = p + ws + 1; }
        else { if (y === hs - 1 || x === 0) continue; q = p + ws - 1; }
        const n = nearest[q];
        if (n < 0) continue;
        const ex = n % ws - x, ey = ((n / ws) | 0) - y;
        const dd = ex * ex + ey * ey;
        if (dd < best) { best = dd; bn = n; }
      }
      dist[p] = best;
      nearest[p] = bn;
    }
  }
  return { step, ws, hs, mask, nearest, edges };
}

export type FitResult = {
  /** Mat cm → frame px. */
  G: Mat3;
  /** Frame px → mat cm. */
  H: Mat3;
  /** Lane edge points that landed on a lane edge (within 1.5 work px), as a fraction of all. */
  score: number;
  /** Of the points in view. */
  inView: number;
  rmsPx: number;
  from: string;
};

const sx = (G: number[], X: number, Y: number) => {
  const w = G[6] * X + G[7] * Y + 1;
  return { u: (G[0] * X + G[1] * Y + G[2]) / w, v: (G[3] * X + G[4] * Y + G[5]) / w, w };
};

/** Solve A·x = b (n×n, row-major) by Gaussian elimination with partial pivoting. */
function solve(A: number[], b: number[], n: number): number[] | null {
  const M = A.slice(), r = b.slice();
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let i = c + 1; i < n; i++) if (Math.abs(M[i * n + c]) > Math.abs(M[piv * n + c])) piv = i;
    if (Math.abs(M[piv * n + c]) < 1e-12) return null;
    if (piv !== c) {
      for (let k = 0; k < n; k++) [M[c * n + k], M[piv * n + k]] = [M[piv * n + k], M[c * n + k]];
      [r[c], r[piv]] = [r[piv], r[c]];
    }
    for (let i = c + 1; i < n; i++) {
      const f = M[i * n + c] / M[c * n + c];
      if (f === 0) continue;
      for (let k = c; k < n; k++) M[i * n + k] -= f * M[c * n + k];
      r[i] -= f * r[c];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = r[i];
    for (let k = i + 1; k < n; k++) s -= M[i * n + k] * x[k];
    x[i] = s / M[i * n + i];
  }
  return x;
}

/**
 * Robust ICP of the model's lane edges onto the frame's lane edges, refining
 * G (normalised model coords → work px). Tukey weights with a shrinking scale.
 */
function icp(g0: number[], mpts: Pt[], inward: Pt[], lf: LaneFrame, scales: number[], iters: number): number[] {
  let g = g0.slice(0, 8);
  const { ws, hs, nearest } = lf;
  for (const scale of scales) {
    for (let it = 0; it < iters; it++) {
      const A = new Array<number>(64).fill(0), b = new Array<number>(8).fill(0);
      let n = 0;
      const cut = 3 * scale;
      for (let mi = 0; mi < mpts.length; mi++) {
        const m = mpts[mi];
        const { u, v, w } = sx(g, m.x, m.y);
        if (!(w > 0) || u < 0 || v < 0 || u >= ws || v >= hs) continue;
        const q = nearest[((v | 0) * ws + (u | 0))];
        if (q < 0) continue;
        const qx = (q % ws) + 0.5, qy = ((q / ws) | 0) + 0.5;
        if (!polarityOk(g, m, inward[mi], qx, qy, lf)) continue;
        const rx = u - qx, ry = v - qy;
        const dd = Math.hypot(rx, ry);
        if (dd > cut) continue;
        const t = dd / cut;
        const wt = (1 - t * t) ** 2;
        const iw = 1 / w;
        // ∂u/∂g, ∂v/∂g
        const ju = [m.x * iw, m.y * iw, iw, 0, 0, 0, -u * m.x * iw, -u * m.y * iw];
        const jv = [0, 0, 0, m.x * iw, m.y * iw, iw, -v * m.x * iw, -v * m.y * iw];
        for (let i = 0; i < 8; i++) {
          b[i] += wt * (ju[i] * rx + jv[i] * ry);
          for (let k = i; k < 8; k++) A[i * 8 + k] += wt * (ju[i] * ju[k] + jv[i] * jv[k]);
        }
        n++;
      }
      if (n < 12) return g;
      for (let i = 0; i < 8; i++) for (let k = 0; k < i; k++) A[i * 8 + k] = A[k * 8 + i];
      for (let i = 0; i < 8; i++) A[i * 9] *= 1.001; // a little damping
      const dx = solve(A, b.map((x) => -x), 8);
      if (!dx) return g;
      g = g.map((x, i) => x + dx[i]);
    }
  }
  return g;
}

/**
 * The edge at (qx, qy) has the lane on the side the model point says: a step
 * into the lane (the model's inward direction, in the frame) lands on lane,
 * a step out does not. Stops outer edges locking onto inner ones.
 */
function polarityOk(g: number[], m: Pt, inward: Pt, qx: number, qy: number, lf: LaneFrame): boolean {
  const a = sx(g, m.x, m.y), b = sx(g, m.x + inward.x * 0.02, m.y + inward.y * 0.02);
  let dx = b.u - a.u, dy = b.v - a.v;
  const L = Math.hypot(dx, dy);
  if (!(L > 0)) return false;
  dx /= L;
  dy /= L;
  const at = (x: number, y: number) => {
    const i = Math.floor(x), j = Math.floor(y);
    return i >= 0 && j >= 0 && i < lf.ws && j < lf.hs ? lf.mask[j * lf.ws + i] : 0;
  };
  return at(qx + 1.5 * dx, qy + 1.5 * dy) === 1 && at(qx - 1.5 * dx, qy - 1.5 * dy) === 0;
}

function scoreG(g: number[], mpts: Pt[], inward: Pt[], lf: LaneFrame): { score: number; inView: number; rms: number } {
  const { ws, hs, nearest } = lf;
  let inl = 0, inView = 0, ss = 0;
  for (let mi = 0; mi < mpts.length; mi++) {
    const m = mpts[mi];
    const { u, v, w } = sx(g, m.x, m.y);
    if (!(w > 0) || u < 0 || v < 0 || u >= ws || v >= hs) continue;
    inView++;
    const q = nearest[((v | 0) * ws + (u | 0))];
    if (q < 0) continue;
    if (!polarityOk(g, m, inward[mi], (q % ws) + 0.5, ((q / ws) | 0) + 0.5, lf)) continue;
    const dd = Math.hypot(u - (q % ws) - 0.5, v - ((q / ws) | 0) - 0.5);
    if (dd <= 1.5) {
      inl++;
      ss += dd * dd;
    }
  }
  return { score: inl / mpts.length, inView: inView / mpts.length, rms: inl ? Math.sqrt(ss / inl) : NaN };
}

/** Normalising transform for model points (centre, scale). */
function modelNorm(model: LaneModel) {
  const cx = model.matWidthCm / 2, cy = model.matHeightCm / 2, s = Math.max(model.matWidthCm, model.matHeightCm) / 2;
  const N: Mat3 = [1 / s, 0, -cx / s, 0, 1 / s, -cy / s, 0, 0, 1];
  const Ninv: Mat3 = [s, 0, cx, 0, s, cy, 0, 0, 1];
  return { N, Ninv, pts: model.pts.map((p) => ({ x: (p.x - cx) / s, y: (p.y - cy) / s })) };
}

const mul = (a: Mat3, b: Mat3): Mat3 => {
  const r = new Array<number>(9);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
  return r;
};
const norm9 = (m: Mat3): Mat3 => m.map((x) => x / m[8]);

export type FitOpts = {
  workWidth?: number;
  /** Last frame's G (mat cm → frame px): track from there. */
  prev?: Mat3;
  /** Mat corners from the outline finder, as another starting point. */
  matQuad?: Quad;
  /** Lowest score to accept. Default 0.25. */
  minScore?: number;
  /** Search from scratch even with `prev`. */
  full?: boolean;
  /** Collects each start's score (diagnostics). */
  debug?: { from: string; score: number }[];
};

/** Fit the lane model to a frame. null when nothing fits well enough. */
export function fitTrack(img: ImageBuf, model: LaneModel, opts: FitOpts = {}, lf = laneFrame(img, opts.workWidth ?? 320)): FitResult | null {
  if (lf.edges < 30) return null;
  const k = lf.step;
  const S: Mat3 = [1 / k, 0, 0, 0, 1 / k, 0, 0, 0, 1]; // frame px → work px
  const Sinv: Mat3 = [k, 0, 0, 0, k, 0, 0, 0, 1];
  const nm = modelNorm(model);
  // G in normalised model → work px
  const toWork = (Gframe: Mat3) => norm9(mul(mul(S, Gframe), nm.Ninv));
  const cands: { g: number[]; from: string }[] = [];
  let best: { g: number[]; score: number; inView: number; rms: number; from: string } | null = null;
  const consider = (g0: Mat3, from: string, scales: number[], iters: number) => {
    if (!g0.every(Number.isFinite)) return;
    const g = icp(g0, nm.pts, model.inward, lf, scales, iters);
    const s = scoreG(g, nm.pts, model.inward, lf);
    opts.debug?.push({ from, score: Math.round(s.score * 1000) / 1000 });
    if (!best || s.score > best.score) best = { g, ...s, from };
  };

  if (opts.prev && !opts.full) {
    consider(toWork(opts.prev), 'prev', [5, 3, 2, 1.5], 2);
    const b = best as { score: number } | null;
    if (b && b.score >= Math.max(0.3, opts.minScore ?? 0.25)) return finish(best!);
  }

  // Precise start: the band's four straight outer edges, intersected, are the
  // corners of the lane's bounding rectangle on the mat (four ways round).
  const bc = bandCorners(lf);
  if (bc) {
    const box = modelBox(model);
    for (let r = 0; r < 4; r++) {
      try {
        const dst = [0, 1, 2, 3].map((i) => bc[(i + r) % 4]);
        const Gw = solveHomography(box, dst); // mat cm → work px
        cands.push({ g: norm9(mul(Gw, nm.Ninv)), from: `band${r}` });
      } catch {
        // degenerate
      }
    }
  }
  // Rough starts from the lane's hull: its 4-point reduction ↔ the model's, four ways round.
  const hullPts: Pt[] = [];
  for (let j = 0; j < lf.hs; j++) {
    let lo = -1, hi = -1;
    for (let i = 0; i < lf.ws; i++) {
      if (!lf.mask[j * lf.ws + i]) continue;
      if (lo < 0) lo = i;
      hi = i;
    }
    if (lo >= 0) hullPts.push({ x: lo + 0.5, y: j + 0.5 }, { x: hi + 0.5, y: j + 0.5 });
  }
  if (hullPts.length >= 8) {
    const iq = reduceToQuad(convexHull(trimOutliers(hullPts, lf)));
    if (iq.length === 4 && quadArea(iq) > 0.01 * lf.ws * lf.hs) {
      for (let r = 0; r < 4; r++) {
        try {
          const src = model.quad.map((p) => ({ x: (p.x - model.matWidthCm / 2) / (Math.max(model.matWidthCm, model.matHeightCm) / 2), y: (p.y - model.matHeightCm / 2) / (Math.max(model.matWidthCm, model.matHeightCm) / 2) }));
          const dst = [0, 1, 2, 3].map((i) => iq[(i + r) % 4]);
          cands.push({ g: solveHomography(src, dst), from: `hull${r}` });
        } catch {
          // degenerate
        }
      }
    }
  }
  if (opts.matQuad) {
    for (let r = 0; r < 4; r++) {
      try {
        const dst = [0, 1, 2, 3].map((i) => opts.matQuad![(i + r) % 4]);
        const Gf = solveHomography([{ x: 0, y: 0 }, { x: model.matWidthCm, y: 0 }, { x: model.matWidthCm, y: model.matHeightCm }, { x: 0, y: model.matHeightCm }], dst);
        cands.push({ g: toWork(Gf), from: `mat${r}` });
      } catch {
        // degenerate
      }
    }
  }
  for (const c of cands) consider(c.g, c.from, [16, 8, 5, 3, 2, 1.5], 3);
  // Restarts around the best start: small shifts, turns and zooms of its
  // picture can get it out of a wrong fit (edges of a neighbouring lane).
  const top = best as { g: number[]; score: number } | null;
  if (top && top.score < 0.85) {
    let seed = 777;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff - 0.5;
    };
    const cx = lf.ws / 2, cy = lf.hs / 2;
    const base: Mat3 = [...top.g, 1];
    for (let i = 0; i < 10; i++) {
      const a = rnd() * 0.12, sc = 1 + rnd() * 0.16, tx = rnd() * 0.08 * lf.ws, ty = rnd() * 0.08 * lf.hs;
      const c = Math.cos(a) * sc, sn = Math.sin(a) * sc;
      // image-space similarity about the centre
      const T: Mat3 = [c, -sn, cx - c * cx + sn * cy + tx, sn, c, cy - sn * cx - c * cy + ty, 0, 0, 1];
      consider(norm9(mul(T, base)), `restart${i}`, [8, 5, 3, 2, 1.5], 3);
    }
  }
  const b = best as { score: number } | null;
  // A first lock needs a clearly good fit; tracking may go lower.
  if (!b || b.score < Math.max(opts.minScore ?? 0.25, 0.4)) return null;
  return finish(best!);

  function finish(r: { g: number[]; score: number; inView: number; rms: number; from: string }): FitResult | null {
    const gw: Mat3 = [...r.g, 1];
    const Gframe = norm9(mul(mul(Sinv, gw), nm.N)); // mat cm → frame px
    const H = mat3Inv(Gframe);
    if (!H) return null;
    // sanity: the mat projects to a convex, positively oriented quad in front of the camera
    const corners = [{ x: 0, y: 0 }, { x: model.matWidthCm, y: 0 }, { x: model.matWidthCm, y: model.matHeightCm }, { x: 0, y: model.matHeightCm }].map((p) => {
      const w = Gframe[6] * p.x + Gframe[7] * p.y + Gframe[8];
      return w > 0 ? applyH(Gframe, p) : null;
    });
    if (corners.some((c) => !c) || quadArea(corners as Pt[]) <= 0) return null;
    return { G: Gframe, H: norm9(H), score: r.score, inView: r.inView, rmsPx: r.rms * k, from: r.from };
  }
}

/** Mat corners (TL, TR, BR, BL) in frame px for a fit. */
export function matCornersOf(G: Mat3, matWidthCm: number, matHeightCm: number): Quad {
  return [{ x: 0, y: 0 }, { x: matWidthCm, y: 0 }, { x: matWidthCm, y: matHeightCm }, { x: 0, y: matHeightCm }].map((p) => applyH(G, p)) as Quad;
}

/** The model's lane bounding rectangle (TL, TR, BR, BL), mat cm. */
function modelBox(model: LaneModel): Pt[] {
  const xs = model.pts.map((p) => p.x), ys = model.pts.map((p) => p.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  return [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
}

/**
 * The lane band's outline as a quadrilateral: per side of the hull's rough
 * quad, the straight part of the band's outer edge found by RANSAC (the band
 * has rounded corners and the zigzag's hairpins), the lines intersected.
 */
export let bandReject = '';
const bandFail = (why: string): null => {
  bandReject = why;
  return null;
};

export function bandCorners(lf: LaneFrame): Pt[] | null {
  const { ws, hs, mask } = lf;
  const pts: Pt[] = [];
  const colMin = new Int32Array(ws).fill(-1), colMax = new Int32Array(ws).fill(-1);
  for (let j = 0; j < hs; j++) {
    let lo = -1, hi = -1;
    for (let i = 0; i < ws; i++) {
      if (!mask[j * ws + i]) continue;
      if (lo < 0) lo = i;
      hi = i;
      if (colMin[i] < 0) colMin[i] = j;
      colMax[i] = j;
    }
    if (lo >= 0) pts.push({ x: lo + 0.5, y: j + 0.5 }, { x: hi + 0.5, y: j + 0.5 });
  }
  for (let i = 0; i < ws; i++) if (colMin[i] >= 0) pts.push({ x: i + 0.5, y: colMin[i] + 0.5 }, { x: i + 0.5, y: colMax[i] + 0.5 });
  const bpts = trimOutliers(pts, lf);
  if (bpts.length < 40) return bandFail('b1');
  const rough = reduceToQuad(convexHull(bpts));
  if (rough.length !== 4) return bandFail('b2');
  let seed = 12345;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const lines: { nx: number; ny: number; c: number }[] = [];
  for (let k = 0; k < 4; k++) {
    const a = rough[k], b = rough[(k + 1) % 4];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 10) return bandFail('b3');
    const ux = (b.x - a.x) / len, uy = (b.y - a.y) / len;
    const cand = bpts.filter((p) => {
      const t = ((p.x - a.x) * ux + (p.y - a.y) * uy) / len;
      const d = Math.abs((p.x - a.x) * -uy + (p.y - a.y) * ux);
      return t > 0.12 && t < 0.88 && d < 0.25 * len;
    });
    if (cand.length < 8) return bandFail('b4');
    let best: { nx: number; ny: number; c: number; n: number } | null = null;
    for (let it = 0; it < 150; it++) {
      const p = cand[Math.floor(rnd() * cand.length)], q = cand[Math.floor(rnd() * cand.length)];
      const L = Math.hypot(q.x - p.x, q.y - p.y);
      if (L < 0.15 * len) continue;
      const lx = (q.x - p.x) / L, ly = (q.y - p.y) / L;
      if (Math.abs(lx * ux + ly * uy) < Math.cos((25 * Math.PI) / 180)) continue;
      const nx = -ly, ny = lx, c = nx * p.x + ny * p.y;
      let n = 0;
      for (const r of cand) if (Math.abs(nx * r.x + ny * r.y - c) < 1) n++;
      if (!best || n > best.n) best = { nx, ny, c, n };
    }
    if (!best || best.n < 8) return bandFail('b5');
    // least squares on the inliers
    const inl = cand.filter((r) => Math.abs(best!.nx * r.x + best!.ny * r.y - best!.c) < 1.2);
    const mx = inl.reduce((s2, r) => s2 + r.x, 0) / inl.length, my = inl.reduce((s2, r) => s2 + r.y, 0) / inl.length;
    let sxx = 0, syy = 0, sxy = 0;
    for (const r of inl) {
      sxx += (r.x - mx) ** 2;
      syy += (r.y - my) ** 2;
      sxy += (r.x - mx) * (r.y - my);
    }
    const th = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    const nx = -Math.sin(th), ny = Math.cos(th);
    lines.push({ nx, ny, c: nx * mx + ny * my });
  }
  const out: Pt[] = [];
  for (let k = 0; k < 4; k++) {
    const l1 = lines[(k + 3) % 4], l2 = lines[k];
    const det = l1.nx * l2.ny - l1.ny * l2.nx;
    if (Math.abs(det) < 1e-6) return bandFail('b6');
    const p = { x: (l1.c * l2.ny - l1.ny * l2.c) / det, y: (l1.nx * l2.c - l1.c * l2.nx) / det };
    if (Math.hypot(p.x - rough[k].x, p.y - rough[k].y) > 0.5 * Math.max(ws, hs)) return bandFail('b7');
    out.push(p);
  }
  return quadArea(out) > 0 ? out : null;
}

/** Keep the hull points of the big lane components only (blue jeans and bags make small ones). */
function trimOutliers(pts: Pt[], lf: LaneFrame): Pt[] {
  // Components by size; keep pixels of those ≥ 15 % of the largest.
  const { ws, hs, mask } = lf;
  const label = new Int32Array(ws * hs);
  const sizes: number[] = [0];
  const queue = new Int32Array(ws * hs);
  for (let p0 = 0; p0 < mask.length; p0++) {
    if (!mask[p0] || label[p0]) continue;
    const id = sizes.length;
    let head = 0, tail = 0;
    queue[tail++] = p0;
    label[p0] = id;
    while (head < tail) {
      const p = queue[head++];
      const x = p % ws;
      if (x > 0 && mask[p - 1] && !label[p - 1]) { label[p - 1] = id; queue[tail++] = p - 1; }
      if (x < ws - 1 && mask[p + 1] && !label[p + 1]) { label[p + 1] = id; queue[tail++] = p + 1; }
      if (p >= ws && mask[p - ws] && !label[p - ws]) { label[p - ws] = id; queue[tail++] = p - ws; }
      if (p + ws < mask.length && mask[p + ws] && !label[p + ws]) { label[p + ws] = id; queue[tail++] = p + ws; }
    }
    sizes.push(tail);
  }
  const big = Math.max(...sizes);
  return pts.filter((p) => {
    const l = label[Math.floor(p.y) * ws + Math.min(ws - 1, Math.floor(p.x))];
    return l > 0 && sizes[l] >= 0.15 * big;
  });
}

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
  return quadArea(hull) < 0 ? hull.reverse() : hull;
}

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
