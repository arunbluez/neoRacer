import { describe, expect, it } from 'vitest';
import { PUGUZ_PROFILE, simLap } from '../testing/simLap';
import { minWheelSpeed, motorModel } from './motor';
import { buildPlan, RALLY_ROUTE } from './route';
import { buildSpeedProfile } from './speedProfile';
import { clampTuning, constantTuning, MAX_STEP, tuningDiff, type Tuning } from './tuning';

const model = motorModel(PUGUZ_PROFILE);
const ids = RALLY_ROUTE.sections.map((s) => s.id);
const base = { speedCmS: 22, curveSpeedCmS: 30 };
const arc = buildPlan(RALLY_ROUTE, 'arc');
const vMin = Math.max(minWheelSpeed(model, 'L'), minWheelSpeed(model, 'R'));

function fast(): Tuning {
  const sections: Tuning['sections'] = {};
  for (const id of ids) sections[id] = { straightCmS: 50, turnCmS: 36 };
  return { sections, accelCmS2: 100, decelCmS2: 120, latAccelCmS2: 2000, label: 'fast', source: 'manual' };
}

describe('speed profile', () => {
  it('reproduces the constant speeds without a tuning', () => {
    const p = buildSpeedProfile(arc, undefined, model, base);
    const q = buildSpeedProfile(arc, constantTuning(base, ids), model, base);
    // On straights: the set speed, lifted to the slowest the wheels can go.
    const mid = arc.sectionStarts.find((s) => s.id === 'c')!.s + 100;
    expect(p.at(mid)).toBeCloseTo(Math.max(22, vMin), 1);
    // In the hairpins: the inner wheel needs ~35 cm/s.
    const hp = arc.outline.find((x) => x.section === 'e' && x.turn)!;
    expect(p.at(hp.s + 5)).toBeGreaterThan(33);
    expect(q.predictedS).toBeCloseTo(p.predictedS, 1);
    expect(p.predictedS).toBeGreaterThan(25);
    expect(p.predictedS).toBeLessThan(45);
    expect(p.sections.find((s) => s.id === 'e')!.floorBinds).toBe(true); // 22 cm/s is below what the hairpins need
  });

  it('brakes before the turns and accelerates out of them', () => {
    const p = buildSpeedProfile(arc, fast(), model, base);
    const dStart = arc.sectionStarts.find((s) => s.id === 'd')!.s;
    const hpStart = arc.outline.find((x) => x.section === 'd' && x.turn)!.s;
    // Somewhere on the far straight it reaches 50; at the hairpin it is down to its turn speed (36, or the floor).
    let top = 0;
    for (let s = dStart; s < hpStart; s += 1) top = Math.max(top, p.at(s));
    expect(top).toBeGreaterThan(45);
    expect(p.at(hpStart + 1)).toBeLessThan(40);
    // Braking at 120 cm/s²: no faster drop than that anywhere.
    for (let i = 1; i < p.v.length; i++) {
      const ds = p.s[i] - p.s[i - 1];
      if (ds <= 0) continue;
      const a = (p.v[i] ** 2 - p.v[i - 1] ** 2) / (2 * ds);
      expect(a).toBeGreaterThan(-120 - 1e-6);
    }
    const slow = buildSpeedProfile(arc, undefined, model, base);
    expect(p.predictedS).toBeLessThan(slow.predictedS - 5);
  });

  it('flags a turn speed below what the inner wheel needs', () => {
    const t = fast();
    t.sections.e = { straightCmS: 30, turnCmS: 25 };
    const p = buildSpeedProfile(arc, t, model, base);
    expect(p.sections.find((s) => s.id === 'e')!.floorBinds).toBe(true);
    expect(p.at(arc.outline.find((x) => x.section === 'e' && x.turn)!.s + 5)).toBeGreaterThan(33);
  });

  it('limits turn speed by grip', () => {
    const t = { ...fast(), latAccelCmS2: 30 };
    const p = buildSpeedProfile(arc, t, model, base);
    const b = p.sections.find((s) => s.id === 'b')!;
    expect(b.gripBinds).toBe(true);
    const turn = arc.outline.find((x) => x.section === 'b' && x.turn)!;
    expect(p.at(turn.s + 10)).toBeLessThan(Math.sqrt(30 * 29) + 0.5);
  });

  it('arrives at every spin at the slowest speed', () => {
    const spin = buildPlan(RALLY_ROUTE, 'spin');
    const p = buildSpeedProfile(spin, fast(), model, base);
    for (const leg of spin.legs) if (leg.kind === 'spin') expect(p.at(leg.s)).toBeLessThan(vMin + 0.5);
    expect(p.predictedS).toBeGreaterThan(buildSpeedProfile(arc, fast(), model, base).predictedS);
  });
});

describe('tuning limits', () => {
  it('clamps to the limits and lets a step raise numbers by at most MAX_STEP', () => {
    const ref = constantTuning(base, ids);
    const t = fast();
    t.sections.a = { straightCmS: 500, turnCmS: 10 };
    const { tuning, warnings } = clampTuning(t, ref, ids);
    expect(tuning.sections.a.straightCmS).toBeCloseTo(22 * (1 + MAX_STEP), 1);
    expect(tuning.sections.a.turnCmS).toBe(18); // lowering is allowed, down to the limit
    expect(tuning.sections.c.straightCmS).toBeCloseTo(27.5, 1);
    expect(tuning.decelCmS2).toBe(120); // braking gentler than "constant" (150) is fine
    expect(warnings.some((w) => w.startsWith('a straights'))).toBe(true);
    expect(tuningDiff(ref, tuning).length).toBeGreaterThan(5);
  });
});

describe('simulated laps with a tuning', () => {
  it('drives the lap faster than the constant speed and stays in the lane', () => {
    const plan = buildPlan(RALLY_ROUTE, 'arc');
    const slow = simLap({ style: 'arc', camera: true });
    const prof = buildSpeedProfile(plan, fast(), model, base);
    const quick = simLap({ style: 'arc', camera: true, follower: { profile: prof } });
    expect(quick.finished).toBe(true);
    expect(quick.maxOffLaneCm).toBeLessThan(9);
    if (process.env.DUMP) console.log('sim laps', { slow: slow.timeMs, quick: quick.timeMs, predicted: prof.predictedS, off: quick.maxOffLaneCm, per: quick.perSection });
    expect(quick.timeMs).toBeLessThan(slow.timeMs - 5000);
    // The prediction is in the right place.
    expect(Math.abs(quick.timeMs / 1000 - prof.predictedS)).toBeLessThan(0.25 * prof.predictedS);
  });
});
