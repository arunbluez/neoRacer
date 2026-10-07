// A synthetic copy of the race mat, drawn from the measured route (see
// race/route.ts): 200 × 300 cm, black background, an 18 cm lane with 2 cm
// white borders shading from blue at the near end to pink at the far end, the
// checkered start/finish line on the left straight, white arrows in the side
// margins, lettering and a wooden see-saw in the infield, a wooden bridge
// over the right straight, and red and grey cones. Used by the mock robot's
// line sensors and the simulated camera.

import { buildPlan, RALLY_ROUTE, type RouteSpec } from '../race/route';
import { hsvToRgbBytes } from './colorUtil';

export type Pt2 = { x: number; y: number };

export const SURFACE = { offtrack: 0, border: 1, lane: 2, other: 3 } as const;

export type TrackMask = {
  width: number;
  height: number;
  cmPerPx: number;
  /** One SURFACE class per pixel. */
  classes: Uint8Array;
};

export type SyntheticTrack = {
  matWidthCm: number;
  matHeightCm: number;
  /** The painted lane's centre line, in driving order. */
  centerline: Pt2[];
  laneWidthCm: number;
  borderCm: number;
  mask: TrackMask;
  /** RGBA top-down picture of the mat at mask resolution. */
  image: { width: number; height: number; data: Uint8ClampedArray };
  start: { x: number; y: number; headingDeg: number };
  cones: (Pt2 & { color: 'red' | 'grey' })[];
  /** The bridge's footprint (darker for the light sensor; hides the robot from the camera). */
  bridge: { x0: number; y0: number; x1: number; y1: number };
  route: RouteSpec;
};

