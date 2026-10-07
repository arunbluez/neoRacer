// Colour maths: HSV, mat pixel classes and marker colours.

import type { ImageBuf } from './rectify';

/** h in degrees [0, 360), s and v in 0..1. */
export type Hsv = { h: number; s: number; v: number };

// Hue in degrees [0, 360) from 0..255 channels with their max and min.
function hueOf(r: number, g: number, b: number, max: number, min: number): number {
  const d = max - min;
  if (d === 0) return 0;
  let h: number;
  if (max === r) {
    h = (g - b) / d;
    if (h < 0) h += 6;
  } else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  return h >= 360 ? h - 360 : h;
}

/** Circular distance between two hues, 0..180. */
function hueDist(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/** True if h lies on the arc from lo to hi going upwards (wraps past 360). */
function hueInRange(h: number, lo: number, hi: number): boolean {
  const span = hi - lo;
  if (span >= 360) return true;
  const d = (((h - lo) % 360) + 360) % 360;
  return d <= ((span % 360) + 360) % 360;
}

export function rgbToHsv(r: number, g: number, b: number): Hsv {
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  return { h: hueOf(r, g, b, max, min), s: max > 0 ? (max - min) / max : 0, v: max / 255 };
}

/** RGB 0..255 (rounded). h in degrees (any value, wrapped), s and v 0..1. */
export function hsvToRgb(h: number, s: number, v: number): { r: number; g: number; b: number } {
  const hp = ((((h % 360) + 360) % 360) / 60);
  const c = v * s, x = c * (1 - Math.abs((hp % 2) - 1)), m = v - c;
  let r = 0, g = 0, b = 0;
  if (hp < 1) [r, g] = [c, x];
  else if (hp < 2) [r, g] = [x, c];
  else if (hp < 3) [g, b] = [c, x];
  else if (hp < 4) [g, b] = [x, c];
  else if (hp < 5) [r, b] = [x, c];
  else [r, b] = [c, x];
  return { r: Math.round((r + m) * 255), g: Math.round((g + m) * 255), b: Math.round((b + m) * 255) };
}

export type ClassThresholds = {
  darkV: number;        // v below this -> offtrack (dark mat background)
  borderSMax: number;   // bright & low saturation -> border (white lines)
  borderVMin: number;
  laneSMin: number;     // saturated & hue in [laneHueMin, laneHueMax] (may wrap past 360) -> lane
  laneVMin: number;
  laneHueMin: number;
  laneHueMax: number;
};

/**
 * Tuned on a photo of the real mat (Berlin, Oct 2026): the black background
 * reads as V ≈ 0.25–0.42 under hall lighting, the lane runs blue (≈223°,
 * S ≈ 0.6) → pastel purple (≈295°, S ≈ 0.28) → pink (≈335°, S ≈ 0.56), and
 * the white borders and arrows are S < 0.15.
 */
export const DEFAULT_CLASS_THRESHOLDS: ClassThresholds = {
  darkV: 0.5,
  borderSMax: 0.18,
  borderVMin: 0.62,
  laneSMin: 0.16,
  laneVMin: 0.5,
  laneHueMin: 200,
  laneHueMax: 350,
};

/** none = transparent / outside the mat (alpha < 128). */
export const PIXEL_CLASS = { offtrack: 0, border: 1, lane: 2, other: 3, none: 255 } as const;

/** Rules in order: dark → offtrack, bright and grey → border, lane hue → lane, else other. */
export function classifyRgb(r: number, g: number, b: number, th: ClassThresholds): number {
  const max = r > g ? (r > b ? r : b) : g > b ? g : b;
  const min = r < g ? (r < b ? r : b) : g < b ? g : b;
  const v = max / 255;
  if (v < th.darkV) return PIXEL_CLASS.offtrack;
  const s = max > 0 ? (max - min) / max : 0;
  if (s <= th.borderSMax && v >= th.borderVMin) return PIXEL_CLASS.border;
  if (s >= th.laneSMin && v >= th.laneVMin && hueInRange(hueOf(r, g, b, max, min), th.laneHueMin, th.laneHueMax)) {
    return PIXEL_CLASS.lane;
  }
  return PIXEL_CLASS.other;
}

/**
 * Per-pixel classes (PIXEL_CLASS values). counts = [offtrack, border, lane,
 * other, none]; percentages are over the non-'none' pixels, 0..100.
 */
export function classifyImage(img: ImageBuf, th: ClassThresholds): {
  classes: Uint8Array;
  counts: number[];
  percentages: { offtrack: number; border: number; lane: number; other: number };
} {
  const n = img.width * img.height, d = img.data;
  const classes = new Uint8Array(n);
  const counts = [0, 0, 0, 0, 0];
  for (let p = 0, o = 0; p < n; p++, o += 4) {
    if (d[o + 3] < 128) {
      classes[p] = PIXEL_CLASS.none;
      counts[4]++;
    } else {
      const c = classifyRgb(d[o], d[o + 1], d[o + 2], th);
      classes[p] = c;
      counts[c]++;
    }
  }
  const valid = n - counts[4];
  const pct = (c: number) => (valid > 0 ? (counts[c] / valid) * 100 : 0);
  return { classes, counts, percentages: { offtrack: pct(0), border: pct(1), lane: pct(2), other: pct(3) } };
}

const CLASS_RGBA: Record<number, [number, number, number, number]> = {
  [PIXEL_CLASS.offtrack]: [24, 24, 28, 255],
  [PIXEL_CLASS.border]: [255, 255, 255, 255],
  [PIXEL_CLASS.lane]: [210, 60, 200, 255],
  [PIXEL_CLASS.other]: [255, 140, 0, 255],
};

/** Visualise classes: offtrack near-black, border white, lane magenta, other orange, none transparent. */
export function classesToImage(classes: Uint8Array, width: number, height: number): ImageBuf {
  const n = width * height;
  const data = new Uint8ClampedArray(n * 4);
  for (let p = 0, o = 0; p < n; p++, o += 4) {
    const c = CLASS_RGBA[classes[p]];
    if (c) data.set(c, o);
  }
  return { width, height, data };
}

/**
 * Hue histogram: bins[k] = fraction of all opaque pixels (alpha ≥ 128) that
 * have s ≥ minS, v ≥ minV and hue in [k, k+1)·360/bins. total = opaque pixels.
 * Defaults: 36 bins of 10°, minS 0.25, minV 0.2.
 */
export function hueHistogram(
  img: ImageBuf, opts: { bins?: number; minS?: number; minV?: number } = {},
): { bins: number[]; total: number } {
  const nb = Math.max(1, Math.round(opts.bins ?? 36));
  const minS = opts.minS ?? 0.25, minV255 = (opts.minV ?? 0.2) * 255;
  const counts = new Float64Array(nb);
  const n = img.width * img.height, d = img.data, k = nb / 360;
  let total = 0;
  for (let o = 0; o < n * 4; o += 4) {
    if (d[o + 3] < 128) continue;
    total++;
    const r = d[o], g = d[o + 1], b = d[o + 2];
    const max = r > g ? (r > b ? r : b) : g > b ? g : b;
    const min = r < g ? (r < b ? r : b) : g < b ? g : b;
    if (max < minV255 || max - min < minS * max || max === 0) continue;
    const bin = Math.floor(hueOf(r, g, b, max, min) * k);
    counts[bin < nb ? bin : nb - 1]++;
  }
  return { bins: Array.from(counts, (c) => (total > 0 ? c / total : 0)), total };
}

/**
 * Marker hues the scene barely contains, rarest first, at least 40° apart.
 * Bins are ranked by their fraction smoothed with a Gaussian (σ 25°) around
 * the hue circle, so hues next to common colours rank lower (camera hue
 * drifts with exposure), and among unused hues the ones farthest from the
 * scene's colours come first. Returns bin-centre hues and raw bin fractions.
 */
export function suggestMarkerHues(hist: { bins: number[] }, count = 3): { hue: number; fraction: number }[] {
  const nb = hist.bins.length;
  if (nb === 0) return [];
  const bw = 360 / nb, sigma = 25;
  const score = hist.bins.map((_, i) => {
    let s = 0;
    for (let j = 0; j < nb; j++) {
      if (hist.bins[j] > 0) s += hist.bins[j] * Math.exp(-((hueDist(i * bw, j * bw) / sigma) ** 2));
    }
    return s;
  });
  const order = score.map((_, i) => i).sort((a, b) => score[a] - score[b] || a - b);
  const out: { hue: number; fraction: number }[] = [];
  for (const i of order) {
    if (out.length >= count) break;
    const hue = (i + 0.5) * bw;
    if (out.every((o) => hueDist(o.hue, hue) >= 40)) out.push({ hue, fraction: hist.bins[i] });
  }
  return out;
}

/** A marker LED colour and its acceptance tolerances. */
export type MarkerColor = { h: number; s: number; v: number; hTol: number; sMin: number; vMin: number };

/**
 * Marker colour from a size×size patch centred on the pixel containing
 * (cx, cy): circular mean hue (weighted by s·v so dark and grey pixels barely
 * count), median s and v. Tolerances: hTol 18°, sMin = max(0.25, s/2),
 * vMin = max(0.35, 0.6·v). Throws if the patch has no opaque pixel.
 */
export function sampleMarker(img: ImageBuf, cx: number, cy: number, size = 9): MarkerColor {
  const half = Math.floor(size / 2), ci = Math.floor(cx), cj = Math.floor(cy);
  const { width: w, height: h, data: d } = img;
  const ss: number[] = [], vs: number[] = [];
  let sc = 0, sn = 0;
  for (let j = cj - half; j <= cj + half; j++) {
    if (j < 0 || j >= h) continue;
    for (let i = ci - half; i <= ci + half; i++) {
      if (i < 0 || i >= w) continue;
      const o = (j * w + i) * 4;
      if (d[o + 3] < 128) continue;
      const c = rgbToHsv(d[o], d[o + 1], d[o + 2]);
      const a = (c.h * Math.PI) / 180, wt = c.s * c.v;
      sc += wt * Math.cos(a);
      sn += wt * Math.sin(a);
      ss.push(c.s);
      vs.push(c.v);
    }
  }
  if (ss.length === 0) throw new RangeError('sampleMarker: no opaque pixels around the point');
  const median = (a: number[]) => {
    a.sort((x, y) => x - y);
    const m = a.length >> 1;
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  };
  let hue = (Math.atan2(sn, sc) * 180) / Math.PI;
  if (hue < 0) hue += 360;
  const s = median(ss), v = median(vs);
  return { h: hue, s, v, hTol: 18, sMin: Math.max(0.25, s * 0.5), vMin: Math.max(0.35, v * 0.6) };
}

/** Hue within hTol (circular), s ≥ sMin and v ≥ vMin. */
export function matchesMarker(r: number, g: number, b: number, m: MarkerColor): boolean {
  const max = r > g ? (r > b ? r : b) : g > b ? g : b;
  if (max < m.vMin * 255) return false;
  const min = r < g ? (r < b ? r : b) : g < b ? g : b;
  if (max - min < m.sMin * max) return false;
  return hueDist(hueOf(r, g, b, max, min), m.h) <= m.hTol;
}

/**
 * A marker colour for an LED set to `rgb`, before anyone has sampled it from
 * the camera: its hue, with tolerances wide enough for a saturated LED's
 * coloured halo.
 */
export function defaultMarkerColor(rgb: { r: number; g: number; b: number }): MarkerColor {
  const c = rgbToHsv(rgb.r, rgb.g, rgb.b);
  return { h: c.h, s: Math.max(0.5, c.s), v: Math.max(0.6, c.v), hTol: 28, sMin: 0.3, vMin: 0.45 };
}
