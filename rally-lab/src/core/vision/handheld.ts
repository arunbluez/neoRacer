// Robot tracking with a hand-held phone: no fixed calibration. Every frame the
// mat is found again (matFinder), its corners keep their identity from frame
// to frame, the frame's own homography maps the robot's lights onto the mat,
// and the lights' height above the mat is corrected using the camera position
// worked out from the same homography.

import type { Frame } from '../types';
import type { MarkerColor } from './color';
import { applyH, mat3Inv, type Mat3, type Pt } from './linalg';
import { findMat, matchCorners, quadToMat, type MatQuad, type Quad } from './matFinder';
import { bestOrientation, cameraPose, cmPerPxAt, correctParallax, orientationScore, type BandGrid, type CameraPose } from './matView';
import { Tracker, type TrackResult } from './tracker';

export type HandheldConfig = {
  grid: BandGrid;
  markerA: MarkerColor;
  markerB?: MarkerColor;
  minAreaPx: number;
  /** Mat finder working width (px). */
  workWidth?: number;
  /** Height of marker A (headlights) and marker B (underglow) above the mat, cm. */
  headHeightCm: number;
  ugHeightCm: number;
  /** Which way round the mat is (frame corner of mat corner 0, in the finder's order); null = work it out. */
  rot?: number | null;
  /** Keep using the last mat this long when a frame doesn't show it, ms. */
  holdMatMs?: number;
};

export type CamFix = {
  /** Frame capture time, ms. */
  t: number;
  /** Marker A's ground point, mat cm (parallax corrected). */
  x: number;
  y: number;
  /** B → A, when both markers were seen. */
  headingDeg: number | null;
  /** As seen, before the parallax correction. */
  raw: Pt;
  conf: number;
  /** How coarse the view is at the robot, cm per pixel. */
  cmPerPx: number;
};

export type HandheldFrame = {
  t: number;
  /** This frame's mat detection. */
  mat?: MatQuad;
  /** Mat corners in use, in mat order (corner i = mat corner i: TL, TR, BR, BL). */
  corners?: Quad;
  /** Frame px → mat cm. */
  H?: Mat3;
  /** Age of the mat in use (0 = found in this frame), ms. */
  matAgeMs: number;
  rot: number | null;
  rotScores?: number[];
  cam?: CameraPose;
  fix?: CamFix;
  track?: TrackResult;
  procMs: number;
};

const ROT_VOTES_TO_LOCK = 4;

export class HandheldTracker {
  private cfg: HandheldConfig;
  private tracker?: Tracker;
  private frameW = 0;
  private frameH = 0;
  /** Corners in mat order, and when they were last seen. */
  private matCorners?: Quad;
  private matT = -Infinity;
  private votes = [0, 0, 0, 0];
  private sinceCheck = 0;
  private lastMat?: MatQuad;
  rot: number | null;
  rotScores?: number[];
  /** Why the last frame had no mat (for the status line). */
  lastReject = '';

  constructor(cfg: HandheldConfig) {
    this.cfg = cfg;
    this.rot = cfg.rot ?? null;
  }

  configure(patch: Partial<HandheldConfig>): void {
    this.cfg = { ...this.cfg, ...patch };
    if ('rot' in patch) this.setRot(patch.rot ?? null);
    if ('markerA' in patch || 'markerB' in patch || 'minAreaPx' in patch) this.tracker = undefined;
  }

  /** Fix the orientation (null: work it out again). Re-labels the current corners. */
  setRot(rot: number | null): void {
    this.votes = [0, 0, 0, 0];
    if (rot === null) {
      this.rot = null;
      this.matCorners = undefined;
      return;
    }
    const r = ((rot % 4) + 4) % 4;
    if (this.lastMat) this.matCorners = rotate(this.lastMat.corners, r);
    this.rot = r;
  }

  /** Turn the mat a quarter (when the automatic choice is wrong). */
  rotateBy(k: number): void {
    if (this.matCorners) this.matCorners = rotate(this.matCorners, k);
    this.rot = ((this.rot ?? 0) + k + 4) % 4;
    this.votes = [0, 0, 0, 0];
  }

  /**
   * One frame. hintMat: where marker A's ground point is expected (mat cm),
   * which keeps the search on the robot while the phone moves.
   */
  process(frame: Frame, now: () => number, hintMat?: Pt): HandheldFrame {
    const t0 = now();
    const t = frame.tCaptureMs;
    const out: HandheldFrame = { t, matAgeMs: Infinity, rot: this.rot, procMs: 0 };
    const mat = findMat(frame, { workWidth: this.cfg.workWidth ?? 200, prev: this.lastMat?.corners, onReject: (r) => (this.lastReject = r) });
    if (mat) {
      out.mat = mat;
      this.lastMat = mat;
      this.lastReject = '';
      this.updateCorners(frame, mat, t);
    }
    out.rot = this.rot;
    out.rotScores = this.rotScores;
    const hold = this.cfg.holdMatMs ?? 400;
    if (this.matCorners && t - this.matT <= hold && this.rot !== null) {
      out.corners = this.matCorners;
      out.matAgeMs = t - this.matT;
      const g = this.cfg.grid;
      const H = quadToMat(this.matCorners, 0, g.matWidthCm, g.matHeightCm);
      out.H = H;
      const cam = cameraPose(H, frame.width, frame.height);
      if (cam) out.cam = cam;
      this.trackRobot(frame, H, cam ?? undefined, out, hintMat);
    }
    out.procMs = now() - t0;
    return out;
  }

