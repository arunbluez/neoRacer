// T3.x — motion experiments. Robot on the mat. Measured by camera tracking
// when it is calibrated and running, otherwise by manual entry.

import { alongAndSide, circleFit, medianOrNull, radiusFromChord, speeds, steadySpeed, trackWidthFromArc, trimFromDrift, unwrapDeg } from '../model/fits';
import { cmPerSFor, upsertTable, type RobotProfile } from '../model/profile';
import { mean, median } from '../util/stats';
import { angleDiffDeg } from '../vision/pose';
import type { TrackedPose } from './camera';
import { num, r1 } from './helpers';
import type { PromptField, TestContext, TestDefinition, TestSummary } from './types';

const DEFAULT_TRACK_WIDTH_CM = 9;

/** Camera tracking usable for this test (and with heading when needed). */
function camera(ctx: TestContext, needHeading = false) {
  const pose = ctx.pose;
  if (!pose?.active) return undefined;
  const last = pose.latest();
  if (!last || ctx.clockNow() - last.tFrame > 500) return undefined;
  if (needHeading && last.headingDeg === null) return undefined;
  return pose;
}

/** Mean pose over the last ms before now (robot at rest). */
function restPose(poses: TrackedPose[]): { x: number; y: number; heading: number } | null {
  if (poses.length === 0) return null;
  const hs = poses.map((p) => p.headingDeg ?? p.fHeadingDeg);
  return { x: mean(poses.map((p) => p.fx)), y: mean(poses.map((p) => p.fy)), heading: hs[hs.length - 1] };
}

type Capture = { t0: number; tCmd: number; tStop: number; poses: TrackedPose[]; before: TrackedPose[] };

/** Run a motion with the camera recording: 400 ms of rest before, settle after. */
async function captureMotion(ctx: TestContext, cam: NonNullable<TestContext['pose']>, motion: () => Promise<number>, settleMs = 700): Promise<Capture> {
  const t0 = ctx.clockNow();
  await ctx.sleep(400);
  const before = cam.between(t0, ctx.clockNow());
  const tCmd = ctx.clockNow();
  const tStop = await motion();
  await ctx.sleep(settleMs);
  return { t0, tCmd, tStop, poses: cam.between(tCmd, ctx.clockNow()), before };
}

async function manual(ctx: TestContext, title: string, text: string, fields: PromptField[]): Promise<Record<string, number>> {
  const r = await ctx.ask({ title, text, fields, buttons: ['Save'] });
  const out: Record<string, number> = {};
  for (const f of fields) out[f.key] = Number(r.values[f.key]);
  return out;
}

async function placeRobot(ctx: TestContext, text: string, button = 'Go'): Promise<void> {
  await ctx.ask({ title: 'Place the robot', text, buttons: [button] });
}

// ---------------------------------------------------------------- T3.1

const SEQUENCES: Record<string, { label: string; l: number; r: number; key?: 'lf' | 'lb' | 'rf' | 'rb' }> = {
  'both fwd': { label: 'both wheels forward', l: 1, r: 1 },
  'both back': { label: 'both wheels back', l: -1, r: -1 },
  'left fwd': { label: 'left wheel forward', l: 1, r: 0, key: 'lf' },
  'left back': { label: 'left wheel back', l: -1, r: 0, key: 'lb' },
  'right fwd': { label: 'right wheel forward', l: 0, r: 1, key: 'rf' },
  'right back': { label: 'right wheel back', l: 0, r: -1, key: 'rb' },
};

type DeadbandResult = { seq: string; moving: number | null; by: 'camera' | 'tap' | 'none'; steps: number[] };
type T31Data = { measuredBy: 'camera' | 'manual'; step: number; stepMs: number; results: DeadbandResult[] };

