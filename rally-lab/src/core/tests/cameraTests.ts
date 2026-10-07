// T4.x — camera experiments. Phone on a tripod at the mat's edge.

import type { MarkerSource } from '../settings';
import { max, mean, median, min, quantile, std } from '../util/stats';
import { pointErrorsCm } from '../vision/calibration';
import type { FrameStat, MarkerProbe, TrackedPose } from './camera';
import { num, r1 } from './helpers';
import type { TestContext, TestDefinition } from './types';

function needPose(ctx: TestContext) {
  if (!ctx.pose?.active) throw new Error('Camera tracking is not running: calibrate the track and markers, then start tracking on the Camera tab.');
  return ctx.pose;
}

function needCamera(ctx: TestContext) {
  if (!ctx.camera) throw new Error('Start the camera on the Camera tab first.');
  return ctx.camera;
}

/** The light command for a marker source. */
export function lightCommand(source: MarkerSource, rgb: { r: number; g: number; b: number }): string {
  const c = `${Math.round(rgb.r)},${Math.round(rgb.g)},${Math.round(rgb.b)}`;
  switch (source) {
    case 'headlights': return `HL,${c}`;
    case 'headlightLeft': return `HLL,${c}`;
    case 'headlightRight': return `HLR,${c}`;
    case 'underglow': return `UG,${c}`;
  }
}

// ---------------------------------------------------------------- T4.1

type CamCaps = { label?: string; deviceId?: string; capabilities?: Record<string, unknown>; settings?: Record<string, unknown>; error?: string };

export const T4_1: TestDefinition = {
  id: 'T4.1',
  group: 'Camera',
  title: 'Capabilities',
  setup: 'Dumps getCapabilities() and getSettings() for every camera (each opens briefly). Stop tracking first if a camera is in use.',
  params: [],
  needs: { robot: false, camera: true },
  maxMs: 60_000,
  async run(ctx) {
    const cams = (await needCamera(ctx).dumpCapabilities()) as CamCaps[];
    ctx.artifact('cameras.json', cams);
    ctx.sample({ cameras: cams.length });
    return { cameras: cams };
  },
  summarize(raw) {
    const cams = (raw as { cameras: CamCaps[] }).cameras;
    const range = (v: unknown) => {
      if (!v || typeof v !== 'object') return Array.isArray(v) ? v.join('/') : v === undefined ? null : String(v);
      const r = v as { min?: number; max?: number };
      return r.min !== undefined ? `${r.min}–${r.max}` : JSON.stringify(v);
    };
    return {
      values: { cameras: cams.length },
      tables: [{
        title: 'Cameras',
        columns: ['label', 'max size', 'zoom', 'exposure', 'white balance', 'focus', 'error'],
        rows: cams.map((c) => {
          const cap = c.capabilities ?? {};
          return [
            c.label ?? c.deviceId ?? '?', `${range(cap.width)} × ${range(cap.height)}`, range(cap.zoom),
            range(cap.exposureMode), range(cap.whiteBalanceMode), range(cap.focusMode), c.error ?? null,
          ] as (string | number | null)[];
        }),
      }],
      notes: ['Full JSON per camera is in session.json and tests/<runId>/cameras.json.'],
    };
  },
};

// ---------------------------------------------------------------- T4.2

type T42Data = { calibrationId?: string; points: { img: { x: number; y: number }; mat: { x: number; y: number }; errCm: number }[]; rms: number; max: number; mean: number };

export const T4_2: TestDefinition = {
  id: 'T4.2',
  group: 'Camera',
  title: 'Calibration check',
  setup: 'After calibration: tap 4 or more points whose mat position you know (measure with a tape from the top-left corner) and enter their coordinates. Reports the reprojection error in cm.',
  params: [{ key: 'count', label: 'Points', type: 'number', default: 4, min: 4, max: 12 }],
  needs: { robot: false, camera: true },
  maxMs: 600_000,
  async run(ctx, p) {
    const cam = needCamera(ctx);
    const cal = ctx.calibration;
    if (!cal) throw new Error('No active calibration.');
    const pts = await cam.collectPoints(Number(p.count));
    const e = pointErrorsCm(cal, pts);
    const data: T42Data = {
      calibrationId: cal.id,
      points: pts.map((q, i) => ({ img: { x: r1(q.img.x), y: r1(q.img.y) }, mat: q.mat, errCm: Math.round(e.perPoint[i] * 100) / 100 })),
      rms: e.rms, max: e.max, mean: e.mean,
    };
    ctx.sample({ rms: e.rms, max: e.max });
    return data;
  },
  summarize(raw) {
    const d = raw as T42Data;
    return {
      values: { rmsCm: num(d.rms, 2), maxCm: num(d.max, 2), meanCm: num(d.mean, 2), points: d.points.length, calibrationId: d.calibrationId ?? null },
      tables: [{ title: 'Check points', columns: ['x cm', 'y cm', 'error cm'], rows: d.points.map((q) => [q.mat.x, q.mat.y, q.errCm]) }],
      notes: [d.max <= 2 ? `Calibration good: max error ${num(d.max, 2)} cm.` : `Max error ${num(d.max, 2)} cm is above 2 cm: recalibrate (check the corners and mat size).`],
    };
  },
};

