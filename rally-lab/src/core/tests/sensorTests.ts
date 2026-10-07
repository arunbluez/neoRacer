// T2.x — sensor experiments. Robot on the mat.

import { cmPerSFor } from '../model/profile';
import { circularMeanDeg, circularStdDeg, histogram, max, mean, median, mode, quantile, std } from '../util/stats';
import { angleDiffDeg } from '../vision/pose';
import { LINE_NAMES, num, r1 } from './helpers';
import type { ResultTable, TestDefinition, TestRun } from './types';

export const SURFACES = [
  'lane blue end', 'lane purple', 'lane pink end', 'white border', 'black background', 'checkered white',
  'checkered black', 'start line', 'bridge deck', 'floor outside the mat', 'custom',
];

// ---------------------------------------------------------------- T2.1

type T21Data = { surface: string; note: string; codes: number[]; lost: number; rtts: number[] };

export const T2_1: TestDefinition = {
  id: 'T2.1',
  group: 'Sensors',
  title: 'Surface survey',
  setup: 'Pick a surface, place the robot so both line sensors (under the front, by the ball caster) sit on it, then Start. Takes 20 × ?LINE. Repeat for every surface on the track.',
  params: [
    { key: 'surface', label: 'Surface', type: 'select', default: SURFACES[0], options: SURFACES },
    { key: 'custom', label: 'Custom label', type: 'text', default: '' },
    { key: 'samples', label: 'Samples', type: 'number', default: 20 },
    { key: 'note', label: 'Note', type: 'text', default: '' },
  ],
  needs: { robot: true },
  maxMs: 60_000,
  async run(ctx, p) {
    const surface = p.surface === 'custom' && String(p.custom).trim() ? String(p.custom).trim() : String(p.surface);
    const n = Number(p.samples);
    const data: T21Data = { surface, note: String(p.note), codes: [], lost: 0, rtts: [] };
    ctx.keep(data);
    for (let i = 0; i < n; i++) {
      const r = await ctx.link.query('?LINE');
      if (r.status === 'ok' && r.reply.type === 'line') {
        data.codes.push(r.reply.code);
        data.rtts.push(r1(r.rttMs));
        ctx.sample({ i, code: r.reply.code });
      } else data.lost++;
      ctx.progress((i + 1) / n, `${i + 1}/${n}`);
      await ctx.sleep(40);
    }
    return data;
  },
  summarize(raw) {
    const d = raw as T21Data;
    const h = histogram(d.codes);
    const m = mode(d.codes);
    return {
      values: {
        surface: d.surface, majorityCode: m.value ?? null, majority: m.value === undefined ? null : LINE_NAMES[m.value],
        sharePct: num(m.share * 100, 0), samples: d.codes.length, lost: d.lost,
      },
      tables: [{
        title: `Line codes on "${d.surface}"`,
        columns: ['code', 'meaning', 'count'],
        rows: [0, 1, 2, 3].map((c) => [c, LINE_NAMES[c], h[String(c)] ?? 0]),
      }],
      notes: [
        `"${d.surface}" reads ${m.value === undefined ? '–' : `${m.value} (${LINE_NAMES[m.value]})`} in ${num(m.share * 100, 0)} % of ${d.codes.length} samples.${d.note ? ` Note: ${d.note}` : ''}`,
      ],
      profilePatch: m.value === undefined ? undefined : {
        surfaces: { [d.surface]: { code: m.value, share: num(m.share, 2) ?? 0, n: d.codes.length } },
      },
    };
  },
  aggregate(runs: TestRun[]): ResultTable | null {
    const done = runs.filter((r) => r.testId === 'T2.1' && r.data);
    if (done.length === 0) return null;
    const by = new Map<string, number[]>();
    for (const r of done) {
      const d = r.data as T21Data;
      by.set(d.surface, [...(by.get(d.surface) ?? []), ...d.codes]);
    }
    return {
      title: 'Surface survey across labels',
      columns: ['surface', 'n', '0 white', '1 R black', '2 L black', '3 both black', 'majority', 'share %'],
      rows: [...by.entries()].map(([s, codes]) => {
        const h = histogram(codes);
        const m = mode(codes);
        return [s, codes.length, h['0'] ?? 0, h['1'] ?? 0, h['2'] ?? 0, h['3'] ?? 0, m.value ?? null, num(m.share * 100, 0)];
      }),
    };
  },
};

// ---------------------------------------------------------------- T2.2

type Segment = { code: number; tStartMs: number; durMs: number; cm?: number };
type T22Data = { speed: number; samples: { t: number; code: number }[]; segments: Segment[]; cmPerS?: number; speedSource: string };

