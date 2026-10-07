// Interfaces the portable core depends on. Adapters implement them per
// platform (Web today, React Native later); nothing in src/core touches a
// browser API directly.

import type { LogEvent } from './log/events';

export type LinkState = 'connecting' | 'connected' | 'disconnected';

export interface DeviceInfo {
  name: string;
  id: string;
}

export interface Transport {
  /** Ask the user to pick a robot and open the GATT link. */
  connect(): Promise<DeviceInfo>;
  /** Re-open the link to the device picked earlier, without a chooser. */
  reconnect?(): Promise<DeviceInfo>;
  disconnect(): Promise<void>;
  /** Resolves when the GATT write completes. */
  write(bytes: Uint8Array): Promise<void>;
  onData(cb: (chunk: Uint8Array, tMs: number) => void): () => void;
  onState(cb: (s: LinkState, reason?: string) => void): () => void;
  /** Which GATT write mode is in use, once known. */
  readonly writeMode?: 'withoutResponse' | 'withResponse';
  readonly kind: 'web-bluetooth' | 'mock';
}

export interface Clock {
  now(): number;
}

export interface StoredImage {
  id: string;
  sessionId?: string;
  calibrationId?: string;
  name: string;
  mime: string;
  bytes: Uint8Array;
  createdAt: string;
}

export interface LogStore {
  append(sessionId: string, batch: LogEvent[]): Promise<void>;
  putSession(header: import('./log/session').SessionHeader): Promise<void>;
  getSession(id: string): Promise<import('./log/session').SessionHeader | undefined>;
  listSessions(): Promise<import('./log/session').SessionSummary[]>;
  deleteSession(id: string): Promise<void>;
  events(sessionId: string): Promise<LogEvent[]>;
  countEvents(sessionId: string): Promise<number>;

  putTestRun(run: import('./tests/types').TestRun): Promise<void>;
  listTestRuns(sessionId?: string): Promise<import('./tests/types').TestRun[]>;

  getProfile(robotId: string): Promise<import('./model/profile').RobotProfile | undefined>;
  putProfile(profile: import('./model/profile').RobotProfile): Promise<void>;
  listProfiles(): Promise<import('./model/profile').RobotProfile[]>;

  putCalibration(cal: import('./vision/calibration').TrackCalibration): Promise<void>;
  getCalibration(id: string): Promise<import('./vision/calibration').TrackCalibration | undefined>;
  listCalibrations(): Promise<import('./vision/calibration').TrackCalibration[]>;

  putImage(img: StoredImage): Promise<void>;
  getImage(id: string): Promise<StoredImage | undefined>;
  listImages(filter: { sessionId?: string; calibrationId?: string }): Promise<StoredImage[]>;
}

export interface CameraOpts {
  deviceId?: string;
  width: number;
  height: number;
  fps: number;
  /** Frames are scaled to this width before they reach onFrame. */
  procWidth: number;
}

/** RGBA pixels, row-major, 4 bytes per pixel. */
export type Frame = {
  width: number;
  height: number;
  data: Uint8ClampedArray;
  tCaptureMs: number;
  /** Time spent getting the pixels (draw + read back), ms, when the source measures it. */
  grabMs?: number;
};

export interface FrameSource {
  start(opts: CameraOpts): Promise<void>;
  onFrame(cb: (f: Frame) => void): () => void;
  stop(): void;
}

/** Sinks receive every flushed batch of log events (IndexedDB, dev sync). */
export interface LogSink {
  name: string;
  write(sessionId: string, batch: LogEvent[]): Promise<void>;
}
