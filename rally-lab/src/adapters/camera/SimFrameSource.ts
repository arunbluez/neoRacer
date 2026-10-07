// A simulated tripod camera for the mock robot: the synthetic mat seen in
// perspective, with the robot's body and its lights drawn from the mock
// world. Lets the whole camera pipeline run without a phone camera.

import type { Rgb } from '../../core/protocol/commands';
import type { SimWorld } from '../../core/sim/world';
import type { CameraOpts, Clock, Frame } from '../../core/types';
import { applyH, mat3Inv, type Mat3 } from '../../core/vision/linalg';
import { fillDisc, renderPerspective, type ImageBuf } from '../../core/vision/rectify';
import { solveHomography } from '../../core/vision/homography';
import { drawImageBuf } from './imageIo';
import type { CameraSource, LockResult } from './types';

const FULL = { w: 1280, h: 720 };

/**
 * Mat corners (TL, TR, BR, BL) in a 2000 × 1125 phone photo of the real track,
 * taken standing at the near (bottom) edge. The simulated camera reuses that
 * viewpoint, scaled into a 1280 × 720 frame with a margin.
 */
const PHOTO_CORNERS = [{ x: 520, y: 352 }, { x: 1412, y: 354 }, { x: 1850, y: 1116 }, { x: 0, y: 1020 }];

function cameraH(w: number, matW: number, matH: number): Mat3 {
  const k = (0.58 * w) / FULL.w;
  const ox = (50 * w) / FULL.w;
  const oy = (30 * w) / FULL.w;
  const img = PHOTO_CORNERS.map((p) => ({ x: p.x * k + ox, y: p.y * k + oy }));
  return solveHomography([{ x: 0, y: 0 }, { x: matW, y: 0 }, { x: matW, y: matH }, { x: 0, y: matH }], img);
}

export class SimFrameSource implements CameraSource {
  readonly kind = 'sim' as const;
  readonly label = 'Simulated camera';
  readonly deviceId = 'sim';
  readonly preview: HTMLCanvasElement = document.createElement('canvas');
  readonly size = FULL;
  dropped = 0;
  private cbs = new Set<(f: Frame) => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private bg?: ImageBuf;
  private H?: Mat3; // mat cm -> proc px
  private procW = 640;
  private procH = 360;
  /** Simulated exposure + delivery delay, ms. */
  latencyMs = 40;

  constructor(
    private readonly clock: Clock,
    private readonly world: () => SimWorld | undefined,
    private readonly mat: { image: ImageBuf; matWidthCm: number; matHeightCm: number },
  ) {
    this.preview.style.width = '100%';
  }

  async start(opts: CameraOpts): Promise<void> {
    this.stop();
    this.procW = opts.procWidth;
    this.procH = Math.round((opts.procWidth * FULL.h) / FULL.w);
    this.H = cameraH(this.procW, this.mat.matWidthCm, this.mat.matHeightCm);
    this.bg = this.render(this.procW, this.procH, this.H);
    const period = 1000 / Math.min(30, opts.fps);
    this.timer = setInterval(() => this.tick(), period);
  }

  private render(w: number, h: number, H: Mat3): ImageBuf {
    const inv = mat3Inv(H)!;
    return renderPerspective(this.mat.image, this.mat.matWidthCm, this.mat.matHeightCm, inv, w, h, [40, 44, 40]);
  }

  /** Draw the robot at its pose `latencyMs` ago. */
  private drawRobot(img: ImageBuf, H: Mat3, t: number): void {
    const w = this.world();
    if (!w) return;
    const p = w.poseAt(t);
    const lights = w.lightsAt(t);
    const th = (p.headingDeg * Math.PI) / 180;
    const fx = Math.cos(th);
    const fy = Math.sin(th);
    const lx = fy; // left of heading on a y-down mat
    const ly = -fx;
    const at = (ahead: number, left: number) => applyH(H, { x: p.x + fx * ahead + lx * left, y: p.y + fy * ahead + ly * left });
    const pxPerCm = (q: { x: number; y: number }) => {
      const a = applyH(H, q);
      const b = applyH(H, { x: q.x + 1, y: q.y });
      return Math.hypot(b.x - a.x, b.y - a.y);
    };
    const s = pxPerCm({ x: p.x, y: p.y });
    const body = at(0, 0);
    fillDisc(img, body.x, body.y, 5.5 * s, [30, 30, 34]);
    // yellow battery label on top: a classic false positive
    const label = at(-2, 0);
    fillDisc(img, label.x, label.y, 1.3 * s, [210, 190, 40]);
    const led = (c: Rgb, q: { x: number; y: number }, r: number) => {
      const m = Math.max(c.r, c.g, c.b);
      if (m < 10) return;
      // LEDs saturate the sensor: bright core, coloured halo
      fillDisc(img, q.x, q.y, r * 1.8, [c.r * 0.7, c.g * 0.7, c.b * 0.7]);
      fillDisc(img, q.x, q.y, r, [Math.min(255, (c.r * 255) / m), Math.min(255, (c.g * 255) / m), Math.min(255, (c.b * 255) / m)]);
    };
    led(lights.ugL, at(0, 3), 1.6 * s);
    led(lights.ugR, at(0, -3), 1.6 * s);
    led(lights.hlL, at(5.5, 2.2), 1.6 * s);
    led(lights.hlR, at(5.5, -2.2), 1.6 * s);
  }

  private tick(): void {
    if (!this.bg || !this.H) return;
    const now = this.clock.now();
    const t = now - this.latencyMs;
    const img: ImageBuf = { width: this.bg.width, height: this.bg.height, data: new Uint8ClampedArray(this.bg.data) };
    this.drawRobot(img, this.H, t);
    drawImageBuf(this.preview, img);
    const frame: Frame = { ...img, tCaptureMs: t };
    for (const cb of this.cbs) cb(frame);
  }

  onFrame(cb: (f: Frame) => void): () => void {
    this.cbs.add(cb);
    return () => this.cbs.delete(cb);
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  async captureStill() {
    const H = cameraH(FULL.w, this.mat.matWidthCm, this.mat.matHeightCm);
    const img = this.render(FULL.w, FULL.h, H);
    this.drawRobot(img, H, this.clock.now());
    const c = document.createElement('canvas');
    drawImageBuf(c, img);
    const blob = await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('jpeg failed'))), 'image/jpeg', 0.92));
    return { img, jpeg: new Uint8Array(await blob.arrayBuffer()) };
  }

  /** A mat point in processed-frame pixels (for tests and demos). */
  project(xCm: number, yCm: number): { x: number; y: number } | null {
    return this.H ? applyH(this.H, { x: xCm, y: yCm }) : null;
  }

  /** Where the true mat corners are in the full-size still (for tests and demos). */
  trueCorners(): { x: number; y: number }[] {
    const H = cameraH(FULL.w, this.mat.matWidthCm, this.mat.matHeightCm);
    const W = this.mat.matWidthCm;
    const Hc = this.mat.matHeightCm;
    return [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: Hc }, { x: 0, y: Hc }].map((q) => applyH(H, q));
  }

  capabilities() {
    return { simulated: true, width: { min: 640, max: FULL.w }, height: { min: 360, max: FULL.h } };
  }

  settings() {
    return { simulated: true, width: FULL.w, height: FULL.h, frameRate: 30, latencyMs: this.latencyMs };
  }

  async setZoom(): Promise<void> {}

  async lockExposure(): Promise<LockResult> {
    return { applied: { simulated: true }, failed: {}, settings: this.settings() };
  }
}
