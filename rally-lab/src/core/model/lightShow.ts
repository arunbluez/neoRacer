// The robot's lights as signals: amber turn signals on the headlight of the
// side it turns to, red when it brakes or reverses, and underglow that
// follows the speed (or shows the link's health when it stands still).
//
// Two modes. 'drive' (manual driving): everything, worked out from the wheel
// commands, turn signals blinking. 'auto' (a camera-assisted run): the run
// says what it is doing (a turn of the route coming up, braking, backing up)
// so the lights change a couple of times per turn, not with every steering
// correction (each light command takes Bluetooth time from the motors). The
// camera tracks the robot by its marker colour, so the underglow always
// stays that colour and only the headlights signal, steadily. The camera's
// fix then sits where the marker-coloured lights are: see markerHeadlightsAt
// (the tracker shifts its idea of the light centre).
//
// Light commands are only sent when something changes, at most one every
// minGapMs, most important first (brake/reverse, signals, underglow).

import type { Rgb } from '../protocol/commands';

export type LightMode = { kind: 'off' } | { kind: 'drive' } | { kind: 'auto'; marker: Rgb };

export type LightState = { hlL: Rgb; hlR: Rgb; ug: Rgb };

/** What an auto run is doing, for its lights. */
export type LightIntent = { signal: 'L' | 'R' | null; brake: boolean; reverse: boolean };

export const AMBER: Rgb = { r: 255, g: 140, b: 0 };
export const BRAKE_RED: Rgb = { r: 255, g: 0, b: 0 };
const DIM_RED: Rgb = { r: 90, g: 0, b: 0 };
const WHITE: Rgb = { r: 255, g: 255, b: 255 };
const OFF: Rgb = { r: 0, g: 0, b: 0 };

export type LightShowOpts = {
  /** Shortest gap between two light commands, ms. */
  minGapMs: number;
  /** Turn signal blink period in drive mode, ms (on half, off half). */
  blinkMs: number;
  /** How long the brake lights stay on after a slow-down, ms. */
  brakeHoldMs: number;
};

export const DEFAULT_LIGHT_OPTS: LightShowOpts = { minGapMs: 130, blinkMs: 500, brakeHoldMs: 700 };

/** Auto runs: fewer, calmer light commands. */
const AUTO_MIN_GAP_MS = 250;

const same = (a: Rgb, b: Rgb) => a.r === b.r && a.g === b.g && a.b === b.b;
const cmd = (name: string, c: Rgb) => `${name},${c.r},${c.g},${c.b}`;

/** Underglow colour for a speed (command units 0..100): teal → lime → hot pink, in 5 steps. */
export function speedColor(v: number): Rgb {
  const steps: Rgb[] = [
    { r: 0, g: 200, b: 170 }, { r: 60, g: 230, b: 60 }, { r: 210, g: 255, b: 0 }, { r: 255, g: 120, b: 0 }, { r: 255, g: 0, b: 140 },
  ];
  const i = Math.max(0, Math.min(steps.length - 1, Math.floor((Math.abs(v) - 15) / 15)));
  return steps[i];
}

/** Standing still: the link's health (round trip, ms). */
export function healthColor(rttMs: number | null): Rgb {
  if (rttMs === null) return { r: 0, g: 40, b: 60 };
  if (rttMs < 80) return { r: 0, g: 70, b: 25 };
  if (rttMs < 200) return { r: 90, g: 50, b: 0 };
  return { r: 90, g: 0, b: 0 };
}

/** What the lights should show at time t. */
export function lightFrame(o: {
  mode: LightMode; t: number; l: number; r: number; braking: boolean; rttMs: number | null; blinkMs: number; intent?: LightIntent;
}): LightState | null {
  const { mode } = o;
  if (mode.kind === 'off') return null;
  if (mode.kind === 'auto') {
    const base = mode.marker;
    const it = o.intent ?? { signal: null, brake: false, reverse: false };
    if (it.reverse || it.brake) return { hlL: BRAKE_RED, hlR: BRAKE_RED, ug: base };
    return { hlL: it.signal === 'L' ? AMBER : base, hlR: it.signal === 'R' ? AMBER : base, ug: base };
  }
  const v = (o.l + o.r) / 2;
  const diff = o.l - o.r; // > 0: left wheel faster, turning right
  const reversing = v < -2 || (o.l < 0 && o.r < 0);
  const turning = Math.abs(diff) >= Math.max(6, 0.25 * Math.abs(v)) && !reversing;
  const side: 'L' | 'R' | null = turning ? (diff > 0 ? 'R' : 'L') : null;
  const blinkOn = Math.floor(o.t / (o.blinkMs / 2)) % 2 === 0;
  const moving = Math.abs(v) > 1;
  const head = reversing || o.braking ? BRAKE_RED : moving ? WHITE : DIM_RED;
  const ug = reversing ? BRAKE_RED : moving ? speedColor(v) : healthColor(o.rttMs);
  return {
    hlL: side === 'L' ? (blinkOn ? AMBER : OFF) : head,
    hlR: side === 'R' ? (blinkOn ? AMBER : OFF) : head,
    ug,
  };
}

