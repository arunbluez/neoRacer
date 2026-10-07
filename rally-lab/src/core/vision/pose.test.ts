import { describe, it, expect } from 'vitest';
import { AlphaBetaPoseFilter, angleDiffDeg, wrapDeg } from './pose';

describe('angles', () => {
  it('wraps to (-180, 180]', () => {
    expect(wrapDeg(0)).toBe(0);
    expect(wrapDeg(180)).toBe(180);
    expect(wrapDeg(-180)).toBe(180);
    expect(wrapDeg(190)).toBe(-170);
    expect(wrapDeg(-190)).toBe(170);
    expect(wrapDeg(540)).toBe(180);
    expect(wrapDeg(359)).toBe(-1);
    expect(wrapDeg(-720)).toBe(0);
  });
  it('takes the short way round', () => {
    expect(angleDiffDeg(-170, 170)).toBe(20);
    expect(angleDiffDeg(170, -170)).toBe(-20);
    expect(angleDiffDeg(90, 0)).toBe(90);
  });
});

describe('AlphaBetaPoseFilter', () => {
  it('tracks constant velocity and derives heading from motion', () => {
    const f = new AlphaBetaPoseFilter();
    expect(f.state).toBeNull();
    expect(f.predict(0)).toBeNull();
    let p = f.update({ x: 10, y: 20, headingDeg: null }, 1000);
    expect(p).toMatchObject({ x: 10, y: 20, vx: 0, vy: 0, t: 1000 });
    expect(f.headingKnown).toBe(false);
    for (let k = 1; k <= 60; k++) {
      const t = k / 30;
      p = f.update({ x: 10 + 50 * t, y: 20 - 30 * t, headingDeg: null }, 1000 + t * 1000);
    }
    expect(p.vx).toBeCloseTo(50, 0);
    expect(p.vy).toBeCloseTo(-30, 0);
    expect(p.x).toBeCloseTo(110, 0);
    expect(f.headingKnown).toBe(true);
    expect(Math.abs(angleDiffDeg(p.headingDeg, (Math.atan2(-30, 50) * 180) / Math.PI))).toBeLessThan(1);
    const q = f.predict(p.t + 100)!;
    expect(q.x).toBeCloseTo(p.x + 5, 6);
    expect(q.y).toBeCloseTo(p.y - 3, 6);
  });

  it('filters heading across the ±180° seam', () => {
    const f = new AlphaBetaPoseFilter();
    let p = f.update({ x: 0, y: 0, headingDeg: 170 }, 0);
    for (let k = 1; k <= 45; k++) {
      p = f.update({ x: 0, y: 0, headingDeg: wrapDeg(170 + 60 * (k / 30)) }, (k / 30) * 1000);
    }
    // Truth: 170 + 90 = 260 ≡ -100.
    expect(Math.abs(angleDiffDeg(p.headingDeg, -100))).toBeLessThan(2);
    expect(p.headingDeg).toBeGreaterThan(-180);
    expect(p.headingDeg).toBeLessThanOrEqual(180);
    expect(p.omegaDegS).toBeCloseTo(60, -1);
  });

  it('holds heading when slow and resets after a long gap', () => {
    const f = new AlphaBetaPoseFilter({ maxGapMs: 300 });
    f.update({ x: 0, y: 0, headingDeg: 45 }, 0);
    const p = f.update({ x: 0.01, y: 0, headingDeg: null }, 33);
    expect(p.headingDeg).toBeCloseTo(45, 9);
    f.update({ x: 5, y: 0, headingDeg: null }, 66);
    expect(f.state!.vx).not.toBe(0);
    const r = f.update({ x: 50, y: 50, headingDeg: null }, 1000);
    expect(r).toMatchObject({ x: 50, y: 50, vx: 0, vy: 0, t: 1000 });
    f.reset();
    expect(f.state).toBeNull();
  });
});
