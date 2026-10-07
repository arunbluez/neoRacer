// Per-frame tracking with logging and history: wraps the Tracker, scales the
// calibration to processed frames, keeps poses and frame stats in ring
// buffers, logs cam.pose for every tracked frame and cam.stats once a second,
// and serves them to tests as a PoseSource.

import type { Logger } from '../log/logger';
import type { FrameStat, MarkerProbe, PoseSource, TrackedPose } from '../tests/camera';
import type { Clock, Frame } from '../types';
import { RingBuffer } from '../util/ring';
import { median, quantile } from '../util/stats';
import type { TrackCalibration } from './calibration';
import type { MarkerColor } from './color';
import { scaleHomography } from './linalg';
import { Tracker, type TrackerConfig, type TrackResult } from './tracker';

export type FrameMeta = { width: number; height: number; tCaptureMs: number; grabMs?: number };

/** Mean RGB of a 7×7 patch at a point (marker probe for the LED latency test). */
export function probePatch(frame: Frame, at: { cx: number; cy: number } | undefined, tFrame: number): MarkerProbe {
  const p: MarkerProbe = { tFrame, r: 0, g: 0, b: 0, found: !!at };
  if (!at) return p;
  const R = 3;
  let n = 0;
  const cx = Math.floor(at.cx);
  const cy = Math.floor(at.cy);
  for (let y = Math.max(0, cy - R); y <= Math.min(frame.height - 1, cy + R); y++) {
    for (let x = Math.max(0, cx - R); x <= Math.min(frame.width - 1, cx + R); x++) {
      const o = (y * frame.width + x) * 4;
      p.r += frame.data[o];
      p.g += frame.data[o + 1];
      p.b += frame.data[o + 2];
      n++;
    }
  }
  if (n) {
    p.r /= n;
    p.g /= n;
    p.b /= n;
  }
  return p;
}

export type PipelineConfig = {
  calibration: TrackCalibration;
  markerA: MarkerColor;
  markerB?: MarkerColor;
  minAreaPx: number;
  predictMs: number;
};

export type CamStats = { fps: number; procMs: number; procP95: number; grabMs: number; dropped: number; detectRate: number };

export class TrackingPipeline implements PoseSource {
  readonly poses = new RingBuffer<TrackedPose>(20_000);
  readonly frameStats = new RingBuffer<FrameStat>(20_000);
  lastResult?: TrackResult;
  lastFrame?: Frame;
  private tracker?: Tracker;
  private cfg?: PipelineConfig;
  private frameW = 0;
  private frameH = 0;
  private waiters: ((s: FrameStat) => void)[] = [];
  private probes = new Set<(p: MarkerProbe) => void>();
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private lastStatsAt = 0;
  private lastStatsTotal = 0;
  /** Frames the source had to skip (reported by the adapter). */
  dropped = 0;
  private droppedReported = 0;
  private _stats: CamStats = { fps: 0, procMs: 0, procP95: 0, grabMs: NaN, dropped: 0, detectRate: 0 };
  tracking = false;

  constructor(private readonly logger: Logger, private readonly clock: Clock) {}

  get stats(): CamStats {
    return this._stats;
  }

  get config(): PipelineConfig | undefined {
    return this.cfg;
  }

  /** Configure (or reconfigure) tracking. Resets the filter when H or markers change. */
  configure(cfg: PipelineConfig): void {
    this.cfg = cfg;
    this.configVersion++;
    this.tracker = undefined; // rebuilt on the next frame, when the frame size is known
  }

  start(): void {
    this.tracking = true;
    this.lastStatsAt = this.clock.now();
    this.lastStatsTotal = this.frameStats.total;
    if (this.statsTimer === null) this.statsTimer = setInterval(() => this.logStats(), 1000);
  }

  stop(): void {
    this.tracking = false;
    if (this.statsTimer !== null) clearInterval(this.statsTimer);
    this.statsTimer = null;
  }

  get active(): boolean {
    const last = this.frameStats.latest();
    return this.tracking && !!this.cfg && !!last && this.clock.now() - last.tFrame < 1000;
  }

  /** Bumped on every configure(), so a worker knows to rebuild its tracker. */
  configVersion = 0;

  /** Tracker settings for frames of this size (the calibration is scaled to them). */
  trackerConfig(w: number, h: number): TrackerConfig {
    const cfg = this.cfg!;
    const cal = cfg.calibration;
    // The calibration was solved on the full-size still; frames are scaled down.
    const H = scaleHomography(cal.H, cal.imageWidth / w, cal.imageHeight / h);
    return {
      H,
      markerA: cfg.markerA,
      markerB: cfg.markerB,
      minAreaPx: cfg.minAreaPx,
      searchRadiusPx: Math.round(w / 10),
      predictMs: cfg.predictMs,
      matWidthCm: cal.matWidthCm,
      matHeightCm: cal.matHeightCm,
    };
  }

  /**
   * Whether frames of this size match the calibration's picture shape. Rotating
   * the phone (portrait ↔ landscape) or changing the frame shape invalidates the
   * calibration, and tracking with it would put the robot in the wrong place.
   */
  aspectMatches(w: number, h: number): boolean {
    const cal = this.cfg?.calibration;
    if (!cal) return false;
    return Math.abs(w / h - cal.imageWidth / cal.imageHeight) < 0.03;
  }

