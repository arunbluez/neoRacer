// A 2D world for the mock robot: differential-drive kinematics with a motor
// deadband, a first-order speed lag and a slight wheel mismatch, line sensors
// that read a track mask, and simple models of the other sensors.

import type { Rgb } from '../protocol/commands';
import { SURFACE, surfaceAt, type TrackMask } from './track';

export type SimParams = {
  /** Wheel speed at command 100, cm/s. */
  maxSpeedCmS: number;
  /** Commands below this don't move a wheel. */
  deadband: number;
  /** Speed lag time constant, ms. */
  tauMs: number;
  /** Right wheel speed factor (1 = matched). */
  rightFactor: number;
  trackWidthCm: number;
  /** Line sensors: distance ahead of the axle and half spacing, cm. */
  sensorAheadCm: number;
  sensorHalfSpacingCm: number;
  /** Whether the coloured lane reads black to the IR sensors. */
  laneReadsBlack: boolean;
  /** Ultrasonic reading when nothing is scripted, cm. */
  distanceCm: number;
  noise: number;
};

export const DEFAULT_SIM_PARAMS: SimParams = {
  maxSpeedCmS: 45,
  deadband: 12,
  tauMs: 120,
  rightFactor: 0.97,
  trackWidthCm: 9.2,
  sensorAheadCm: 5,
  sensorHalfSpacingCm: 0.8,
  laneReadsBlack: false,
  distanceCm: 45,
  noise: 1,
};

export type SimLights = { hlL: Rgb; hlR: Rgb; ugL: Rgb; ugR: Rgb };
const OFF: Rgb = { r: 0, g: 0, b: 0 };

export type SimPose = { x: number; y: number; headingDeg: number; vl: number; vr: number; t: number };

