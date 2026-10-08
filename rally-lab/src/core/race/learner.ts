// Quick tune: the next lap's tuning from the last run, by plain rules, on the
// phone, offline. A part of a section (its straights, its turns) that the
// robot drove cleanly gets faster; one where it wandered or the line sensors
// complained stays or gets slower; where it left the lane gets clearly slower,
// and so does the braking into it. Raises are small (the step limit in
// tuning.ts caps them anyway) so a few clean laps creep up on the limit.
// The race engineer starts from this too, as a baseline it can argue with.

import type { PartStats, RunAnalysis } from './lapAnalysis';
import { clampTuning, type Tuning } from './tuning';

export type QuickTuneRules = {
  /** Clean: worst distance off the path below this, cm, and no line events. */
  cleanOffCm: number;
  /** Bad: worst distance off above this, cm. */
  badOffCm: number;
  /** Speed factors for clean straights and turns, bad parts, and the part it left the lane in. */
  upStraight: number;
  upTurn: number;
  down: number;
  crash: number;
  /** Don't speed up a part where the camera lost the robot for this long (ms) and then had to correct it by more than cleanOffCm. */
  camGapMs: number;
};

export const DEFAULT_RULES: QuickTuneRules = {
  cleanOffCm: 4,
  badOffCm: 7.5,
  upStraight: 1.15,
  upTurn: 1.08,
  down: 0.9,
  crash: 0.85,
  camGapMs: 900,
};

export type QuickTune = { tuning: Tuning; reasons: string[]; warnings: string[]; basedOn: string };

type Verdict = 'clean' | 'ok' | 'bad' | 'none';

function judge(p: PartStats | null, r: QuickTuneRules): { v: Verdict; why: string } {
  if (!p || p.timeMs === 0) return { v: 'none', why: '' };
  if (p.recoveries > 0) return { v: 'bad', why: `had to back up and find the route ${p.recoveries}×` };
  if (p.lineBoth > 0) return { v: 'bad', why: `both line sensors black ${p.lineBoth}×` };
  if (p.maxOffCm > r.badOffCm) return { v: 'bad', why: `${p.maxOffCm} cm off the path` };
  if (p.lineOne >= 3) return { v: 'bad', why: `line sensor nudges ${p.lineOne}×` };
  if (p.maxOffCm > r.cleanOffCm || p.lineOne > 0) return { v: 'ok', why: `${p.maxOffCm} cm off${p.lineOne ? `, ${p.lineOne} nudge(s)` : ''}` };
  // Blind for a while (the bridge) and the camera then had to move the estimate a lot: it may have wandered unseen.
  if (p.camGapMaxMs > r.camGapMs && p.corrMaxCm > r.cleanOffCm) {
    return { v: 'ok', why: `camera lost it for ${(p.camGapMaxMs / 1000).toFixed(1)} s, then corrected ${p.corrMaxCm} cm` };
  }
  return { v: 'clean', why: `clean (${p.maxOffCm} cm worst)` };
}

const r1 = (x: number) => Math.round(x * 10) / 10;

/**
 * Next tuning from the latest run. `current` is the tuning in use as the
 * robot really drives it (effectiveTuning), so a raise starts from the speed
 * the robot actually did.
 */
export function quickTune(run: RunAnalysis, current: Tuning, n: number, rules: QuickTuneRules = DEFAULT_RULES): QuickTune {
  const next: Tuning = {
    ...current,
    sections: Object.fromEntries(Object.entries(current.sections).map(([k, v]) => [k, { ...v }])),
    label: `quick ${n}`,
    source: 'quick',
  };
  const reasons: string[] = [];
  let brake = false;
  let allClean = run.finished;
  for (const sec of run.sections) {
    const sp = next.sections[sec.id];
    if (!sp) continue;
    if (!sec.reached) {
      reasons.push(`${sec.id}: not reached, unchanged`);
      allClean = false;
      continue;
    }
    if (sec.stoppedHere) {
      // Where it stopped: the part it was in, plus braking if that was a turn.
      const inTurn = !!sec.turn && (!sec.straight || (sec.turn.maxOffCm >= sec.straight.maxOffCm));
      if (inTurn) {
        sp.turnCmS = r1(sp.turnCmS * rules.crash);
        brake = true;
        reasons.push(`${sec.id}: stopped in a turn (${run.reason}): turns ×${rules.crash}, brake earlier`);
      } else {
        sp.straightCmS = r1(sp.straightCmS * rules.crash);
        reasons.push(`${sec.id}: stopped on a straight (${run.reason}): straights ×${rules.crash}`);
      }
      allClean = false;
      continue;
    }
    const s = judge(sec.straight, rules);
    // Spin style: the turns are spins on the spot, the turn speeds don't apply.
    const t = run.style === 'spin' ? { v: 'none' as Verdict, why: '' } : judge(sec.turn, rules);
    if (s.v === 'clean' && sec.completed) sp.straightCmS = r1(sp.straightCmS * rules.upStraight);
    else if (s.v === 'bad') sp.straightCmS = r1(sp.straightCmS * rules.down);
    if (t.v === 'clean' && sec.completed) sp.turnCmS = r1(sp.turnCmS * rules.upTurn);
    else if (t.v === 'bad') {
      sp.turnCmS = r1(sp.turnCmS * rules.down);
      // Wide in a turn after a fast straight: brake earlier too.
      if ((sec.straight?.targetMaxCmS ?? 0) > (sec.turn?.targetMeanCmS ?? 0) + 8) brake = true;
    }
    if (s.v !== 'clean' || (t.v !== 'clean' && t.v !== 'none')) allClean = false;
    const say = (v: Verdict, why: string, up: number) => (v === 'clean' ? `${why} → ×${up}` : v === 'bad' ? `${why} → ×${rules.down}` : v === 'ok' ? `${why} → hold` : '');
    const parts = [s.v !== 'none' ? `straights ${say(s.v, s.why, rules.upStraight)}` : '', t.v !== 'none' ? `turns ${say(t.v, t.why, rules.upTurn)}` : ''].filter(Boolean);
    reasons.push(`${sec.id}: ${parts.join('; ')}`);
  }
  if (brake) {
    next.decelCmS2 = r1(current.decelCmS2 * 0.8);
    reasons.push(`braking limit → ${next.decelCmS2} cm/s² (brake earlier into turns)`);
  } else if (allClean) {
    next.decelCmS2 = r1(current.decelCmS2 * 1.1);
    next.accelCmS2 = r1(current.accelCmS2 * 1.1);
    reasons.push('every section clean: accelerate and brake a little harder');
  }
  const { tuning, warnings } = clampTuning(next, current, Object.keys(current.sections));
  // A strong pull is the motor numbers, not the speeds: slowing down doesn't cure it.
  const b = run.learned?.biasDegS ?? 0;
  if (Math.abs(b) > 12) {
    warnings.unshift(`The robot pulled ${Math.abs(b)} °/s to the ${b > 0 ? 'right' : 'left'}: its motor numbers are off. Run Deadband (T3.1) and Straight check (T3.7) first; slower won't fix a pull (a weak wheel stalls sooner).`);
  }
  return { tuning: { ...tuning, label: `quick ${n}`, source: 'quick' }, reasons, warnings, basedOn: run.id };
}
