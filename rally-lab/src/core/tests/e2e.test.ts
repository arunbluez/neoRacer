import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { autoUi, drive, makeLab } from '../testing/labHarness';
import { defaultParams } from './types';
import { T1_1, T1_2, T1_3, T1_4, T1_5, T1_6 } from './linkTests';
import { T2_1 } from './sensorTests';
import { T3_2 } from './motionTests';

describe('link tests against the mock robot', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('T1.1 measures the ping baseline', async () => {
    const { lab, store } = await makeLab();
    const run = await drive(lab.runner.run(T1_1, { ...defaultParams(T1_1), count: 50 }));
    expect(run.status).toBe('done');
    const v = run.summary!.values;
    expect(v.sent).toBe(50);
    expect(v.lost).toBe(0);
    expect(Number(v.rttMedian)).toBeGreaterThan(8);
    expect(Number(v.rttMedian)).toBeLessThan(60);
    expect((await store.listTestRuns(lab.header.id)).length).toBe(1);
    await lab.logger.flush();
    const kinds = (await store.events(lab.header.id)).map((e) => e.k);
    expect(kinds.filter((k) => k === 'test.sample').length).toBe(50);
    expect(kinds).toContain('test.start');
    expect(kinds).toContain('test.end');
  });

  it('T1.5 recovers the firmware blocking table', async () => {
    const { lab } = await makeLab();
    const run = await drive(lab.runner.run(T1_5, defaultParams(T1_5)));
    expect(run.status).toBe('done');
    const b = run.summary!.profilePatch!.blocking!;
    expect(b.ICON).toBeGreaterThan(560);
    expect(b.ICON).toBeLessThan(660);
    expect(b.HORN).toBeGreaterThan(170);
    expect(b.HORN).toBeLessThan(240);
    expect(b.BEEP).toBeGreaterThan(70);
    expect(b.BEEP).toBeLessThan(140);
    expect(b.TONE).toBeLessThan(40);
    expect(b.DISP_PER_CHAR).toBeGreaterThan(800);
    expect(b.DISP_PER_CHAR).toBeLessThan(1000);
    expect(b.HL).toBeUndefined();
    // saving it changes the scheduler's hold
    await lab.updateProfile(run.summary!.profilePatch!);
    expect(lab.link.config.blocking.ICON).toBe(b.ICON);
  });

  it('T1.4 finds packing unsafe or safe from replies', async () => {
    const { lab } = await makeLab();
    const run = await drive(lab.runner.run(T1_4, { ...defaultParams(T1_4), repeats: 2 }));
    expect(run.status).toBe('done');
    // The mock queues one handler event per '#', like the micro:bit, so packing works.
    expect(run.summary!.values.packingSafe).toBe(true);
  });

  it('T1.6 shows the receive buffer overflowing during a scroll', async () => {
    const { lab } = await makeLab();
    const run = await drive(lab.runner.run(T1_6, defaultParams(T1_6)));
    expect(run.status).toBe('done');
    const got = Number(run.summary!.values.received);
    expect(got).toBeGreaterThan(0);
    expect(got).toBeLessThan(10);
    expect(run.summary!.values.aliveAfter).toBe(true);
  });

  it('T1.2 and T1.3 produce a safe rate and gap', async () => {
    const { lab } = await makeLab();
    const r2 = await drive(lab.runner.run(T1_2, { ...defaultParams(T1_2), rates: [5, 20, 50], stepS: 2 }));
    expect(r2.status).toBe('done');
    expect(r2.summary!.tables[0].rows.length).toBe(3);
    const r3 = await drive(lab.runner.run(T1_3, { ...defaultParams(T1_3), gaps: [100, 30], stepS: 2 }));
    expect(r3.status).toBe('done');
    expect(r3.summary!.values.safeWriteGapMs).not.toBeNull();
    // scheduler settings are restored after the test
    expect(lab.link.scheduler.config.minWriteGapMs).toBe(30);
  });

  it('STOP aborts a running test and sends S', async () => {
    const { lab, mock, clock } = await makeLab();
    const p = lab.runner.run(T1_1, { ...defaultParams(T1_1), count: 500 });
    await vi.advanceTimersByTimeAsync(500);
    void lab.link.send('MS,50,50');
    await vi.advanceTimersByTimeAsync(200);
    lab.stopAll('test');
    const run = await drive(p);
    expect(run.status).toBe('aborted');
    expect(run.summary).toBeDefined(); // partial result kept
    await vi.advanceTimersByTimeAsync(200);
    expect(mock.world.pose(clock.now()).vl).toBeLessThan(40);
    expect(mock.world.cmdL).toBe(0);
  });

  it('T2.1 surveys a surface on the synthetic track', async () => {
    const { lab } = await makeLab({ withTrack: true });
    const run = await drive(lab.runner.run(T2_1, { ...defaultParams(T2_1), surface: 'lane blue end' }));
    expect(run.status).toBe('done');
    // the mock starts on the lane, which reads white by default
    expect(run.summary!.values.majorityCode).toBe(0);
    expect(run.summary!.profilePatch!.surfaces!['lane blue end'].code).toBe(0);
  });

  it('aborts a robot test when the link drops', async () => {
    const { lab, mock } = await makeLab();
    const p = lab.runner.run(T1_1, { ...defaultParams(T1_1), count: 500 });
    await vi.advanceTimersByTimeAsync(800);
    mock.simulateDrop();
    const run = await drive(p);
    expect(run.status).toBe('aborted');
    expect(run.error).toBe('robot disconnected');
  });

  it('keeps a test that waits for a typed measurement when the page is hidden', async () => {
    const ui = autoUi(undefined, 3000); // the user takes 3 s to answer each prompt
    const { lab } = await makeLab({ ui });
    const p = lab.runner.run(T2_1, defaultParams(T2_1));
    await vi.advanceTimersByTimeAsync(200);
    expect(lab.runner.waitingForUser).toBe(false); // T2.1 asks nothing
    await drive(p);
    const p2 = lab.runner.run(T3_2, { ...defaultParams(T3_2), speeds: [50] });
    await vi.advanceTimersByTimeAsync(500);
    expect(lab.runner.waitingForUser).toBe(true); // "Place the robot"
    lab.onHidden();
    lab.onVisible();
    const run = await drive(p2);
    expect(run.status).toBe('done');
  });
});
