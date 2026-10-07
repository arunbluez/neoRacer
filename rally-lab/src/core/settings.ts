import type { BlockingTable } from './link/blocking';
import type { Rgb } from './protocol/commands';

export type PollerEntry = { cmd: string; hz: number };
export type PollerPreset = { name: string; entries: PollerEntry[] };

export type MarkerSource = 'headlights' | 'headlightLeft' | 'headlightRight' | 'underglow';

/** Colour model of a marker as seen by the camera (see vision/color MarkerColor). */
export type MarkerHsv = { h: number; s: number; v: number; hTol: number; sMin: number; vMin: number };

export type MarkerSpec = { source: MarkerSource; rgb: Rgb; hsv?: MarkerHsv };

export type Settings = {
  minWriteGapMs: number;
  replyTimeoutMs: number;
  packWrites: boolean;
  /** Per-command block times, applied on top of the robot profile's measured table. */
  blockingOverrides: BlockingTable;
  pollerPresets: PollerPreset[];
  matWidthCm: number;
  matHeightCm: number;
  cameraId?: string;
  cameraWidth: number;
  cameraHeight: number;
  cameraFps: number;
  procWidth: number;
  mmPerPx: number;
  markerA: MarkerSpec;
  markerB: MarkerSpec;
  /** Forward prediction for the tracker; defaults from T4.5. */
  trackingLatencyMs: number;
  minBlobAreaPx: number;
  mockRobot: boolean;
  drive: { speedCap: number; expo: number; sendHz: number; tiltMaxDeg: number; lineOverlay: boolean };
};

export const DEFAULT_POLLER_PRESETS: PollerPreset[] = [
  { name: 'Off', entries: [] },
  { name: 'Ping 2 Hz', entries: [{ cmd: 'PING', hz: 2 }] },
  { name: 'Monitor', entries: [{ cmd: '?LINE', hz: 10 }, { cmd: '?ACCEL', hz: 5 }, { cmd: 'PING', hz: 2 }, { cmd: '?DIST', hz: 2 }] },
  { name: 'Line 20 Hz', entries: [{ cmd: '?LINE', hz: 20 }, { cmd: 'PING', hz: 2 }] },
  { name: 'Everything', entries: [
    { cmd: '?LINE', hz: 10 }, { cmd: '?ACCEL', hz: 5 }, { cmd: '?DIST', hz: 2 }, { cmd: '?LIGHT', hz: 1 },
    { cmd: '?TEMP', hz: 0.5 }, { cmd: 'PING', hz: 2 },
  ] },
];

export const DEFAULT_SETTINGS: Settings = {
  minWriteGapMs: 30,
  replyTimeoutMs: 500,
  packWrites: false,
  blockingOverrides: {},
  pollerPresets: DEFAULT_POLLER_PRESETS,
  matWidthCm: 300,
  matHeightCm: 250,
  cameraWidth: 1280,
  cameraHeight: 720,
  cameraFps: 30,
  procWidth: 640,
  mmPerPx: 5,
  markerA: { source: 'headlights', rgb: { r: 0, g: 255, b: 0 } },
  markerB: { source: 'underglow', rgb: { r: 255, g: 200, b: 0 } },
  trackingLatencyMs: 150,
  minBlobAreaPx: 6,
  mockRobot: false,
  drive: { speedCap: 70, expo: 0.4, sendHz: 25, tiltMaxDeg: 30, lineOverlay: true },
};

/** Fill in fields missing from older stored settings. */
export function withDefaults(s: Partial<Settings> | undefined): Settings {
  return {
    ...DEFAULT_SETTINGS,
    ...(s ?? {}),
    drive: { ...DEFAULT_SETTINGS.drive, ...(s?.drive ?? {}) },
    markerA: { ...DEFAULT_SETTINGS.markerA, ...(s?.markerA ?? {}) },
    markerB: { ...DEFAULT_SETTINGS.markerB, ...(s?.markerB ?? {}) },
    pollerPresets: s?.pollerPresets?.length ? s.pollerPresets : DEFAULT_POLLER_PRESETS,
  };
}
