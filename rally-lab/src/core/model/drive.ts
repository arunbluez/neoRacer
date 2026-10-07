// Manual drive mixing: stick (or tilt) to wheel commands. Portable so the race
// app can reuse it.

export type DriveConfig = {
  /** Max wheel command, 0..100. */
  speedCap: number;
  /** 0 = linear, 1 = fully cubic. */
  expo: number;
  /** Right wheel factor: right = right * (1 + trim). */
  trim: number;
  /** How strongly x turns, relative to throttle. */
  turnGain?: number;
};

export const expoCurve = (v: number, expo: number) => (1 - expo) * v + expo * v * v * v;
const clamp1 = (v: number) => Math.max(-1, Math.min(1, v));

/**
 * Arcade mixing. x: turn, -1 (left) .. 1 (right). y: throttle, -1 (back) .. 1 (forward).
 * Returns integer wheel commands in -speedCap..speedCap (trim may scale both down).
 */
export function arcade(x: number, y: number, cfg: DriveConfig): { l: number; r: number } {
  const t = expoCurve(clamp1(y), cfg.expo);
  const s = expoCurve(clamp1(x), cfg.expo) * (cfg.turnGain ?? 0.8);
  let l = t + s;
  let r = t - s;
  const m = Math.max(1, Math.abs(l), Math.abs(r));
  l /= m;
  r /= m;
  const cap = Math.max(0, Math.min(100, cfg.speedCap));
  l *= cap;
  r *= cap * (1 + cfg.trim);
  // Keep the ratio if trim pushes a wheel past 100.
  const over = Math.max(Math.abs(l), Math.abs(r)) / 100;
  if (over > 1) {
    l /= over;
    r /= over;
  }
  return { l: Math.round(l), r: Math.round(r) };
}

/** Phone tilt to a stick position, relative to a neutral pose captured when tilt mode starts. */
export function tiltToStick(beta: number, gamma: number, neutral: { beta: number; gamma: number }, maxDeg: number): { x: number; y: number } {
  const dead = 2;
  const f = (d: number) => (Math.abs(d) < dead ? 0 : clamp1((d - Math.sign(d) * dead) / Math.max(1, maxDeg - dead)));
  // Tilting the top of the phone away (beta decreasing) drives forward.
  return { x: f(gamma - neutral.gamma), y: f(neutral.beta - beta) };
}
