// The hand-held tracking chain on simulated phone views of the synthetic mat:
// the track found by its lane (also in a cluttered hall and with the mat's
// edges out of view), the camera position, the robot's position with the
// lights' height corrected, the gate that ignores other robots, and the blink
// test that tells ours apart.
import { describe, expect, it } from 'vitest';
import { buildPlan, RALLY_ROUTE } from '../race/route';
import { CUTEBOT_LOOK, drawSimRobot, HANDHELD_AT_B, HandShake, projector, renderMatView, type SimCameraPose } from '../sim/camera';
import { makeSyntheticTrack, paintedRoute } from '../sim/track';
import type { SimLights } from '../sim/world';
import { BlinkFinder, BLINK_PATTERN } from './blinkFinder';
import { defaultMarkerColor } from './color';
import { HandheldTracker } from './handheld';
import { laneModel } from './laneFit';
import { applyH, type Pt } from './linalg';
import { findMat, quadToMat } from './matFinder';
import { cameraPose, correctParallax } from './matView';
import { fillDisc } from './rectify';

const track = makeSyntheticTrack({ cmPerPx: 0.5 });
const model = laneModel(buildPlan(paintedRoute(RALLY_ROUTE), 'arc').outline, 9, 200, 300, 2);
const GREEN = { r: 0, g: 255, b: 0 };
const ALL_GREEN: SimLights = { hlL: GREEN, hlR: GREEN, ugL: GREEN, ugR: GREEN };
const OFF = { r: 0, g: 0, b: 0 };
const W = 640, H = 480;
const now = () => 0;

type Robot = { x: number; y: number; headingDeg: number; lights?: SimLights };

function view(pose: SimCameraPose, robots: Robot[] = [], t = 0, clutter = false) {
  const proj = projector(pose, W, H);
  const img = renderMatView(track.image, 200, 300, proj);
  if (clutter) {
    // people in dark clothes, a bag and chairs right against the far end and the left side
    for (const [x, y, r] of [[30, -25, 22], [100, -30, 26], [170, -20, 18], [-30, 60, 22], [-35, 160, 18], [-25, 240, 15]] as const) {
      const c = proj.project(x, y, 0);
      if (c) fillDisc(img, c.x, c.y, r, [35, 34, 40]);
    }
  }
  for (const r of robots) drawSimRobot(img, proj, r, r.lights ?? ALL_GREEN, CUTEBOT_LOOK, [track.bridge]);
  return { frame: { ...img, tCaptureMs: t }, proj };
}

function tracker() {
  return new HandheldTracker({ model, marker: defaultMarkerColor(GREEN), minAreaPx: 3, markerHeightCm: 2 });
}

/** The centre of the four lights' ground points (roughly what the merged patch is). */
const lightsPoint = (r: Robot): Pt => {
  const th = (r.headingDeg * Math.PI) / 180;
  return { x: r.x + Math.cos(th) * 2.75, y: r.y + Math.sin(th) * 2.75 };
};

const SIDES: Record<string, SimCameraPose> = {
  b: HANDHELD_AT_B,
  c: { eye: { x: 400, y: 150, height: 140 }, target: { x: 100, y: 150 }, hfovDeg: 70, rollDeg: 0 },
  d: { eye: { x: 95, y: -125, height: 120 }, target: { x: 100, y: 160 }, hfovDeg: 66, rollDeg: 3 },
  a: { eye: { x: -200, y: 150, height: 140 }, target: { x: 100, y: 150 }, hfovDeg: 70, rollDeg: -2 },
};

/** How far off (mat cm) the fit puts a point of the lane: where the frame shows it, mapped back. */
const near = (H: number[], proj: ReturnType<typeof projector>, p: Pt) => {
  const q = applyH(H, proj.project(p.x, p.y)!);
  return Math.hypot(q.x - p.x, q.y - p.y);
};

describe('mat outline finder (still used as a starting point)', () => {
  it('finds the corners from side b', () => {
    const { frame, proj } = view(HANDHELD_AT_B);
    const m = findMat(frame)!;
    const truth = [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 300 }, { x: 0, y: 300 }].map((q) => proj.project(q.x, q.y)!);
    for (const c of m.corners) expect(Math.min(...truth.map((q) => Math.hypot(q.x - c.x, q.y - c.y)))).toBeLessThan(1.5);
    const cam = cameraPose(quadToMat(m.corners, 0, 200, 300), W, H)!;
    expect(Math.abs(cam.height - 115)).toBeLessThan(6);
  });
});