export function segmentCodes(samples: { t: number; code: number }[]): Segment[] {
  const segs: Segment[] = [];
  for (const s of samples) {
    const last = segs[segs.length - 1];
    if (last && last.code === s.code) continue;
    if (last) last.durMs = s.t - last.tStartMs;
    segs.push({ code: s.code, tStartMs: s.t, durMs: 0 });
  }
  const last = segs[segs.length - 1];
  if (last && samples.length) last.durMs = samples[samples.length - 1].t - last.tStartMs;
  return segs;
}

export const T2_2: TestDefinition = {
  id: 'T2.2',
  group: 'Sensors',
  title: 'Lane crossing',
  setup: 'Place the robot on the black background facing straight across the lane, about 10 cm before it, with room to drive out the other side. Drives at MS,20,20 while polling ?LINE as fast as the link allows, then stops.',
  params: [
    { key: 'speed', label: 'Speed', type: 'number', default: 20 },
    { key: 'durationS', label: 'Drive for', type: 'number', default: 3, unit: 's' },
  ],
  needs: { robot: true, motion: true },
  maxMs: 30_000,
  async run(ctx, p) {
    const speed = Number(p.speed);
    const durMs = Number(p.durationS) * 1000;
    const samples: { t: number; code: number }[] = [];
    const data: T22Data = { speed, samples, segments: [], speedSource: 'none' };
    ctx.keep(data);
    await ctx.ask({ title: 'Ready?', text: 'Robot on black, facing across the lane.', buttons: ['Start'] });
    const t0 = ctx.clockNow();
    const poses0 = ctx.pose?.active ? ctx.pose.latest() : undefined;
    await ctx.link.send(`MS,${speed},${speed}`);
    while (ctx.clockNow() - t0 < durMs) {
      const r = await ctx.link.query('?LINE');
      if (r.status === 'ok' && r.reply.type === 'line') {
        samples.push({ t: r1(r.tRx - t0), code: r.reply.code });
      }
      ctx.progress((ctx.clockNow() - t0) / durMs);
    }
    await ctx.link.stop();
    data.segments = segmentCodes(samples);
    if (ctx.pose?.active && poses0) {
      const track = ctx.pose.between(t0, ctx.clockNow());
      if (track.length > 2) {
        const dist = Math.hypot(track[track.length - 1].fx - track[0].fx, track[track.length - 1].fy - track[0].fy);
        data.cmPerS = dist / ((track[track.length - 1].tFrame - track[0].tFrame) / 1000);
        data.speedSource = 'camera';
      }
    }
    if (data.cmPerS === undefined) {
      const v = ctx.profile ? cmPerSFor(ctx.profile, speed) : undefined;
      if (v !== undefined) {
        data.cmPerS = v;
        data.speedSource = 'speed table';
      }
    }
    if (data.cmPerS !== undefined) for (const s of data.segments) s.cm = r1((s.durMs / 1000) * data.cmPerS);
    for (const s of data.segments) ctx.sample(s);
    return data;
  },
  summarize(raw) {
    const d = raw as T22Data;
    const gaps = d.samples.slice(1).map((s, i) => s.t - d.samples[i].t);
    return {
      values: {
        speed: d.speed, samples: d.samples.length, sampleIntervalMs: num(median(gaps)), segments: d.segments.length,
        cmPerS: d.cmPerS === undefined ? null : r1(d.cmPerS), speedSource: d.speedSource,
      },
      tables: [{
        title: 'Code sequence',
        columns: ['code', 'meaning', 'start ms', 'duration ms', 'width cm'],
        rows: d.segments.map((s) => [s.code, LINE_NAMES[s.code], s.tStartMs, r1(s.durMs), s.cm ?? null]),
      }],
      notes: [
        `Sampled every ~${num(median(gaps), 0)} ms, so transitions are only known to that resolution.`,
        d.cmPerS === undefined ? 'No speed known (no tracking, no speed table): widths in ms only.' : `Widths in cm use ${r1(d.cmPerS)} cm/s from the ${d.speedSource}.`,
      ],
    };
  },
};

// ---------------------------------------------------------------- T2.3

export const ULTRASONIC_SCENES = ['open track', 'cone at 10 cm', 'cone at 30 cm', 'bridge', 'hand', 'custom'];
type T23Data = { scene: string; values: number[]; rtts: number[]; lost: number };

