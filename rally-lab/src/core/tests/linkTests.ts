// T1.x — link experiments. Robot on a stand, wheels free.

import { blockMs, DEFAULT_BLOCKING } from '../link/blocking';
import type { QueryResult } from '../link/link';
import type { MatchResult } from '../link/matcher';
import { isQuery } from '../protocol/commands';
import { mean, median, quantile, summarize } from '../util/stats';
import { baselineRtt, collectRaw, every, num, r0, r1, rttTable } from './helpers';
import type { Params, TestDefinition, TestSummary } from './types';

type PingSample = { i: number; status: string; rtt?: number; rttEnq?: number };

// ---------------------------------------------------------------- T1.1

type T11Data = { samples: PingSample[]; timeoutMs: number };

export const T1_1: TestDefinition = {
  id: 'T1.1',
  group: 'Link',
  title: 'Ping baseline',
  setup: 'Robot on a stand (or anywhere), connected. Sends PING repeatedly; the next one goes out when the reply arrives or times out.',
  params: [
    { key: 'count', label: 'Pings', type: 'number', default: 200, min: 10, max: 1000 },
    { key: 'timeoutMs', label: 'Reply timeout', type: 'number', default: 500, unit: 'ms' },
  ],
  needs: { robot: true },
  maxMs: 60_000,
  async run(ctx, p) {
    const count = Number(p.count);
    const timeoutMs = Number(p.timeoutMs);
    const data: T11Data = { samples: [], timeoutMs };
    ctx.keep(data);
    for (let i = 0; i < count; i++) {
      const r = await ctx.link.query('PING', { replyTimeoutMs: timeoutMs });
      const s: PingSample = r.status === 'ok'
        ? { i, status: 'ok', rtt: r1(r.rttMs), rttEnq: r1(r.rttEnqMs) }
        : { i, status: r.status };
      data.samples.push(s);
      ctx.sample(s);
      ctx.progress((i + 1) / count, `${i + 1}/${count}`);
    }
    return data;
  },
  summarize(raw) {
    const d = raw as T11Data;
    const rtts = d.samples.filter((s) => s.status === 'ok').map((s) => s.rtt!);
    const lost = d.samples.length - rtts.length;
    const s = summarize(rtts);
    return {
      values: {
        sent: d.samples.length,
        rttMin: num(s.min), rttMedian: num(s.median), rttP95: num(s.p95), rttMax: num(s.max),
        lost, lossPct: num((100 * lost) / Math.max(1, d.samples.length)),
      },
      tables: [rttTable('PING round-trip (ms)', rtts)],
      notes: [
        `Median round trip ${num(s.median)} ms, p95 ${num(s.p95)} ms over ${d.samples.length} pings; ${lost} lost.`,
      ],
    };
  },
};

// ---------------------------------------------------------------- T1.2

type RateStep = {
  rateHz: number;
  sent: number;
  skipped: number;
  written: number;
  ok: number;
  lost: number;
  rtts: number[];
  rttEnqs: number[];
  durS: number;
};
type T12Data = { cmd: string; baselineMs: number; baselineSource: string; steps: RateStep[] };

