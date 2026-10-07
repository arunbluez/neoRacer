// Resampling between the camera image and the top-down mat map.
//
// Pixel convention (used throughout core/vision): image coordinates are
// continuous; pixel (i, j) covers [i, i+1) × [j, j+1) and its centre is at
// (i + 0.5, j + 0.5). The image spans [0, width] × [0, height]. Tapped
// points, blob centroids and homographies all use these coordinates, so a
// frame scaled down by k maps to full resolution by multiplying by k.

import { applyH, mat3Inv } from './linalg';
import type { Mat3 } from './linalg';

/** RGBA pixels, row-major, 4 bytes per pixel. */
export type ImageBuf = { width: number; height: number; data: Uint8ClampedArray };

/**
 * Bilinear sample at continuous (x, y); writes RGBA (rounded) to
 * out[outOffset..outOffset+3]. Returns false (writing nothing) when the point
 * lies outside [0, width] × [0, height]. Within half a pixel of the edge the
 * border pixels are repeated.
 */
export function sampleBilinear(
  img: ImageBuf, x: number, y: number, out: Uint8ClampedArray | number[], outOffset: number,
): boolean {
  const w = img.width, h = img.height;
  if (!(x >= 0 && y >= 0 && x <= w && y <= h)) return false; // also rejects NaN
  const fx = x - 0.5, fy = y - 0.5;
  let x0 = Math.floor(fx), y0 = Math.floor(fy);
  const tx = fx - x0, ty = fy - y0;
  let x1 = x0 + 1, y1 = y0 + 1;
  if (x0 < 0) x0 = 0;
  if (y0 < 0) y0 = 0;
  if (x1 > w - 1) x1 = w - 1;
  if (y1 > h - 1) y1 = h - 1;
  if (x0 > w - 1) x0 = w - 1;
  if (y0 > h - 1) y0 = h - 1;
  const d = img.data;
  const i00 = (y0 * w + x0) * 4, i01 = (y0 * w + x1) * 4, i10 = (y1 * w + x0) * 4, i11 = (y1 * w + x1) * 4;
  const w11 = tx * ty, w01 = tx - w11, w10 = ty - w11, w00 = 1 - tx - ty + w11;
  for (let c = 0; c < 4; c++) {
    out[outOffset + c] = (d[i00 + c] * w00 + d[i01 + c] * w01 + d[i10 + c] * w10 + d[i11 + c] * w11 + 0.5) | 0;
  }
  return true;
}

/**
 * Top-down map of the mat. Output pixel (u, v) shows mat point
 * ((u + 0.5)·k, (v + 0.5)·k) cm with k = mmPerPx / 10, looked up in `src`
 * through HmatToImg (mat cm → image px, the inverse of the calibration H).
 * Points that fall outside the source image are transparent (0, 0, 0, 0).
 */
export function rectify(
  src: ImageBuf, HmatToImg: Mat3, matWidthCm: number, matHeightCm: number, mmPerPx: number,
): ImageBuf {
  const outW = Math.max(1, Math.round((matWidthCm * 10) / mmPerPx));
  const outH = Math.max(1, Math.round((matHeightCm * 10) / mmPerPx));
  const out = new Uint8ClampedArray(outW * outH * 4);
  const k = mmPerPx / 10;
  const [h0, h1, h2, h3, h4, h5, h6, h7, h8] = HmatToImg;
  for (let v = 0; v < outH; v++) {
    const yc = (v + 0.5) * k;
    // Numerators and denominator are affine in the column index.
    const bx = h1 * yc + h2 + h0 * 0.5 * k, by = h4 * yc + h5 + h3 * 0.5 * k, bw = h7 * yc + h8 + h6 * 0.5 * k;
    const dx = h0 * k, dy = h3 * k, dw = h6 * k;
    let o = v * outW * 4;
    for (let u = 0; u < outW; u++, o += 4) {
      const w = bw + dw * u;
      sampleBilinear(src, (bx + dx * u) / w, (by + dy * u) / w, out, o);
    }
  }
  return { width: outW, height: outH, data: out };
}

/**
 * What a camera would see: output pixel centres go through HimgToMat to mat
 * cm, then to pixels of `mat` (a top-down image covering the whole mat) and
 * are sampled bilinearly and composited over `background`. Everything off
 * the mat (or beyond the horizon) is `background`. Output is opaque.
 */
export function renderPerspective(
  mat: ImageBuf, matWidthCm: number, matHeightCm: number, HimgToMat: Mat3,
  outW: number, outH: number, background: [number, number, number],
): ImageBuf {
  const out = new Uint8ClampedArray(outW * outH * 4);
  const [h0, h1, h2, h3, h4, h5, h6, h7, h8] = HimgToMat;
  // Image points beyond the horizon map with the opposite sign of w; take
  // the visible sign from the image of the mat centre.
  let sgn = 1;
  const inv = mat3Inv(HimgToMat);
  if (inv) {
    const c = applyH(inv, { x: matWidthCm / 2, y: matHeightCm / 2 });
    sgn = h6 * c.x + h7 * c.y + h8 < 0 ? -1 : 1;
  }
  const sx = mat.width / matWidthCm, sy = mat.height / matHeightCm;
  const [br, bg, bb] = background;
  for (let v = 0; v < outH; v++) {
    const yi = v + 0.5;
    let o = v * outW * 4;
    for (let u = 0; u < outW; u++, o += 4) {
      const xi = u + 0.5;
      const w = h6 * xi + h7 * yi + h8;
      let hit = false;
      if (w * sgn > 0) {
        const xc = (h0 * xi + h1 * yi + h2) / w, yc = (h3 * xi + h4 * yi + h5) / w;
        if (xc >= 0 && yc >= 0 && xc <= matWidthCm && yc <= matHeightCm) hit = sampleBilinear(mat, xc * sx, yc * sy, out, o);
      }
      if (!hit) {
        out[o] = br;
        out[o + 1] = bg;
        out[o + 2] = bb;
      } else if (out[o + 3] < 255) {
        const a = out[o + 3] / 255;
        out[o] = out[o] * a + br * (1 - a);
        out[o + 1] = out[o + 1] * a + bg * (1 - a);
        out[o + 2] = out[o + 2] * a + bb * (1 - a);
      }
      out[o + 3] = 255;
    }
  }
  return { width: outW, height: outH, data: out };
}

/** Paint every pixel whose centre lies within r of (cx, cy); alpha 255. */
export function fillDisc(img: ImageBuf, cx: number, cy: number, r: number, rgb: [number, number, number]): void {
  const { width: w, height: h, data } = img;
  const i0 = Math.max(0, Math.floor(cx - r)), i1 = Math.min(w - 1, Math.ceil(cx + r));
  const j0 = Math.max(0, Math.floor(cy - r)), j1 = Math.min(h - 1, Math.ceil(cy + r));
  const r2 = r * r;
  for (let j = j0; j <= j1; j++) {
    const dy = j + 0.5 - cy;
    for (let i = i0; i <= i1; i++) {
      const dx = i + 0.5 - cx;
      if (dx * dx + dy * dy > r2) continue;
      const o = (j * w + i) * 4;
      data[o] = rgb[0];
      data[o + 1] = rgb[1];
      data[o + 2] = rgb[2];
      data[o + 3] = 255;
    }
  }
}
