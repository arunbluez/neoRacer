// Glue between the camera, the hand-held tracker and the auto run: every
// camera frame is tracked (mat, orientation, robot); fixes go to the running
// auto run; once a second the camera's health goes into the log (auto.cam);
// views of the mat (camera frame and a top-down rectified picture) are saved
// into the session at the start and end of each run, for checking the route
// against the real lane afterwards.

import { encodeImage } from '../../adapters/camera/imageIo';
import { AutoRun, type AutoSettings, type AutoSummary } from '../../core/race/autoRun';
import { buildPlan, RALLY_ROUTE, type Plan, type RouteSpec } from '../../core/race/route';
import { PUGUZ_PROFILE } from '../../core/sim/robots';
import { paintedRoute } from '../../core/sim/track';
import type { Frame } from '../../core/types';
import { errorMessage } from '../../core/util/async';
import { defaultMarkerColor, sampleMarker, type MarkerColor } from '../../core/vision/color';
import { HandheldTracker, type CamFix, type HandheldFrame } from '../../core/vision/handheld';
import { mat3Inv } from '../../core/vision/linalg';
import { bandGrid, type BandGrid } from '../../core/vision/matView';
import { rectify } from '../../core/vision/rectify';
import { useApp } from '../appStore';
import { cameraController } from '../camera/controller';
import { clock, getLab, store } from '../lab';

type CamSecond = { frames: number; mat: number; robot: number; proc: number };

class AutoController {
  tracker?: HandheldTracker;
  last?: HandheldFrame;
  lastFrame?: Frame;
  /** The latest fix (kept for the start pose and the overlay). */
  latestFix?: CamFix;
  summary?: AutoSummary;
  error?: string;
  /** Tap the robot's lights on the picture to learn their colour. */
  pickMarker: 'A' | 'B' | null = null;
  private off?: () => void;
  private grid?: { key: string; grid: BandGrid };
  private sec: CamSecond = { frames: 0, mat: 0, robot: 0, proc: 0 };
  private secTimer: ReturnType<typeof setInterval> | null = null;
  private planCache?: { key: string; plan: Plan };
  /** Recent fixes for the overlay trail. */
  readonly trail: { x: number; y: number; t: number }[] = [];
  readonly estTrail: { x: number; y: number }[] = [];

  get settings(): AutoSettings {
    return getLab().settings.auto;
  }

  get route(): RouteSpec {
    return this.settings.route ?? RALLY_ROUTE;
  }

  /** The plan for the current settings (for overlays and the map). */
  plan(): Plan {
    const s = this.settings;
    const key = JSON.stringify([s.route ?? null, s.style, s.maxSpinDeg]);
    if (this.planCache?.key !== key) this.planCache = { key, plan: buildPlan(this.route, s.style, { maxSpinDeg: s.maxSpinDeg }) };
    return this.planCache.plan;
  }

  /** The painted lane's centre line (the route without cone offsets). */
  lane(): { x: number; y: number }[] {
    const r = this.route;
    const key = JSON.stringify(r.sections) + JSON.stringify(r.start);
    if (this.laneCache?.key !== key) this.laneCache = { key, pts: buildPlan(paintedRoute(r), 'arc').outline };
    return this.laneCache.pts;
  }

  private laneCache?: { key: string; pts: { x: number; y: number }[] };

  private bandGrid(): BandGrid {
    const r = this.route;
    const key = JSON.stringify(r.sections) + r.matWidthCm + r.matHeightCm;
    if (this.grid?.key !== key) {
      this.grid = { key, grid: bandGrid(this.lane(), r.laneWidthCm / 2 + r.borderCm, r.matWidthCm, r.matHeightCm, 4) };
    }
    return this.grid.grid;
  }

  private markers(): { a: MarkerColor; b: MarkerColor } {
    const lab = getLab();
    const s = this.settings;
    return {
      a: lab.settings.markerA.hsv ?? defaultMarkerColor(s.headlights),
      b: lab.settings.markerB.hsv ?? defaultMarkerColor(s.underglow),
    };
  }

  private makeTracker(): HandheldTracker {
    const m = this.markers();
    const s = this.settings;
    return new HandheldTracker({
      grid: this.bandGrid(), markerA: m.a, markerB: m.b, minAreaPx: getLab().settings.minBlobAreaPx,
      headHeightCm: s.headHeightCm, ugHeightCm: s.ugHeightCm, rot: s.matRot,
    });
  }

  /** Settings changed (markers, heights, route): rebuild the tracker, keeping the orientation. */
  reconfigure(): void {
    const rot = this.tracker?.rot ?? this.settings.matRot;
    this.tracker = this.makeTracker();
    if (rot !== null && rot !== undefined) this.tracker.setRot(rot);
  }

  /** Start tracking camera frames (idempotent). */
  attach(): void {
    if (this.off) return;
    this.tracker ??= this.makeTracker();
    this.off = cameraController.addFrameListener((f) => this.onFrame(f));
    this.secTimer = setInterval(() => this.logSecond(), 1000);
  }

  /** Stop tracking (not while a run is going). */
  detach(): void {
    if (getLab().auto?.state === 'running') return;
    this.off?.();
    this.off = undefined;
    if (this.secTimer !== null) clearInterval(this.secTimer);
    this.secTimer = null;
  }

  get attached(): boolean {
    return !!this.off;
  }

