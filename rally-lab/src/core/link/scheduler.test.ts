import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeAscii } from '../protocol/ascii';
import { fakeClock } from '../testing/fakeClock';
import { blockMs } from './blocking';
import { classify, WriteScheduler, type WriteRecord } from './scheduler';

type Wire = { text: string; t: number };

function setup(cfg: Partial<ConstructorParameters<typeof WriteScheduler>[2]> = {}, writeMs = 5) {
  const clock = fakeClock();
  const wire: Wire[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const write = (b: Uint8Array) => {
    wire.push({ text: decodeAscii(b), t: clock.now() });
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    return new Promise<void>((r) => setTimeout(() => { inFlight--; r(); }, writeMs));
  };
  const s = new WriteScheduler(write, clock, { minWriteGapMs: 30, ...cfg });
  return { s, wire, clock, maxInFlight: () => maxInFlight };
}

describe('WriteScheduler', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('classifies commands into channels', () => {
    expect(classify('S')).toBe('safety');
    expect(classify('MS,1,1')).toBe('motor');
    expect(classify('F,30')).toBe('motor');
    expect(classify('ML,20')).toBe('motor');
    expect(classify('?LINE')).toBe('query');
    expect(classify('PING')).toBe('query');
    expect(classify('HL,1,2,3')).toBe('light');
    expect(classify('UGO')).toBe('light');
    expect(classify('HORN')).toBe('oneshot');
    expect(classify('DISP,HI')).toBe('oneshot');
  });

  it('keeps one write in flight and spaces writes by the minimum gap', async () => {
    const { s, wire, maxInFlight } = setup({ minWriteGapMs: 30 }, 40);
    for (let i = 0; i < 4; i++) void s.send('HORN', { ch: 'oneshot', bypassHold: true });
    await vi.advanceTimersByTimeAsync(500);
    expect(wire.map((w) => w.text)).toEqual(['HORN#', 'HORN#', 'HORN#', 'HORN#']);
    expect(maxInFlight()).toBe(1);
    // write takes 40 ms > gap, so writes are 40 ms apart
    expect(wire[1].t - wire[0].t).toBe(40);

    const b = setup({ minWriteGapMs: 30 }, 2);
    for (let i = 0; i < 3; i++) void b.s.send(`TONE,${100 + i},1`, { bypassHold: true });
    await vi.advanceTimersByTimeAsync(500);
    expect(b.wire[1].t - b.wire[0].t).toBe(30);
    expect(b.wire[2].t - b.wire[1].t).toBe(30);
  });

  it('orders channels by priority', async () => {
    const { s, wire } = setup();
    void s.send('BEEP', { bypassHold: true }); // goes out at once
    void s.send('ICON,HAPPY', { ch: 'raw' });
    void s.send('CLS');
    void s.send('HL,1,1,1');
    void s.send('?LINE');
    void s.send('MS,10,10');
    void s.send('S');
    await vi.advanceTimersByTimeAsync(400);
    expect(wire.map((w) => w.text)).toEqual(['BEEP#', 'S#', '?LINE#', 'HL,1,1,1#', 'CLS#', 'ICON,HAPPY#']);
  });

  it('motor channel: latest wins', async () => {
    const { s, wire } = setup();
    void s.send('PING');
    const a = s.send('MS,10,10');
    const b = s.send('MS,20,20');
    const c = s.send('MS,30,30');
    await vi.advanceTimersByTimeAsync(200);
    expect(wire.map((w) => w.text)).toEqual(['PING#', 'MS,30,30#']);
    expect((await a).status).toBe('coalesced');
    expect((await b).status).toBe('coalesced');
    expect((await c).status).toBe('done');
  });

  it('folds ML/MR into one MS so no wheel update is lost', async () => {
    const { s, wire } = setup();
    void s.send('MS,40,40');
    await vi.advanceTimersByTimeAsync(10);
    void s.send('PING');
    void s.send('ML,10');
    const r = s.send('MR,-20');
    await vi.advanceTimersByTimeAsync(200);
    // motor outranks query
    expect(wire.map((w) => w.text)).toEqual(['MS,40,40#', 'MS,10,-20#', 'PING#']);
    expect((await r).mergedFrom).toEqual(['ML,10', 'MR,-20']);
    expect(s.motorState).toEqual({ l: 10, r: -20 });
  });

  it('safety clears the motor channel and jumps the queue', async () => {
    const { s, wire } = setup();
    void s.send('PING');
    void s.send('?LINE');
    void s.send('HL,1,2,3');
    const m = s.send('MS,50,50');
    void s.send('S');
    await vi.advanceTimersByTimeAsync(300);
    expect(wire.map((w) => w.text)).toEqual(['PING#', 'S#', '?LINE#', 'HL,1,2,3#']);
    expect((await m).status).toBe('coalesced');
  });

  it('query channel drops unsent duplicates', async () => {
    const { s, wire } = setup();
    void s.send('HORN', { bypassHold: true });
    const a = s.send('?LINE');
    const b = s.send('?LINE');
    void s.send('?DIST');
    expect(b).toBe(a);
    await vi.advanceTimersByTimeAsync(300);
    expect(wire.map((w) => w.text)).toEqual(['HORN#', '?LINE#', '?DIST#']);
  });

  it('light channel keeps one slot per light command', async () => {
    const { s, wire } = setup();
    void s.send('PING');
    void s.send('HLL,1,0,0');
    void s.send('UG,0,1,0');
    void s.send('HLL,2,0,0');
    void s.send('UGL,0,0,1');
    await vi.advanceTimersByTimeAsync(300);
    expect(wire.map((w) => w.text)).toEqual(['PING#', 'UG,0,1,0#', 'HLL,2,0,0#', 'UGL,0,0,1#']);

    const t = setup();
    void t.s.send('PING');
    void t.s.send('HLL,1,0,0');
    void t.s.send('UGR,1,0,0');
    void t.s.send('HO');
    await vi.advanceTimersByTimeAsync(300);
    expect(t.wire.map((w) => w.text)).toEqual(['PING#', 'HO#']);
  });

  it('oneshot and raw are first in first out, raw never coalesced', async () => {
    const { s, wire } = setup();
    void s.send('PING');
    void s.send('?LINE', { ch: 'raw' });
    void s.send('?LINE', { ch: 'raw' });
    void s.send('CLS');
    void s.send('QUIET');
    await vi.advanceTimersByTimeAsync(400);
    expect(wire.map((w) => w.text)).toEqual(['PING#', 'CLS#', 'QUIET#', '?LINE#', '?LINE#']);
  });

  it('holds everything but safety after a blocking command', async () => {
    const { s, wire } = setup({ minWriteGapMs: 10 }, 5);
    void s.send('ICON,HAPPY');
    await vi.advanceTimersByTimeAsync(20);
    expect(s.isBusy()).toBe(true);
    void s.send('PING');
    void s.send('MS,10,10');
    void s.send('S');
    await vi.advanceTimersByTimeAsync(100);
    expect(wire.map((w) => w.text)).toEqual(['ICON,HAPPY#', 'S#']);
    await vi.advanceTimersByTimeAsync(600);
    expect(wire.map((w) => w.text)).toEqual(['ICON,HAPPY#', 'S#', 'PING#']);
    // ICON done at t=5, hold = 600 + 20 pad
    expect(wire[2].t).toBe(5 + 600 + 20);
    expect(s.isBusy()).toBe(false);
  });

  it('bypassHold lets a test measure the block', async () => {
    const { s, wire } = setup({ minWriteGapMs: 0 }, 5);
    void s.send('ICON,HAPPY', { ch: 'raw' });
    void s.send('PING', { ch: 'raw', bypassHold: true });
    await vi.advanceTimersByTimeAsync(50);
    expect(wire.map((w) => w.text)).toEqual(['ICON,HAPPY#', 'PING#']);
  });

  it('rejects writes over 20 bytes', async () => {
    const { s, wire } = setup();
    const r = await s.send('DISP,THIS IS TOO LONG!!');
    expect(r.status).toBe('rejected');
    expect(r.error).toMatch(/20-byte/);
    const okP = s.send('DISP,EXACTLY 20 BYT', { bypassHold: true }); // 19 chars + '#'
    await vi.advanceTimersByTimeAsync(50);
    expect((await okP).bytes).toBe(20);
    expect(wire.map((w) => w.text)).toEqual(['DISP,EXACTLY 20 BYT#']);
  });

  it('packs short commands when packWrites is on', async () => {
    const { s, wire } = setup({ packWrites: true });
    void s.send('HORN', { bypassHold: true }); // in flight
    const recs: Promise<WriteRecord>[] = [s.send('MS,0,0'), s.send('PING'), s.send('?LINE'), s.send('?TEMP')];
    await vi.advanceTimersByTimeAsync(400);
    expect(wire[1].text).toBe('MS,0,0#PING#?LINE#');
    expect(wire[2].text).toBe('?TEMP#');
    const done = await Promise.all(recs);
    expect(done[0].packId).toBe(done[1].packId);
    expect(done[3].packId).toBeUndefined();
  });

  it('sends literal payloads unchanged', async () => {
    const { s, wire } = setup();
    const p = s.send('PING#PING#', { literal: true });
    await vi.advanceTimersByTimeAsync(50);
    expect((await p).cmds).toEqual(['PING', 'PING']);
    expect(wire[0].text).toBe('PING#PING#');
  });

  it('rejects everything while disabled and clears queues on disable', async () => {
    const { s } = setup();
    void s.send('HORN', { bypassHold: true });
    const q = s.send('?LINE');
    s.setEnabled(false);
    expect((await q).status).toBe('cleared');
    expect((await s.send('PING')).status).toBe('rejected');
  });

  it('reports write errors', async () => {
    const clock = fakeClock();
    const s = new WriteScheduler(() => Promise.reject(new Error('GATT busy')), clock);
    const r = await s.send('PING');
    expect(r.status).toBe('error');
    expect(r.error).toBe('GATT busy');
  });
});

describe('blocking table', () => {
  it('uses firmware defaults and overrides', () => {
    expect(blockMs('ICON,HAPPY')).toBe(600);
    expect(blockMs('HORN')).toBe(200);
    expect(blockMs('BEEP')).toBe(100);
    expect(blockMs('TONE,440,500')).toBe(500);
    expect(blockMs('DISP,A')).toBe((6 + 5) * 150);
    expect(blockMs('DISP,HELLO')).toBe((30 + 5) * 150);
    expect(blockMs('PING')).toBe(0);
    expect(blockMs('MS,1,1')).toBe(0);
    expect(blockMs('ICON,HAPPY', { ICON: 450 })).toBe(450);
    expect(blockMs('TONE,440,500', { TONE: 12 })).toBe(512);
    expect(blockMs('DISP,HELLO', { DISP_BASE: 100, DISP_PER_CHAR: 900 })).toBe(4600);
    expect(blockMs('HL,1,1,1', { HL: 3 })).toBe(3);
  });
});
