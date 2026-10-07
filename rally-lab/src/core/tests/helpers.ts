// Shared bits for experiment runners and summaries.

import type { ReplyEvent } from '../link/link';
import type { RobotProfile } from '../model/profile';
import { median, round, summarize } from '../util/stats';
import type { ResultTable, TestContext, TestRun } from './types';

export const r0 = (x: number) => round(x, 0);
export const r1 = (x: number) => round(x, 1);
export const r2 = (x: number) => round(x, 2);

/** Number or null for result values (NaN becomes null). */
export const num = (x: number, digits = 1): number | null => (Number.isFinite(x) ? round(x, digits) : null);

/** Median ping RTT: from the latest T1.1 run, else measured now with a few pings. */
export async function baselineRtt(ctx: TestContext, pings = 15): Promise<{ median: number; source: string }> {
  const prev = ctx.previousRuns('T1.1').find((r) => r.status === 'done');
  const v = prev?.summary?.values.rttMedian;
  if (typeof v === 'number' && Number.isFinite(v)) return { median: v, source: `T1.1 run ${prev!.runId}` };
  const rtts: number[] = [];
  for (let i = 0; i < pings; i++) {
    ctx.token.throwIfAborted();
    const r = await ctx.link.query('PING', { ch: 'raw' });
    if (r.status === 'ok') rtts.push(r.rttMs);
  }
  ctx.sample({ phase: 'baseline', rtts: rtts.map(r1) });
  return { median: median(rtts), source: `${rtts.length} pings now` };
}

/** Collect unmatched or garbled replies while fn runs. */
export async function collectRaw<T>(ctx: TestContext, fn: () => Promise<T>): Promise<{ result: T; raw: string[] }> {
  const raw: string[] = [];
  const off = ctx.link.onReply((e: ReplyEvent) => {
    if (e.reply.type === 'raw' || e.rttMs === undefined) raw.push(e.raw);
  });
  try {
    return { result: await fn(), raw };
  } finally {
    off();
  }
}

/** Calls fn every periodMs (drift-free) for durationMs. */
export async function every(ctx: TestContext, periodMs: number, durationMs: number, fn: (i: number) => void): Promise<number> {
  const t0 = ctx.clockNow();
  let i = 0;
  while (ctx.clockNow() - t0 < durationMs) {
    ctx.token.throwIfAborted();
    fn(i);
    i++;
    const next = t0 + i * periodMs;
    await ctx.sleep(Math.max(0, next - ctx.clockNow()));
  }
  return i;
}

export function rttTable(title: string, rtts: number[]): ResultTable {
  const s = summarize(rtts);
  return {
    title,
    columns: ['n', 'min', 'median', 'p95', 'max', 'mean'],
    rows: [[s.n, num(s.min), num(s.median), num(s.p95), num(s.max), num(s.mean)]],
  };
}

export function lastDone(runs: TestRun[], testId: string): TestRun | undefined {
  return runs.filter((r) => r.testId === testId && r.status === 'done').sort((a, b) => b.tStart - a.tStart)[0];
}

export function profileValue<K extends keyof RobotProfile>(p: RobotProfile | undefined, k: K): RobotProfile[K] | undefined {
  return p ? p[k] : undefined;
}

export const LINE_NAMES = ['both white', 'right black', 'left black', 'both black'];
