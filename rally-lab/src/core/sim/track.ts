// A synthetic mat that resembles the race track: black background, a lane
// with a blue -> purple -> pink gradient and white borders, a checkered
// start/finish at the top left, a serpentine of hairpins, and red cones.
// Used by the mock robot's line sensors and the simulated camera. When a real
// track mask has been exported, the mock uses that instead.

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
  cones: Pt2[];
  /** Area under the wooden bridge (darker for the light sensor). */
  bridge: { x0: number; y0: number; x1: number; y1: number };
};

const ROUTE: Pt2[] = [
  { x: 95, y: 30 }, { x: 40, y: 30 }, { x: 30, y: 45 }, { x: 30, y: 205 }, { x: 45, y: 220 },
  { x: 255, y: 220 }, { x: 270, y: 205 }, { x: 270, y: 45 }, { x: 255, y: 30 }, { x: 232, y: 30 },
  { x: 217, y: 45 }, { x: 217, y: 172 }, { x: 202, y: 187 }, { x: 187, y: 172 }, { x: 187, y: 76 },
  { x: 172, y: 61 }, { x: 157, y: 76 }, { x: 157, y: 172 }, { x: 142, y: 187 }, { x: 127, y: 172 },
  { x: 127, y: 45 }, { x: 112, y: 30 },
];

/** Chaikin corner cutting on a closed polyline. */
function smooth(pts: Pt2[], iterations: number): Pt2[] {
  let p = pts;
  for (let k = 0; k < iterations; k++) {
    const out: Pt2[] = [];
    for (let i = 0; i < p.length; i++) {
      const a = p[i];
      const b = p[(i + 1) % p.length];
      out.push({ x: 0.75 * a.x + 0.25 * b.x, y: 0.75 * a.y + 0.25 * b.y });
      out.push({ x: 0.25 * a.x + 0.75 * b.x, y: 0.25 * a.y + 0.75 * b.y });
    }
    p = out;
  }
  return p;
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

export function makeSyntheticTrack(opts: { matWidthCm?: number; matHeightCm?: number; cmPerPx?: number } = {}): SyntheticTrack {
  const matWidthCm = opts.matWidthCm ?? 300;
  const matHeightCm = opts.matHeightCm ?? 250;
  const cmPerPx = opts.cmPerPx ?? 0.5;
  const sx = matWidthCm / 300;
  const sy = matHeightCm / 250;
  const centerline = smooth(ROUTE.map((p) => ({ x: p.x * sx, y: p.y * sy })), 3);
  const laneWidthCm = 20;
  const borderCm = 2.5;
  const { cum, total } = pathLengths(centerline);

  const width = Math.round(matWidthCm / cmPerPx);
  const height = Math.round(matHeightCm / cmPerPx);
  const classes = new Uint8Array(width * height);
  const data = new Uint8ClampedArray(width * height * 4);
  const half = laneWidthCm / 2;
  const start = { x: 95 * sx, y: 30 * sy };
  const finishX = 100 * sx; // checkered strip just behind the start, across the lane

  // Coarse grid of path distances speeds up the per-pixel search: skip pixels far from any segment.
  for (let j = 0; j < height; j++) {
    const y = (j + 0.5) * cmPerPx;
    for (let i = 0; i < width; i++) {
      const x = (i + 0.5) * cmPerPx;
      const { d, s } = nearestOnPath(centerline, cum, total, x, y);
      const o = (j * width + i) * 4;
      let cls: number = SURFACE.offtrack;
      let r = 12;
      let g = 12;
      let b = 16;
      if (d < half) {
        cls = SURFACE.lane;
        // blue (220°) -> purple (275°) -> pink (330°) along the route
        [r, g, b] = hsvToRgbBytes(220 + 110 * s, 0.75, 0.85);
        if (Math.abs(x - finishX) < 4 && Math.abs(y - start.y) < half) {
          const checker = (Math.floor(x / 2) + Math.floor(y / 2)) % 2 === 0;
          [r, g, b] = checker ? [240, 240, 240] : [15, 15, 15];
          cls = checker ? SURFACE.border : SURFACE.offtrack;
        }
      } else if (d < half + borderCm) {
        cls = SURFACE.border;
        r = g = b = 235;
      }
      classes[j * width + i] = cls;
      data[o] = r;
      data[o + 1] = g;
      data[o + 2] = b;
      data[o + 3] = 255;
    }
  }

  const cones: Pt2[] = [
    { x: 202 * sx, y: 200 * sy }, { x: 172 * sx, y: 48 * sy }, { x: 142 * sx, y: 200 * sy },
    { x: 110 * sx, y: 238 * sy }, { x: 190 * sx, y: 238 * sy },
  ];
  for (const c of cones) {
    const r = 3 / cmPerPx;
    const ci = c.x / cmPerPx;
    const cj = c.y / cmPerPx;
    for (let j = Math.max(0, Math.floor(cj - r)); j <= Math.min(height - 1, Math.ceil(cj + r)); j++) {
      for (let i = Math.max(0, Math.floor(ci - r)); i <= Math.min(width - 1, Math.ceil(ci + r)); i++) {
        const dd = Math.hypot(i + 0.5 - ci, j + 0.5 - cj);
        if (dd > r) continue;
        const o = (j * width + i) * 4;
        const white = dd > r * 0.45 && dd < r * 0.7;
        data[o] = white ? 240 : 220;
        data[o + 1] = white ? 240 : 40;
        data[o + 2] = white ? 240 : 30;
        classes[j * width + i] = SURFACE.other;
      }
    }
  }

  return {
    matWidthCm,
    matHeightCm,
    centerline,
    laneWidthCm,
    borderCm,
    mask: { width, height, cmPerPx, classes },
    image: { width, height, data },
    start: { x: start.x, y: start.y, headingDeg: 180 },
    cones,
    bridge: { x0: 15 * sx, y0: 100 * sy, x1: 45 * sx, y1: 140 * sy },
  };
}

/** Surface class at a mat position; offtrack outside the mask. */
export function surfaceAt(mask: TrackMask, xCm: number, yCm: number): number {
  const i = Math.floor(xCm / mask.cmPerPx);
  const j = Math.floor(yCm / mask.cmPerPx);
  if (i < 0 || j < 0 || i >= mask.width || j >= mask.height) return SURFACE.offtrack;
  return mask.classes[j * mask.width + i];
}
