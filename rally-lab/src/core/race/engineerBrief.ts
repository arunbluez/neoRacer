// What the race engineer (Claude) is told: who it is, how the robot drives,
// the knobs and their limits, and the runs so far (lapAnalysis), with the
// quick tune's suggestion as a baseline to argue with. Plus the two tools it
// can call while it thinks (a lap prediction for a candidate tuning, and the
// detail of one section of one run) and the shape of the answer. Shared by the
// laptop command (engineer/), which calls Claude through the Agent SDK, and the
// app's "Copy brief" (paste into the Claude app; no tools there).

import { checkPlan, PLAN_KIND, type EngineerPlan } from './engineerPlan';
import { runForEngineer, type RunAnalysis } from './lapAnalysis';
import { quickTune } from './learner';
import { minWheelSpeed, motorModel, wheelSpeed, type MotorModel } from './motor';
import { buildPlan, type RouteSpec, type TurnStyle } from './route';
import { buildSpeedProfile, effectiveTuning, type SpeedProfile } from './speedProfile';
import { clampTuning, MAX_STEP, TUNING_LIMITS, type Tuning } from './tuning';

export type EngineerContext = {
  route: RouteSpec;
  style: TurnStyle;
  model: MotorModel;
  settings: RunAnalysis['env']['settings'];
  /** The tuning in use, as driven (speeds raised to what the wheels can do). */
  current: Tuning;
  profile: SpeedProfile;
  /** The label the new plan's tuning gets. */
  label: string;
  runs: RunAnalysis[];
};

/** Context from the runs (the latest one sets the route, settings, model and tuning). */
export function engineerContext(runs: RunAnalysis[]): EngineerContext {
  if (!runs.length) throw new Error('No auto runs in these logs.');
  const last = runs[runs.length - 1];
  const env = last.env;
  const model = env.model ? motorModel(undefined, { ...env.model }) : motorModel();
  const plan = buildPlan(env.route, last.style, { maxSpinDeg: env.settings.maxSpinDeg });
  const raw = { ...last.tuning, settleCm: last.tuning.settleCm ?? env.settings.settleCm };
  const current = effectiveTuning(raw, buildSpeedProfile(plan, raw, model, env.settings));
  const profile = buildSpeedProfile(plan, current, model, env.settings);
  const n = 1 + runs.filter((r) => r.tuning.source === 'engineer').map((r) => r.tuning.label).filter((l, i, a) => a.indexOf(l) === i).length;
  return { route: env.route, style: last.style, model, settings: env.settings, current, profile, label: `engineer ${n}`, runs };
}

/** Lap prediction for a candidate tuning, as the engineer's predict_lap tool answers it. */
export function predictLap(ctx: EngineerContext, candidate: Tuning): {
  predictedS: number;
  currentPredictedS: number;
  sections: { id: string; timeS: number; vMax: number; floorBinds: boolean; gripBinds: boolean }[];
  /** The tuning after the limits and the step limit (what the app would really apply). */
  applied: Tuning;
  warnings: string[];
} {
  const ids = ctx.route.sections.map((s) => s.id);
  const full = { ...candidate, sections: { ...ctx.current.sections, ...candidate.sections }, label: ctx.label, source: 'engineer' as const };
  const { tuning, warnings } = clampTuning(full, ctx.current, ids);
  const plan = buildPlan(ctx.route, ctx.style, { maxSpinDeg: ctx.settings.maxSpinDeg });
  const p = buildSpeedProfile(plan, tuning, ctx.model, ctx.settings);
  return {
    predictedS: p.predictedS,
    currentPredictedS: ctx.profile.predictedS,
    sections: p.sections.map((s) => ({ id: s.id, timeS: s.timeS, vMax: s.vMax, floorBinds: s.floorBinds, gripBinds: s.gripBinds })),
    applied: tuning,
    warnings,
  };
}

