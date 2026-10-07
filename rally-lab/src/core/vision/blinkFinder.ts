// Which of the lights on the mat is our robot: blink its lights on and off in
// a known rhythm and find the light that follows it. Other robots' lights,
// cones and reflections don't blink with ours.

import type { Pt } from './linalg';

export type BlinkStep = { t: number; on: boolean };

/** On/off pattern (ms from the start): five changes, unlike anything steady. */
export const BLINK_PATTERN: BlinkStep[] = [
  { t: 0, on: false }, { t: 400, on: true }, { t: 800, on: false }, { t: 1100, on: true }, { t: 1700, on: false }, { t: 2000, on: true },
];
export const BLINK_MS = 2400;

export type BlinkResult = { pos: Pt; agreement: number; latencyMs: number; onFrames: number; offFrames: number };

type Obs = { t: number; blobs: Pt[] };

export class BlinkFinder {
  private obs: Obs[] = [];

  constructor(private readonly t0: number, private readonly pattern: BlinkStep[] = BLINK_PATTERN) {}

  /** Lights seen in a frame taken at t (mat cm). */
  add(t: number, blobs: Pt[]): void {
    this.obs.push({ t, blobs });
  }

  get frames(): number {
    return this.obs.length;
  }

  private stateAt(t: number): boolean | null {
    const rel = t - this.t0;
    let s: boolean | null = null;
    for (const p of this.pattern) {
      // too close to a change to say
      if (Math.abs(rel - p.t) < 70) return null;
      if (p.t <= rel) s = p.on;
    }
    return s;
  }

  /** The light that blinked with the pattern, or null. */
  result(): BlinkResult | null {
    // Places where lights were seen (clustered within 6 cm).
    const places: { x: number; y: number; n: number }[] = [];
    for (const o of this.obs) {
      for (const b of o.blobs) {
        const p = places.find((q) => Math.hypot(q.x - b.x, q.y - b.y) < 6);
        if (p) {
          p.x = (p.x * p.n + b.x) / (p.n + 1);
          p.y = (p.y * p.n + b.y) / (p.n + 1);
          p.n++;
        } else places.push({ x: b.x, y: b.y, n: 1 });
      }
    }
    let best: BlinkResult | null = null;
    for (const place of places) {
      for (let lat = 0; lat <= 400; lat += 25) {
        let agree = 0, total = 0, on = 0, off = 0;
        for (const o of this.obs) {
          const want = this.stateAt(o.t - lat);
          if (want === null) continue;
          const seen = o.blobs.some((b) => Math.hypot(b.x - place.x, b.y - place.y) < 8);
          total++;
          if (seen === want) agree++;
          if (want) on++;
          else off++;
        }
        if (on < 2 || off < 2) continue;
        const a = agree / total;
        if (!best || a > best.agreement) best = { pos: { x: place.x, y: place.y }, agreement: a, latencyMs: lat, onFrames: on, offFrames: off };
      }
    }
    return best && best.agreement >= 0.85 ? best : null;
  }
}