// ---------------------------------------------------------------- T4.3

export const T43_SPOTS = ['lane blue end', 'lane pink end', 'bridge', 'a hairpin', 'start'];

type SpotResult = { spot: string; frames: number; detected: number; stdXmm: number; stdYmm: number; jitterMm: number; falseDet: number; multiCandidates: number; x: number; y: number };

export const T4_3: TestDefinition = {
  id: 'T4.3',
  group: 'Camera',
  title: 'Tracking quality',
  setup: 'Tracking on, robot lights set as markers. Place the robot still at each spot for 3 s: detection rate, position jitter (mm) and false detections.',
  params: [
    { key: 'spots', label: 'Spots', type: 'multi', default: T43_SPOTS, options: T43_SPOTS },
    { key: 'holdS', label: 'Hold', type: 'number', default: 3, unit: 's' },
  ],
  needs: { robot: false, camera: true, tracking: true },
  maxMs: 300_000,
  async run(ctx, p) {
    const pose = needPose(ctx);
    const holdMs = Number(p.holdS) * 1000;
    const spots = p.spots as string[];
    const results: SpotResult[] = [];
    ctx.keep({ results });
    for (const [k, spot] of spots.entries()) {
      await ctx.ask({ title: `Spot: ${spot}`, text: 'Place the robot there, hands away, then Measure.', buttons: ['Measure'] });
      await ctx.sleep(300);
      const t0 = ctx.clockNow();
      await ctx.sleep(holdMs);
      const frames: FrameStat[] = pose.frames(t0, ctx.clockNow());
      const poses: TrackedPose[] = pose.between(t0, ctx.clockNow());
      const mx = median(poses.map((q) => q.xCm));
      const my = median(poses.map((q) => q.yCm));
      const far = poses.filter((q) => Math.hypot(q.xCm - mx, q.yCm - my) > 5);
      const near = poses.filter((q) => Math.hypot(q.xCm - mx, q.yCm - my) <= 5);
      const sx = std(near.map((q) => q.xCm)) * 10;
      const sy = std(near.map((q) => q.yCm)) * 10;
      const res: SpotResult = {
        spot, frames: frames.length, detected: frames.filter((f) => f.detected).length,
        stdXmm: r1(sx), stdYmm: r1(sy), jitterMm: r1(Math.hypot(sx, sy)), falseDet: far.length,
        multiCandidates: frames.filter((f) => f.candidates > 1).length, x: r1(mx), y: r1(my),
      };
      results.push(res);
      ctx.sample(res);
      ctx.progress((k + 1) / spots.length, spot);
    }
    return { results };
  },
  summarize(raw) {
    const rs = (raw as { results: SpotResult[] }).results;
    const total = rs.reduce((n, r) => n + r.frames, 0);
    const det = rs.reduce((n, r) => n + r.detected, 0);
    return {
      values: { detectRatePct: num((100 * det) / Math.max(1, total)), worstJitterMm: num(max(rs.map((r) => r.jitterMm))), falseDetections: rs.reduce((n, r) => n + r.falseDet, 0) },
      tables: [{
        title: 'Robot still at each spot',
        columns: ['spot', 'x cm', 'y cm', 'frames', 'detected %', 'jitter mm', 'std x', 'std y', 'false', 'multi-blob frames'],
        rows: rs.map((r) => [r.spot, r.x, r.y, r.frames, num((100 * r.detected) / Math.max(1, r.frames)), r.jitterMm, r.stdXmm, r.stdYmm, r.falseDet, r.multiCandidates]),
      }],
      notes: ['False = detections more than 5 cm from the spot median. Multi-blob frames had more than one marker-coloured blob (cones, labels, borders).'],
    };
  },
};

