// A full Lab against the mock robot, with fake timers, for end-to-end tests.
import { vi } from 'vitest';
import { MockTransport } from '../../adapters/ble/MockTransport';
import { Lab } from '../lab';
import { DEFAULT_SETTINGS } from '../settings';
import { makeSyntheticTrack } from '../sim/track';
import { SimWorld } from '../sim/world';
import type { PromptHandle, PromptRequest, PromptResponse, TestUi } from '../tests/types';
import { fakeClock } from './fakeClock';
import { MemoryStore } from './memoryStore';

/** Answers every prompt with its first button (and field defaults) after a short delay. */
export function autoUi(answer?: (req: PromptRequest) => PromptResponse | undefined, delayMs = 50): TestUi & { asked: PromptRequest[] } {
  const asked: PromptRequest[] = [];
  return {
    asked,
    prompt(req): PromptHandle {
      asked.push(req);
      const taps: { button: string; t: number }[] = [];
      const values: Record<string, number | string> = {};
      for (const f of req.fields ?? []) values[f.key] = 'default' in f && f.default !== undefined ? f.default : f.type === 'number' ? 0 : '';
      const res = answer?.(req) ?? { button: (req.buttons ?? ['Next'])[0], values };
      const result = new Promise<PromptResponse>((r) => setTimeout(() => r(res), delayMs));
      return { result, taps, close: () => {} };
    },
  };
}

let track: ReturnType<typeof makeSyntheticTrack> | null = null;

export async function makeLab(opts: { ui?: TestUi; withTrack?: boolean } = {}) {
  const clock = fakeClock();
  const store = new MemoryStore();
  let mock: MockTransport | null = null;
  const labP = Lab.create({
    clock,
    wallClock: () => new Date(Date.UTC(2026, 9, 7, 10, 0, 0) + clock.now()),
    store,
    sinks: [store.sink()],
    env: { buildId: 'test', buildTime: '2026-10-07T00:00:00Z', userAgent: 'vitest', screen: { w: 412, h: 915, dpr: 2 } },
    realTransport: () => { throw new Error('no bluetooth in tests'); },
    mockTransport: () => {
      let world: SimWorld | undefined;
      if (opts.withTrack) {
        track ??= makeSyntheticTrack({ cmPerPx: 1 });
        world = new SimWorld(clock.now(), { mask: track.mask, pose: track.start });
      }
      mock = new MockTransport(clock, {}, world);
      return mock;
    },
    settings: { ...DEFAULT_SETTINGS, mockRobot: true },
    saveSettings: () => {},
    ui: opts.ui ?? autoUi(),
  });
  await vi.advanceTimersByTimeAsync(10);
  const lab = await labP;
  const c = lab.connect();
  await vi.advanceTimersByTimeAsync(600);
  await c;
  await vi.advanceTimersByTimeAsync(50);
  return { lab, store, clock, mock: mock! as MockTransport };
}

/** Run a promise to completion while advancing fake time. */
export async function drive<T>(p: Promise<T>, stepMs = 100, maxMs = 300_000): Promise<T> {
  let done = false;
  let value!: T;
  let error: unknown;
  p.then((v) => { done = true; value = v; }, (e) => { done = true; error = e; });
  for (let t = 0; t < maxMs && !done; t += stepMs) await vi.advanceTimersByTimeAsync(stepMs);
  if (!done) throw new Error('timed out driving promise');
  if (error) throw error;
  return value;
}