export const T3_1: TestDefinition = {
  id: 'T3.1',
  group: 'Motion',
  title: 'Deadband',
  setup: 'Robot on the mat with a little space around it. Ramps MS from 0 up in steps every 0.8 s until the robot moves (camera, or tap "Moving" as soon as you see it move). Repeats backwards and per wheel.',
  params: [
    { key: 'sequences', label: 'Sequences', type: 'multi', default: Object.keys(SEQUENCES), options: Object.keys(SEQUENCES) },
    { key: 'step', label: 'Step', type: 'number', default: 5 },
    { key: 'stepMs', label: 'Step time', type: 'number', default: 800, unit: 'ms' },
    { key: 'maxCmd', label: 'Give up above', type: 'number', default: 60 },
    { key: 'reactionMs', label: 'Tap reaction allowance', type: 'number', default: 250, unit: 'ms', help: 'A tap counts for the step that was running this long before it.' },
  ],
  needs: { robot: true, motion: true, tracking: true },
  maxMs: 120_000,
  async run(ctx, p) {
    const step = Number(p.step);
    const stepMs = Number(p.stepMs);
    const maxCmd = Number(p.maxCmd);
    const reaction = Number(p.reactionMs);
    const cam = camera(ctx);
    const data: T31Data = { measuredBy: cam ? 'camera' : 'manual', step, stepMs, results: [] };
    ctx.keep(data);
    const seqs = p.sequences as string[];
    for (const [k, name] of seqs.entries()) {
      const seq = SEQUENCES[name];
      await placeRobot(ctx, `${seq.label}: ramps until it moves.${cam ? '' : ' Tap "Moving" the moment you see any wheel turn the robot.'}`, 'Start');
      const handle = cam ? null : ctx.ui.prompt({ title: `${name}: watching`, text: 'Tap as soon as it moves.', buttons: ['Moving'], live: true });
      const res: DeadbandResult = { seq: name, moving: null, by: 'none', steps: [] };
      const stepStarts: { v: number; t: number }[] = [];
      const start = cam ? restPose(cam.between(ctx.clockNow() - 400, ctx.clockNow())) : null;
      try {
        outer: for (let v = 0; v <= maxCmd; v += step) {
          await ctx.link.send(`MS,${seq.l * v},${seq.r * v}`);
          stepStarts.push({ v, t: ctx.clockNow() });
          res.steps.push(v);
          const tStep = ctx.clockNow();
          while (ctx.clockNow() - tStep < stepMs) {
            await ctx.sleep(40);
            if (handle && handle.taps.length > 0) {
              const tTap = handle.taps[0].t - reaction;
              const at = [...stepStarts].reverse().find((s) => s.t <= tTap) ?? stepStarts[0];
              res.moving = at.v;
              res.by = 'tap';
              break outer;
            }
            if (cam && start) {
              const now = cam.latest();
              if (now) {
                const moved = Math.hypot(now.fx - start.x, now.fy - start.y);
                const turned = now.headingDeg !== null ? Math.abs(angleDiffDeg(now.headingDeg, start.heading)) : 0;
                if (moved > 1.0 || turned > 4) {
                  res.moving = v;
                  res.by = 'camera';
                  break outer;
                }
              }
            }
          }
        }
      } finally {
        await ctx.link.stop();
        handle?.close();
      }
      data.results.push(res);
      ctx.sample(res);
      ctx.progress((k + 1) / seqs.length, name);
      await ctx.sleep(500);
    }
    return data;
  },
  summarize(raw) {
    const d = raw as T31Data;
    const by = new Map(d.results.map((r) => [r.seq, r.moving]));
    const pick = (wheel: string, both: string) => by.get(wheel) ?? by.get(both) ?? null;
    const lf = pick('left fwd', 'both fwd');
    const lb = pick('left back', 'both back');
    const rf = pick('right fwd', 'both fwd');
    const rb = pick('right back', 'both back');
    const complete = lf !== null && lb !== null && rf !== null && rb !== null;
    return {
      values: { lf, lb, rf, rb, measuredBy: d.measuredBy },
      tables: [{
        title: `Lowest moving command (step ${d.step}, ${d.stepMs} ms per step)`,
        columns: ['sequence', 'moves at', 'detected by'],
        rows: d.results.map((r) => [r.seq, r.moving, r.by]),
      }],
      notes: [
        complete ? `Deadband: left fwd ${lf}, left back ${lb}, right fwd ${rf}, right back ${rb}.` : 'Some sequences never moved within the limit; the deadband is incomplete.',
        d.measuredBy === 'manual' ? 'Manual taps: values may be one step high.' : 'Detected by camera: > 1 cm or > 4° from rest.',
      ],
      profilePatch: complete ? { deadband: { lf: lf!, lb: lb!, rf: rf!, rb: rb! } } : undefined,
    };
  },
};

// ---------------------------------------------------------------- T3.2 / T3.6

