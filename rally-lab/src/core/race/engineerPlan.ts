// The race engineer's plan: the next tuning, what changed and why, optional
// corrections to the track code, and what to watch on the next lap. The
// engineer (a command on the laptop, engineer/) writes it as JSON; the app
// reads it back (file or paste), checks it against the limits and the tuning
// in use, shows the changes, and applies them only when told to.

import { checkRoute, closureError, type RouteSpec, type TurnStyle } from './route';
import { clampTuning, type Tuning } from './tuning';

export const PLAN_KIND = 'rally-lab/engineer-plan';

export type RouteEdit = {
  section: string;
  /** Index of the part in the section (0 = first). */
  part: number;
  /** New straight length or turn radius, cm. */
  lengthCm?: number;
  radiusCm?: number;
  why?: string;
};

export type EngineerPlan = {
  kind: typeof PLAN_KIND;
  version: 1;
  createdAt: string;
  /** Who made it: Claude (with the model) or the offline quick tune. */
  engine: 'claude' | 'quick';
  model?: string;
  /** The runs it looked at ("<session>#<n>") and the tuning they drove. */
  basedOn: { runs: string[]; tuning?: string };
  summary: string;
  tuning: Tuning;
  changes: { what: string; why: string }[];
  routeEdits: RouteEdit[];
  /** What to look at on the next lap. */
  watch: string[];
  /** Lap time the plan expects, s. */
  predictedS?: number;
  confidence: 'low' | 'medium' | 'high';
};

/** Largest change a route edit may make: a fraction of the current value, and at most this many cm. */
export const ROUTE_EDIT_LIMITS = { frac: 0.15, cm: 15 };

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const str = (x: unknown, d = ''): string => (typeof x === 'string' ? x : d);
const numOr = (x: unknown): number => (typeof x === 'number' ? x : typeof x === 'string' && x.trim() !== '' ? Number(x) : NaN);

/**
 * Read a plan from text or an object. Accepts the plan itself, or text with
 * the JSON inside (a pasted message): the first {...} that parses as a plan.
 */
export function parsePlan(input: unknown): { plan?: EngineerPlan; errors: string[] } {
  let obj: unknown = input;
  if (typeof input === 'string') {
    obj = undefined;
    const text = input.trim();
    const tries = [text, ...candidates(text)];
    for (const t of tries) {
      try {
        const o = JSON.parse(t);
        if (isObj(o) && (o.kind === PLAN_KIND || isObj(o.tuning))) {
          obj = o;
          break;
        }
      } catch {
        // next candidate
      }
    }
    if (obj === undefined) return { errors: ['No engineer plan found in the text (expected JSON with "kind": "rally-lab/engineer-plan").'] };
  }
  if (!isObj(obj)) return { errors: ['The plan is not a JSON object.'] };
  const errors: string[] = [];
  if (obj.kind !== undefined && obj.kind !== PLAN_KIND) errors.push(`Not an engineer plan (kind ${String(obj.kind)}).`);
  const t = obj.tuning;
  if (!isObj(t) || !isObj(t.sections)) errors.push('The plan has no tuning with sections.');
  if (errors.length) return { errors };
  const tt = t as Record<string, unknown>;
  const sections: Tuning['sections'] = {};
  for (const [id, v] of Object.entries(tt.sections as Record<string, unknown>)) {
    if (!isObj(v)) continue;
    sections[id] = { straightCmS: numOr(v.straightCmS), turnCmS: numOr(v.turnCmS) };
  }
  const tuning: Tuning = {
    sections,
    accelCmS2: numOr(tt.accelCmS2),
    decelCmS2: numOr(tt.decelCmS2),
    latAccelCmS2: numOr(tt.latAccelCmS2),
    label: str(tt.label, 'engineer'),
    source: 'engineer',
    createdAt: str(obj.createdAt) || undefined,
  };
  if (tt.settleCm !== undefined && tt.settleCm !== null) tuning.settleCm = numOr(tt.settleCm);
  const arr = (x: unknown) => (Array.isArray(x) ? x : []);
  const plan: EngineerPlan = {
    kind: PLAN_KIND,
    version: 1,
    createdAt: str(obj.createdAt, ''),
    engine: obj.engine === 'quick' ? 'quick' : 'claude',
    model: str(obj.model) || undefined,
    basedOn: isObj(obj.basedOn) ? { runs: arr(obj.basedOn.runs).map(String), tuning: str(obj.basedOn.tuning) || undefined } : { runs: [] },
    summary: str(obj.summary),
    tuning,
    changes: arr(obj.changes).filter(isObj).map((c) => ({ what: str(c.what), why: str(c.why) })),
    routeEdits: arr(obj.routeEdits).filter(isObj).map((e) => ({
      section: str(e.section),
      part: Math.round(numOr(e.part)),
      ...(e.lengthCm !== undefined && e.lengthCm !== null ? { lengthCm: numOr(e.lengthCm) } : {}),
      ...(e.radiusCm !== undefined && e.radiusCm !== null ? { radiusCm: numOr(e.radiusCm) } : {}),
      ...(e.why ? { why: str(e.why) } : {}),
    })),
    watch: arr(obj.watch).map(String),
    predictedS: Number.isFinite(numOr(obj.predictedS)) ? numOr(obj.predictedS) : undefined,
    confidence: obj.confidence === 'high' || obj.confidence === 'low' ? obj.confidence : 'medium',
  };
  return { plan, errors: [] };
}

