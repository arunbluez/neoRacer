// One camera-assisted auto run: the hard-coded route, driven by the follower
// from the estimated pose, the camera correcting the estimate, the line
// sensors as a last guard. Logs everything needed to correct the route and
// the tuning afterwards: auto.start (plan and settings), auto.tick (every
// control step), auto.fix (every camera fix and whether it was used),
// auto.line, auto.spin and auto.end (the summary).

import type { RobotLink } from '../link/link';
import type { Poller } from '../link/poller';
import type { Logger } from '../log/logger';
import type { RobotProfile } from '../model/profile';
import type { Rgb } from '../protocol/commands';
import type { PollerEntry } from '../settings';
import type { Clock } from '../types';
import { PoseEstimator, type EstPose } from './estimator';
import { Follower, type FollowStep } from './follower';
import { motorModel, type MotorModel } from './motor';
import { buildPlan, RALLY_ROUTE, wrapDeg, type Plan, type RouteSpec, type TurnStyle } from './route';
import { buildSpeedProfile, type SpeedProfile } from './speedProfile';
import type { Tuning } from './tuning';

export type AutoSettings = {
  style: TurnStyle;
  /** Target speed on straights, cm/s. */
  speedCmS: number;
  curveSpeedCmS: number;
  /** Distance over which errors are corrected, cm. */
  settleCm: number;
  maxSpinDeg: number;
  spinCmd: number;
  spinLeadMs: number;
  settleMs: number;
  afterSpinMs: number;
  /** Use the camera to correct the position (off: dead reckoning only). */
  cameraAssist: boolean;
  /** Poll the line sensors and stop when the robot leaves the lane. */
  lineGuard: boolean;
  lineHz: number;
  cmdLatencyMs: number;
  /**
   * All four lights (headlights and underglow) in one colour: the camera sees
   * one bright patch. Where its centre is: ahead of the wheel axle, and
   * height above the mat, cm.
   */
  markerAheadCm: number;
  markerHeightCm: number;
  lightColor: Rgb;
  tickMs: number;
  /** Stop when the camera shows the robot this far off the path for half a second (0 = never). */
  offTrackStopCm: number;
  /**
   * Hold still when the camera hasn't seen the robot for this long, ms (0 =
   * drive on blind); longer under the bridge. While it holds, the camera looks
   * along the route back to where it last saw the robot, and the run carries
   * on from where it finds it. Gives up after lostStopMs.
   */
  lostPauseMs: number;
  lostStopMs: number;
  /** Stop when the camera sees the robot not moving for this long while it is driven, ms (0 = never). */
  stuckStopMs: number;
  /** The track code in use; undefined = the measured Robot Rallye track. */
  route?: RouteSpec;
  /** Lap tuning: per-section speeds, acceleration and braking; undefined = the constant speeds above. */
  tuning?: Tuning;
  /** The tuning before the last change (one step of undo). */
  tuningPrev?: Tuning;
  /** The tuning kept for the race (the final's one timed attempt), with the lap it drove. */
  raceTuning?: { tuning: Tuning; lapMs: number; at: string };
  /** Where the camera views from, to remember the orientation (0..3, null = automatic). */
  matRot: number | null;
  /** Settings layout version (2: arcs became the default; 3: one light colour). */
  version?: number;
};

export const DEFAULT_AUTO_SETTINGS: AutoSettings = {
  // Follow the lane's curves (the turns have a radius); 'spin' turns on the spot.
  style: 'arc',
  speedCmS: 22,
  curveSpeedCmS: 30,
  settleCm: 25,
  maxSpinDeg: 45,
  spinCmd: 24,
  spinLeadMs: 0,
  settleMs: 120,
  afterSpinMs: 200,
  cameraAssist: true,
  lineGuard: true,
  lineHz: 12,
  cmdLatencyMs: 25,
  markerAheadCm: 3,
  markerHeightCm: 1.5,
  lightColor: { r: 0, g: 255, b: 0 },
  tickMs: 40,
  offTrackStopCm: 18,
  lostPauseMs: 1000,
  lostStopMs: 8000,
  stuckStopMs: 1500,
  matRot: null,
  version: 3,
};

