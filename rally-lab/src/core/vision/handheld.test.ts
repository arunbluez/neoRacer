// The hand-held tracking chain on simulated phone views of the synthetic mat:
// mat corners, which way round, camera position, and the robot's position
// with the lights' height corrected.
import { describe, expect, it } from 'vitest';
import { CUTEBOT_LOOK, drawSimRobot, HANDHELD_AT_B, HandShake, projector, renderMatView, type SimCameraPose } from '../sim/camera';
import { makeSyntheticTrack } from '../sim/track';
import type { SimLights } from '../sim/world';
import { defaultMarkerColor } from './color';
import { HandheldTracker } from './handheld';
import { applyH, type Pt } from './linalg';
import { findMat, quadToMat } from './matFinder';
import { bandGrid, cameraPose, correctParallax } from './matView';
import { fillDisc } from './rectify';

const track = makeSyntheticTrack({ cmPerPx: 0.5 });
const grid = bandGrid(track.centerline, 11, 200, 300, 4);
const GREEN = { r: 0, g: 255, b: 0 }, CYAN = { r: 0, g: 255, b: 255 };
const LIGHTS: SimLights = { hlL: GREEN, hlR: GREEN, ugL: CYAN, ugR: CYAN };
const W = 640, H = 480;
const now = () => 0;

function view(pose: SimCameraPose, robot?: { x: number; y: number; headingDeg: number }, t = 0) {
  const proj = projector(pose, W, H);
  const img = renderMatView(track.image, 200, 300, proj);
  if (robot) drawSimRobot(img, proj, robot, LIGHTS, CUTEBOT_LOOK, [track.bridge]);
  return { frame: { ...img, tCaptureMs: t }, proj };
}

function tracker() {
  return new HandheldTracker({
    grid, markerA: defaultMarkerColor(GREEN), markerB: defaultMarkerColor(CYAN), minAreaPx: 3,
    headHeightCm: CUTEBOT_LOOK.headHeight, ugHeightCm: CUTEBOT_LOOK.ugHeight,
  });
}

/** Marker A's ground point for a robot pose. */
const headPoint = (r: { x: number; y: number; headingDeg: number }): Pt => {
  const th = (r.headingDeg * Math.PI) / 180;
  return { x: r.x + Math.cos(th) * CUTEBOT_LOOK.headAhead, y: r.y + Math.sin(th) * CUTEBOT_LOOK.headAhead };
};

const SIDES: Record<string, SimCameraPose> = {
  b: HANDHELD_AT_B,
  c: { eye: { x: 400, y: 150, height: 140 }, target: { x: 100, y: 150 }, hfovDeg: 70, rollDeg: 0 },
  d: { eye: { x: 95, y: -125, height: 120 }, target: { x: 100, y: 160 }, hfovDeg: 66, rollDeg: 3 },
  a: { eye: { x: -200, y: 150, height: 140 }, target: { x: 100, y: 150 }, hfovDeg: 70, rollDeg: -2 },
};

describe('mat finder on simulated phone views', () => {
  for (const [side, pose] of Object.entries(SIDES)) {
    it(`finds the corners standing at side ${side}`, () => {
      const { frame, proj } = view(pose);
      const m = findMat(frame);
      expect(m).not.toBeNull();
      expect(m!.touchesBorder).toBe(false);
      const truth = [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 300 }, { x: 0, y: 300 }].map((q) => proj.project(q.x, q.y)!);
      for (const c of m!.corners) {
        const d = Math.min(...truth.map((q) => Math.hypot(q.x - c.x, q.y - c.y)));
        expect(d).toBeLessThan(1.5);
      }
    });
  }

  it('ignores dark things touching the mat edge', () => {
    const { frame, proj } = view(HANDHELD_AT_B);
    // a dark bag against the left edge and a shoe on the near edge
    const left = proj.project(0, 150)!, near = proj.project(120, 300)!;
    fillDisc(frame, left.x - 12, left.y, 16, [35, 35, 40]);
    fillDisc(frame, near.x, near.y + 10, 12, [30, 28, 30]);
    const m = findMat(frame)!;
    const truth = [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 300 }, { x: 0, y: 300 }].map((q) => proj.project(q.x, q.y)!);
    for (const c of m.corners) expect(Math.min(...truth.map((q) => Math.hypot(q.x - c.x, q.y - c.y)))).toBeLessThan(3);
  });

  it('flags a mat that runs out of the frame', () => {
    const { frame } = view({ ...HANDHELD_AT_B, eye: { x: 100, y: 330, height: 100 } });
    const m = findMat(frame);
    expect(m === null || m.touchesBorder).toBe(true);
  });
});

