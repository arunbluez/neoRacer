// The target speed at every point of the plan, from a tuning: the section's
// straight or turn speed, capped in turns by grip (v² ≤ a·R) and by the outer
// wheel's top speed, lifted where a tight turn needs the inner wheel above its
// deadband, then shaped so the speed never rises faster than the acceleration
// limit or falls faster than the braking limit (a forward and a backward
// pass, the way lap-time simulators do it). Also predicts the lap time, so a
// tuning can be judged before the robot drives it.

import { minWheelSpeed, spinRateDegS, wheelSpeed, type MotorModel } from './motor';
import type { Plan } from './route';
import { sectionSpeeds, START_LIMITS, type Tuning } from './tuning';

export type ProfileSection = {
  id: string;
  lengthCm: number;
  /** Predicted time in the section, s (spins included). */
  timeS: number;
  vMax: number;
  vMin: number;
  /** A tight turn needs more speed than the tuning asks for (the inner wheel's deadband). */
  floorBinds: boolean;
  /** Slowest the robot can drive the section's straights and its tightest turn, cm/s. */
  floorStraight: number;
  floorTurn: number;
  /** Turns are slower than asked because of the grip limit. */
  gripBinds: boolean;
};

export type SpeedProfile = {
  /** Distance along the plan (cm) and target speed (cm/s), per outline point. */
  s: number[];
  v: number[];
  /** Target speed at distance s along the plan. */
  at(s: number): number;
  /** Predicted lap time, s. */
  predictedS: number;
  sections: ProfileSection[];
};

export type ProfileOpts = {
  /** The auto settings' constant speeds, for sections the tuning leaves out. */
  speedCmS: number;
  curveSpeedCmS: number;
  /** Highest wheel command (the follower's cap). */
  cmdCap?: number;
  /** Spin legs: wheel command and the pauses around each spin. */
  spinCmd?: number;
  settleMs?: number;
  afterSpinMs?: number;
};

/** Curvature above which the follower treats a point as a curve (1/cm). */
const CURVE_K = 0.01;

