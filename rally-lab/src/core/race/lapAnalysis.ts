// What each auto run did, section by section, from the session log: how long
// the straights and the turns took, how far off the path the robot got, the
// line sensors' complaints, how well the camera kept up, and where it stopped.
// The quick tune (learner.ts) and the race engineer read this, not the raw
// log; section_trace gives the engineer the detail of one section.

import type { LogEvent } from '../log/events';
import { buildPlan, RALLY_ROUTE, type PathPt, type Plan, type RouteSpec, type TurnStyle } from './route';
import { constantTuning, type Tuning } from './tuning';

export type PartStats = {
  timeMs: number;
  lengthCm: number;
  /** Driven speed (length / time) and the commanded target, cm/s. */
  speedCmS: number;
  targetMeanCmS: number;
  targetMaxCmS: number;
  /** Distance off the path, cm (|e|): worst, mean, 90th percentile. */
  maxOffCm: number;
  meanOffCm: number;
  p90OffCm: number;
  /** Worst heading error, degrees. */
  maxHeadingErrDeg: number;
  /** Line sensors: one sensor off the lane band (a nudge), both black (leaving the lane). */
  lineOne: number;
  lineBoth: number;
  /** Times the robot had to back up and find its way again here (off the lane, stuck, off the path). */
  recoveries: number;
  /** Camera: fixes used, the mean and worst correction they made (cm), the longest gap between fixes (ms). */
  fixes: number;
  corrMeanCm: number;
  corrMaxCm: number;
  camGapMaxMs: number;
};

export type SectionRun = {
  id: string;
  /** The robot got to the section / got through it. */
  reached: boolean;
  completed: boolean;
  timeMs: number;
  straight: PartStats | null;
  turn: PartStats | null;
  /** The run ended in this section (not at the finish). */
  stoppedHere: boolean;
  /** The speeds the tuning asked for here. */
  asked: { straightCmS: number; turnCmS: number };
};

export type RunAnalysis = {
  /** "<session>#<n>", n counting the session's auto runs from 1. */
  id: string;
  sessionId: string;
  n: number;
  /** Session time of the start, ms. */
  t: number;
  finished: boolean;
  reason: string;
  timeMs: number;
  progressCm: number;
  lengthCm: number;
  style: TurnStyle;
  tuning: Tuning;
  /** Whether a lap tuning was in use (false: the constant speeds). */
  tuned: boolean;
  predictedS?: number;
  settleCm: number;
  cameraAssist: boolean;
  sections: SectionRun[];
  stop?: { s: number; section: string; x: number; y: number };
  lineEvents: number;
  fixes?: { total: number; used: number; rejected: number; resets: number };
  learned?: { biasDegS: number; speedScale: number; turnScale: number };
  cam?: { fps: number; matPct: number; robotPct: number };
  /** What the run was driven with (for predictions; not for the engineer's reading). */
  env: RunEnv;
};

/** The settings, motor model and route a run was driven with, from its auto.start. */
export type RunEnv = {
  route: RouteSpec;
  settings: { speedCmS: number; curveSpeedCmS: number; settleCm: number; spinCmd: number; settleMs: number; afterSpinMs: number; maxSpinDeg: number };
  model?: { a: number; b: number; deadband: { lf: number; lb: number; rf: number; rb: number }; trim: number; trimTable?: { cmd: number; trim: number }[]; trackWidthCm: number };
};

type Tick = { t: number; s: number; sec: string; kind: string; e: number; he: number; v: number; cam: number | null; x: number; y: number; turn: boolean };

type RawRun = {
  start: LogEvent;
  ticks: Tick[];
  fixes: { t: number; sec: string; turn: boolean; corr: number; used: boolean }[];
  lines: { t: number; s: number; code: number; sec: string; turn: boolean }[];
  recs: { s: number; sec: string; turn: boolean; why: string }[];
  cams: LogEvent[];
  end?: LogEvent;
  plan: Plan;
  route: RouteSpec;
};