type StraightRun = {
  speed: number;
  durMs: number;
  along: number | null;
  side: number | null;
  avgCmS: number | null;
  steadyCmS: number | null;
  by: 'camera' | 'manual';
  path?: { t: number; x: number; y: number }[];
};
type T32Data = { measuredBy: 'camera' | 'manual'; runs: StraightRun[]; trackWidthCm: number; note?: string; at?: string };

async function straightRun(ctx: TestContext, speed: number, durMs: number): Promise<StraightRun> {
  const cam = camera(ctx, true);
  await placeRobot(ctx, `On a straight, pointing along it, with ${Math.round(speed * durMs / 1000 * 0.6) + 20} cm clear ahead. Drives F,${speed} for ${durMs / 1000} s.${cam ? '' : ' Put a mark at the front of the robot first.'}`);
  if (cam) {
    const c = await captureMotion(ctx, cam, async () => {
      await ctx.link.send(`F,${speed}`);
      await ctx.sleep(durMs);
      await ctx.link.stop();
      return ctx.clockNow();
    });
    const start = restPose(c.before);
    const endP = restPose(c.poses.slice(-5));
    if (!start || !endP) throw new Error('Lost the robot in the camera view.');
    const { along, side } = alongAndSide(start, start.heading, endP);
    const pts = c.poses.map((q) => ({ t: q.tFrame - c.tCmd, x: q.fx, y: q.fy }));
    const steady = steadySpeed(pts, Math.min(500, durMs / 2), durMs);
    return { speed, durMs, along: r1(along), side: r1(side), avgCmS: r1(along / (durMs / 1000)), steadyCmS: steady === null ? null : r1(steady), by: 'camera', path: pts.map((q) => ({ t: Math.round(q.t), x: r1(q.x), y: r1(q.y) })) };
  }
  await ctx.link.send(`F,${speed}`);
  await ctx.sleep(durMs);
  await ctx.link.stop();
  const m = await manual(ctx, `F,${speed}: measure`, 'Measure from the start mark to the front of the robot.', [
    { key: 'along', label: 'Distance along the line', type: 'number', unit: 'cm', hint: 'straight-line distance in the start direction' },
    { key: 'side', label: 'Sideways drift', type: 'number', unit: 'cm', default: 0, hint: '+ right, − left (seen from behind the robot)' },
  ]);
  const along = Number.isFinite(m.along) ? m.along : null;
  return { speed, durMs, along, side: Number.isFinite(m.side) ? m.side : 0, avgCmS: along === null ? null : r1(along / (durMs / 1000)), steadyCmS: null, by: 'manual' };
}

function straightSummary(d: T32Data, profile?: RobotProfile) {
  const trims = d.runs
    .filter((r) => r.along !== null && r.side !== null && r.along > 10)
    .map((r) => trimFromDrift(r.along!, r.side!, d.trackWidthCm));
  const trim = medianOrNull(trims);
  const clampTrim = trim === null ? null : Math.max(-0.2, Math.min(0.2, trim));
  let table = profile?.speedTable;
  for (const r of d.runs) {
    const v = r.steadyCmS ?? r.avgCmS;
    if (v !== null) table = upsertTable(table, { cmd: r.speed, cmPerS: v });
  }
  return { trim: clampTrim, table };
}

