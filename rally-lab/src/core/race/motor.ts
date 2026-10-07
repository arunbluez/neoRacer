// What a wheel command does, from the robot profile: no motion below the
// deadband, then speed roughly proportional to the command (a line fitted
// through the speed table), the right wheel scaled by the trim. Used both
// ways: commands → expected motion (the estimator) and wanted wheel speeds →
// commands (the follower).

import { trimAt, type Deadband } from '../model/drive';
import type { RobotProfile } from '../model/profile';

export type MotorModel = {
  /** Wheel speed above the deadband: v = a·cmd + b (cm/s). */
  a: number;
  b: number;
  deadband: Deadband;
  trim: number;
  trimTable?: { cmd: number; trim: number }[];
  trackWidthCm: number;
  /** Speed lag time constant, ms. */
  tauMs: number;
  /** Where the numbers came from, for the log. */
  source: string[];
};

export const DEFAULT_TRACK_WIDTH_CM = 8.5;

/** Line through the speed table (least squares; through the origin with one point). */
function fitSpeed(table: { cmd: number; cmPerS: number }[]): { a: number; b: number } | null {
  const t = table.filter((r) => r.cmd > 0 && r.cmPerS > 0);
  if (t.length === 0) return null;
  if (t.length === 1) return { a: t[0].cmPerS / t[0].cmd, b: 0 };
  const n = t.length;
  const mx = t.reduce((s, r) => s + r.cmd, 0) / n, my = t.reduce((s, r) => s + r.cmPerS, 0) / n;
  let sxx = 0, sxy = 0;
  for (const r of t) {
    sxx += (r.cmd - mx) ** 2;
    sxy += (r.cmd - mx) * (r.cmPerS - my);
  }
  if (sxx === 0) return { a: my / mx, b: 0 };
  const a = sxy / sxx;
  return { a, b: my - a * mx };
}

export function motorModel(profile?: Partial<RobotProfile>, over: Partial<MotorModel> = {}): MotorModel {
  const source: string[] = [];
  const fit = profile?.speedTable?.length ? fitSpeed(profile.speedTable) : null;
  if (fit) source.push(`speed table (${profile!.speedTable!.length} rows)`);
  else source.push('default speed 1.1 cm/s per unit');
  const deadband = profile?.deadband ?? { lf: 15, lb: 15, rf: 15, rb: 15 };
  source.push(profile?.deadband ? 'deadband from T3.1' : 'default deadband 15');
  const trackWidthCm = profile?.trackWidthCm ?? DEFAULT_TRACK_WIDTH_CM;
  source.push(profile?.trackWidthCm ? 'track width from T3.5' : `default track width ${DEFAULT_TRACK_WIDTH_CM}`);
  return {
    a: fit?.a ?? 1.1,
    b: fit?.b ?? 0,
    deadband,
    trim: profile?.trim ?? 0,
    trimTable: profile?.trimTable,
    trackWidthCm,
    tauMs: 90,
    source,
    ...over,
  };
}

const dbOf = (m: MotorModel, side: 'L' | 'R', forward: boolean) =>
  side === 'L' ? (forward ? m.deadband.lf : m.deadband.lb) : forward ? m.deadband.rf : m.deadband.rb;

/** Slowest a wheel can turn (cm/s) going forward or back: its speed at the deadband (the right one with its trim). */
export function minWheelSpeed(m: MotorModel, side: 'L' | 'R', forward = true): number {
  const db = dbOf(m, side, forward);
  return Math.max(1, Math.abs(wheelSpeed(m, forward ? db : -db, side)));
}

/**
 * Expected wheel speed (cm/s, signed) for a command. The deadband is in raw
 * commands (T3.1 measured each wheel on its own); above it the right wheel's
 * command is divided by (1 + trim) to compare it with the left.
 */
export function wheelSpeed(m: MotorModel, cmd: number, side: 'L' | 'R'): number {
  if (cmd === 0) return 0;
  const fwd = cmd > 0;
  const c = Math.abs(cmd);
  if (c < dbOf(m, side, fwd)) return 0;
  const eq = side === 'R' ? c / (1 + trimAt(m, c)) : c;
  return (fwd ? 1 : -1) * Math.max(0, m.a * eq + m.b);
}

/** Integer command for a wanted wheel speed (cm/s, signed); 0 for (nearly) nothing. Clamped to ±cap. */
export function wheelCommand(m: MotorModel, v: number, side: 'L' | 'R', cap = 100): number {
  if (Math.abs(v) < 0.5) return 0;
  const fwd = v > 0;
  const eq = (Math.abs(v) - m.b) / m.a;
  let c = side === 'R' ? eq * (1 + trimAt(m, eq)) : eq;
  c = Math.min(cap, Math.max(dbOf(m, side, fwd), Math.round(c)));
  return (fwd ? 1 : -1) * c;
}

/** Turn rate (deg/s) of a spin on the spot at command c (left wheel −c, right +c for a left spin). */
export function spinRateDegS(m: MotorModel, c: number): number {
  const vl = Math.abs(wheelSpeed(m, c, 'L')), vr = Math.abs(wheelSpeed(m, c, 'R'));
  return (((vl + vr) / m.trackWidthCm) * 180) / Math.PI;
}
