// Drives the plan: along path legs it steers by curvature (the path's own,
// plus corrections for the sideways and heading error from the estimated
// pose), at the set speed, with every moving wheel above its deadband; at
// spin legs it stops, turns on the spot for the time the motor model gives,
// and stops again so the camera can catch up.

import type { EstPose } from './estimator';
import { minWheelSpeed, spinRateDegS, wheelCommand, wheelSpeed, type MotorModel } from './motor';
import { wrapDeg, type Leg, type PathPt, type Plan } from './route';

export type FollowerOpts = {
  /** Target speed on straights, cm/s. */
  speedCmS: number;
  /** Speed limit in curves (arc turns), cm/s; it rises if the inner wheel would stall. */
  curveSpeedCmS: number;
  /** Distance over which a sideways error is corrected, cm (smaller = sharper). */
  settleCm: number;
  /** Highest wheel command. */
  cmdCap: number;
  /** Wheel command for turns on the spot. */
  spinCmd: number;
  /** End a spin this much early: the robot coasts on, ms. */
  spinLeadMs: number;
  /** Stand still before a spin, ms. */
  settleMs: number;
  /** Stand still after a spin, ms (the camera sees the new heading). */
  afterSpinMs: number;
  /** Slow down over this distance before a spin, cm. */
  slowBeforeSpinCm: number;
  /** How far ahead the path's curvature is read, cm. */
  lookaheadCm: number;
  /**
   * Target speed along the plan (speedProfile.ts, from a lap tuning). When
   * set it replaces speedCmS and curveSpeedCmS; read a little ahead, by the
   * distance the robot covers while a new speed takes effect.
   */
  profile?: { at(s: number): number };
};

export const DEFAULT_FOLLOWER_OPTS: FollowerOpts = {
  speedCmS: 22,
  curveSpeedCmS: 30,
  settleCm: 25,
  cmdCap: 70,
  spinCmd: 24,
  spinLeadMs: 0,
  settleMs: 150,
  afterSpinMs: 250,
  slowBeforeSpinCm: 12,
  lookaheadCm: 4,
};

export type FollowStep = {
  l: number;
  r: number;
  leg: number;
  kind: Leg['kind'] | 'done';
  phase?: 'stop' | 'turn' | 'after';
  section: string;
  /** Progress along the plan, cm. */
  s: number;
  /** Sideways error, cm, positive = right of the path. */
  e: number;
  /** Heading error, degrees, positive = pointing right of the path. */
  he: number;
  /** Commanded speed (cm/s) and turn rate (deg/s). */
  v: number;
  w: number;
  done: boolean;
};

type SpinState = { phase: 'stop' | 'turn' | 'after'; t0: number; durMs: number; dir: number; cmd: number; deltaDeg: number };

const RAD = Math.PI / 180;

export class Follower {
  private legIdx = 0;
  private idx = 0;
  private spin?: SpinState;
  /** Spins done: commanded angle and time, for the run log. */
  readonly spins: { leg: number; section: string; deltaDeg: number; durMs: number; cmd: number; headingBefore: number; target: number }[] = [];
  opts: FollowerOpts;
  /** Extra curvature from the line guard (1/cm), added while set. */
  nudgeK = 0;

  constructor(readonly plan: Plan, public model: MotorModel, opts: Partial<FollowerOpts> = {}) {
    this.opts = { ...DEFAULT_FOLLOWER_OPTS, ...opts };
  }

  get leg(): Leg | undefined {
    return this.plan.legs[this.legIdx];
  }

  get done(): boolean {
    return this.legIdx >= this.plan.legs.length;
  }

  /** Progress along the plan, cm. */
  get progress(): number {
    const leg = this.leg;
    if (!leg) return this.plan.lengthCm;
    return leg.kind === 'path' ? leg.pts[Math.min(this.idx, leg.pts.length - 1)].s : leg.s;
  }

  private next(): void {
    this.legIdx++;
    this.idx = 0;
    this.spin = undefined;
  }

  step(t: number, pose: EstPose): FollowStep {
    for (;;) {
      const leg = this.leg;
      if (!leg) return { l: 0, r: 0, leg: this.legIdx, kind: 'done', section: this.plan.sectionStarts[this.plan.sectionStarts.length - 1]?.id ?? '', s: this.plan.lengthCm, e: 0, he: 0, v: 0, w: 0, done: true };
      const out = leg.kind === 'path' ? this.followPath(leg, pose) : this.doSpin(leg, t, pose);
      if (out) return out;
      this.next();
    }
  }

