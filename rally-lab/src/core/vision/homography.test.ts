import { describe, it, expect } from 'vitest';
import { applyH, mat3Inv, mat3Mul, normalizeH } from './linalg';
import type { Pt } from './linalg';
import { errorStats, reprojectionErrors, solveHomography } from './homography';
import { syntheticCameraH } from './synthetic';

function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const W = 300, Hc = 250;
const CORNERS: Pt[] = [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: Hc }, { x: 0, y: Hc }];

// Tripod behind the near edge of the mat, jittered; mat cm -> 1280×720 px.
function randomCamera(r: () => number) {
  const j = (s: number) => (r() * 2 - 1) * s;
  return syntheticCameraH({
    imageWidth: 1280, imageHeight: 720, hfovDeg: 68 + j(4),
    eye: { x: 150 + j(40), y: 430 + j(30), height: 200 + j(25) },
    target: { x: 150 + j(15), y: 140 + j(15) },
  });
}

const grid: Pt[] = [];
for (let y = 0; y <= Hc; y += 25) for (let x = 0; x <= W; x += 25) grid.push({ x, y });

/** Max image-px distance between two mat→image maps over the mat. */
function pxDiffs(A: number[], B: number[]): number[] {
  return grid.map((p) => {
    const a = applyH(A, p), b = applyH(B, p);
    return Math.hypot(a.x - b.x, a.y - b.y);
  });
}
const maxPxDiff = (A: number[], B: number[]) => Math.max(...pxDiffs(A, B));

describe('solveHomography', () => {
  it('is exact for 4 points of an oblique view', () => {
    const r = rng(42);
    for (let k = 0; k < 10; k++) {
      const Hcam = randomCamera(r);
      const img = CORNERS.map((p) => applyH(Hcam, p));
      for (const p of img) {
        expect(p.x).toBeGreaterThan(0);
        expect(p.x).toBeLessThan(1280);
        expect(p.y).toBeGreaterThan(0);
        expect(p.y).toBeLessThan(720);
      }
      const H = solveHomography(img, CORNERS); // image px -> mat cm
      expect(H[8]).toBe(1);
      expect(Math.max(...reprojectionErrors(H, img, CORNERS))).toBeLessThan(1e-6);
      expect(maxPxDiff(mat3Inv(H)!, Hcam)).toBeLessThan(0.1);
      // H ∘ Hcam is the identity up to scale.
      const I = normalizeH(mat3Mul(H, Hcam));
      [1, 0, 0, 0, 1, 0, 0, 0, 1].forEach((v, i) => expect(I[i]).toBeCloseTo(v, 6));
    }
  });

  it('fits 12 noisy points in the least-squares sense', () => {
    const r = rng(3);
    const Hcam = randomCamera(r);
    const mat: Pt[] = [];
    for (let y = 0; y < 3; y++) for (let x = 0; x < 4; x++) mat.push({ x: 20 + x * 85, y: 20 + y * 100 });
    const img = mat.map((p) => {
      const q = applyH(Hcam, p);
      return { x: q.x + (r() - 0.5), y: q.y + (r() - 0.5) };
    });
    const H = solveHomography(img, mat);
    const Hinv = mat3Inv(H)!;
    const pxErr = errorStats(reprojectionErrors(Hinv, mat, img));
    expect(pxErr.rms).toBeGreaterThan(0.05);
    expect(pxErr.rms).toBeLessThan(0.6);
    // Against the true camera over the whole mat (corners are extrapolated).
    const d = errorStats(pxDiffs(Hinv, Hcam));
    expect(d.mean).toBeLessThan(0.6);
    expect(d.max).toBeLessThan(2);
    expect(errorStats(reprojectionErrors(H, img, mat)).rms).toBeLessThan(1); // cm
  });

  it('round-trips H ∘ H⁻¹', () => {
    const H = solveHomography(CORNERS.map((p) => applyH(randomCamera(rng(9)), p)), CORNERS);
    const I = mat3Mul(H, mat3Inv(H)!);
    [1, 0, 0, 0, 1, 0, 0, 0, 1].forEach((v, i) => expect(I[i]).toBeCloseTo(v, 9));
  });

  it('throws on too few, mismatched or degenerate points', () => {
    const ok: Pt[] = [{ x: 10, y: 10 }, { x: 200, y: 20 }, { x: 220, y: 180 }, { x: 5, y: 170 }];
    expect(() => solveHomography(ok.slice(0, 3), CORNERS.slice(0, 3))).toThrow();
    expect(() => solveHomography(ok, CORNERS.slice(0, 3))).toThrow();
    const line = [0, 1, 2, 3].map((i) => ({ x: i * 10, y: i * 5 + 3 }));
    expect(() => solveHomography(line, CORNERS)).toThrow();
    expect(() => solveHomography(CORNERS, line)).toThrow();
    const three = [{ x: 0, y: 0 }, { x: 50, y: 50 }, { x: 100, y: 100 }, { x: 0, y: 100 }];
    expect(() => solveHomography(three, CORNERS)).toThrow();
    const longLine = [0, 1, 2, 3, 4, 5].map((i) => ({ x: i * 7, y: 2 * i }));
    expect(() => solveHomography(longLine, longLine.map((p) => ({ x: p.y, y: p.x })))).toThrow();
    expect(() => solveHomography([...ok.slice(0, 3), { x: NaN, y: 0 }], CORNERS)).toThrow();
  });
});

describe('errorStats', () => {
  it('computes rms, max and mean', () => {
    expect(errorStats([3, 4])).toEqual({ rms: Math.sqrt(12.5), max: 4, mean: 3.5 });
    expect(errorStats([])).toEqual({ rms: 0, max: 0, mean: 0 });
  });
});