  /** Set while frames don't match the calibration (see aspectMatches). */
  calibrationMismatch = false;

  /** Process one frame here. Returns the result, or undefined when not tracking. */
  process(frame: Frame): TrackResult | undefined {
    this.lastFrame = frame;
    if (!this.tracking || !this.cfg) return undefined;
    this.calibrationMismatch = !this.aspectMatches(frame.width, frame.height);
    if (this.calibrationMismatch) return undefined;
    if (!this.tracker || frame.width !== this.frameW || frame.height !== this.frameH) {
      this.tracker = new Tracker(this.trackerConfig(frame.width, frame.height));
      this.frameW = frame.width;
      this.frameH = frame.height;
    }
    const t0 = this.clock.now();
    const res = this.tracker.process(frame);
    const procMs = this.clock.now() - t0;
    this.record(frame, res, procMs, this.probes.size ? this.probeColour(frame, res) : undefined);
    return res;
  }

  /** Record a result computed elsewhere (a Web Worker). */
  ingest(meta: FrameMeta, res: TrackResult, procMs: number, probe?: MarkerProbe): void {
    this.lastMeta = meta;
    if (!this.tracking || !this.cfg) return;
    this.record(meta, res, procMs, probe);
  }

  /** Size and time of the last frame seen, whichever path it took. */
  get frameMeta(): FrameMeta | undefined {
    return this.lastMeta ?? this.lastFrame;
  }

  private lastMeta?: FrameMeta;

  private record(frame: FrameMeta, res: TrackResult, procMs: number, probe?: MarkerProbe): void {
    res.procMs = procMs;
    this.lastResult = res;
    const stat: FrameStat = { tFrame: frame.tCaptureMs, procMs, grabMs: frame.grabMs, detected: !!res.raw, candidates: res.candidates };
    this.frameStats.push(stat);
    if (res.raw && res.filtered) {
      const f = res.filtered;
      const pose: TrackedPose = {
        tFrame: frame.tCaptureMs,
        xCm: res.raw.xCm,
        yCm: res.raw.yCm,
        headingDeg: res.raw.headingDeg,
        conf: res.raw.conf,
        fx: f.x,
        fy: f.y,
        fHeadingDeg: f.headingDeg,
        speedCmS: Math.hypot(f.vx, f.vy),
      };
      this.poses.push(pose);
      const r1 = (x: number) => Math.round(x * 10) / 10;
      this.logger.log('cam.pose', {
        xCm: r1(f.x), yCm: r1(f.y), headingDeg: r1(f.headingDeg), conf: Math.round(res.raw.conf * 100) / 100,
        tFrame: this.logger.rel(frame.tCaptureMs), procMs: r1(procMs),
        raw: { xCm: r1(res.raw.xCm), yCm: r1(res.raw.yCm), headingDeg: res.raw.headingDeg === null ? null : r1(res.raw.headingDeg) },
      }, frame.tCaptureMs);
    }
    if (probe) for (const cb of this.probes) cb(probe);
    const ws = this.waiters;
    this.waiters = [];
    for (const w of ws) w(stat);
  }

  get wantsProbe(): boolean {
    return this.probes.size > 0;
  }

  /** Mean colour of a small patch at marker A's last image position. */
  private probeColour(frame: Frame, res: TrackResult): MarkerProbe {
    if (res.a) this.lastProbeAt = res.a;
    return probePatch(frame, res.a ?? this.lastProbeAt, frame.tCaptureMs);
  }

  private lastProbeAt?: { cx: number; cy: number };

  probeMarker(cb: (p: MarkerProbe) => void): () => void {
    this.probes.add(cb);
    return () => this.probes.delete(cb);
  }

  latest(): TrackedPose | undefined {
    return this.poses.latest();
  }

  between(t0: number, t1: number): TrackedPose[] {
    return this.poses.last(Math.min(this.poses.size, 6000)).filter((p) => p.tFrame >= t0 && p.tFrame <= t1);
  }

  frames(t0: number, t1: number): FrameStat[] {
    return this.frameStats.last(Math.min(this.frameStats.size, 6000)).filter((f) => f.tFrame >= t0 && f.tFrame <= t1);
  }

  nextFrame(): Promise<FrameStat> {
    return new Promise((r) => this.waiters.push(r));
  }

  private logStats(): void {
    const now = this.clock.now();
    const n = this.frameStats.total - this.lastStatsTotal;
    const recent = this.frameStats.last(Math.min(n, this.frameStats.size));
    const procs = recent.map((f) => f.procMs);
    const fps = (n * 1000) / Math.max(1, now - this.lastStatsAt);
    const dropped = this.dropped - this.droppedReported;
    this._stats = {
      fps,
      procMs: median(procs),
      procP95: quantile(procs, 0.95),
      grabMs: median(recent.map((f) => f.grabMs).filter((x): x is number => x !== undefined)),
      dropped,
      detectRate: recent.length ? recent.filter((f) => f.detected).length / recent.length : 0,
    };
    this.droppedReported = this.dropped;
    this.lastStatsAt = now;
    this.lastStatsTotal = this.frameStats.total;
    const r1 = (x: number) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : null);
    this.logger.log('cam.stats', { fps: r1(fps), procMs: r1(this._stats.procMs), procP95: r1(this._stats.procP95), grabMs: r1(this._stats.grabMs), dropped, detectRate: r1(this._stats.detectRate * 100) });
  }
}