/**
 * Where the camera should look for our robot (mat cm, ground): a circle, and
 * while the robot is unseen also a strip along the route (trail) back to
 * where it was last seen.
 */
export type TrackGate = {
  center: { x: number; y: number };
  radiusCm: number;
  why: 'run' | 'lost' | 'blink' | 'start';
  trail?: { x: number; y: number }[];
  trailRadiusCm?: number;
};

/**
 * During a run: around the estimate (wider when it is unsure), plus the
 * route back to where the camera last saw the robot when it hasn't seen it
 * for a moment. Before it: where the blink test found the robot (for two
 * minutes), else the start line.
 */
export function trackingGate(o: {
  auto?: AutoRun; identified?: { x: number; y: number; t: number } | null; now: number; route: RouteSpec; markerAheadCm: number;
}): TrackGate {
  if (o.auto?.state === 'running') return o.auto.searchArea(o.now);
  if (o.identified && o.now - o.identified.t < 120_000) return { center: { x: o.identified.x, y: o.identified.y }, radiusCm: 12, why: 'blink' };
  const st = o.route.start;
  const th = (st.headingDeg * Math.PI) / 180;
  return { center: { x: st.x + o.markerAheadCm * Math.cos(th), y: st.y + o.markerAheadCm * Math.sin(th) }, radiusCm: 30, why: 'start' };
}

export type CamFixIn = { t: number; x: number; y: number; headingDeg: number | null; cmPerPx: number; raw?: { x: number; y: number }; conf?: number };

export type SectionStats = { id: string; tStart: number; tEnd: number; maxE: number; sumE: number; n: number; fixes: number; lineEvents: number };

export type AutoSummary = {
  reason: string;
  finished: boolean;
  timeMs: number;
  progressCm: number;
  lengthCm: number;
  style: TurnStyle;
  speedCmS: number;
  /** The lap tuning driven (label), and the lap time its profile predicted, s. */
  tuning?: string;
  predictedS: number;
  sections: { id: string; timeMs: number; maxErrCm: number; meanErrCm: number; fixes: number; lineEvents: number }[];
  fixes: { total: number; used: number; rejected: number; resets: number };
  lineEvents: number;
  /** Times it held still because the camera had lost it. */
  holds: number;
  learned: { biasDegS: number; speedScale: number; turnScale: number };
  spins: { section: string; deltaDeg: number; durMs: number; headingErrAfterDeg?: number }[];
};

export type AutoLive = {
  running: boolean;
  t: number;
  pose: EstPose;
  step?: FollowStep;
  lastFixAgeMs: number;
  progress: number;
  lengthCm: number;
  section: string;
  reason?: string;
  /** Holding still: the camera lost the robot. */
  holding: boolean;
};

type Deps = {
  link: Pick<RobotLink, 'send' | 'stop' | 'connected' | 'onReply' | 'onState'>;
  poller: Pick<Poller, 'set' | 'entries' | 'source'>;
  logger: Pick<Logger, 'log' | 'rel'>;
  clock: Clock;
  profile?: RobotProfile;
};

const r1 = (x: number) => Math.round(x * 10) / 10;
const rgbCmd = (name: string, c: Rgb) => `${name},${c.r},${c.g},${c.b}`;

