// The race engineer's plan, from text to the tuning in use. Shared by the Lap
// tuning card (shows the plan, applies on a tap) and the race view (pastes
// and applies in one go). Every plan is checked against the tuning in use
// first: missing numbers are kept, raises are capped at 25 % a lap.

import type { RobotProfile } from '../../core/model/profile';
import type { AutoSettings } from '../../core/race/autoRun';
import { engineerBriefText, engineerContext } from '../../core/race/engineerBrief';
import { checkPlan, parsePlan, type RouteEdit } from '../../core/race/engineerPlan';
import type { RunAnalysis } from '../../core/race/lapAnalysis';
import { motorModel } from '../../core/race/motor';
import type { RouteSpec } from '../../core/race/route';
import { buildSpeedProfile, effectiveTuning } from '../../core/race/speedProfile';
import { constantTuning, tuningDiff, type Tuning, type TuningChange } from '../../core/race/tuning';
import { getLab } from '../lab';
import { autoController as ac } from './autoController';

export type PlanReview = {
  title: string;
  summary?: string;
  tuning: Tuning;
  diff: TuningChange[];
  notes: string[];
  watch: string[];
  warnings: string[];
  predictedS: number;
  route?: RouteSpec;
  routeApplied: RouteEdit[];
  routeRejected: { edit: RouteEdit; why: string }[];
  closure?: { before: number; after: number };
};

/** The tuning in use, as driven (speeds raised to what the wheels can do), and its lap prediction. */
export function tuningInUse(s: AutoSettings = getLab().settings.auto, robot: RobotProfile | undefined = getLab().profile) {
  const ids = ac.route.sections.map((x) => x.id);
  const plan = ac.plan();
  const model = motorModel(robot);
  const base = s.tuning ?? constantTuning(s, ids);
  const profile = buildSpeedProfile(plan, base, model, s);
  const current = effectiveTuning({ ...base, settleCm: base.settleCm ?? s.settleCm }, profile);
  const predictOf = (t: Tuning) => buildSpeedProfile(plan, t, model, s).predictedS;
  return { ids, base, profile, current, predictOf };
}

/** Read an engineer plan (the laptop command's JSON, or the Claude app's whole answer) and check it. */
export function reviewPlan(text: string): { review?: PlanReview; error?: string } {
  const { plan: p, errors } = parsePlan(text);
  if (!p) return { error: errors[0] ?? 'No plan found' };
  const s = getLab().settings.auto;
  const { base, current, predictOf } = tuningInUse();
  const label = p.tuning.label.startsWith('engineer') ? p.tuning.label : `engineer ${new Date().toTimeString().slice(0, 5)}`;
  const c = checkPlan(p, { current, route: ac.route, style: s.style, label });
  return {
    review: {
      title: `${label}${p.model ? ` (${p.model})` : p.engine === 'quick' ? ' (quick tune)' : ''}`,
      summary: p.summary,
      tuning: c.tuning,
      diff: tuningDiff(current, c.tuning),
      notes: p.changes.map((x) => `${x.what.replace(/[.:]+$/, '')} — ${x.why}`),
      watch: p.watch,
      warnings: [
        ...(p.basedOn.tuning && p.basedOn.tuning !== base.label ? [`This plan was made after runs with "${p.basedOn.tuning}"; the tuning in use is "${base.label}". Its numbers are checked against the one in use.`] : []),
        ...c.warnings,
      ],
      predictedS: predictOf(c.tuning),
      route: c.route,
      routeApplied: c.routeApplied,
      routeRejected: c.routeRejected,
      closure: c.closure,
    },
  };
}

/** Drive with this tuning from now on (and the plan's track edits, if asked); one step can be undone. */
export async function applyTuning(t: Tuning, route?: RouteSpec): Promise<void> {
  const lab = getLab();
  const a = lab.settings.auto;
  const ids = ac.route.sections.map((x) => x.id);
  const newRoute = route ?? a.route;
  await lab.setSettings({ auto: { ...a, tuning: { ...t, createdAt: new Date().toISOString() }, tuningPrev: a.tuning ?? constantTuning(a, ids), route: newRoute } });
  if (newRoute !== a.route) ac.reconfigure();
  lab.logger.log('app', { event: 'tuning.applied', detail: { label: t.label, source: t.source, route: newRoute !== a.route } });
}

/** Back to the tuning before the last change. */
export async function undoTuning(): Promise<Tuning | undefined> {
  const lab = getLab();
  const a = lab.settings.auto;
  if (!a.tuningPrev) return undefined;
  const back = a.tuningPrev.source === 'constant' ? undefined : a.tuningPrev;
  await lab.setSettings({ auto: { ...a, tuning: back, tuningPrev: a.tuning } });
  return back;
}

/** The brief for the Claude app: the last four runs, the knobs and the answer's shape. */
export function briefText(runs: RunAnalysis[]): string {
  if (!runs.length) throw new Error('Drive a lap first: no runs in the logs yet.');
  return engineerBriefText(engineerContext(runs.slice(-4)));
}
