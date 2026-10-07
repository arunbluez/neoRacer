import type { Settings } from '../settings';
import type { RobotProfile } from '../model/profile';

export const SCHEMA_VERSION = 1;

export type SessionHeader = {
  schemaVersion: number;
  id: string;
  /** Wall-clock start, ISO 8601. */
  startedAt: string;
  buildId: string;
  buildTime: string;
  userAgent: string;
  screen: { w: number; h: number; dpr: number };
  /** The robot the session is about (first one connected). */
  robot?: { name: string; id: string };
  /** Every robot connected during the session, with session time. */
  robots: { name: string; id: string; t: number }[];
  transport: string;
  settings: Settings;
  profile?: RobotProfile;
  calibrationId?: string;
  /** Wall-clock time of the last flush, ISO 8601. */
  updatedAt?: string;
};

export type SessionSummary = SessionHeader & { eventCount: number; testRunCount: number };

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** `YYYYMMDD-HHMMSS-<robotId>`, local time. */
export function makeSessionId(date: Date, robotId: string | undefined): string {
  const d = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
  const t = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  const rid = (robotId ?? 'none').replace(/[^A-Za-z0-9]/g, '').slice(0, 16) || 'none';
  return `${d}-${t}-${rid}`;
}

/** The 5-letter id inside `BBC micro:bit [popuv]`, or a sanitised fallback. */
export function robotIdFromName(name: string): string {
  const m = /\[([A-Za-z]+)\]/.exec(name);
  if (m) return m[1].toLowerCase();
  const clean = name.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
  return clean.slice(-8) || 'unknown';
}
