// In-memory LogStore for tests.
import type { LogEvent } from '../log/events';
import type { SessionHeader, SessionSummary } from '../log/session';
import type { RobotProfile } from '../model/profile';
import type { TestRun } from '../tests/types';
import type { LogSink, LogStore, StoredImage } from '../types';
import type { TrackCalibration } from '../vision/calibration';

export class MemoryStore implements LogStore {
  sessions = new Map<string, SessionHeader>();
  ev = new Map<string, LogEvent[]>();
  runs = new Map<string, TestRun>();
  profiles = new Map<string, RobotProfile>();
  cals = new Map<string, TrackCalibration>();
  images = new Map<string, StoredImage>();

  async append(sessionId: string, batch: LogEvent[]) {
    this.ev.set(sessionId, [...(this.ev.get(sessionId) ?? []), ...batch]);
  }
  async putSession(h: SessionHeader) { this.sessions.set(h.id, structuredClone(h)); }
  async getSession(id: string) { return this.sessions.get(id); }
  async listSessions(): Promise<SessionSummary[]> {
    return [...this.sessions.values()].map((s) => ({
      ...s, eventCount: this.ev.get(s.id)?.length ?? 0,
      testRunCount: [...this.runs.values()].filter((r) => r.sessionId === s.id).length,
    }));
  }
  async deleteSession(id: string) { this.sessions.delete(id); this.ev.delete(id); }
  async events(id: string) { return [...(this.ev.get(id) ?? [])].sort((a, b) => a.t - b.t); }
  async countEvents(id: string) { return this.ev.get(id)?.length ?? 0; }
  async putTestRun(r: TestRun) { this.runs.set(r.runId, structuredClone(r)); }
  async listTestRuns(sessionId?: string) {
    return [...this.runs.values()].filter((r) => sessionId === undefined || r.sessionId === sessionId);
  }
  async getProfile(id: string) { return this.profiles.get(id); }
  async putProfile(p: RobotProfile) { this.profiles.set(p.robotId, structuredClone(p)); }
  async listProfiles() { return [...this.profiles.values()]; }
  async putCalibration(c: TrackCalibration) { this.cals.set(c.id, c); }
  async getCalibration(id: string) { return this.cals.get(id); }
  async listCalibrations() { return [...this.cals.values()]; }
  async putImage(i: StoredImage) { this.images.set(i.id, i); }
  async getImage(id: string) { return this.images.get(id); }
  async listImages(f: { sessionId?: string; calibrationId?: string }) {
    return [...this.images.values()].filter((i) => (f.sessionId ? i.sessionId === f.sessionId : true) && (f.calibrationId ? i.calibrationId === f.calibrationId : true));
  }
  sink(): LogSink {
    return { name: 'memory', write: (id, b) => this.append(id, b) };
  }
}
