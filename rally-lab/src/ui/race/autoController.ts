// Glue between the camera, the hand-held tracker and the auto run: every
// camera frame is tracked (the track by its lane, our robot by its lights
// near where it should be); fixes go to the running auto run; "Find my robot"
// blinks the lights and finds the light that blinked; once a second the
// camera's health goes into the log (auto.cam); the camera frame and a
// top-down picture of the mat are saved into the session at the start and end
// of each run.

import { encodeImage } from '../../adapters/camera/imageIo';
import type { Rgb } from '../../core/protocol/commands';
import { addSavedLap, applySavedLap, makeSavedLap } from '../../core/race/savedLaps';
import type { SavedLap } from '../../core/settings';
import { vibrate } from '../../adapters/device/device';
import { AutoRun, trackingGate, type AutoSettings, type AutoSummary, type TrackGate } from '../../core/race/autoRun';
import { buildPlan, RALLY_ROUTE, type Plan, type RouteSpec } from '../../core/race/route';
import { PUGUZ_PROFILE } from '../../core/sim/robots';
import { paintedRoute } from '../../core/sim/track';
import type { Frame } from '../../core/types';
import { errorMessage, sleep } from '../../core/util/async';
import { BLINK_MS, BLINK_PATTERN, BlinkFinder, type BlinkResult } from '../../core/vision/blinkFinder';
import { defaultMarkerColor, sampleMarker, type MarkerColor } from '../../core/vision/color';
import { HandheldTracker, type CamFix, type HandheldFrame } from '../../core/vision/handheld';
import { laneModel, type LaneModel } from '../../core/vision/laneFit';
import { mat3Inv } from '../../core/vision/linalg';
import { rectify } from '../../core/vision/rectify';
import { useApp } from '../appStore';
import { cameraController } from '../camera/controller';
import { clock, getLab, store } from '../lab';

type CamSecond = { frames: number; mat: number; robot: number; proc: number; score: number };

class AutoController {
  tracker?: HandheldTracker;
  last?: HandheldFrame;
  lastFrame?: Frame;
  /** The latest fix (kept for the start pose and the overlay). */
  latestFix?: CamFix;
  summary?: AutoSummary;
  /** The settings the last run drove with (to save it as a lap). */
  lastRunSettings?: AutoSettings;
  /** Start lights: how many are lit (1–4), 0 = lights out, go; null = none showing. */
  countdown: number | null = null;
  /** The last finished lap has been saved (its id). */
  savedId?: string;
  error?: string;
  /** Where the blink test found our robot. */
  identified: { x: number; y: number; t: number } | null = null;
  blinking = false;
  lastBlink?: BlinkResult | null;
  /** Tap the robot's lights on the picture to learn their colour. */
  pickMarker = false;
  gate?: TrackGate;
  private blink?: BlinkFinder;
  private off?: () => void;
  private modelCache?: { key: string; model: LaneModel };
  private sec: CamSecond = { frames: 0, mat: 0, robot: 0, proc: 0, score: 0 };
  private secTimer: ReturnType<typeof setInterval> | null = null;
  private planCache?: { key: string; plan: Plan };
  /** The run a blink re-find is going for (one at a time). */
  private refindHold?: AutoRun;
  private laneCache?: { key: string; pts: { x: number; y: number; headingDeg: number }[] };
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
  lane(): { x: number; y: number; headingDeg: number }[] {
    const r = this.route;
    const key = JSON.stringify(r.sections) + JSON.stringify(r.start);
    if (this.laneCache?.key !== key) this.laneCache = { key, pts: buildPlan(paintedRoute(r), 'arc').outline };
    return this.laneCache.pts;
  }

  private model(): LaneModel {
    const r = this.route;
    const key = JSON.stringify(r.sections) + JSON.stringify(r.start) + r.laneWidthCm;
    if (this.modelCache?.key !== key) this.modelCache = { key, model: laneModel(this.lane(), r.laneWidthCm / 2, r.matWidthCm, r.matHeightCm, 2) };
    return this.modelCache.model;
  }