export const T3_2: TestDefinition = {
  id: 'T3.2',
  group: 'Motion',
  title: 'Straight speed',
  setup: 'Robot on a long straight. Drives F,s for 1.5 s at each speed; measures distance, speed and sideways drift (camera, or tape measure), and suggests a trim.',
  params: [
    { key: 'speeds', label: 'Speeds', type: 'numbers', default: [30, 50, 70, 100] },
    { key: 'durationS', label: 'Drive time', type: 'number', default: 1.5, unit: 's' },
  ],
  needs: { robot: true, motion: true, tracking: true },
  maxMs: 180_000,
  async run(ctx, p) {
    const speeds = p.speeds as number[];
    const durMs = Number(p.durationS) * 1000;
    const data: T32Data = { measuredBy: camera(ctx, true) ? 'camera' : 'manual', runs: [], trackWidthCm: ctx.profile?.trackWidthCm ?? DEFAULT_TRACK_WIDTH_CM };
    ctx.keep(data);
    for (const [k, s] of speeds.entries()) {
      const r = await straightRun(ctx, s, durMs);
      data.runs.push(r);
      ctx.sample({ ...r, path: undefined });
      ctx.progress((k + 1) / speeds.length, `F,${s}`);
    }
    return data;
  },
  summarize(raw, _p, { profile }) {
    const d = raw as T32Data;
    const { trim, table } = straightSummary(d, profile);
    return {
      values: {
        measuredBy: d.measuredBy, trimSuggestionPct: trim === null ? null : r1(trim * 100),
        ...Object.fromEntries(d.runs.map((r) => [`cmPerS_${r.speed}`, r.steadyCmS ?? r.avgCmS])),
      },
      tables: [{
        title: `F,s for ${(d.runs[0]?.durMs ?? 0) / 1000} s`,
        columns: ['speed', 'distance cm', 'drift cm (+right)', 'avg cm/s', 'steady cm/s', 'by'],
        rows: d.runs.map((r) => [r.speed, r.along, r.side, r.avgCmS, r.steadyCmS, r.by]),
      }],
      notes: [
        trim === null ? 'No trim suggestion (need distance and drift).' : `Suggested trim ${r1(trim * 100)} % on the right wheel (track width ${d.trackWidthCm} cm${profile?.trackWidthCm ? '' : ', assumed'}).`,
        d.measuredBy === 'manual' ? 'Manual: speed = distance / drive time, so it includes start-up and coasting.' : 'Camera: steady speed from the second half of the run.',
      ],
      profilePatch: { ...(table ? { speedTable: table } : {}), ...(trim !== null ? { trim: Math.round(trim * 1000) / 1000 } : {}) },
    };
  },
};

export const T3_6: TestDefinition = {
  id: 'T3.6',
  group: 'Motion',
  title: 'Battery check',
  setup: 'T3.2 at s = 100, labelled with the time and a battery note. Run it a few times over the day to see the speed drop.',
  params: [
    { key: 'battery', label: 'Battery note', type: 'text', default: 'fresh AAA' },
    { key: 'durationS', label: 'Drive time', type: 'number', default: 1.5, unit: 's' },
  ],
  needs: { robot: true, motion: true, tracking: true },
  maxMs: 60_000,
  async run(ctx, p) {
    const durMs = Number(p.durationS) * 1000;
    const data: T32Data = {
      measuredBy: camera(ctx, true) ? 'camera' : 'manual', runs: [], trackWidthCm: ctx.profile?.trackWidthCm ?? DEFAULT_TRACK_WIDTH_CM,
      note: String(p.battery), at: new Date(Date.now()).toISOString(),
    };
    ctx.keep(data);
    data.runs.push(await straightRun(ctx, 100, durMs));
    ctx.sample({ ...data.runs[0], path: undefined });
    return data;
  },
  summarize(raw, _p, { profile }) {
    const d = raw as T32Data;
    const r = d.runs[0];
    const v = r ? r.steadyCmS ?? r.avgCmS : null;
    return {
      values: { at: d.at ?? null, battery: d.note ?? '', cmPerS: v, measuredBy: d.measuredBy },
      tables: [],
      notes: [`F,100: ${v ?? '–'} cm/s with "${d.note}".`],
      profilePatch: v === null ? undefined : { batteryLog: [...(profile?.batteryLog ?? []), { at: d.at ?? '', cmPerS: v, note: d.note }] },
    };
  },
  aggregate(runs) {
    const done = runs.filter((r) => r.testId === 'T3.6' && r.summary);
    if (!done.length) return null;
    return { title: 'Speed at F,100 over the day', columns: ['at', 'battery', 'cm/s'], rows: done.map((r) => [String(r.summary!.values.at), String(r.summary!.values.battery), r.summary!.values.cmPerS as number]) };
  },
};

// ---------------------------------------------------------------- T3.3

type T33Data = {
  measuredBy: 'camera' | 'manual';
  camera?: { steadyCmS: number | null; t90Ms: number | null; stopCm: number | null; stopMs: number | null; profile: { t: number; v: number }[] };
  manual?: { d1: number; d2: number; t1: number; t2: number };
};

