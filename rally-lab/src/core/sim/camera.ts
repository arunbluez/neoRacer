// A simulated phone camera: a pinhole camera anywhere around the mat (held by
// hand: it sways and shakes), the synthetic mat in perspective on a concrete
// floor, and the mock robot with its lights at their real heights, so the
// lights show the same parallax a real camera sees. Portable (no DOM), used by
// the simulated camera adapter and by end-to-end tests.

import { solveHomography } from '../vision/homography';
import { mat3Inv, type Mat3, type Pt } from '../vision/linalg';
import { fillDisc, renderPerspective, type ImageBuf } from '../vision/rectify';
import type { Rgb } from '../protocol/commands';
import { rng, type SimLights } from './world';

export type SimCameraPose = {
  /** Camera centre: mat cm and height above the mat. */
  eye: { x: number; y: number; height: number };
  /** Mat point on the optical axis. */
  target: { x: number; y: number };
  hfovDeg: number;
  /** Rotation about the optical axis, degrees. */
  rollDeg: number;
};

/** Standing behind the near edge (side b) holding the phone at chest height, as in the venue photo. */
export const HANDHELD_AT_B: SimCameraPose = { eye: { x: 105, y: 430, height: 115 }, target: { x: 100, y: 130 }, hfovDeg: 66, rollDeg: 0 };

type V3 = [number, number, number];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: V3): V3 => {
  const n = Math.sqrt(dot(a, a));
  return [a[0] / n, a[1] / n, a[2] / n];
};

export type Projector = {
  /** Mat point (x, y) at `height` cm above the mat → frame px, or null behind the camera. */
  project: (x: number, y: number, height?: number) => Pt | null;
  /** Mat plane → frame px. */
  H: Mat3;
  width: number;
  height: number;
};

/** Pinhole projection for a camera pose and frame size (world: x right, y towards the viewer, z into the mat). */
export function projector(pose: SimCameraPose, width: number, height: number): Projector {
  const eye: V3 = [pose.eye.x, pose.eye.y, -pose.eye.height];
  const f = unit(sub([pose.target.x, pose.target.y, 0], eye));
  const down: V3 = [0, 0, 1];
  let d = unit(sub(down, f.map((v) => v * dot(down, f)) as V3));
  let r = cross(d, f);
  const roll = (pose.rollDeg * Math.PI) / 180;
  if (roll) {
    const c = Math.cos(roll), s = Math.sin(roll);
    const r2: V3 = [r[0] * c + d[0] * s, r[1] * c + d[1] * s, r[2] * c + d[2] * s];
    d = [d[0] * c - r[0] * s, d[1] * c - r[1] * s, d[2] * c - r[2] * s];
    r = r2;
  }
  const fx = width / 2 / Math.tan((pose.hfovDeg * Math.PI) / 360);
  const cx = width / 2, cy = height / 2;
  const project = (x: number, y: number, h = 0): Pt | null => {
    const p = sub([x, y, -h], eye);
    const zc = dot(p, f);
    if (zc <= 1e-6) return null;
    return { x: (fx * dot(p, r)) / zc + cx, y: (fx * dot(p, d)) / zc + cy };
  };
  const src = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }];
  const H = solveHomography(src, src.map((q) => project(q.x, q.y) ?? { x: NaN, y: NaN }));
  return { project, H, width, height };
}

/** Hand-held sway and shake around a base pose; deterministic for a seed. */
export class HandShake {
  private rand: () => number;
  private phases: number[];
  constructor(private readonly base: SimCameraPose, private readonly amount = 1, seed = 7) {
    this.rand = rng(seed);
    this.phases = Array.from({ length: 6 }, () => this.rand() * Math.PI * 2);
  }

  /** The pose at time t (ms). */
  at(t: number): SimCameraPose {
    const k = this.amount;
    const s = (i: number, periodS: number) => Math.sin((2 * Math.PI * t) / 1000 / periodS + this.phases[i]);
    const tremor = () => (this.rand() * 2 - 1) * 0.4 * k;
    const b = this.base;
    return {
      eye: { x: b.eye.x + 4 * k * s(0, 3.1) + tremor(), y: b.eye.y + 3 * k * s(1, 4.3) + tremor(), height: b.eye.height + 3 * k * s(2, 2.7) + tremor() },
      target: { x: b.target.x + 5 * k * s(3, 3.7), y: b.target.y + 6 * k * s(4, 5.3) },
      hfovDeg: b.hfovDeg,
      rollDeg: b.rollDeg + 2 * k * s(5, 4.9),
    };
  }
}