/** The route as the engineer reads it: sections and their parts (index, kind, size). */
function routeForEngineer(route: RouteSpec) {
  return {
    lapCm: undefined as number | undefined,
    laneWidthCm: route.laneWidthCm,
    sections: route.sections.map((s) => ({
      id: s.id,
      note: s.note,
      parts: s.parts.map((p, i) => (p.kind === 'straight'
        ? { part: i, straightCm: p.lengthCm, ...(p.offsets ? { coneDodges: p.offsets } : {}) }
        : { part: i, turnDeg: p.deg, radiusCm: p.radiusCm, dir: p.deg > 0 ? 'right' : 'left' })),
    })),
  };
}

const L = TUNING_LIMITS;

/** The engineer's standing instructions (system prompt). */
export function engineerSystem(ctx: EngineerContext): string {
  const vMin = Math.max(minWheelSpeed(ctx.model, 'L'), minWheelSpeed(ctx.model, 'R'));
  const vTop = wheelSpeed(ctx.model, 70, 'L');
  return `You are the race engineer for a small two-wheeled robot (a Cutebot, ${ctx.model.trackWidthCm} cm between the wheels) racing a fixed route on a 200 × 300 cm mat. The robot drives itself; you never drive it. After each practice lap you read what happened and set the next lap's tuning so the lap time goes down without the robot leaving the lane. In the final there is one timed attempt: a lap that doesn't finish is far worse than a slow one, so your aim is the fastest tuning that finishes reliably, reached in steps.

How it drives
- The route is track code: sections a–g of straights and turns (arcs of a given radius). A follower steers the robot along it from an estimate of where it is (wheel commands, corrected by a hand-held phone camera that sees the robot's lights). Line sensors stop it if it leaves the lane; it also stops when the camera shows it 18 cm off the path.
- The lane is ${ctx.route.laneWidthCm} cm wide: ±${ctx.route.laneWidthCm / 2} cm from the path. Up to ~4 cm off is clean, 4–7.5 cm is a warning, beyond that it is close to leaving.
- Speed comes from your tuning: a straight speed and a turn speed per section, how fast the speed may rise (acceleration) and fall (braking, which makes it slow down early enough before a turn), and a grip limit for turns (v² ≤ grip·radius). A profile built from these gives the target speed everywhere; the robot follows it.
- Physics you can't tune away: the slowest the robot can go is ~${vMin.toFixed(1)} cm/s (motor deadband) and the fastest ~${vTop.toFixed(0)} cm/s. In a tight turn the inner wheel must keep turning, so the robot has to go at least (slowest speed)/(1 − ${ctx.model.trackWidthCm}/(2·radius)): ~35 cm/s in the zigzag's 13 cm hairpins. A turn speed below that changes nothing ("floorBinds").
- The bridge over section c hides the robot from the camera for about a second; the estimate then runs blind and the camera corrects it after.

The knobs and their limits
- straightCmS ${L.straightCmS[0]}–${L.straightCmS[1]}, turnCmS ${L.turnCmS[0]}–${L.turnCmS[1]} per section; accelCmS2 ${L.accelCmS2[0]}–${L.accelCmS2[1]}; decelCmS2 ${L.decelCmS2[0]}–${L.decelCmS2[1]}; latAccelCmS2 (grip) ${L.latAccelCmS2[0]}–${L.latAccelCmS2[1]}; settleCm (steering: distance over which a sideways error is corrected; smaller = sharper, can oscillate) ${L.settleCm[0]}–${L.settleCm[1]}.
- What the limits mean: a higher decelCmS2 brakes later and harder before a turn (faster, riskier); a lower one starts braking earlier (safer). A higher accelCmS2 gets up to speed sooner out of a turn. A lower latAccelCmS2 slows the wide turns.
- One lap may raise any number by at most ${MAX_STEP * 100} % of its current value (the app enforces it); lowering is always allowed.
- The current values are the speeds the robot really drove (already raised to its physical minimums).

How to work
- Read the runs. Per section you get the straights and the turns separately: time, length, driven speed, target speed, distance off the path (worst, mean, 90th percentile), heading error, line sensor events (one sensor = a nudge back, both = leaving the lane), camera fixes, how much the camera had to correct the estimate, and the longest camera gap. A run that stopped says where.
- Fix what failed first: where it stopped or a sensor saw both black, slow that part down and brake earlier into it; don't raise anything right after a failure in that section.
- Raise what was clean, most where the clock gains most: long straights first (c, then b, d, g), then braking/acceleration, turns last and in smaller steps. Mind the turn floors: raising a turn speed below its floor gains nothing.
- Wide in a turn after a fast straight usually means braking too late (lower decelCmS2) rather than a slow turn.
- Use predict_lap to check candidate tunings: it gives the lap time the profile predicts, per section, and what the app's limits would make of your numbers. Use section_trace when a section's numbers don't explain themselves.
- Route edits (track code) only when several runs show the same geometric error in the same place with good camera coverage, e.g. always turning late at the same corner. Straights: lengthCm; turns: radiusCm; at most 15 % or 15 cm per step; turn angles never change (the mat fixes them). Most of the time: no route edits.
- Say what the next lap should watch.
- Write for the person at the track: short, concrete, in plain words. Numbers in cm, cm/s, s.

Answer with the structured output only: the complete next tuning (every section), the changes with reasons, route edits (usually none), what to watch, the predicted lap time from predict_lap, and your confidence.`;
}