// ---------------------------------------------------------------- T4.4

type T44Data = { durS: number; frames: number; procs: number[]; gaps: number[]; detected: number };

export const T4_4: TestDefinition = {
  id: 'T4.4',
  group: 'Camera',
  title: 'Frame timing',
  setup: '30 s of tracking: frame rate, processing time and frame gaps. The robot may sit still or be driven.',
  params: [{ key: 'durationS', label: 'Duration', type: 'number', default: 30, unit: 's' }],
  needs: { robot: false, camera: true, tracking: true },
  maxMs: 120_000,
  async run(ctx, p) {
    const pose = needPose(ctx);
    const durMs = Number(p.durationS) * 1000;
    const t0 = ctx.clockNow();
    while (ctx.clockNow() - t0 < durMs) {
      await ctx.sleep(500);
      ctx.progress((ctx.clockNow() - t0) / durMs);
    }
    const fr = pose.frames(t0, ctx.clockNow());
    const gaps = fr.slice(1).map((f, i) => f.tFrame - fr[i].tFrame);
    const data: T44Data = { durS: durMs / 1000, frames: fr.length, procs: fr.map((f) => r1(f.procMs)), gaps: gaps.map(r1), detected: fr.filter((f) => f.detected).length };
    ctx.sample({ frames: data.frames });
    return data;
  },
  summarize(raw) {
    const d = raw as T44Data;
    const medGap = median(d.gaps);
    const long = d.gaps.filter((g) => g > 1.5 * medGap);
    return {
      values: {
        fps: num(d.frames / d.durS), procMedMs: num(median(d.procs)), procP95Ms: num(quantile(d.procs, 0.95)), procMaxMs: num(max(d.procs)),
        gapMedMs: num(medGap), gapMaxMs: num(max(d.gaps)), longGaps: long.length, detectPct: num((100 * d.detected) / Math.max(1, d.frames)),
      },
      tables: [{ title: 'Frame intervals (ms)', columns: ['min', 'median', 'p95', 'max', '> 1.5× median'], rows: [[num(min(d.gaps)), num(medGap), num(quantile(d.gaps, 0.95)), num(max(d.gaps)), long.length]] }],
      notes: [
        `${num(d.frames / d.durS)} fps, processing ${num(median(d.procs))} ms median (target ≤ 20 ms, ≥ 20 fps).`,
        quantile(d.procs, 0.95) > 15 ? 'Processing p95 above 15 ms: consider tracking in a Web Worker.' : 'Processing fits comfortably in the frame budget.',
      ],
    };
  },
};

// ---------------------------------------------------------------- T4.5

type Switch = { toB: boolean; tSent: number; tDone: number; tSeen: number | null };
type T45Data = { colorA: number[]; colorB: number[]; switches: Switch[]; source: MarkerSource };

const dist3 = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