export const T1_2: TestDefinition = {
  id: 'T1.2',
  group: 'Link',
  title: 'Poll rate sweep',
  setup: 'Robot connected. Sends ?LINE at each rate without waiting for replies, 5 s per rate, and measures replies, round trip and loss.',
  params: [
    { key: 'rates', label: 'Rates', type: 'numbers', default: [5, 10, 20, 30, 50, 80], unit: 'Hz' },
    { key: 'stepS', label: 'Seconds per rate', type: 'number', default: 5 },
    { key: 'cmd', label: 'Query', type: 'select', default: '?LINE', options: ['?LINE', 'PING', '?ACCEL', '?DIST'] },
    { key: 'gapMs', label: 'Scheduler gap during test', type: 'number', default: 0, unit: 'ms', help: '0 lets the GATT write rate be the limit' },
  ],
  needs: { robot: true },
  maxMs: 60_000,
  async run(ctx, p) {
    const rates = (p.rates as number[]).filter((r) => r > 0);
    const stepMs = Number(p.stepS) * 1000;
    const cmd = String(p.cmd);
    const base = await baselineRtt(ctx);
    ctx.link.scheduler.setConfig({ minWriteGapMs: Number(p.gapMs) });
    const data: T12Data = { cmd, baselineMs: r1(base.median), baselineSource: base.source, steps: [] };
    ctx.keep(data);
    for (const [k, rate] of rates.entries()) {
      const step: RateStep = { rateHz: rate, sent: 0, skipped: 0, written: 0, ok: 0, lost: 0, rtts: [], rttEnqs: [], durS: stepMs / 1000 };
      const waits: Promise<void>[] = [];
      await every(ctx, 1000 / rate, stepMs, () => {
        // Don't let an unbounded backlog build up; count it instead.
        if (ctx.link.scheduler.depths().raw > 20) {
          step.skipped++;
          return;
        }
        step.sent++;
        waits.push(ctx.link.query(cmd, { ch: 'raw' }).then((r) => {
          if (r.rec.status === 'done') step.written++;
          if (r.status === 'ok') {
            step.ok++;
            step.rtts.push(r1(r.rttMs));
            step.rttEnqs.push(r1(r.rttEnqMs));
          } else if (r.status === 'lost') step.lost++;
        }));
        ctx.progress((k + (step.sent + step.skipped) / (rate * stepMs / 1000)) / rates.length, `${rate} Hz`);
      });
      await Promise.all(waits);
      data.steps.push(step);
      ctx.sample({ rateHz: rate, sent: step.sent, ok: step.ok, lost: step.lost, skipped: step.skipped, rttMed: num(median(step.rtts)) });
      await ctx.sleep(300);
    }
    return data;
  },
  summarize(raw) {
    const d = raw as T12Data;
    const limit = 2 * d.baselineMs;
    const rows = d.steps.map((s) => {
      const p95 = quantile(s.rtts, 0.95);
      return {
        s,
        p95,
        ok: Number.isFinite(p95) && p95 < limit && s.lost / Math.max(1, s.sent) < 0.02 && s.skipped === 0,
      };
    });
    const safe = rows.filter((r) => r.ok).map((r) => r.s.rateHz);
    const safeHz = safe.length ? Math.max(...safe) : null;
    return {
      values: { baselineMs: d.baselineMs, p95LimitMs: r1(limit), safePollHz: safeHz },
      tables: [{
        title: `${d.cmd} sent without waiting`,
        columns: ['rate Hz', 'sent/s', 'replies/s', 'rtt med', 'rtt p95', 'rtt+queue med', 'loss %', 'skipped', 'ok'],
        rows: rows.map(({ s, p95, ok }) => [
          s.rateHz, num(s.written / s.durS), num(s.ok / s.durS), num(median(s.rtts)), num(p95),
          num(median(s.rttEnqs)), num((100 * s.lost) / Math.max(1, s.sent)), s.skipped, ok ? 'yes' : 'no',
        ]),
      }],
      notes: [
        safeHz === null
          ? `No rate kept p95 under 2× the baseline (${r1(limit)} ms).`
          : `Highest rate with p95 under 2× baseline (${r1(limit)} ms), <2 % loss and no backlog: ${safeHz} Hz.`,
        `Baseline ${d.baselineMs} ms from ${d.baselineSource}.`,
      ],
      profilePatch: safeHz === null ? undefined : { safePollHz: safeHz },
    };
  },
};

// ---------------------------------------------------------------- T1.3

type GapStep = {
  gapMs: number;
  targetHz: number;
  durS: number;
  writesDone: number;
  writeErrors: number;
  coalesced: number;
  pings: number;
  pingLost: number;
  rtts: number[];
  rttEnqs: number[];
};
type T13Data = { baselineMs: number; baselineSource: string; steps: GapStep[] };

