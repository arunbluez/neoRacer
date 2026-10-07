// What a hand-held view of the mat tells us besides the corners: which way
// round the mat is (by matching the lane pattern), where the phone is (from
// the mat's perspective), and therefore how far a light that sits above the
// mat appears shifted away from the phone.

import { applyH, mat3Inv, type Mat3, type Pt } from './linalg';
import { quadToMat, type Quad } from './matFinder';
import type { ImageBuf } from './rectify';

/** Where the lane band (lane and its white borders) is, on a coarse grid over the mat. */
export type BandGrid = { cellCm: number; cols: number; rows: number; band: Uint8Array; matWidthCm: number; matHeightCm: number };

/** Band grid from the painted lane's centre line. */
export function bandGrid(centerline: Pt[], halfBandCm: number, matWidthCm: number, matHeightCm: number, cellCm = 4): BandGrid {
  const cols = Math.ceil(matWidthCm / cellCm), rows = Math.ceil(matHeightCm / cellCm);
  const band = new Uint8Array(cols * rows);
  const r = Math.ceil(halfBandCm / cellCm) + 1;
  for (const p of centerline) {
    const ci = Math.floor(p.x / cellCm), cj = Math.floor(p.y / cellCm);
    for (let j = Math.max(0, cj - r); j <= Math.min(rows - 1, cj + r); j++) {
      for (let i = Math.max(0, ci - r); i <= Math.min(cols - 1, ci + r); i++) {
        if (Math.hypot((i + 0.5) * cellCm - p.x, (j + 0.5) * cellCm - p.y) <= halfBandCm) band[j * cols + i] = 1;
      }
    }
  }
  return { cellCm, cols, rows, band, matWidthCm, matHeightCm };
}

function maxChannelAt(img: ImageBuf, p: Pt): number {
  const x = Math.floor(p.x), y = Math.floor(p.y);
  if (!(x >= 0 && y >= 0 && x < img.width && y < img.height)) return -1;
  const o = (y * img.width + x) * 4, d = img.data;
  return Math.max(d[o], d[o + 1], d[o + 2]);
}

/**
 * How well the frame matches the expected lane pattern with mat corner 0 at
 * frame corner `rot`: balanced accuracy of "bright" (≥ threshold) against the
 * band grid, 0.5 = chance, 1 = perfect.
 */
export function orientationScore(img: ImageBuf, corners: Quad, rot: number, grid: BandGrid, threshold: number): number {
  const H = quadToMat(corners, rot, grid.matWidthCm, grid.matHeightCm);
  const inv = mat3Inv(H);
  if (!inv) return 0;
  let tp = 0, fn = 0, tn = 0, fp = 0;
  for (let j = 0; j < grid.rows; j++) {
    for (let i = 0; i < grid.cols; i++) {
      const v = maxChannelAt(img, applyH(inv, { x: (i + 0.5) * grid.cellCm, y: (j + 0.5) * grid.cellCm }));
      if (v < 0) continue;
      const bright = v >= threshold;
      if (grid.band[j * grid.cols + i]) {
        if (bright) tp++;
        else fn++;
      } else if (bright) fp++;
      else tn++;
    }
  }
  if (tp + fn === 0 || tn + fp === 0) return 0;
  return 0.5 * (tp / (tp + fn) + tn / (tn + fp));
}

/** Scores for all four ways round, and the best. */
export function bestOrientation(img: ImageBuf, corners: Quad, grid: BandGrid, threshold: number): { rot: number; score: number; scores: number[] } {
  const scores = [0, 1, 2, 3].map((r) => orientationScore(img, corners, r, grid, threshold));
  let rot = 0;
  for (let r = 1; r < 4; r++) if (scores[r] > scores[rot]) rot = r;
  return { rot, score: scores[rot], scores };
}

export type CameraPose = {
  /** Focal length, px (solved from the mat's perspective, else from the assumed field of view). */
  focalPx: number;
  focalSolved: boolean;
  /** Camera centre in mat cm; height above the mat, cm. */
  x: number;
  y: number;
  height: number;
};

/**
 * Camera position from H (frame px → mat cm), assuming square pixels and the
 * principal point at the frame centre. The focal length comes from the two
 * conditions a rectangle's homography must meet (its sides are perpendicular
 * and equally scaled); when the view is too square-on for that, from
 * `assumedHfovDeg`.
 */
