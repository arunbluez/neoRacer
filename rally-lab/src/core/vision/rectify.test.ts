import { describe, it, expect } from 'vitest';
import { applyH, mat3Inv, normalizeH } from './linalg';
import type { Pt } from './linalg';
import { solveHomography } from './homography';
import { fillDisc, rectify, renderPerspective, sampleBilinear } from './rectify';
import type { ImageBuf } from './rectify';
import { syntheticCameraH } from './synthetic';

const W = 300, Hc = 250;
const CORNERS: Pt[] = [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: Hc }, { x: 0, y: Hc }];

type Rgb = [number, number, number];
// 10×10 cm squares of saturated colours, by centre (cm), and a test for each.
const SQUARES: { c: Pt; rgb: Rgb; is: (r: number, g: number, b: number) => boolean }[] = [
  { c: { x: 30, y: 30 }, rgb: [255, 0, 0], is: (r, g, b) => r > 215 && g < 35 && b < 70 },
  { c: { x: 270, y: 30 }, rgb: [0, 255, 0], is: (r, g, b) => g > 215 && r < 35 && b < 70 },
  { c: { x: 270, y: 220 }, rgb: [0, 0, 255], is: (r, g, b) => b > 215 && r < 35 && g < 35 },
  { c: { x: 30, y: 220 }, rgb: [255, 255, 0], is: (r, g, b) => r > 215 && g > 215 && b < 70 },
  { c: { x: 150, y: 125 }, rgb: [255, 0, 255], is: (r, g, b) => r > 215 && b > 215 && g < 35 },
];

// Top-down test mat at 1 px/cm: smooth gradient plus the squares.
function makeMat(): ImageBuf {
  const data = new Uint8ClampedArray(W * Hc * 4);
  for (let y = 0; y < Hc; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4;
      data[o] = 40 + (x + 0.5) * 0.5;
      data[o + 1] = 50 + (y + 0.5) * 0.6;
      data[o + 2] = 150;
      data[o + 3] = 255;
      for (const s of SQUARES) {
        if (Math.abs(x + 0.5 - s.c.x) < 5 && Math.abs(y + 0.5 - s.c.y) < 5) data.set(s.rgb, o);
      }
    }
  }
  return { width: W, height: Hc, data };
}

function centroid(img: ImageBuf, is: (r: number, g: number, b: number) => boolean): Pt & { n: number } {
  let sx = 0, sy = 0, n = 0;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const o = (y * img.width + x) * 4;
      if (img.data[o + 3] > 0 && is(img.data[o], img.data[o + 1], img.data[o + 2])) {
        sx += x + 0.5;
        sy += y + 0.5;
        n++;
      }
    }
  }
  return { x: sx / n, y: sy / n, n };
}

describe('sampleBilinear', () => {
  const img: ImageBuf = { width: 2, height: 2, data: new Uint8ClampedArray([0, 0, 0, 255, 100, 0, 0, 255, 0, 200, 0, 255, 100, 200, 0, 255]) };
  it('interpolates between pixel centres', () => {
    const out = [0, 0, 0, 0];
    expect(sampleBilinear(img, 0.5, 0.5, out, 0)).toBe(true);
    expect(out).toEqual([0, 0, 0, 255]);
    sampleBilinear(img, 1, 1, out, 0);
    expect(out).toEqual([50, 100, 0, 255]);
    sampleBilinear(img, 2, 2, out, 0); // edge: clamps to the last pixel
    expect(out).toEqual([100, 200, 0, 255]);
  });
  it('rejects points outside the image', () => {
    const out = new Uint8ClampedArray(8);
    expect(sampleBilinear(img, -0.01, 1, out, 4)).toBe(false);
    expect(sampleBilinear(img, 1, 2.01, out, 4)).toBe(false);
    expect(sampleBilinear(img, NaN, 1, out, 4)).toBe(false);
    expect(Array.from(out)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });
});

describe('fillDisc', () => {
  it('fills pixels whose centres lie inside the circle', () => {
    const img: ImageBuf = { width: 40, height: 40, data: new Uint8ClampedArray(40 * 40 * 4) };
    fillDisc(img, 20.3, 17.6, 5, [0, 255, 0]);
    const c = centroid(img, (_r, g) => g === 255);
    expect(Math.abs(c.n - Math.PI * 25)).toBeLessThan(6);
    expect(Math.hypot(c.x - 20.3, c.y - 17.6)).toBeLessThan(0.2);
  });
});

describe('rectify round trip', () => {
  const mat = makeMat();
  const Hcam = syntheticCameraH({
    imageWidth: 1280, imageHeight: 720, hfovDeg: 68,
    eye: { x: 120, y: 420, height: 190 }, target: { x: 160, y: 135 },
  });
  const cam = renderPerspective(mat, W, Hc, normalizeH(mat3Inv(Hcam)!), 1280, 720, [5, 5, 5]);

  it('renders the mat into the camera view and background elsewhere', () => {
    expect(cam.width).toBe(1280);
    expect(Array.from(cam.data.subarray(0, 4))).toEqual([5, 5, 5, 255]); // top-left is beyond the mat
    const c = applyH(Hcam, SQUARES[4].c);
    const o = (Math.floor(c.y) * 1280 + Math.floor(c.x)) * 4;
    expect(Array.from(cam.data.subarray(o, o + 4))).toEqual([255, 0, 255, 255]);
  });

  it('recovers the top-down mat from 4 corner taps', () => {
    const taps = CORNERS.map((p) => applyH(Hcam, p));
    const H = solveHomography(taps, CORNERS); // image px -> mat cm
    const top = rectify(cam, mat3Inv(H)!, W, Hc, 10);
    expect(top.width).toBe(300);
    expect(top.height).toBe(250);

    for (const s of SQUARES) {
      const c = centroid(top, s.is);
      expect(c.n).toBeGreaterThan(20);
      expect(Math.hypot(c.x - s.c.x, c.y - s.c.y)).toBeLessThan(1.5);
    }

    // Interior colours away from the squares match the original closely.
    let sum = 0, n = 0, max = 0;
    for (let y = 4; y < Hc - 4; y++) {
      for (let x = 4; x < W - 4; x++) {
        if (SQUARES.some((s) => Math.abs(x + 0.5 - s.c.x) < 12 && Math.abs(y + 0.5 - s.c.y) < 12)) continue;
        const o = (y * W + x) * 4;
        expect(top.data[o + 3]).toBe(255);
        for (let ch = 0; ch < 3; ch++) {
          const d = Math.abs(top.data[o + ch] - mat.data[o + ch]);
          sum += d;
          n++;
          if (d > max) max = d;
        }
      }
    }
    expect(sum / n).toBeLessThan(1.5);
    expect(max).toBeLessThan(8);
  });

  it('honours mmPerPx and leaves points outside the image transparent', () => {
    // A camera that sees only part of the mat.
    const Hnear = syntheticCameraH({
      imageWidth: 640, imageHeight: 360, hfovDeg: 50,
      eye: { x: 150, y: 300, height: 80 }, target: { x: 150, y: 180 },
    });
    const view = renderPerspective(mat, W, Hc, normalizeH(mat3Inv(Hnear)!), 640, 360, [0, 0, 0]);
    const top = rectify(view, Hnear, W, Hc, 20);
    expect(top.width).toBe(150);
    expect(top.height).toBe(125);
    expect(Array.from(top.data.subarray(0, 4))).toEqual([0, 0, 0, 0]); // far corner not in view
    const o = (110 * 150 + 75) * 4; // mat (151, 221) cm is in view
    expect(top.data[o + 3]).toBe(255);
  });
});
