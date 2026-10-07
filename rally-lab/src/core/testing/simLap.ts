// A lap of the auto run against the simulated robot, without the link: the
// estimator, follower and a camera model (late, noisy fixes of marker A, none
// under the bridge) in a plain time-stepped loop. For tuning and tests.

import { PoseEstimator, type EstimatorOpts } from '../race/estimator';
import { Follower, type FollowerOpts } from '../race/follower';
import { motorModel } from '../race/motor';
import { buildPlan, RALLY_ROUTE, type PlanOpts, type RouteSpec, type TurnStyle } from '../race/route';
import type { RobotProfile } from '../model/profile';
import { makeSyntheticTrack, nearestOnPath, pathLengths } from '../sim/track';
import { PUGUZ_PROFILE, PUGUZ_SIM } from '../sim/robots';
import { rng, SimWorld, type SimParams } from '../sim/world';

export { PUGUZ_PROFILE, PUGUZ_SIM };

export type SimLapOpts = {
  style: TurnStyle;
  plan?: PlanOpts;
  follower?: Partial<FollowerOpts>;
  estimator?: Partial<EstimatorOpts>;
  camera: boolean;
  /** Camera: frame rate, delay, noise (cm). */
  camHz?: number;
  camDelayMs?: number;
  camNoiseCm?: number;
  /** Error in the frames' timestamps (positive: stamped later than taken), ms. */
  camStampErrorMs?: number;
  sim?: Partial<SimParams>;
  profile?: Partial<RobotProfile>;
  route?: RouteSpec;
  maxMs?: number;
  seed?: number;
};

export type SimLapResult = {
  finished: boolean;
  timeMs: number;
  /** Distance of the robot from the painted lane centre, cm. */
  maxOffLaneCm: number;
  meanOffLaneCm: number;
  /** Worst per section. */
  perSection: Record<string, number>;
  /** Estimator vs truth at the end, cm. */
  estErrCm: number;
  biasDegS: number;
  speedScale: number;
  end: { x: number; y: number };
};

export function simLap(opts: SimLapOpts): SimLapResult {
  const route = opts.route ?? RALLY_ROUTE;
  const track = makeSyntheticTrack({ cmPerPx: 1, route });
  const { cum, total } = pathLengths(track.centerline);
  const world = new SimWorld(0, { mask: track.mask, pose: route.start, params: { ...PUGUZ_SIM, ...opts.sim }, seed: opts.seed ?? 1 });
  const model = motorModel(opts.profile ?? PUGUZ_PROFILE);
  const est = new PoseEstimator(model, opts.estimator);
  const plan = buildPlan(route, opts.style, opts.plan);
  const fol = new Follower(plan, model, opts.follower);
  const rand = rng(opts.seed ?? 1);
  const gauss = () => {
    let s = 0;
    for (let i = 0; i < 6; i++) s += rand();
    return (s - 3) * Math.SQRT2;
  };
  est.reset(route.start, 0, { cm: 1, deg: 3 });
  const tick = 40;
  const camPeriod = 1000 / (opts.camHz ?? 25);
  const camDelay = opts.camDelayMs ?? 120;
  const noise = opts.camNoiseCm ?? 1;
  const pending: { due: number; fix: { t: number; x: number; y: number; headingDeg: null; cmPerPx: number } }[] = [];
  let nextCam = 0;
  let maxOff = 0, sumOff = 0, n = 0;
  const perSection: Record<string, number> = {};
  const maxMs = opts.maxMs ?? 120_000;
  const sendLatency = 20;
  let lastCmd = { l: 0, r: 0 };
  let t = 0;
  let finished = false;
  for (; t < maxMs; t += tick) {
    // camera frames taken in this tick, delivered later
    while (opts.camera && nextCam <= t) {
      const p = world.poseAt(nextCam);
      const th = (p.headingDeg * Math.PI) / 180;
      const hx = p.x + 5.5 * Math.cos(th), hy = p.y + 5.5 * Math.sin(th);
      const b = track.bridge;
      if (!(hx >= b.x0 && hx <= b.x1 && hy >= b.y0 && hy <= b.y1)) {
        pending.push({ due: nextCam + camDelay, fix: { t: Math.min(nextCam + camDelay, nextCam + (opts.camStampErrorMs ?? 0)), x: hx + gauss() * noise, y: hy + gauss() * noise, headingDeg: null, cmPerPx: 1 } });
      }
      nextCam += camPeriod;
    }
    world.advanceTo(t);
    est.advance(t);
    while (pending.length && pending[0].due <= t) est.addFix(pending.shift()!.fix);
    const step = fol.step(t, est.pose);
    if (step.l !== lastCmd.l || step.r !== lastCmd.r) {
      world.setMotors(step.l, step.r, t + sendLatency);
      est.setCommand(t, step.l, step.r);
      lastCmd = { l: step.l, r: step.r };
    }
    const truth = world.pose(t);
    const off = nearestOnPath(track.centerline, cum, total, truth.x, truth.y).d;
    if (t > 300) {
      maxOff = Math.max(maxOff, off);
      sumOff += off;
      n++;
      perSection[step.section] = Math.max(perSection[step.section] ?? 0, off);
    }
    if (step.done) {
      finished = true;
      break;
    }
  }
  world.setMotors(0, 0, t);
  const truth = world.pose(t + 500);
  const e = est.pose;
  return {
    finished, timeMs: t, maxOffLaneCm: maxOff, meanOffLaneCm: n ? sumOff / n : 0, perSection,
    estErrCm: Math.hypot(e.x - truth.x, e.y - truth.y), biasDegS: e.biasDegS, speedScale: e.speedScale,
    end: { x: truth.x, y: truth.y },
  };
}