export const T4_5: TestDefinition = {
  id: 'T4.5',
  group: 'Camera',
  title: 'LED latency',
  setup: 'Robot still and tracked. Switches the marker-A light between colour A and B at random 300–700 ms intervals, 30 times, and times send → first frame showing the new colour (Bluetooth + firmware + camera).',
  params: [
    { key: 'switches', label: 'Switches', type: 'number', default: 30 },
    { key: 'colorB', label: 'Colour B (r,g,b)', type: 'text', default: '255,0,0' },
  ],
  needs: { robot: true, camera: true, tracking: true },
  maxMs: 90_000,
  async run(ctx, p) {
    const pose = needPose(ctx);
    const cam = needCamera(ctx);
    const spec = ctx.settings.markerA;
    const [br, bg, bb] = String(p.colorB).split(',').map(Number);
    const cmdA = lightCommand(spec.source, spec.rgb);
    const cmdB = lightCommand(spec.source, { r: br || 0, g: bg || 0, b: bb || 0 });
    const probes: MarkerProbe[] = [];
    const off = cam.probeMarker((q) => probes.push(q));
    const meanColor = (t0: number) => {
      const ps = probes.filter((q) => q.tFrame >= t0);
      return [mean(ps.map((q) => q.r)), mean(ps.map((q) => q.g)), mean(ps.map((q) => q.b))];
    };
    const data: T45Data = { colorA: [], colorB: [], switches: [], source: spec.source };
    ctx.keep(data);
    try {
      if (!pose.latest()) throw new Error('Marker A is not detected: check the lights and marker calibration.');
      await ctx.link.send(cmdA, { ch: 'raw' });
      await ctx.sleep(600);
      let t = ctx.clockNow();
      await ctx.sleep(400);
      data.colorA = meanColor(t).map(r1);
      await ctx.link.send(cmdB, { ch: 'raw' });
      await ctx.sleep(600);
      t = ctx.clockNow();
      await ctx.sleep(400);
      data.colorB = meanColor(t).map(r1);
      if (dist3(data.colorA, data.colorB) < 30) throw new Error(`Colours A and B look the same to the camera (${data.colorA} vs ${data.colorB}).`);
      let toB = false;
      const n = Number(p.switches);
      for (let i = 0; i < n; i++) {
        toB = !toB;
        const target = toB ? data.colorB : data.colorA;
        const other = toB ? data.colorA : data.colorB;
        const rec = await ctx.link.send(toB ? cmdB : cmdA, { ch: 'raw' });
        const tSent = rec.tSent ?? ctx.clockNow();
        const wait = 300 + Math.random() * 400;
        await ctx.sleep(wait);
        const seen = probes.find((q) => q.tFrame > tSent && dist3([q.r, q.g, q.b], target) < dist3([q.r, q.g, q.b], other));
        const sw: Switch = { toB, tSent, tDone: rec.tDone ?? tSent, tSeen: seen ? seen.tFrame : null };
        data.switches.push(sw);
        ctx.sample({ i, toB, latencyMs: seen ? r1(seen.tFrame - tSent) : null });
        ctx.progress((i + 1) / n);
      }
    } finally {
      off();
      void ctx.link.send(cmdA, { ch: 'raw' });
    }
    return data;
  },
  summarize(raw) {
    const d = raw as T45Data;
    const lat = d.switches.filter((s) => s.tSeen !== null).map((s) => s.tSeen! - s.tSent);
    const fromDone = d.switches.filter((s) => s.tSeen !== null).map((s) => s.tSeen! - s.tDone);
    const med = median(lat);
    return {
      values: {
        latencyMedMs: num(med), latencyP95Ms: num(quantile(lat, 0.95)), latencyMinMs: num(min(lat)), latencyMaxMs: num(max(lat)),
        fromWriteDoneMedMs: num(median(fromDone)), missed: d.switches.length - lat.length,
      },
      tables: [{ title: 'Camera colours (mean RGB at the marker)', columns: ['colour', 'r', 'g', 'b'], rows: [['A', ...d.colorA], ['B', ...d.colorB]] }],
      notes: [
        `Send → seen: ${num(med)} ms median, ${num(quantile(lat, 0.95))} ms p95 (${lat.length} of ${d.switches.length} switches seen).`,
        'Includes Bluetooth, firmware, LED, camera exposure and frame delivery; use it as the tracker prediction latency.',
      ],
      profilePatch: Number.isFinite(med) ? { ledLatencyMs: Math.round(med) } : undefined,
      settingsPatch: Number.isFinite(med) ? { trackingLatencyMs: Math.round(med) } : undefined,
    };
  },
};

// ---------------------------------------------------------------- T4.6

type MotionRun = { i: number; tSent: number; latencyMs: number | null; thresholdCm: number };