export const T1_3: TestDefinition = {
  id: 'T1.3',
  group: 'Link',
  title: 'Write gap sweep',
  setup: 'Robot on a stand, wheels free. Sends MS,0,0 at each gap through the motor channel, with a PING every 250 ms, and watches the ping round trip.',
  params: [
    { key: 'gaps', label: 'Gaps', type: 'numbers', default: [100, 50, 30, 20, 10], unit: 'ms' },
    { key: 'stepS', label: 'Seconds per gap', type: 'number', default: 5 },
    { key: 'pingMs', label: 'Ping every', type: 'number', default: 250, unit: 'ms' },
  ],
  needs: { robot: true, wheelsUp: true },
  maxMs: 60_000,
  async run(ctx, p) {
    const gaps = (p.gaps as number[]).filter((g) => g > 0);
    const stepMs = Number(p.stepS) * 1000;
    const base = await baselineRtt(ctx);
    ctx.link.scheduler.setConfig({ minWriteGapMs: 0 });
    const data: T13Data = { baselineMs: r1(base.median), baselineSource: base.source, steps: [] };
    ctx.keep(data);
    for (const [k, gap] of gaps.entries()) {
      const step: GapStep = {
        gapMs: gap, targetHz: 1000 / gap, durS: stepMs / 1000, writesDone: 0, writeErrors: 0, coalesced: 0,
        pings: 0, pingLost: 0, rtts: [], rttEnqs: [],
      };
      const waits: Promise<void>[] = [];
      const pinger = every(ctx, Number(p.pingMs), stepMs, () => {
        step.pings++;
        waits.push(ctx.link.query('PING', { ch: 'query' }).then((r) => {
          if (r.status === 'ok') {
            step.rtts.push(r1(r.rttMs));
            step.rttEnqs.push(r1(r.rttEnqMs));
          } else step.pingLost++;
        }));
      });
      const writer = every(ctx, gap, stepMs, (i) => {
        waits.push(ctx.link.send('MS,0,0', { ch: 'motor' }).then((rec) => {
          if (rec.status === 'done') step.writesDone++;
          else if (rec.status === 'error') step.writeErrors++;
          else if (rec.status === 'coalesced') step.coalesced++;
        }));
        ctx.progress((k + (i * gap) / stepMs) / gaps.length, `gap ${gap} ms`);
      });
      await Promise.all([pinger, writer]);
      await Promise.all(waits);
      data.steps.push(step);
      ctx.sample({ gapMs: gap, writes: step.writesDone, errors: step.writeErrors, pingMed: num(median(step.rtts)), pingLost: step.pingLost });
      await ctx.sleep(300);
    }
    return data;
  },
  summarize(raw) {
    const d = raw as T13Data;
    const limit = 2 * d.baselineMs;
    const rows = d.steps.map((s) => {
      const p95 = quantile(s.rtts, 0.95);
      const achievedHz = s.writesDone / s.durS;
      const ok = Number.isFinite(p95) && p95 <= limit && s.pingLost === 0 && s.writeErrors === 0 && achievedHz >= 0.9 * s.targetHz;
      return { s, p95, achievedHz, ok };
    });
    const safe = rows.filter((r) => r.ok).map((r) => r.s.gapMs);
    const safeGap = safe.length ? Math.min(...safe) : null;
    return {
      values: { baselineMs: d.baselineMs, p95LimitMs: r1(limit), safeWriteGapMs: safeGap },
      tables: [{
        title: 'MS,0,0 at each gap with PING every 250 ms',
        columns: ['gap ms', 'target/s', 'writes/s', 'coalesced', 'errors', 'ping med', 'ping p95', 'ping+queue med', 'ping lost', 'ok'],
        rows: rows.map(({ s, p95, achievedHz, ok }) => [
          s.gapMs, num(s.targetHz), num(achievedHz), s.coalesced, s.writeErrors, num(median(s.rtts)), num(p95),
          num(median(s.rttEnqs)), s.pingLost, ok ? 'yes' : 'no',
        ]),
      }],
      notes: [
        safeGap === null
          ? 'No gap kept the link healthy.'
          : `Smallest safe gap: ${safeGap} ms (ping p95 ≤ ${r1(limit)} ms, no loss or errors, ≥ 90 % of target write rate).`,
        'ping+queue includes time waiting behind motor writes in the scheduler (motor outranks query).',
      ],
      profilePatch: safeGap === null ? undefined : { safeWriteGapMs: safeGap },
    };
  },
};

// ---------------------------------------------------------------- T1.4

const PACK_PATTERNS: { payload: string; expect: string[] }[] = [
  { payload: 'PING#PING#', expect: ['PING', 'PING'] },
  { payload: 'MS,0,0#PING#', expect: ['PING'] },
  { payload: '?LINE#?TEMP#', expect: ['?LINE', '?TEMP'] },
];

type T14Data = { patterns: { payload: string; expected: number; got: number[]; raw: string[] }[] };

