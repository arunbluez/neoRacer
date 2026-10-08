// Where the robot is, between and through camera fixes: an extended Kalman
// filter on the wheel axle's position and heading, driven by the wheel
// commands through the motor model, corrected by the camera. It also learns
// how far off the motor model is: a turning bias (the robot pulls to one side)
// and a speed scale. Camera fixes arrive late (frame capture → processing),
// so the filter keeps a short history and folds each fix in at the time its
// frame was taken, then replays the commands since.

import { minWheelSpeed, wheelSpeed, type MotorModel } from './motor';

export type EstimatorOpts = {
  /** Marker A (where the camera fix is) ahead of the axle, cm. */
  markerAheadCm: number;
  /** Delay from sending a command to the wheels reacting, ms. */
  cmdLatencyMs: number;
  /** Integration step, ms. */
  stepMs: number;
  /** History kept for late fixes, ms. */
  historyMs: number;
  /** Camera fix noise at 1 cm per pixel, cm. */
  fixSigmaCm: number;
  /**
   * Camera heading (B → A) noise, degrees; 0 ignores it. Off by default: the
   * two markers are only ~5 cm apart and one underglow LED is often hidden
   * behind the headlights, which skews B→A by up to ~30° the same way frame
   * after frame. Position fixes give the heading as soon as the robot moves.
   */
  headingSigmaDeg: number;
};

export const DEFAULT_ESTIMATOR_OPTS: EstimatorOpts = {
  markerAheadCm: 5.5,
  cmdLatencyMs: 25,
  stepMs: 10,
  historyMs: 1500,
  fixSigmaCm: 1.2,
  headingSigmaDeg: 0,
};

export type EstPose = {
  t: number;
  x: number;
  y: number;
  headingDeg: number;
  /** Learned turning bias, deg/s (positive: pulls right). */
  biasDegS: number;
  /** Learned speed scale (1 = as the motor model says). */
  speedScale: number;
  /** Learned turn scale: how much the robot really turns for a wheel speed difference (1 = as the model says). */
  turnScale: number;
  /** Wheel speeds the model thinks the wheels have now, cm/s. */
  vl: number;
  vr: number;
  /** 1-sigma position and heading uncertainty. */
  sigmaCm: number;
  sigmaDeg: number;
};

export type FixResult = { used: boolean; reason?: string; dx: number; dy: number; nis: number };

const N = 6; // x, y, θ (rad), bias (rad/s), speed scale, turn scale
type Vec = number[];
type Mat = number[]; // N×N row-major

type Snap = { t: number; s: Vec; P: Mat; vl: number; vr: number };

const RAD = Math.PI / 180;

function eye(scale: number[]): Mat {
  const m = new Array<number>(N * N).fill(0);
  for (let i = 0; i < N; i++) m[i * N + i] = scale[i];
  return m;
}

/** A = F·P·Fᵀ for a sparse F given as rows of (col, value) beyond the identity. */
function propagateP(P: Mat, F: Mat): Mat {
  const FP = new Array<number>(N * N).fill(0);
  for (let i = 0; i < N; i++) for (let k = 0; k < N; k++) {
    const f = F[i * N + k];
    if (f === 0) continue;
    for (let j = 0; j < N; j++) FP[i * N + j] += f * P[k * N + j];
  }
  const out = new Array<number>(N * N).fill(0);
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    let s = 0;
    for (let k = 0; k < N; k++) s += FP[i * N + k] * F[j * N + k];
    out[i * N + j] = s;
  }
  return out;
}

export class PoseEstimator {
  private s: Vec = [0, 0, 0, 0, 1, 1];
  private P: Mat = eye([25, 25, 0.03, 0.01, 0.02, 0.01]);
  private t = 0;
  private vl = 0;
  private vr = 0;
  private snaps: Snap[] = [];
  /** Wheel commands, in the order they take effect. */
  private cmds: { t: number; l: number; r: number }[] = [{ t: -Infinity, l: 0, r: 0 }];
  private rejects = 0;
  readonly opts: EstimatorOpts;
  /** Counters for the run log. */
  stats = { fixes: 0, used: 0, rejected: 0, resets: 0 };

  constructor(public model: MotorModel, opts: Partial<EstimatorOpts> = {}) {
    this.opts = { ...DEFAULT_ESTIMATOR_OPTS, ...opts };
  }