export const T2_3: TestDefinition = {
  id: 'T2.3',
  group: 'Sensors',
  title: 'Ultrasonic',
  setup: 'Set up the scene in front of the robot (e.g. a cone 10 cm ahead) and Start. Takes 20 × ?DIST.',
  params: [
    { key: 'scene', label: 'Scene', type: 'select', default: ULTRASONIC_SCENES[0], options: ULTRASONIC_SCENES },
    { key: 'custom', label: 'Custom label', type: 'text', default: '' },
    { key: 'samples', label: 'Samples', type: 'number', default: 20 },
  ],
  needs: { robot: true },
  maxMs: 60_000,
  async run(ctx, p) {
    const scene = p.scene === 'custom' && String(p.custom).trim() ? String(p.custom).trim() : String(p.scene);
    const n = Number(p.samples);
    const data: T23Data = { scene, values: [], rtts: [], lost: 0 };
    ctx.keep(data);
    for (let i = 0; i < n; i++) {
      const r = await ctx.link.query('?DIST', { replyTimeoutMs: 1000 });
      if (r.status === 'ok' && r.reply.type === 'dist') {
        data.values.push(r.reply.cm);
        data.rtts.push(r1(r.rttMs));
        ctx.sample({ i, cm: r.reply.cm, rtt: r1(r.rttMs) });
      } else data.lost++;
      ctx.progress((i + 1) / n);
      await ctx.sleep(50);
    }
    return data;
  },
  summarize(raw) {
    const d = raw as T23Data;
    const echoes = d.values.filter((v) => v > 0);
    return {
      values: {
        scene: d.scene, meanCm: num(mean(echoes)), medianCm: num(median(echoes)), stdCm: num(std(echoes), 2),
        minCm: num(Math.min(...echoes)), maxCm: num(max(echoes)), noEcho: d.values.length - echoes.length,
        lost: d.lost, replyMedMs: num(median(d.rtts)), replyP95Ms: num(quantile(d.rtts, 0.95)),
      },
      tables: [{ title: `?DIST on "${d.scene}"`, columns: ['readings (cm)'], rows: [[d.values.join(' ')]] }],
      notes: [
        `${d.scene}: ${num(median(echoes))} cm median, spread ±${num(std(echoes), 1)} cm; ${d.values.length - echoes.length} readings of 0 (no echo); reply ${num(median(d.rtts))} ms median.`,
      ],
    };
  },
  aggregate(runs) {
    const done = runs.filter((r) => r.testId === 'T2.3' && r.summary);
    if (!done.length) return null;
    return {
      title: 'Ultrasonic per scene',
      columns: ['scene', 'median cm', 'std cm', 'no echo', 'reply ms'],
      rows: done.map((r) => {
        const v = r.summary!.values;
        return [String(v.scene), v.medianCm as number, v.stdCm as number, v.noEcho as number, v.replyMedMs as number];
      }),
    };
  },
};

// ---------------------------------------------------------------- T2.4

type AccelSample = { t: number; x: number; y: number; z: number };
type T24Data = { phases: { name: string; samples: AccelSample[]; durMs: number }[] };

async function pollAccel(ctx: Parameters<TestDefinition['run']>[0], name: string, durMs: number, during?: () => Promise<void>): Promise<T24Data['phases'][number]> {
  const samples: AccelSample[] = [];
  const t0 = ctx.clockNow();
  const bg = during?.();
  while (ctx.clockNow() - t0 < durMs) {
    const r = await ctx.link.query('?ACCEL');
    if (r.status === 'ok' && r.reply.type === 'accel') {
      samples.push({ t: r1(r.tRx - t0), x: r.reply.x, y: r.reply.y, z: r.reply.z });
    }
  }
  await bg;
  ctx.sample({ phase: name, n: samples.length });
  return { name, samples, durMs };
}

const mag = (s: AccelSample) => Math.hypot(s.x, s.y, s.z);

