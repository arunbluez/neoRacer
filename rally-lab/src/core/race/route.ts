// The race route as "track code": sections a–g of straights and turns, the way
// the track was described at the venue, with the numbers measured from a
// top-down view of the real mat. A route builds into a plan the auto run
// follows: one smooth path (arc turns), or straights joined by turns on the
// spot (spin turns), which also work at the slowest speeds.
//
// Mat coordinates: cm, origin at the mat's top-left corner as seen standing at
// the near edge (side b in the venue photo), x to the right, y towards you.
// Headings: degrees, atan2(dy, dx), so 0 = +x, 90 = +y (towards you); a right
// turn makes the heading grow.

export type OffsetRange = {
  /** Distance from the start of the straight, cm. */
  from: number;
  to: number;
  /** Sideways shift of the line to follow, cm; positive = to the right of the direction of travel. */
  offsetCm: number;
};

export type RoutePart =
  | { kind: 'straight'; lengthCm: number; offsets?: OffsetRange[] }
  /** deg: positive = right, negative = left. radiusCm: of the lane's centre line. */
  | { kind: 'turn'; deg: number; radiusCm: number };

export type RouteSection = { id: string; note?: string; parts: RoutePart[] };

export type RouteSpec = {
  name: string;
  matWidthCm: number;
  matHeightCm: number;
  laneWidthCm: number;
  borderCm: number;
  /** Where the lap starts and ends (the start/finish line, on the lane's centre line). */
  start: { x: number; y: number; headingDeg: number };
  sections: RouteSection[];
  /** Things on the mat that matter for the drive (for the map and the simulator). */
  cones?: { x: number; y: number; color: 'red' | 'grey' }[];
  bridge?: { x0: number; y0: number; x1: number; y1: number };
};

const S = (lengthCm: number, offsets?: OffsetRange[]): RoutePart => ({ kind: 'straight', lengthCm, ...(offsets ? { offsets } : {}) });
const L = (deg: number, radiusCm: number): RoutePart => ({ kind: 'turn', deg: -deg, radiusCm });
const R = (deg: number, radiusCm: number): RoutePart => ({ kind: 'turn', deg, radiusCm });

/**
 * The Robot Rallye track (venue photo, 7 Oct 2026). Lane centres: left side
 * x 48.5, right side x 151.2, bottom y 276.1, top y 25; the zigzag's lanes at
 * y 52.5, 78, 103.5 and 133.2. Straight lengths are the straight parts only,
 * between the curves (the venue measurements of a lane's whole length include
 * its curves).
 */
export const RALLY_ROUTE: RouteSpec = {
  name: 'Robot Rallye, Oct 2026',
  matWidthCm: 200,
  matHeightCm: 300,
  laneWidthCm: 18,
  borderCm: 2,
  start: { x: 48.5, y: 230.5, headingDeg: 90 },
  sections: [
    { id: 'a', note: 'start → first corner', parts: [S(20.2), L(90, 25.4)] },
    { id: 'b', note: 'near straight', parts: [S(48.3), L(90, 29)] },
    {
      id: 'c',
      note: 'long straight: bridge, then cones on the right, then on the left',
      // Cones at 42 and 61 cm (right) and 93 and 111 cm (left): pass them 4.5 cm off the centre line.
      parts: [S(195.6, [{ from: 30, to: 70, offsetCm: -4.5 }, { from: 86, to: 124, offsetCm: 4.5 }]), L(90, 26.5)],
    },
    { id: 'd', note: 'far straight, hairpin into the zigzag', parts: [S(62.45), L(180, 13.75)] },
    { id: 'e', note: 'zigzag, short legs', parts: [S(17.5), R(180, 12.75), S(18.25), L(180, 12.75)] },
    { id: 'f', note: 'zigzag, long legs', parts: [S(34.65), R(180, 14.85), S(17.65), L(90, 30)] },
    { id: 'g', note: 'down to the finish', parts: [S(67.3)] },
  ],
  cones: [
    { x: 159, y: 186, color: 'red' }, { x: 159, y: 205, color: 'red' },
    { x: 145, y: 136, color: 'red' }, { x: 145, y: 154, color: 'red' },
    { x: 141, y: 50, color: 'red' },
    { x: 62.5, y: 37, color: 'grey' }, { x: 75, y: 37, color: 'red' },
    { x: 63.5, y: 64, color: 'red' }, { x: 77.5, y: 61, color: 'grey' },
    { x: 61.5, y: 89, color: 'grey' }, { x: 78, y: 90, color: 'red' },
    { x: 84.5, y: 118, color: 'grey' }, { x: 96, y: 117, color: 'grey' },
    { x: 34, y: 220, color: 'grey' }, { x: 61, y: 220, color: 'grey' },
    { x: 34, y: 237, color: 'red' }, { x: 61, y: 238, color: 'red' },
  ],
  bridge: { x0: 136, y0: 205, x1: 168, y1: 242 },
};