  /** Start from a pose (axle, heading) at time t. */
  reset(pose: { x: number; y: number; headingDeg: number }, t: number, sigma: { cm: number; deg: number } = { cm: 3, deg: 8 }): void {
    this.s = [pose.x, pose.y, pose.headingDeg * RAD, 0, 1, 1];
    this.P = eye([sigma.cm ** 2, sigma.cm ** 2, (sigma.deg * RAD) ** 2, 0.25 ** 2, 0.15 ** 2, 0.12 ** 2]);
    this.t = t;
    this.vl = this.vr = 0;
    this.snaps = [{ t, s: [...this.s], P: [...this.P], vl: 0, vr: 0 }];
    this.cmds = [{ t: -Infinity, l: 0, r: 0 }];
    this.rejects = 0;
  }

  /**
   * Put the robot somewhere else (the camera found it away from the estimate)
   * with the heading the route has there, keeping what was learned about its
   * motors (bias, speed and turn scale).
   */
  relocate(pose: { x: number; y: number; headingDeg: number }, sigma: { cm: number; deg: number } = { cm: 3, deg: 12 }): void {
    const keep = [this.s[3], this.s[4], this.s[5]];
    const pk = [this.P[3 * N + 3], this.P[4 * N + 4], this.P[5 * N + 5]];
    this.s = [pose.x, pose.y, pose.headingDeg * RAD, keep[0], keep[1], keep[2]];
    this.P = eye([sigma.cm ** 2, sigma.cm ** 2, (sigma.deg * RAD) ** 2, pk[0], pk[1], pk[2]]);
    this.snaps = [{ t: this.t, s: [...this.s], P: [...this.P], vl: this.vl, vr: this.vr }];
    this.rejects = 0;
  }

  /** A command sent at tSent (it takes effect cmdLatencyMs later). */
  setCommand(tSent: number, l: number, r: number): void {
    const last = this.cmds[this.cmds.length - 1];
    if (last.l === l && last.r === r) return;
    this.cmds.push({ t: tSent + this.opts.cmdLatencyMs, l, r });
    const cutoff = this.t - this.opts.historyMs - 1000;
    while (this.cmds.length > 2 && this.cmds[1].t < cutoff) this.cmds.shift();
  }

  private cmdAt(t: number): { l: number; r: number } {
    for (let i = this.cmds.length - 1; i >= 0; i--) if (this.cmds[i].t <= t) return this.cmds[i];
    return this.cmds[0];
  }

  /** One prediction step of dt ms with the command in force at the step's start. */
  private step(dtMs: number): void {
    const m = this.model;
    const dt = dtMs / 1000;
    const c = this.cmdAt(this.t);
    const k = 1 - Math.exp(-dtMs / m.tauMs);
    this.vl += (wheelSpeed(m, c.l, 'L') - this.vl) * k;
    this.vr += (wheelSpeed(m, c.r, 'R') - this.vr) * k;
    const [x, y, th, b, kv, kw] = this.s;
    const vm = (this.vl + this.vr) / 2;
    const v = kv * vm;
    const wd = (this.vl - this.vr) / m.trackWidthCm;
    const w = kw * wd + b;
    const cos = Math.cos(th), sin = Math.sin(th);
    this.s = [x + v * cos * dt, y + v * sin * dt, th + w * dt, b, kv, kw];
    const F = eye([1, 1, 1, 1, 1, 1]);
    F[0 * N + 2] = -v * sin * dt;
    F[0 * N + 4] = vm * cos * dt;
    F[1 * N + 2] = v * cos * dt;
    F[1 * N + 4] = vm * sin * dt;
    F[2 * N + 3] = dt;
    F[2 * N + 5] = wd * dt;
    this.P = propagateP(this.P, F);
    // Process noise: slip grows with speed, spin errors with turn rate.
    const qPos = (0.12 * Math.abs(v) + 0.3) ** 2 * dt;
    const spin = Math.abs(this.vl - this.vr) / m.trackWidthCm;
    const qTh = (0.08 * spin + (0.02 * Math.abs(v)) / m.trackWidthCm + 0.005) ** 2 * dt;
    this.P[0] += qPos;
    this.P[N + 1] += qPos;
    this.P[2 * N + 2] += qTh;
    this.P[3 * N + 3] += 0.02 ** 2 * dt;
    this.P[4 * N + 4] += 0.01 ** 2 * dt;
    this.P[5 * N + 5] += 0.005 ** 2 * dt;
    this.t += dtMs;
  }

