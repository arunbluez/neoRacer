import { describe, it, expect } from 'vitest';
import {
  DEFAULT_CLASS_THRESHOLDS, PIXEL_CLASS, classesToImage, classifyImage, classifyRgb, hsvToRgb, hueHistogram,
  matchesMarker, rgbToHsv, sampleMarker, suggestMarkerHues,
} from './color';
import { fillDisc } from './rectify';
import type { ImageBuf } from './rectify';
import { drawSyntheticMat } from './synthetic';

const hueDist = (a: number, b: number) => {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
};

describe('hsv', () => {
  it('converts known colours', () => {
    expect(rgbToHsv(255, 0, 0)).toEqual({ h: 0, s: 1, v: 1 });
    expect(rgbToHsv(0, 255, 0).h).toBeCloseTo(120, 9);
    expect(rgbToHsv(0, 0, 255).h).toBeCloseTo(240, 9);
    expect(rgbToHsv(255, 0, 128).h).toBeCloseTo(329.9, 1);
    expect(rgbToHsv(0, 0, 0)).toEqual({ h: 0, s: 0, v: 0 });
    expect(hsvToRgb(60, 1, 1)).toEqual({ r: 255, g: 255, b: 0 });
    expect(hsvToRgb(-60, 1, 1)).toEqual({ r: 255, g: 0, b: 255 });
  });

  it('round-trips rgb → hsv → rgb', () => {
    for (let r = 0; r < 256; r += 15) {
      for (let g = 0; g < 256; g += 17) {
        for (let b = 0; b < 256; b += 19) {
          const c = rgbToHsv(r, g, b);
          expect(c.h).toBeGreaterThanOrEqual(0);
          expect(c.h).toBeLessThan(360);
          expect(hsvToRgb(c.h, c.s, c.v)).toEqual({ r, g, b });
        }
      }
    }
  });
});

describe('classification', () => {
  const th = DEFAULT_CLASS_THRESHOLDS;
  it('classifies the mat colours', () => {
    expect(classifyRgb(0, 0, 0, th)).toBe(PIXEL_CLASS.offtrack);
    expect(classifyRgb(30, 30, 35, th)).toBe(PIXEL_CLASS.offtrack);
    expect(classifyRgb(255, 255, 255, th)).toBe(PIXEL_CLASS.border);
    expect(classifyRgb(225, 230, 240, th)).toBe(PIXEL_CLASS.border);
    expect(classifyRgb(40, 90, 230, th)).toBe(PIXEL_CLASS.lane); // blue
    expect(classifyRgb(140, 60, 220, th)).toBe(PIXEL_CLASS.lane); // purple
    expect(classifyRgb(235, 70, 175, th)).toBe(PIXEL_CLASS.lane); // pink
    expect(classifyRgb(255, 140, 0, th)).toBe(PIXEL_CLASS.other); // orange
    expect(classifyRgb(220, 30, 30, th)).toBe(PIXEL_CLASS.other); // red cone
    expect(classifyRgb(40, 220, 60, th)).toBe(PIXEL_CLASS.other); // green
  });

  it('handles lane hue ranges that wrap past 360', () => {
    const wrap = { ...th, laneHueMin: 300, laneHueMax: 380 };
    expect(classifyRgb(255, 0, 10, wrap)).toBe(PIXEL_CLASS.lane); // ≈358°
    expect(classifyRgb(255, 60, 0, wrap)).toBe(PIXEL_CLASS.lane); // ≈14°
    expect(classifyRgb(255, 200, 0, wrap)).toBe(PIXEL_CLASS.other); // ≈47°
  });

  it('classifies an image and counts transparent pixels as none', () => {
    const data = new Uint8ClampedArray([
      0, 0, 0, 255, 255, 255, 255, 255, 40, 90, 230, 255, 255, 140, 0, 255, 40, 90, 230, 255, 9, 9, 9, 0,
    ]);
    const res = classifyImage({ width: 3, height: 2, data }, th);
    expect(Array.from(res.classes)).toEqual([0, 1, 2, 3, 2, 255]);
    expect(res.counts).toEqual([1, 1, 2, 1, 1]);
    expect(res.percentages).toEqual({ offtrack: 20, border: 20, lane: 40, other: 20 });
    const vis = classesToImage(res.classes, 3, 2);
    expect(Array.from(vis.data.subarray(4, 8))).toEqual([255, 255, 255, 255]);
    expect(vis.data[5 * 4 + 3]).toBe(0);
  });

  it('finds the lane and border on the synthetic mat', () => {
    const res = classifyImage(drawSyntheticMat(1), th);
    expect(res.percentages.lane).toBeGreaterThan(20);
    expect(res.percentages.border).toBeGreaterThan(3);
    expect(res.percentages.offtrack).toBeGreaterThan(40);
    expect(res.percentages.other).toBeLessThan(1);
  });
});

