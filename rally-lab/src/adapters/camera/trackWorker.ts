/// <reference lib="webworker" />
// Tracking off the main thread: the page transfers each video frame as an
// ImageBitmap; this worker reads its pixels and runs the portable Tracker.

import type { MarkerProbe } from '../../core/tests/camera';
import { probePatch } from '../../core/vision/pipeline';
import { Tracker, type TrackerConfig } from '../../core/vision/tracker';

export type ToWorker =
  | { type: 'config'; version: number; cfg: TrackerConfig }
  | { type: 'frame'; bitmap: ImageBitmap; t: number; probe: boolean };

export type FromWorker = {
  type: 'result';
  t: number;
  width: number;
  height: number;
  grabMs: number;
  procMs: number;
  version: number;
  res: ReturnType<Tracker['process']> | null;
  probe?: MarkerProbe;
};

const ctx = self as unknown as DedicatedWorkerGlobalScope;
let tracker: Tracker | null = null;
let version = -1;
let canvas: OffscreenCanvas | null = null;
let g: OffscreenCanvasRenderingContext2D | null = null;
let lastA: { cx: number; cy: number } | undefined;

ctx.onmessage = (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  if (m.type === 'config') {
    tracker = new Tracker(m.cfg);
    version = m.version;
    lastA = undefined;
    return;
  }
  const bmp = m.bitmap;
  const t0 = performance.now();
  if (!canvas || canvas.width !== bmp.width || canvas.height !== bmp.height) {
    canvas = new OffscreenCanvas(bmp.width, bmp.height);
    g = canvas.getContext('2d', { willReadFrequently: true });
  }
  g!.drawImage(bmp, 0, 0);
  bmp.close();
  const frame = { width: canvas.width, height: canvas.height, data: g!.getImageData(0, 0, canvas.width, canvas.height).data, tCaptureMs: m.t };
  const t1 = performance.now();
  const res = tracker ? tracker.process(frame) : null;
  const t2 = performance.now();
  let probe: MarkerProbe | undefined;
  if (m.probe && res) {
    if (res.a) lastA = res.a;
    probe = probePatch(frame, res.a ?? lastA, m.t);
  }
  const out: FromWorker = { type: 'result', t: m.t, width: frame.width, height: frame.height, grabMs: t1 - t0, procMs: t2 - t1, version, res, probe };
  ctx.postMessage(out);
};