  /** Integrate up to time t, keeping a snapshot per step. */
  advance(t: number): void {
    const h = this.opts.stepMs;
    while (this.t + h <= t) {
      this.step(h);
      this.snaps.push({ t: this.t, s: [...this.s], P: [...this.P], vl: this.vl, vr: this.vr });
    }
    const cutoff = this.t - this.opts.historyMs;
    let drop = 0;
    while (drop < this.snaps.length - 1 && this.snaps[drop + 1].t < cutoff) drop++;
    if (drop) this.snaps.splice(0, drop);
  }

  /** Fold in a camera fix of marker A taken at fix.t. */
  addFix(fix: { t: number; x: number; y: number; headingDeg: number | null; cmPerPx: number }): FixResult {
    this.stats.fixes++;
    if (fix.t > this.t) this.advance(fix.t);
    const now = this.t;
    // Roll back to the last snapshot at or before the fix.
    let i = this.snaps.length - 1;
    while (i > 0 && this.snaps[i].t > fix.t) i--;
    const snap = this.snaps[i];
    if (!snap || snap.t > fix.t) {
      this.stats.rejected++;
      return { used: false, reason: 'too old', dx: 0, dy: 0, nis: 0 };
    }
    const saved = { s: this.s, P: this.P, t: this.t, vl: this.vl, vr: this.vr, snaps: this.snaps };
    this.s = [...snap.s];
    this.P = [...snap.P];
    this.t = snap.t;
    this.vl = snap.vl;
    this.vr = snap.vr;
    this.snaps = this.snaps.slice(0, i + 1);
    if (fix.t > this.t) this.step(fix.t - this.t);

    const res = this.update(fix);
    if (!res.used && res.reason !== 'reset') {
      // Nothing changed: put the present back as it was.
      this.s = saved.s;
      this.P = saved.P;
      this.t = saved.t;
      this.vl = saved.vl;
      this.vr = saved.vr;
      this.snaps = saved.snaps;
      return res;
    }
    this.snaps.push({ t: this.t, s: [...this.s], P: [...this.P], vl: this.vl, vr: this.vr });
    // Replay to the present (the step boundaries stay on the original grid).
    const h = this.opts.stepMs;
    const firstStep = Math.ceil((this.t - snap.t) / h) * h + snap.t;
    if (firstStep > this.t && firstStep <= now) {
      this.step(firstStep - this.t);
      this.snaps.push({ t: this.t, s: [...this.s], P: [...this.P], vl: this.vl, vr: this.vr });
    }
    this.advance(now);
    if (this.t < now) this.step(now - this.t);
    return res;
  }

