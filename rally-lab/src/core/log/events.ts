// One append-only log per session. Every event has a session-relative time
// in ms and a kind; the remaining fields depend on the kind.

export type LogEvent = {
  /** ms since session start (performance.now() based). */
  t: number;
  /** Kind, see LogKind. */
  k: string;
  [field: string]: unknown;
};

export type LogKind =
  | 'ble.tx' // cmd, ch, bytes, tEnq, tSent, tDone (every write)
  | 'ble.drop' // cmd, ch, status (coalesced/cleared/rejected) — commands that never went out
  | 'ble.rx' // raw (every reply line)
  | 'ble.state' // state, reason, durMs
  | 'ble.err' // op, message
  | 'sensor' // type, value, rttMs (every parsed reply)
  | 'link.stats' // rttMed, rttP95, txps, rxps, lost, queue (once per second)
  | 'input' // mode, left, right, raw (drive input, at send rate)
  | 'cam.stats' // fps, procMs, dropped (once per second)
  | 'cam.pose' // xCm, yCm, headingDeg, conf, tFrame, raw
  | 'test.start' | 'test.sample' | 'test.end' // testId, runId, params, data, summary
  | 'auto.start' | 'auto.tick' | 'auto.fix' | 'auto.line' | 'auto.spin' | 'auto.end' // camera-assisted auto run (race/autoRun)
  | 'auto.cam' // hand-held camera: mat found, orientation, fps (once per second)
  | 'note' // text, tags
  | 'app'; // event, detail

export const LOG_KINDS: LogKind[] = [
  'ble.tx', 'ble.drop', 'ble.rx', 'ble.state', 'ble.err', 'sensor', 'link.stats', 'input',
  'cam.stats', 'cam.pose', 'test.start', 'test.sample', 'test.end',
  'auto.start', 'auto.tick', 'auto.fix', 'auto.line', 'auto.spin', 'auto.end', 'auto.cam', 'note', 'app',
];

/** Round a time to 0.1 ms for compact logs. */
export const r1 = (x: number | undefined) => (x === undefined ? undefined : Math.round(x * 10) / 10);