  private marker(): MarkerColor {
    const lab = getLab();
    return lab.settings.markerA.hsv ?? defaultMarkerColor(this.settings.lightColor);
  }

  private makeTracker(): HandheldTracker {
    return new HandheldTracker({ model: this.model(), marker: this.marker(), minAreaPx: getLab().settings.minBlobAreaPx, markerHeightCm: this.settings.markerHeightCm });
  }

  /** Settings changed (marker colour, heights, route): rebuild the tracker. */
  reconfigure(): void {
    this.tracker = this.makeTracker();
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
    if (getLab().auto?.state === 'running' || this.blinking) return;
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
    const lab = getLab();
    const auto = lab.auto;
    const gate = trackingGate({ auto, identified: this.identified, now: clock.now(), route: this.route, markerAheadCm: this.settings.markerAheadCm });
    this.gate = gate;
    let out: HandheldFrame;
    try {
      out = tracker.process(f, () => clock.now(), gate);
      // During the blink test, every light on the mat counts.
      if (this.blink) {
        const cur = tracker.current(f.tCaptureMs);
        if (cur) this.blink.add(f.tCaptureMs, tracker.blobs(f, cur, out.cam));
      }
    } catch (err) {
      this.error = errorMessage(err);
      return;
    }
    this.last = out;
    this.sec.frames++;
    this.sec.proc += out.procMs;
    if (out.H) this.sec.mat++;
    if (out.fit) this.sec.score += out.fit.score;
    if (out.fix) {
      this.sec.robot++;
      this.latestFix = out.fix;
      this.trail.push({ x: out.fix.x, y: out.fix.y, t: out.fix.t });
      if (this.trail.length > 400) this.trail.splice(0, 100);
      auto?.onFix(out.fix);
    }
    if (auto?.state === 'running') {
      // Lost for a while (not along the route either): blink to find it wherever it is, then carry on.
      const live = auto.live();
      if (live.holding && live.heldMs > 3000 && !this.blinking && this.refindHold !== auto) {
        this.refindHold = auto;
        void this.findRobot().then((res) => {
          if (res && auto.state === 'running') auto.placeAt(res.pos, clock.now());
        }).catch(() => {}).finally(() => {
          // another try on the next long hold
          setTimeout(() => { if (this.refindHold === auto) this.refindHold = undefined; }, 4000);
        });
      }
      const p = auto.est.pose;
      this.estTrail.push({ x: p.x, y: p.y });
      if (this.estTrail.length > 2000) this.estTrail.splice(0, 500);
    }
  }

  private logSecond(): void {
    const s = this.sec;
    this.sec = { frames: 0, mat: 0, robot: 0, proc: 0, score: 0 };
    if (!cameraController.running || s.frames === 0) return;
    const last = this.last;
    const r1 = (x: number) => Math.round(x * 10) / 10;
    getLab().logger.log('auto.cam', {
      fps: s.frames, matPct: Math.round((100 * s.mat) / s.frames), robotPct: Math.round((100 * s.robot) / s.frames),
      procMs: r1(s.proc / s.frames), score: s.mat ? Math.round((100 * s.score) / s.mat) / 100 : undefined,
      side: last?.side ?? null, from: last?.fit?.from, reject: this.tracker?.lastReject || undefined,
      gate: this.gate ? { why: this.gate.why, x: r1(this.gate.center.x), y: r1(this.gate.center.y), r: r1(this.gate.radiusCm) } : undefined,
      blobs: last?.blobs,
      corners: last?.corners?.map((p) => [Math.round(p.x), Math.round(p.y)]),
      cam: last?.cam ? { x: r1(last.cam.x), y: r1(last.cam.y), h: r1(last.cam.height), f: Math.round(last.cam.focalPx) } : undefined,
      frame: this.lastFrame ? [this.lastFrame.width, this.lastFrame.height] : undefined,
    });
  }

  /** Search for the track from scratch on the next frame. */
  redetect(): void {
    this.tracker?.redetect();
  }

