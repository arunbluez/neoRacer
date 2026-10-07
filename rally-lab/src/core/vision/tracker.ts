// Frame-by-frame tracking of the robot's two light markers.
// Marker A (headlights, front) gives the position; marker B (underglow,
// centre) gives the heading B→A when both are seen; otherwise the heading
// comes from the filtered velocity.

import { applyH } from './linalg';
import type { Mat3, Pt } from './linalg';
import type { MarkerColor } from './color';
import { findBlobs, thresholdMarker } from './blob';
import type { Blob, Rect } from './blob';
import { AlphaBetaPoseFilter } from './pose';
import type { FilteredPose } from './pose';

export type TrackerConfig = {
  H: Mat3;                 // processed-frame pixels -> mat cm
  markerA: MarkerColor;    // front (headlights)
  markerB?: MarkerColor;   // rear/centre (underglow)
  minAreaPx: number;       // default 6
  searchRadiusPx: number;  // default 60; whole frame when lost
  alpha?: number; beta?: number;
  predictMs: number;       // forward prediction for display (latency compensation)
  matWidthCm?: number; matHeightCm?: number; // optional: reject detections mapping outside the mat (with a small margin)
};

export const TRACKER_DEFAULTS = { minAreaPx: 6, searchRadiusPx: 60, predictMs: 0 } as const;

export type TrackResult = {
  tFrame: number;
  procMs?: number;             // left undefined; caller measures
  a?: Blob; b?: Blob;          // in frame pixels
  raw?: { xCm: number; yCm: number; headingDeg: number | null; conf: number };
  filtered?: FilteredPose;
  predicted?: FilteredPose;
  candidates: number;          // number of blobs >= minAreaPx found for marker A (for false-detection stats)
};

const LOST_AFTER = 5;      // frames without a detection before the whole frame is searched
const MAT_MARGIN_CM = 10;  // detections may lie this far outside the mat
const MIN_SEP_CM = 1;      // B must be this far from A to define a heading...
const MAX_SEP_CM = 40;     // ...and no farther than this to be the same robot
const COAST_MS = 500;      // keep predicting this long after the last detection

type MarkerTrack = { mask: Uint8Array; last: Pt | null; misses: number };
type Found = { blob?: Blob; mat?: Pt; candidates: number };

export class Tracker {
  private cfg: TrackerConfig;
  private filter: AlphaBetaPoseFilter;
  private ta: MarkerTrack = { mask: new Uint8Array(0), last: null, misses: LOST_AFTER };
  private tb: MarkerTrack = { mask: new Uint8Array(0), last: null, misses: LOST_AFTER };
  private w = 0;
  private h = 0;

  constructor(cfg: TrackerConfig) {
    this.cfg = { ...cfg };
    this.filter = this.makeFilter();
  }

  /** Merge config. New H or marker colours restart tracking; new alpha/beta rebuild the filter. */
  setConfig(cfg: Partial<TrackerConfig>): void {
    this.cfg = { ...this.cfg, ...cfg };
    if ('alpha' in cfg || 'beta' in cfg) this.filter = this.makeFilter();
    if ('H' in cfg || 'markerA' in cfg || 'markerB' in cfg) this.reset();
  }

  reset(): void {
    for (const t of [this.ta, this.tb]) {
      t.last = null;
      t.misses = LOST_AFTER;
    }
    this.filter.reset();
  }

  process(frame: { width: number; height: number; data: Uint8ClampedArray; tCaptureMs: number }): TrackResult {
    const { width: w, height: h, tCaptureMs: t } = frame;
    if (w !== this.w || h !== this.h) {
      this.w = w;
      this.h = h;
      this.ta.mask = new Uint8Array(w * h);
      this.tb.mask = new Uint8Array(w * h);
      this.reset();
    }
    const cfg = this.cfg;
    const res: TrackResult = { tFrame: t, candidates: 0 };

    const inMat = (p: Pt) => {
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return false;
      if (cfg.matWidthCm === undefined || cfg.matHeightCm === undefined) return true;
      return p.x >= -MAT_MARGIN_CM && p.y >= -MAT_MARGIN_CM &&
        p.x <= cfg.matWidthCm + MAT_MARGIN_CM && p.y <= cfg.matHeightCm + MAT_MARGIN_CM;
    };

    const fa = this.search(frame, this.ta, cfg.markerA, this.ta.misses < LOST_AFTER ? this.ta.last : null, inMat);
    res.candidates = fa.candidates;

    let fb: Found = { candidates: 0 };
    const bTracked = this.tb.misses < LOST_AFTER && this.tb.last !== null;
    // B sits near A: search around its own last position, else around A.
    // With both lost, a whole-frame search for B would be wasted work.
    if (cfg.markerB && (bTracked || fa.blob)) {
      const centre = bTracked ? this.tb.last : fa.blob ? { x: fa.blob.cx, y: fa.blob.cy } : null;
      const aMat = fa.mat;
      fb = this.search(frame, this.tb, cfg.markerB, centre, (p) => {
        if (!inMat(p)) return false;
        if (!aMat) return true;
        const d = Math.hypot(p.x - aMat.x, p.y - aMat.y);
        return d >= MIN_SEP_CM && d <= MAX_SEP_CM;
      });
    }

    if (fa.blob && fa.mat) {
      res.a = fa.blob;
      let headingDeg: number | null = null, conf = fa.blob.conf;
      if (fb.blob && fb.mat) {
        headingDeg = (Math.atan2(fa.mat.y - fb.mat.y, fa.mat.x - fb.mat.x) * 180) / Math.PI;
        conf = Math.min(conf, fb.blob.conf);
      }
      res.raw = { xCm: fa.mat.x, yCm: fa.mat.y, headingDeg, conf };
      res.filtered = this.filter.update({ x: fa.mat.x, y: fa.mat.y, headingDeg }, t);
    }
    if (fb.blob) res.b = fb.blob;

    // Latency-compensated pose; keeps coasting briefly while A is unseen.
    const st = this.filter.state;
    if (st && t - st.t <= COAST_MS) {
      const p = this.filter.predict(t + (cfg.predictMs ?? TRACKER_DEFAULTS.predictMs));
      if (p) res.predicted = p;
    }
    return res;
  }

  private makeFilter(): AlphaBetaPoseFilter {
    return new AlphaBetaPoseFilter({ alpha: this.cfg.alpha, beta: this.cfg.beta });
  }

  // Threshold + components in a window around `centre` (whole frame if null);
  // the largest blob whose mat position passes `accept` wins.
  private search(
    frame: { width: number; height: number; data: Uint8ClampedArray },
    track: MarkerTrack, m: MarkerColor, centre: Pt | null, accept: (p: Pt) => boolean,
  ): Found {
    const { width: w, height: h } = frame;
    const r = this.cfg.searchRadiusPx ?? TRACKER_DEFAULTS.searchRadiusPx;
    const win: Rect = centre
      ? { x0: centre.x - r, y0: centre.y - r, x1: centre.x + r, y1: centre.y + r }
      : { x0: 0, y0: 0, x1: w, y1: h };
    track.mask = thresholdMarker(frame, m, win, track.mask);
    const blobs = findBlobs(track.mask, w, h, this.cfg.minAreaPx ?? TRACKER_DEFAULTS.minAreaPx, win);
    for (const blob of blobs) {
      const mat = applyH(this.cfg.H, { x: blob.cx, y: blob.cy });
      if (!accept(mat)) continue;
      track.last = { x: blob.cx, y: blob.cy };
      track.misses = 0;
      return { blob, mat, candidates: blobs.length };
    }
    track.misses++;
    return { candidates: blobs.length };
  }
}