describe('hand-held tracker', () => {
  for (const [side, pose] of Object.entries(SIDES)) {
    it(`works out which way round the mat is from side ${side}`, () => {
      const tr = tracker();
      let out;
      for (let i = 0; i < 6; i++) out = tr.process(view(pose, undefined, i * 33).frame, now);
      expect(tr.rot).not.toBeNull();
      // mat corner 0 really is the mat's (0, 0)
      const { proj } = view(pose);
      const p = applyH(out!.H!, proj.project(10, 20)!);
      expect(p.x).toBeCloseTo(10, 0);
      expect(p.y).toBeCloseTo(20, 0);
    });
  }

  it('recovers the camera position from the mat alone', () => {
    const { frame } = view(HANDHELD_AT_B);
    const m = findMat(frame)!;
    const cam = cameraPose(quadToMat(m.corners, 0, 200, 300), W, H)!;
    expect(cam.x).toBeCloseTo(105, -1);
    expect(Math.abs(cam.y - 430)).toBeLessThan(8);
    expect(Math.abs(cam.height - 115)).toBeLessThan(6);
  });

  it('finds the robot, corrected for the height of its lights', () => {
    const tr = tracker();
    const robots = [
      { x: 48.5, y: 230.5, headingDeg: 90 }, // start, near
      { x: 100, y: 25, headingDeg: 180 }, // far straight
      { x: 151, y: 120, headingDeg: -90 }, // right side, middle
    ];
    for (let i = 0; i < 5; i++) tr.process(view(HANDHELD_AT_B, robots[0], i * 33).frame, now);
    for (const r of robots) {
      let fix;
      // the hint stands in for the estimator's prediction (the robot jumps between these poses)
      for (let i = 0; i < 3; i++) fix = tr.process(view(HANDHELD_AT_B, r, 1000 + i * 33).frame, now, headPoint(r)).fix;
      expect(fix).toBeDefined();
      const truth = headPoint(r);
      const err = Math.hypot(fix!.x - truth.x, fix!.y - truth.y);
      const rawErr = Math.hypot(fix!.raw.x - truth.x, fix!.raw.y - truth.y);
      expect(err).toBeLessThan(2.5);
      // at the far end the uncorrected position would be several cm off
      if (r.y < 50) expect(rawErr).toBeGreaterThan(5);
      // B → A is a short baseline and one underglow LED is often hidden: heading is only rough
      if (fix!.headingDeg !== null) expect(Math.abs(((fix!.headingDeg - r.headingDeg + 540) % 360) - 180)).toBeLessThan(40);
    }
  });

  it('keeps the corners and the robot while the phone shakes', () => {
    const tr = tracker();
    const shake = new HandShake(HANDHELD_AT_B, 1.5, 3);
    const robot = { x: 151, y: 150, headingDeg: -90 };
    let worst = 0, fixes = 0;
    for (let i = 0; i < 60; i++) {
      const t = i * 33;
      const out = tr.process(view(shake.at(t), robot, t).frame, now, headPoint(robot));
      if (!out.fix) continue;
      fixes++;
      const truth = headPoint(robot);
      worst = Math.max(worst, Math.hypot(out.fix.x - truth.x, out.fix.y - truth.y));
    }
    expect(fixes).toBeGreaterThan(50);
    expect(worst).toBeLessThan(4.5); // ~1.5 px at 640 × 480 where the robot is
  });

  it('loses the robot under the bridge', () => {
    const tr = tracker();
    for (let i = 0; i < 5; i++) tr.process(view(HANDHELD_AT_B, { x: 151, y: 150, headingDeg: -90 }, i * 33).frame, now);
    const out = tr.process(view(HANDHELD_AT_B, { x: 151, y: 222, headingDeg: -90 }, 500).frame, now);
    expect(out.H).toBeDefined();
    expect(out.fix).toBeUndefined();
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