/** The data for this round (the user message). */
export function engineerPrompt(ctx: EngineerContext): string {
  const last = ctx.runs[ctx.runs.length - 1];
  const quick = quickTune(last, ctx.current, 0);
  const finishedRuns = ctx.runs.filter((r) => r.finished && r.predictedS);
  const calib = finishedRuns.length
    ? finishedRuns.map((r) => ({ run: r.id, predictedS: r.predictedS, actualS: Math.round(r.timeMs / 100) / 10 }))
    : [];
  const route = routeForEngineer(ctx.route);
  route.lapCm = Math.round(ctx.profile.s[ctx.profile.s.length - 1] ?? 0);
  const data = {
    route,
    turnStyle: ctx.style,
    currentTuning: { ...ctx.current, createdAt: undefined },
    currentPrediction: { predictedS: ctx.profile.predictedS, sections: ctx.profile.sections },
    predictionVsActual: calib,
    runs: ctx.runs.map(runForEngineer),
    quickTuneBaseline: { tuning: quick.tuning.sections, accelCmS2: quick.tuning.accelCmS2, decelCmS2: quick.tuning.decelCmS2, reasons: quick.reasons },
    newTuningLabel: ctx.label,
  };
  return `Runs so far (oldest first; the last one is the latest lap, driven with the current tuning). Set the next lap's tuning.

${JSON.stringify(data)}`;
}

/** JSON schema of the engineer's answer (structured output). */
export function planSchema(sectionIds: string[]): Record<string, unknown> {
  const num = (description: string) => ({ type: 'number', description });
  const sec = {
    type: 'object',
    properties: { straightCmS: num('Speed on the straights, cm/s'), turnCmS: num('Speed limit in the turns, cm/s') },
    required: ['straightCmS', 'turnCmS'],
    additionalProperties: false,
  };
  return {
    type: 'object',
    properties: {
      summary: { type: 'string', description: 'Two or three sentences: what the last lap showed and what this tuning does.' },
      tuning: {
        type: 'object',
        properties: {
          sections: { type: 'object', properties: Object.fromEntries(sectionIds.map((id) => [id, sec])), required: sectionIds, additionalProperties: false },
          accelCmS2: num('Acceleration limit, cm/s²'),
          decelCmS2: num('Braking limit, cm/s²'),
          latAccelCmS2: num('Grip limit in turns, cm/s²'),
          settleCm: num('Steering distance, cm'),
        },
        required: ['sections', 'accelCmS2', 'decelCmS2', 'latAccelCmS2', 'settleCm'],
        additionalProperties: false,
      },
      changes: {
        type: 'array',
        items: { type: 'object', properties: { what: { type: 'string' }, why: { type: 'string' } }, required: ['what', 'why'], additionalProperties: false },
      },
      routeEdits: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            section: { type: 'string' }, part: { type: 'integer' }, lengthCm: num('New straight length, cm (straights only)'),
            radiusCm: num('New turn radius, cm (turns only)'), why: { type: 'string' },
          },
          required: ['section', 'part', 'why'],
          additionalProperties: false,
        },
      },
      watch: { type: 'array', items: { type: 'string' }, description: 'What to look at on the next lap.' },
      predictedS: num('Lap time predict_lap gave for this tuning, s'),
      confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
    },
    required: ['summary', 'tuning', 'changes', 'routeEdits', 'watch', 'predictedS', 'confidence'],
    additionalProperties: false,
  };
}

