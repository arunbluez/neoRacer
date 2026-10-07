// A simulated hand-held phone camera for the mock robot: the synthetic mat
// seen from behind its near edge (side b), swaying and shaking a little like
// a phone held by hand, with the robot and its lights drawn from the mock
// world at their real heights. Lets the whole camera pipeline run without a
// phone camera.

import { CUTEBOT_LOOK, drawSimRobot, HANDHELD_AT_B, HandShake, projector, renderMatView } from '../../core/sim/camera';
import type { SimWorld } from '../../core/sim/world';
import type { CameraOpts, Clock, Frame } from '../../core/types';
import type { ImageBuf } from '../../core/vision/rectify';
import { drawImageBuf } from './imageIo';
import type { CameraSource, LockResult } from './types';

const FULL = { w: 1280, h: 960 };

export type SimMat = {
  image: ImageBuf;
  matWidthCm: number;
  matHeightCm: number;
  /** Hides the robot's lights from the camera (the bridge). */
  occluders?: { x0: number; y0: number; x1: number; y1: number }[];
};

export class SimFrameSource implements CameraSource {
  readonly kind = 'sim' as const;
  readonly label = 'Simulated camera';
  readonly deviceId = 'sim';
  readonly preview: HTMLCanvasElement = document.createElement('canvas');
  readonly size = FULL;
  dropped = 0;
  private cbs = new Set<(f: Frame) => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private procW = 640;
  private procH = 480;
  private shake: HandShake;
  /** Simulated exposure + delivery delay, ms. */
  latencyMs = 50;

  constructor(
    private readonly clock: Clock,
    private readonly world: () => SimWorld | undefined,
    private readonly mat: SimMat,
    /** How much the hand shakes (0 = tripod). */
    handheld = 1,
  ) {
    this.preview.style.width = '100%';
    this.shake = new HandShake(HANDHELD_AT_B, handheld, 5);
  }

  async start(opts: CameraOpts): Promise<void> {
    this.stop();
    this.procW = Math.min(opts.procWidth, 640);
    this.procH = Math.round((this.procW * FULL.h) / FULL.w);
    // Rendering in the page is slow; 15 fps is plenty for the simulator.
    const period = 1000 / Math.min(15, opts.fps);
    this.timer = setInterval(() => this.tick(), period);
  }

  private render(w: number, h: number, t: number): ImageBuf {
    const proj = projector(this.shake.at(t), w, h);
    const img = renderMatView(this.mat.image, this.mat.matWidthCm, this.mat.matHeightCm, proj);
    const world = this.world();
    if (world) drawSimRobot(img, proj, world.poseAt(t), world.lightsAt(t), CUTEBOT_LOOK, this.mat.occluders ?? []);
    return img;
  }

  private tick(): void {
    const t = this.clock.now() - this.latencyMs;
    const img = this.render(this.procW, this.procH, t);
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
    const img = this.render(FULL.w, FULL.h, this.clock.now());
    const c = document.createElement('canvas');
    drawImageBuf(c, img);
    const blob = await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('jpeg failed'))), 'image/jpeg', 0.92));
    return { img, jpeg: new Uint8Array(await blob.arrayBuffer()) };
  }

  capabilities() {
    return { simulated: true, width: { min: 640, max: FULL.w }, height: { min: 480, max: FULL.h } };
  }

  settings() {
    return { simulated: true, width: FULL.w, height: FULL.h, frameRate: 15, latencyMs: this.latencyMs };
  }

  async setZoom(): Promise<void> {}

  async lockExposure(): Promise<LockResult> {
    return { applied: { simulated: true }, failed: {}, settings: this.settings() };
  }
}
