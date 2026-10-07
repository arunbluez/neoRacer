// Measured facts about one robot, keyed by its 5-letter id. Test summaries
// offer "Save to profile" for the values they measure.

import type { BlockingTable } from '../link/blocking';

export type RobotProfile = {
  robotId: string;
  name: string;
  mac?: string;
  /** -0.2..0.2, applied to the right wheel: right = right * (1 + trim). */
  trim: number;
  /** Trim per command level (T3.2, T3.7); preferred over `trim` when present. */
  trimTable?: { cmd: number; trim: number }[];
  /** Lowest command that moves the robot: left/right wheel, forward/back. */
  deadband?: { lf: number; lb: number; rf: number; rb: number };
  speedTable?: { cmd: number; cmPerS: number }[];
  spinTable?: { cmd: number; degPerS: number }[];
  trackWidthCm?: number;
  /** ms, from T1.5 (see link/blocking for the special keys). */
  blocking?: BlockingTable;
  safeWriteGapMs?: number;
  safePollHz?: number;
  packingSafe?: boolean;
  /** Send-to-seen latency from T4.5, ms. */
  ledLatencyMs?: number;
  /** Send-to-motion latency from T4.6, ms. */
  motionLatencyMs?: number;
  /** Line-sensor code per surface label, from T2.1. */
  surfaces?: Record<string, { code: number; share: number; n: number }>;
  compassCalibrated: boolean;
  /** Speed at s=100 over the day, from T3.6. */
  batteryLog?: { at: string; cmPerS: number; note?: string }[];
  notes: string;
  updatedAt: string;
};

export function newProfile(robotId: string, name: string, nowIso: string): RobotProfile {
  return { robotId, name, trim: 0, compassCalibrated: false, notes: '', updatedAt: nowIso };
}

/** Interpolate cm/s for a speed command from the speed table (linear, through 0 below the first point). */
export function cmPerSFor(profile: Pick<RobotProfile, 'speedTable'>, cmd: number): number | undefined {
  const t = [...(profile.speedTable ?? [])].sort((a, b) => a.cmd - b.cmd);
  if (t.length === 0) return undefined;
  const sign = Math.sign(cmd) || 1;
  const c = Math.abs(cmd);
  if (c <= t[0].cmd) return sign * (t[0].cmPerS * c) / t[0].cmd;
  for (let i = 1; i < t.length; i++) {
    if (c <= t[i].cmd) {
      const f = (c - t[i - 1].cmd) / (t[i].cmd - t[i - 1].cmd);
      return sign * (t[i - 1].cmPerS + f * (t[i].cmPerS - t[i - 1].cmPerS));
    }
  }
  const a = t[t.length - 2] ?? { cmd: 0, cmPerS: 0 };
  const b = t[t.length - 1];
  return sign * (b.cmPerS + ((c - b.cmd) * (b.cmPerS - a.cmPerS)) / Math.max(1, b.cmd - a.cmd));
}

/** Upsert a row keyed by cmd. */
export function upsertTable<T extends { cmd: number }>(rows: T[] | undefined, row: T): T[] {
  const out = (rows ?? []).filter((r) => r.cmd !== row.cmd);
  out.push(row);
  return out.sort((a, b) => a.cmd - b.cmd);
}