// ---------------------------------------------------------------- plan

export type PathPt = {
  x: number;
  y: number;
  /** Distance along the plan from the start, cm. */
  s: number;
  headingDeg: number;
  /** 1/cm, positive = turning right. */
  curv: number;
  section: string;
};

export type Leg =
  | { kind: 'path'; pts: PathPt[]; lengthCm: number; section: string }
  | { kind: 'spin'; x: number; y: number; fromDeg: number; toDeg: number; deltaDeg: number; s: number; section: string };

export type TurnStyle = 'arc' | 'spin';

export type Plan = {
  style: TurnStyle;
  legs: Leg[];
  /** All path points in order (spins add none), for maps and overlays. */
  outline: PathPt[];
  lengthCm: number;
  /** Where each section starts along the plan, cm. */
  sectionStarts: { id: string; s: number }[];
};

const RAD = Math.PI / 180;

export function wrapDeg(a: number): number {
  let r = a % 360;
  if (r <= -180) r += 360;
  else if (r > 180) r -= 360;
  return r + 0;
}

/**
 * Cosine-ramped sideways offset along a straight (ramps of `rampCm` outside
 * each range). 25 cm keeps the swap from one side to the other between the
 * cones of section c a gentle bend (~22 cm radius): with 15 cm ramps it was
 * as sharp as a 5–8 cm radius turn, which the robot can only drive by
 * speeding up to keep its inner wheel turning.
 */
export function offsetAt(offsets: OffsetRange[] | undefined, d: number, rampCm = 25): number {
  if (!offsets) return 0;
  let o = 0;
  for (const r of offsets) {
    let w = 0;
    if (d >= r.from && d <= r.to) w = 1;
    else {
      const gap = d < r.from ? r.from - d : d - r.to;
      if (gap < rampCm) w = 0.5 * (1 + Math.cos((Math.PI * gap) / rampCm));
    }
    o += w * r.offsetCm;
  }
  return o;
}

/** The route as painted: the lane's centre line, without the sideways dodges. */
export function withoutOffsets(spec: RouteSpec): RouteSpec {
  return {
    ...spec,
    sections: spec.sections.map((sec) => ({ ...sec, parts: sec.parts.map((p) => (p.kind === 'straight' ? { kind: 'straight' as const, lengthCm: p.lengthCm } : p)) })),
  };
}

/** A copy of the route with one offset range's sideways shift changed (the cone dodges). */
export function withOffset(spec: RouteSpec, section: string, part: number, range: number, offsetCm: number): RouteSpec {
  return {
    ...spec,
    sections: spec.sections.map((sec) => (sec.id !== section ? sec : {
      ...sec,
      parts: sec.parts.map((p, i) => (i !== part || p.kind !== 'straight' || !p.offsets ? p : {
        ...p, offsets: p.offsets.map((o, k) => (k === range ? { ...o, offsetCm } : o)),
      })),
    })),
  };
}

