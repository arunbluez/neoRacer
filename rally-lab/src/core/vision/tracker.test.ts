import { describe, it, expect } from 'vitest';
import { applyH, mat3Inv, normalizeH, scaleHomography } from './linalg';
import type { Pt } from './linalg';
import { fillDisc, renderPerspective } from './rectify';
import type { ImageBuf } from './rectify';
import { rgbToHsv } from './color';
import type { MarkerColor } from './color';
import { angleDiffDeg } from './pose';
import { Tracker } from './tracker';
import type { TrackResult } from './tracker';
import { buildCalibration } from './calibration';
import { drawSyntheticMat, syntheticCameraH } from './synthetic';

function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rgb = [number, number, number];
const MW = 300, MH = 250, PW = 640, PH = 360;
const GREEN: Rgb = [40, 230, 70], YELLOW: Rgb = [250, 215, 20];
const marker = (rgb: Rgb): MarkerColor => {
  const c = rgbToHsv(...rgb);
  return { ...c, hTol: 18, sMin: Math.max(0.25, c.s / 2), vMin: Math.max(0.35, c.v * 0.6) };
};

// Calibrated at 1280×720, tracked on frames scaled down to 640×360.
const HcamFull = syntheticCameraH({
  imageWidth: 1280, imageHeight: 720, hfovDeg: 68,
  eye: { x: 150, y: 430, height: 200 }, target: { x: 150, y: 140 },
});
const cal = buildCalibration({
  id: 'test', createdAt: '2026-10-07T00:00:00Z', imageWidth: 1280, imageHeight: 720,
  corners: [{ x: 0, y: 0 }, { x: MW, y: 0 }, { x: MW, y: MH }, { x: 0, y: MH }].map((p) => applyH(HcamFull, p)),
  matWidthCm: MW, matHeightCm: MH,
});
const Hproc = scaleHomography(cal.H, 1280 / PW, 720 / PH);
const toProc = (p: Pt) => {
  const q = applyH(HcamFull, p);
  return { x: q.x / 2, y: q.y / 2 };
};

// Rendered mat with a little sensor noise, reused for every frame.
const background = (() => {
  const img = renderPerspective(drawSyntheticMat(2), MW, MH, scaleHomography(normalizeH(mat3Inv(HcamFull)!), 2, 2), PW, PH, [10, 10, 12]);
  const r = rng(5);
  for (let i = 0; i < img.data.length; i += 4) for (let c = 0; c < 3; c++) img.data[i + c] += Math.round((r() - 0.5) * 12);
  return img;
})();

function frameWith(discs: { at: Pt; rgb: Rgb; r?: number }[], out?: ImageBuf): ImageBuf {
  const img = out ?? { width: PW, height: PH, data: new Uint8ClampedArray(background.data.length) };
  img.data.set(background.data);
  for (const d of discs) fillDisc(img, d.at.x, d.at.y, d.r ?? 3.5, d.rgb);
  return img;
}

// Robot drives in a straight line; A (front) leads B by 10 cm.
const START = { x: 60, y: 190 }, VEL = { x: 90, y: -25 }; // cm/s
const HEADING = (Math.atan2(VEL.y, VEL.x) * 180) / Math.PI;
const SEP = 10;
function truth(tS: number) {
  const a = { x: START.x + VEL.x * tS, y: START.y + VEL.y * tS };
  const u = Math.hypot(VEL.x, VEL.y);
  return { a, b: { x: a.x - (SEP * VEL.x) / u, y: a.y - (SEP * VEL.y) / u } };
}

const baseCfg = {
  H: Hproc, markerA: marker(GREEN), markerB: marker(YELLOW), minAreaPx: 6, searchRadiusPx: 60,
  predictMs: 50, matWidthCm: MW, matHeightCm: MH,
};