describe('hand-held tracker', () => {
  for (const [side, pose] of Object.entries(SIDES)) {
    it(`fits the lane seen from side ${side}`, () => {
      const tr = tracker();
      const { frame, proj } = view(pose, [], 0, true);
      const out = tr.process(frame, now);
      expect(out.H).toBeDefined();
      // at the far end one pixel is 2–3 cm of mat
      for (const p of [{ x: 48.5, y: 150 }, { x: 151, y: 150 }, { x: 100, y: 25 }, { x: 100, y: 276 }]) expect(near(out.H!, proj, p)).toBeLessThan(3.5);
      expect(out.side).toBe(side);
    });
  }

  it('does not need the mat edges in view', () => {
    // close to the near end: the mat's near corners are out of the picture
    const pose: SimCameraPose = { eye: { x: 100, y: 345, height: 120 }, target: { x: 100, y: 150 }, hfovDeg: 66, rollDeg: 0 };
    const { frame, proj } = view(pose);
    const m = findMat(frame);
    expect(m === null || m.touchesBorder).toBe(true);
    const out = tracker().process(frame, now);
    expect(out.H).toBeDefined();
    expect(near(out.H!, proj, { x: 151, y: 120 })).toBeLessThan(2.5);
  });

  it('finds our robot, corrected for the height of its lights, and ignores others outside the gate', () => {
    const tr = tracker();
    const ours: Robot = { x: 100, y: 25, headingDeg: 180 };
    const other: Robot = { x: 151, y: 150, headingDeg: -90 };
    const { frame } = view(HANDHELD_AT_B, [ours, other]);
    tr.process(frame, now);
    const out = tr.process(frame, now, { center: lightsPoint(ours), radiusCm: 20 });
    expect(out.fix).toBeDefined();
    const err = Math.hypot(out.fix!.x - lightsPoint(ours).x, out.fix!.y - lightsPoint(ours).y);
    expect(err).toBeLessThan(3);
    // uncorrected, the far-end lights would look several cm further away
    expect(Math.abs(out.fix!.raw.y - out.fix!.y)).toBeGreaterThan(3);
    // without a gate the other robot is just as visible
    expect(tr.process(frame, now).blobs).toBeGreaterThanOrEqual(2);
  });

  it('keeps tracking while the phone shakes', () => {
    const tr = tracker();
    const shake = new HandShake(HANDHELD_AT_B, 1.5, 3);
    const robot: Robot = { x: 151, y: 150, headingDeg: -90 };
    let worst = 0, fixes = 0;
    for (let i = 0; i < 40; i++) {
      const t = i * 33;
      const out = tr.process(view(shake.at(t), [robot], t, true).frame, now, { center: lightsPoint(robot), radiusCm: 20 });
      if (!out.fix) continue;
      fixes++;
      worst = Math.max(worst, Math.hypot(out.fix.x - lightsPoint(robot).x, out.fix.y - lightsPoint(robot).y));
    }
    expect(fixes).toBeGreaterThan(35);
    expect(worst).toBeLessThan(4.5);
  });

  it('tells our robot from another by blinking its lights', () => {
    const tr = tracker();
    const ours: Robot = { x: 48.5, y: 230.5, headingDeg: 90 };
    const other: Robot = { x: 60, y: 200, headingDeg: 90 };
    const bf = new BlinkFinder(0);
    const latency = 120;
    for (let t = 0; t < 2600; t += 50) {
      // our lights follow the pattern, seen `latency` ms later
      let on = true;
      for (const s of BLINK_PATTERN) if (s.t <= t - latency) on = s.on;
      const { frame } = view(HANDHELD_AT_B, [{ ...ours, lights: on ? ALL_GREEN : { hlL: OFF, hlR: OFF, ugL: OFF, ugR: OFF } }, other], t);
      const out = tr.process(frame, now);
      const cur = tr.current(t)!;
      bf.add(t, tr.blobs(frame, cur, out.cam));
    }
    const res = bf.result();
    expect(res).not.toBeNull();
    expect(Math.hypot(res!.pos.x - lightsPoint(ours).x, res!.pos.y - lightsPoint(ours).y)).toBeLessThan(4);
    expect(Math.abs(res!.latencyMs - latency)).toBeLessThanOrEqual(75);
  });

  it('parallax correction is the inverse of where a raised point is seen', () => {
    const cam = { x: 100, y: 430, height: 115 };
    const g = { x: 60, y: 40 };
    const k = 1 - 3 / 115;
    const seen = { x: cam.x + (g.x - cam.x) / k, y: cam.y + (g.y - cam.y) / k };
    const back = correctParallax(seen, cam, 3);
    expect(back.x).toBeCloseTo(g.x, 6);
    expect(back.y).toBeCloseTo(g.y, 6);
  });
});
