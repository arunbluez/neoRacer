// Manual drive mixing: stick (or tilt) to wheel commands. Portable so the race
// app can reuse it.
//
// Measured on the real robot: a wheel doesn't turn below a command of ~15–20
// (its deadband) and, once it does, speed grows roughly in proportion to the
// command. So the stick is mapped onto [deadband, cap] per wheel: the first
// bit of stick travel already moves the robot slowly instead of doing nothing
// and then lurching. Trim corrects the right wheel and may differ per speed.

export type Deadband = { lf: number; lb: number; rf: number; rb: number };
export type TrimPoint = { cmd: number; trim: number };

export type DriveConfig = {
  /** Max wheel command, 0..100. */
  speedCap: number;
  /** 0 = linear, 1 = fully cubic. */
  expo: number;
  /** Right wheel factor: right = right * (1 + trim). Used when there is no trim table. */
  trim: number;
  /** Trim per command level (from T3.2 / T3.7), interpolated by speed. */
  trimTable?: TrimPoint[];
  /** How strongly x turns, relative to throttle (0..1). */
  turnGain?: number;
  /** Lowest command that moves each wheel; stick input starts there. */
  deadband?: Deadband;
  /** Stick travel around the centre that counts as zero (0..0.3). */
  deadzone?: number;
};

export const DEFAULT_DEADBAND = 15;

export const expoCurve = (v: number, expo: number) => (1 - expo) * v + expo * v * v * v;
const clamp1 = (v: number) => Math.max(-1, Math.min(1, v));

/** Trim for a command level: interpolated from the table, else the single trim. */
export function trimAt(cfg: Pick<DriveConfig, 'trim' | 'trimTable'>, cmd: number): number {
  const t = [...(cfg.trimTable ?? [])].sort((a, b) => a.cmd - b.cmd);
  if (t.length === 0) return cfg.trim;
  const c = Math.abs(cmd);
  if (c <= t[0].cmd) return t[0].trim;
  for (let i = 1; i < t.length; i++) {
    if (c <= t[i].cmd) {
      const f = (c - t[i - 1].cmd) / (t[i].cmd - t[i - 1].cmd);
      return t[i - 1].trim + f * (t[i].trim - t[i - 1].trim);
    }
  }
  return t[t.length - 1].trim;
}

/** Stick axis with a dead zone at the centre, rescaled so full travel is still ±1. */
function withDeadzone(v: number, dz: number): number {
  const a = Math.abs(v);
  if (a <= dz) return 0;
  return Math.sign(v) * Math.min(1, (a - dz) / (1 - dz));
}

/** Wheel effort (-1..1) to a command in [deadband, cap]; 0 stays 0. */
export function wheelCommand(u: number, cap: number, deadband: number): number {
  if (Math.abs(u) < 1e-3) return 0;
  const lo = Math.min(deadband, cap);
  return Math.sign(u) * (lo + Math.abs(u) * (cap - lo));
}

/**
 * Arcade mixing. x: turn, -1 (left) .. 1 (right). y: throttle, -1 (back) .. 1 (forward).
 * Returns integer wheel commands (each 0 or between its deadband and speedCap, then trimmed).
 */
export function arcade(x: number, y: number, cfg: DriveConfig): { l: number; r: number } {
  const dz = cfg.deadzone ?? 0.06;
  const t = expoCurve(withDeadzone(clamp1(y), dz), cfg.expo);
  const s = expoCurve(withDeadzone(clamp1(x), dz), cfg.expo) * (cfg.turnGain ?? 0.6);
  let l = t + s;
  let r = t - s;
  const m = Math.max(1, Math.abs(l), Math.abs(r));
  l /= m;
  r /= m;
  const cap = Math.max(0, Math.min(100, cfg.speedCap));
  const db = cfg.deadband ?? { lf: 0, lb: 0, rf: 0, rb: 0 };
  let L = wheelCommand(l, cap, l >= 0 ? db.lf : db.lb);
  let R = wheelCommand(r, cap, r >= 0 ? db.rf : db.rb);
  if (R !== 0) {
    R *= 1 + trimAt(cfg, (Math.abs(L) + Math.abs(R)) / 2);
    // trim must not push the wheel back under its deadband
    const dbR = R >= 0 ? db.rf : db.rb;
    if (Math.abs(R) < dbR) R = Math.sign(R) * dbR;
  }
  // Keep the ratio if a wheel goes past 100.
  const over = Math.max(Math.abs(L), Math.abs(R)) / 100;
  if (over > 1) {
    L /= over;
    R /= over;
  }
  return { l: Math.round(L), r: Math.round(R) };
}

/** Phone tilt to a stick position, relative to a neutral pose captured when tilt mode starts. */
export function tiltToStick(beta: number, gamma: number, neutral: { beta: number; gamma: number }, maxDeg: number): { x: number; y: number } {
  const dead = 2;
  const f = (d: number) => (Math.abs(d) < dead ? 0 : clamp1((d - Math.sign(d) * dead) / Math.max(1, maxDeg - dead)));
  // Tilting the top of the phone away (beta decreasing) drives forward.
  return { x: f(gamma - neutral.gamma), y: f(neutral.beta - beta) };
}
