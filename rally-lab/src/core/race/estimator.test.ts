import { describe, expect, it } from 'vitest';
import { PUGUZ_PROFILE } from '../testing/simLap';
import { PoseEstimator } from './estimator';
import { minWheelSpeed, motorModel, spinRateDegS, wheelCommand, wheelSpeed } from './motor';

const model = motorModel(PUGUZ_PROFILE);

describe('motor model', () => {
  it('fits the speed table and keeps the deadband in raw commands', () => {
    expect(wheelSpeed(model, 30, 'L')).toBeCloseTo(33.3, 0);
    expect(wheelSpeed(model, 50, 'L')).toBeCloseTo(56.7, 0);
    expect(wheelSpeed(model, 19, 'L')).toBe(0);
    expect(wheelSpeed(model, -15, 'L')).toBeLessThan(0);
    // the right wheel is faster for the same command (trim −8 %)
    expect(wheelSpeed(model, 30, 'R')).toBeGreaterThan(wheelSpeed(model, 30, 'L'));
    expect(minWheelSpeed(model, 'R')).toBeCloseTo(wheelSpeed(model, 20, 'R'), 6);
  });

  it('turns wanted speeds into commands and back', () => {
    for (const v of [25, 33, 45, -30]) { // above each wheel's slowest speed
      for (const side of ['L', 'R'] as const) {
        const c = wheelCommand(model, v, side);
        expect(Math.abs(wheelSpeed(model, c, side) - v)).toBeLessThan(1.5);
      }
    }
    // never below the deadband, 0 for nothing
    expect(wheelCommand(model, 5, 'L')).toBe(20);
    expect(wheelCommand(model, 0.2, 'R')).toBe(0);
  });

  it('spins at the rate the track width gives', () => {
    // puguz: ~450°/s at 30 measured in turns per second
    expect(spinRateDegS(model, 30)).toBeGreaterThan(400);
    expect(spinRateDegS(model, 30)).toBeLessThan(520);
  });
});

describe('pose estimator', () => {
  it('dead-reckons a straight run from the commands', () => {
    const e = new PoseEstimator(model, { cmdLatencyMs: 0 });
    e.reset({ x: 0, y: 0, headingDeg: 0 }, 0);
    e.setCommand(0, 30, wheelCommand(model, wheelSpeed(model, 30, 'L'), 'R'));
    e.advance(1000);
    const p = e.pose;
    expect(p.x).toBeGreaterThan(28); // 33 cm/s less the start-up lag
    expect(p.x).toBeLessThan(34);
    expect(Math.abs(p.y)).toBeLessThan(1.5); // commands are whole numbers
  });

  it('folds in a late fix where it was taken', () => {
    const e = new PoseEstimator(model, { cmdLatencyMs: 0, markerAheadCm: 0 });
    e.reset({ x: 0, y: 0, headingDeg: 0 }, 0, { cm: 3, deg: 2 });
    e.setCommand(0, 30, 28);
    e.advance(600);
    const before = e.pose;
    // a frame taken 150 ms ago shows the robot 3 cm to the side of where the estimate had it then
    const r = e.addFix({ t: 450, x: before.x - 0.15 * 33, y: 3, headingDeg: null, cmPerPx: 1 });
    expect(r.used).toBe(true);
    const after = e.pose;
    expect(after.t).toBe(before.t);
    expect(after.y).toBeGreaterThan(1.5);
    expect(after.y).toBeLessThan(3.5);
  });

  it('learns that the robot pulls to one side', () => {
    const e = new PoseEstimator(model, { cmdLatencyMs: 0, markerAheadCm: 5.5 });
    e.reset({ x: 0, y: 0, headingDeg: 0 }, 0, { cm: 1, deg: 2 });
    const l = 30, r = wheelCommand(model, wheelSpeed(model, 30, 'L'), 'R');
    e.setCommand(0, l, r);
    // truth: same speed, but turning right at 8°/s
    let x = 0, y = 0, th = 0;
    const v = wheelSpeed(model, 30, 'L');
    for (let t = 10; t <= 4000; t += 10) {
      th += (8 * Math.PI) / 180 / 100;
      x += (v * Math.cos(th)) / 100;
      y += (v * Math.sin(th)) / 100;
      e.advance(t);
      if (t % 50 === 0) e.addFix({ t, x: x + 5.5 * Math.cos(th), y: y + 5.5 * Math.sin(th), headingDeg: null, cmPerPx: 1 });
    }
    const p = e.pose;
    expect(p.biasDegS).toBeGreaterThan(5);
    expect(p.biasDegS).toBeLessThan(11);
    expect(Math.hypot(p.x - x, p.y - y)).toBeLessThan(2);
    expect(Math.abs(p.headingDeg - (th * 180) / Math.PI)).toBeLessThan(4);
  });

  it('ignores a wild fix, and believes the camera when it keeps insisting', () => {
    const e = new PoseEstimator(model, { cmdLatencyMs: 0 });
    e.reset({ x: 50, y: 50, headingDeg: 0 }, 0, { cm: 1, deg: 2 });
    e.advance(100);
    expect(e.addFix({ t: 100, x: 150, y: 50, headingDeg: null, cmPerPx: 1 }).reason).toBe('gated');
    let last;
    for (let i = 0; i < 5; i++) {
      e.advance(120 + i * 20);
      last = e.addFix({ t: 120 + i * 20, x: 150, y: 50, headingDeg: null, cmPerPx: 1 });
    }
    expect(last!.reason).toBe('reset');
    expect(e.pose.x).toBeGreaterThan(140);
  });
});