export class AutoRun {
  readonly plan: Plan;
  readonly model: MotorModel;
  readonly est: PoseEstimator;
  readonly follower: Follower;
  readonly route: RouteSpec;
  /** Target speed along the plan (from the tuning, or the constant speeds). */
  readonly profile: SpeedProfile;
  private timer: ReturnType<typeof setInterval> | null = null;
  private offs: (() => void)[] = [];
  private prevPoller?: { entries: PollerEntry[]; source: string };
  private t0 = 0;
  private lastSent = { l: NaN, r: NaN, t: -Infinity };
  private lastFixT = -Infinity;
  private latestFix?: CamFixIn;
  private lineBlack = 0;
  private lineEvents = 0;
  private nudge = { k: 0, until: -Infinity };
  private offTrackSince: number | null = null;
  /** Progress along the plan where the camera last saw the robot, cm. */
  private seenS = 0;
  /** Holding still since (the camera lost the robot). */
  private holdSince: number | null = null;
  private holds = 0;
  /** Recent camera positions while driving (stuck detection). */
  private recent: { t: number; x: number; y: number }[] = [];
  private sections = new Map<string, SectionStats>();
  private lastStep?: FollowStep;
  private resolve?: (s: AutoSummary) => void;
  private spinsLogged = 0;
  private spinCheck: { idx: number; leg: number } | null = null;
  private spinResults: AutoSummary['spins'] = [];
  state: 'idle' | 'running' | 'ended' = 'idle';
  summary?: AutoSummary;

  constructor(private readonly deps: Deps, readonly settings: AutoSettings) {
    this.route = settings.route ?? RALLY_ROUTE;
    this.plan = buildPlan(this.route, settings.style, { maxSpinDeg: settings.maxSpinDeg });
    this.model = motorModel(deps.profile);
    this.est = new PoseEstimator(this.model, { markerAheadCm: settings.markerAheadCm, cmdLatencyMs: settings.cmdLatencyMs });
    this.profile = buildSpeedProfile(this.plan, settings.tuning, this.model, settings);
    this.follower = new Follower(this.plan, this.model, {
      speedCmS: settings.speedCmS, curveSpeedCmS: settings.curveSpeedCmS, settleCm: settings.tuning?.settleCm ?? settings.settleCm,
      spinCmd: settings.spinCmd, spinLeadMs: settings.spinLeadMs, settleMs: settings.settleMs, afterSpinMs: settings.afterSpinMs,
      // Without a tuning the follower keeps its constant speeds (as before tunings existed).
      profile: settings.tuning ? this.profile : undefined,
    });
  }

  /** All four lights on in the marker colour (the camera looks for them). */
  static lightsOn(link: Pick<RobotLink, 'send'>, s: Pick<AutoSettings, 'lightColor'>): void {
    void link.send(rgbCmd('HL', s.lightColor));
    void link.send(rgbCmd('UG', s.lightColor));
  }

  /** HO switches off the headlights and the underglow. */
  static lightsOff(link: Pick<RobotLink, 'send'>): void {
    void link.send('HO');
  }

  /** The robot's starting pose: from a recent camera fix near the start line, else the route's start. */
  startPose(now: number): { pose: { x: number; y: number; headingDeg: number }; from: 'camera' | 'route'; distCm: number } {
    const st = this.route.start;
    const f = this.latestFix;
    if (this.settings.cameraAssist && f && now - f.t < 600) {
      const th = (st.headingDeg * Math.PI) / 180;
      const x = f.x - this.settings.markerAheadCm * Math.cos(th), y = f.y - this.settings.markerAheadCm * Math.sin(th);
      return { pose: { x, y, headingDeg: st.headingDeg }, from: 'camera', distCm: Math.hypot(x - st.x, y - st.y) };
    }
    return { pose: { ...st }, from: 'route', distCm: 0 };
  }

