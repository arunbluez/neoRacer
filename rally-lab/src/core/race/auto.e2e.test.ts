// A whole camera-assisted lap: the Lab and the mock robot over the mock BLE
// link, a simulated hand-held phone rendering frames of the synthetic mat with
// the robot's lights, the hand-held tracker turning them into fixes, and the
// auto run driving the route.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { drive, makeLab } from '../testing/labHarness';
import { PUGUZ_PROFILE, PUGUZ_SIM } from '../testing/simLap';
import { CUTEBOT_LOOK, drawSimRobot, HANDHELD_AT_B, HandShake, projector, renderMatView } from '../sim/camera';
import { makeSyntheticTrack, nearestOnPath, paintedRoute, pathLengths } from '../sim/track';
import { defaultMarkerColor } from '../vision/color';
import { HandheldTracker } from '../vision/handheld';
import { laneModel } from '../vision/laneFit';
import { AutoRun, DEFAULT_AUTO_SETTINGS, trackingGate, type AutoSettings } from './autoRun';
import { analyzeRuns } from './lapAnalysis';
import { quickTune } from './learner';
import { buildPlan, RALLY_ROUTE } from './route';
import { effectiveTuning } from './speedProfile';

const track = makeSyntheticTrack({ cmPerPx: 0.5 });
const { cum, total } = pathLengths(track.centerline);
const model = laneModel(buildPlan(paintedRoute(RALLY_ROUTE), 'arc').outline, 9, 200, 300, 2);

async function lap(settings: Partial<AutoSettings>, camera = true) {
  const { lab, mock, clock, store } = await makeLab({ withTrack: true });
  Object.assign(mock.world.params, PUGUZ_SIM);
  await lab.updateProfile(PUGUZ_PROFILE);
  const s: AutoSettings = { ...DEFAULT_AUTO_SETTINGS, ...settings };
  const auto = lab.createAuto(s);
  AutoRun.lightsOn(lab.link, s);
  const tracker = new HandheldTracker({ model, marker: defaultMarkerColor(s.lightColor), minAreaPx: 3, markerHeightCm: s.markerHeightCm });
  const shake = new HandShake(HANDHELD_AT_B, 1, 11);
  let worst = 0, frames = 0, fixes = 0;
  let worstAt = { x: 0, y: 0, sec: '' };
  const cam = setInterval(() => {
    const t = clock.now();
    const tCap = t - 60; // exposure + delivery
    const w = mock.world;
    const truth = w.poseAt(tCap);
    if (auto.state === 'running') {
      const d = nearestOnPath(track.centerline, cum, total, truth.x, truth.y).d;
      if (d > worst) {
        worst = d;
        worstAt = { x: Math.round(truth.x), y: Math.round(truth.y), sec: auto.live().section };
      }
    }
    if (!camera) return;
    const proj = projector(shake.at(tCap), 480, 360);
    const img = renderMatView(track.image, 200, 300, proj);
    drawSimRobot(img, proj, truth, w.lightsAt(tCap), CUTEBOT_LOOK, [track.bridge]);
    const gate = trackingGate({ auto, now: clock.now(), route: RALLY_ROUTE, markerAheadCm: s.markerAheadCm });
    const out = tracker.process({ ...img, tCaptureMs: tCap }, () => clock.now(), gate);
    frames++;
    if (out.fix) {
      fixes++;
      auto.onFix(out.fix);
    }
  }, 66);
  await vi.advanceTimersByTimeAsync(800); // the camera finds the mat and the robot before the start
  const summary = await drive(auto.start(), 100, 150_000);
  clearInterval(cam);
  await lab.logger.flush();
  const events = await store.events(lab.logger.sessionId);
  return { summary, worst, worstAt, frames, fixes, events, lab, mock };
}

describe('camera-assisted auto run (simulated)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('drives a lap with arc turns, staying in the lane', async () => {
    const { summary, worst, fixes, events, lab } = await lap({ style: 'arc', speedCmS: 30 });
    if (process.env.DUMP_ARC) (await import('node:fs')).writeFileSync(process.env.DUMP_ARC, events.map((e) => JSON.stringify(e)).join('\n'));
    expect(summary.reason).toBe('finished');
    expect(summary.finished).toBe(true);
    expect(worst).toBeLessThan(9); // the lane band is ±11 cm
    expect(fixes).toBeGreaterThan(200);
    expect(summary.fixes.used).toBeGreaterThan(0.8 * summary.fixes.total);
    expect(summary.sections.map((x) => x.id).join('')).toBe('abcdefg');
    const kinds = new Set(events.map((e) => e.k));
    for (const k of ['auto.start', 'auto.tick', 'auto.fix', 'auto.end']) expect(kinds.has(k)).toBe(true);
    const { report } = await lab.bundle();
    expect(report).toContain('## Auto runs (camera assisted)');
    expect(report).toContain('### Auto run 1 — finished');
    expect(report).toMatch(/\| g \| [0-9.]+ \|/);
    // The log reads back as a run the quick tune can learn from: everything clean, so faster.
    const [run] = analyzeRuns(events, 'sim');
    expect(run.finished).toBe(true);
    expect(run.sections.every((x) => x.completed && x.straight)).toBe(true);
    expect(run.sections.find((x) => x.id === 'c')!.straight!.fixes).toBeGreaterThan(20);
    const cur = effectiveTuning(run.tuning, lab.auto!.profile);
    const q = quickTune(run, cur, 1);
    expect(q.tuning.sections.b.straightCmS).toBeGreaterThan(cur.sections.b.straightCmS);
    expect(q.tuning.sections.g.straightCmS).toBeGreaterThan(cur.sections.g.straightCmS);
  }, 60_000);

  it('drives a lap with spin turns at the slowest speed', async () => {
    const { summary, worst, worstAt, events } = await lap({ style: 'spin', speedCmS: 20 });
    if (process.env.DUMP) {
      console.log('spin lap', JSON.stringify({ worst, worstAt, sections: summary.sections, spins: summary.spins.map((x) => x.headingErrAfterDeg) }));
      (await import('node:fs')).writeFileSync(process.env.DUMP, events.map((e) => JSON.stringify(e)).join('\n'));
    }
    expect(summary.finished).toBe(true);
    expect(worst).toBeLessThan(10);
    expect(summary.spins.length).toBe(24);
  }, 90_000);

  it('stops when told to, and when the page is hidden', async () => {
    const { lab, mock, clock } = await makeLab({ withTrack: true });
    Object.assign(mock.world.params, PUGUZ_SIM);
    await lab.updateProfile(PUGUZ_PROFILE);
    const auto = lab.createAuto({ ...DEFAULT_AUTO_SETTINGS, cameraAssist: false });
    const p = auto.start();
    await vi.advanceTimersByTimeAsync(800);
    expect(mock.world.pose(clock.now()).y).toBeGreaterThan(track.start.y + 8); // on its way down section a
    lab.onHidden();
    const s = await drive(p);
    expect(s.reason).toBe('page hidden');
    await vi.advanceTimersByTimeAsync(300);
    expect(mock.world.pose(clock.now()).vl).toBeLessThan(1);
    expect(() => auto.start()).toThrow();
  });

  it('refuses to start when the camera sees the robot away from the start line', async () => {
    const { lab, clock } = await makeLab({ withTrack: true });
    const auto = lab.createAuto(DEFAULT_AUTO_SETTINGS);
    auto.onFix({ t: clock.now(), x: 120, y: 150, headingDeg: null, cmPerPx: 1 });
    expect(() => auto.start()).toThrow(/from the start line/);
  });
});
