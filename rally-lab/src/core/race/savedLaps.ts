// Laps worth keeping: when a lap goes well, its settings (speed, turn style,
// lap tuning, cone dodges, lights, …) are saved with its time, to drive the
// same way again later, whatever was tried in between.

import type { SavedLap } from '../settings';
import type { AutoSettings, AutoSummary } from './autoRun';

/** The settings that drove a lap, without the bookkeeping (undo, race pick). */
export function snapshotAuto(a: AutoSettings): AutoSettings {
  const { tuningPrev: _p, raceTuning: _r, ...rest } = a;
  return JSON.parse(JSON.stringify(rest)) as AutoSettings;
}

/** A saved lap from a finished run and the settings it drove with. */
export function makeSavedLap(o: { summary: AutoSummary; settings: AutoSettings; robotId?: string; at: Date }): SavedLap {
  const s = o.settings;
  const how = s.tuning ? s.tuning.label : `${s.speedCmS} cm/s`;
  const hh = String(o.at.getHours()).padStart(2, '0'), mm = String(o.at.getMinutes()).padStart(2, '0');
  return {
    id: `lap-${o.at.getTime()}`,
    name: `${(o.summary.timeMs / 1000).toFixed(1)} s · ${how} · ${hh}:${mm}`,
    lapMs: o.summary.timeMs,
    at: o.at.toISOString(),
    robotId: o.robotId,
    auto: snapshotAuto(s),
  };
}

/** Drive like the saved lap: its settings, keeping where the camera views from. */
export function applySavedLap(current: AutoSettings, lap: SavedLap): AutoSettings {
  return { ...current, ...snapshotAuto(lap.auto), matRot: current.matRot, tuningPrev: current.tuning, raceTuning: current.raceTuning };
}

/** Saved laps, best first; a new one replaces nothing (up to `max`, the slowest go first). */
export function addSavedLap(list: SavedLap[], lap: SavedLap, max = 12): SavedLap[] {
  return [...list, lap].sort((a, b) => a.lapMs - b.lapMs).slice(0, max);
}
