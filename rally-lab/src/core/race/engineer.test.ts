import { describe, expect, it } from 'vitest';
import type { LogEvent } from '../log/events';
import { PUGUZ_PROFILE } from '../testing/simLap';
import { engineerBriefText, engineerContext, engineerPrompt, engineerSystem, finishPlan, planSchema, predictLap, quickPlan } from './engineerBrief';
import { applyRouteEdits, checkPlan, parsePlan, PLAN_KIND } from './engineerPlan';
import { analyzeRuns, sectionTrace, type PartStats, type RunAnalysis } from './lapAnalysis';
import { quickTune } from './learner';
import { motorModel } from './motor';
import { buildPlan, RALLY_ROUTE } from './route';
import { buildSpeedProfile, effectiveTuning } from './speedProfile';
import { constantTuning, type Tuning } from './tuning';

const ids = RALLY_ROUTE.sections.map((s) => s.id);
const base = { speedCmS: 22, curveSpeedCmS: 30 };
const plan = buildPlan(RALLY_ROUTE, 'arc');
const model = motorModel(PUGUZ_PROFILE);

/** A made-up run's log: ticks every 40 ms along the plan at `v`, wandering `off(s)` cm, stopping at `stopAt`. */
function fakeLog(o: { v: number; off: (s: number) => number; stopAt?: number; lines?: { s: number; code: number }[]; tuning?: Tuning }): LogEvent[] {
  const ev: LogEvent[] = [{ t: 0, k: 'auto.start', style: 'arc', settings: { speedCmS: 22, curveSpeedCmS: 30, tickMs: 40, maxSpinDeg: 45, tuning: o.tuning }, profile: { predictedS: 20 },
    model: { a: model.a, b: model.b, deadband: model.deadband, trim: model.trim, trackWidthCm: model.trackWidthCm } }];
  let t = 0;
  const end = o.stopAt ?? plan.lengthCm;
  const lines = [...(o.lines ?? [])];
  for (let s = 0; s < end; s += (o.v * 40) / 1000) {
    t += 40;
    const p = plan.outline.find((q) => q.s >= s) ?? plan.outline[plan.outline.length - 1];
    ev.push({ t, k: 'auto.tick', s, sec: p.section, kind: 'path', e: o.off(s), he: 0, v: o.v, x: p.x, y: p.y, cam: 80 });
    if (Math.round(t) % 120 === 0) ev.push({ t, k: 'auto.fix', used: true, dx: 0.5, dy: 0.2 });
    while (lines.length && lines[0].s <= s) {
      const l = lines.shift()!;
      ev.push({ t, k: 'auto.line', code: l.code, s: l.s });
    }
  }
  const finished = o.stopAt === undefined;
  ev.push({ t: t + 40, k: 'auto.end', reason: finished ? 'finished' : 'left the lane (both line sensors black)', finished, timeMs: t, progressCm: end, lineEvents: o.lines?.length ?? 0 });
  return ev;
}

describe('lap analysis', () => {
  it('splits each section into straights and turns', () => {
    const runs = analyzeRuns(fakeLog({ v: 25, off: () => 1.5 }), 'S1');
    expect(runs).toHaveLength(1);
    const r = runs[0];
    expect(r.id).toBe('S1#1');
    expect(r.finished).toBe(true);
    expect(r.sections.map((s) => s.id).join('')).toBe('abcdefg');
    const d = r.sections.find((s) => s.id === 'd')!;
    expect(d.straight!.lengthCm).toBeCloseTo(62.45, 0);
    expect(d.turn!.lengthCm).toBeCloseTo(Math.PI * 13.75, 0);
    expect(d.straight!.speedCmS).toBeGreaterThan(20);
    expect(d.straight!.speedCmS).toBeLessThan(30);
    expect(d.straight!.maxOffCm).toBe(1.5);
    expect(r.sections.find((s) => s.id === 'g')!.turn).toBeNull();
    expect(r.tuned).toBe(false);
    expect(r.tuning.sections.c.straightCmS).toBe(22);
  });

  it('finds where a run stopped, and the line events by part', () => {
    const eStart = plan.sectionStarts.find((s) => s.id === 'e')!.s;
    const hp = plan.outline.find((p) => p.section === 'e' && p.turn)!.s;
    const runs = analyzeRuns(fakeLog({ v: 30, off: (s) => (s > hp ? 9 : 2), stopAt: hp + 10, lines: [{ s: hp + 5, code: 3 }, { s: eStart + 3, code: 1 }] }), 'S2');
    const r = runs[0];
    expect(r.finished).toBe(false);
    expect(r.stop?.section).toBe('e');
    const e = r.sections.find((s) => s.id === 'e')!;
    expect(e.stoppedHere).toBe(true);
    expect(e.turn!.lineBoth).toBe(1);
    expect(e.straight!.lineOne).toBe(1);
    expect(r.sections.find((s) => s.id === 'f')!.reached).toBe(false);
    const tr = sectionTrace(fakeLog({ v: 30, off: () => 2 }), 1, 'c');
    expect(tr!.points.length).toBeGreaterThan(30);
    expect(tr!.points[1].s - tr!.points[0].s).toBeGreaterThanOrEqual(4);
  });
});