/** Validates a spec; returns problems (empty when fine). */
export function checkRoute(spec: RouteSpec): string[] {
  const out: string[] = [];
  if (!spec.sections.length) out.push('no sections');
  for (const sec of spec.sections) {
    for (const p of sec.parts) {
      if (p.kind === 'straight' && !(p.lengthCm >= 0)) out.push(`${sec.id}: straight length must be ≥ 0`);
      if (p.kind === 'turn' && !(p.radiusCm > 0)) out.push(`${sec.id}: turn radius must be > 0`);
      if (p.kind === 'turn' && !(Math.abs(p.deg) > 0 && Math.abs(p.deg) <= 360)) out.push(`${sec.id}: turn angle must be 1..360°`);
    }
  }
  return out;
}

type Cursor = { x: number; y: number; h: number; s: number };

export type PlanOpts = {
  /** Point spacing along straights and arcs, cm. Default 1. */
  stepCm?: number;
  /**
   * Spin style: largest turn on the spot, degrees. Each turn is cut into
   * pieces this size; a piece's corner lies R·(1/cos(d/2) − 1) outside the
   * lane's centre (45°: 8 % of the radius, 2 cm on a 25 cm corner). Default 45.
   */
  maxSpinDeg?: number;
};

/**
 * Build the plan. 'arc': one path leg with the turns as arcs. 'spin': each
 * turn becomes pieces of at most maxSpinDeg, and each piece a straight to the
 * corner where the piece's straights meet, a turn on the spot, and a straight
 * out. Points every ~stepCm along straights and arcs.
 */
