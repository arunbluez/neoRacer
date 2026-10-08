import { describe, expect, it } from 'vitest';
import { buildPlan, checkRoute, closureError, offsetAt, RALLY_ROUTE, totalTurnDeg, wrapDeg, type RouteSpec } from './route';

describe('route', () => {
  it('the measured track is a closed lap that turns once to the left', () => {
    expect(checkRoute(RALLY_ROUTE)).toEqual([]);
    expect(totalTurnDeg(RALLY_ROUTE)).toBe(-360);
    expect(closureError(RALLY_ROUTE, 'arc')).toBeLessThan(0.5);
    expect(closureError(RALLY_ROUTE, 'spin')).toBeLessThan(0.5);
  });

  it('runs along the measured lane centres', () => {
    const plan = buildPlan(RALLY_ROUTE, 'arc');
    expect(plan.lengthCm).toBeGreaterThan(800);
    expect(plan.lengthCm).toBeLessThan(850);
    const xs = plan.outline.map((p) => p.x), ys = plan.outline.map((p) => p.y);
    expect(Math.min(...xs)).toBeCloseTo(48.5, 0);
    expect(Math.max(...xs)).toBeCloseTo(151.2 + 3.5, 0); // the right side, shifted around the left-hand cones
    expect(Math.min(...ys)).toBeCloseTo(25, 0);
    expect(Math.max(...ys)).toBeCloseTo(276.1, 0);
    // every section is visited in order
    expect(plan.sectionStarts.map((s) => s.id).join('')).toBe('abcdefg');
    for (let i = 1; i < plan.sectionStarts.length; i++) expect(plan.sectionStarts[i].s).toBeGreaterThan(plan.sectionStarts[i - 1].s);
  });

  it('weaves around the cones on c', () => {
    const plan = buildPlan(RALLY_ROUTE, 'arc');
    const c = plan.outline.filter((p) => p.section === 'c' && Math.abs(p.curv) < 0.02);
    const at = (y: number) => c.reduce((best, p) => (Math.abs(p.y - y) < Math.abs(best.y - y) ? p : best));
    // driving up (−y): right of travel is +x
    expect(at(195).x).toBeCloseTo(151.2 - 2.5, 1); // right-hand cones: keep left
    expect(at(145).x).toBeCloseTo(151.2 + 3.5, 1); // left-hand cones: keep right
    expect(at(235).x).toBeCloseTo(151.2, 1);
  });

  it('spin style turns on the spot where the straights meet', () => {
    const plan = buildPlan(RALLY_ROUTE, 'spin', { maxSpinDeg: 90 });
    const spins = plan.legs.filter((l) => l.kind === 'spin');
    // 4 corners of 90° and 4 hairpins of 2 × 90°
    expect(spins.length).toBe(12);
    for (const s of spins) if (s.kind === 'spin') expect(Math.abs(s.deltaDeg)).toBe(90);
    const first = spins[0];
    if (first.kind !== 'spin') throw new Error();
    expect(first.x).toBeCloseTo(48.5, 1);
    expect(first.y).toBeCloseTo(276.1, 1);
    expect(first.fromDeg).toBe(90);
    expect(first.toDeg).toBe(0);
    // legs alternate path / spin and start and end with a path
    expect(plan.legs[0].kind).toBe('path');
    expect(plan.legs[plan.legs.length - 1].kind).toBe('path');
  });

  it('cuts turns into smaller spins that stay near the lane centre', () => {
    const plan = buildPlan(RALLY_ROUTE, 'spin');
    expect(plan.legs.filter((l) => l.kind === 'spin').length).toBe(4 * 2 + 4 * 4);
    const arc = buildPlan(RALLY_ROUTE, 'arc').outline;
    for (const l of plan.legs) {
      if (l.kind !== 'spin') continue;
      const d = Math.min(...arc.map((p) => Math.hypot(p.x - l.x, p.y - l.y)));
      expect(d).toBeLessThan(3.5); // the cone offsets on c are not in the spin corners
    }
    expect(closureError(RALLY_ROUTE, 'spin')).toBeLessThan(0.5);
  });

  it('ramps offsets in and out smoothly', () => {
    const r = [{ from: 10, to: 20, offsetCm: 4 }];
    expect(offsetAt(r, 15)).toBe(4);
    expect(offsetAt(r, 0)).toBeCloseTo(0.5 * (1 + Math.cos(Math.PI * 10 / 25)) * 4, 6);
    expect(offsetAt(r, -20)).toBe(0);
    expect(offsetAt(r, 50)).toBe(0);
    // The swap between the cones of section c is a gentle bend (radius > 25 cm), not a corner.
    const c = buildPlan(RALLY_ROUTE, 'arc').outline.filter((p) => p.section === 'c' && !p.turn);
    expect(Math.max(...c.map((p) => Math.abs(p.curv)))).toBeLessThan(1 / 25);
  });

  it('flags broken specs', () => {
    const bad: RouteSpec = { ...RALLY_ROUTE, sections: [{ id: 'x', parts: [{ kind: 'turn', deg: 90, radiusCm: 0 }] }] };
    expect(checkRoute(bad).length).toBe(1);
    expect(wrapDeg(270)).toBe(-90);
  });
});