export function pathLengths(path: Pt2[]): { cum: number[]; total: number } {
  const cum: number[] = [];
  let total = 0;
  for (let i = 0; i < path.length; i++) {
    cum.push(total);
    const a = path[i];
    const b = path[(i + 1) % path.length];
    total += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return { cum, total };
}

/** Distance from p to the closed polyline and the path fraction (0..1) of the nearest point. */
export function nearestOnPath(path: Pt2[], cum: number[], total: number, px: number, py: number): { d: number; s: number } {
  let best = Infinity;
  let bestS = 0;
  for (let i = 0; i < path.length; i++) {
    const a = path[i];
    const b = path[(i + 1) % path.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy || 1;
    let u = ((px - a.x) * dx + (py - a.y) * dy) / len2;
    u = u < 0 ? 0 : u > 1 ? 1 : u;
    const qx = a.x + u * dx - px;
    const qy = a.y + u * dy - py;
    const d2 = qx * qx + qy * qy;
    if (d2 < best) {
      best = d2;
      bestS = (cum[i] + u * Math.sqrt(len2)) / total;
    }
  }
  return { d: Math.sqrt(best), s: bestS };
}

/** Lane colour at a mat y, as measured on the real mat: blue (≈223°) at the near end, pink (≈335°) at the far end. */
export function laneRgb(yCm: number, matHeightCm = 300): [number, number, number] {
  const f = Math.max(0, Math.min(1, 1 - yCm / matHeightCm));
  return hsvToRgbBytes(223 + 112 * f, 0.58 - 0.3 * Math.sin(Math.PI * f), 0.77 + 0.15 * f);
}

/** The route with its sideways offsets removed: the painted lane itself. */
export function paintedRoute(spec: RouteSpec): RouteSpec {
  return {
    ...spec,
    sections: spec.sections.map((s) => ({
      ...s,
      parts: s.parts.map((p) => (p.kind === 'straight' ? { kind: 'straight' as const, lengthCm: p.lengthCm } : p)),
    })),
  };
}

export function makeSyntheticTrack(opts: { cmPerPx?: number; route?: RouteSpec } = {}): SyntheticTrack {
  const route = opts.route ?? RALLY_ROUTE;
  const matWidthCm = route.matWidthCm;
  const matHeightCm = route.matHeightCm;
  const cmPerPx = opts.cmPerPx ?? 0.5;
  const centerline = buildPlan(paintedRoute(route), 'arc').outline.map((p) => ({ x: p.x, y: p.y }));
  const laneWidthCm = route.laneWidthCm;
  const borderCm = route.borderCm;
  const half = laneWidthCm / 2;
  const outer = half + borderCm;

  const width = Math.round(matWidthCm / cmPerPx);
  const height = Math.round(matHeightCm / cmPerPx);
  const classes = new Uint8Array(width * height);
  const data = new Uint8ClampedArray(width * height * 4);
  const BG: [number, number, number] = [28, 28, 32];
  const WHITE: [number, number, number] = [236, 236, 232];
  const WOOD: [number, number, number] = [214, 184, 136];

  // Distance to the centre line by stamping discs along it (fast: no per-pixel search).
  const dist = new Float32Array(width * height).fill(Infinity);
  const R = Math.ceil(outer / cmPerPx) + 1;
  for (const p of centerline) {
    const ci = p.x / cmPerPx;
    const cj = p.y / cmPerPx;
    for (let j = Math.max(0, Math.floor(cj - R)); j <= Math.min(height - 1, Math.ceil(cj + R)); j++) {
      for (let i = Math.max(0, Math.floor(ci - R)); i <= Math.min(width - 1, Math.ceil(ci + R)); i++) {
        const d = Math.hypot((i + 0.5 - ci) * cmPerPx, (j + 0.5 - cj) * cmPerPx);
        const k = j * width + i;
        if (d < dist[k]) dist[k] = d;
      }
    }
  }

  const put = (k: number, rgb: [number, number, number], cls: number) => {
    data[k * 4] = rgb[0];
    data[k * 4 + 1] = rgb[1];
    data[k * 4 + 2] = rgb[2];
    data[k * 4 + 3] = 255;
    classes[k] = cls;
  };
  // Fill a shape given as a predicate over mat cm, inside a bounding box.
  const fill = (x0: number, y0: number, x1: number, y1: number, inside: (x: number, y: number) => boolean, rgb: (x: number, y: number) => [number, number, number], cls: number) => {
    for (let j = Math.max(0, Math.floor(y0 / cmPerPx)); j < Math.min(height, Math.ceil(y1 / cmPerPx)); j++) {
      for (let i = Math.max(0, Math.floor(x0 / cmPerPx)); i < Math.min(width, Math.ceil(x1 / cmPerPx)); i++) {
        const x = (i + 0.5) * cmPerPx;
        const y = (j + 0.5) * cmPerPx;
        if (inside(x, y)) put(j * width + i, rgb(x, y), cls);
      }
    }
  };

  for (let j = 0; j < height; j++) {
    const y = (j + 0.5) * cmPerPx;
    const lane = laneRgb(y, matHeightCm);
    for (let i = 0; i < width; i++) {
      const k = j * width + i;
      const d = dist[k];
      if (d < half) put(k, lane, SURFACE.lane);
      else if (d < outer) put(k, WHITE, SURFACE.border);
      else put(k, BG, SURFACE.offtrack);
    }
  }

  // Checkered start/finish across the lane: two rows of squares, black ones read as black.
  const st = route.start;
  const sq = laneWidthCm / 5;
  const checker = (x: number, y: number) => (Math.floor((x - (st.x - half)) / sq) + Math.floor((y - st.y) / sq)) % 2 === 0;
  fill(st.x - half, st.y - sq, st.x + half, st.y + sq, () => true, (x, y) => (checker(x, y) ? WHITE : BG), SURFACE.border);
  fill(st.x - half, st.y - sq, st.x + half, st.y + sq, (x, y) => !checker(x, y), () => BG, SURFACE.offtrack);

  // White arrows in the side margins: ↓ on the left, ↑ on the right (the driving direction).
  const arrow = (cx: number, cy: number, dir: 1 | -1) => fill(cx - 7, cy - 10, cx + 7, cy + 10, (x, y) => {
    const u = (y - cy) * dir; // along the arrow
    const v = Math.abs(x - cx);
    return (u > -9 && u < 3 && v < 1.6) || (u >= 1 && u < 9 && v < 6.5 - (u - 1) * 0.8);
  }, () => WHITE, SURFACE.border);
  for (const y of [97, 125, 152, 180, 207]) arrow(19, y, 1);
  for (const y of [90, 118, 145, 172, 200]) arrow(181, y, -1);

  // "ROBOT RALLYE" in the infield: two rows of lane-coloured letters.
  const letter = (x0: number, y0: number, w: number, h: number) => fill(x0, y0, x0 + w, y0 + h, (x, y) => x - x0 < 2.2 || x0 + w - x < 2.2 || y - y0 < 2.2 || y0 + h - y < 2.2, (x) => laneRgb(300 - x * 1.5, matHeightCm), SURFACE.lane);
  for (let n = 0; n < 5; n++) letter(69 + n * 11.5, 203, 9, 10);
  for (let n = 0; n < 6; n++) letter(69 + n * 10.5, 217, 8.5, 10);

  // The wooden see-saw in the infield (raised: "other").
  fill(78, 150, 112, 160, () => true, () => WOOD, SURFACE.other);
  fill(100, 150, 112, 187, () => true, () => WOOD, SURFACE.other);
  // The bridge over the right straight: two side rails on posts and cross bars.
  const bridge = route.bridge ?? { x0: 136, y0: 205, x1: 168, y1: 242 };
  fill(bridge.x0, bridge.y0, bridge.x1, bridge.y1, (x, y) => x < bridge.x0 + 3 || x > bridge.x1 - 3 || Math.abs(((y - bridge.y0) % 9) - 4.5) < 1, () => WOOD, SURFACE.other);

  const cones = (route.cones ?? []).map((c) => ({ ...c }));
  for (const c of cones) {
    const r = 2.5;
    fill(c.x - r, c.y - r, c.x + r, c.y + r, (x, y) => Math.hypot(x - c.x, y - c.y) < r, (x, y) => {
      const dd = Math.hypot(x - c.x, y - c.y);
      if (c.color === 'grey') return dd < 1 ? [250, 250, 250] : [170, 172, 178];
      return dd < 0.9 ? [250, 230, 230] : [215, 25, 35];
    }, SURFACE.other);
  }

  return {
    matWidthCm,
    matHeightCm,
    centerline,
    laneWidthCm,
    borderCm,
    mask: { width, height, cmPerPx, classes },
    image: { width, height, data },
    start: { ...route.start },
    cones,
    bridge,
    route,
  };
}

/** Surface class at a mat position; offtrack outside the mask. */
export function surfaceAt(mask: TrackMask, xCm: number, yCm: number): number {
  const i = Math.floor(xCm / mask.cmPerPx);
  const j = Math.floor(yCm / mask.cmPerPx);
  if (i < 0 || j < 0 || i >= mask.width || j >= mask.height) return SURFACE.offtrack;
  return mask.classes[j * mask.width + i];
}