/** Turn the engineer's structured answer into a checked plan (limits applied, route edits checked). */
export function finishPlan(answer: unknown, ctx: EngineerContext, meta: { model?: string; engine: 'claude' | 'quick'; createdAt: string }): {
  plan: EngineerPlan; warnings: string[];
} {
  const a = (answer ?? {}) as Omit<Partial<EngineerPlan>, 'tuning'> & { tuning?: Partial<Tuning> };
  const tIn: Partial<Tuning> = a.tuning ?? {};
  const raw: EngineerPlan = {
    kind: PLAN_KIND,
    version: 1,
    createdAt: meta.createdAt,
    engine: meta.engine,
    model: meta.model,
    basedOn: { runs: ctx.runs.map((r) => r.id), tuning: ctx.current.label },
    summary: String(a.summary ?? ''),
    tuning: {
      sections: (tIn.sections ?? {}) as Tuning['sections'],
      accelCmS2: Number(tIn.accelCmS2),
      decelCmS2: Number(tIn.decelCmS2),
      latAccelCmS2: Number(tIn.latAccelCmS2),
      ...(tIn.settleCm !== undefined ? { settleCm: Number(tIn.settleCm) } : {}),
      label: ctx.label,
      source: 'engineer',
      createdAt: meta.createdAt,
    },
    changes: Array.isArray(a.changes) ? a.changes : [],
    routeEdits: Array.isArray(a.routeEdits) ? a.routeEdits : [],
    watch: Array.isArray(a.watch) ? a.watch.map(String) : [],
    predictedS: typeof a.predictedS === 'number' ? a.predictedS : undefined,
    confidence: a.confidence === 'low' || a.confidence === 'high' ? a.confidence : 'medium',
  };
  const checked = checkPlan(raw, { current: ctx.current, route: ctx.route, style: ctx.style, label: ctx.label });
  const plan: EngineerPlan = { ...raw, tuning: { ...checked.tuning, createdAt: meta.createdAt } };
  const pred = predictLap(ctx, plan.tuning);
  plan.predictedS = pred.predictedS;
  return {
    plan,
    warnings: [...checked.warnings, ...checked.routeRejected.map((r) => `route edit ${r.edit.section}/${r.edit.part}: ${r.why}`)],
  };
}

/** The quick tune as a plan (the engineer's offline answer). */
export function quickPlan(ctx: EngineerContext, createdAt: string): EngineerPlan {
  const q = quickTune(ctx.runs[ctx.runs.length - 1], ctx.current, 0);
  return finishPlan({
    summary: `Quick tune from ${q.basedOn}: clean parts faster, wandering parts held or slower.`,
    tuning: q.tuning,
    changes: q.reasons.map((r) => ({ what: r.split(':')[0], why: r.slice(r.indexOf(':') + 1).trim() })),
    routeEdits: [],
    watch: [],
    confidence: 'medium',
  }, ctx, { engine: 'quick', createdAt }).plan;
}

/** Everything for a chat with Claude in one text (the app's "Copy brief"; the answer is the plan JSON). */
export function engineerBriefText(ctx: EngineerContext): string {
  const schema = planSchema(ctx.route.sections.map((s) => s.id));
  const system = engineerSystem(ctx)
    .replace(/- Use predict_lap[^\n]*\n/, '- No tools here: judge lap times from currentPrediction (per section) and the physics above.\n')
    .replace('the predicted lap time from predict_lap', 'your estimate of the lap time');
  return `${system}

${engineerPrompt(ctx)}

Answer with one JSON object, nothing else, matching this schema:
${JSON.stringify(schema)}`;
}