  /** null when the leg is finished. */
  private followPath(leg: Extract<Leg, { kind: 'path' }>, pose: EstPose): FollowStep | null {
    const pts = leg.pts;
    const n = pts.length;
    // Nearest point, searching a window ahead of the last one (adjacent lanes of the zigzag are close).
    let best = this.idx, bestD = Infinity;
    for (let i = Math.max(0, this.idx - 3); i < Math.min(n, this.idx + 40); i++) {
      const d = (pts[i].x - pose.x) ** 2 + (pts[i].y - pose.y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    this.idx = best;
    const q = pts[best];
    const h = q.headingDeg * RAD;
    const ux = Math.cos(h), uy = Math.sin(h);
    const along = (pose.x - q.x) * ux + (pose.y - q.y) * uy;
    const e = (pose.x - q.x) * -uy + (pose.y - q.y) * ux;
    const he = wrapDeg(pose.headingDeg - q.headingDeg);
    const toEnd = pts[n - 1].s - q.s - along;
    const nextLeg = this.plan.legs[this.legIdx + 1];
    const o = this.opts, m = this.model;
    // Stop short by the distance the robot coasts once told to stop.
    const coast = (Math.max(0, (pose.vl + pose.vr) / 2) * (m.tauMs + 30)) / 1000;
    if (toEnd <= (nextLeg?.kind === 'spin' ? coast : 0.5) || (best >= n - 1 && along >= 0)) return null;

    // Speed: the set speed (or the tuning's profile), the curve limit, slower
    // before a spin. In a curve the inner wheel must keep turning, so a tight
    // curve needs some speed: look a little ahead so the robot is up to it on
    // the way in.
    const ahead = pts[Math.min(n - 1, best + Math.round(o.lookaheadCm))];
    const kFf = ahead.curv;
    const vMin = Math.max(minWheelSpeed(m, 'L'), minWheelSpeed(m, 'R'));
    let kMax = 0;
    for (let i = best; i < Math.min(n, best + 12); i++) kMax = Math.max(kMax, Math.abs(pts[i].curv));
    let v = o.profile ? o.profile.at(q.s + along + coast) : o.speedCmS;
    if (kMax > 0.01) {
      if (!o.profile) v = Math.min(v, o.curveSpeedCmS);
      const ratio = 1 - (m.trackWidthCm * kMax) / 2;
      if (ratio > 0.05) v = Math.max(v, vMin / ratio);
    }
    if (nextLeg?.kind === 'spin' && toEnd < o.slowBeforeSpinCm) v = Math.min(v, vMin + ((v - vMin) * toEnd) / o.slowBeforeSpinCm);

    // Steering: curvature to follow (1/cm, positive = right).
    const L = o.settleCm;
    let k = kFf - e / (L * L) - (1.6 / L) * Math.sin(he * RAD) + this.nudgeK;
    k = Math.max(-0.2, Math.min(0.2, k));
    const wheels = this.wheels(v, k, pose);
    return {
      ...wheels, leg: this.legIdx, kind: 'path', section: q.section, s: q.s + along, e, he, v, w: (k * v) / RAD, done: false,
    };
  }

  /** Wheel commands for speed v (cm/s) along curvature k, compensating the learned bias and speed scale. */
  private wheels(v: number, k: number, pose: EstPose): { l: number; r: number } {
    const m = this.model;
    const W = m.trackWidthCm;
    const kv = pose.speedScale || 1;
    const vw = v / kv;
    // ω = turnScale·(vl − vr)/W + bias  ⇒  vl − vr = W·(k·v − bias)/turnScale
    const diff = (W * (k * v - pose.biasDegS * RAD)) / (pose.turnScale || 1);
    let vl = vw + diff / 2, vr = vw - diff / 2;
    // Every wheel at least at its slowest moving speed: lift both, keeping the difference.
    const lift = Math.max(minWheelSpeed(m, 'L') - vl, minWheelSpeed(m, 'R') - vr, 0);
    vl += lift;
    vr += lift;
    const vCap = wheelSpeed(m, this.opts.cmdCap, 'L');
    const over = Math.max(vl, vr) - vCap;
    if (over > 0) {
      vl -= over;
      vr -= over;
    }
    return { l: wheelCommand(m, vl, 'L', this.opts.cmdCap), r: wheelCommand(m, vr, 'R', this.opts.cmdCap) };
  }

  private doSpin(leg: Extract<Leg, { kind: 'spin' }>, t: number, pose: EstPose): FollowStep | null {
    const o = this.opts, m = this.model;
    const base = { leg: this.legIdx, kind: 'spin' as const, section: leg.section, s: leg.s, e: 0, he: wrapDeg(pose.headingDeg - leg.toDeg), v: 0, done: false };
    if (!this.spin) this.spin = { phase: 'stop', t0: t, durMs: 0, dir: 0, cmd: 0, deltaDeg: 0 };
    const sp = this.spin;
    if (sp.phase === 'stop') {
      if (t - sp.t0 < o.settleMs) return { ...base, l: 0, r: 0, w: 0, phase: 'stop' };
      const delta = wrapDeg(leg.toDeg - pose.headingDeg);
      const c = Math.max(o.spinCmd, m.deadband.lb + 2, m.deadband.lf + 2, m.deadband.rb + 2, m.deadband.rf + 2);
      const rate = spinRateDegS(m, c) * (pose.turnScale || 1);
      const dur = rate > 0 ? (Math.abs(delta) / rate) * 1000 - o.spinLeadMs : 0;
      Object.assign(sp, { phase: 'turn', t0: t, durMs: Math.max(0, dur), dir: Math.sign(delta), cmd: c, deltaDeg: delta });
      this.spins.push({ leg: this.legIdx, section: leg.section, deltaDeg: delta, durMs: Math.max(0, dur), cmd: c, headingBefore: pose.headingDeg, target: leg.toDeg });
    }
    if (sp.phase === 'turn') {
      if (t - sp.t0 < sp.durMs && Math.abs(sp.deltaDeg) >= 3) {
        // Left (heading falls): left wheel back, right forward.
        const vs = Math.abs(wheelSpeed(m, sp.cmd, 'L'));
        const l = sp.dir < 0 ? -sp.cmd : sp.cmd;
        const r = wheelCommand(m, sp.dir < 0 ? vs : -vs, 'R');
        return { ...base, l, r, w: sp.dir * spinRateDegS(m, sp.cmd), phase: 'turn' };
      }
      Object.assign(sp, { phase: 'after', t0: t });
    }
    if (t - sp.t0 < o.afterSpinMs) return { ...base, l: 0, r: 0, w: 0, phase: 'after' };
    return null;
  }

  /** The path point nearest the current progress (for overlays). */
  target(): PathPt | undefined {
    const leg = this.leg;
    return leg?.kind === 'path' ? leg.pts[Math.min(this.idx, leg.pts.length - 1)] : undefined;
  }
}