export const T3_3: TestDefinition = {
  id: 'T3.3',
  group: 'Motion',
  title: 'Start and stop',
  setup: 'Robot on a long straight. F,100 from rest, then S at full speed. Camera: time to 90 % speed and stopping distance. Manual: two runs (1 s and 2 s) whose difference separates speed from start/stop losses.',
  params: [{ key: 'durationS', label: 'Drive time (camera)', type: 'number', default: 1.5, unit: 's' }],
  needs: { robot: true, motion: true, tracking: true },
  maxMs: 90_000,
  async run(ctx, p) {
    const cam = camera(ctx);
    if (cam) {
      const durMs = Number(p.durationS) * 1000;
      await placeRobot(ctx, 'On a straight with ~1 m clear ahead.');
      let tS = 0;
      const c = await captureMotion(ctx, cam, async () => {
        await ctx.link.send('F,100');
        await ctx.sleep(durMs);
        const rec = await ctx.link.stop();
        tS = rec.tSent ?? ctx.clockNow();
        return tS;
      }, 1200);
      const pts = c.poses.map((q) => ({ t: q.tFrame - c.tCmd, x: q.fx, y: q.fy }));
      const prof = speeds(pts);
      const steady = steadySpeed(pts, durMs * 0.5, durMs);
      const t90 = steady === null ? null : prof.find((s) => s.v >= 0.9 * steady)?.t ?? null;
      const tSrel = tS - c.tCmd;
      const atS = pts.filter((q) => q.t <= tSrel).pop();
      const end = pts[pts.length - 1];
      const stopCm = atS && end ? Math.hypot(end.x - atS.x, end.y - atS.y) : null;
      const stillAt = prof.find((s) => s.t > tSrel && s.v < 2)?.t;
      const data: T33Data = {
        measuredBy: 'camera',
        camera: {
          steadyCmS: steady === null ? null : r1(steady), t90Ms: t90 === null ? null : Math.round(t90), stopCm: stopCm === null ? null : r1(stopCm),
          stopMs: stillAt === undefined ? null : Math.round(stillAt - tSrel), profile: prof.map((s) => ({ t: Math.round(s.t), v: r1(s.v) })),
        },
      };
      ctx.sample({ ...data.camera, profile: undefined });
      return data;
    }
    const runs: number[] = [];
    for (const secs of [1, 2]) {
      await placeRobot(ctx, `Mark the front of the robot. Drives F,100 for ${secs} s.`);
      await ctx.link.send('F,100');
      await ctx.sleep(secs * 1000);
      await ctx.link.stop();
      await ctx.sleep(600);
      const m = await manual(ctx, `${secs} s run`, 'Distance from the mark to the front of the robot, after it stopped.', [
        { key: 'd', label: 'Distance', type: 'number', unit: 'cm' },
      ]);
      runs.push(m.d);
      ctx.sample({ secs, cm: m.d });
    }
    return { measuredBy: 'manual', manual: { d1: runs[0], d2: runs[1], t1: 1, t2: 2 } } satisfies T33Data;
  },
  summarize(raw): TestSummary {
    const d = raw as T33Data;
    if (d.camera) {
      const c = d.camera;
      return {
        values: { measuredBy: 'camera', steadyCmS: c.steadyCmS, t90Ms: c.t90Ms, stopCm: c.stopCm, stopMs: c.stopMs },
        tables: [{ title: 'Speed profile (cm/s)', columns: ['t ms', 'v'], rows: c.profile.filter((_, i) => i % 3 === 0).map((s) => [s.t, s.v]) }],
        notes: [`Reaches 90 % of ${c.steadyCmS} cm/s after ${c.t90Ms} ms (from sending F,100); stops within ${c.stopCm} cm after S.`],
      };
    }
    const m = d.manual!;
    const v = (m.d2 - m.d1) / (m.t2 - m.t1);
    const lost = m.d1 - v * m.t1;
    return {
      values: { measuredBy: 'manual', cmPerS: num(v), startStopLossCm: num(lost) },
      tables: [{ title: 'F,100 runs', columns: ['seconds', 'distance cm'], rows: [[m.t1, m.d1], [m.t2, m.d2]] }],
      notes: [
        `Steady speed ${num(v)} cm/s. A 1 s run covers ${num(lost)} cm ${lost < 0 ? 'less' : 'more'} than speed × time: start-up lag minus coasting after S.`,
      ],
    };
  },
};

// ---------------------------------------------------------------- T3.4

type SpinRun = { side: 'L' | 'R'; speed: number; deg: number | null; by: 'camera' | 'manual' };
type T34Data = { measuredBy: 'camera' | 'manual'; durMs: number; runs: SpinRun[] };