export class LightShow {
  private mode: LightMode = { kind: 'off' };
  private motor = { l: 0, r: 0, t: 0 };
  private vPrev: { v: number; t: number }[] = [];
  private brakeUntil = -Infinity;
  private sent: LightState | null = null;
  private lastSendT = -Infinity;
  private heldUntil = -Infinity;
  /** When each headlight state took effect (for the camera): marker-coloured headlights count. */
  private headLog: { t: number; n: number }[] = [{ t: -Infinity, n: 2 }];
  rttMs: number | null = null;
  /** What the auto run is doing (auto mode). */
  intent: LightIntent = { signal: null, brake: false, reverse: false };
  readonly opts: LightShowOpts;

  constructor(private readonly send: (cmd: string) => void, opts: Partial<LightShowOpts> = {}) {
    this.opts = { ...DEFAULT_LIGHT_OPTS, ...opts };
  }

  get kind(): LightMode['kind'] {
    return this.mode.kind;
  }

  /** Switch mode. The lights already showing are taken as unknown: the next tick sets them all. */
  setMode(mode: LightMode, t: number): void {
    if (JSON.stringify(mode) === JSON.stringify(this.mode)) return;
    this.mode = mode;
    this.sent = null;
    if (mode.kind === 'auto') this.headLog.push({ t, n: 2 });
  }

  /** Someone else drives the lights for a while (the blink test): stay quiet, then set them all again. */
  hold(ms: number, now: number): void {
    this.heldUntil = Math.max(this.heldUntil, now + ms);
    this.sent = null;
  }

  /** A motor command went out (wheel commands, signed). */
  setMotor(l: number, r: number, t: number): void {
    const v = (l + r) / 2;
    // A clear slow-down (or stopping from speed) lights the brakes for a moment.
    this.vPrev.push({ v, t });
    while (this.vPrev.length > 1 && t - this.vPrev[0].t > 600) this.vPrev.shift();
    const top = Math.max(...this.vPrev.map((p) => p.v));
    if (v >= 0 && top - v >= 8 && top > 12) this.brakeUntil = t + this.opts.brakeHoldMs;
    this.motor = { l, r, t };
  }

  /** Called every ~50–100 ms: sends what changed. */
  tick(t: number): void {
    if (t < this.heldUntil) return;
    const want = lightFrame({
      mode: this.mode, t, l: this.motor.l, r: this.motor.r, braking: t < this.brakeUntil, rttMs: this.rttMs, blinkMs: this.opts.blinkMs, intent: this.intent,
    });
    if (!want) return;
    if (t - this.lastSendT < (this.mode.kind === 'auto' ? AUTO_MIN_GAP_MS : this.opts.minGapMs)) return;
    // What the robot shows (unknown after a mode change or a hold: everything is sent again).
    const unknown: Rgb = { r: -1, g: -1, b: -1 };
    const s: LightState = this.sent ?? { hlL: unknown, hlR: unknown, ug: unknown };
    // One command per tick, most important first.
    let out: string | null = null;
    let next: LightState | null = null;
    if (!same(s.hlL, want.hlL) || !same(s.hlR, want.hlR)) {
      if (same(want.hlL, want.hlR)) {
        out = cmd('HL', want.hlL);
        next = { ...s, hlL: want.hlL, hlR: want.hlR };
      } else if (!same(s.hlL, want.hlL)) {
        out = cmd('HLL', want.hlL);
        next = { ...s, hlL: want.hlL };
      } else {
        out = cmd('HLR', want.hlR);
        next = { ...s, hlR: want.hlR };
      }
    } else if (!same(s.ug, want.ug)) {
      out = cmd('UG', want.ug);
      next = { ...s, ug: want.ug };
    }
    if (!out || !next) return;
    this.sent = next;
    this.lastSendT = t;
    this.send(out);
    if (this.mode.kind === 'auto') {
      const m = this.mode.marker;
      const n = (same(next.hlL, m) ? 1 : 0) + (same(next.hlR, m) ? 1 : 0);
      if (n !== this.headLog[this.headLog.length - 1].n) this.headLog.push({ t, n });
      if (this.headLog.length > 50) this.headLog.splice(1, 25);
    }
  }

  /**
   * How many headlights showed the marker colour at time t (2 = both): the
   * camera's light centre moves back towards the underglow with fewer. The
   * robot takes ~80 ms to show a command.
   */
  markerHeadlightsAt(t: number): number {
    for (let i = this.headLog.length - 1; i >= 0; i--) if (this.headLog[i].t + 80 <= t) return this.headLog[i].n;
    return 2;
  }
}

/**
 * Where the camera sees the light centre, ahead of the axle, with n of the
 * two headlights in the marker colour (the underglow always is): all four
 * lights average at `aheadAll`; the headlights are ~2× that ahead, the
 * underglow at the axle.
 */
export function markerAheadFor(n: number, aheadAll: number): number {
  return (aheadAll * 2 * n) / (2 + n);
}
