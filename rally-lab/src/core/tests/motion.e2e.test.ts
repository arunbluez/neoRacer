import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockTransport } from '../../adapters/ble/MockTransport';
import { alongAndSide } from '../model/fits';
import { drive, makeLab } from '../testing/labHarness';
import type { PromptHandle, PromptRequest, PromptResponse, TestUi } from './types';
import { defaultParams } from './types';
import { T3_1, T3_2, T3_4, T3_5 } from './motionTests';

/** A tester who watches the simulated robot and measures it perfectly. */
function simTester(getMock: () => MockTransport, now: () => number): TestUi {
  let start = { x: 0, y: 0, h: 0 };
  return {
    prompt(req: PromptRequest): PromptHandle {
      const mock = getMock();
      const taps: { button: string; t: number }[] = [];
      let close = () => {};
      const values: Record<string, number | string> = {};
      let result: Promise<PromptResponse>;
      if (req.live) {
        // Tap "Moving" 200 ms after the robot really starts moving.
        result = new Promise((resolve) => {
          const p0 = mock.world.pose(now());
          const h = setInterval(() => {
            const p = mock.world.pose(now());
            if (Math.hypot(p.x - p0.x, p.y - p0.y) > 0.3 || Math.abs(p.headingDeg - p0.headingDeg) > 1) {
              clearInterval(h);
              setTimeout(() => {
                taps.push({ button: 'Moving', t: now() });
                resolve({ button: 'Moving', values });
              }, 200);
            }
          }, 20);
          close = () => clearInterval(h);
        });
      } else {
        if (req.title === 'Place the robot') {
          // Put the robot in the middle of open mat, facing +x.
          mock.world.place(150, 125, 0);
          const p = mock.world.pose(now());
          start = { x: p.x, y: p.y, h: p.headingDeg };
        }
        const p = mock.world.pose(now());
        const { along, side } = alongAndSide(start, start.h, p);
        const turned = Math.abs(p.headingDeg - start.h);
        for (const f of req.fields ?? []) {
          if (f.key === 'along') values.along = along;
          else if (f.key === 'side') values.side = side;
          else if (f.key === 'chord') values.chord = Math.hypot(p.x - start.x, p.y - start.y);
          else values[f.key] = 0;
        }
        if (req.title.includes(': angle')) values.deg = mock.world.totalTurnDeg;
        if (req.title.includes(': measure') && 'deg' in values) values.deg = Math.min(turned, 360 - turned);
        result = new Promise((r) => setTimeout(() => r({ button: (req.buttons ?? ['Next'])[0], values }), 30));
      }
      return { result, taps, close: () => close() };
    },
  };
}

describe('motion tests with manual entry against the simulated robot', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  async function setup() {
    const ref: { mock?: MockTransport; now: () => number } = { now: () => 0 };
    const ui = simTester(() => ref.mock!, () => ref.now());
    const h = await makeLab({ ui });
    ref.mock = h.mock;
    ref.now = () => h.clock.now();
    return h;
  }

  it('T3.1 finds the deadband by watching for motion', async () => {
    const { lab } = await setup();
    const run = await drive(lab.runner.run(T3_1, { ...defaultParams(T3_1), sequences: ['left fwd', 'right back'] }));
    expect(run.status).toBe('done');
    expect(run.measuredBy).toBe('manual');
    // the sim's deadband is 12, so motion starts at 15 with steps of 5
    expect(run.summary!.values.lf).toBe(15);
    expect(run.summary!.values.rb).toBe(15);
  });

  it('T3.2 measures speed and suggests trim for a slower right wheel', async () => {
    const { lab } = await setup();
    const run = await drive(lab.runner.run(T3_2, { ...defaultParams(T3_2), speeds: [50, 100] }));
    expect(run.status).toBe('done');
    const v = run.summary!.values;
    expect(Number(v.cmPerS_100)).toBeGreaterThan(30);
    expect(Number(v.cmPerS_100)).toBeLessThan(45);
    expect(Number(v.cmPerS_50)).toBeLessThan(Number(v.cmPerS_100));
    // right factor 0.97 → drifts right → positive trim of a few percent
    expect(Number(v.trimSuggestionPct)).toBeGreaterThan(1);
    expect(Number(v.trimSuggestionPct)).toBeLessThan(6);
    await lab.updateProfile(run.summary!.profilePatch!);
    expect(lab.profile!.speedTable!.map((r) => r.cmd)).toEqual([50, 100]);
  });

  it('T3.5 gets the track width from arcs given a speed table', async () => {
    const { lab } = await setup();
    const sp = await drive(lab.runner.run(T3_2, { ...defaultParams(T3_2), speeds: [25, 50, 70, 100], durationS: 3 }));
    await lab.updateProfile({ speedTable: sp.summary!.profilePatch!.speedTable });
    const run = await drive(lab.runner.run(T3_5, { ...defaultParams(T3_5), pairs: '100/60, 70/40', durationS: 1.5 }));
    expect(run.status).toBe('done');
    const w = Number(run.summary!.values.trackWidthCm);
    expect(w).toBeGreaterThan(6);
    expect(w).toBeLessThan(13); // sim track width 9.2 cm
  });

  it('T3.4 reports spin rates', async () => {
    const { lab } = await setup();
    const run = await drive(lab.runner.run(T3_4, { ...defaultParams(T3_4), speeds: [50] }));
    expect(run.status).toBe('done');
    expect(Number(run.summary!.values.degPerS_50)).toBeGreaterThan(100);
  });
});