export const T3_4: TestDefinition = {
  id: 'T3.4',
  group: 'Motion',
  title: 'Spin rate',
  setup: 'Robot on the mat with room to spin. L,s and R,s for 1 s at each speed. Camera needs both markers for heading; otherwise enter the angle turned (count full turns).',
  params: [
    { key: 'speeds', label: 'Speeds', type: 'numbers', default: [30, 50, 70, 100] },
    { key: 'durationS', label: 'Spin time', type: 'number', default: 1, unit: 's' },
  ],
  needs: { robot: true, motion: true, tracking: true },
  maxMs: 180_000,
  async run(ctx, p) {
    const durMs = Number(p.durationS) * 1000;
    const cam = camera(ctx, true);
    const data: T34Data = { measuredBy: cam ? 'camera' : 'manual', durMs, runs: [] };
    ctx.keep(data);
    const list = (p.speeds as number[]).flatMap((s) => [{ side: 'L' as const, speed: s }, { side: 'R' as const, speed: s }]);
    for (const [k, { side, speed }] of list.entries()) {
      await placeRobot(ctx, `Spins ${side},${speed} for ${durMs / 1000} s.${cam ? '' : ' Align the robot with a mat edge first.'}`);
      let deg: number | null = null;
      if (cam) {
        const c = await captureMotion(ctx, cam, async () => {
          await ctx.link.send(`${side},${speed}`);
          await ctx.sleep(durMs);
          await ctx.link.stop();
          return ctx.clockNow();
        });
        const hs = [...c.before, ...c.poses].map((q) => q.headingDeg).filter((h): h is number => h !== null);
        const un = unwrapDeg(hs);
        deg = un.length > 2 ? Math.abs(un[un.length - 1] - un[0]) : null;
      } else {
        await ctx.link.send(`${side},${speed}`);
        await ctx.sleep(durMs);
        await ctx.link.stop();
        const m = await manual(ctx, `${side},${speed}: angle`, 'Total angle turned, including full turns (e.g. 1.5 turns = 540°).', [
          { key: 'deg', label: 'Angle', type: 'number', unit: '°' },
        ]);
        deg = Number.isFinite(m.deg) ? Math.abs(m.deg) : null;
      }
      const run: SpinRun = { side, speed, deg: deg === null ? null : r1(deg), by: cam ? 'camera' : 'manual' };
      data.runs.push(run);
      ctx.sample(run);
      ctx.progress((k + 1) / list.length, `${side},${speed}`);
    }
    return data;
  },
  summarize(raw, _p, { profile }) {
    const d = raw as T34Data;
    const speedsList = [...new Set(d.runs.map((r) => r.speed))];
    let table = profile?.spinTable;
    const rows = speedsList.map((s) => {
      const l = d.runs.find((r) => r.speed === s && r.side === 'L')?.deg ?? null;
      const rr = d.runs.find((r) => r.speed === s && r.side === 'R')?.deg ?? null;
      const both = [l, rr].filter((x): x is number => x !== null).map((x) => x / (d.durMs / 1000));
      if (both.length) table = upsertTable(table, { cmd: s, degPerS: r1(mean(both)) });
      return [s, l === null ? null : r1(l / (d.durMs / 1000)), rr === null ? null : r1(rr / (d.durMs / 1000)), both.length ? r1(mean(both)) : null];
    });
    return {
      values: { measuredBy: d.measuredBy, ...Object.fromEntries(rows.map((r) => [`degPerS_${r[0]}`, r[3]])) },
      tables: [{ title: `Spin for ${d.durMs / 1000} s (°/s, includes spin-up)`, columns: ['speed', 'L °/s', 'R °/s', 'mean'], rows }],
      notes: ['Rates include spin-up and coasting; compare L and R for asymmetry.'],
      profilePatch: table ? { spinTable: table } : undefined,
    };
  },
};

// ---------------------------------------------------------------- T3.5

type ArcRun = { l: number; r: number; radiusCm: number | null; speedCmS: number | null; by: 'camera' | 'manual'; widthCm: number | null };
type T35Data = { measuredBy: 'camera' | 'manual'; durMs: number; runs: ArcRun[] };

