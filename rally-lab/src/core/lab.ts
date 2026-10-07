// The composition root of the portable core: one logger, one link, one
// poller and one test runner, plus sessions, settings and robot profiles.
// Platform adapters are passed in; the UI only talks to this object.

import { RobotLink } from './link/link';
import { zipSession, zipSessions, type SessionBundle } from './log/export';
import { buildReport } from './log/report';
import { ALL_TESTS } from './tests/registry';
import { Poller } from './link/poller';
import { Logger } from './log/logger';
import { makeSessionId, robotIdFromName, SCHEMA_VERSION, type SessionHeader } from './log/session';
import { newProfile, type RobotProfile } from './model/profile';
import { withDefaults, type Settings } from './settings';
import type { CameraControl, PoseSource } from './tests/camera';
import { TestRunner } from './tests/runner';
import type { TestRun, TestUi } from './tests/types';
import type { Clock, DeviceInfo, LogSink, LogStore, Transport } from './types';
import type { TrackCalibration } from './vision/calibration';
import { errorMessage } from './util/async';

export type LabEnv = {
  buildId: string;
  buildTime: string;
  userAgent: string;
  screen: { w: number; h: number; dpr: number };
};

export type LabDeps = {
  clock: Clock;
  wallClock: () => Date;
  store: LogStore;
  sinks: LogSink[];
  /** Write a file next to the session log (dev sync). */
  artifact?: (sessionId: string, path: string, data: unknown) => void;
  env: LabEnv;
  realTransport: () => Transport;
  mockTransport: () => Transport;
  settings: Settings;
  saveSettings: (s: Settings) => void;
  lastRobotId?: string;
  saveLastRobotId?: (id: string) => void;
  ui: TestUi;
};

type Listener = () => void;

export class Lab {
  readonly logger: Logger;
  readonly link: RobotLink;
  readonly poller: Poller;
  readonly runner: TestRunner;
  readonly store: LogStore;
  settings: Settings;
  profile?: RobotProfile;
  header!: SessionHeader;
  /** Set by the camera layer while tracking is calibrated and running. */
  pose?: PoseSource;
  camera?: CameraControl;
  /** The active track calibration (loaded by the camera layer). */
  calibration?: TrackCalibration;
  private listeners = new Set<Listener>();
  private real?: Transport;
  private mock?: Transport;

  private constructor(private readonly deps: LabDeps) {
    this.store = deps.store;
    this.settings = withDefaults(deps.settings);
    this.logger = new Logger(deps.clock);
    for (const s of deps.sinks) this.logger.addSink(s);
    this.link = new RobotLink(this.transportFor(this.settings.mockRobot), deps.clock, this.logger, this.linkConfig());
    this.poller = new Poller(this.link);
    this.runner = new TestRunner({
      link: this.link,
      poller: this.poller,
      logger: this.logger,
      clock: deps.clock,
      ui: deps.ui,
      settings: () => this.settings,
      profile: () => this.profile,
      pose: () => this.pose,
      camera: () => this.camera,
      calibration: () => this.calibration,
      saveRun: (run) => this.store.putTestRun(run),
      artifact: (path, data) => this.artifact(path, data),
      wallClock: deps.wallClock,
    });
    this.link.onState((s, info) => {
      if (s === 'connected' && info?.device) void this.onConnected(info.device);
      this.emit();
    });
  }

  static async create(deps: LabDeps): Promise<Lab> {
    const lab = new Lab(deps);
    await lab.newSession(deps.lastRobotId);
    lab.logger.startAutoFlush(1000);
    return lab;
  }

