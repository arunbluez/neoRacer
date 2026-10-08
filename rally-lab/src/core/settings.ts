import type { BlockingTable } from './link/blocking';
import { DEFAULT_AUTO_SETTINGS, type AutoSettings } from './race/autoRun';
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
  /** Grab pixels and track in a Web Worker (real camera only). */
  trackInWorker: boolean;
  mockRobot: boolean;
  drive: {
    speedCap: number;
    expo: number;
    /** How strongly the stick turns (0..1). */
    turnGain: number;
    /** Stick travel around the centre that counts as zero. */
    deadzone: number;
    /** Map the stick onto [deadband, cap] using the robot profile's deadband. */
    useDeadband: boolean;
    sendHz: number;
    tiltMaxDeg: number;
    lineOverlay: boolean;
  };
  /** Camera-assisted auto run. */
  auto: AutoSettings;
  /** Show the lab tools (Monitor, Console, Tests, Camera) in the tab bar. */
  labTools: boolean;
  /**
   * Turn signals, brake/reverse lights and underglow while driving, start lights and a finish
   * show around auto runs (show); signals during auto runs too (inAuto, experimental).
   */
  lights: { show: boolean; inAuto: boolean };
  /** Laps worth keeping: the settings that drove them, to drive them again. */
  savedLaps: SavedLap[];
  /** Interface: 'race' (the new full-screen race view) or 'classic' (tabs and all the tools). */
  ui: 'race' | 'classic';
};

/** A lap worth keeping: its time, and the auto settings that drove it. */
export type SavedLap = {
  id: string;
  name: string;
  lapMs: number;
  at: string;
  robotId?: string;
  auto: AutoSettings;
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
  // The Robot Rallye mat, seen from the near end (side b).
  matWidthCm: 200,
  matHeightCm: 300,
  // 4:3 uses the whole sensor; 16:9 crops it (and in portrait, to a narrow strip).
  cameraWidth: 1280,
  cameraHeight: 960,
  cameraFps: 30,
  procWidth: 640,
  mmPerPx: 5,
  markerA: { source: 'headlights', rgb: { r: 0, g: 255, b: 0 } },
  // Hues 80–210° never occur on the mat; wood, cones and the battery labels sit at 0–60°.
  markerB: { source: 'underglow', rgb: { r: 0, g: 255, b: 255 } },
  trackingLatencyMs: 150,
  minBlobAreaPx: 4,
  trackInWorker: false,
  mockRobot: false,
  // sendHz 0: send at the write gap (minWriteGapMs)
  drive: { speedCap: 50, expo: 0.3, turnGain: 0.5, deadzone: 0.06, useDeadband: true, sendHz: 0, tiltMaxDeg: 30, lineOverlay: true },
  auto: DEFAULT_AUTO_SETTINGS,
  labTools: false,
  // Signals during auto runs are experimental: headlights changing colour move the light centre the camera tracks.
  lights: { show: true, inAuto: false },
  savedLaps: [],
  ui: 'classic',
};

/** Fill in fields missing from older stored settings. */
export function withDefaults(s: Partial<Settings> | undefined): Settings {
  return {
    ...DEFAULT_SETTINGS,
    ...(s ?? {}),
    drive: { ...DEFAULT_SETTINGS.drive, ...(s?.drive ?? {}) },
    lights: { ...DEFAULT_SETTINGS.lights, ...(s?.lights ?? {}) },
    savedLaps: Array.isArray(s?.savedLaps) ? s.savedLaps : [],
    // Version 2 made arc turns the default; settings saved before that switch over once.
    auto: migrateAuto(s?.auto),
    markerA: { ...DEFAULT_SETTINGS.markerA, ...(s?.markerA ?? {}) },
    markerB: { ...DEFAULT_SETTINGS.markerB, ...(s?.markerB ?? {}) },
    pollerPresets: s?.pollerPresets?.length ? s.pollerPresets : DEFAULT_POLLER_PRESETS,
  };
}

/** Stored auto settings from older versions: 2 made arcs the default, 3 moved to one light colour. */
function migrateAuto(a: Partial<AutoSettings> | undefined): AutoSettings {
  const out = { ...DEFAULT_SETTINGS.auto, ...(a ?? {}) };
  const v = a ? (a.version ?? 1) : DEFAULT_SETTINGS.auto.version ?? 3;
  if (v < 2) out.style = 'arc';
  if (v < 3) {
    out.markerAheadCm = DEFAULT_SETTINGS.auto.markerAheadCm;
    out.markerHeightCm = DEFAULT_SETTINGS.auto.markerHeightCm;
    out.lightColor = DEFAULT_SETTINGS.auto.lightColor;
  }
  out.version = DEFAULT_SETTINGS.auto.version;
  return out;
}

