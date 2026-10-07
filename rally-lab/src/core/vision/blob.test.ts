import { describe, it, expect } from 'vitest';
import { clampRect, findBlobs, thresholdMarker } from './blob';
import { fillDisc } from './rectify';
import type { ImageBuf } from './rectify';
import { rgbToHsv } from './color';
import type { MarkerColor } from './color';

function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const W = 640, H = 360;
const GREEN: [number, number, number] = [40, 230, 70];
const g = rgbToHsv(...GREEN);
const MARKER: MarkerColor = { h: g.h, s: g.s, v: g.v, hTol: 18, sMin: 0.4, vMin: 0.4 };
const TRUE = { x: 321.3, y: 187.7 }, DECOY = { x: 100.2, y: 50.6 };

// Noisy dark/blue background, a green disc r=5, a smaller decoy r=3 and green speckles.
function makeFrame(): ImageBuf {
  const r = rng(11);
  const data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    const blue = r() < 0.3;
    data[i * 4] = 20 + r() * 30;
    data[i * 4 + 1] = 20 + r() * 30;
    data[i * 4 + 2] = blue ? 150 + r() * 80 : 25 + r() * 30;
    data[i * 4 + 3] = 255;
  }
  const img = { width: W, height: H, data };
  fillDisc(img, TRUE.x, TRUE.y, 5, GREEN);
  fillDisc(img, DECOY.x, DECOY.y, 3, GREEN);
  for (let k = 0; k < 200; k++) {
    const x = Math.floor(r() * W), y = Math.floor(r() * H);
    if (Math.hypot(x - TRUE.x, y - TRUE.y) > 12) data.set([50, 220, 60], (y * W + x) * 4);
  }
  return img;
}

describe('clampRect', () => {
  it('rounds outwards and clamps to the image', () => {
    expect(clampRect({ x0: -5.5, y0: 2.2, x1: 10.1, y1: 400 }, 640, 360)).toEqual({ x0: 0, y0: 2, x1: 11, y1: 360 });
    expect(clampRect({ x0: 700, y0: 10, x1: 800, y1: 5 }, 640, 360)).toEqual({ x0: 640, y0: 10, x1: 640, y1: 10 });
  });
});

describe('thresholdMarker + findBlobs', () => {
  const img = makeFrame();

  it('finds the largest blob with an accurate centroid', () => {
    const mask = thresholdMarker(img, MARKER);
    const blobs = findBlobs(mask, W, H, 6);
    expect(blobs.length).toBe(2); // speckles are below the area threshold
    const b = blobs[0];
    expect(Math.hypot(b.cx - TRUE.x, b.cy - TRUE.y)).toBeLessThan(0.5);
    expect(Math.abs(b.area - Math.PI * 25)).toBeLessThan(8);
    expect(b.compactness).toBeGreaterThan(0.7);
    expect(b.compactness).toBeLessThanOrEqual(1);
    expect(b.conf).toBeGreaterThan(0.8);
    expect(b.conf).toBeLessThanOrEqual(1);
    expect(blobs[1].area).toBeLessThan(b.area);
    expect(blobs[1].conf).toBeLessThan(b.conf);
    expect(Math.hypot(blobs[1].cx - DECOY.x, blobs[1].cy - DECOY.y)).toBeLessThan(0.5);
    expect(findBlobs(mask, W, H, 6, undefined, 1)).toHaveLength(1);
    // findBlobs leaves the mask intact.
    expect(findBlobs(mask, W, H, 6)).toEqual(blobs);
  });

  it('respects the area threshold', () => {
    const mask = thresholdMarker(img, MARKER);
    const big = findBlobs(mask, W, H, 40);
    expect(big).toHaveLength(1);
    expect(Math.hypot(big[0].cx - TRUE.x, big[0].cy - TRUE.y)).toBeLessThan(0.5);
    expect(findBlobs(mask, W, H, 1).length).toBeGreaterThan(100); // the speckles
  });

  it('searches only inside the window and reuses the mask buffer', () => {
    const out = new Uint8Array(W * H);
    const win = { x0: TRUE.x - 60, y0: TRUE.y - 60, x1: TRUE.x + 60, y1: TRUE.y + 60 };
    let mask = thresholdMarker(img, MARKER, win, out);
    expect(mask).toBe(out);
    const inWin = findBlobs(mask, W, H, 6, win);
    expect(inWin).toHaveLength(1);
    expect(Math.hypot(inWin[0].cx - TRUE.x, inWin[0].cy - TRUE.y)).toBeLessThan(0.5);
    // Nothing outside the window was set.
    expect(findBlobs(mask, W, H, 6)).toHaveLength(1);

    const win2 = { x0: DECOY.x - 20, y0: DECOY.y - 20, x1: DECOY.x + 20, y1: DECOY.y + 20 };
    mask = thresholdMarker(img, MARKER, win2, out);
    expect(mask).toBe(out);
    const all = findBlobs(mask, W, H, 6); // the previous window was cleared
    expect(all).toHaveLength(1);
    expect(Math.hypot(all[0].cx - DECOY.x, all[0].cy - DECOY.y)).toBeLessThan(0.5);
    // Every set pixel lies inside the second window (speckles included).
    const pieces = findBlobs(mask, W, H, 1);
    expect(mask.reduce((s, v) => s + v, 0)).toBe(pieces.reduce((s, b) => s + b.area, 0));
    for (const p of pieces) {
      expect(p.bbox.x0).toBeGreaterThanOrEqual(Math.floor(win2.x0));
      expect(p.bbox.x1).toBeLessThanOrEqual(Math.ceil(win2.x1));
      expect(p.bbox.y0).toBeGreaterThanOrEqual(Math.floor(win2.y0));
      expect(p.bbox.y1).toBeLessThanOrEqual(Math.ceil(win2.y1));
    }
  });

  it('labels 8-connected shapes as one blob and cuts at the window edge', () => {
    const mask = new Uint8Array(10 * 10);
    for (let i = 0; i < 6; i++) mask[i * 10 + i] = 1; // diagonal line
    const b = findBlobs(mask, 10, 10, 1);
    expect(b).toHaveLength(1);
    expect(b[0].area).toBe(6);
    expect(b[0].bbox).toEqual({ x0: 0, y0: 0, x1: 6, y1: 6 });
    expect(b[0].cx).toBeCloseTo(3, 12);
    expect(findBlobs(mask, 10, 10, 1, { x0: 0, y0: 0, x1: 3, y1: 3 })[0].area).toBe(3);
  });
});
