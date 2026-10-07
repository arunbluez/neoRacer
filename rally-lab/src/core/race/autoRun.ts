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
  /** Marker A (headlights) ahead of the axle, and the lights' heights above the mat, cm. */
  markerAheadCm: number;
  headHeightCm: number;
  ugHeightCm: number;
  headlights: Rgb;
  underglow: Rgb;
  tickMs: number;
  /** Stop when the camera shows the robot this far off the path for half a second (0 = never). */
  offTrackStopCm: number;
  /** The track code in use; undefined = the measured Robot Rallye track. */
  route?: RouteSpec;
  /** Where the camera views from, to remember the orientation (0..3, null = automatic). */
  matRot: number | null;
  /** Settings layout version (2: arcs became the default). */
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
  markerAheadCm: 5.5,
  headHeightCm: 3,
  ugHeightCm: 1,
  headlights: { r: 0, g: 255, b: 0 },
  underglow: { r: 0, g: 255, b: 255 },
  tickMs: 40,
  offTrackStopCm: 18,
  matRot: null,
  version: 2,
};

export type CamFixIn = { t: number; x: number; y: number; headingDeg: number | null; cmPerPx: number; raw?: { x: number; y: number }; conf?: number };

export type SectionStats = { id: string; tStart: number; tEnd: number; maxE: number; sumE: number; n: number; fixes: number };

export type AutoSummary = {
  reason: string;
  finished: boolean;
  timeMs: number;
  progressCm: number;
  lengthCm: number;
  style: TurnStyle;
  speedCmS: number;
  sections: { id: string; timeMs: number; maxErrCm: number; meanErrCm: number; fixes: number }[];
  fixes: { total: number; used: number; rejected: number; resets: number };
  lineEvents: number;
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
    this.follower = new Follower(this.plan, this.model, {
      speedCmS: settings.speedCmS, curveSpeedCmS: settings.curveSpeedCmS, settleCm: settings.settleCm, spinCmd: settings.spinCmd,
      spinLeadMs: settings.spinLeadMs, settleMs: settings.settleMs, afterSpinMs: settings.afterSpinMs,
    });
  }

  /** Turn the marker lights on (the camera looks for them). */
  static lightsOn(link: Pick<RobotLink, 'send'>, s: Pick<AutoSettings, 'headlights' | 'underglow'>): void {
    void link.send(rgbCmd('HL', s.headlights));
    void link.send(rgbCmd('UG', s.underglow));
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
    this.est.reset(sp.pose, now, sp.from === 'camera' ? { cm: 2, deg: 8 } : { cm: 4, deg: 10 });
    for (const s of this.plan.sectionStarts) this.sections.set(s.id, { id: s.id, tStart: NaN, tEnd: NaN, maxE: 0, sumE: 0, n: 0, fixes: 0 });
    logger.log('auto.start', {
      route: this.route.name, style: this.settings.style, lengthCm: r1(this.plan.lengthCm), legs: this.plan.legs.length,
      settings: { ...this.settings, route: this.settings.route ? this.route : undefined },
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
    if (res.used) this.lastFixT = fix.t;
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
    if (code === 3) {
      this.lineBlack++;
      this.lineEvents++;
      if (this.lineBlack >= 3) this.stop('left the lane (both line sensors black)');
      return;
    }
    this.lineBlack = 0;
    if (code === 1 || code === 2) {
      // One sensor off the band: steer back towards the other side for a moment.
      this.lineEvents++;
      this.nudge = { k: code === 1 ? -0.03 : 0.03, until: t + 300 };
    }
  }

  private tick(): void {
    if (this.state !== 'running') return;
    const { clock, logger } = this.deps;
    const t = clock.now();
    this.est.advance(t);
    const pose = this.est.pose;
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
      sections: [...this.sections.values()].filter((s) => !Number.isNaN(s.tStart)).map((s) => ({
        id: s.id, timeMs: Math.round(s.tEnd - s.tStart), maxErrCm: r1(s.maxE), meanErrCm: r1(s.n ? s.sumE / s.n : 0), fixes: s.fixes,
      })),
      fixes: { total: this.est.stats.fixes, used: this.est.stats.used, rejected: this.est.stats.rejected, resets: this.est.stats.resets },
      lineEvents: this.lineEvents,
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
      section: this.lastStep?.section ?? this.plan.legs[0]?.section ?? '', reason: this.summary?.reason,
    };
  }
}
