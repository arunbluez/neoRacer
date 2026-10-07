// A synthetic copy of the race mat, measured from a photo of the real one
// (rectified to 300 × 250 cm): black background; an 18 cm lane with 2 cm
// white borders and a left-to-right blue → pastel purple → pink gradient; a
// checkered start/finish across the top straight; a serpentine of four legs
// in the top right; white arrows above and below the loop; lane-coloured
// lettering and two wooden ramps in the infield; a wooden bridge on the
// bottom-left corner; red and grey cones. Used by the mock robot's line
// sensors and the simulated camera. When a real track mask has been
// exported, the mock can use that instead.

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
  centerline: Pt2[];
  laneWidthCm: number;
  borderCm: number;
  mask: TrackMask;
  /** RGBA top-down picture of the mat at mask resolution. */
  image: { width: number; height: number; data: Uint8ClampedArray };
  start: { x: number; y: number; headingDeg: number };
  finishX: number;
  cones: (Pt2 & { color: 'red' | 'grey' })[];
  /** Area under the wooden bridge (darker for the light sensor). */
  bridge: { x0: number; y0: number; x1: number; y1: number };
};

/** Builds the route as straight lines and circular arcs, sampled every ~1 cm. */
class PathBuilder {
  pts: Pt2[] = [];
  constructor(start: Pt2) {
    this.pts.push(start);
  }
  get last(): Pt2 {
    return this.pts[this.pts.length - 1];
  }
  line(to: Pt2): this {
    const a = this.last;
    const n = Math.max(1, Math.ceil(Math.hypot(to.x - a.x, to.y - a.y)));
    for (let i = 1; i <= n; i++) this.pts.push({ x: a.x + ((to.x - a.x) * i) / n, y: a.y + ((to.y - a.y) * i) / n });
    return this;
  }
  /** Arc around c from the current point, sweeping `deg` (positive = clockwise on a y-down mat). */
  arc(c: Pt2, deg: number): this {
    const a = this.last;
    const r = Math.hypot(a.x - c.x, a.y - c.y);
    const a0 = Math.atan2(a.y - c.y, a.x - c.x);
    const sweep = (deg * Math.PI) / 180;
    const n = Math.max(4, Math.ceil(Math.abs(sweep) * r));
    for (let i = 1; i <= n; i++) {
      const t = a0 + (sweep * i) / n;
      this.pts.push({ x: c.x + r * Math.cos(t), y: c.y + r * Math.sin(t) });
    }
    return this;
  }
}

/** Centreline in the direction of travel, starting at the finish line heading left (cm, 300 × 250 mat). */
function route(): Pt2[] {
  const b = new PathBuilder({ x: 67, y: 59 });
  b.line({ x: 32, y: 59 }).arc({ x: 32, y: 73 }, -90) // top-left corner
    .line({ x: 18, y: 173 }).arc({ x: 32, y: 173 }, -90) // left side, bottom-left corner (bridge)
    .line({ x: 262, y: 187 }).arc({ x: 262, y: 173 }, -90) // bottom straight, bottom-right corner
    .line({ x: 276, y: 73 }).arc({ x: 262, y: 73 }, -180) // right side up, first hairpin
    .line({ x: 248, y: 100 }).arc({ x: 235, y: 100 }, 180) // leg 4 down, U-turn
    .line({ x: 222, y: 73 }).arc({ x: 208.5, y: 73 }, -180) // leg 3 up, hairpin
    .line({ x: 195, y: 122 }).arc({ x: 180, y: 122 }, 180) // leg 2 down, U-turn
    .line({ x: 165, y: 73 }).arc({ x: 151, y: 73 }, -90) // leg 1 up, onto the top straight
    .line({ x: 68, y: 59 });
  return b.pts;
}

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

/** Lane colour at a mat x, as measured on the real mat: hue 223° → 335°, saturation dips in the middle. */
export function laneRgb(xCm: number, matWidthCm = 300): [number, number, number] {
  const f = Math.max(0, Math.min(1, xCm / matWidthCm));
  return hsvToRgbBytes(223 + 112 * f, 0.58 - 0.3 * Math.sin(Math.PI * f), 0.77 + 0.15 * f);
}