/** Deterministic pseudo-random numbers (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class SimWorld {
  params: SimParams;
  mask?: TrackMask;
  x: number;
  y: number;
  heading: number; // degrees, mat coordinates (0 = +x, 90 = +y)
  cmdL = 0;
  cmdR = 0;
  vl = 0;
  vr = 0;
  t: number;
  lights: SimLights = { hlL: OFF, hlR: OFF, ugL: OFF, ugR: OFF };
  /** Text or icon currently on the 5×5 display. */
  display = 'HAPPY';
  compassCalibrated = false;
  /** Optional dark rectangle (bridge) for the light sensor. */
  shade?: { x0: number; y0: number; x1: number; y1: number };
  private ax = 0;
  private ay = 0;
  private rand: () => number;

  constructor(tStart: number, opts: { params?: Partial<SimParams>; mask?: TrackMask; pose?: { x: number; y: number; headingDeg: number }; seed?: number } = {}) {
    this.params = { ...DEFAULT_SIM_PARAMS, ...(opts.params ?? {}) };
    this.mask = opts.mask;
    this.x = opts.pose?.x ?? 150;
    this.y = opts.pose?.y ?? 125;
    this.heading = opts.pose?.headingDeg ?? 0;
    this.t = tStart;
    this.rand = rng(opts.seed ?? 42);
  }

  place(x: number, y: number, headingDeg: number): void {
    this.x = x;
    this.y = y;
    this.heading = headingDeg;
    this.vl = this.vr = 0;
  }

  setMotors(l: number, r: number, t: number): void {
    this.advanceTo(t);
    this.cmdL = Math.max(-100, Math.min(100, l));
    this.cmdR = Math.max(-100, Math.min(100, r));
  }

  private target(cmd: number): number {
    const a = Math.abs(cmd);
    if (a < this.params.deadband) return 0;
    return Math.sign(cmd) * this.params.maxSpeedCmS * ((a - this.params.deadband) / (100 - this.params.deadband)) ** 0.9;
  }

  /** Integrate the motion up to time t (ms). */
  advanceTo(t: number): void {
    let dt = t - this.t;
    if (dt <= 0) return;
    const step = 5;
    const tl = this.target(this.cmdL);
    const tr = this.target(this.cmdR) * this.params.rightFactor;
    while (dt > 0) {
      const h = Math.min(step, dt);
      const k = 1 - Math.exp(-h / this.params.tauMs);
      const vl0 = this.vl;
      const vr0 = this.vr;
      this.vl += (tl - this.vl) * k;
      this.vr += (tr - this.vr) * k;
      const v = (this.vl + this.vr) / 2;
      // y points down on the mat: a faster right wheel turns toward -y.
      const omega = ((this.vl - this.vr) / this.params.trackWidthCm) * (180 / Math.PI);
      const th = (this.heading * Math.PI) / 180;
      this.x += (v * Math.cos(th) * h) / 1000;
      this.y += (v * Math.sin(th) * h) / 1000;
      this.heading = (((this.heading + (omega * h) / 1000) % 360) + 360) % 360;
      this.ax = ((this.vl + this.vr - vl0 - vr0) / 2 / (h / 1000)) / 981; // g, forward
      this.ay = ((v * omega * Math.PI) / 180) / 981; // g, centripetal
      dt -= h;
    }
    this.t = t;
  }

  pose(t: number): SimPose {
    this.advanceTo(t);
    return { x: this.x, y: this.y, headingDeg: this.heading, vl: this.vl, vr: this.vr, t };
  }

  private sensorPoint(side: -1 | 1): { x: number; y: number } {
    const th = (this.heading * Math.PI) / 180;
    const fx = Math.cos(th);
    const fy = Math.sin(th);
    // left of the heading in y-down coordinates is (fy, -fx)
    const lx = fy;
    const ly = -fx;
    const a = this.params.sensorAheadCm;
    const s = this.params.sensorHalfSpacingCm * (side === -1 ? 1 : -1);
    return { x: this.x + fx * a + lx * s, y: this.y + fy * a + ly * s };
  }

  private isBlack(p: { x: number; y: number }): boolean {
    if (!this.mask) return false;
    const c = surfaceAt(this.mask, p.x, p.y);
    if (c === SURFACE.offtrack) return true;
    if (c === SURFACE.lane) return this.params.laneReadsBlack;
    return false;
  }

  /** 0 both white, 1 right black, 2 left black, 3 both black. */
  lineCode(t: number): number {
    this.advanceTo(t);
    const l = this.isBlack(this.sensorPoint(-1));
    const r = this.isBlack(this.sensorPoint(1));
    return l && r ? 3 : l ? 2 : r ? 1 : 0;
  }

  private noise(amp: number): number {
    return (this.rand() * 2 - 1) * amp * this.params.noise;
  }

  distanceCm(t: number): number {
    this.advanceTo(t);
    return Math.max(0, Math.round(this.params.distanceCm + this.noise(1)));
  }

  /** micro:bit accelerometer, mg; flat and face up reads z ≈ -1024. */
  accel(t: number): [number, number, number] {
    this.advanceTo(t);
    const vib = this.cmdL !== 0 || this.cmdR !== 0 ? 25 : 0;
    return [
      Math.round(this.ay * 1000 + this.noise(12 + vib)),
      Math.round(-this.ax * 1000 + this.noise(12 + vib)),
      Math.round(-1024 + this.noise(15 + vib)),
    ];
  }

  lightLevel(t: number): number {
    this.advanceTo(t);
    const s = this.shade;
    const under = s && this.x >= s.x0 && this.x <= s.x1 && this.y >= s.y0 && this.y <= s.y1;
    return Math.max(0, Math.min(255, Math.round((under ? 18 : 60) + this.noise(3))));
  }

  temperature(): number {
    return 24;
  }

  /** Compass heading with mat "up" (-y) as north, 0..359. */
  compass(t: number): number {
    this.advanceTo(t);
    const motorOffset = this.cmdL !== 0 || this.cmdR !== 0 ? 6 : 0;
    return Math.round((((this.heading + 90 + motorOffset + this.noise(2)) % 360) + 360) % 360);
  }
}