  /** Run to the end. Resolves with the summary when finished or stopped. */
  start(): Promise<AutoSummary> {
    if (this.state !== 'idle') throw new Error('This run has already been used.');
    const { link, poller, logger, clock } = this.deps;
    if (!link.connected) throw new Error('Connect the robot first.');
    const now = clock.now();
    const sp = this.startPose(now);
    if (sp.from === 'camera' && sp.distCm > 25) {
      throw new Error(`The camera sees the robot ${Math.round(sp.distCm)} cm from the start line: place it on the line, facing section a.`);
    }
    this.state = 'running';
    this.t0 = now;
    // The camera has a moment to see the robot before the run holds for it.
    this.lastFixT = now;
    this.est.reset(sp.pose, now, sp.from === 'camera' ? { cm: 2, deg: 8 } : { cm: 4, deg: 10 });
    for (const s of this.plan.sectionStarts) this.sections.set(s.id, { id: s.id, tStart: NaN, tEnd: NaN, maxE: 0, sumE: 0, n: 0, fixes: 0, lineEvents: 0 });
    logger.log('auto.start', {
      route: this.route.name, style: this.settings.style, lengthCm: r1(this.plan.lengthCm), legs: this.plan.legs.length,
      settings: { ...this.settings, route: this.settings.route ? this.route : undefined, tuningPrev: undefined, raceTuning: undefined },
      profile: { predictedS: this.profile.predictedS, sections: this.profile.sections },
      start: { ...sp, pose: { x: r1(sp.pose.x), y: r1(sp.pose.y), headingDeg: sp.pose.headingDeg }, distCm: r1(sp.distCm) },
      model: { a: r1(this.model.a * 100) / 100, b: r1(this.model.b), deadband: this.model.deadband, trim: this.model.trim, trimTable: this.model.trimTable, trackWidthCm: this.model.trackWidthCm, source: this.model.source },
      plan: this.plan.legs.map((l) => (l.kind === 'spin'
        ? { k: 'spin', sec: l.section, x: r1(l.x), y: r1(l.y), deg: l.deltaDeg, s: r1(l.s) }
        : { k: 'path', sec: l.section, len: r1(l.lengthCm), s: r1(l.pts[0].s) })),
    });
    AutoRun.lightsOn(link, this.settings);
    this.prevPoller = poller.set(this.settings.lineGuard ? [{ cmd: '?LINE', hz: this.settings.lineHz }] : [], 'auto');
    this.offs.push(link.onReply((e) => {
      if (e.reply.type === 'line') this.onLine(e.reply.code, e.tRx);
    }));
    this.offs.push(link.onState((s) => {
      if (s === 'disconnected') this.stop('robot disconnected');
    }));
    this.timer = setInterval(() => this.tick(), this.settings.tickMs);
    return new Promise((r) => (this.resolve = r));
  }

  /** A camera fix (from the hand-held tracker). */
  onFix(fix: CamFixIn): void {
    this.latestFix = fix;
    if (this.state !== 'running' || !this.settings.cameraAssist) return;
    const res = this.est.addFix(fix);
    if (res.reason === 'reset' || (res.used && Math.hypot(res.dx, res.dy) > 5)) {
      // The camera found the robot away from the estimate (it slipped, got stuck, or the estimate ran
      // on while it was out of sight): the estimate moved; pick the route up where the robot is.
      const before = this.follower.progress;
      this.follower.resync(this.est.pose, res.reason === 'reset' ? 250 : 60);
      const tp = this.follower.target();
      if (res.reason === 'reset' && tp) {
        // Its heading is unknown after a while unseen: take the route's there (it was following it).
        const h = (tp.headingDeg * Math.PI) / 180, a = this.settings.markerAheadCm;
        this.est.relocate({ x: fix.x - a * Math.cos(h), y: fix.y - a * Math.sin(h), headingDeg: tp.headingDeg });
      }
      if (Math.abs(this.follower.progress - before) > 3) {
        this.recent = [];
        this.deps.logger.log('auto.resync', { from: r1(before), s: r1(this.follower.progress), x: r1(this.est.pose.x), y: r1(this.est.pose.y), why: res.reason ?? 'fix' });
      }
    }
    if (res.used || res.reason === 'reset') {
      this.lastFixT = Math.max(this.lastFixT, fix.t);
      this.seenS = this.follower.progress;
    }
    if (res.used) this.checkStuck(fix);
    const sec = this.lastStep?.section;
    if (sec && res.used) {
      const st = this.sections.get(sec);
      if (st) st.fixes++;
    }
    this.deps.logger.log('auto.fix', {
      tf: this.deps.logger.rel(fix.t), x: r1(fix.x), y: r1(fix.y), raw: fix.raw ? { x: r1(fix.raw.x), y: r1(fix.raw.y) } : undefined,
      hd: fix.headingDeg === null ? null : r1(fix.headingDeg), cmPx: r1(fix.cmPerPx * 10) / 10,
      used: res.used, why: res.reason, dx: r1(res.dx), dy: r1(res.dy), nis: r1(res.nis),
    });
  }

