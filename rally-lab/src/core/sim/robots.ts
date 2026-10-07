// The robots we have measured, as a profile (what the app knows) and as
// simulator parameters (how the mock robot behaves).

import type { RobotProfile } from '../model/profile';
import type { SimParams } from './world';

/** puguz, measured on 7 Oct 2026 (see docs/field-notes-2026-10-07.md). */
export const PUGUZ_PROFILE: Partial<RobotProfile> = {
  deadband: { lf: 20, lb: 15, rf: 20, rb: 20 },
  speedTable: [{ cmd: 30, cmPerS: 33.3 }, { cmd: 50, cmPerS: 56.7 }],
  trim: -0.08,
  trackWidthCm: 8.5,
};

/** A mock robot that behaves like puguz: jumps to ~20 cm/s at its deadband, right wheel faster. */
export const PUGUZ_SIM: Partial<SimParams> = {
  deadband: 18,
  linear: { a: 1.17, b: -1.8 },
  rightFactor: 1.1,
  trackWidthCm: 8.5,
  tauMs: 90,
};