export const T2_4: TestDefinition = {
  id: 'T2.4',
  group: 'Sensors',
  title: 'Accelerometer',
  setup: 'Robot on the mat with ~1 m of clear space ahead. Four phases: still for 5 s, F,100 start, spin L,60, and a light bump by hand. Polls ?ACCEL as fast as replies come.',
  params: [
    { key: 'stillS', label: 'Still phase', type: 'number', default: 5, unit: 's' },
    { key: 'moveS', label: 'Drive/spin phase', type: 'number', default: 1.2, unit: 's' },
  ],
  needs: { robot: true, motion: true },
  maxMs: 60_000,
  async run(ctx, p) {
    const data: T24Data = { phases: [] };
    ctx.keep(data);
    const moveMs = Number(p.moveS) * 1000;
    await ctx.ask({ title: 'Still', text: 'Leave the robot still on the mat.', buttons: ['Start'] });
    data.phases.push(await pollAccel(ctx, 'still', Number(p.stillS) * 1000));
    ctx.progress(0.3, 'F,100');
    await ctx.ask({ title: 'Forward start', text: 'Clear space ahead: the robot drives F,100 for a moment.', buttons: ['Go'] });
    data.phases.push(await pollAccel(ctx, 'F,100 start', moveMs + 600, async () => {
      await ctx.sleep(300);
      await ctx.link.send('F,100');
      await ctx.sleep(moveMs);
      await ctx.link.stop();
    }));
    ctx.progress(0.55, 'spin');
    await ctx.ask({ title: 'Spin', text: 'The robot spins L,60 in place.', buttons: ['Go'] });
    data.phases.push(await pollAccel(ctx, 'spin L,60', moveMs + 600, async () => {
      await ctx.sleep(300);
      await ctx.link.send('L,60');
      await ctx.sleep(moveMs);
      await ctx.link.stop();
    }));
    ctx.progress(0.8, 'bump');
    await ctx.ask({ title: 'Bump', text: 'After Go, give the robot one light bump by hand within 3 s.', buttons: ['Go'] });
    data.phases.push(await pollAccel(ctx, 'bump', 3000));
    return data;
  },
  summarize(raw) {
    const d = raw as T24Data;
    const still = d.phases.find((p) => p.name === 'still');
    const g0 = still ? median(still.samples.map(mag)) : 1024;
    const rows = d.phases.map((p) => {
      const n = p.samples.length;
      const dev = p.samples.map((s) => Math.abs(mag(s) - g0));
      const peakXY = Math.max(0, ...p.samples.map((s) => Math.hypot(s.x - (still ? median(still.samples.map((q) => q.x)) : 0), s.y - (still ? median(still.samples.map((q) => q.y)) : 0))));
      return [
        p.name, n, num(n / (p.durMs / 1000)),
        num(std(p.samples.map((s) => s.x))), num(std(p.samples.map((s) => s.y))), num(std(p.samples.map((s) => s.z))),
        num(max(dev) / 1000, 3), num(peakXY / 1000, 3),
      ];
    });
    const rate = still ? still.samples.length / (still.durMs / 1000) : NaN;
    return {
      values: {
        sampleHz: num(rate), stillNoiseX: rows[0]?.[3] ?? null, stillNoiseY: rows[0]?.[4] ?? null, stillNoiseZ: rows[0]?.[5] ?? null,
        gMilli: num(g0, 0),
      },
      tables: [{
        title: 'Accelerometer per phase (mg; peaks in g)',
        columns: ['phase', 'n', 'Hz', 'std x', 'std y', 'std z', 'peak |a|−g', 'peak xy'],
        rows,
      }],
      notes: [`Sample rate achieved with sequential ?ACCEL queries: ${num(rate)} Hz. Still magnitude ${num(g0, 0)} mg.`],
    };
  },
};

// ---------------------------------------------------------------- T2.5

export const LIGHT_SCENES = ['open track', 'under the bridge', 'headlights on', 'headlights off'];
type T25Data = { scene: string; light: number[]; temp: number[] };

export const T2_5: TestDefinition = {
  id: 'T2.5',
  group: 'Sensors',
  title: 'Light and temperature',
  setup: 'Place the robot in the scene and Start. Takes 10 × ?LIGHT and 5 × ?TEMP. "Headlights on/off" switches the headlights for you.',
  params: [{ key: 'scene', label: 'Scene', type: 'select', default: LIGHT_SCENES[0], options: LIGHT_SCENES }],
  needs: { robot: true },
  maxMs: 30_000,
  async run(ctx, p) {
    const scene = String(p.scene);
    const data: T25Data = { scene, light: [], temp: [] };
    ctx.keep(data);
    if (scene === 'headlights on') await ctx.link.send('HL,255,255,255');
    if (scene === 'headlights off') await ctx.link.send('HO');
    await ctx.sleep(400);
    for (let i = 0; i < 10; i++) {
      const r = await ctx.link.query('?LIGHT');
      if (r.status === 'ok' && r.reply.type === 'light') data.light.push(r.reply.level);
      ctx.progress((i + 1) / 15);
    }
    for (let i = 0; i < 5; i++) {
      const r = await ctx.link.query('?TEMP');
      if (r.status === 'ok' && r.reply.type === 'temp') data.temp.push(r.reply.celsius);
      ctx.progress((11 + i) / 15);
    }
    if (scene === 'headlights on') await ctx.link.send('HO');
    ctx.sample({ scene, light: data.light, temp: data.temp });
    return data;
  },
  summarize(raw) {
    const d = raw as T25Data;
    return {
      values: { scene: d.scene, lightMean: num(mean(d.light)), lightStd: num(std(d.light), 2), tempC: num(median(d.temp)) },
      tables: [{ title: d.scene, columns: ['light readings', 'temp readings'], rows: [[d.light.join(' '), d.temp.join(' ')]] }],
      notes: [`${d.scene}: light ${num(mean(d.light))} (±${num(std(d.light), 1)}), ${num(median(d.temp))} °C.`],
    };
  },
  aggregate(runs) {
    const done = runs.filter((r) => r.testId === 'T2.5' && r.summary);
    if (!done.length) return null;
    return {
      title: 'Light and temperature per scene',
      columns: ['scene', 'light', 'light std', '°C'],
      rows: done.map((r) => [String(r.summary!.values.scene), r.summary!.values.lightMean as number, r.summary!.values.lightStd as number, r.summary!.values.tempC as number]),
    };
  },
};