export const T1_4: TestDefinition = {
  id: 'T1.4',
  group: 'Link',
  title: 'Packed writes',
  setup: 'Robot connected. Sends several commands in one write (PING#PING#, MS,0,0#PING#, ?LINE#?TEMP#) and counts the replies.',
  params: [
    { key: 'repeats', label: 'Repeats per pattern', type: 'number', default: 5 },
    { key: 'timeoutMs', label: 'Reply timeout', type: 'number', default: 800, unit: 'ms' },
  ],
  needs: { robot: true },
  maxMs: 60_000,
  async run(ctx, p) {
    const repeats = Number(p.repeats);
    const data: T14Data = { patterns: [] };
    ctx.keep(data);
    for (const [k, pat] of PACK_PATTERNS.entries()) {
      const entry = { payload: pat.payload, expected: pat.expect.length, got: [] as number[], raw: [] as string[] };
      data.patterns.push(entry);
      for (let i = 0; i < repeats; i++) {
        const { result, raw } = await collectRaw(ctx, async () => {
          const rec = await ctx.link.send(pat.payload, { literal: true, replyTimeoutMs: Number(p.timeoutMs) });
          if (rec.status !== 'done') return [] as MatchResult[];
          return ctx.link.repliesOf(rec);
        });
        const ok = result.filter((r) => r.status === 'ok').length;
        entry.got.push(ok);
        entry.raw.push(...raw);
        ctx.sample({ payload: pat.payload, i, replies: ok, expected: pat.expect.length, raw });
        ctx.progress((k * repeats + i + 1) / (PACK_PATTERNS.length * repeats), pat.payload);
        await ctx.sleep(200);
      }
    }
    return data;
  },
  summarize(raw) {
    const d = raw as T14Data;
    const safe = d.patterns.length > 0 && d.patterns.every((p) => p.got.length > 0 && p.got.every((g) => g === p.expected) && p.raw.length === 0);
    return {
      values: { packingSafe: safe },
      tables: [{
        title: 'Replies per packed write',
        columns: ['payload', 'expected', 'received per try', 'garbled/unmatched'],
        rows: d.patterns.map((p) => [p.payload, p.expected, p.got.join(' '), p.raw.length]),
      }],
      notes: [safe
        ? 'Packing safe: every packed write produced all expected replies.'
        : 'Packing NOT safe: keep packWrites off.'],
      profilePatch: { packingSafe: safe },
    };
  },
};

// ---------------------------------------------------------------- T1.5

/** Estimated blocks below this are link jitter, not firmware blocking. */
const NOT_BLOCKING_MS = 25;

export const T15_COMMANDS = [
  'ICON,HAPPY', 'HORN', 'BEEP', 'TONE,440,500', 'DISP,A', 'DISP,HELLO', 'HL,255,255,255', 'UG,0,255,0',
  'HO', 'CLS', '?DIST', '?LINE', '?ACCEL', '?LIGHT', '?TEMP',
];

type BlockSample = { cmd: string; rep: number; pongDelay: number | null; cmdReplyDelay: number | null; status: string };
type T15Data = { pingBaseMs: number; samples: BlockSample[] };

