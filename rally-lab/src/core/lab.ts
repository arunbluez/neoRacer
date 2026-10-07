// The composition root of the portable core: one logger, one link, one
// poller and one test runner, plus sessions, settings and robot profiles.
// Platform adapters are passed in; the UI only talks to this object.

import { RobotLink } from './link/link';
import { Poller } from './link/poller';
import { Logger } from './log/logger';
import { makeSessionId, robotIdFromName, SCHEMA_VERSION, type SessionHeader } from './log/session';
import { newProfile, type RobotProfile } from './model/profile';
import { withDefaults, type Settings } from './settings';
import type { CameraControl, PoseSource } from './tests/camera';
import { TestRunner } from './tests/runner';
import type { TestRun, TestUi } from './tests/types';
import type { Clock, DeviceInfo, LogSink, LogStore, Transport } from './types';
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

  setCalibration(id: string | undefined): void {
    this.header.calibrationId = id;
    this.logger.log('app', { event: 'calibration', detail: id ?? null });
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
}
