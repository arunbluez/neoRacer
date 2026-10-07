import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockTransport } from '../../adapters/ble/MockTransport';
import { Logger } from '../log/logger';
import { fakeClock } from '../testing/fakeClock';
import { RobotLink } from './link';

function setup(opts: ConstructorParameters<typeof MockTransport>[1] = {}) {
  const clock = fakeClock();
  const logger = new Logger(clock);
  void logger.startSession('test');
  const mock = new MockTransport(clock, opts);
  const link = new RobotLink(mock, clock, logger, { minWriteGapMs: 30, replyTimeoutMs: 500 });
  return { clock, logger, mock, link };
}

describe('RobotLink against the mock robot', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('connects, pings and logs every byte', async () => {
    const { link, logger } = setup();
    const c = link.connect();
    await vi.advanceTimersByTimeAsync(500);
    expect((await c).name).toBe('BBC micro:bit [mocky]');
    expect(link.connected).toBe(true);

    const q = link.query('PING');
    await vi.advanceTimersByTimeAsync(200);
    const r = await q;
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.reply).toEqual({ type: 'pong' });
    expect(r.rttMs).toBeGreaterThan(5);
    expect(r.rttMs).toBeLessThan(80);

    const kinds = logger.ring.toArray().map((e) => e.k);
    expect(kinds).toContain('ble.state');
    expect(kinds).toContain('ble.tx');
    expect(kinds).toContain('ble.rx');
    expect(kinds).toContain('sensor');
    const tx = logger.ring.toArray().find((e) => e.k === 'ble.tx')!;
    expect(tx).toMatchObject({ cmd: 'PING', ch: 'query', bytes: 5 });
    expect(typeof tx.tEnq).toBe('number');
    expect(typeof tx.tDone).toBe('number');
    const sensor = logger.ring.toArray().find((e) => e.k === 'sensor')!;
    expect(sensor).toMatchObject({ type: 'pong' });
    expect(sensor.rttMs).toBeGreaterThan(0);
  });

  it('counts lost replies', async () => {
    const { link } = setup({ lossRate: 1 });
    const c = link.connect();
    await vi.advanceTimersByTimeAsync(500);
    await c;
    const q = link.query('?LINE');
    await vi.advanceTimersByTimeAsync(700);
    expect((await q).status).toBe('lost');
    expect(link.stats.lost).toBe(1);
  });

  it('drives the simulated motors and stops on disconnect', async () => {
    const { link, mock, clock } = setup();
    const c = link.connect();
    await vi.advanceTimersByTimeAsync(500);
    await c;
    void link.send('MS,60,60');
    await vi.advanceTimersByTimeAsync(1000);
    const p = mock.world.pose(clock.now());
    expect(Math.hypot(p.vl, p.vr)).toBeGreaterThan(10);
    mock.simulateDrop();
    await vi.advanceTimersByTimeAsync(600);
    expect(mock.world.cmdL).toBe(0);
  });

  it('reconnects with backoff after the link drops', async () => {
    const { link, mock, logger } = setup();
    const c = link.connect();
    await vi.advanceTimersByTimeAsync(500);
    await c;
    mock.simulateDrop();
    expect(link.state).toBe('connecting');
    await vi.advanceTimersByTimeAsync(250 + 400 + 50);
    expect(link.state).toBe('connected');
    expect(link.stats.reconnects).toBe(1);
    const states = logger.ring.toArray().filter((e) => e.k === 'ble.state').map((e) => `${e.state}:${e.reason ?? ''}`);
    expect(states).toContain('disconnected:gattserverdisconnected');
    expect(states).toContain('connected:reconnect');
  });

  it('does not reconnect after a user disconnect', async () => {
    const { link } = setup();
    const c = link.connect();
    await vi.advanceTimersByTimeAsync(500);
    await c;
    await link.disconnect();
    await vi.advanceTimersByTimeAsync(3000);
    expect(link.state).toBe('disconnected');
  });

  it('a blocking command delays the next reply in the firmware', async () => {
    const { link } = setup();
    const c = link.connect();
    await vi.advanceTimersByTimeAsync(500);
    await c;
    void link.send('ICON,HAPPY', { ch: 'raw' });
    const q = link.query('PING', { ch: 'raw', bypassHold: true, replyTimeoutMs: 2000 });
    await vi.advanceTimersByTimeAsync(1000);
    const r = await q;
    expect(r.status).toBe('ok');
    if (r.status === 'ok') expect(r.rttMs).toBeGreaterThan(550);
  });
});