function part(over: Partial<PartStats>): PartStats {
  return {
    timeMs: 1000, lengthCm: 30, speedCmS: 30, targetMeanCmS: 30, targetMaxCmS: 30, maxOffCm: 2, meanOffCm: 1, p90OffCm: 1.5,
    maxHeadingErrDeg: 5, lineOne: 0, lineBoth: 0, fixes: 10, corrMeanCm: 1, corrMaxCm: 2, camGapMaxMs: 150, ...over,
  };
}

describe('quick tune', () => {
  const current = effectiveTuning(constantTuning(base, ids), buildSpeedProfile(plan, constantTuning(base, ids), model, base));
  const run = (secs: Partial<Record<string, { straight?: Partial<PartStats>; turn?: Partial<PartStats> | null; stoppedHere?: boolean; reached?: boolean }>>, finished = true): RunAnalysis => ({
    id: 'S#1', sessionId: 'S', n: 1, t: 0, finished, reason: finished ? 'finished' : 'left the lane', timeMs: 30000, progressCm: 800, lengthCm: 828,
    style: 'arc', tuning: current, tuned: false, settleCm: 25, cameraAssist: true, lineEvents: 0,
    env: { route: RALLY_ROUTE, settings: { ...base, settleCm: 25, spinCmd: 24, settleMs: 120, afterSpinMs: 200, maxSpinDeg: 45 } },
    sections: ids.map((id) => {
      const o = secs[id] ?? {};
      return {
        id, reached: o.reached ?? true, completed: !o.stoppedHere && (o.reached ?? true), timeMs: 3000,
        straight: part(o.straight ?? {}), turn: o.turn === null ? null : part(o.turn ?? {}), stoppedHere: !!o.stoppedHere, asked: current.sections[id],
      };
    }),
  });

  it('starts from the speeds the robot really drove', () => {
    // 22 cm/s asked, but the wheels can't go slower than ~23.6, and the hairpins need ~35.
    expect(current.sections.c.straightCmS).toBeGreaterThan(23);
    expect(current.sections.e.turnCmS).toBeGreaterThan(33);
  });

  it('speeds up clean parts and slows down where it wandered or left the lane', () => {
    const q = quickTune(run({ d: { turn: { maxOffCm: 9 } }, e: { turn: { lineBoth: 2 }, stoppedHere: true }, f: { reached: false } }, false), current, 2);
    expect(q.tuning.label).toBe('quick 2');
    expect(q.tuning.sections.a.straightCmS).toBeGreaterThan(current.sections.a.straightCmS * 1.1);
    expect(q.tuning.sections.d.turnCmS).toBeLessThan(current.sections.d.turnCmS);
    expect(q.tuning.sections.e.turnCmS).toBeLessThan(current.sections.e.turnCmS * 0.9);
    expect(q.tuning.sections.f).toEqual(current.sections.f);
    expect(q.tuning.decelCmS2).toBeLessThan(current.decelCmS2);
    expect(q.reasons.join('\n')).toMatch(/e: stopped in a turn/);
  });

  it('holds a part where the camera lost the robot', () => {
    const q = quickTune(run({ c: { straight: { camGapMaxMs: 1500, corrMaxCm: 8 } }, d: { straight: { camGapMaxMs: 1500, corrMaxCm: 1.5 } } }), current, 3);
    expect(q.tuning.sections.d.straightCmS).toBeGreaterThan(current.sections.d.straightCmS); // blind, but nothing to correct
    expect(q.tuning.sections.c.straightCmS).toBe(current.sections.c.straightCmS);
    expect(q.tuning.sections.b.straightCmS).toBeGreaterThan(current.sections.b.straightCmS);
  });
});

