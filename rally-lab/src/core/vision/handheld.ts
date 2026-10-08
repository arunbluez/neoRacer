// Robot tracking with a hand-held phone: no fixed calibration. Every frame the
// track is found again by its painted lane (laneFit: works in a busy hall and
// needs only the track in view, not the whole mat), the frame's own
// homography maps the robot's lights onto the mat, and the lights' height
// above the mat is corrected using the camera position worked out from the
// same homography. Only lights near where our robot should be count (other
// robots on the track carry lights too): near the start line before a run,
// near the estimate during one, or where the blink test found it.

import type { Frame } from '../types';
import { findBlobs, thresholdMarker, type Rect } from './blob';
import type { MarkerColor } from './color';
import { applyH, type Mat3, type Pt } from './linalg';
import { fitTrack, laneFrame, matCornersOf, type FitResult, type LaneModel } from './laneFit';
import { findMat, type Quad } from './matFinder';
import { cameraPose, cmPerPxAt, correctParallax, type CameraPose } from './matView';

export type HandheldConfig = {
  model: LaneModel;
  marker: MarkerColor;
  minAreaPx: number;
  /** Lane-fit working width, px. */
  workWidth?: number;
  /** Height of the marker lights above the mat, cm. */
  markerHeightCm: number;
  /** Keep using the last fit this long when a frame doesn't give one, ms. */
  holdMatMs?: number;
};

export type CamFix = {
  /** Where this light centre is ahead of the axle, cm (set by the app while headlights signal). */
  aheadCm?: number;
  /** Frame capture time, ms. */
  t: number;
  /** The marker's ground point, mat cm (parallax corrected). */
  x: number;
  y: number;
  /** Not measured in this mode (one colour for all lights). */
  headingDeg: number | null;
  /** As seen, before the parallax correction. */
  raw: Pt;
  conf: number;
  /** How coarse the view is at the robot, cm per pixel. */
  cmPerPx: number;
  /** Image position, frame px. */
  px: Pt;
};

/** Where to look for our robot: a circle on the mat (ground cm). */
/** Where our robot can be: a circle, plus optionally a strip along a polyline (trail) of the given half-width. */
export type Gate = { center: Pt; radiusCm: number; trail?: Pt[]; trailRadiusCm?: number };

/** Inside the gate (the circle, or near the trail). */
export function inGate(g: Gate, p: Pt): boolean {
  if (Math.hypot(p.x - g.center.x, p.y - g.center.y) <= g.radiusCm) return true;
  const r = g.trailRadiusCm ?? 0;
  return !!g.trail && r > 0 && g.trail.some((q) => Math.hypot(p.x - q.x, p.y - q.y) <= r);
}

export type Blob = { x: number; y: number; raw: Pt; px: Pt; area: number };

export type HandheldFrame = {
  t: number;
  fit?: FitResult;
  /** Mat corners in frame px (TL, TR, BR, BL), from the fit. */
  corners?: Quad;
  /** Frame px → mat cm, and back. */
  H?: Mat3;
  G?: Mat3;
  /** Age of the fit in use (0 = this frame), ms. */
  matAgeMs: number;
  /** Which side of the mat the phone is on: b (near end), c, d, a/g. */
  side: string | null;
  cam?: CameraPose;
  fix?: CamFix;
  /** Lights seen inside the gate (or anywhere without one). */
  blobs: number;
  gate?: Gate;
  procMs: number;
};

export const SIDES: Record<string, string> = { b: 'b (near end)', c: 'c (bridge side)', d: 'd (far end)', a: 'a/g (start side)' };

/** The mat side the camera stands at, from its position. */
export function sideOf(cam: Pick<CameraPose, 'x' | 'y'>, w: number, h: number): string {
  const ex = { b: cam.y - h, c: cam.x - w, d: -cam.y, a: -cam.x };
  let best: keyof typeof ex = 'b';
  for (const k of Object.keys(ex) as (keyof typeof ex)[]) if (ex[k] > ex[best]) best = k;
  return best;
}

export class HandheldTracker {
  private cfg: HandheldConfig;
  private G?: Mat3;
  private H?: Mat3;
  private fitT = -Infinity;
  private lastFit?: FitResult;
  private forceFull = true;
  /** Why the last frame had no track (for the status line). */
  lastReject = '';

  constructor(cfg: HandheldConfig) {
    this.cfg = cfg;
  }

  configure(patch: Partial<HandheldConfig>): void {
    this.cfg = { ...this.cfg, ...patch };
  }

  /** Search from scratch on the next frame. */
  redetect(): void {
    this.forceFull = true;
  }

  /** The fit's homography for a frame time, if fresh enough. */
  current(t: number): { H: Mat3; G: Mat3 } | null {
    return this.H && this.G && t - this.fitT <= (this.cfg.holdMatMs ?? 500) ? { H: this.H, G: this.G } : null;
  }

