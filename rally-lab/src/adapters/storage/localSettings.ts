import { withDefaults, type Settings } from '../../core/settings';

const KEY = 'rally-lab.settings.v1';
const ROBOT_KEY = 'rally-lab.lastRobotId';

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    return withDefaults(raw ? (JSON.parse(raw) as Partial<Settings>) : undefined);
  } catch {
    return withDefaults(undefined);
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // storage blocked: settings stay in memory
  }
}

export function loadLastRobotId(): string | undefined {
  try {
    return localStorage.getItem(ROBOT_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

export function saveLastRobotId(id: string): void {
  try {
    localStorage.setItem(ROBOT_KEY, id);
  } catch {
    // ignore
  }
}