describe('marker hues', () => {
  it('builds a hue histogram of saturated pixels', () => {
    const data = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255, 0, 255, 0, 255, 128, 128, 128, 255, 0, 0, 255, 0]);
    const h = hueHistogram({ width: 5, height: 1, data }, { bins: 12 });
    expect(h.total).toBe(4);
    expect(h.bins).toHaveLength(12);
    expect(h.bins[0]).toBe(0.25);
    expect(h.bins[4]).toBe(0.5);
    expect(h.bins.reduce((s, v) => s + v, 0)).toBe(0.75);
  });

  it('suggests hues the blue→pink mat does not contain', () => {
    const hist = hueHistogram(drawSyntheticMat(1));
    const sug = suggestMarkerHues(hist, 3);
    expect(sug).toHaveLength(3);
    for (const s of sug) {
      expect(s.fraction).toBe(0);
      expect(s.hue).toBeGreaterThan(30); // yellowish ... greenish/cyan
      expect(s.hue).toBeLessThan(170);
    }
    expect(sug[0].hue).toBeGreaterThan(60); // farthest from the mat colours first
    expect(sug[0].hue).toBeLessThan(130);
    for (let i = 0; i < sug.length; i++) {
      for (let j = i + 1; j < sug.length; j++) expect(hueDist(sug[i].hue, sug[j].hue)).toBeGreaterThanOrEqual(40);
    }
  });
});

describe('sampleMarker / matchesMarker', () => {
  it('samples a marker colour and matches it', () => {
    const img: ImageBuf = { width: 40, height: 40, data: new Uint8ClampedArray(40 * 40 * 4) };
    for (let i = 0; i < 40 * 40; i++) img.data.set([20, 20, 25, 255], i * 4);
    fillDisc(img, 20, 20, 7, [40, 230, 70]);
    const m = sampleMarker(img, 20, 20);
    const ref = rgbToHsv(40, 230, 70);
    expect(hueDist(m.h, ref.h)).toBeLessThan(1);
    expect(m.s).toBeCloseTo(ref.s, 6);
    expect(m.v).toBeCloseTo(ref.v, 6);
    expect(m.hTol).toBe(18);
    expect(m.sMin).toBeCloseTo(Math.max(0.25, ref.s / 2), 9);
    expect(m.vMin).toBeCloseTo(Math.max(0.35, ref.v * 0.6), 9);
    expect(matchesMarker(40, 230, 70, m)).toBe(true);
    expect(matchesMarker(60, 200, 120, m)).toBe(true); // a bit off, still green
    expect(matchesMarker(40, 90, 230, m)).toBe(false); // blue
    expect(matchesMarker(10, 50, 15, m)).toBe(false); // too dark
    expect(matchesMarker(200, 230, 205, m)).toBe(false); // washed out
    expect(() => sampleMarker(img, -50, -50)).toThrow();
  });

  it('matches hues across 0°', () => {
    const red = { h: 355, s: 1, v: 1, hTol: 18, sMin: 0.3, vMin: 0.3 };
    expect(matchesMarker(255, 40, 0, red)).toBe(true); // ≈9°
    expect(matchesMarker(255, 0, 60, red)).toBe(true); // ≈346°
    expect(matchesMarker(255, 120, 0, red)).toBe(false); // ≈28°
  });
});