const num = (x: unknown, d = 0): number => (typeof x === 'number' && Number.isFinite(x) ? x : d);
const r1 = (x: number) => Math.round(x * 10) / 10;

/** The plan point at distance s (nearest at or after it). */
function pointAt(plan: Plan, s: number): PathPt | undefined {
  const pts = plan.outline;
  let lo = 0, hi = pts.length - 1;
  if (hi < 0) return undefined;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (pts[mid].s < s) lo = mid + 1;
    else hi = mid;
  }
  return pts[lo];
}

function rawRuns(events: LogEvent[]): RawRun[] {
  const out: RawRun[] = [];
  let cur: RawRun | null = null;
  let lastTick: Tick | undefined;
  for (const e of events) {
    if (e.k === 'auto.start') {
      const st = (e.settings ?? {}) as { route?: RouteSpec; maxSpinDeg?: number };
      const route = st.route ?? RALLY_ROUTE;
      const style = (e.style === 'spin' ? 'spin' : 'arc') as TurnStyle;
      cur = { start: e, ticks: [], fixes: [], lines: [], recs: [], cams: [], plan: buildPlan(route, style, { maxSpinDeg: st.maxSpinDeg }), route };
      out.push(cur);
      lastTick = undefined;
      continue;
    }
    if (!cur) continue;
    if (e.k === 'auto.tick') {
      const s = num(e.s);
      const kind = String(e.kind ?? 'path');
      const p = pointAt(cur.plan, s);
      const tick: Tick = {
        t: e.t, s, sec: String(e.sec ?? p?.section ?? ''), kind, e: num(e.e), he: num(e.he), v: num(e.v),
        cam: typeof e.cam === 'number' ? e.cam : null, x: num(e.x), y: num(e.y), turn: kind === 'spin' || !!p?.turn,
      };
      cur.ticks.push(tick);
      lastTick = tick;
    } else if (e.k === 'auto.fix') {
      if (lastTick) cur.fixes.push({ t: e.t, sec: lastTick.sec, turn: lastTick.turn, corr: Math.hypot(num(e.dx), num(e.dy)), used: !!e.used });
    } else if (e.k === 'auto.line') {
      if (e.ignored || e.rec) continue;
      const s = num(e.s);
      const p = pointAt(cur.plan, s);
      cur.lines.push({ t: e.t, s, code: num(e.code), sec: p?.section ?? lastTick?.sec ?? '', turn: !!p?.turn });
    } else if (e.k === 'auto.recover') {
      const s = num(e.s);
      const p = pointAt(cur.plan, s);
      cur.recs.push({ s, sec: p?.section ?? lastTick?.sec ?? '', turn: !!p?.turn, why: String(e.why ?? '') });
    } else if (e.k === 'auto.cam') {
      cur.cams.push(e);
    } else if (e.k === 'auto.end') {
      cur.end = e;
      cur = null;
    }
  }
  return out;
}

function partStats(ticks: Tick[], fixes: RawRun['fixes'], lines: RawRun['lines'], recs: RawRun['recs'], lengthCm: number, tickMs: number): PartStats | null {
  if (!ticks.length) return null;
  const offs = ticks.filter((t) => t.kind === 'path').map((t) => Math.abs(t.e)).sort((a, b) => a - b);
  const timeMs = ticks.length * tickMs;
  const used = fixes.filter((f) => f.used);
  const corr = used.map((f) => f.corr);
  return {
    timeMs: Math.round(timeMs),
    lengthCm: r1(lengthCm),
    speedCmS: r1(timeMs > 0 ? lengthCm / (timeMs / 1000) : 0),
    targetMeanCmS: r1(ticks.reduce((a, t) => a + t.v, 0) / ticks.length),
    targetMaxCmS: r1(Math.max(...ticks.map((t) => t.v))),
    maxOffCm: r1(offs.length ? offs[offs.length - 1] : 0),
    meanOffCm: r1(offs.length ? offs.reduce((a, b) => a + b, 0) / offs.length : 0),
    p90OffCm: r1(offs.length ? offs[Math.min(offs.length - 1, Math.floor(0.9 * offs.length))] : 0),
    maxHeadingErrDeg: r1(Math.max(0, ...ticks.filter((t) => t.kind === 'path').map((t) => Math.abs(t.he)))),
    lineOne: lines.filter((l) => l.code === 1 || l.code === 2).length,
    lineBoth: lines.filter((l) => l.code === 3).length,
    recoveries: recs.length,
    fixes: used.length,
    corrMeanCm: r1(corr.length ? corr.reduce((a, b) => a + b, 0) / corr.length : 0),
    corrMaxCm: r1(corr.length ? Math.max(...corr) : 0),
    camGapMaxMs: Math.round(Math.max(0, ...ticks.map((t) => t.cam ?? 0))),
  };
}

