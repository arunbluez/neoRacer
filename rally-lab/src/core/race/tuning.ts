// Lap tuning: how fast the robot drives each part of the route. A speed for
// the straights and one for the turns of every section, how quickly the speed
// may rise and fall, and a grip limit in the turns. The speed profile
// (speedProfile.ts) turns it into a target speed at every point of the plan.
// No tuning = the constant speeds of the auto settings, as before.
//
// Tunings come from three places: "constant" (the auto settings' speeds),
// "quick" (the offline lap learner, learner.ts) and "engineer" (a plan from
// the race engineer on the laptop, engineerPlan.ts). Whatever the source, a
// tuning is clamped to TUNING_LIMITS, and one step may raise a number by at
// most MAX_STEP so a bad suggestion can't throw the robot off the track
// (lowering one is always allowed: slower and gentler is the safe way).

export type SectionSpeeds = {
  /** Target speed on the section's straights, cm/s. */
  straightCmS: number;
  /** Speed limit in its turns, cm/s (a tight turn may need more: the inner wheel must keep turning). */
  turnCmS: number;
};

export type TuningSource = 'constant' | 'quick' | 'engineer' | 'manual';

export type Tuning = {
  /** Per section id; a missing section drives at the auto settings' speeds. */
  sections: Record<string, SectionSpeeds>;
  /** How fast the speed may rise, cm/s². */
  accelCmS2: number;
  /** How fast it may fall (braking into turns), cm/s². */
  decelCmS2: number;
  /** Grip limit in turns: v² ≤ latAccel·R, cm/s². */
  latAccelCmS2: number;
  /** Steering firmness: distance over which a sideways error is corrected, cm (undefined = the auto settings'). */
  settleCm?: number;
  /** A short name for the lists ("engineer 3", "quick 2"). */
  label: string;
  source: TuningSource;
  /** ISO time it was made. */
  createdAt?: string;
};

type Range = readonly [number, number];

export const TUNING_LIMITS: {
  straightCmS: Range; turnCmS: Range; accelCmS2: Range; decelCmS2: Range; latAccelCmS2: Range; settleCm: Range;
} = {
  straightCmS: [18, 80],
  turnCmS: [18, 70],
  accelCmS2: [20, 400],
  decelCmS2: [20, 400],
  latAccelCmS2: [40, 2000],
  settleCm: [10, 60],
};

/**
 * Limits a tuning starts from: gentle enough to be safe at speed, loose
 * enough not to slow the constant-speed laps (their speed hardly changes).
 */
export const START_LIMITS = { accelCmS2: 150, decelCmS2: 150, latAccelCmS2: 500 } as const;

/** Biggest rise one step may make to any number (fraction of the current value). */
export const MAX_STEP = 0.25;

/** The auto settings' constant speeds as a tuning, with the starting limits. */
export function constantTuning(o: { speedCmS: number; curveSpeedCmS: number }, sectionIds: string[]): Tuning {
  const sections: Record<string, SectionSpeeds> = {};
  for (const id of sectionIds) sections[id] = { straightCmS: o.speedCmS, turnCmS: Math.min(o.speedCmS, o.curveSpeedCmS) };
  return { sections, ...START_LIMITS, label: `constant ${o.speedCmS} cm/s`, source: 'constant' };
}

/** Speeds of a section, falling back to the constant ones. */
export function sectionSpeeds(t: Tuning | undefined, id: string, o: { speedCmS: number; curveSpeedCmS: number }): SectionSpeeds {
  return t?.sections[id] ?? { straightCmS: o.speedCmS, turnCmS: Math.min(o.speedCmS, o.curveSpeedCmS) };
}

const r1 = (x: number) => Math.round(x * 10) / 10;

function clampTo(x: number, [lo, hi]: Range): number {
  return Math.min(hi, Math.max(lo, x));
}

/**
 * Bring a tuning inside the limits and, given the tuning in use (`ref`), no
 * more than MAX_STEP above it (the steering distance: no more than MAX_STEP
 * either way). Returns what had to change, in words.
 */
