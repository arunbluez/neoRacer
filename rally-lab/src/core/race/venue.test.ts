// The measured route against the real mat: a 1 cm/px top-down picture of the
// mat, rectified from a phone photo taken at the venue (7 Oct 2026) with the
// mat finder's corners. The route has to run on the painted lane.
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { paintedRoute } from '../sim/track';
import { classifyImage, DEFAULT_CLASS_THRESHOLDS, PIXEL_CLASS } from '../vision/color';
import type { ImageBuf } from '../vision/rectify';
import { buildPlan, RALLY_ROUTE } from './route';

function loadVenue(): ImageBuf {
  const rgb = gunzipSync(readFileSync(new URL('../vision/fixtures/venue-mat-200x300.rgb.gz', import.meta.url)));
  const w = 200, h = 300;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = rgb[i * 3];
    data[i * 4 + 1] = rgb[i * 3 + 1];
    data[i * 4 + 2] = rgb[i * 3 + 2];
    data[i * 4 + 3] = 255;
  }
  return { width: w, height: h, data };
}

describe('the measured route on the venue mat', () => {
  const img = loadVenue();
  const cls = classifyImage(img, DEFAULT_CLASS_THRESHOLDS).classes;
  const at = (x: number, y: number) => cls[Math.floor(y) * 200 + Math.floor(x)];
  const lane = buildPlan(paintedRoute(RALLY_ROUTE), 'arc').outline;

  it('runs on the lane all the way round', () => {
    let onLane = 0, n = 0;
    for (let i = 0; i < lane.length; i += 2) {
      n++;
      if (at(lane[i].x, lane[i].y) === PIXEL_CLASS.lane) onLane++;
    }
    // cones, robots and the bridge sit on the lane in places
    expect(onLane / n).toBeGreaterThan(0.9);
  });

  it('has black mat just outside the lane', () => {
    let dark = 0, n = 0;
    for (let i = 0; i < lane.length; i += 4) {
      const p = lane[i];
      const th = (p.headingDeg * Math.PI) / 180;
      for (const side of [-1, 1]) {
        const x = p.x - Math.sin(th) * 14 * side, y = p.y + Math.cos(th) * 14 * side;
        if (x < 0 || y < 0 || x >= 200 || y >= 300) continue;
        n++;
        if (at(x, y) !== PIXEL_CLASS.lane) dark++;
      }
    }
    expect(dark / n).toBeGreaterThan(0.85);
  });
});