/** Every auto run in a session's events, analysed. */
export function analyzeRuns(events: LogEvent[], sessionId = ''): RunAnalysis[] {
  return rawRuns(events).map((raw, i) => analyzeRun(raw, sessionId, i + 1));
}

function analyzeRun(raw: RawRun, sessionId: string, n: number): RunAnalysis {
  const st = (raw.start.settings ?? {}) as {
    tuning?: Tuning; speedCmS?: number; curveSpeedCmS?: number; settleCm?: number; cameraAssist?: boolean; tickMs?: number;
    spinCmd?: number; settleMs?: number; afterSpinMs?: number; maxSpinDeg?: number;
  };
  const base = { speedCmS: st.speedCmS ?? 22, curveSpeedCmS: st.curveSpeedCmS ?? 30 };
  const ids = raw.route.sections.map((s) => s.id);
  const tuning = st.tuning ?? constantTuning(base, ids);
  const end = (raw.end ?? {}) as { reason?: string; finished?: boolean; timeMs?: number; progressCm?: number; lengthCm?: number; fixes?: RunAnalysis['fixes']; learned?: RunAnalysis['learned']; lineEvents?: number };
  const tickMs = num(st.tickMs, 40);
  const finished = !!end.finished;
  const lastTick = raw.ticks[raw.ticks.length - 1];
  // Lengths of each section's straights and turns along the plan.
  const len = new Map<string, { straight: number; turn: number }>();
  const pts = raw.plan.outline;
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i];
    const l = len.get(p.section) ?? { straight: 0, turn: 0 };
    l[p.turn ? 'turn' : 'straight'] += p.s - pts[i - 1].s;
    len.set(p.section, l);
  }
  const progress = finished ? raw.plan.lengthCm : num(end.progressCm, lastTick?.s ?? 0);
  const sections: SectionRun[] = ids.map((id) => {
    const ticks = raw.ticks.filter((t) => t.sec === id);
    const startS = raw.plan.sectionStarts.find((x) => x.id === id)?.s ?? 0;
    const next = raw.plan.sectionStarts[raw.plan.sectionStarts.findIndex((x) => x.id === id) + 1];
    const endS = next ? next.s : raw.plan.lengthCm;
    const reached = ticks.length > 0;
    const completed = finished || progress >= endS - 1;
    const asked = tuning.sections[id] ?? constantTuning(base, [id]).sections[id];
    const L = len.get(id) ?? { straight: 0, turn: 0 };
    // A section only partly driven: count the distance driven.
    const frac = completed ? 1 : Math.max(0, Math.min(1, (progress - startS) / Math.max(1, endS - startS)));
    const sTicks = ticks.filter((t) => !t.turn), tTicks = ticks.filter((t) => t.turn);
    const fx = raw.fixes.filter((f) => f.sec === id), ln = raw.lines.filter((l) => l.sec === id), rc = raw.recs.filter((x) => x.sec === id);
    return {
      id,
      reached,
      completed: reached && completed,
      timeMs: reached ? Math.round(ticks[ticks.length - 1].t - ticks[0].t + tickMs) : 0,
      straight: partStats(sTicks, fx.filter((f) => !f.turn), ln.filter((l) => !l.turn), rc.filter((x) => !x.turn), L.straight * frac, tickMs),
      turn: partStats(tTicks, fx.filter((f) => f.turn), ln.filter((l) => l.turn), rc.filter((x) => x.turn), L.turn * frac, tickMs),
      stoppedHere: !finished && reached && !completed && lastTick?.sec === id,
      asked: { straightCmS: asked.straightCmS, turnCmS: asked.turnCmS },
    };
  });
  const profile = raw.start.profile as { predictedS?: number } | undefined;
  const cams = raw.cams;
  const avg = (k: string) => (cams.length ? Math.round(cams.reduce((a, c) => a + num(c[k]), 0) / cams.length) : 0);
  return {
    id: `${sessionId}#${n}`,
    sessionId,
    n,
    t: raw.start.t,
    finished,
    reason: end.reason ?? (raw.end ? '?' : 'no end in the log'),
    timeMs: num(end.timeMs, lastTick ? lastTick.t - raw.start.t : 0),
    progressCm: r1(progress),
    lengthCm: r1(raw.plan.lengthCm),
    style: raw.plan.style,
    tuning,
    tuned: !!st.tuning,
    predictedS: profile?.predictedS,
    settleCm: st.tuning?.settleCm ?? st.settleCm ?? 25,
    cameraAssist: st.cameraAssist !== false,
    sections,
    stop: !finished && lastTick ? { s: r1(lastTick.s), section: lastTick.sec, x: r1(lastTick.x), y: r1(lastTick.y) } : undefined,
    lineEvents: num(end.lineEvents, raw.lines.length),
    fixes: end.fixes,
    learned: end.learned,
    cam: cams.length ? { fps: avg('fps'), matPct: avg('matPct'), robotPct: avg('robotPct') } : undefined,
    env: {
      route: raw.route,
      settings: {
        ...base, settleCm: st.settleCm ?? 25, spinCmd: st.spinCmd ?? 24, settleMs: st.settleMs ?? 120, afterSpinMs: st.afterSpinMs ?? 200, maxSpinDeg: st.maxSpinDeg ?? 45,
      },
      model: raw.start.model as RunEnv['model'],
    },
  };
}

