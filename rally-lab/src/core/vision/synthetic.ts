// Synthetic scenes for tests and the simulated camera: a pinhole camera
// looking at the mat plane, and a procedurally drawn rally mat.

import { normalizeH } from './linalg';
import type { Mat3 } from './linalg';
import { hsvToRgb } from './color';
import type { ImageBuf } from './rectify';

export type SyntheticCamera = {
  imageWidth: number;
  imageHeight: number;
  hfovDeg: number;                               // horizontal field of view
  eye: { x: number; y: number; height: number }; // camera position: mat cm, height above the mat
  target: { x: number; y: number };              // mat point on the optical axis
};

type V3 = [number, number, number];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: V3): V3 => {
  const n = Math.sqrt(dot(a, a));
  return [a[0] / n, a[1] / n, a[2] / n];
};

/**
 * Homography mat cm → image px of an ideal pinhole camera (no roll, square
 * pixels, principal point at the image centre; pixel-centre convention).
 */
export function syntheticCameraH(cam: SyntheticCamera): Mat3 {
  // World frame (x, y, z) with z pointing *into* the mat: with x right and y
  // down the mat this frame is right-handed, like the camera's (right, down, forward).
  const eye: V3 = [cam.eye.x, cam.eye.y, -cam.eye.height];
  const f = unit(sub([cam.target.x, cam.target.y, 0], eye));
  const down: V3 = [0, 0, 1];
  const d = unit(sub(down, f.map((v) => v * dot(down, f)) as V3));
  const r = cross(d, f);
  const fx = cam.imageWidth / 2 / Math.tan((cam.hfovDeg * Math.PI) / 360);
  const cx = cam.imageWidth / 2, cy = cam.imageHeight / 2;
  // p_cam = R·(X − eye) with X = (x, y, 0); image = K·p_cam.
  const P = [r, d, f].map((row) => [row[0], row[1], -dot(row, eye)]);
  return normalizeH([
    fx * P[0][0] + cx * P[2][0], fx * P[0][1] + cx * P[2][1], fx * P[0][2] + cx * P[2][2],
    fx * P[1][0] + cy * P[2][0], fx * P[1][1] + cy * P[2][1], fx * P[1][2] + cy * P[2][2],
    P[2][0], P[2][1], P[2][2],
  ]);
}

/**
 * Top-down rally mat at pxPerCm: dark background, an elliptical lane ~40 cm
 * wide shading blue (220°) → purple → pink (330°) around the loop, white
 * border lines 3 cm wide.
 */
export function drawSyntheticMat(pxPerCm: number, matWidthCm = 300, matHeightCm = 250): ImageBuf {
  const w = Math.round(matWidthCm * pxPerCm), h = Math.round(matHeightCm * pxPerCm);
  const data = new Uint8ClampedArray(w * h * 4);
  const cxm = matWidthCm / 2, cym = matHeightCm / 2, ax = matWidthCm * 0.36, ay = matHeightCm * 0.34;
  const k = Math.min(ax, ay);
  for (let j = 0; j < h; j++) {
    const y = (j + 0.5) / pxPerCm;
    for (let i = 0; i < w; i++) {
      const x = (i + 0.5) / pxPerCm;
      const ex = (x - cxm) / ax, ey = (y - cym) / ay;
      const dist = Math.abs(Math.sqrt(ex * ex + ey * ey) - 1) * k; // ≈ cm from the lane centre line
      const o = (j * w + i) * 4;
      if (dist < 20) {
        const t = (Math.atan2(ey, ex) + Math.PI) / (2 * Math.PI);
        const c = hsvToRgb(220 + 110 * (1 - Math.abs(2 * t - 1)), 0.75, 0.85);
        data[o] = c.r;
        data[o + 1] = c.g;
        data[o + 2] = c.b;
      } else if (dist < 23) {
        data[o] = data[o + 1] = data[o + 2] = 245;
      } else {
        data[o] = 18;
        data[o + 1] = 18;
        data[o + 2] = 22;
      }
      data[o + 3] = 255;
    }
  }
  return { width: w, height: h, data };
}