  private update(fix: { x: number; y: number; headingDeg: number | null; cmPerPx: number }): FixResult {
    const d = this.opts.markerAheadCm;
    const [x, y, th] = this.s;
    const cos = Math.cos(th), sin = Math.sin(th);
    const zx = fix.x - (x + d * cos), zy = fix.y - (y + d * sin);
    // H rows: ∂h/∂state
    const Hx = [1, 0, -d * sin, 0, 0, 0];
    const Hy = [0, 1, d * cos, 0, 0, 0];
    const sig = Math.max(this.opts.fixSigmaCm, 1.2 * (Number.isFinite(fix.cmPerPx) ? fix.cmPerPx : 1));
    const R = sig * sig;
    const PHt = (h: number[]) => Array.from({ length: N }, (_, i) => h.reduce((s, hv, k) => s + this.P[i * N + k] * hv, 0));
    const ax = PHt(Hx), ay = PHt(Hy);
    const S00 = Hx.reduce((s, hv, k) => s + hv * ax[k], 0) + R;
    const S01 = Hx.reduce((s, hv, k) => s + hv * ay[k], 0);
    const S11 = Hy.reduce((s, hv, k) => s + hv * ay[k], 0) + R;
    const det = S00 * S11 - S01 * S01;
    if (!(det > 0)) return { used: false, reason: 'singular', dx: zx, dy: zy, nis: 0 };
    const i00 = S11 / det, i01 = -S01 / det, i11 = S00 / det;
    const nis = zx * (i00 * zx + i01 * zy) + zy * (i01 * zx + i11 * zy);
    if (nis > 30) {
      // Far from where the robot should be: a false detection, or the estimate is lost.
      this.rejects++;
      this.stats.rejected++;
      if (this.rejects >= 6) {
        // Trust the camera: move there, keep the heading, widen the uncertainty.
        this.s = [fix.x - d * cos, fix.y - d * sin, th, this.s[3], this.s[4], this.s[5]];
        this.P[0] = this.P[N + 1] = sig * sig * 4;
        this.P[2 * N + 2] = Math.max(this.P[2 * N + 2], (20 * RAD) ** 2);
        this.rejects = 0;
        this.stats.resets++;
        return { used: false, reason: 'reset', dx: zx, dy: zy, nis };
      }
      return { used: false, reason: 'gated', dx: zx, dy: zy, nis };
    }
    this.rejects = 0;
    // K = P Hᵀ S⁻¹
    const K = Array.from({ length: N }, (_, i) => [ax[i] * i00 + ay[i] * i01, ax[i] * i01 + ay[i] * i11]);
    for (let i = 0; i < N; i++) this.s[i] += K[i][0] * zx + K[i][1] * zy;
    // P = (I − K H) P
    const KH = new Array<number>(N * N).fill(0);
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) KH[i * N + j] = K[i][0] * Hx[j] + K[i][1] * Hy[j];
    const P2 = new Array<number>(N * N).fill(0);
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
      let s = this.P[i * N + j];
      for (let k = 0; k < N; k++) s -= KH[i * N + k] * this.P[k * N + j];
      P2[i * N + j] = s;
    }
    // keep it symmetric
    for (let i = 0; i < N; i++) for (let j = 0; j < i; j++) P2[i * N + j] = P2[j * N + i] = (P2[i * N + j] + P2[j * N + i]) / 2;
    this.P = P2;
    this.clampState();

    // Heading from B → A: weak, gated.
    if (fix.headingDeg !== null && this.opts.headingSigmaDeg > 0) {
      const r = (((fix.headingDeg * RAD - this.s[2]) % (2 * Math.PI)) + 3 * Math.PI) % (2 * Math.PI) - Math.PI;
      const Rh = (this.opts.headingSigmaDeg * RAD) ** 2;
      const Sh = this.P[2 * N + 2] + Rh;
      if ((r * r) / Sh < 6) {
        const Kh = Array.from({ length: N }, (_, i) => this.P[i * N + 2] / Sh);
        for (let i = 0; i < N; i++) this.s[i] += Kh[i] * r;
        const row2 = Array.from({ length: N }, (_, j) => this.P[2 * N + j]);
        for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) this.P[i * N + j] -= Kh[i] * row2[j];
        this.clampState();
      }
    }
    this.stats.used++;
    return { used: true, dx: zx, dy: zy, nis };
  }

  private clampState(): void {
    this.s[3] = Math.max(-1, Math.min(1, this.s[3])); // |bias| ≤ 57°/s
    this.s[4] = Math.max(0.6, Math.min(1.6, this.s[4]));
    this.s[5] = Math.max(0.6, Math.min(1.5, this.s[5]));
  }

  get pose(): EstPose {
    const [x, y, th, b, kv, kw] = this.s;
    return {
      t: this.t, x, y, headingDeg: wrap(th / RAD), biasDegS: b / RAD, speedScale: kv, turnScale: kw, vl: this.vl, vr: this.vr,
      sigmaCm: Math.sqrt(Math.max(0, (this.P[0] + this.P[N + 1]) / 2)), sigmaDeg: Math.sqrt(Math.max(0, this.P[2 * N + 2])) / RAD,
    };
  }

  /** Where marker A should be now (for the camera's search). */
  markerA(): { x: number; y: number } {
    const [x, y, th] = this.s;
    return { x: x + this.opts.markerAheadCm * Math.cos(th), y: y + this.opts.markerAheadCm * Math.sin(th) };
  }

  /** Whether a command would move a wheel at all. */
  moving(): boolean {
    const m = this.model;
    return Math.abs(this.vl) > 0.3 * minWheelSpeed(m, 'L') || Math.abs(this.vr) > 0.3 * minWheelSpeed(m, 'R');
  }
}

function wrap(a: number): number {
  let r = a % 360;
  if (r <= -180) r += 360;
  else if (r > 180) r -= 360;
  return r + 0;
}