  /** Where marker A should be now (mat cm), for the camera's search. */
  hint(): { x: number; y: number } | undefined {
    return this.state === 'running' ? this.est.markerA() : undefined;
  }

  /**
   * Where the camera should look: around the estimate; when it hasn't seen
   * the robot for a moment, also along the route from 20 cm before where it
   * last saw it to just past the estimate (a robot that slips or gets stuck
   * falls behind its estimate).
   */
  searchArea(now: number): TrackGate {
    const center = this.est.markerA();
    const radiusCm = Math.min(40, 15 + 2 * this.est.pose.sigmaCm);
    if (now - this.lastFixT < 300) return { center, radiusCm, why: 'run' };
    const from = this.seenS - 20, to = this.follower.progress + 10;
    const a = this.settings.markerAheadCm;
    const trail: { x: number; y: number }[] = [];
    let last = -Infinity;
    for (const p of this.plan.outline) {
      if (p.s < from || p.s > to || p.s - last < 4) continue;
      last = p.s;
      const h = (p.headingDeg * Math.PI) / 180;
      trail.push({ x: p.x + a * Math.cos(h), y: p.y + a * Math.sin(h) });
    }
    return { center, radiusCm, why: 'lost', trail, trailRadiusCm: 14 };
  }

  /** Under (or next to) the bridge, where the camera can't see the robot. */
  private inBlindZone(): boolean {
    const b = this.route.bridge;
    if (!b) return false;
    const p = this.est.pose, m = 12;
    return p.x > b.x0 - m && p.x < b.x1 + m && p.y > b.y0 - m && p.y < b.y1 + m;
  }

  /** The camera sees the robot standing still while it is told to drive: stuck (on a cone?). */
  private checkStuck(fix: CamFixIn): void {
    const lim = this.settings.stuckStopMs;
    const step = this.lastStep;
    if (!lim || !step || step.kind !== 'path' || step.v < 10 || this.holdSince !== null) {
      this.recent = [];
      return;
    }
    this.recent.push({ t: fix.t, x: fix.x, y: fix.y });
    while (this.recent.length > 2 && fix.t - this.recent[1].t >= lim) this.recent.shift();
    const first = this.recent[0];
    if (fix.t - first.t < lim) return;
    let far = 0;
    for (const q of this.recent) far = Math.max(far, Math.hypot(q.x - first.x, q.y - first.y));
    if (far < 3) this.stop(`stuck: the camera saw it not moving for ${(lim / 1000).toFixed(1)} s (against a cone?)`);
  }

  /** The camera lost the robot: stand still and let it look; give up after lostStopMs. */
  private hold(t: number, camAge: number): void {
    const { logger } = this.deps;
    if (this.holdSince === null) {
      this.holdSince = t;
      this.holds++;
      this.recent = [];
      logger.log('auto.lost', { s: r1(this.follower.progress), sec: this.lastStep?.section, camAgeMs: Math.round(camAge) });
    }
    this.send(0, 0, t);
    this.est.setCommand(t, 0, 0);
    if (t - this.holdSince > this.settings.lostStopMs) {
      this.stop(`lost the robot: the camera hasn't seen it for ${(camAge / 1000).toFixed(1)} s`);
    }
  }

