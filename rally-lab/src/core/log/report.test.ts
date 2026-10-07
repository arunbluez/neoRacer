import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../settings';
import { ALL_TESTS } from '../tests/registry';
import type { TestRun } from '../tests/types';
import { buildReport, openWarnings } from './report';
import type { SessionHeader } from './session';
import { T1_1, T1_5 } from '../tests/linkTests';
import { T2_1 } from '../tests/sensorTests';
import { zipSession } from './export';
import { unzipSync, strFromU8 } from 'fflate';

const header: SessionHeader = {
  schemaVersion: 1,
  id: '20261007-101500-popuv',
  startedAt: '2026-10-07T10:15:00.000Z',
  buildId: 'abc1234',
  buildTime: '2026-10-07T09:00:00Z',
  userAgent: 'fixture',
  screen: { w: 412, h: 915, dpr: 2.6 },
  robot: { name: 'BBC micro:bit [popuv]', id: 'popuv' },
  robots: [{ name: 'BBC micro:bit [popuv]', id: 'popuv', t: 1200 }],
  transport: 'web-bluetooth',
  settings: DEFAULT_SETTINGS,
};

function run(def: typeof T1_1, runId: string, tStart: number, params: TestRun['params'], data: unknown): TestRun {
  return {
    runId, testId: def.id, title: def.title, sessionId: header.id, robotId: 'popuv',
    startedAt: new Date(Date.parse(header.startedAt) + tStart).toISOString(), tStart, tEnd: tStart + 9000,
    params, status: 'done', data,
    summary: def.summarize(data, params, { settings: DEFAULT_SETTINGS }),
  };
}

const runs: TestRun[] = [
  run(T1_1, 'T1.1-5000-1', 5000, { count: 5, timeoutMs: 500 }, {
    timeoutMs: 500,
    samples: [
      { i: 0, status: 'ok', rtt: 31.2, rttEnq: 32 }, { i: 1, status: 'ok', rtt: 28.4, rttEnq: 29 },
      { i: 2, status: 'lost' }, { i: 3, status: 'ok', rtt: 45.1, rttEnq: 46 }, { i: 4, status: 'ok', rtt: 30, rttEnq: 31 },
    ],
  }),
  run(T1_5, 'T1.5-20000-2', 20000, { commands: ['ICON,HAPPY', 'HORN', 'PING'], repeats: 1, timeoutMs: 9000 }, {
    pingBaseMs: 30,
    samples: [
      { cmd: 'ICON,HAPPY', rep: 0, status: 'ok', pongDelay: 652.5, cmdReplyDelay: null },
      { cmd: 'HORN', rep: 0, status: 'ok', pongDelay: 236, cmdReplyDelay: null },
      { cmd: 'PING', rep: 0, status: 'ok', pongDelay: 41, cmdReplyDelay: 30 },
    ],
  }),
  run(T2_1, 'T2.1-40000-3', 40000, { surface: 'lane purple', samples: 4 }, { surface: 'lane purple', note: 'mid lane', codes: [0, 0, 0, 1], lost: 0, rtts: [30, 31, 29, 30] }),
  run(T2_1, 'T2.1-50000-4', 50000, { surface: 'black background', samples: 4 }, { surface: 'black background', note: '', codes: [3, 3, 3, 3], lost: 0, rtts: [30, 31, 29, 30] }),
];

describe('report.md', () => {
  it('matches the snapshot for a fixture session', () => {
    const md = buildReport({
      header, runs, defs: ALL_TESTS, settings: DEFAULT_SETTINGS, calibrations: [],
      profile: { robotId: 'popuv', name: 'BBC micro:bit [popuv]', trim: 0.03, compassCalibrated: false, notes: '', updatedAt: '2026-10-07T10:20:00.000Z', blocking: { ICON: 623, HORN: 206 } },
      eventCounts: { 'ble.tx': 210, 'ble.rx': 205 },
    });
    expect(md).toMatchSnapshot();
    expect(md).toContain('## T1.1 Ping baseline');
    expect(md).toContain('Surface survey across labels');
    expect(md).toContain('Packing not verified');
  });

  it('warns about what is still unmeasured', () => {
    const w = openWarnings({ runs: [], profile: undefined, calibrations: [], settings: DEFAULT_SETTINGS });
    expect(w.join('\n')).toMatch(/Blocking table not measured/);
    expect(w.join('\n')).toMatch(/No camera calibration/);
  });

  it('zips session.json, events.jsonl, report.md and images', () => {
    const zip = zipSession({
      header, runs, events: [{ t: 0, k: 'app', event: 'start' }, { t: 1.5, k: 'ble.tx', cmd: 'PING' }], calibrations: [],
      images: [{ id: 'img1', name: 'still.jpg', mime: 'image/jpeg', bytes: new Uint8Array([1, 2, 3]), createdAt: '' }],
      report: '# r',
    });
    const files = unzipSync(zip);
    expect(Object.keys(files).sort()).toEqual(['events.jsonl', 'images/still.jpg', 'report.md', 'session.json']);
    expect(strFromU8(files['events.jsonl']).trim().split('\n')).toHaveLength(2);
    expect(JSON.parse(strFromU8(files['session.json'])).testRuns).toHaveLength(4);
  });
});
