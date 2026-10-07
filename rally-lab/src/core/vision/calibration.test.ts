import { describe, it, expect } from 'vitest';
import { applyH } from './linalg';
import type { Pt } from './linalg';
import { buildCalibration, matOutline, pointErrorsCm } from './calibration';
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
const Hcam = syntheticCameraH({
  imageWidth: 1280, imageHeight: 720, hfovDeg: 70,
  eye: { x: 170, y: 440, height: 210 }, target: { x: 140, y: 130 },
});
const corners = [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: Hc }, { x: 0, y: Hc }].map((p) => applyH(Hcam, p));
const base = { id: 'cal-1', createdAt: '2026-10-07T10:00:00Z', imageWidth: 1280, imageHeight: 720, corners, matWidthCm: W, matHeightCm: Hc };

describe('buildCalibration', () => {
  it('solves 4 corners exactly', () => {
    const cal = buildCalibration({ ...base, cameraLabel: 'Back camera' });
    expect(cal.reprojErrorCm.perPoint).toHaveLength(4);
    expect(cal.reprojErrorCm.max).toBeLessThan(1e-6);
    expect(cal.H[8]).toBe(1);
    expect(cal.Hinv[8]).toBe(1);
    expect(cal.landmarks).toEqual([]);
    expect(cal.extraPoints).toEqual([]);
    expect(cal.cameraLabel).toBe('Back camera');
    expect('cameraId' in cal).toBe(false);
    const c = applyH(cal.H, applyH(Hcam, { x: 123, y: 45 }));
    expect(c.x).toBeCloseTo(123, 6);
    expect(c.y).toBeCloseTo(45, 6);
  });

  it('reports the noise of extra points', () => {
    const r = rng(17);
    const mat: Pt[] = [
      { x: 75, y: 60 }, { x: 150, y: 60 }, { x: 225, y: 60 }, { x: 75, y: 190 },
      { x: 150, y: 190 }, { x: 225, y: 190 }, { x: 150, y: 125 }, { x: 40, y: 125 },
    ];
    const extraPoints = mat.map((m) => {
      const q = applyH(Hcam, m);
      return { img: { x: q.x + (r() - 0.5) * 2, y: q.y + (r() - 0.5) * 2 }, mat: m }; // ±1 px
    });
    const cal = buildCalibration({ ...base, extraPoints });
    expect(cal.reprojErrorCm.perPoint).toHaveLength(12);
    expect(cal.reprojErrorCm.rms).toBeGreaterThan(0.05);
    expect(cal.reprojErrorCm.rms).toBeLessThan(1.5);
    expect(cal.reprojErrorCm.max).toBeGreaterThanOrEqual(cal.reprojErrorCm.rms);

    // The calibration check: noise-free points measure the calibration error itself.
    const check = pointErrorsCm(cal, [{ x: 100, y: 100 }, { x: 200, y: 150 }].map((m) => ({ img: applyH(Hcam, m), mat: m })));
    expect(check.perPoint).toHaveLength(2);
    expect(check.max).toBeLessThan(1);
    expect(check.mean).toBeLessThanOrEqual(check.max);
    const exact = pointErrorsCm(buildCalibration(base), [{ img: applyH(Hcam, { x: 10, y: 20 }), mat: { x: 10, y: 20 } }]);
    expect(exact.rms).toBeLessThan(1e-6);
  });

  it('rejects bad input', () => {
    expect(() => buildCalibration({ ...base, corners: corners.slice(0, 3) })).toThrow();
    expect(() => buildCalibration({ ...base, matWidthCm: 0 })).toThrow();
  });
});

describe('matOutline', () => {
  it('starts each edge on a corner', () => {
    const cal = buildCalibration(base);
    const out = matOutline(cal, 10);
    expect(out).toHaveLength(40);
    for (let k = 0; k < 4; k++) {
      expect(out[k * 10].x).toBeCloseTo(corners[k].x, 6);
      expect(out[k * 10].y).toBeCloseTo(corners[k].y, 6);
    }
    // Points in between lie on the projected edge.
    const mid = out[5], want = applyH(Hcam, { x: W / 2, y: 0 });
    expect(Math.hypot(mid.x - want.x, mid.y - want.y)).toBeLessThan(1e-6);
  });
});