describe('Tracker', () => {
  it('tracks both markers, survives a dropout and recovers', () => {
    const tr = new Tracker(baseCfg);
    const results: TrackResult[] = [];
    const buf = frameWith([]);
    for (let k = 0; k < 60; k++) {
      const tS = k / 30, { a, b } = truth(tS);
      const hidden = k >= 30 && k < 36; // 6 frames without markers
      const f = frameWith(hidden ? [] : [{ at: toProc(b), rgb: YELLOW }, { at: toProc(a), rgb: GREEN }], buf);
      const res = tr.process({ ...f, tCaptureMs: 5000 + tS * 1000 });
      results.push(res);
      expect(res.tFrame).toBe(5000 + tS * 1000);
      if (hidden) {
        expect(res.a).toBeUndefined();
        expect(res.raw).toBeUndefined();
        expect(res.filtered).toBeUndefined();
        expect(res.predicted).toBeDefined(); // coasting
        continue;
      }
      expect(res.a).toBeDefined();
      expect(res.b).toBeDefined();
      expect(res.candidates).toBe(1);
      const raw = res.raw!;
      expect(Math.hypot(raw.xCm - a.x, raw.yCm - a.y)).toBeLessThan(1);
      expect(Math.abs(angleDiffDeg(raw.headingDeg!, HEADING))).toBeLessThan(4);
      expect(raw.conf).toBeGreaterThan(0.5);
      expect(res.filtered).toBeDefined();
      expect(res.predicted!.t).toBe(res.tFrame + 50);
    }
    const last = results[59].filtered!;
    expect(Math.abs(last.vx - VEL.x)).toBeLessThan(9);
    expect(Math.abs(last.vy - VEL.y)).toBeLessThan(9);
    expect(Math.abs(angleDiffDeg(last.headingDeg, HEADING))).toBeLessThan(3);
    const { a } = truth(59 / 30);
    expect(Math.hypot(last.x - a.x, last.y - a.y)).toBeLessThan(1.5);
  });

  it('uses velocity for heading with marker A only, and ignores detections off the mat', () => {
    const tr = new Tracker({ ...baseCfg, markerB: undefined });
    // A larger green light in the background, far off the mat.
    const decoy = { at: { x: 40, y: 15 }, rgb: GREEN, r: 6 };
    expect(applyH(Hproc, decoy.at).y).toBeLessThan(-50);
    let res: TrackResult | undefined;
    for (let k = 0; k < 45; k++) {
      const tS = k / 30, { a } = truth(tS);
      res = tr.process({ ...frameWith([decoy, { at: toProc(a), rgb: GREEN }]), tCaptureMs: tS * 1000 });
      expect(res.b).toBeUndefined();
      expect(res.raw!.headingDeg).toBeNull();
      expect(Math.hypot(res.raw!.xCm - a.x, res.raw!.yCm - a.y)).toBeLessThan(1);
      if (k === 0) expect(res.candidates).toBe(2); // whole-frame search sees the decoy too
    }
    expect(Math.abs(angleDiffDeg(res!.filtered!.headingDeg, HEADING))).toBeLessThan(5);
  });

  it('processes a 640×360 frame quickly', () => {
    const tr = new Tracker(baseCfg);
    const frames = Array.from({ length: 30 }, (_, k) => {
      const { a, b } = truth(k / 30);
      return frameWith([{ at: toProc(b), rgb: YELLOW }, { at: toProc(a), rgb: GREEN }]);
    });
    const empty = frameWith([]);
    const run = (n: number, lost: boolean) => {
      const t0 = performance.now();
      for (let i = 0; i < n; i++) {
        const f = lost ? empty : frames[i % frames.length];
        tr.process({ ...f, tCaptureMs: i * 33 });
      }
      return (performance.now() - t0) / n;
    };
    run(60, false); // warm-up
    run(20, true);
    const tracking = run(300, false);
    const lost = run(100, true); // whole-frame search for both markers every frame
    expect(tracking).toBeLessThan(40);
    expect(lost).toBeLessThan(40);
  });
});

describe('tracker: paired lights', () => {
  it('merges two headlights into one marker at their midpoint', async () => {
    const { Tracker } = await import('./tracker');
    const { fillDisc } = await import('./rectify');
    const w = 320;
    const h = 180;
    const mk = (lx: number, rx: number, rLeft: number) => {
      const data = new Uint8ClampedArray(w * h * 4);
      for (let i = 0; i < w * h; i++) data[i * 4 + 3] = 255;
      const img = { width: w, height: h, data };
      fillDisc(img, lx, 90, rLeft, [0, 255, 0]);
      fillDisc(img, rx, 90, 2, [0, 255, 0]);
      return { ...img, tCaptureMs: 0 };
    };
    // 1 px = 1 cm
    const t = new Tracker({ H: [1, 0, 0, 0, 1, 0, 0, 0, 1], markerA: { h: 120, s: 1, v: 1, hTol: 15, sMin: 0.5, vMin: 0.5 }, minAreaPx: 4, searchRadiusPx: 60, predictMs: 0 });
    // the left light alternates between slightly larger and slightly smaller than the right one
    const xs: number[] = [];
    for (let i = 0; i < 6; i++) {
      const r = t.process({ ...mk(100, 105, i % 2 ? 2.4 : 1.8), tCaptureMs: i * 33 });
      xs.push(r.raw!.xCm);
    }
    for (const x of xs) expect(Math.abs(x - 103)).toBeLessThan(1.5);
    expect(Math.max(...xs) - Math.min(...xs)).toBeLessThan(1.5);
  });
});