export type FloorStyle = { rgb: [number, number, number]; noise: number };
export const CONCRETE: FloorStyle = { rgb: [150, 148, 142], noise: 14 };

/** The mat in perspective on a floor (mild deterministic texture so thresholds see something real). */
export function renderMatView(
  mat: ImageBuf, matWidthCm: number, matHeightCm: number, proj: Projector, floor: FloorStyle = CONCRETE,
): ImageBuf {
  const inv = mat3Inv(proj.H)!;
  const img = renderPerspective(mat, matWidthCm, matHeightCm, inv, proj.width, proj.height, floor.rgb);
  if (floor.noise > 0) {
    const d = img.data;
    for (let j = 0; j < img.height; j++) {
      for (let i = 0; i < img.width; i++) {
        // cheap hash noise, stronger on the floor than on the (smooth) mat
        const h = Math.sin(i * 12.9898 + j * 78.233) * 43758.5453;
        const n = (h - Math.floor(h) - 0.5) * floor.noise;
        const o = (j * img.width + i) * 4;
        d[o] += n;
        d[o + 1] += n;
        d[o + 2] += n;
      }
    }
  }
  return img;
}

export type RobotLook = {
  /** Headlights: ahead of the axle, half spacing, height above the mat (cm). */
  headAhead: number;
  headHalf: number;
  headHeight: number;
  /** Underglow: half spacing and height. */
  ugHalf: number;
  ugHeight: number;
  /** LED radius on the picture, cm. */
  ledCm: number;
};

export const CUTEBOT_LOOK: RobotLook = { headAhead: 5.5, headHalf: 2.2, headHeight: 3, ugHalf: 3, ugHeight: 1, ledCm: 1.6 };

/** Draw the robot (dark body, bright LEDs with a coloured halo). Hidden lights: those under `occluders`. */
export function drawSimRobot(
  img: ImageBuf, proj: Projector, pose: { x: number; y: number; headingDeg: number }, lights: SimLights,
  look: RobotLook = CUTEBOT_LOOK, occluders: { x0: number; y0: number; x1: number; y1: number }[] = [],
): void {
  const th = (pose.headingDeg * Math.PI) / 180;
  const fx = Math.cos(th), fy = Math.sin(th);
  const lx = fy, ly = -fx; // left of the heading on a y-down mat
  const at = (ahead: number, left: number) => ({ x: pose.x + fx * ahead + lx * left, y: pose.y + fy * ahead + ly * left });
  const pxPerCm = (q: Pt, h: number) => {
    const a = proj.project(q.x, q.y, h), b = proj.project(q.x + 1, q.y, h), c = proj.project(q.x, q.y + 1, h);
    if (!a || !b || !c) return 0;
    return Math.max(Math.hypot(b.x - a.x, b.y - a.y), Math.hypot(c.x - a.x, c.y - a.y));
  };
  const hidden = (q: Pt) => occluders.some((o) => q.x >= o.x0 && q.x <= o.x1 && q.y >= o.y0 && q.y <= o.y1);
  // body: a few dark discs from tail to nose, 4 cm tall
  for (const a of [-3, 0, 3]) {
    const q = at(a, 0);
    const c = proj.project(q.x, q.y, 2);
    if (c && !hidden(q)) fillDisc(img, c.x, c.y, 4.6 * pxPerCm(q, 2), [30, 30, 34]);
  }
  const led = (c: Rgb, q: Pt, h: number) => {
    const m = Math.max(c.r, c.g, c.b);
    if (m < 10 || hidden(q)) return;
    const p = proj.project(q.x, q.y, h);
    if (!p) return;
    const r = Math.max(0.8, look.ledCm * pxPerCm(q, h));
    // LEDs saturate the sensor: bright core, coloured halo
    fillDisc(img, p.x, p.y, r * 1.8, [c.r * 0.7, c.g * 0.7, c.b * 0.7]);
    fillDisc(img, p.x, p.y, r, [Math.min(255, (c.r * 255) / m), Math.min(255, (c.g * 255) / m), Math.min(255, (c.b * 255) / m)]);
  };
  led(lights.ugL, at(0, look.ugHalf), look.ugHeight);
  led(lights.ugR, at(0, -look.ugHalf), look.ugHeight);
  led(lights.hlL, at(look.headAhead, look.headHalf), look.headHeight);
  led(lights.hlR, at(look.headAhead, -look.headHalf), look.headHeight);
}