export const T4_6: TestDefinition = {
  id: 'T4.6',
  group: 'Camera',
  title: 'Motion latency',
  setup: 'Robot still and tracked with ~30 cm clear ahead and behind. F,60 from rest 10 times (each followed by B,60 to return): send → first frame where the robot has moved.',
  params: [
    { key: 'runs', label: 'Runs', type: 'number', default: 10 },
    { key: 'speed', label: 'Speed', type: 'number', default: 60 },
    { key: 'driveMs', label: 'Drive time', type: 'number', default: 400, unit: 'ms' },
  ],
  needs: { robot: true, motion: true, camera: true, tracking: true },
  maxMs: 120_000,
  async run(ctx, p) {
    const pose = needPose(ctx);
    const n = Number(p.runs);
    const speed = Number(p.speed);
    const driveMs = Number(p.driveMs);
    const runs: MotionRun[] = [];
    ctx.keep({ runs });
    for (let i = 0; i < n; i++) {
      await ctx.sleep(800);
      const rest = pose.between(ctx.clockNow() - 600, ctx.clockNow());
      if (rest.length < 3) throw new Error('Robot not tracked at rest.');
      const mx = median(rest.map((q) => q.xCm));
      const my = median(rest.map((q) => q.yCm));
      const sd = Math.hypot(std(rest.map((q) => q.xCm)), std(rest.map((q) => q.yCm)));
      const thr = Math.max(0.5, 4 * sd);
      const rec = await ctx.link.send(`F,${speed}`);
      const tSent = rec.tSent ?? ctx.clockNow();
      await ctx.sleep(driveMs);
      await ctx.link.stop();
      await ctx.sleep(300);
      const moved = pose.between(tSent, ctx.clockNow()).find((q) => Math.hypot(q.xCm - mx, q.yCm - my) > thr);
      const run: MotionRun = { i, tSent, latencyMs: moved ? r1(moved.tFrame - tSent) : null, thresholdCm: r1(thr) };
      runs.push(run);
      ctx.sample(run);
      // drive back to the start
      await ctx.link.send(`B,${speed}`);
      await ctx.sleep(driveMs);
      await ctx.link.stop();
      ctx.progress((i + 1) / n);
    }
    return { runs };
  },
  summarize(raw, p) {
    const rs = (raw as { runs: MotionRun[] }).runs;
    const lat = rs.map((r) => r.latencyMs).filter((x): x is number => x !== null);
    const med = median(lat);
    return {
      values: { latencyMedMs: num(med), latencyP95Ms: num(quantile(lat, 0.95)), latencyMinMs: num(min(lat)), latencyMaxMs: num(max(lat)), missed: rs.length - lat.length },
      tables: [{ title: 'Send → first motion', columns: ['run', 'latency ms', 'threshold cm'], rows: rs.map((r) => [r.i + 1, r.latencyMs, r.thresholdCm]) }],
      notes: [`F,${p.speed} → first visible motion: ${num(med)} ms median. Includes the motor's start-up, so it is longer than the LED latency.`],
      profilePatch: Number.isFinite(med) ? { motionLatencyMs: Math.round(med) } : undefined,
    };
  },
};

// ---------------------------------------------------------------- T4.7

type TrajPoint = { t: number; x: number; y: number; h: number; v: number; line?: number };
type T47Data = {
  lapMs: number | null;
  lapSource: 'start/finish crossing' | 'start and finish taps';
  durationMs: number;
  trajectory: TrajPoint[];
  lineCodes: { t: number; code: number; x?: number; y?: number }[];
  pathCm: number;
};

/** Times (ms) at which the path enters a circle around p after having left it. */
function crossings(traj: TrajPoint[], p: { x: number; y: number }, r: number): number[] {
  const out: number[] = [];
  let away = false;
  for (const q of traj) {
    const d = Math.hypot(q.x - p.x, q.y - p.y);
    if (d > r * 2) away = true;
    else if (d < r && away) {
      out.push(q.t);
      away = false;
    }
  }
  return out;
}

