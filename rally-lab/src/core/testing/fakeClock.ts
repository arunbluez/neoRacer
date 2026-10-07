// Test helper: a Clock that follows vitest's fake timers (Date is faked).
import type { Clock } from '../types';

export function fakeClock(): Clock {
  const t0 = Date.now();
  return { now: () => Date.now() - t0 };
}