  /** Learn the lights' colour from a tap on the picture (frame pixels). */
  async sampleAt(x: number, y: number): Promise<void> {
    const f = this.lastFrame;
    if (!f || !this.pickMarker) return;
    const m = sampleMarker(f, x, y, 7);
    const lab = getLab();
    await lab.setSettings({ markerA: { ...lab.settings.markerA, hsv: m } });
    lab.logger.log('app', { event: 'marker', detail: { hsv: m } });
    this.pickMarker = false;
    this.reconfigure();
  }

  lightsOn(): void {
    const lab = getLab();
    if (lab.link.connected) AutoRun.lightsOn(lab.link, this.settings);
  }

  /**
   * Blink the robot's lights in a known pattern and find the light on the mat
   * that blinked along: that's ours, wherever it is and whatever else is lit.
   */
  async findRobot(): Promise<BlinkResult | null> {
    const lab = getLab();
    if (!lab.link.connected) throw new Error('Connect the robot first.');
    if (!cameraController.running) throw new Error('Start the camera first.');
    if (this.blinking) return null;
    this.attach();
    this.blinking = true;
    useApp.getState().bump();
    const t0 = clock.now();
    this.blink = new BlinkFinder(t0);
    lab.lights.hold(BLINK_MS + 800, t0);
    const timers = BLINK_PATTERN.map((st) => setTimeout(() => {
      if (st.on) AutoRun.lightsOn(lab.link, this.settings);
      else AutoRun.lightsOff(lab.link);
    }, st.t));
    try {
      await sleep(BLINK_MS + 400);
    } finally {
      timers.forEach(clearTimeout);
      this.lightsOn();
    }
    const finder = this.blink;
    this.blink = undefined;
    this.blinking = false;
    const res = finder.result();
    this.lastBlink = res;
    if (res) this.identified = { x: res.pos.x, y: res.pos.y, t: clock.now() };
    const st = this.route.start;
    lab.logger.log('app', {
      event: 'auto.blink',
      detail: { frames: finder.frames, found: res ? { x: Math.round(res.pos.x * 10) / 10, y: Math.round(res.pos.y * 10) / 10, agreement: Math.round(res.agreement * 100) / 100, latencyMs: res.latencyMs, fromStartCm: Math.round(Math.hypot(res.pos.x - st.x, res.pos.y - st.y)) } : null },
    });
    useApp.getState().bump();
    return res;
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
    // Make sure the camera follows our robot, not someone else's.
    if (this.settings.cameraAssist && cameraController.running && !(this.identified && clock.now() - this.identified.t < 60_000)) {
      const found = await this.findRobot();
      if (!found) {
        this.error = 'Could not see the robot\'s lights blink: is it in the picture?';
        useApp.getState().bump();
        throw new Error(this.error);
      }
      await sleep(300); // a few frames with the lights on again
    }
    if (lab.settings.lights.show) await this.startLights();
    this.lastRunSettings = this.settings;
    this.savedId = undefined;
    const auto = lab.createAuto(this.settings);
    if (this.latestFix && clock.now() - this.latestFix.t < 600) auto.onFix(this.latestFix);
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
    // the robot has moved: identify it again next time
    this.identified = null;
    void this.saveViews('end');
    useApp.getState().bump();
    if (summary.finished) {
      vibrate([60, 50, 60, 50, 220]);
      if (lab.settings.lights.show) void this.celebrate();
    } else vibrate(300);
  }

  /**
   * Start lights, like Formula 1: four red lights come on one by one, then
   * all out, and it goes. Then the marker colour again for the camera.
   */
  private async startLights(): Promise<void> {
    const lab = getLab();
    const send = (c: string) => void lab.link.send(c);
    const red: Rgb = { r: 255, g: 0, b: 0 };
    const rgb = (n: string, c: Rgb) => `${n},${c.r},${c.g},${c.b}`;
    lab.lights.hold(3000, clock.now());
    const stops = lab.stops;
    const check = () => {
      if (lab.stops !== stops || !lab.link.connected) {
        this.countdown = null;
        AutoRun.lightsOn(lab.link, this.settings);
        useApp.getState().bump();
        throw new Error('Stopped before the start.');
      }
    };
    send('HO');
    const steps = ['UGL', 'UGR', 'HLL', 'HLR'];
    for (let i = 0; i < steps.length; i++) {
      await sleep(420);
      check();
      send(rgb(steps[i], red));
      this.countdown = i + 1;
      vibrate(35);
      useApp.getState().bump();
    }
    await sleep(500 + Math.random() * 300);
    check();
    send('HO');
    this.countdown = 0;
    vibrate(140);
    useApp.getState().bump();
    await sleep(120);
    AutoRun.lightsOn(lab.link, this.settings);
    // a few frames with the marker colour, so the start pose comes from the camera
    await sleep(450);
    this.countdown = null;
  }

