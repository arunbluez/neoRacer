import { describe, expect, it } from 'vitest';
import * as fits from './fits';
import { arcade, tiltToStick } from './drive';
import { alongAndSide, circleFit, radiusFromChord, steadySpeed, trackWidthFromArc, trimFromDrift, unwrapDeg } from './fits';
import { cmPerSFor, upsertTable } from './profile';

describe('drive mixing', () => {
  const cfg = { speedCap: 100, expo: 0, trim: 0 };
  it('mixes throttle and turn', () => {
    expect(arcade(0, 1, cfg)).toEqual({ l: 100, r: 100 });
    expect(arcade(0, -1, cfg)).toEqual({ l: -100, r: -100 });
    expect(arcade(0, 0, cfg)).toEqual({ l: 0, r: 0 });
    const right = arcade(1, 0, cfg);
    expect(right.l).toBeGreaterThan(0);
    expect(right.r).toBeLessThan(0);
    const fr = arcade(0.5, 1, cfg);
    expect(fr.l).toBe(100);
    expect(fr.r).toBeLessThan(100);
  });
  it('caps, curves and trims', () => {
    expect(arcade(0, 1, { ...cfg, speedCap: 60 })).toEqual({ l: 60, r: 60 });
    expect(arcade(0, 0.5, { ...cfg, expo: 1 }).l).toBe(13); // 0.125 * 100
    const t = arcade(0, 0.5, { ...cfg, trim: 0.1 });
    expect(t).toEqual({ l: 50, r: 55 });
    const full = arcade(0, 1, { ...cfg, trim: 0.1 });
    expect(full.r).toBe(100);
    expect(full.l).toBe(91);
  });
  it('maps tilt with a dead zone', () => {
    expect(tiltToStick(30, 0, { beta: 30, gamma: 0 }, 30)).toEqual({ x: 0, y: 0 });
    expect(tiltToStick(0, 32, { beta: 30, gamma: 0 }, 30)).toEqual({ x: 1, y: 1 });
  });
});

describe('fits', () => {
  it('fits a circle', () => {
    const pts = Array.from({ length: 20 }, (_, i) => ({ x: 10 + 25 * Math.cos(i / 6), y: -4 + 25 * Math.sin(i / 6) }));
    const c = circleFit(pts)!;
    expect(c.r).toBeCloseTo(25, 6);
    expect(c.cx).toBeCloseTo(10, 6);
    expect(circleFit([{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }])).toBeNull();
  });
  it('splits displacement along and to the side', () => {
    // heading +x; +y is the robot's right on a y-down mat
    expect(alongAndSide({ x: 0, y: 0 }, 0, { x: 50, y: 3 })).toEqual({ along: 50, side: 3 });
    const r = alongAndSide({ x: 0, y: 0 }, 90, { x: -2, y: 40 });
    expect(r.along).toBeCloseTo(40);
    expect(r.side).toBeCloseTo(2);
  });
  it('estimates steady speed and unwraps angles', () => {
    const pts = Array.from({ length: 30 }, (_, i) => ({ t: i * 33, x: i * 33 * 0.03, y: 0 }));
    expect(steadySpeed(pts, 0, 1000)).toBeCloseTo(30, 6);
    expect(unwrapDeg([170, -170, -150, 179])).toEqual([170, 190, 210, 179]); // -150 -> 179 is a 31° step back
    expect(unwrapDeg([0, 120, 240, 0])).toEqual([0, 120, 240, 360]);
  });
  it('trim, track width and chord radius', () => {
    // drifting right (side > 0) needs a faster right wheel (positive trim)
    expect(trimFromDrift(60, 3, 9)).toBeCloseTo((2 * 3 / 3600) * 9);
    expect(trackWidthFromArc(30, 15, 22.5, 13.5)).toBeCloseTo(9);
    expect(radiusFromChord(Math.SQRT2 * 20, 90)).toBeCloseTo(20);
  });
});

describe('profile tables', () => {
  it('interpolates the speed table', () => {
    const p = { speedTable: [{ cmd: 30, cmPerS: 10 }, { cmd: 50, cmPerS: 20 }, { cmd: 100, cmPerS: 45 }] };
    expect(cmPerSFor(p, 40)).toBe(15);
    expect(cmPerSFor(p, -40)).toBe(-15);
    expect(cmPerSFor(p, 15)).toBe(5);
    expect(cmPerSFor({}, 40)).toBeUndefined();
    expect(upsertTable(p.speedTable, { cmd: 50, cmPerS: 21 })).toEqual([{ cmd: 30, cmPerS: 10 }, { cmd: 50, cmPerS: 21 }, { cmd: 100, cmPerS: 45 }]);
  });
});

describe('signed curvature', () => {
  it('is positive for a path bending right on a y-down mat', () => {
    // heading +x, bending toward +y (the robot's right): circle of radius 200 centred below
    const right = Array.from({ length: 30 }, (_, i) => {
      const a = -Math.PI / 2 + i * 0.01;
      return { x: 200 * Math.cos(a), y: 200 + 200 * Math.sin(a) };
    });
    const { signedCurvature } = fits;
    expect(signedCurvature(right)).toBeCloseTo(1 / 200, 5);
    expect(signedCurvature(right.map((p) => ({ x: p.x, y: -p.y })))).toBeCloseTo(-1 / 200, 5);
    expect(signedCurvature(Array.from({ length: 10 }, (_, i) => ({ x: i, y: 0 })))).toBe(0);
  });
});
