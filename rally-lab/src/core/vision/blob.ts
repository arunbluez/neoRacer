// Marker thresholding and connected components. Coordinates follow the
// pixel-centre convention of rectify.ts: pixel (i, j) has centre (i+0.5, j+0.5).

import type { ImageBuf } from './rectify';
import type { MarkerColor } from './color';

/** Pixel rectangle; x1 and y1 are exclusive. */
export type Rect = { x0: number; y0: number; x1: number; y1: number };

/**
 * A connected component. cx, cy: centroid (pixel-centre convention); area in
 * pixels; compactness = area / bbox area (0..1, a disc ≈ 0.79).
 * conf = area/(area + 2·minAreaPx) × min(1, compactness/0.6) × min(1, aspect/0.5),
 * aspect = short/long bbox side: saturates for large round blobs, falls for
 * tiny, sparse or elongated ones.
 */
export type Blob = { cx: number; cy: number; area: number; bbox: Rect; compactness: number; conf: number };

/** Integer rectangle inside [0, width] × [0, height] (outward rounding, never inverted). */
export function clampRect(r: Rect, width: number, height: number): Rect {
  const x0 = Math.max(0, Math.min(width, Math.floor(r.x0)));
  const y0 = Math.max(0, Math.min(height, Math.floor(r.y0)));
  const x1 = Math.max(x0, Math.min(width, Math.ceil(r.x1)));
  const y1 = Math.max(y0, Math.min(height, Math.ceil(r.y1)));
  return { x0, y0, x1, y1 };
}

// Region each reused mask was last written in, so the next call clears only that.
const dirty = new WeakMap<Uint8Array, Rect & { w: number }>();

/**
 * Mask (width·height) with 1 where the pixel matches the marker (see
 * matchesMarker; transparent pixels never match) inside `window`, 0
 * elsewhere. `out` is reused when it is large enough (else a new array is
 * returned); only the area written by the previous call on it is cleared, so
 * nothing but thresholdMarker should write into it.
 */
export function thresholdMarker(img: ImageBuf, m: MarkerColor, window?: Rect, out?: Uint8Array): Uint8Array {
  const { width: w, height: h, data: d } = img;
  const n = w * h;
  let mask: Uint8Array;
  if (out && out.length >= n) {
    mask = out;
    const prev = dirty.get(mask);
    if (!prev || prev.w !== w) mask.fill(0);
    else for (let y = prev.y0; y < prev.y1; y++) mask.fill(0, y * w + prev.x0, y * w + prev.x1);
  } else mask = new Uint8Array(n);

  const r = window ? clampRect(window, w, h) : { x0: 0, y0: 0, x1: w, y1: h };
  const vMin = m.vMin * 255, sMin = m.sMin, tol = m.hTol;
  const hc = ((m.h % 360) + 360) % 360; // so |hue − hc| < 360 below
  for (let y = r.y0; y < r.y1; y++) {
    let p = y * w + r.x0;
    for (let o = p * 4, x = r.x0; x < r.x1; x++, p++, o += 4) {
      const R = d[o], G = d[o + 1], B = d[o + 2];
      // max < vMin, written so dark noisy pixels take no unpredictable branch.
      if ((R < vMin && G < vMin && B < vMin) || d[o + 3] < 128) {
        mask[p] = 0;
        continue;
      }
      const max = R > G ? (R > B ? R : B) : G > B ? G : B;
      const min = R < G ? (R < B ? R : B) : G < B ? G : B;
      const dd = max - min;
      if (dd < sMin * max) {
        mask[p] = 0;
        continue;
      }
      // Inline hue (see color.ts) and circular distance to the marker hue.
      let hue = 0;
      if (dd > 0) {
        if (max === R) hue = (G - B) / dd + (G < B ? 6 : 0);
        else if (max === G) hue = (B - R) / dd + 2;
        else hue = (R - G) / dd + 4;
        hue *= 60;
      }
      let dh = hue - hc;
      if (dh < 0) dh = -dh;
      if (dh > 180) dh = 360 - dh;
      mask[p] = dh <= tol ? 1 : 0;
    }
  }
  dirty.set(mask, { x0: r.x0, y0: r.y0, x1: r.x1, y1: r.y1, w });
  return mask;
}

// Flood-fill queue, shared between calls. It ends up holding every visited
// pixel, which is also the list used to restore the mask afterwards.
let queue = new Int32Array(4096);

/**
 * 8-connected components of mask == 1 inside `window` (components are cut
 * at the window edge), keeping those with area ≥ minAreaPx, sorted by area
 * descending and truncated to maxBlobs. The mask is left unchanged.
 */
export function findBlobs(
  mask: Uint8Array, width: number, height: number, minAreaPx: number, window?: Rect, maxBlobs?: number,
): Blob[] {
  const r = window ? clampRect(window, width, height) : { x0: 0, y0: 0, x1: width, y1: height };
  const { x0: wx0, y0: wy0, x1: wx1, y1: wy1 } = r;
  const blobs: Blob[] = [];
  const minA = Math.max(1, minAreaPx);
  let q = queue, tail = 0;
  for (let y = wy0; y < wy1; y++) {
    for (let p0 = y * width + wx0, pe = y * width + wx1; p0 < pe; p0++) {
      if (mask[p0] !== 1) continue;
      // Breadth-first fill; visited pixels are marked 2.
      mask[p0] = 2;
      const head0 = tail;
      if (tail >= q.length) q = grow(q);
      q[tail++] = p0;
      // Scanning row by row, the seed is in the component's top row.
      const by0 = y;
      let area = 0, sx = 0, sy = 0, bx0 = width, bx1 = 0, by1 = y;
      for (let head = head0; head < tail; head++) {
        const p = q[head];
        const py = (p / width) | 0, px = p - py * width;
        area++;
        sx += px;
        sy += py;
        if (px < bx0) bx0 = px;
        if (px > bx1) bx1 = px;
        if (py > by1) by1 = py;
        const ya = py > wy0 ? py - 1 : py, yb = py < wy1 - 1 ? py + 1 : py;
        const xa = px > wx0 ? px - 1 : px, xb = px < wx1 - 1 ? px + 1 : px;
        for (let ny = ya; ny <= yb; ny++) {
          for (let n = ny * width + xa, ne = ny * width + xb; n <= ne; n++) {
            if (mask[n] !== 1) continue;
            mask[n] = 2;
            if (tail >= q.length) q = grow(q);
            q[tail++] = n;
          }
        }
      }
      if (area < minA) continue;
      const bw = bx1 - bx0 + 1, bh = by1 - by0 + 1;
      const compactness = area / (bw * bh);
      const aspect = bw < bh ? bw / bh : bh / bw;
      const conf = (area / (area + 2 * minAreaPx)) * Math.min(1, compactness / 0.6) * Math.min(1, aspect / 0.5);
      blobs.push({
        cx: sx / area + 0.5, cy: sy / area + 0.5, area,
        bbox: { x0: bx0, y0: by0, x1: bx1 + 1, y1: by1 + 1 }, compactness, conf,
      });
    }
  }
  for (let i = 0; i < tail; i++) mask[q[i]] = 1;
  queue = q;
  blobs.sort((a, b) => b.area - a.area);
  return maxBlobs !== undefined && blobs.length > maxBlobs ? blobs.slice(0, Math.max(0, maxBlobs)) : blobs;
}

function grow(q: Int32Array<ArrayBuffer>): Int32Array<ArrayBuffer> {
  const g = new Int32Array(q.length * 2);
  g.set(q);
  return g;
}