/** Balanced {...} blocks in a text, longest first (a plan pasted inside a message or a code fence). */
function candidates(text: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;
    let depth = 0, inStr = false;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (inStr) {
        if (c === '\\') j++;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) {
        out.push(text.slice(i, j + 1));
        i = j;
        break;
      }
    }
  }
  return out.sort((a, b) => b.length - a.length);
}

export type CheckedPlan = {
  plan: EngineerPlan;
  /** The tuning to apply, inside the limits and the step limit. */
  tuning: Tuning;
  warnings: string[];
  /** The track code with the accepted edits (undefined: no edits). */
  route?: RouteSpec;
  routeApplied: RouteEdit[];
  routeRejected: { edit: RouteEdit; why: string }[];
  /** Closure of the lap before and after the edits, cm. */
  closure?: { before: number; after: number };
};

/** Check a plan against the tuning in use (as driven: effectiveTuning) and the route. */
export function checkPlan(plan: EngineerPlan, ctx: { current: Tuning; route: RouteSpec; style?: TurnStyle; label?: string }): CheckedPlan {
  const ids = ctx.route.sections.map((s) => s.id);
  const t = { ...plan.tuning, sections: { ...plan.tuning.sections } };
  for (const id of ids) t.sections[id] ??= ctx.current.sections[id];
  for (const k of ['accelCmS2', 'decelCmS2', 'latAccelCmS2'] as const) if (!Number.isFinite(t[k])) t[k] = ctx.current[k];
  const { tuning, warnings } = clampTuning({ ...t, label: ctx.label ?? t.label, source: 'engineer' }, ctx.current, ids);
  const out: CheckedPlan = { plan, tuning, warnings, routeApplied: [], routeRejected: [] };
  if (plan.routeEdits.length) {
    const r = applyRouteEdits(ctx.route, plan.routeEdits);
    out.routeApplied = r.applied;
    out.routeRejected = r.rejected;
    if (r.applied.length) {
      out.route = r.route;
      out.closure = { before: round1(closureError(ctx.route, ctx.style)), after: round1(closureError(r.route, ctx.style)) };
    }
  }
  return out;
}

/** Apply length/radius edits within ROUTE_EDIT_LIMITS; turn angles never change (the mat fixes them). */
export function applyRouteEdits(route: RouteSpec, edits: RouteEdit[]): { route: RouteSpec; applied: RouteEdit[]; rejected: { edit: RouteEdit; why: string }[] } {
  const next: RouteSpec = { ...route, sections: route.sections.map((s) => ({ ...s, parts: s.parts.map((p) => ({ ...p })) })) };
  const applied: RouteEdit[] = [], rejected: { edit: RouteEdit; why: string }[] = [];
  const within = (from: number, to: number) => Math.abs(to - from) <= Math.min(ROUTE_EDIT_LIMITS.cm, Math.max(1, ROUTE_EDIT_LIMITS.frac * from));
  for (const e of edits) {
    const sec = next.sections.find((s) => s.id === e.section);
    const part = sec?.parts[e.part];
    if (!sec || !part) {
      rejected.push({ edit: e, why: `no part ${e.part} in section ${e.section}` });
      continue;
    }
    if (part.kind === 'straight') {
      if (e.lengthCm === undefined || !Number.isFinite(e.lengthCm)) rejected.push({ edit: e, why: 'a straight takes lengthCm' });
      else if (!within(part.lengthCm, e.lengthCm)) rejected.push({ edit: e, why: `${part.lengthCm} → ${e.lengthCm} cm is too big a change for one step` });
      else {
        part.lengthCm = round1(e.lengthCm);
        applied.push(e);
      }
    } else {
      if (e.radiusCm === undefined || !Number.isFinite(e.radiusCm)) rejected.push({ edit: e, why: 'a turn takes radiusCm' });
      else if (!within(part.radiusCm, e.radiusCm)) rejected.push({ edit: e, why: `radius ${part.radiusCm} → ${e.radiusCm} cm is too big a change for one step` });
      else {
        part.radiusCm = round1(e.radiusCm);
        applied.push(e);
      }
    }
  }
  const problems = checkRoute(next);
  if (problems.length) return { route, applied: [], rejected: [...rejected, ...applied.map((edit) => ({ edit, why: problems.join('; ') }))] };
  return { route: next, applied, rejected };
}

/** The plan file's name: engineer-plan-<session>-<runs>.json */
export function planFileName(plan: EngineerPlan): string {
  const last = plan.basedOn.runs[plan.basedOn.runs.length - 1] ?? 'runs';
  return `engineer-plan-${last.replace(/[^A-Za-z0-9-]+/g, '-')}.json`;
}

const round1 = (x: number) => Math.round(x * 10) / 10;
