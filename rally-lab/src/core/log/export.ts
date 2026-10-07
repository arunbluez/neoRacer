// session.zip: session.json (header, robot profile, calibrations, test
// results), events.jsonl, report.md and images/.

import { strToU8, zipSync, type Zippable } from 'fflate';
import type { RobotProfile } from '../model/profile';
import type { TestRun } from '../tests/types';
import type { StoredImage } from '../types';
import type { TrackCalibration } from '../vision/calibration';
import type { LogEvent } from './events';
import type { SessionHeader } from './session';

export type SessionBundle = {
  header: SessionHeader;
  events: LogEvent[];
  runs: TestRun[];
  profile?: RobotProfile;
  calibrations: TrackCalibration[];
  images: StoredImage[];
  report: string;
};

export function sessionJson(b: SessionBundle): string {
  return JSON.stringify({
    schemaVersion: b.header.schemaVersion,
    header: b.header,
    profile: b.profile ?? b.header.profile ?? null,
    calibrations: b.calibrations,
    testRuns: b.runs,
    images: b.images.map((i) => ({ id: i.id, name: i.name, mime: i.mime, calibrationId: i.calibrationId, bytes: i.bytes.length })),
  }, null, 2);
}

export function eventsJsonl(events: LogEvent[]): string {
  return events.map((e) => JSON.stringify(e)).join('\n') + (events.length ? '\n' : '');
}

function addSession(files: Zippable, prefix: string, b: SessionBundle): void {
  files[`${prefix}session.json`] = strToU8(sessionJson(b));
  files[`${prefix}events.jsonl`] = strToU8(eventsJsonl(b.events));
  files[`${prefix}report.md`] = strToU8(b.report);
  const used = new Set<string>();
  for (const img of b.images) {
    let name = img.name.replace(/[^A-Za-z0-9_.-]/g, '_');
    while (used.has(name)) name = `x${name}`;
    used.add(name);
    // Images are already compressed: store them.
    files[`${prefix}images/${name}`] = [img.bytes, { level: 0 }];
  }
}

export function zipSession(b: SessionBundle): Uint8Array {
  const files: Zippable = {};
  addSession(files, '', b);
  return zipSync(files, { level: 6 });
}

export function zipSessions(bundles: SessionBundle[]): Uint8Array {
  const files: Zippable = {};
  for (const b of bundles) addSession(files, `${b.header.id}/`, b);
  return zipSync(files, { level: 6 });
}