/** A run without its environment: what the engineer reads. */
export function runForEngineer(r: RunAnalysis): Omit<RunAnalysis, 'env' | 'tuning' | 'sessionId' | 'n' | 't'> & { tuning: string } {
  const { env: _env, tuning, sessionId: _s, n: _n, t: _t, ...rest } = r;
  return { ...rest, tuning: tuning.label };
}

/** One section of one run in detail, every ~stepCm: for the engineer's section_trace tool. */
export function sectionTrace(events: LogEvent[], runN: number, sectionId: string, stepCm = 4): {
  points: { s: number; part: 'straight' | 'turn' | 'spin'; off: number; headingErr: number; target: number; camAgeMs: number | null }[];
  lines: { s: number; code: number }[];
  fixes: { atS: number; corrCm: number; used: boolean }[];
} | null {
  const raw = rawRuns(events)[runN - 1];
  if (!raw) return null;
  const ticks = raw.ticks.filter((t) => t.sec === sectionId);
  const points: NonNullable<ReturnType<typeof sectionTrace>>['points'] = [];
  let lastS = -Infinity;
  for (const t of ticks) {
    if (t.s - lastS < stepCm && t.kind !== 'spin') continue;
    lastS = t.s;
    points.push({ s: r1(t.s), part: t.kind === 'spin' ? 'spin' : t.turn ? 'turn' : 'straight', off: r1(t.e), headingErr: r1(t.he), target: r1(t.v), camAgeMs: t.cam });
  }
  const sOfT = (t: number) => {
    let best: Tick | undefined;
    for (const k of ticks) if (k.t <= t) best = k;
    return best ? r1(best.s) : NaN;
  };
  return {
    points,
    lines: raw.lines.filter((l) => l.sec === sectionId).map((l) => ({ s: r1(l.s), code: l.code })),
    fixes: raw.fixes.filter((f) => f.sec === sectionId).map((f) => ({ atS: sOfT(f.t), corrCm: r1(f.corr), used: f.used })),
  };
}