  /** Finished: a short light show, then the marker colour again. */
  private async celebrate(): Promise<void> {
    const lab = getLab();
    const send = (c: string) => void lab.link.send(c);
    lab.lights.hold(2400, clock.now());
    const colours: Rgb[] = [
      { r: 255, g: 0, b: 140 }, { r: 255, g: 140, b: 0 }, { r: 210, g: 255, b: 0 }, { r: 0, g: 220, b: 160 }, { r: 0, g: 120, b: 255 }, { r: 170, g: 0, b: 255 },
    ];
    for (let i = 0; i < colours.length; i++) {
      const c = colours[i];
      send(`UG,${c.r},${c.g},${c.b}`);
      send(i % 2 ? 'HL,255,255,255' : 'HL,0,0,0');
      await sleep(260);
    }
    AutoRun.lightsOn(lab.link, this.settings);
  }

  /**
   * Back to the start line after a run (stopped, finished or failed): motors
   * off, the result and trails cleared, the lights in the marker colour, and
   * the camera looking for the robot at the start again.
   */
  reset(): void {
    const lab = getLab();
    if (lab.auto?.state === 'running' || this.countdown !== null) lab.stopAll('reset (race view)');
    else if (lab.link.connected) void lab.link.stop();
    this.summary = undefined;
    this.error = undefined;
    this.lastRunSettings = undefined;
    this.savedId = undefined;
    this.identified = null;
    this.lastBlink = undefined;
    this.refindHold = undefined;
    this.countdown = null;
    this.trail.length = 0;
    this.estTrail.length = 0;
    this.lightsOn();
    lab.logger.log('app', { event: 'auto.reset' });
    useApp.getState().bump();
  }

  /** Keep the last finished lap: its time and the settings that drove it. */
  async saveLastLap(): Promise<SavedLap | null> {
    const sum = this.summary, st = this.lastRunSettings;
    if (!sum?.finished || !st) return null;
    const lab = getLab();
    const lap = makeSavedLap({ summary: sum, settings: st, robotId: lab.profile?.robotId, at: new Date() });
    await lab.setSettings({ savedLaps: addSavedLap(lab.settings.savedLaps, lap) });
    lab.logger.log('app', { event: 'lap.saved', detail: { id: lap.id, name: lap.name, lapMs: lap.lapMs } });
    this.savedId = lap.id;
    vibrate(60);
    useApp.getState().bump();
    return lap;
  }

  /** Drive like a saved lap from now on. */
  async useSavedLap(id: string): Promise<void> {
    const lab = getLab();
    const lap = lab.settings.savedLaps.find((l) => l.id === id);
    if (!lap) return;
    await lab.setSettings({ auto: applySavedLap(lab.settings.auto, lap) });
    lab.logger.log('app', { event: 'lap.used', detail: { id: lap.id, name: lap.name } });
    this.reconfigure();
    vibrate(30);
    useApp.getState().bump();
  }

  async deleteSavedLap(id: string): Promise<void> {
    const lab = getLab();
    await lab.setSettings({ savedLaps: lab.settings.savedLaps.filter((l) => l.id !== id) });
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
      lab.logger.log('app', { event: 'auto.views', detail: { tag, stamp, corners: this.last?.corners, cam: this.last?.cam, fit: this.last?.fit && { score: this.last.fit.score, from: this.last.fit.from } } });
    } catch (err) {
      lab.logger.log('app', { event: 'error', detail: `saving views failed: ${errorMessage(err)}` });
    }
  }
}

export const autoController = new AutoController();
