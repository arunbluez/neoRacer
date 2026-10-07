// α-β filtering of the robot pose. Units: cm, cm/s, ms timestamps.
// Heading: degrees in mat coordinates, atan2(dy, dx) — 0 = +x (right),
// 90 = +y (down the mat) — wrapped to (-180, 180].

/** Wrap to (-180, 180]. */
export function wrapDeg(a: number): number {
  let r = a % 360;
  if (r <= -180) r += 360;
  else if (r > 180) r -= 360;
  return r + 0; // -0 → 0
}

/** Signed smallest rotation from b to a, (-180, 180]. */
export function angleDiffDeg(a: number, b: number): number {
  return wrapDeg(a - b);
}

export type FilteredPose = { x: number; y: number; vx: number; vy: number; headingDeg: number; omegaDegS: number; t: number };

/** Below this speed (cm/s) a velocity direction is too noisy to serve as heading. */
const MIN_HEADING_SPEED = 3;
const RAD = 180 / Math.PI;

export class AlphaBetaPoseFilter {
  private readonly alpha: number;
  private readonly beta: number;
  private readonly alphaH: number;
  private readonly betaH: number;
  private readonly maxGapMs: number;
  private s: FilteredPose | null = null;
  private hasHeading = false;

  /** Defaults: alpha 0.5, beta 0.15 (position); alphaH 0.5, betaH 0.15 (heading); maxGapMs 500. */
  constructor(opts: { alpha?: number; beta?: number; alphaH?: number; betaH?: number; maxGapMs?: number } = {}) {
    this.alpha = opts.alpha ?? 0.5;
    this.beta = opts.beta ?? 0.15;
    this.alphaH = opts.alphaH ?? 0.5;
    this.betaH = opts.betaH ?? 0.15;
    this.maxGapMs = opts.maxGapMs ?? 500;
  }

  /**
   * Fold in a measurement taken at tMs. headingDeg null: heading follows the
   * filtered velocity when faster than 3 cm/s, else it is held (ω = 0).
   * The filter restarts from the measurement (v = 0) on the first call,
   * after a gap > maxGapMs, or if time runs backwards.
   */
  update(meas: { x: number; y: number; headingDeg: number | null }, tMs: number): FilteredPose {
    const s = this.s;
    if (!s || tMs < s.t || tMs - s.t > this.maxGapMs) {
      const known = meas.headingDeg !== null;
      this.hasHeading = known;
      this.s = { x: meas.x, y: meas.y, vx: 0, vy: 0, headingDeg: known ? wrapDeg(meas.headingDeg as number) : 0, omegaDegS: 0, t: tMs };
      return { ...this.s };
    }

    const dt = (tMs - s.t) / 1000;
    if (dt === 0) {
      // Same timestamp: blend the position, nothing to learn about rates.
      s.x += this.alpha * (meas.x - s.x);
      s.y += this.alpha * (meas.y - s.y);
      if (meas.headingDeg !== null) this.correctHeading(meas.headingDeg, s.headingDeg, 0);
      return { ...s };
    }

    const px = s.x + s.vx * dt, py = s.y + s.vy * dt;
    const rx = meas.x - px, ry = meas.y - py;
    s.x = px + this.alpha * rx;
    s.y = py + this.alpha * ry;
    s.vx += (this.beta / dt) * rx;
    s.vy += (this.beta / dt) * ry;

    let mh = meas.headingDeg;
    if (mh === null && Math.hypot(s.vx, s.vy) > MIN_HEADING_SPEED) mh = Math.atan2(s.vy, s.vx) * RAD;
    if (mh === null) s.omegaDegS = 0;
    else this.correctHeading(mh, wrapDeg(s.headingDeg + s.omegaDegS * dt), dt);
    s.t = tMs;
    return { ...s };
  }

  private correctHeading(mh: number, predicted: number, dt: number): void {
    const s = this.s as FilteredPose;
    if (!this.hasHeading) {
      this.hasHeading = true;
      s.headingDeg = wrapDeg(mh);
      s.omegaDegS = 0;
      return;
    }
    const r = angleDiffDeg(mh, predicted); // residual across the ±180° seam
    s.headingDeg = wrapDeg(predicted + this.alphaH * r);
    if (dt > 0) s.omegaDegS += (this.betaH / dt) * r;
  }

  /** Constant-velocity (and constant turn rate) extrapolation to tMs; null before the first update. */
  predict(tMs: number): FilteredPose | null {
    const s = this.s;
    if (!s) return null;
    const dt = (tMs - s.t) / 1000;
    return {
      x: s.x + s.vx * dt, y: s.y + s.vy * dt, vx: s.vx, vy: s.vy,
      headingDeg: wrapDeg(s.headingDeg + s.omegaDegS * dt), omegaDegS: s.omegaDegS, t: tMs,
    };
  }

  reset(): void {
    this.s = null;
    this.hasHeading = false;
  }

  /** Copy of the latest filtered pose, or null. */
  get state(): FilteredPose | null {
    return this.s ? { ...this.s } : null;
  }

  /** False until a heading has been measured or derived from motion. */
  get headingKnown(): boolean {
    return this.hasHeading;
  }
}