export function clampTuning(t: Tuning, ref?: Tuning, sectionIds?: string[]): { tuning: Tuning; warnings: string[] } {
  const warnings: string[] = [];
  const fix = (name: string, x: number, range: Range, refX?: number, bothWays = false): number => {
    if (!Number.isFinite(x)) {
      const back = refX ?? range[0];
      warnings.push(`${name}: not a number, kept ${back}`);
      return back;
    }
    let y = clampTo(x, range);
    if (y !== x) warnings.push(`${name}: ${r1(x)} is outside ${range[0]}–${range[1]}, using ${r1(y)}`);
    if (refX !== undefined && refX > 0) {
      const lo = bothWays ? refX * (1 - MAX_STEP) : -Infinity, hi = refX * (1 + MAX_STEP);
      const z = Math.min(hi, Math.max(lo, y));
      if (Math.abs(z - y) > 1e-9) warnings.push(`${name}: ${r1(y)} is more than ${MAX_STEP * 100} % from ${r1(refX)}, using ${r1(z)} this time`);
      y = z;
    }
    return r1(y);
  };
  const sections: Record<string, SectionSpeeds> = {};
  const ids = sectionIds ?? Object.keys(t.sections);
  for (const id of ids) {
    const s = t.sections[id] ?? ref?.sections[id];
    if (!s) continue;
    const rs = ref?.sections[id];
    sections[id] = {
      straightCmS: fix(`${id} straights`, s.straightCmS, TUNING_LIMITS.straightCmS, rs?.straightCmS),
      turnCmS: fix(`${id} turns`, s.turnCmS, TUNING_LIMITS.turnCmS, rs?.turnCmS),
    };
  }
  for (const id of Object.keys(t.sections)) if (!ids.includes(id)) warnings.push(`section ${id}: not on this route, ignored`);
  const out: Tuning = {
    sections,
    accelCmS2: fix('acceleration', t.accelCmS2, TUNING_LIMITS.accelCmS2, ref?.accelCmS2),
    decelCmS2: fix('braking', t.decelCmS2, TUNING_LIMITS.decelCmS2, ref?.decelCmS2),
    latAccelCmS2: fix('grip', t.latAccelCmS2, TUNING_LIMITS.latAccelCmS2, ref?.latAccelCmS2),
    label: String(t.label || 'tuning').slice(0, 40),
    source: t.source,
    ...(t.createdAt ? { createdAt: t.createdAt } : {}),
  };
  if (t.settleCm !== undefined) out.settleCm = fix('steering distance', t.settleCm, TUNING_LIMITS.settleCm, ref?.settleCm, true);
  return { tuning: out, warnings };
}

export type TuningChange = { key: string; from: number | undefined; to: number | undefined };

/** What differs between two tunings, number by number. */
export function tuningDiff(a: Tuning, b: Tuning): TuningChange[] {
  const out: TuningChange[] = [];
  const cmp = (key: string, x: number | undefined, y: number | undefined) => {
    if (x === undefined && y === undefined) return;
    if (x === undefined || y === undefined || Math.abs(x - y) > 0.05) out.push({ key, from: x, to: y });
  };
  const ids = [...new Set([...Object.keys(a.sections), ...Object.keys(b.sections)])].sort();
  for (const id of ids) {
    cmp(`${id} straights cm/s`, a.sections[id]?.straightCmS, b.sections[id]?.straightCmS);
    cmp(`${id} turns cm/s`, a.sections[id]?.turnCmS, b.sections[id]?.turnCmS);
  }
  cmp('acceleration cm/s²', a.accelCmS2, b.accelCmS2);
  cmp('braking cm/s²', a.decelCmS2, b.decelCmS2);
  cmp('grip cm/s²', a.latAccelCmS2, b.latAccelCmS2);
  cmp('steering distance cm', a.settleCm, b.settleCm);
  return out;
}
