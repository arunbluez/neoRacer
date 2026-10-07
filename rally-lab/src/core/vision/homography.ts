// Planar homography by the normalised DLT (Hartley & Zisserman, alg. 4.2).

import { jacobiEigen, mat3Mul, normalizeH, applyH } from './linalg';
import type { Mat3, Pt } from './linalg';

type Normalized = { xs: Float64Array; ys: Float64Array; s: number; cx: number; cy: number };

// Hartley normalisation: centroid to the origin, mean distance from it √2.
function normalizePoints(pts: Pt[], what: string): Normalized {
  const n = pts.length;
  let cx = 0, cy = 0;
  for (const p of pts) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) throw new Error(`solveHomography: non-finite ${what} point`);
    cx += p.x;
    cy += p.y;
  }
  cx /= n;
  cy /= n;
  let md = 0;
  for (const p of pts) md += Math.hypot(p.x - cx, p.y - cy);
  md /= n;
  if (!(md > 0)) throw new Error(`solveHomography: degenerate ${what} points (all coincide)`);
  const s = Math.SQRT2 / md;
  const xs = new Float64Array(n), ys = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    xs[i] = (pts[i].x - cx) * s;
    ys[i] = (pts[i].y - cy) * s;
  }

  // All points on one line: the 2×2 scatter matrix has a ~zero eigenvalue.
  let sxx = 0, syy = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += xs[i] * xs[i];
    syy += ys[i] * ys[i];
    sxy += xs[i] * ys[i];
  }
  const tr = (sxx + syy) / n;
  const disc = Math.sqrt(((sxx - syy) / n) ** 2 + 4 * (sxy / n) ** 2);
  if ((tr - disc) / 2 < 1e-10) throw new Error(`solveHomography: degenerate ${what} points (collinear)`);

  // With exactly four points no three may be collinear.
  if (n === 4) {
    for (let a = 0; a < 4; a++) {
      const i = (a + 1) % 4, j = (a + 2) % 4, k = (a + 3) % 4;
      const area2 = (xs[j] - xs[i]) * (ys[k] - ys[i]) - (ys[j] - ys[i]) * (xs[k] - xs[i]);
      if (Math.abs(area2) < 1e-6) throw new Error(`solveHomography: degenerate ${what} points (three collinear)`);
    }
  }
  return { xs, ys, s, cx, cy };
}

/**
 * Homography H with H(src[i]) ≈ dst[i]. Exact for 4 pairs, algebraic least
 * squares for more. Result normalised so H[8] = 1. Throws on fewer than 4
 * pairs, mismatched lengths, non-finite or degenerate (collinear) input.
 */
export function solveHomography(src: Pt[], dst: Pt[]): Mat3 {
  const n = src.length;
  if (n < 4) throw new Error(`solveHomography: need at least 4 point pairs, got ${n}`);
  if (dst.length !== n) throw new Error('solveHomography: src and dst lengths differ');
  const S = normalizePoints(src, 'source');
  const D = normalizePoints(dst, 'destination');

  // Normal matrix AᵀA of the 2n×9 DLT system, accumulated row pair by row pair.
  const M = Array.from({ length: 9 }, () => new Array<number>(9).fill(0));
  const r1 = new Array<number>(9).fill(0), r2 = new Array<number>(9).fill(0);
  for (let i = 0; i < n; i++) {
    const x = S.xs[i], y = S.ys[i], u = D.xs[i], v = D.ys[i];
    r1[0] = -x; r1[1] = -y; r1[2] = -1; r1[6] = u * x; r1[7] = u * y; r1[8] = u;
    r2[3] = -x; r2[4] = -y; r2[5] = -1; r2[6] = v * x; r2[7] = v * y; r2[8] = v;
    for (let a = 0; a < 9; a++) {
      for (let b = a; b < 9; b++) M[a][b] += r1[a] * r1[b] + r2[a] * r2[b];
    }
  }
  for (let a = 0; a < 9; a++) for (let b = 0; b < a; b++) M[a][b] = M[b][a];

  // Solution: eigenvector of the smallest eigenvalue. A second ~zero
  // eigenvalue means the points do not pin down a unique homography.
  const { values, vectors } = jacobiEigen(M);
  if (!(values[1] > 1e-12 * values[8])) throw new Error('solveHomography: degenerate configuration');
  const h = vectors[0];
  const det =
    h[0] * (h[4] * h[8] - h[5] * h[7]) - h[1] * (h[3] * h[8] - h[5] * h[6]) + h[2] * (h[3] * h[7] - h[4] * h[6]);
  if (Math.abs(det) < 1e-9) throw new Error('solveHomography: degenerate configuration (singular)');

  // Undo the normalisation: H = T_dst⁻¹ · Hn · T_src.
  const Ts: Mat3 = [S.s, 0, -S.s * S.cx, 0, S.s, -S.s * S.cy, 0, 0, 1];
  const TdInv: Mat3 = [1 / D.s, 0, D.cx, 0, 1 / D.s, D.cy, 0, 0, 1];
  return normalizeH(mat3Mul(mat3Mul(TdInv, h), Ts));
}

/** |H(src[i]) − dst[i]| for each pair, in dst units. */
export function reprojectionErrors(H: Mat3, src: Pt[], dst: Pt[]): number[] {
  return src.map((p, i) => {
    const q = applyH(H, p);
    return Math.hypot(q.x - dst[i].x, q.y - dst[i].y);
  });
}

export function errorStats(errs: number[]): { rms: number; max: number; mean: number } {
  if (errs.length === 0) return { rms: 0, max: 0, mean: 0 };
  let s = 0, s2 = 0, max = 0;
  for (const e of errs) {
    s += e;
    s2 += e * e;
    if (e > max) max = e;
  }
  return { rms: Math.sqrt(s2 / errs.length), max, mean: s / errs.length };
}
