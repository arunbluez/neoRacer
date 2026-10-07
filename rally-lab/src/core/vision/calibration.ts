// Mat calibration: the homography between camera image pixels and mat cm
// (origin top-left of the mat, x right, y down).

import { applyH, mat3Inv, normalizeH } from './linalg';
import type { Mat3, Pt } from './linalg';
import { errorStats, reprojectionErrors, solveHomography } from './homography';
import type { ClassThresholds } from './color';

export type Landmark = { name: string; xCm: number; yCm: number };

export type TrackCalibration = {
  id: string; createdAt: string;
  cameraId?: string; cameraLabel?: string; cameraSettings?: Record<string, unknown>;
  imageWidth: number; imageHeight: number;
  corners: Pt[];                                   // image px: TL, TR, BR, BL
  extraPoints: { img: Pt; mat: Pt }[];             // up to 8 known points
  matWidthCm: number; matHeightCm: number;
  H: Mat3;                                         // image px -> mat cm
  Hinv: Mat3;                                      // mat cm -> image px
  reprojErrorCm: { rms: number; max: number; perPoint: number[] };
  stillImageId?: string; mapImageId?: string; maskImageId?: string;
  mmPerPx?: number;
  classThresholds?: ClassThresholds;
  classPercentages?: { offtrack: number; border: number; lane: number; other: number };
  landmarks: Landmark[];
  markers?: Record<string, unknown>;               // owned by another module; leave opaque
};

/**
 * Solve the calibration. The corners map to (0,0), (W,0), (W,H), (0,H) cm
 * and go into one least-squares solve with the extra points. perPoint lists
 * the residuals in cm: the 4 corners first, then the extra points (with only
 * the corners the solve is exact and the error is ~0). Throws on bad input.
 */
export function buildCalibration(input: {
  id: string; createdAt: string; imageWidth: number; imageHeight: number; corners: Pt[];
  extraPoints?: { img: Pt; mat: Pt }[]; matWidthCm: number; matHeightCm: number;
  cameraId?: string; cameraLabel?: string; cameraSettings?: Record<string, unknown>;
}): TrackCalibration {
  const { corners, matWidthCm: W, matHeightCm: Hc } = input;
  if (corners.length !== 4) throw new Error('buildCalibration: need exactly 4 corners (TL, TR, BR, BL)');
  if (!(W > 0 && Hc > 0)) throw new Error('buildCalibration: mat size must be positive');
  const extra = input.extraPoints ?? [];
  const src = [...corners, ...extra.map((p) => p.img)];
  const dst = [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: Hc }, { x: 0, y: Hc }, ...extra.map((p) => p.mat)];
  const H = solveHomography(src, dst);
  const inv = mat3Inv(H);
  if (!inv) throw new Error('buildCalibration: singular homography');
  const perPoint = reprojectionErrors(H, src, dst);
  const { rms, max } = errorStats(perPoint);

  const cal: TrackCalibration = {
    id: input.id,
    createdAt: input.createdAt,
    imageWidth: input.imageWidth,
    imageHeight: input.imageHeight,
    corners: corners.map((p) => ({ x: p.x, y: p.y })),
    extraPoints: extra.map((p) => ({ img: { x: p.img.x, y: p.img.y }, mat: { x: p.mat.x, y: p.mat.y } })),
    matWidthCm: W,
    matHeightCm: Hc,
    H,
    Hinv: normalizeH(inv),
    reprojErrorCm: { rms, max, perPoint },
    landmarks: [],
  };
  if (input.cameraId !== undefined) cal.cameraId = input.cameraId;
  if (input.cameraLabel !== undefined) cal.cameraLabel = input.cameraLabel;
  if (input.cameraSettings !== undefined) cal.cameraSettings = input.cameraSettings;
  return cal;
}

/**
 * The mat border in image px (via Hinv): `steps` points per edge, starting at
 * TL and going TL→TR→BR→BL, so point k·steps is corner k. Not closed (the
 * first point is not repeated).
 */
export function matOutline(cal: Pick<TrackCalibration, 'Hinv' | 'matWidthCm' | 'matHeightCm'>, steps = 8): Pt[] {
  const W = cal.matWidthCm, H = cal.matHeightCm, n = Math.max(1, Math.round(steps));
  const c = [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: H }, { x: 0, y: H }];
  const out: Pt[] = [];
  for (let e = 0; e < 4; e++) {
    const a = c[e], b = c[(e + 1) % 4];
    for (let k = 0; k < n; k++) {
      const t = k / n;
      out.push(applyH(cal.Hinv, { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }));
    }
  }
  return out;
}

/** Distance in cm between H(img) and the known mat position, per point, plus stats. */
export function pointErrorsCm(
  cal: { H: Mat3 }, pts: { img: Pt; mat: Pt }[],
): { perPoint: number[]; rms: number; max: number; mean: number } {
  const perPoint = reprojectionErrors(cal.H, pts.map((p) => p.img), pts.map((p) => p.mat));
  return { perPoint, ...errorStats(perPoint) };
}