  /** One frame. gate: where our robot can be (mat cm, ground); none = anywhere on the mat. */
  process(frame: Frame, now: () => number, gate?: Gate): HandheldFrame {
    const t0 = now();
    const t = frame.tCaptureMs;
    const out: HandheldFrame = { t, matAgeMs: Infinity, side: null, blobs: 0, gate, procMs: 0 };
    const m = this.cfg.model;
    const lf = laneFrame(frame, this.cfg.workWidth ?? 320);
    const tracking = !this.forceFull && this.G && t - this.fitT < 600;
    let matQuad: Quad | undefined;
    if (!tracking) {
      const mq = findMat(frame);
      if (mq && !mq.touchesBorder) matQuad = mq.corners;
    }
    const fit = fitTrack(frame, m, { prev: tracking ? this.G : undefined, matQuad, full: !tracking }, lf);
    if (fit) {
      this.G = fit.G;
      this.H = fit.H;
      this.fitT = t;
      this.lastFit = fit;
      this.forceFull = false;
      this.lastReject = '';
      out.fit = fit;
    } else {
      this.lastReject = lf.edges < 30 ? 'no lane in view' : 'lane does not fit';
    }
    const cur = this.current(t);
    if (cur) {
      out.H = cur.H;
      out.G = cur.G;
      out.matAgeMs = t - this.fitT;
      out.corners = matCornersOf(cur.G, m.matWidthCm, m.matHeightCm);
      const cam = cameraPose(cur.H, frame.width, frame.height);
      if (cam) {
        out.cam = cam;
        out.side = sideOf(cam, m.matWidthCm, m.matHeightCm);
      }
      const blobs = this.blobs(frame, cur, cam ?? undefined, gate);
      out.blobs = blobs.length;
      // Ours: the nearest to the gate's centre, else the biggest.
      const pick = gate
        ? blobs.reduce<Blob | undefined>((b, x) => (!b || Math.hypot(x.x - gate.center.x, x.y - gate.center.y) < Math.hypot(b.x - gate.center.x, b.y - gate.center.y) ? x : b), undefined)
        : blobs.reduce<Blob | undefined>((b, x) => (!b || x.area > b.area ? x : b), undefined);
      if (pick) {
        out.fix = {
          t, x: pick.x, y: pick.y, headingDeg: null, raw: pick.raw, px: pick.px,
          conf: Math.min(1, pick.area / (pick.area + 2 * this.cfg.minAreaPx)), cmPerPx: cmPerPxAt(cur.H, pick),
        };
      }
    }
    out.procMs = now() - t0;
    return out;
  }

  /**
   * Marker-coloured lights on the mat (inside the gate when given), lights
   * within 8 cm of each other merged (one robot's four LEDs).
   */
  blobs(frame: Frame, cur: { H: Mat3; G: Mat3 }, cam: CameraPose | undefined, gate?: Gate): Blob[] {
    const m = this.cfg.model;
    let win: Rect = { x0: 0, y0: 0, x1: frame.width, y1: frame.height };
    if (gate) {
      // The gate's box in the frame (seen positions are pushed away from the camera: widen a little).
      const boxes: { c: Pt; r: number }[] = [{ c: gate.center, r: gate.radiusCm * 1.3 + 4 }];
      for (const q of gate.trail ?? []) boxes.push({ c: q, r: (gate.trailRadiusCm ?? 0) * 1.3 + 4 });
      const corners = boxes.flatMap(({ c, r }) => [{ x: c.x - r, y: c.y - r }, { x: c.x + r, y: c.y - r }, { x: c.x + r, y: c.y + r }, { x: c.x - r, y: c.y + r }]);
      const pts = corners.map((p) => applyH(cur.G, p)).filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
      if (pts.length === corners.length) {
        win = {
          x0: Math.max(0, Math.min(...pts.map((p) => p.x)) - 6), y0: Math.max(0, Math.min(...pts.map((p) => p.y)) - 6),
          x1: Math.min(frame.width, Math.max(...pts.map((p) => p.x)) + 6), y1: Math.min(frame.height, Math.max(...pts.map((p) => p.y)) + 6),
        };
      }
    }
    if (win.x1 <= win.x0 || win.y1 <= win.y0) return [];
    const mask = thresholdMarker(frame, this.cfg.marker, win, this.maskBuf);
    this.maskBuf = mask;
    const raw = findBlobs(mask, frame.width, frame.height, this.cfg.minAreaPx, win, 40);
    const seen = raw.map((b) => {
      const r = applyH(cur.H, { x: b.cx, y: b.cy });
      const g = cam ? correctParallax(r, cam, this.cfg.markerHeightCm) : r;
      return { x: g.x, y: g.y, raw: r, px: { x: b.cx, y: b.cy }, area: b.area };
    }).filter((b) => Number.isFinite(b.x) && b.x > -10 && b.y > -10 && b.x < m.matWidthCm + 10 && b.y < m.matHeightCm + 10);
    // merge lights within 8 cm (biggest first)
    seen.sort((a, b) => b.area - a.area);
    const merged: Blob[] = [];
    for (const s of seen) {
      const host = merged.find((g) => Math.hypot(g.x - s.x, g.y - s.y) < 8);
      if (!host) {
        merged.push({ ...s, raw: { ...s.raw }, px: { ...s.px } });
        continue;
      }
      const a = host.area + s.area;
      for (const k of ['x', 'y'] as const) {
        host[k] = (host[k] * host.area + s[k] * s.area) / a;
        host.raw[k] = (host.raw[k] * host.area + s.raw[k] * s.area) / a;
        host.px[k] = (host.px[k] * host.area + s.px[k] * s.area) / a;
      }
      host.area = a;
    }
    return gate ? merged.filter((b) => inGate(gate, b)) : merged;
  }

  private maskBuf?: Uint8Array;

  get fit(): FitResult | undefined {
    return this.lastFit;
  }
}

/** Where a light `heightCm` above ground point g appears on the mat (inverse of correctParallax). */
export function unParallax(g: Pt, cam: Pick<CameraPose, 'x' | 'y' | 'height'>, heightCm: number): Pt {
  if (!(cam.height > heightCm)) return g;
  const k = 1 - heightCm / cam.height;
  return { x: cam.x + (g.x - cam.x) / k, y: cam.y + (g.y - cam.y) / k };
}