export const T1_5: TestDefinition = {
  id: 'T1.5',
  group: 'Link',
  title: 'Blocking commands',
  setup: 'Robot connected (it will beep, show icons and scroll text; lights flash). Sends each command, then PING at once, and measures how long the PONG is delayed.',
  params: [
    { key: 'commands', label: 'Commands', type: 'multi', default: T15_COMMANDS, options: [...T15_COMMANDS, '?COMPASS'] },
    { key: 'repeats', label: 'Repeats', type: 'number', default: 2, min: 1, max: 5 },
    { key: 'timeoutMs', label: 'PONG timeout', type: 'number', default: 9000, unit: 'ms' },
  ],
  needs: { robot: true },
  maxMs: 60_000,
  async run(ctx, p) {
    let cmds = (p.commands as string[]).slice();
    if (cmds.includes('?COMPASS') && !ctx.profile?.compassCalibrated) {
      cmds = cmds.filter((c) => c !== '?COMPASS');
      ctx.sample({ note: '?COMPASS skipped: profile does not mark the compass calibrated' });
    }
    const repeats = Number(p.repeats);
    const timeoutMs = Number(p.timeoutMs);
    ctx.link.scheduler.setConfig({ minWriteGapMs: 0 });
    const base: number[] = [];
    for (let i = 0; i < 10; i++) {
      const r = await ctx.link.query('PING', { ch: 'raw', bypassHold: true });
      if (r.status === 'ok') base.push(r.rttMs);
    }
    const data: T15Data = { pingBaseMs: r1(median(base)), samples: [] };
    ctx.keep(data);
    const total = cmds.length * repeats;
    let n = 0;
    for (let rep = 0; rep < repeats; rep++) {
      for (const cmd of cmds) {
        await ctx.sleep(250);
        const cmdP = ctx.link.send(cmd, { ch: 'raw', bypassHold: true, replyTimeoutMs: timeoutMs });
        const pingP = ctx.link.query('PING', { ch: 'raw', bypassHold: true, replyTimeoutMs: timeoutMs });
        const rec = await cmdP;
        const cmdReplies = isQuery(cmd) && rec.status === 'done' ? await ctx.link.repliesOf(rec) : [];
        const ping: QueryResult = await pingP;
        const s: BlockSample = {
          cmd,
          rep,
          status: ping.status,
          pongDelay: ping.status === 'ok' && rec.tDone !== undefined ? r1(ping.tRx - rec.tDone) : null,
          cmdReplyDelay: cmdReplies[0]?.status === 'ok' ? r1(cmdReplies[0].rttMs) : null,
        };
        data.samples.push(s);
        ctx.sample(s);
        ctx.progress(++n / total, cmd);
      }
    }
    // Leave the robot quiet and dark.
    void ctx.link.send('HO');
    void ctx.link.send('CLS');
    return data;
  },
  summarize(raw) {
    const d = raw as T15Data;
    const byCmd = new Map<string, BlockSample[]>();
    for (const s of d.samples) byCmd.set(s.cmd, [...(byCmd.get(s.cmd) ?? []), s]);
    const est = (cmd: string): number | null => {
      const xs = (byCmd.get(cmd) ?? []).map((s) => s.pongDelay).filter((x): x is number => x !== null);
      if (xs.length === 0) return null;
      return Math.max(0, median(xs) - d.pingBaseMs);
    };
    const rows = [...byCmd.entries()].map(([cmd, ss]) => {
      const delays = ss.map((s) => s.pongDelay).filter((x): x is number => x !== null);
      const replies = ss.map((s) => s.cmdReplyDelay).filter((x): x is number => x !== null);
      const e = est(cmd);
      return [cmd, blockMs(cmd), num(median(delays)), e === null ? null : r0(e), replies.length ? num(median(replies)) : null, ss.filter((s) => s.status !== 'ok').length];
    });
    // Profile table keyed by command name (see link/blocking).
    const blocking: Record<string, number> = {};
    const put = (key: string, v: number | null) => {
      if (v !== null && Number.isFinite(v)) blocking[key] = r0(v);
    };
    for (const name of Object.keys(DEFAULT_BLOCKING)) {
      const cmd = [...byCmd.keys()].find((c) => c === name || c.startsWith(`${name},`));
      if (cmd) put(name, est(cmd));
    }
    const tone = est('TONE,440,500');
    if (tone !== null) put('TONE', Math.max(0, tone - 500));
    const dA = est('DISP,A');
    const dH = est('DISP,HELLO');
    if (dA !== null && dH !== null) {
      const perChar = (dH - dA) / 4;
      put('DISP_PER_CHAR', perChar);
      put('DISP_BASE', dA - perChar);
    }
    for (const cmd of byCmd.keys()) {
      const name = cmd.split(',')[0];
      if (name in blocking || name === 'TONE' || name === 'DISP' || name === 'ICON') continue;
      const e = est(cmd);
      if (e !== null && e >= NOT_BLOCKING_MS) put(name, e); // below that it's link jitter
    }
    return {
      values: { pingBaseMs: d.pingBaseMs, ...Object.fromEntries(Object.entries(blocking).map(([k, v]) => [`block_${k}`, v])) },
      tables: [{
        title: 'PONG delay after each command (ms)',
        columns: ['command', 'expected block', 'pong delay', 'est. block', 'own reply rtt', 'lost'],
        rows,
      }],
      notes: [
        `Estimated block = PONG delay − PING baseline (${d.pingBaseMs} ms). Other commands under ${NOT_BLOCKING_MS} ms are treated as not blocking.`,
        'Saving to the profile replaces the default blocking table for this robot.',
      ],
      profilePatch: { blocking },
    };
  },
};