  subscribe(cb: Listener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit(): void {
    for (const cb of this.listeners) cb();
  }

  private transportFor(mock: boolean): Transport {
    if (mock) return (this.mock ??= this.deps.mockTransport());
    return (this.real ??= this.deps.realTransport());
  }

  get mockTransport(): Transport | undefined {
    return this.mock;
  }

  private linkConfig() {
    return {
      minWriteGapMs: this.settings.minWriteGapMs,
      replyTimeoutMs: this.settings.replyTimeoutMs,
      packWrites: this.settings.packWrites,
      blocking: { ...(this.profile?.blocking ?? {}), ...this.settings.blockingOverrides },
    };
  }

  artifact(path: string, data: unknown): void {
    this.deps.artifact?.(this.logger.sessionId, path, data);
  }

  async newSession(robotId?: string): Promise<void> {
    const now = this.deps.wallClock();
    const id = makeSessionId(now, robotId ?? this.profile?.robotId);
    await this.logger.startSession(id);
    const dev = this.link.connected ? this.link.device : undefined;
    this.header = {
      schemaVersion: SCHEMA_VERSION,
      id,
      startedAt: now.toISOString(),
      buildId: this.deps.env.buildId,
      buildTime: this.deps.env.buildTime,
      userAgent: this.deps.env.userAgent,
      screen: this.deps.env.screen,
      robot: dev && this.profile ? { name: dev.name, id: this.profile.robotId } : undefined,
      robots: dev && this.profile ? [{ name: dev.name, id: this.profile.robotId, t: 0 }] : [],
      transport: this.link.transportKind,
      settings: this.settings,
      profile: this.profile,
      calibrationId: this.header?.calibrationId,
    };
    this.logger.log('app', { event: 'session', detail: this.header });
    if (dev) this.logger.log('ble.state', { state: 'connected', reason: 'session start', name: dev.name, id: dev.id });
    this.runner.resetHistory();
    await this.saveHeader();
    this.artifact('session-header.json', this.header);
    this.emit();
  }

  async saveHeader(): Promise<void> {
    this.header.updatedAt = this.deps.wallClock().toISOString();
    try {
      await this.store.putSession(this.header);
    } catch (err) {
      this.logger.log('app', { event: 'error', detail: `saving session failed: ${errorMessage(err)}` });
    }
  }

  async connect(): Promise<DeviceInfo> {
    return this.link.connect();
  }

  async disconnect(): Promise<void> {
    this.runner.abort('disconnect');
    this.poller.stop();
    await this.link.disconnect();
  }

  private async onConnected(dev: DeviceInfo): Promise<void> {
    const robotId = robotIdFromName(dev.name);
    const nowIso = this.deps.wallClock().toISOString();
    let profile: RobotProfile | undefined;
    try {
      profile = await this.store.getProfile(robotId);
    } catch (err) {
      this.logger.log('app', { event: 'error', detail: `loading profile failed: ${errorMessage(err)}` });
    }
    if (!profile) {
      profile = newProfile(robotId, dev.name, nowIso);
      await this.store.putProfile(profile).catch(() => {});
    }
    this.profile = profile;
    this.deps.saveLastRobotId?.(robotId);
    this.link.configure(this.linkConfig());
    // Keep the round trip live in the header from the first second.
    if (this.poller.entries.length === 0 && !this.runner.running) this.poller.set([{ cmd: 'PING', hz: 2 }], 'default');

    // A session that has not talked to any robot yet takes the robot's name.
    const fresh = !this.header.robot && (this.logger.counts.get('ble.tx') ?? 0) === 0;
    if (fresh && !this.header.id.endsWith(`-${robotId}`)) {
      const stale = this.header.id;
      const onlyStartup = [...this.logger.counts.keys()].every((k) => k === 'app' || k === 'ble.state' || k === 'ble.err');
      await this.newSession(robotId);
      // The pre-connect session only holds startup events; don't let those pile up in the list.
      if (onlyStartup) await this.store.deleteSession(stale).catch(() => {});
    } else {
      this.header.robot ??= { name: dev.name, id: robotId };
      if (!this.header.robots.some((r) => r.id === robotId)) {
        this.header.robots.push({ name: dev.name, id: robotId, t: this.logger.now() });
      }
      this.header.profile = profile;
      this.header.transport = this.link.transportKind;
      await this.saveHeader();
    }
    this.emit();
  }

  /** STOP: stop the motors, abort any test. */
  stopAll(reason = 'STOP'): void {
    void this.link.stop();
    if (this.runner.running) this.runner.abort(reason);
    this.logger.log('app', { event: 'stop', detail: reason });
  }

  /** The page became hidden: stop motors, tests and pollers. */
  onHidden(): void {
    if (this.link.connected) void this.link.stop();
    this.runner.abort('page hidden');
    this.poller.stop();
    this.logger.log('app', { event: 'visibility', detail: 'hidden' });
    void this.logger.flush();
  }

  onVisible(): void {
    this.logger.log('app', { event: 'visibility', detail: 'visible' });
  }

  async setSettings(patch: Partial<Settings>): Promise<void> {
    const before = this.settings.mockRobot;
    this.settings = withDefaults({ ...this.settings, ...patch });
    this.deps.saveSettings(this.settings);
    this.link.configure(this.linkConfig());
    this.logger.log('app', { event: 'settings', detail: patch });
    if (this.settings.mockRobot !== before) {
      this.poller.stop();
      await this.link.setTransport(this.transportFor(this.settings.mockRobot));
    }
    this.emit();
  }

  async updateProfile(patch: Partial<RobotProfile>): Promise<RobotProfile | undefined> {
    if (!this.profile) return undefined;
    this.profile = { ...this.profile, ...patch, updatedAt: this.deps.wallClock().toISOString() };
    await this.store.putProfile(this.profile);
    this.header.profile = this.profile;
    this.link.configure(this.linkConfig());
    this.logger.log('app', { event: 'profile', detail: patch });
    await this.saveHeader();
    this.emit();
    return this.profile;
  }

  setCalibration(cal: TrackCalibration | undefined): void {
    this.calibration = cal;
    this.header.calibrationId = cal?.id;
    this.logger.log('app', { event: 'calibration', detail: cal ? { id: cal.id, reprojErrorCm: cal.reprojErrorCm } : null });
    void this.saveHeader();
    this.emit();
  }

  note(text: string, tags: string[] = []): void {
    this.logger.log('note', { text, tags });
    this.emit();
  }

  async sessionRuns(sessionId = this.logger.sessionId): Promise<TestRun[]> {
    return this.store.listTestRuns(sessionId);
  }

  /** Everything export needs for one session, with report.md. */
  async bundle(sessionId = this.logger.sessionId): Promise<SessionBundle> {
    const current = sessionId === this.logger.sessionId;
    if (current) {
      await this.logger.flush();
      await this.saveHeader();
    }
    const header = (await this.store.getSession(sessionId)) ?? (current ? this.header : undefined);
    if (!header) throw new Error(`unknown session ${sessionId}`);
    const [events, runs] = await Promise.all([this.store.events(sessionId), this.store.listTestRuns(sessionId)]);
    const profile = (header.robot ? await this.store.getProfile(header.robot.id) : undefined) ?? header.profile;
    const startedAt = header.startedAt;
    const endedAt = header.updatedAt ?? this.deps.wallClock().toISOString();
    const calibrations = (await this.store.listCalibrations()).filter(
      (c) => c.id === header.calibrationId || (c.createdAt >= startedAt && c.createdAt <= endedAt),
    );
    const images = [
      ...(await this.store.listImages({ sessionId })),
      ...(await Promise.all(calibrations.map((c) => this.store.listImages({ calibrationId: c.id })))).flat(),
    ].filter((img, i, all) => all.findIndex((x) => x.id === img.id) === i);
    const eventCounts: Record<string, number> = {};
    for (const e of events) eventCounts[e.k] = (eventCounts[e.k] ?? 0) + 1;
    const report = buildReport({
      header, runs, defs: ALL_TESTS, profile, calibrations, settings: header.settings ?? this.settings, eventCounts,
    });
    return { header, events, runs, profile, calibrations, images, report };
  }

  async exportZip(sessionId?: string): Promise<{ name: string; bytes: Uint8Array }> {
    const b = await this.bundle(sessionId);
    return { name: `${b.header.id}.zip`, bytes: zipSession(b) };
  }

  async exportAllZip(): Promise<{ name: string; bytes: Uint8Array }> {
    const sessions = await this.store.listSessions();
    const bundles: SessionBundle[] = [];
    for (const s of sessions) bundles.push(await this.bundle(s.id));
    const d = this.deps.wallClock().toISOString().slice(0, 10);
    return { name: `rally-lab-all-${d}.zip`, bytes: zipSessions(bundles) };
  }
}
