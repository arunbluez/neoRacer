// IndexedDB storage for sessions, events, test runs, robot profiles,
// calibrations and images, via Dexie.

import Dexie, { type Table } from 'dexie';
import type { LogEvent } from '../../core/log/events';
import type { SessionHeader, SessionSummary } from '../../core/log/session';
import type { RobotProfile } from '../../core/model/profile';
import type { TestRun } from '../../core/tests/types';
import type { LogSink, LogStore, StoredImage } from '../../core/types';
import type { TrackCalibration } from '../../core/vision/calibration';

type EventRow = LogEvent & { sessionId: string; seq?: number };
type ImageRow = Omit<StoredImage, 'bytes'> & { blob: Blob };

class RallyDb extends Dexie {
  sessions!: Table<SessionHeader, string>;
  events!: Table<EventRow, number>;
  testRuns!: Table<TestRun, string>;
  profiles!: Table<RobotProfile, string>;
  calibrations!: Table<TrackCalibration, string>;
  images!: Table<ImageRow, string>;

  constructor(name: string) {
    super(name);
    this.version(1).stores({
      sessions: 'id, startedAt',
      events: '++seq, [sessionId+t]',
      testRuns: 'runId, sessionId, testId',
      profiles: 'robotId',
      calibrations: 'id, createdAt',
      images: 'id, sessionId, calibrationId',
    });
  }
}

export class DexieLogStore implements LogStore {
  readonly db: RallyDb;

  constructor(name = 'rally-lab') {
    this.db = new RallyDb(name);
  }

  private range(sessionId: string) {
    return this.db.events.where('[sessionId+t]').between([sessionId, Dexie.minKey], [sessionId, Dexie.maxKey]);
  }

  async append(sessionId: string, batch: LogEvent[]): Promise<void> {
    await this.db.events.bulkAdd(batch.map((e) => ({ ...e, sessionId })));
  }

  async putSession(header: SessionHeader): Promise<void> {
    await this.db.sessions.put(header);
  }

  getSession(id: string): Promise<SessionHeader | undefined> {
    return this.db.sessions.get(id);
  }

  async listSessions(): Promise<SessionSummary[]> {
    const sessions = await this.db.sessions.orderBy('startedAt').reverse().toArray();
    return Promise.all(sessions.map(async (s) => ({
      ...s,
      eventCount: await this.range(s.id).count(),
      testRunCount: await this.db.testRuns.where('sessionId').equals(s.id).count(),
    })));
  }

  async deleteSession(id: string): Promise<void> {
    await this.db.transaction('rw', [this.db.events, this.db.testRuns, this.db.images, this.db.sessions], async () => {
      await this.range(id).delete();
      await this.db.testRuns.where('sessionId').equals(id).delete();
      await this.db.images.where('sessionId').equals(id).delete();
      await this.db.sessions.delete(id);
    });
  }

  async events(sessionId: string): Promise<LogEvent[]> {
    const rows = await this.range(sessionId).toArray();
    return rows.map(({ sessionId: _s, seq: _q, ...e }) => e as LogEvent);
  }

  countEvents(sessionId: string): Promise<number> {
    return this.range(sessionId).count();
  }

  async putTestRun(run: TestRun): Promise<void> {
    await this.db.testRuns.put(run);
  }

  async listTestRuns(sessionId?: string): Promise<TestRun[]> {
    const rows = sessionId === undefined
      ? await this.db.testRuns.toArray()
      : await this.db.testRuns.where('sessionId').equals(sessionId).toArray();
    return rows.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }

  getProfile(robotId: string): Promise<RobotProfile | undefined> {
    return this.db.profiles.get(robotId);
  }

  async putProfile(profile: RobotProfile): Promise<void> {
    await this.db.profiles.put(profile);
  }

  listProfiles(): Promise<RobotProfile[]> {
    return this.db.profiles.toArray();
  }

  async deleteProfile(robotId: string): Promise<void> {
    await this.db.profiles.delete(robotId);
  }

  async putCalibration(cal: TrackCalibration): Promise<void> {
    await this.db.calibrations.put(cal);
  }

  getCalibration(id: string): Promise<TrackCalibration | undefined> {
    return this.db.calibrations.get(id);
  }

  async listCalibrations(): Promise<TrackCalibration[]> {
    return (await this.db.calibrations.orderBy('createdAt').reverse().toArray());
  }

  async deleteCalibration(id: string): Promise<void> {
    await this.db.transaction('rw', [this.db.calibrations, this.db.images], async () => {
      await this.db.images.where('calibrationId').equals(id).delete();
      await this.db.calibrations.delete(id);
    });
  }

  async putImage(img: StoredImage): Promise<void> {
    const { bytes, ...rest } = img;
    await this.db.images.put({ ...rest, blob: new Blob([new Uint8Array(bytes)], { type: img.mime }) });
  }

  async getImage(id: string): Promise<StoredImage | undefined> {
    const row = await this.db.images.get(id);
    return row ? fromRow(row) : undefined;
  }

  async listImages(filter: { sessionId?: string; calibrationId?: string }): Promise<StoredImage[]> {
    let rows: ImageRow[];
    if (filter.calibrationId) rows = await this.db.images.where('calibrationId').equals(filter.calibrationId).toArray();
    else if (filter.sessionId) rows = await this.db.images.where('sessionId').equals(filter.sessionId).toArray();
    else rows = await this.db.images.toArray();
    return Promise.all(rows.map(fromRow));
  }
}

async function fromRow(row: ImageRow): Promise<StoredImage> {
  const { blob, ...rest } = row;
  return { ...rest, bytes: new Uint8Array(await blob.arrayBuffer()) };
}

/** Flushes log batches into IndexedDB. */
export class IndexedDbSink implements LogSink {
  readonly name = 'indexeddb';
  constructor(private readonly store: DexieLogStore) {}
  write(sessionId: string, batch: LogEvent[]): Promise<void> {
    return this.store.append(sessionId, batch);
  }
}

export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  if (!navigator.storage?.estimate) return null;
  const e = await navigator.storage.estimate();
  return { usage: e.usage ?? 0, quota: e.quota ?? 0 };
}

export async function requestPersistentStorage(): Promise<boolean> {
  try {
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}