// ---------------------------------------------------------------- T1.6

type T16Data = {
  text: string; count: number; spacingMs: number; delays: (number | null)[]; raw: string[];
  aliveAfter: boolean; aliveTries: number; dispBlockMs: number;
};

export const T1_6: TestDefinition = {
  id: 'T1.6',
  group: 'Link',
  title: 'Buffer overflow',
  setup: 'Robot connected. Sends DISP,HELLO WORLD (scrolls for ~10 s), then 10 × PING 20 ms apart, and counts how many PONGs come back.',
  params: [
    { key: 'text', label: 'DISP text', type: 'text', default: 'HELLO WORLD' },
    { key: 'count', label: 'Pings', type: 'number', default: 10 },
    { key: 'spacingMs', label: 'Ping spacing', type: 'number', default: 20, unit: 'ms' },
  ],
  needs: { robot: true },
  maxMs: 60_000,
  async run(ctx, p) {
    const text = String(p.text).slice(0, 14);
    const count = Number(p.count);
    const spacing = Number(p.spacingMs);
    const disp = `DISP,${text}`;
    const timeout = blockMs(disp) + 5000;
    ctx.link.scheduler.setConfig({ minWriteGapMs: 0 });
    const data: T16Data = { text, count, spacingMs: spacing, delays: [], raw: [], aliveAfter: false, aliveTries: 0, dispBlockMs: blockMs(disp) };
    ctx.keep(data);
    const { result, raw } = await collectRaw(ctx, async () => {
      void ctx.link.send(disp, { ch: 'raw', bypassHold: true });
      const waits: Promise<QueryResult>[] = [];
      await every(ctx, spacing, spacing * count - 1, () => {
        waits.push(ctx.link.query('PING', { ch: 'raw', bypassHold: true, replyTimeoutMs: timeout }));
      });
      ctx.progress(0.2, 'waiting for the scroll to finish');
      return Promise.all(waits);
    });
    data.delays = result.map((r) => (r.status === 'ok' ? r1(r.rttMs) : null));
    data.raw = raw;
    for (const [i, d] of data.delays.entries()) ctx.sample({ i, delay: d });
    // Bytes left in the receive buffer can garble the next command, so allow a few tries.
    for (let i = 0; i < 3 && !data.aliveAfter; i++) {
      await ctx.sleep(300);
      data.aliveTries++;
      const alive = await ctx.link.query('PING', { ch: 'raw', bypassHold: true, replyTimeoutMs: 1000 });
      data.aliveAfter = alive.status === 'ok';
    }
    void ctx.link.send('CLS');
    return data;
  },
  summarize(raw) {
    const d = raw as T16Data;
    const got = d.delays.filter((x) => x !== null).length;
    return {
      values: { received: got, sent: d.delays.length, garbled: d.raw.length, aliveAfter: d.aliveAfter, aliveTries: d.aliveTries },
      tables: [{
        title: `PONGs after DISP,${d.text} (expected block ${d.dispBlockMs} ms)`,
        columns: ['ping', 'delay ms'],
        rows: d.delays.map((x, i) => [i + 1, x]),
      }],
      notes: [
        `${got} of ${d.delays.length} PONGs received while the robot was busy scrolling.`,
        d.raw.length ? `Unmatched or garbled replies: ${d.raw.map((r) => JSON.stringify(r)).join(', ')}.` : 'No garbled replies.',
        d.aliveAfter
          ? d.aliveTries > 1
            ? `The first ${d.aliveTries - 1} PING(s) afterwards got no reply (leftover bytes garbled them); then healthy.`
            : 'Link healthy afterwards.'
          : 'No PING answered afterwards: the robot may need a reconnect.',
      ],
    };
  },
};

// ---------------------------------------------------------------- T1.7

type SoakBucket = { t0S: number; rttMed: number | null; rttP95: number | null; replies: number; lost: number; writes: number };
type T17Data = { pollHz: number; gapMs: number; durationS: number; buckets: SoakBucket[]; disconnects: number; reconnects: number };

