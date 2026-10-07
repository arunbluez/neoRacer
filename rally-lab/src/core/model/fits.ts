// Motion model fits used by the motion tests.

import { median } from '../util/stats';

export type P = { x: number; y: number };
export type TimedP = P & { t: number };

/** Algebraic (Kåsa) circle fit. Returns null for fewer than 3 points or collinear points. */
export function circleFit(pts: P[]): { cx: number; cy: number; r: number; rms: number } | null {
  if (pts.length < 3) return null;
  const mx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const my = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  let suu = 0, svv = 0, suv = 0, suuu = 0, svvv = 0, suvv = 0, svuu = 0;
  for (const p of pts) {
    const u = p.x - mx;
    const v = p.y - my;
    suu += u * u; svv += v * v; suv += u * v;
    suuu += u * u * u; svvv += v * v * v; suvv += u * v * v; svuu += v * u * u;
  }
  const det = suu * svv - suv * suv;
  if (Math.abs(det) < 1e-9) return null;
  const a = 0.5 * (suuu + suvv);
  const b = 0.5 * (svvv + svuu);
  const uc = (a * svv - b * suv) / det;
  const vc = (b * suu - a * suv) / det;
  const r = Math.sqrt(uc * uc + vc * vc + (suu + svv) / pts.length);
  const cx = uc + mx;
  const cy = vc + my;
  const rms = Math.sqrt(pts.reduce((s, p) => s + (Math.hypot(p.x - cx, p.y - cy) - r) ** 2, 0) / pts.length);
  return { cx, cy, r, rms };
}

/**
 * Signed curvature (1/cm) of a nearly straight path, from a circle fit:
 * positive when it bends to the robot's right (clockwise on a y-down mat).
 * Independent of any heading measurement.
 */
export function signedCurvature(pts: P[]): number {
  if (pts.length < 5) return 0;
  const fit = circleFit(pts);
  if (!fit || fit.r > 1e5) return 0;
  const a = pts[0];
  const m = pts[Math.floor(pts.length / 2)];
  const b = pts[pts.length - 1];
  const cross = (m.x - a.x) * (b.y - m.y) - (m.y - a.y) * (b.x - m.x);
  return cross === 0 ? 0 : Math.sign(cross) / fit.r;
}

/** Path length of a polyline. */
export function pathLength(pts: P[]): number {
  let d = 0;
  for (let i = 1; i < pts.length; i++) d += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return d;
}

/** Unwrap a sequence of angles in degrees so it has no ±360 jumps. */
export function unwrapDeg(a: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < a.length; i++) {
    if (i === 0) {
      out.push(a[0]);
      continue;
    }
    let d = a[i] - a[i - 1];
    d = ((((d + 180) % 360) + 360) % 360) - 180;
    out.push(out[i - 1] + d);
  }
  return out;
}

/**
 * Displacement from a start pose split into along-heading and sideways parts.
 * Sideways is positive to the robot's right (y-down mat coordinates).
 */
export function alongAndSide(start: P, headingDeg: number, end: P): { along: number; side: number } {
  const th = (headingDeg * Math.PI) / 180;
  const fx = Math.cos(th);
  const fy = Math.sin(th);
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  // right of heading in y-down coordinates is (-fy, fx)
  return { along: dx * fx + dy * fy, side: -dx * fy + dy * fx };
}

/** Speed from a straight-line fit of distance travelled over time within [t0, t1] (ms). */
export function steadySpeed(pts: TimedP[], t0: number, t1: number): number | null {
  const sel = pts.filter((p) => p.t >= t0 && p.t <= t1);
  if (sel.length < 3) return null;
  const s: number[] = [0];
  for (let i = 1; i < sel.length; i++) s.push(s[i - 1] + Math.hypot(sel[i].x - sel[i - 1].x, sel[i].y - sel[i - 1].y));
  const ts = sel.map((p) => p.t / 1000);
  const mt = ts.reduce((a, b) => a + b, 0) / ts.length;
  const ms = s.reduce((a, b) => a + b, 0) / s.length;
  let num = 0;
  let den = 0;
  for (let i = 0; i < ts.length; i++) {
    num += (ts[i] - mt) * (s[i] - ms);
    den += (ts[i] - mt) ** 2;
  }
  return den > 0 ? num / den : null;
}

/** Speed profile by central differences, cm/s at each point's time. */
export function speeds(pts: TimedP[]): { t: number; v: number }[] {
  const out: { t: number; v: number }[] = [];
  for (let i = 1; i < pts.length - 1; i++) {
    const dt = (pts[i + 1].t - pts[i - 1].t) / 1000;
    if (dt <= 0) continue;
    out.push({ t: pts[i].t, v: Math.hypot(pts[i + 1].x - pts[i - 1].x, pts[i + 1].y - pts[i - 1].y) / dt });
  }
  return out;
}

/**
 * Trim that would cancel a measured drift: drifting right means the right
 * wheel is slower. Curvature k = 2·side / along², wheel speed difference
 * (vl - vr)/v = k·W, and trim is applied to the right wheel.
 */
export function trimFromDrift(along: number, side: number, trackWidthCm: number): number {
  if (Math.abs(along) < 5) return 0;
  const k = (2 * side) / (along * along);
  return k * trackWidthCm;
}

/** Effective track width from an arc: W = |vL − vR| / ω with ω = v / R. */
export function trackWidthFromArc(vLeft: number, vRight: number, speed: number, radius: number): number | null {
  if (speed <= 0 || radius <= 0) return null;
  const omega = speed / radius;
  return Math.abs(vLeft - vRight) / omega;
}

/** Radius from a chord and a heading change (manual arc entry). */
export function radiusFromChord(chordCm: number, headingChangeDeg: number): number | null {
  const th = (Math.abs(headingChangeDeg) * Math.PI) / 180;
  if (th < 1e-3) return null;
  return chordCm / (2 * Math.sin(th / 2));
}

export function medianOrNull(xs: number[]): number | null {
  const f = xs.filter(Number.isFinite);
  return f.length ? median(f) : null;
}