  private updateCorners(frame: Frame, mat: MatQuad, t: number): void {
    const g = this.cfg.grid;
    const recent = this.matCorners && t - this.matT < 1000;
    if (this.rot === null) {
      // Not known yet: vote over a few frames for the way round that matches the lane pattern.
      const best = bestOrientation(frame, mat.corners, g, mat.threshold);
      this.rotScores = best.scores;
      const second = Math.max(...best.scores.filter((_, i) => i !== best.rot));
      if (best.score > 0.72 && best.score - second > 0.06) this.votes[best.rot]++;
      const lead = this.votes.indexOf(Math.max(...this.votes));
      if (this.votes[lead] >= ROT_VOTES_TO_LOCK) {
        this.rot = lead;
        this.matCorners = rotate(mat.corners, lead);
        this.matT = t;
      }
      return;
    }
    if (recent) {
      this.matCorners = matchCorners(this.matCorners!, mat.corners);
    } else {
      this.matCorners = rotate(mat.corners, this.rot);
    }
    this.matT = t;
    // Now and then, check the labels still fit the lane pattern; switch when
    // another way round fits clearly better (the mat was lost and found turned).
    if (++this.sinceCheck >= 15) {
      this.sinceCheck = 0;
      const cur = mat.corners.indexOf(this.matCorners[0]);
      if (cur < 0) return;
      this.rot = cur;
      const s = orientationScore(frame, mat.corners, cur, g, mat.threshold);
      this.rotScores = [0, 1, 2, 3].map((r) => (r === cur ? s : NaN));
      if (s < 0.65) {
        const best = bestOrientation(frame, mat.corners, g, mat.threshold);
        this.rotScores = best.scores;
        if (best.rot !== cur && best.score > s + 0.15) {
          this.rot = best.rot;
          this.matCorners = rotate(mat.corners, best.rot);
          this.switched++;
        }
      }
    }
  }

  /** Times the orientation was switched by the periodic check. */
  switched = 0;

  private trackRobot(frame: Frame, H: Mat3, cam: CameraPose | undefined, out: HandheldFrame, hintMat?: Pt): void {
    const cfg = this.cfg;
    if (!this.tracker || frame.width !== this.frameW || frame.height !== this.frameH) {
      this.frameW = frame.width;
      this.frameH = frame.height;
      this.tracker = new Tracker({
        H,
        markerA: cfg.markerA,
        markerB: cfg.markerB,
        minAreaPx: cfg.minAreaPx,
        searchRadiusPx: Math.round(frame.width / 10),
        predictMs: 0,
        matWidthCm: cfg.grid.matWidthCm,
        matHeightCm: cfg.grid.matHeightCm,
      });
    }
    let hintA: Pt | undefined;
    if (hintMat) {
      const seen = cam ? unParallax(hintMat, cam, cfg.headHeightCm) : hintMat;
      const inv = mat3Inv(H);
      const p = inv ? applyH(inv, seen) : undefined;
      if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) hintA = p;
    }
    const res = this.tracker.process(frame, { H, hintA });
    out.track = res;
    if (!res.raw || !res.a) return;
    const rawA = { x: res.raw.xCm, y: res.raw.yCm };
    const a = cam ? correctParallax(rawA, cam, cfg.headHeightCm) : rawA;
    let headingDeg: number | null = null;
    if (res.b) {
      const rawB = applyH(H, { x: res.b.cx, y: res.b.cy });
      const b = cam ? correctParallax(rawB, cam, cfg.ugHeightCm) : rawB;
      if (Math.hypot(a.x - b.x, a.y - b.y) > 1) headingDeg = (Math.atan2(a.y - b.y, a.x - b.x) * 180) / Math.PI;
    }
    out.fix = { t: out.t, x: a.x, y: a.y, headingDeg, raw: rawA, conf: res.raw.conf, cmPerPx: cmPerPxAt(H, a) };
  }
}

/** Where a light `heightCm` above ground point g appears on the mat (inverse of correctParallax). */
export function unParallax(g: Pt, cam: Pick<CameraPose, 'x' | 'y' | 'height'>, heightCm: number): Pt {
  if (!(cam.height > heightCm)) return g;
  const k = 1 - heightCm / cam.height;
  return { x: cam.x + (g.x - cam.x) / k, y: cam.y + (g.y - cam.y) / k };
}

function rotate(q: Quad, k: number): Quad {
  const r = ((k % 4) + 4) % 4;
  return [q[r], q[(r + 1) % 4], q[(r + 2) % 4], q[(r + 3) % 4]];
}