// ---------------------------------------------------------------- T2.6

type T26Data = { poses: { label: string; headings: number[] }[]; motorOn: number[]; motorOff: number[] };

export const T2_6: TestDefinition = {
  id: 'T2.6',
  group: 'Sensors',
  title: 'Compass (guarded)',
  setup: 'Only with a calibrated compass (an uncalibrated micro:bit blocks on ?COMPASS until someone tilts it to fill the screen). Four still headings 90° apart, then motors on and off with the wheels lifted.',
  params: [{ key: 'samples', label: 'Samples per pose', type: 'number', default: 10 }],
  needs: { robot: true, wheelsUp: true },
  maxMs: 90_000,
  async run(ctx, p) {
    if (!ctx.profile?.compassCalibrated) {
      throw new Error('The profile does not mark the compass calibrated. Calibrate it once (tilt to fill the screen), then tick "compass calibrated" in Data → Profiles.');
    }
    const n = Number(p.samples);
    const data: T26Data = { poses: [], motorOn: [], motorOff: [] };
    ctx.keep(data);
    const read = async (out: number[]) => {
      for (let i = 0; i < n; i++) {
        const r = await ctx.link.query('?COMPASS', { replyTimeoutMs: 1500 });
        if (r.status === 'ok' && r.reply.type === 'compass') out.push(r.reply.degrees);
        else if (r.status === 'lost') throw new Error('?COMPASS did not answer: the micro:bit may be waiting for calibration.');
      }
    };
    for (const [k, label] of ['0°', '90°', '180°', '270°'].entries()) {
      await ctx.ask({ title: `Heading ${label}`, text: `Point the robot ${k === 0 ? 'along a reference edge of the mat' : `${label} clockwise from the first pose`}, keep it still.`, buttons: ['Measure'] });
      const headings: number[] = [];
      await read(headings);
      data.poses.push({ label, headings });
      ctx.sample({ pose: label, headings });
      ctx.progress((k + 1) / 6);
    }
    await ctx.ask({ title: 'Motors', text: 'Lift the wheels (robot on a stand), keep its heading fixed.', buttons: ['Measure'] });
    await read(data.motorOff);
    await ctx.link.send('MS,60,60');
    await ctx.sleep(400);
    await read(data.motorOn);
    await ctx.link.stop();
    ctx.progress(1);
    return data;
  },
  summarize(raw) {
    const d = raw as T26Data;
    const rows = d.poses.map((pz, i) => {
      const m = circularMeanDeg(pz.headings);
      const prev = i > 0 ? circularMeanDeg(d.poses[i - 1].headings) : null;
      return [pz.label, num(m), num(circularStdDeg(pz.headings), 2), prev === null ? null : num(angleDiffDeg(m, prev))];
    });
    const off = circularMeanDeg(d.motorOff);
    const on = circularMeanDeg(d.motorOn);
    return {
      values: { motorOffsetDeg: d.motorOn.length && d.motorOff.length ? num(angleDiffDeg(on, off)) : null },
      tables: [{ title: 'Compass per pose', columns: ['pose', 'mean °', 'std °', 'step from previous °'], rows }],
      notes: [`Motors on shift the heading by ${num(angleDiffDeg(on, off))}° (on ${num(on)}°, off ${num(off)}°).`],
    };
  },
};

export const SENSOR_TESTS = [T2_1, T2_2, T2_3, T2_4, T2_5, T2_6];