export const T4_7: TestDefinition = {
  id: 'T4.7',
  group: 'Camera',
  title: 'Tracked lap',
  setup: 'Tracking on. Put the robot on the start line, tap Start, drive one full lap on the Drive tab, then tap Finish in the banner. Records trajectory, speed profile, lap time and line codes along the path.',
  params: [{ key: 'pollHz', label: '?LINE rate (0 = profile safe rate)', type: 'number', default: 0, unit: 'Hz' }],
  needs: { robot: true, camera: true, tracking: true },
  maxMs: 300_000,
  async run(ctx, p) {
    const pose = needPose(ctx);
    await ctx.ask({ title: 'Tracked lap', text: 'Robot on the start line. Start, then drive one lap on the Drive tab and tap Finish.', buttons: ['Start'] });
    const hz = Number(p.pollHz) || ctx.profile?.safePollHz || 10;
    ctx.poller.set([{ cmd: '?LINE', hz }], 'test:T4.7');
    const lineCodes: T47Data['lineCodes'] = [];
    const off = ctx.link.onReply((e) => {
      if (e.reply.type === 'line') lineCodes.push({ t: e.tRx, code: e.reply.code });
    });
    const t0 = ctx.clockNow();
    const banner = ctx.ui.prompt({ title: 'Lap in progress', text: 'Drive one lap, then Finish.', buttons: ['Finish'], live: true, banner: true });
    try {
      const timer = setInterval(() => ctx.progress(Math.min(0.99, (ctx.clockNow() - t0) / 120_000), `${Math.round((ctx.clockNow() - t0) / 1000)} s`), 1000);
      try {
        await Promise.race([banner.result, new Promise<never>((_, reject) => ctx.token.onAbort((r) => reject(new Error(r))))]);
      } finally {
        clearInterval(timer);
      }
    } finally {
      banner.close();
      off();
      ctx.poller.set([], 'test:T4.7');
    }
    const t1 = ctx.clockNow();
    const poses = pose.between(t0, t1);
    const traj: TrajPoint[] = poses.map((q) => ({ t: Math.round(q.tFrame - t0), x: r1(q.fx), y: r1(q.fy), h: r1(q.fHeadingDeg), v: r1(q.speedCmS) }));
    // Attach line codes to the nearest pose in time.
    let j = 0;
    for (const lc of lineCodes) {
      const tt = lc.t - t0;
      while (j < traj.length - 1 && traj[j + 1].t <= tt) j++;
      const q = traj[j];
      if (q && Math.abs(q.t - tt) < 200) {
        q.line = lc.code;
        Object.assign(lc, { x: q.x, y: q.y });
      }
      lc.t = Math.round(tt);
    }
    let pathCm = 0;
    for (let i = 1; i < traj.length; i++) pathCm += Math.hypot(traj[i].x - traj[i - 1].x, traj[i].y - traj[i - 1].y);
    const sf = ctx.calibration?.landmarks.find((l) => /start|finish/i.test(l.name));
    let lapMs: number | null = null;
    let lapSource: T47Data['lapSource'] = 'start and finish taps';
    if (sf && traj.length > 10) {
      const c = crossings(traj, { x: sf.xCm, y: sf.yCm }, 15);
      if (c.length >= 1) {
        const startNear = Math.hypot(traj[0].x - sf.xCm, traj[0].y - sf.yCm) < 15;
        lapMs = startNear ? c[0] - traj[0].t : c.length >= 2 ? c[1] - c[0] : null;
        if (lapMs !== null) lapSource = 'start/finish crossing';
      }
    }
    if (lapMs === null) lapMs = Math.round(t1 - t0);
    const data: T47Data = { lapMs, lapSource, durationMs: Math.round(t1 - t0), trajectory: traj, lineCodes, pathCm: r1(pathCm) };
    ctx.artifact('trajectory.json', data);
    ctx.sample({ lapMs, points: traj.length, lineCodes: lineCodes.length });
    return data;
  },
  summarize(raw) {
    const d = raw as T47Data;
    const v = d.trajectory.map((q) => q.v);
    const codes = d.lineCodes.map((c) => c.code);
    const share = (c: number) => num((100 * codes.filter((x) => x === c).length) / Math.max(1, codes.length), 0);
    const step = Math.max(1, Math.floor(d.trajectory.length / 30));
    return {
      values: {
        lapS: d.lapMs === null ? null : num(d.lapMs / 1000, 2), lapSource: d.lapSource, pathCm: d.pathCm,
        meanCmS: num(mean(v)), maxCmS: num(max(v)), points: d.trajectory.length, lineSamples: codes.length,
      },
      tables: [
        { title: 'Line codes along the lap (% of samples)', columns: ['0 both white', '1 right black', '2 left black', '3 both black'], rows: [[share(0), share(1), share(2), share(3)]] },
        { title: 'Trajectory (every ~30th point; full data in trajectory.json)', columns: ['t ms', 'x', 'y', 'heading', 'cm/s', 'line'], rows: d.trajectory.filter((_, i) => i % step === 0).map((q) => [q.t, q.x, q.y, q.h, q.v, q.line ?? null]) },
      ],
      notes: [
        `Lap ${d.lapMs === null ? '–' : (d.lapMs / 1000).toFixed(2)} s (${d.lapSource}), ${d.pathCm} cm, mean ${num(mean(v))} cm/s, max ${num(max(v))} cm/s.`,
        d.lapSource === 'start and finish taps' ? 'Add a "start/finish" landmark on the track map to time laps from the line crossing.' : '',
      ].filter(Boolean),
    };
  },
};

export const CAMERA_TESTS = [T4_1, T4_2, T4_3, T4_4, T4_5, T4_6, T4_7];