export function cameraPose(HimgToMat: Mat3, width: number, height: number, assumedHfovDeg = 68): CameraPose | null {
  const G = mat3Inv(HimgToMat); // mat → image
  if (!G) return null;
  const cx = width / 2, cy = height / 2;
  // Shift the image origin to the principal point: G' = T·G.
  const g = [
    G[0] - cx * G[6], G[1] - cx * G[7], G[2] - cx * G[8],
    G[3] - cy * G[6], G[4] - cy * G[7], G[5] - cy * G[8],
    G[6], G[7], G[8],
  ];
  const [h11, h12, h13, h21, h22, h23, h31, h32, h33] = g;
  const fAssumed = width / 2 / Math.tan((assumedHfovDeg * Math.PI) / 360);
  // Two estimates of f²; keep those in a plausible range (field of view 35°–110°).
  const fMin = width / 2 / Math.tan((110 * Math.PI) / 360), fMax = width / 2 / Math.tan((35 * Math.PI) / 360);
  const ests: number[] = [];
  const d1 = h31 * h32;
  if (Math.abs(d1) > 1e-12) {
    const f2 = -(h11 * h12 + h21 * h22) / d1;
    if (f2 > 0) ests.push(Math.sqrt(f2));
  }
  const d2 = h32 * h32 - h31 * h31;
  if (Math.abs(d2) > 1e-12) {
    const f2 = (h11 * h11 + h21 * h21 - h12 * h12 - h22 * h22) / d2;
    if (f2 > 0) ests.push(Math.sqrt(f2));
  }
  const good = ests.filter((f) => f >= fMin && f <= fMax);
  const f = good.length ? good.reduce((a, b) => a + b, 0) / good.length : fAssumed;
  // K⁻¹·G = λ [r1 r2 t]
  const c1 = [h11 / f, h21 / f, h31], c2 = [h12 / f, h22 / f, h32], c3 = [h13 / f, h23 / f, h33];
  const n1 = Math.hypot(c1[0], c1[1], c1[2]), n2 = Math.hypot(c2[0], c2[1], c2[2]);
  if (!(n1 > 0 && n2 > 0)) return null;
  let lam = 2 / (n1 + n2);
  // The mat must be in front of the camera (t_z > 0).
  if (c3[2] * lam < 0) lam = -lam;
  const r1 = c1.map((v) => v * lam), r2 = c2.map((v) => v * lam), t = c3.map((v) => v * lam);
  // Re-orthogonalise r1, r2 and complete r3 = r1 × r2.
  const r3 = [r1[1] * r2[2] - r1[2] * r2[1], r1[2] * r2[0] - r1[0] * r2[2], r1[0] * r2[1] - r1[1] * r2[0]];
  // C = −Rᵀ t, with R's columns r1 r2 r3.
  const C = [
    -(r1[0] * t[0] + r1[1] * t[1] + r1[2] * t[2]),
    -(r2[0] * t[0] + r2[1] * t[1] + r2[2] * t[2]),
    -(r3[0] * t[0] + r3[1] * t[1] + r3[2] * t[2]),
  ];
  // Mat frame: x right, y towards the viewer, z into the mat; above the mat is z < 0.
  const heightCm = Math.abs(C[2]);
  if (!Number.isFinite(heightCm) || heightCm < 1) return null;
  return { focalPx: f, focalSolved: good.length > 0, x: C[0], y: C[1], height: heightCm };
}

/**
 * A light `heightCm` above the mat is seen where the ray through it meets the
 * mat, i.e. pushed away from the camera. Undo that: the point straight below.
 */
export function correctParallax(seen: Pt, cam: Pick<CameraPose, 'x' | 'y' | 'height'>, heightCm: number): Pt {
  if (!(cam.height > heightCm)) return seen;
  const k = 1 - heightCm / cam.height;
  return { x: cam.x + (seen.x - cam.x) * k, y: cam.y + (seen.y - cam.y) * k };
}

/** Mat cm per frame pixel around a mat point (how fine the view is there). */
export function cmPerPxAt(HimgToMat: Mat3, matPt: Pt): number {
  const G = mat3Inv(HimgToMat);
  if (!G) return NaN;
  const a = applyH(G, matPt), b = applyH(G, { x: matPt.x + 1, y: matPt.y }), c = applyH(G, { x: matPt.x, y: matPt.y + 1 });
  // the coarser direction
  const px = Math.min(Math.hypot(b.x - a.x, b.y - a.y), Math.hypot(c.x - a.x, c.y - a.y));
  return px > 0 ? 1 / px : NaN;
}
