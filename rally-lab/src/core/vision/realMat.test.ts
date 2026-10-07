// The class thresholds and colour scan against the real race mat: a 1 cm/px
// top-down picture rectified from a phone photo taken at the venue.
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { classifyImage, DEFAULT_CLASS_THRESHOLDS, hueHistogram, PIXEL_CLASS, suggestMarkerHues } from './color';
import type { ImageBuf } from './rectify';

function loadMat(): ImageBuf {
  const rgb = gunzipSync(readFileSync(new URL('./fixtures/real-mat-300x250.rgb.gz', import.meta.url)));
  const w = 300;
  const h = 250;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = rgb[i * 3];
    data[i * 4 + 1] = rgb[i * 3 + 1];
    data[i * 4 + 2] = rgb[i * 3 + 2];
    data[i * 4 + 3] = 255;
  }
  return { width: w, height: h, data };
}

describe('real mat', () => {
  const mat = loadMat();
  const cls = classifyImage(mat, DEFAULT_CLASS_THRESHOLDS);
  const at = (x: number, y: number) => cls.classes[y * mat.width + x];

  it('splits the mat into background, border and lane', () => {
    const p = cls.percentages;
    expect(p.offtrack).toBeGreaterThan(55);
    expect(p.offtrack).toBeLessThan(72);
    expect(p.lane).toBeGreaterThan(20);
    expect(p.lane).toBeLessThan(30);
    expect(p.border).toBeGreaterThan(5);
    expect(p.border).toBeLessThan(14);
    expect(p.other).toBeLessThan(5);
  });

  it('classifies known spots', () => {
    // lane: left straight (blue), bottom straight (pastel purple), right side (pink), serpentine leg
    for (const [x, y] of [[18, 120], [150, 187], [276, 120], [165, 100], [100, 59]]) expect(at(x, y)).toBe(PIXEL_CLASS.lane);
    // background: infield, below the bottom straight, top right outside the loop
    for (const [x, y] of [[40, 120], [250, 235], [290, 20]]) expect(at(x, y)).toBe(PIXEL_CLASS.offtrack);
  });

  it('suggests marker hues the mat does not use', () => {
    const hues = suggestMarkerHues(hueHistogram(mat), 3).map((s) => s.hue);
    expect(hues.length).toBeGreaterThan(0);
    for (const h of hues) expect(h > 70 && h < 215).toBe(true);
  });
});