export function buildSpeedProfile(plan: Plan, tuning: Tuning | undefined, model: MotorModel, o: ProfileOpts): SpeedProfile {
  const pts = plan.outline;
  const n = pts.length;
  const W = model.trackWidthCm;
  const vMin = Math.max(minWheelSpeed(model, 'L'), minWheelSpeed(model, 'R'));
  const vTop = wheelSpeed(model, o.cmdCap ?? 70, 'L');
  const accel = tuning?.accelCmS2 ?? START_LIMITS.accelCmS2;
  const decel = tuning?.decelCmS2 ?? START_LIMITS.decelCmS2;
  const grip = tuning?.latAccelCmS2 ?? START_LIMITS.latAccelCmS2;

  const cap = new Array<number>(n);
  const floor = new Array<number>(n);
  const gripCut = new Array<boolean>(n).fill(false);
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const k = Math.abs(p.curv);
    const sp = sectionSpeeds(tuning, p.section, o);
    let c = p.turn ? sp.turnCmS : sp.straightCmS;
    if (p.turn && k > 0) {
      const g = Math.sqrt(grip / k);
      if (g < c) {
        c = g;
        gripCut[i] = true;
      }
    }
    // The outer wheel can't go faster than the top speed.
    c = Math.min(c, vTop / (1 + (W * k) / 2));
    let f = vMin;
    if (k > CURVE_K) {
      const ratio = 1 - (W * k) / 2;
      if (ratio > 0.05) f = vMin / ratio;
    }
    cap[i] = c;
    floor[i] = f;
  }
  // Spins: arrive at the slowest speed, and leave from it.
  const spinIdx: number[] = [];
  for (const leg of plan.legs) {
    if (leg.kind !== 'spin') continue;
    let j = lowerBound(pts, leg.s + 1e-6) - 1;
    if (j < 0) j = 0;
    spinIdx.push(j);
    cap[j] = vMin;
  }
  // Lowest speed that still reaches every later floor in time (accelerating).
  const lo = new Array<number>(n);
  lo[n - 1] = floor[n - 1];
  for (let i = n - 2; i >= 0; i--) {
    const ds = pts[i + 1].s - pts[i].s;
    lo[i] = Math.max(floor[i], Math.sqrt(Math.max(0, lo[i + 1] ** 2 - 2 * accel * ds)));
  }
  for (const j of spinIdx) lo[j] = Math.min(lo[j], vMin);
  const v = new Array<number>(n);
  for (let i = 0; i < n; i++) v[i] = Math.max(cap[i], lo[i]);
  // Forward: from the start (standing), no faster than the acceleration allows.
  v[0] = Math.min(v[0], vMin);
  for (let i = 1; i < n; i++) {
    const ds = pts[i].s - pts[i - 1].s;
    v[i] = Math.min(v[i], Math.sqrt(v[i - 1] ** 2 + 2 * accel * ds));
  }
  // Backward: brake in time for everything slower ahead.
  for (let i = n - 2; i >= 0; i--) {
    const ds = pts[i + 1].s - pts[i].s;
    v[i] = Math.min(v[i], Math.sqrt(v[i + 1] ** 2 + 2 * decel * ds));
  }
  for (let i = 0; i < n; i++) v[i] = Math.max(v[i], floor[i]);

  // Lap time: distance over speed, plus the spins and the start.
  const secMap = new Map<string, ProfileSection>();
  const secOf = (id: string) => {
    let x = secMap.get(id);
    if (!x) {
      x = { id, lengthCm: 0, timeS: 0, vMax: 0, vMin: Infinity, floorBinds: false, gripBinds: false, floorStraight: vMin, floorTurn: 0 };
      secMap.set(id, x);
    }
    return x;
  };
  for (const st of plan.sectionStarts) secOf(st.id);
  let total = model.tauMs / 1000;
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const sec = secOf(p.section);
    sec.vMax = Math.max(sec.vMax, v[i]);
    sec.vMin = Math.min(sec.vMin, v[i]);
    if (floor[i] > cap[i] + 0.5 && !spinIdx.includes(i)) sec.floorBinds = true;
    if (gripCut[i]) sec.gripBinds = true;
    if (p.turn) sec.floorTurn = Math.max(sec.floorTurn, floor[i]);
    if (i === 0) continue;
    const ds = p.s - pts[i - 1].s;
    const dt = ds / Math.max(1, (v[i] + v[i - 1]) / 2);
    sec.lengthCm += ds;
    sec.timeS += dt;
    total += dt;
  }
  const rate = spinRateDegS(model, Math.max(o.spinCmd ?? 24, model.deadband.lb + 2, model.deadband.lf + 2, model.deadband.rb + 2, model.deadband.rf + 2));
  for (const leg of plan.legs) {
    if (leg.kind !== 'spin') continue;
    const dt = ((o.settleMs ?? 120) + (o.afterSpinMs ?? 200)) / 1000 + (rate > 0 ? Math.abs(leg.deltaDeg) / rate : 0) + model.tauMs / 1000;
    secOf(leg.section).timeS += dt;
    total += dt;
  }
  const sections = [...secMap.values()].map((x) => ({
    ...x, lengthCm: round1(x.lengthCm), timeS: round2(x.timeS), vMax: round1(x.vMax), vMin: round1(Number.isFinite(x.vMin) ? x.vMin : 0),
    floorStraight: round1(x.floorStraight), floorTurn: round1(x.floorTurn),
  }));
  const s = pts.map((p) => p.s);
  return {
    s,
    v,
    at(d: number): number {
      if (n === 0) return o.speedCmS;
      if (d <= s[0]) return v[0];
      if (d >= s[n - 1]) return v[n - 1];
      const j = lowerBound(pts, d);
      const a = s[j - 1], b = s[j];
      const f = b > a ? (d - a) / (b - a) : 0;
      return v[j - 1] + (v[j] - v[j - 1]) * f;
    },
    predictedS: round2(total),
    sections,
  };
}

/** First index whose s is ≥ d. */
function lowerBound(pts: { s: number }[], d: number): number {
  let lo = 0, hi = pts.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (pts[mid].s < d) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

const round1 = (x: number) => Math.round(x * 10) / 10;
const round2 = (x: number) => Math.round(x * 100) / 100;

/**
 * The tuning as the robot really drives it: speeds below what the wheels can
 * do (the deadband, a tight turn's inner wheel) raised to that. Changes are
 * judged against this, so "22 cm/s in the hairpins" (driven at 35) isn't a
 * reason to hold a hairpin at 27.
 */
export function effectiveTuning(t: Tuning, p: SpeedProfile): Tuning {
  const sections: Tuning['sections'] = {};
  for (const sec of p.sections) {
    const sp = t.sections[sec.id];
    if (!sp) continue;
    sections[sec.id] = {
      straightCmS: Math.max(sp.straightCmS, round1(sec.floorStraight)),
      turnCmS: Math.max(sp.turnCmS, round1(sec.floorTurn)),
    };
  }
  for (const id of Object.keys(t.sections)) sections[id] ??= t.sections[id];
  return { ...t, sections };
}