export const T1_7: TestDefinition = {
  id: 'T1.7',
  group: 'Link',
  title: 'Soak',
  setup: 'Robot on a stand, wheels free. Polls ?LINE at the safe rate and sends MS,0,0 at the safe gap for 3 minutes, watching for drift, losses and disconnects. Takes longer than other tests.',
  params: [
    { key: 'durationS', label: 'Duration', type: 'number', default: 180, unit: 's' },
    { key: 'pollHz', label: '?LINE rate (0 = profile safe rate)', type: 'number', default: 0, unit: 'Hz' },
    { key: 'gapMs', label: 'MS gap (0 = profile safe gap)', type: 'number', default: 0, unit: 'ms' },
  ],
  needs: { robot: true, wheelsUp: true },
  maxMs: 200_000,
  async run(ctx, p) {
    const pollHz = Number(p.pollHz) || ctx.profile?.safePollHz || 20;
    const gapMs = Number(p.gapMs) || ctx.profile?.safeWriteGapMs || 50;
    const durMs = Number(p.durationS) * 1000;
    const data: T17Data = { pollHz, gapMs, durationS: durMs / 1000, buckets: [], disconnects: 0, reconnects: 0 };
    ctx.keep(data);
    const off = ctx.link.onState((s) => {
      if (s === 'disconnected') data.disconnects++;
    });
    const rec0 = ctx.link.stats.reconnects;
    let bucket = { t0: ctx.clockNow(), rtts: [] as number[], replies: 0, lost: 0, writes: 0 };
    const offReply = ctx.link.onReply((e) => {
      bucket.replies++;
      if (e.rttMs !== undefined) bucket.rtts.push(e.rttMs);
    });
    let lost0 = ctx.link.stats.lost;
    const flush = () => {
      const lost = ctx.link.stats.lost - lost0;
      lost0 = ctx.link.stats.lost;
      const b: SoakBucket = {
        t0S: r0((bucket.t0 - t0) / 1000), rttMed: num(median(bucket.rtts)), rttP95: num(quantile(bucket.rtts, 0.95)),
        replies: bucket.replies, lost, writes: bucket.writes,
      };
      data.buckets.push(b);
      ctx.sample(b);
      bucket = { t0: ctx.clockNow(), rtts: [], replies: 0, lost: 0, writes: 0 };
    };
    const t0 = ctx.clockNow();
    ctx.poller.set([{ cmd: '?LINE', hz: pollHz }, { cmd: 'PING', hz: 2 }], 'test:T1.7');
    try {
      await every(ctx, gapMs, durMs, () => {
        void ctx.link.send('MS,0,0').then((r) => {
          if (r.status === 'done') bucket.writes++;
        });
        if (ctx.clockNow() - bucket.t0 >= 10_000) flush();
        ctx.progress((ctx.clockNow() - t0) / durMs, `${Math.round((ctx.clockNow() - t0) / 1000)} s`);
      });
      flush();
    } finally {
      off();
      offReply();
      ctx.poller.set([], 'test:T1.7');
    }
    data.reconnects = ctx.link.stats.reconnects - rec0;
    return data;
  },
  summarize(raw) {
    const d = raw as T17Data;
    const meds = d.buckets.map((b) => b.rttMed).filter((x): x is number => x !== null);
    const lost = d.buckets.reduce((n, b) => n + b.lost, 0);
    const drift = meds.length >= 2 ? meds[meds.length - 1] - meds[0] : null;
    return {
      values: {
        pollHz: d.pollHz, gapMs: d.gapMs, rttMedFirst: meds[0] ?? null, rttMedLast: meds[meds.length - 1] ?? null,
        driftMs: drift === null ? null : r1(drift), lost, disconnects: d.disconnects, reconnects: d.reconnects,
      },
      tables: [{
        title: 'Per 10 s',
        columns: ['t s', 'rtt med', 'rtt p95', 'replies', 'lost', 'MS writes'],
        rows: d.buckets.map((b) => [b.t0S, b.rttMed, b.rttP95, b.replies, b.lost, b.writes]),
      }],
      notes: [
        `RTT median went from ${meds[0] ?? '–'} to ${meds[meds.length - 1] ?? '–'} ms; ${lost} replies lost; ${d.disconnects} disconnects.`,
        mean(meds) > 0 ? `Average bucket median ${r1(mean(meds))} ms.` : '',
      ].filter(Boolean),
    };
  },
};

export const LINK_TESTS = [T1_1, T1_2, T1_3, T1_4, T1_5, T1_6, T1_7];

export type { Params, TestSummary };