  private onLine(code: number, t: number): void {
    if (this.state !== 'running') return;
    const step = this.lastStep;
    const s = this.follower.progress;
    // The checkered start/finish squares read black; spins and their corners can read the border.
    const nearLine = s < 14 || s > this.plan.lengthCm - 14;
    const ignore = nearLine || step?.kind === 'spin';
    this.deps.logger.log('auto.line', { code, s: r1(s), ignored: ignore || undefined });
    if (ignore) {
      this.lineBlack = 0;
      return;
    }
    const sec = step ? this.sections.get(step.section) : undefined;
    if (code === 3) {
      this.lineBlack++;
      this.lineEvents++;
      if (sec) sec.lineEvents++;
      if (this.lineBlack >= 3) this.stop('left the lane (both line sensors black)');
      return;
    }
    this.lineBlack = 0;
    if (code === 1 || code === 2) {
      // One sensor off the band: steer back towards the other side for a moment.
      this.lineEvents++;
      if (sec) sec.lineEvents++;
      this.nudge = { k: code === 1 ? -0.03 : 0.03, until: t + 300 };
    }
  }

  private tick(): void {
    if (this.state !== 'running') return;
    const { clock, logger } = this.deps;
    const t = clock.now();
    this.est.advance(t);
    const pose = this.est.pose;
    // Lost by the camera (outside the bridge): hold still until it finds the robot again.
    const unseen = t - this.lastFixT;
    if (this.settings.cameraAssist && this.settings.lostPauseMs > 0) {
      const allowed = this.settings.lostPauseMs + (this.inBlindZone() ? 3000 : 0);
      if (unseen > allowed) {
        this.hold(t, unseen);
        if (this.state === 'running') {
          logger.log('auto.tick', { s: r1(this.follower.progress), sec: this.lastStep?.section, kind: 'hold', x: r1(pose.x), y: r1(pose.y), cam: Math.round(unseen) });
        }
        return;
      }
      if (this.holdSince !== null) {
        logger.log('auto.found', { s: r1(this.follower.progress), heldMs: Math.round(t - this.holdSince) });
        this.holdSince = null;
      }
    }
    this.follower.nudgeK = t < this.nudge.until ? this.nudge.k : 0;
    const step = this.follower.step(t, pose);
    this.lastStep = step;
    if (step.done) {
      this.send(0, 0, t);
      this.stop('finished');
      return;
    }
    this.send(step.l, step.r, t);
    this.est.setCommand(t, step.l, step.r);

    // Per-section error statistics (camera-backed estimate).
    const st = this.sections.get(step.section);
    if (st) {
      if (Number.isNaN(st.tStart)) st.tStart = t;
      st.tEnd = t;
      if (step.kind === 'path') {
        st.maxE = Math.max(st.maxE, Math.abs(step.e));
        st.sumE += Math.abs(step.e);
        st.n++;
      }
    }
    this.checkSpins(step, pose);
    const camAge = t - this.lastFixT;
    logger.log('auto.tick', {
      s: r1(step.s), sec: step.section, leg: step.leg, kind: step.kind, ph: step.phase,
      x: r1(pose.x), y: r1(pose.y), h: r1(pose.headingDeg), e: r1(step.e), he: r1(step.he),
      v: r1(step.v), w: r1(step.w), l: step.l, r: step.r,
      sig: r1(pose.sigmaCm), b: r1(pose.biasDegS), kv: Math.round(pose.speedScale * 100) / 100, kw: Math.round(pose.turnScale * 100) / 100,
      cam: Number.isFinite(camAge) ? Math.round(camAge) : null, nudge: this.follower.nudgeK || undefined,
    });

    // Off the track by the camera's account: stop before it gets worse.
    const lim = this.settings.offTrackStopCm;
    if (lim > 0 && this.settings.cameraAssist && camAge < 300 && step.kind === 'path' && Math.abs(step.e) > lim) {
      this.offTrackSince ??= t;
      if (t - this.offTrackSince > 500) this.stop(`off the track: ${Math.round(Math.abs(step.e))} cm from the path`);
    } else this.offTrackSince = null;
    const limitMs = (this.plan.lengthCm / Math.max(10, this.settings.speedCmS)) * 3000 + 30_000;
    if (t - this.t0 > limitMs) this.stop('timeout');
  }