export const T3_5: TestDefinition = {
  id: 'T3.5',
  group: 'Motion',
  title: 'Arcs',
  setup: 'Robot on open mat. MS,l,r for 1.5 s over several pairs: radius and speed per pair, and the effective track width (needs the T3.2 speed table).',
  params: [
    { key: 'pairs', label: 'Pairs l/r', type: 'text', default: '100/50, 100/0, 70/35, 50/25' },
    { key: 'durationS', label: 'Drive time', type: 'number', default: 1.5, unit: 's' },
  ],
  needs: { robot: true, motion: true, tracking: true },
  maxMs: 180_000,
  async run(ctx, p) {
    const durMs = Number(p.durationS) * 1000;
    const pairs = String(p.pairs).split(',').map((s) => s.trim().split('/').map(Number)).filter((x) => x.length === 2 && x.every(Number.isFinite));
    const cam = camera(ctx);
    const data: T35Data = { measuredBy: cam ? 'camera' : 'manual', durMs, runs: [] };
    ctx.keep(data);
    for (const [k, [l, r]] of pairs.entries()) {
      await placeRobot(ctx, `Drives MS,${l},${r} for ${durMs / 1000} s (curves ${l > r ? 'right' : 'left'}).${cam ? '' : ' Mark the start position and heading first.'}`);
      let radius: number | null = null;
      let speed: number | null = null;
      if (cam) {
        const c = await captureMotion(ctx, cam, async () => {
          await ctx.link.send(`MS,${l},${r}`);
          await ctx.sleep(durMs);
          await ctx.link.stop();
          return ctx.clockNow();
        });
        const pts = c.poses.map((q) => ({ t: q.tFrame - c.tCmd, x: q.fx, y: q.fy }));
        const steadyPts = pts.filter((q) => q.t > durMs * 0.3 && q.t <= durMs);
        const fit = circleFit(steadyPts);
        radius = fit ? fit.r : null;
        speed = steadySpeed(pts, durMs * 0.3, durMs);
      } else {
        await ctx.link.send(`MS,${l},${r}`);
        await ctx.sleep(durMs);
        await ctx.link.stop();
        const m = await manual(ctx, `MS,${l},${r}: measure`, 'Straight-line distance from start to end position (chord), and how much the heading changed.', [
          { key: 'chord', label: 'Chord', type: 'number', unit: 'cm' },
          { key: 'deg', label: 'Heading change', type: 'number', unit: '°' },
        ]);
        radius = radiusFromChord(m.chord, m.deg);
        speed = radius === null ? null : (radius * (Math.abs(m.deg) * Math.PI / 180)) / (durMs / 1000);
      }
      const vl = ctx.profile ? cmPerSFor(ctx.profile, l) : undefined;
      const vr = ctx.profile ? cmPerSFor(ctx.profile, r) : undefined;
      const width = vl !== undefined && vr !== undefined && speed !== null && radius !== null ? trackWidthFromArc(vl, vr, speed, radius) : null;
      const run: ArcRun = { l, r, radiusCm: radius === null ? null : r1(radius), speedCmS: speed === null ? null : r1(speed), by: cam ? 'camera' : 'manual', widthCm: width === null ? null : r1(width) };
      data.runs.push(run);
      ctx.sample(run);
      ctx.progress((k + 1) / pairs.length);
    }
    return data;
  },
  summarize(raw) {
    const d = raw as T35Data;
    const widths = d.runs.map((r) => r.widthCm).filter((w): w is number => w !== null && w > 2 && w < 30);
    const w = widths.length ? median(widths) : null;
    return {
      values: { measuredBy: d.measuredBy, trackWidthCm: w === null ? null : r1(w) },
      tables: [{ title: `Arcs, ${d.durMs / 1000} s`, columns: ['l', 'r', 'radius cm', 'speed cm/s', 'track width cm', 'by'], rows: d.runs.map((r) => [r.l, r.r, r.radiusCm, r.speedCmS, r.widthCm, r.by]) }],
      notes: [w === null ? 'No track width: needs the speed table from T3.2 and measurable arcs (100/0 pivots on a wheel).' : `Effective track width ${r1(w)} cm (median over pairs).`],
      profilePatch: w === null ? undefined : { trackWidthCm: r1(w) },
    };
  },
};

export const MOTION_TESTS = [T3_1, T3_2, T3_3, T3_4, T3_5, T3_6];
