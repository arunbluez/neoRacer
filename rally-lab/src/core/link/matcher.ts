// Replies carry no request id, so they are matched to queries first in,
// first out per reply type: each sent query queues an expectation, each
// reply pops the oldest one of its type.

import { QUERY_REPLY, type Reply, type ReplyType } from '../protocol/parser';
import { cmdName } from '../protocol/commands';
import type { Clock } from '../types';

export type MatchOk = {
  status: 'ok';
  cmd: string;
  writeId: number;
  reply: Reply;
  tEnq: number;
  tSent: number;
  tDone: number;
  tRx: number;
  /** Reply time minus write-resolved time. */
  rttMs: number;
  /** Reply time minus enqueue time (includes queueing). */
  rttEnqMs: number;
  /** The reply arrived before the write promise resolved. */
  early: boolean;
};

export type MatchLost = {
  status: 'lost';
  cmd: string;
  writeId: number;
  tEnq: number;
  tSent: number;
  tDone?: number;
  waitedMs: number;
};

export type MatchCancelled = { status: 'cancelled'; cmd: string; writeId: number };

export type MatchResult = MatchOk | MatchLost | MatchCancelled;

type Expectation = {
  cmd: string;
  writeId: number;
  /** Index among identical commands in the same write (packed writes). */
  nth: number;
  type: Exclude<ReplyType, 'raw'>;
  tEnq: number;
  tSent: number;
  tDone?: number;
  timeoutMs: number;
  waiters: ((r: MatchResult) => void)[];
};

export class ReplyMatcher {
  private queues = new Map<ReplyType, Expectation[]>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private timerAt = Infinity;
  private lostListeners = new Set<(r: MatchLost) => void>();
  /** Results of recently settled expectations, so a late wait() still gets its answer. */
  private recent = new Map<string, MatchResult>();

  constructor(private readonly clock: Clock, public defaultTimeoutMs = 500) {}

  /** Register a query that has just gone out. Returns false for non-queries. */
  expect(cmd: string, writeId: number, tEnq: number, tSent: number, timeoutMs?: number): boolean {
    const type = QUERY_REPLY[cmdName(cmd)];
    if (!type) return false;
    const q = this.queues.get(type) ?? [];
    const nth = q.filter((e) => e.writeId === writeId && e.cmd === cmd).length;
    q.push({ cmd, writeId, nth, type, tEnq, tSent, timeoutMs: timeoutMs ?? this.defaultTimeoutMs, waiters: [] });
    this.queues.set(type, q);
    this.armSweep();
    return true;
  }

  /** The write carrying these queries has resolved. */
  markDone(writeId: number, tDone: number): void {
    for (const q of this.queues.values()) {
      for (const e of q) if (e.writeId === writeId && e.tDone === undefined) e.tDone = tDone;
    }
    this.armSweep();
  }

  /** Mark a write as failed: its expectations will never be answered. */
  markFailed(writeId: number): void {
    for (const [type, q] of this.queues) {
      const keep: Expectation[] = [];
      for (const e of q) {
        if (e.writeId === writeId) this.settle(e, { status: 'cancelled', cmd: e.cmd, writeId });
        else keep.push(e);
      }
      this.queues.set(type, keep);
    }
  }

  /** Wait for the result of a registered query. */
  wait(writeId: number, cmd: string, nth = 0): Promise<MatchResult> {
    const type = QUERY_REPLY[cmdName(cmd)];
    const e = type ? this.queues.get(type)?.find((x) => x.writeId === writeId && x.cmd === cmd && x.nth === nth) : undefined;
    if (!e) return Promise.resolve(this.recent.get(`${writeId}|${cmd}|${nth}`) ?? { status: 'cancelled', cmd, writeId });
    return new Promise((resolve) => e.waiters.push(resolve));
  }

  /** Match an incoming reply. Returns null when nothing was waiting for it. */
  onReply(reply: Reply, tRx: number): MatchOk | null {
    if (reply.type === 'raw') return null;
    const q = this.queues.get(reply.type);
    const e = q?.shift();
    if (!e) return null;
    const early = e.tDone === undefined || e.tDone > tRx;
    const tDone = early ? e.tSent : e.tDone!;
    const res: MatchOk = {
      status: 'ok',
      cmd: e.cmd,
      writeId: e.writeId,
      reply,
      tEnq: e.tEnq,
      tSent: e.tSent,
      tDone: e.tDone ?? e.tSent,
      tRx,
      rttMs: tRx - tDone,
      rttEnqMs: tRx - e.tEnq,
      early,
    };
    this.settle(e, res);
    this.armSweep();
    return res;
  }

  onLost(cb: (r: MatchLost) => void): () => void {
    this.lostListeners.add(cb);
    return () => this.lostListeners.delete(cb);
  }

  /** Pop every expectation that has waited longer than its timeout. */
  sweep(now = this.clock.now()): MatchLost[] {
    const lost: MatchLost[] = [];
    for (const [type, q] of this.queues) {
      const keep: Expectation[] = [];
      for (const e of q) {
        const from = e.tDone ?? e.tSent;
        if (now - from >= e.timeoutMs) {
          const r: MatchLost = { status: 'lost', cmd: e.cmd, writeId: e.writeId, tEnq: e.tEnq, tSent: e.tSent, tDone: e.tDone, waitedMs: now - from };
          lost.push(r);
          this.settle(e, r);
          for (const cb of this.lostListeners) cb(r);
        } else keep.push(e);
      }
      this.queues.set(type, keep);
    }
    return lost;
  }

  cancelAll(): void {
    for (const q of this.queues.values()) {
      for (const e of q) this.settle(e, { status: 'cancelled', cmd: e.cmd, writeId: e.writeId });
    }
    this.queues.clear();
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.timerAt = Infinity;
  }

  get pending(): number {
    let n = 0;
    for (const q of this.queues.values()) n += q.length;
    return n;
  }

  pendingOf(type: ReplyType): number {
    return this.queues.get(type)?.length ?? 0;
  }

  private settle(e: Expectation, r: MatchResult): void {
    this.recent.set(`${e.writeId}|${e.cmd}|${e.nth}`, r);
    if (this.recent.size > 256) this.recent.delete(this.recent.keys().next().value!);
    for (const w of e.waiters) w(r);
    e.waiters = [];
  }

  private nextDeadline(): number {
    let at = Infinity;
    for (const q of this.queues.values()) {
      for (const e of q) at = Math.min(at, (e.tDone ?? e.tSent) + e.timeoutMs);
    }
    return at;
  }

  private armSweep(): void {
    const at = this.nextDeadline();
    if (at === Infinity) {
      if (this.timer !== null) clearTimeout(this.timer);
      this.timer = null;
      this.timerAt = Infinity;
      return;
    }
    if (this.timer !== null && this.timerAt === at) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timerAt = at;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.timerAt = Infinity;
      this.sweep();
      this.armSweep();
    }, Math.max(0, at - this.clock.now()) + 1);
  }
}