describe('engineer plan', () => {
  const current = constantTuning(base, ids);
  const planJson = {
    kind: PLAN_KIND, version: 1, createdAt: '2026-10-08T10:00:00Z', engine: 'claude', model: 'claude-haiku-5-5',
    basedOn: { runs: ['S#1'] }, summary: 'Faster straights.', confidence: 'medium',
    tuning: {
      label: 'engineer 1', accelCmS2: 150, decelCmS2: 120, latAccelCmS2: 900,
      sections: Object.fromEntries(ids.map((id) => [id, { straightCmS: 40, turnCmS: 26 }])),
    },
    changes: [{ what: 'straights 22 → 27.5', why: 'clean' }],
    routeEdits: [{ section: 'd', part: 0, lengthCm: 64, why: 'turned late' }, { section: 'e', part: 1, radiusCm: 30, why: 'too much' }, { section: 'x', part: 0, lengthCm: 3 }],
    watch: ['d hairpin entry'],
  };

  it('reads a plan pasted inside a message', () => {
    const text = `Here is the plan:\n\`\`\`json\n${JSON.stringify(planJson, null, 2)}\n\`\`\`\nGood luck!`;
    const { plan: p, errors } = parsePlan(text);
    expect(errors).toEqual([]);
    expect(p!.tuning.sections.c.straightCmS).toBe(40);
    expect(p!.routeEdits).toHaveLength(3);
    expect(parsePlan('hello').errors[0]).toMatch(/No engineer plan/);
  });

  it('holds the step limit and rejects route edits that are too big', () => {
    const { plan: p } = parsePlan(planJson);
    const c = checkPlan(p!, { current, route: RALLY_ROUTE });
    expect(c.tuning.sections.c.straightCmS).toBe(27.5); // 22 + 25 %
    expect(c.tuning.decelCmS2).toBe(120);
    expect(c.warnings.some((w) => /more than 25 %/.test(w))).toBe(true);
    expect(c.routeApplied.map((e) => e.section)).toEqual(['d']);
    expect(c.routeRejected.map((r) => r.edit.section).sort()).toEqual(['e', 'x']);
    expect(c.route!.sections.find((s) => s.id === 'd')!.parts[0]).toMatchObject({ kind: 'straight', lengthCm: 64 });
    expect(c.closure!.after).toBeGreaterThan(c.closure!.before);
    // The route itself is untouched.
    expect(RALLY_ROUTE.sections.find((s) => s.id === 'd')!.parts[0]).toMatchObject({ lengthCm: 62.45 });
    expect(applyRouteEdits(RALLY_ROUTE, [{ section: 'a', part: 1, lengthCm: 10 }]).rejected[0].why).toMatch(/radiusCm/);
  });
});

describe('engineer brief', () => {
  const log = [...fakeLog({ v: 25, off: () => 1.5 })];
  const runs = analyzeRuns(log, 'S9');
  const ctx = engineerContext(runs);

  it('starts from the tuning the last run drove, as driven', () => {
    expect(ctx.label).toBe('engineer 1');
    expect(ctx.current.sections.e.turnCmS).toBeGreaterThan(33);
    expect(ctx.profile.predictedS).toBeGreaterThan(20);
  });

  it('tells Claude the physics and the data, and asks for every section', () => {
    const sys = engineerSystem(ctx);
    expect(sys).toMatch(/one timed attempt/);
    expect(sys).toMatch(/at most 25 %/);
    const prompt = engineerPrompt(ctx);
    const data = JSON.parse(prompt.slice(prompt.indexOf('{')));
    expect(data.runs[0].id).toBe('S9#1');
    expect(data.runs[0].env).toBeUndefined();
    expect(data.quickTuneBaseline.reasons.length).toBeGreaterThanOrEqual(7); // one per section, plus the limits
    const schema = planSchema(ids) as { properties: { tuning: { properties: { sections: { required: string[] } } } } };
    expect(schema.properties.tuning.properties.sections.required).toEqual(ids);
    const brief = engineerBriefText(ctx);
    expect(brief).not.toMatch(/predict_lap to check/);
    expect(brief).toMatch(/Answer with one JSON object/);
  });

  it('predicts a candidate and turns an answer into a checked plan', () => {
    const cand = { ...ctx.current, sections: Object.fromEntries(ids.map((id) => [id, { straightCmS: 60, turnCmS: 40 }])) };
    const p = predictLap(ctx, cand);
    expect(p.applied.sections.c.straightCmS).toBeLessThanOrEqual(ctx.current.sections.c.straightCmS * 1.25 + 0.05);
    expect(p.predictedS).toBeLessThan(p.currentPredictedS);
    expect(p.warnings.length).toBeGreaterThan(0);
    const { plan: pl, warnings } = finishPlan({
      summary: 'All clean: straights up.', tuning: { ...cand, settleCm: 25 }, changes: [{ what: 'straights', why: 'clean' }],
      routeEdits: [{ section: 'c', part: 1, radiusCm: 27, why: 'turned late' }], watch: ['c'], predictedS: 1, confidence: 'high',
    }, ctx, { engine: 'claude', model: 'claude-haiku-5-5', createdAt: '2026-10-08T12:00:00Z' });
    expect(pl.kind).toBe(PLAN_KIND);
    expect(pl.tuning.label).toBe('engineer 1');
    expect(pl.predictedS).toBe(p.predictedS); // recomputed, not taken from the answer
    expect(pl.basedOn.runs).toEqual(['S9#1']);
    expect(warnings.length).toBeGreaterThan(0);
    // The app reads it back.
    const back = parsePlan(JSON.stringify(pl));
    expect(back.errors).toEqual([]);
    expect(back.plan!.routeEdits[0]).toMatchObject({ section: 'c', part: 1, radiusCm: 27 });
    expect(quickPlan(ctx, '2026-10-08T12:00:00Z').engine).toBe('quick');
  });
});