export function makeSyntheticTrack(opts: { matWidthCm?: number; matHeightCm?: number; cmPerPx?: number } = {}): SyntheticTrack {
  const matWidthCm = opts.matWidthCm ?? 300;
  const matHeightCm = opts.matHeightCm ?? 250;
  const cmPerPx = opts.cmPerPx ?? 0.5;
  const sx = matWidthCm / 300;
  const sy = matHeightCm / 250;
  const S = (p: Pt2) => ({ x: p.x * sx, y: p.y * sy });
  const centerline = route().map(S);
  const laneWidthCm = 18;
  const borderCm = 2;
  const half = laneWidthCm / 2;
  const outer = half + borderCm;

  const width = Math.round(matWidthCm / cmPerPx);
  const height = Math.round(matHeightCm / cmPerPx);
  const classes = new Uint8Array(width * height);
  const data = new Uint8ClampedArray(width * height * 4);
  const BG: [number, number, number] = [28, 28, 32];
  const WHITE: [number, number, number] = [236, 236, 232];

  // Distance to the centreline by stamping discs along it (fast: no per-pixel search).
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
    for (let j = Math.max(0, Math.floor((y0 * sy) / cmPerPx)); j < Math.min(height, Math.ceil((y1 * sy) / cmPerPx)); j++) {
      for (let i = Math.max(0, Math.floor((x0 * sx) / cmPerPx)); i < Math.min(width, Math.ceil((x1 * sx) / cmPerPx)); i++) {
        const x = ((i + 0.5) * cmPerPx) / sx;
        const y = ((j + 0.5) * cmPerPx) / sy;
        if (inside(x, y)) put(j * width + i, rgb(x, y), cls);
      }
    }
  };

  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      const k = j * width + i;
      const d = dist[k];
      const x = (i + 0.5) * cmPerPx;
      if (d < half) put(k, laneRgb(x, matWidthCm), SURFACE.lane);
      else if (d < outer) put(k, WHITE, SURFACE.border);
      else put(k, BG, SURFACE.offtrack);
    }
  }

  const checker = (x: number, y: number, size: number) => (Math.floor(x / size) + Math.floor(y / size)) % 2 === 0;
  // Checkered start/finish across the top straight, and the flag graphic above it.
  const finishX = 67;
  fill(62, 50, 72, 68, () => true, (x, y) => (checker(x, y, 3.3) ? WHITE : BG), SURFACE.border);
  fill(62, 50, 72, 68, (x, y) => !checker(x, y, 3.3), () => BG, SURFACE.offtrack);
  fill(52, 4, 80, 38, (x, y) => x - 52 > (y - 4) * 0.2 && checker(x, y, 3), () => WHITE, SURFACE.border);

  // White arrows: ← above the loop, → below it.
  const arrow = (cx: number, cy: number, dir: 1 | -1) => fill(cx - 10, cy - 7, cx + 10, cy + 7, (x, y) => {
    const u = (x - cx) * dir; // along the arrow
    const v = Math.abs(y - cy);
    return (u > -9 && u < 3 && v < 1.6) || (u >= 1 && u < 9 && v < 6.5 - (u - 1) * 0.8);
  }, () => WHITE, SURFACE.border);
  for (const x of [92, 120, 148, 176, 204]) arrow(x, 20, -1);
  for (const x of [92, 120, 148, 176, 204]) arrow(x, 222, 1);

  // "ROBOT RALLYE": two columns of lane-coloured letters in the infield.
  const letter = (x0: number, y0: number, w: number, h: number) => fill(x0, y0, x0 + w, y0 + h, (x, y) => x - x0 < 2.5 || x0 + w - x < 2.5 || y - y0 < 2.5 || y0 + h - y < 2.5, (_x, y) => laneRgb(40 + (y - 80) * 2.5, matWidthCm), SURFACE.lane);
  for (let n = 0; n < 6; n++) letter(57, 82 + n * 13, 11, 10);
  for (let n = 0; n < 5; n++) letter(76, 84 + n * 14.5, 12, 11);

  // Wooden ramps (raised: "other").
  const WOOD: [number, number, number] = [214, 184, 136];
  fill(100, 103, 138, 117, () => true, () => WOOD, SURFACE.other);
  fill(104, 122, 142, 136, () => true, () => WOOD, SURFACE.other);
  // Bridge over the bottom-left corner: two rails and cross bars.
  const bridge = { x0: 33 * sx, y0: 160 * sy, x1: 52 * sx, y1: 206 * sy };
  fill(33, 160, 52, 206, (x, y) => x < 35.5 || x > 49.5 || Math.abs(((y - 160) % 9) - 4.5) < 1, () => WOOD, SURFACE.other);

  const cones: SyntheticTrack['cones'] = [
    { x: 262, y: 76, color: 'red' }, { x: 235, y: 95, color: 'red' }, { x: 176, y: 118, color: 'red' },
    { x: 172, y: 179, color: 'red' }, { x: 184, y: 179, color: 'red' }, { x: 137, y: 194, color: 'red' }, { x: 150, y: 195, color: 'red' },
    { x: 102, y: 70, color: 'red' }, { x: 34, y: 161, color: 'red' }, { x: 15, y: 194, color: 'red' },
    { x: 209, y: 72, color: 'grey' }, { x: 146, y: 40, color: 'grey' }, { x: 207, y: 37, color: 'grey' },
    { x: 235, y: 128, color: 'grey' }, { x: 100, y: 168, color: 'grey' }, { x: 230, y: 205, color: 'grey' },
  ].map((c) => ({ ...c, x: c.x * sx, y: c.y * sy })) as SyntheticTrack['cones'];
  for (const c of cones) {
    const r = 2.5;
    fill(c.x / sx - r, c.y / sy - r, c.x / sx + r, c.y / sy + r, (x, y) => Math.hypot(x - c.x / sx, y - c.y / sy) < r, (x, y) => {
      const dd = Math.hypot(x - c.x / sx, y - c.y / sy);
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
    start: { x: 80 * sx, y: 59 * sy, headingDeg: 180 },
    finishX: finishX * sx,
    cones,
    bridge,
  };
}

/** Surface class at a mat position; offtrack outside the mask. */
export function surfaceAt(mask: TrackMask, xCm: number, yCm: number): number {
  const i = Math.floor(xCm / mask.cmPerPx);
  const j = Math.floor(yCm / mask.cmPerPx);
  if (i < 0 || j < 0 || i >= mask.width || j >= mask.height) return SURFACE.offtrack;
  return mask.classes[j * mask.width + i];
}