export function buildPlan(spec: RouteSpec, style: TurnStyle, popts: PlanOpts = {}): Plan {
  const stepCm = popts.stepCm ?? 1;
  const maxSpin = Math.max(10, Math.min(90, popts.maxSpinDeg ?? 45));
  const legs: Leg[] = [];
  const outline: PathPt[] = [];
  const sectionStarts: { id: string; s: number }[] = [];
  const c: Cursor = { x: spec.start.x, y: spec.start.y, h: spec.start.headingDeg, s: 0 };
  let cur: PathPt[] = [];
  let curSection = spec.sections[0]?.id ?? '';
  const push = (p: PathPt) => {
    cur.push(p);
    outline.push(p);
  };
  push({ x: c.x, y: c.y, s: 0, headingDeg: c.h, curv: 0, section: curSection });

  // Straight from the cursor, with an optional sideways offset; offsets are
  // positioned relative to `d0` (where the drawn straight starts).
  const straight = (len: number, section: string, offsets?: OffsetRange[], d0 = 0) => {
    if (len <= 0) return;
    const n = Math.max(1, Math.ceil(len / stepCm));
    const ux = Math.cos(c.h * RAD), uy = Math.sin(c.h * RAD);
    const rx = -uy, ry = ux; // right of travel on a y-down mat
    const bx = c.x, by = c.y;
    const pts: { x: number; y: number }[] = [];
    for (let i = 1; i <= n; i++) {
      const d = (len * i) / n;
      const o = offsetAt(offsets, d - d0);
      pts.push({ x: bx + ux * d + rx * o, y: by + uy * d + ry * o });
    }
    // Heading and curvature from the (possibly offset) points.
    let prev = cur[cur.length - 1];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const ds = Math.hypot(p.x - prev.x, p.y - prev.y);
      const nxt = pts[i + 1];
      const h = nxt ? Math.atan2(nxt.y - prev.y, nxt.x - prev.x) / RAD : Math.atan2(p.y - prev.y, p.x - prev.x) / RAD;
      c.s += ds;
      const q: PathPt = { x: p.x, y: p.y, s: c.s, headingDeg: offsets ? h : c.h, curv: 0, section };
      push(q);
      prev = q;
    }
    if (offsets) {
      // Curvature by finite differences of heading over distance.
      const a = cur.length - pts.length - 1;
      for (let i = Math.max(1, a + 1); i < cur.length - 1; i++) {
        const dh = wrapDeg(cur[i + 1].headingDeg - cur[i - 1].headingDeg) * RAD;
        const ds = cur[i + 1].s - cur[i - 1].s;
        cur[i].curv = ds > 0 ? dh / ds : 0;
      }
    }
    c.x = bx + ux * len;
    c.y = by + uy * len;
  };

  const arc = (deg: number, r: number, section: string) => {
    const sweep = deg * RAD;
    const sgn = Math.sign(deg);
    // Centre: to the right of travel for a right turn.
    const rx = -Math.sin(c.h * RAD) * sgn, ry = Math.cos(c.h * RAD) * sgn;
    const cx = c.x + rx * r, cy = c.y + ry * r;
    const a0 = Math.atan2(c.y - cy, c.x - cx);
    const n = Math.max(2, Math.ceil((Math.abs(sweep) * r) / stepCm));
    for (let i = 1; i <= n; i++) {
      const a = a0 + (sweep * i) / n;
      c.s += (Math.abs(sweep) * r) / n;
      push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a), s: c.s, headingDeg: wrapDeg(c.h + (deg * i) / n), curv: sgn / r, section });
    }
    c.x = cx + r * Math.cos(a0 + sweep);
    c.y = cy + r * Math.sin(a0 + sweep);
    c.h = wrapDeg(c.h + deg);
  };

  const closePath = () => {
    if (cur.length > 1) legs.push({ kind: 'path', pts: cur, lengthCm: cur[cur.length - 1].s - cur[0].s, section: cur[0].section });
    const last = cur[cur.length - 1];
    cur = [{ ...last }];
  };

  // Spin style: how far each straight is extended into the corners around it.
  let carry = 0; // extension owed to the start of the next straight
  for (const sec of spec.sections) {
    curSection = sec.id;
    sectionStarts.push({ id: sec.id, s: c.s });
    for (let pi = 0; pi < sec.parts.length; pi++) {
      const part = sec.parts[pi];
      if (part.kind === 'straight') {
        straight(part.lengthCm + carry, sec.id, part.offsets, carry);
        carry = 0;
        continue;
      }
      if (style === 'arc') {
        arc(part.deg, part.radiusCm, sec.id);
        continue;
      }
      const pieces = Math.ceil(Math.abs(part.deg) / maxSpin - 1e-9);
      const d = part.deg / pieces;
      const ext = part.radiusCm * Math.tan((Math.abs(d) * RAD) / 2);
      for (let k = 0; k < pieces; k++) {
        straight(ext + carry, sec.id);
        carry = 0;
        closePath();
        const from = c.h;
        c.h = wrapDeg(c.h + d);
        legs.push({ kind: 'spin', x: c.x, y: c.y, fromDeg: from, toDeg: c.h, deltaDeg: d, s: c.s, section: sec.id });
        cur = [{ x: c.x, y: c.y, s: c.s, headingDeg: c.h, curv: 0, section: sec.id }];
        carry = ext;
      }
    }
  }
  if (carry > 0) straight(carry, curSection);
  closePath();
  return { style, legs, outline, lengthCm: c.s, sectionStarts };
}

/** Where the plan ends versus where it started (a closed lap ends near 0). */
export function closureError(spec: RouteSpec, style: TurnStyle = 'arc'): number {
  const plan = buildPlan(spec, style);
  const end = plan.outline[plan.outline.length - 1];
  return Math.hypot(end.x - spec.start.x, end.y - spec.start.y);
}

/** Total turning of the route, degrees (a lap of this track turns −360°). */
export function totalTurnDeg(spec: RouteSpec): number {
  let t = 0;
  for (const sec of spec.sections) for (const p of sec.parts) if (p.kind === 'turn') t += p.deg;
  return t;
}