  /** Log each spin, and the heading error once the robot has driven ~12 cm after it. */
  private checkSpins(step: FollowStep, pose: EstPose): void {
    const spins = this.follower.spins;
    while (this.spinsLogged < spins.length) {
      const s = spins[this.spinsLogged++];
      this.deps.logger.log('auto.spin', { sec: s.section, leg: s.leg, deg: r1(s.deltaDeg), durMs: Math.round(s.durMs), cmd: s.cmd, before: r1(s.headingBefore), target: s.target });
      this.spinResults.push({ section: s.section, deltaDeg: r1(s.deltaDeg), durMs: Math.round(s.durMs) });
      this.spinCheck = { idx: this.spinResults.length - 1, leg: s.leg + 1 };
    }
    const c = this.spinCheck;
    if (c && step.kind === 'path' && step.leg === c.leg) {
      const leg = this.plan.legs[c.leg];
      if (leg.kind === 'path' && step.s - leg.pts[0].s >= 12) {
        this.spinResults[c.idx].headingErrAfterDeg = r1(wrapDeg(pose.headingDeg - leg.pts[0].headingDeg));
        this.spinCheck = null;
      }
    }
  }

  private send(l: number, r: number, t: number): void {
    const same = l === this.lastSent.l && r === this.lastSent.r;
    if (same && t - this.lastSent.t < 250) return;
    this.lastSent = { l, r, t };
    void this.deps.link.send(l === 0 && r === 0 ? 'MS,0,0' : `MS,${l},${r}`);
  }

  stop(reason: string): void {
    if (this.state !== 'running') return;
    this.state = 'ended';
    const { link, poller, logger, clock } = this.deps;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    if (link.connected) void link.stop();
    for (const off of this.offs) off();
    this.offs = [];
    if (this.prevPoller) poller.set(this.prevPoller.entries, this.prevPoller.source);
    const t = clock.now();
    const pose = this.est.pose;
    const finished = reason === 'finished';
    const summary: AutoSummary = {
      reason, finished, timeMs: Math.round(t - this.t0), progressCm: r1(finished ? this.plan.lengthCm : this.follower.progress),
      lengthCm: r1(this.plan.lengthCm), style: this.settings.style, speedCmS: this.settings.speedCmS,
      tuning: this.settings.tuning?.label, predictedS: this.profile.predictedS,
      sections: [...this.sections.values()].filter((s) => !Number.isNaN(s.tStart)).map((s) => ({
        id: s.id, timeMs: Math.round(s.tEnd - s.tStart), maxErrCm: r1(s.maxE), meanErrCm: r1(s.n ? s.sumE / s.n : 0), fixes: s.fixes, lineEvents: s.lineEvents,
      })),
      fixes: { total: this.est.stats.fixes, used: this.est.stats.used, rejected: this.est.stats.rejected, resets: this.est.stats.resets },
      lineEvents: this.lineEvents,
      holds: this.holds,
      learned: { biasDegS: r1(pose.biasDegS), speedScale: Math.round(pose.speedScale * 100) / 100, turnScale: Math.round(pose.turnScale * 100) / 100 },
      spins: this.spinResults,
    };
    this.summary = summary;
    logger.log('auto.end', summary);
    this.resolve?.(summary);
  }

  live(): AutoLive {
    const t = this.deps.clock.now();
    return {
      running: this.state === 'running', t: t - this.t0, pose: this.est.pose, step: this.lastStep,
      lastFixAgeMs: t - this.lastFixT, progress: this.follower.progress, lengthCm: this.plan.lengthCm,
      section: this.lastStep?.section ?? this.plan.legs[0]?.section ?? '', reason: this.summary?.reason, holding: this.holdSince !== null,
    };
  }
}
