import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeClock } from '../testing/fakeClock';
import { ReplyMatcher } from './matcher';

describe('ReplyMatcher', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('matches first in first out per type and computes round-trip times', async () => {
    const clock = fakeClock();
    const m = new ReplyMatcher(clock, 500);
    m.expect('PING', 1, 0, 2);
    m.markDone(1, 5);
    m.expect('?LINE', 2, 1, 10);
    m.markDone(2, 12);
    m.expect('PING', 3, 3, 20);
    m.markDone(3, 22);
    const w1 = m.wait(1, 'PING');
    const w3 = m.wait(3, 'PING');

    const a = m.onReply({ type: 'line', code: 2 }, 40)!;
    expect(a.cmd).toBe('?LINE');
    expect(a.writeId).toBe(2);
    expect(a.rttMs).toBe(28); // 40 - tDone 12
    expect(a.rttEnqMs).toBe(39); // 40 - tEnq 1

    const b = m.onReply({ type: 'pong' }, 50)!;
    expect(b.writeId).toBe(1); // oldest PING first
    expect(b.rttMs).toBe(45);
    const c = m.onReply({ type: 'pong' }, 60)!;
    expect(c.writeId).toBe(3);
    expect(c.rttMs).toBe(38);
    expect(await w1).toMatchObject({ status: 'ok', rttMs: 45 });
    expect(await w3).toMatchObject({ status: 'ok', rttMs: 38 });
    expect(m.onReply({ type: 'pong' }, 70)).toBeNull(); // nothing pending
    expect(m.onReply({ type: 'raw', text: 'x' }, 70)).toBeNull();
  });

  it('measures from the write start when a reply beats the write promise', () => {
    const m = new ReplyMatcher(fakeClock(), 500);
    m.expect('PING', 1, 0, 10);
    const r = m.onReply({ type: 'pong' }, 25)!;
    expect(r.early).toBe(true);
    expect(r.rttMs).toBe(15);
  });

  it('times out unanswered queries and pops them', async () => {
    const clock = fakeClock();
    const m = new ReplyMatcher(clock, 500);
    const lost: string[] = [];
    m.onLost((r) => lost.push(r.cmd));
    m.expect('?DIST', 1, 0, 0);
    m.markDone(1, 0);
    m.expect('?DIST', 2, 0, 100, 2000);
    m.markDone(2, 100);
    const w = m.wait(1, '?DIST');
    await vi.advanceTimersByTimeAsync(520);
    expect(lost).toEqual(['?DIST']);
    expect(await w).toMatchObject({ status: 'lost' });
    expect(m.pending).toBe(1);
    // the late reply goes to the remaining query
    const r = m.onReply({ type: 'dist', cm: 10 }, clock.now())!;
    expect(r.writeId).toBe(2);
    await vi.advanceTimersByTimeAsync(3000);
    expect(lost).toEqual(['?DIST']);
  });

  it('handles duplicate queries in one packed write', async () => {
    const m = new ReplyMatcher(fakeClock(), 500);
    m.expect('PING', 7, 0, 0);
    m.expect('PING', 7, 0, 0);
    m.markDone(7, 1);
    m.onReply({ type: 'pong' }, 10);
    m.onReply({ type: 'pong' }, 20);
    expect(await m.wait(7, 'PING', 0)).toMatchObject({ rttMs: 9 });
    expect(await m.wait(7, 'PING', 1)).toMatchObject({ rttMs: 19 });
  });

  it('cancels expectations of failed writes', async () => {
    const m = new ReplyMatcher(fakeClock(), 500);
    m.expect('PING', 1, 0, 0);
    const w = m.wait(1, 'PING');
    m.markFailed(1);
    expect(await w).toMatchObject({ status: 'cancelled' });
    expect(m.pending).toBe(0);
  });
});