  private onFrame(f: Frame): void {
    const tracker = this.tracker;
    if (!tracker) return;
    this.lastFrame = f;
    const auto = getLab().auto;
    let out: HandheldFrame;
    try {
      out = tracker.process(f, () => clock.now(), auto?.hint());
    } catch (err) {
      this.error = errorMessage(err);
      return;
    }
    this.last = out;
    this.sec.frames++;
    this.sec.proc += out.procMs;
    if (out.H) this.sec.mat++;
    if (out.fix) {
      this.sec.robot++;
      this.latestFix = out.fix;
      this.trail.push({ x: out.fix.x, y: out.fix.y, t: out.fix.t });
      if (this.trail.length > 400) this.trail.splice(0, 100);
      auto?.onFix(out.fix);
    }
    if (auto?.state === 'running') {
      const p = auto.est.pose;
      this.estTrail.push({ x: p.x, y: p.y });
      if (this.estTrail.length > 2000) this.estTrail.splice(0, 500);
    }
    if (tracker.rot !== null && tracker.rot !== this.settings.matRot) void this.saveRot(tracker.rot);
  }

  private async saveRot(rot: number): Promise<void> {
    const lab = getLab();
    await lab.setSettings({ auto: { ...lab.settings.auto, matRot: rot } });
  }

  private logSecond(): void {
    const s = this.sec;
    this.sec = { frames: 0, mat: 0, robot: 0, proc: 0 };
    if (!cameraController.running || s.frames === 0) return;
    const last = this.last;
    const r1 = (x: number) => Math.round(x * 10) / 10;
    getLab().logger.log('auto.cam', {
      fps: s.frames, matPct: Math.round((100 * s.mat) / s.frames), robotPct: Math.round((100 * s.robot) / s.frames),
      procMs: r1(s.proc / s.frames), rot: this.tracker?.rot ?? null, reject: this.tracker?.lastReject || undefined,
      corners: last?.corners?.map((p) => [Math.round(p.x), Math.round(p.y)]),
      cam: last?.cam ? { x: r1(last.cam.x), y: r1(last.cam.y), h: r1(last.cam.height), f: Math.round(last.cam.focalPx) } : undefined,
      frame: last ? [this.lastFrame?.width, this.lastFrame?.height] : undefined,
      edgeRms: last?.mat ? r1(last.mat.edgeRms) : undefined,
    });
  }

  /** Turn the mat labels a quarter turn (when the automatic choice is wrong). */
  rotate(): void {
    this.tracker?.rotateBy(1);
    if (this.tracker?.rot !== null && this.tracker?.rot !== undefined) void this.saveRot(this.tracker.rot);
  }

  /** Forget the orientation and work it out again. */
  redetect(): void {
    this.tracker?.setRot(null);
    const lab = getLab();
    void lab.setSettings({ auto: { ...lab.settings.auto, matRot: null } });
  }

  /** Learn a marker's colour from a tap on the picture (frame pixels). */
  async sampleAt(x: number, y: number): Promise<void> {
    const f = this.lastFrame;
    const which = this.pickMarker;
    if (!f || !which) return;
    const m = sampleMarker(f, x, y, 7);
    const lab = getLab();
    if (which === 'A') await lab.setSettings({ markerA: { ...lab.settings.markerA, hsv: m } });
    else await lab.setSettings({ markerB: { ...lab.settings.markerB, hsv: m } });
    lab.logger.log('app', { event: 'marker', detail: { which, hsv: m } });
    this.pickMarker = null;
    this.reconfigure();
  }

  lightsOn(): void {
    const lab = getLab();
    if (lab.link.connected) AutoRun.lightsOn(lab.link, this.settings);
  }

  /** Start a run with the current settings. */
  async run(): Promise<void> {
    const lab = getLab();
    // The mock robot behaves like puguz; give a fresh mock profile puguz's numbers.
    if (lab.link.transportKind === 'mock' && lab.profile && !lab.profile.speedTable?.length) {
      await lab.updateProfile({ ...PUGUZ_PROFILE, notes: 'mock robot: puguz numbers from 7 Oct 2026' });
    }
    this.error = undefined;
    this.summary = undefined;
    this.estTrail.length = 0;
    const auto = lab.createAuto(this.settings);
    if (this.latestFix) auto.onFix(this.latestFix);
    useApp.getState().bump();
    void this.saveViews('start');
    let p: Promise<AutoSummary>;
    try {
      p = auto.start();
    } catch (err) {
      this.error = errorMessage(err);
      useApp.getState().bump();
      throw err;
    }
    useApp.getState().bump();
    const summary = await p;
    this.summary = summary;
    void this.saveViews('end');
    useApp.getState().bump();
  }

  /** Save the camera frame and a top-down picture of the mat into the session. */
  async saveViews(tag: string): Promise<void> {
    const f = this.lastFrame, H = this.last?.H;
    if (!f) return;
    const lab = getLab();
    const now = new Date().toISOString();
    const stamp = `${Math.round(lab.logger.now())}`;
    try {
      const jpeg = await encodeImage(f, 'image/jpeg', 0.85);
      await store.putImage({ id: `auto-${stamp}-${tag}-frame`, sessionId: lab.header.id, name: `auto-${stamp}-${tag}-frame.jpg`, mime: 'image/jpeg', bytes: jpeg, createdAt: now });
      const inv = H ? mat3Inv(H) : null;
      if (inv) {
        const r = this.route;
        const top = rectify(f, inv, r.matWidthCm, r.matHeightCm, 10);
        const png = await encodeImage(top, 'image/png');
        await store.putImage({ id: `auto-${stamp}-${tag}-mat`, sessionId: lab.header.id, name: `auto-${stamp}-${tag}-mat-1cm.png`, mime: 'image/png', bytes: png, createdAt: now });
      }
      lab.logger.log('app', { event: 'auto.views', detail: { tag, stamp, corners: this.last?.corners, cam: this.last?.cam } });
    } catch (err) {
      lab.logger.log('app', { event: 'error', detail: `saving views failed: ${errorMessage(err)}` });
    }
  }
}

export const autoController = new AutoController();
