// Phone camera via getUserMedia. Frames are drawn scaled to procWidth and read
// back as RGBA; requestVideoFrameCallback gives per-frame capture timestamps.

import type { CameraOpts, Frame } from '../../core/types';
import type { CameraInfo, CameraSource, LockResult } from './types';

type VideoFrameMeta = { captureTime?: number; expectedDisplayTime?: number; presentedFrames?: number; width?: number; height?: number };
type RvfcVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: (now: number, meta: VideoFrameMeta) => void) => number;
  cancelVideoFrameCallback?: (h: number) => void;
};

/** Ask for permission once so labels show up, then list the cameras. */
export async function listCameras(): Promise<CameraInfo[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  let devices = await navigator.mediaDevices.enumerateDevices();
  if (devices.filter((d) => d.kind === 'videoinput').every((d) => !d.label)) {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      s.getTracks().forEach((t) => t.stop());
      devices = await navigator.mediaDevices.enumerateDevices();
    } catch {
      // permission denied: labels stay empty
    }
  }
  return devices.filter((d) => d.kind === 'videoinput').map((d, i) => ({ deviceId: d.deviceId, label: d.label || `camera ${i + 1}` }));
}

/** T4.1: capabilities and settings of every camera (each opened briefly). */
export async function dumpAllCapabilities(running?: UserMediaFrameSource): Promise<unknown[]> {
  const out: unknown[] = [];
  for (const cam of await listCameras()) {
    if (running && running.deviceId === cam.deviceId) {
      out.push({ ...cam, capabilities: running.capabilities(), settings: running.settings(), note: 'running' });
      continue;
    }
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: cam.deviceId } }, audio: false });
      const t = s.getVideoTracks()[0];
      out.push({ ...cam, capabilities: t.getCapabilities?.() ?? null, settings: t.getSettings() });
      s.getTracks().forEach((x) => x.stop());
    } catch (err) {
      out.push({ ...cam, error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) });
    }
  }
  return out;
}

export class UserMediaFrameSource implements CameraSource {
  readonly kind = 'camera' as const;
  readonly preview: HTMLVideoElement;
  private stream?: MediaStream;
  private track?: MediaStreamTrack;
  private canvas = document.createElement('canvas');
  private g = this.canvas.getContext('2d', { willReadFrequently: true })!;
  private cbs = new Set<(f: Frame) => void>();
  private handle = 0;
  private raf = 0;
  private running = false;
  private procWidth = 640;
  private lastPresented = -1;
  dropped = 0;
  label = 'camera';
  deviceId?: string;
  /** When set, frames go to this callback as ImageBitmaps (for a worker) instead of pixels. */
  bitmapSink: ((bmp: ImageBitmap, t: number) => boolean) | null = null;

  constructor() {
    const v = document.createElement('video');
    v.playsInline = true;
    v.muted = true;
    v.autoplay = true;
    this.preview = v;
  }

  get size() {
    return { w: this.preview.videoWidth, h: this.preview.videoHeight };
  }

  async start(opts: CameraOpts): Promise<void> {
    this.stop();
    this.procWidth = opts.procWidth;
    const video: MediaTrackConstraints = {
      width: { ideal: opts.width },
      height: { ideal: opts.height },
      frameRate: { ideal: opts.fps },
      ...(opts.deviceId ? { deviceId: { exact: opts.deviceId } } : { facingMode: { ideal: 'environment' } }),
    };
    this.stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
    this.track = this.stream.getVideoTracks()[0];
    this.deviceId = this.track.getSettings().deviceId ?? opts.deviceId;
    this.label = this.track.label || 'camera';
    this.preview.srcObject = this.stream;
    await this.preview.play();
    this.running = true;
    this.schedule();
  }

  private schedule(): void {
    const v = this.preview as RvfcVideo;
    if (!this.running) return;
    if (v.requestVideoFrameCallback) this.handle = v.requestVideoFrameCallback((now, meta) => this.onVideoFrame(now, meta));
    else this.raf = requestAnimationFrame((now) => this.onVideoFrame(now, {}));
  }

  private onVideoFrame(now: number, meta: VideoFrameMeta): void {
    if (!this.running) return;
    if (meta.presentedFrames !== undefined) {
      if (this.lastPresented >= 0 && meta.presentedFrames > this.lastPresented + 1) this.dropped += meta.presentedFrames - this.lastPresented - 1;
      this.lastPresented = meta.presentedFrames;
    }
    const vw = this.preview.videoWidth;
    const vh = this.preview.videoHeight;
    const t = meta.captureTime && meta.captureTime > 0 && meta.captureTime <= now + 1 ? meta.captureTime : now;
    if (vw > 0 && vh > 0 && this.bitmapSink) {
      const w = Math.min(this.procWidth, vw);
      const h = Math.round((vh * w) / vw);
      const sink = this.bitmapSink;
      void createImageBitmap(this.preview, { resizeWidth: w, resizeHeight: h, resizeQuality: 'low' }).then((bmp) => {
        if (!sink(bmp, t)) {
          bmp.close();
          this.dropped++;
        }
      }).catch(() => {
        this.dropped++;
      });
    } else if (vw > 0 && vh > 0 && this.cbs.size > 0) {
      const w = Math.min(this.procWidth, vw);
      const h = Math.round((vh * w) / vw);
      if (this.canvas.width !== w || this.canvas.height !== h) {
        this.canvas.width = w;
        this.canvas.height = h;
      }
      const g0 = performance.now();
      this.g.drawImage(this.preview, 0, 0, w, h);
      const data = this.g.getImageData(0, 0, w, h).data;
      const grabMs = performance.now() - g0;
      const frame: Frame = { width: w, height: h, data, tCaptureMs: t, grabMs };
      for (const cb of this.cbs) cb(frame);
    }
    this.schedule();
  }

  onFrame(cb: (f: Frame) => void): () => void {
    this.cbs.add(cb);
    return () => this.cbs.delete(cb);
  }

  stop(): void {
    this.running = false;
    const v = this.preview as RvfcVideo;
    if (this.handle && v.cancelVideoFrameCallback) v.cancelVideoFrameCallback(this.handle);
    if (this.raf) cancelAnimationFrame(this.raf);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = undefined;
    this.track = undefined;
    this.preview.srcObject = null;
  }

  async captureStill() {
    const w = this.preview.videoWidth;
    const h = this.preview.videoHeight;
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d', { willReadFrequently: true })!;
    g.drawImage(this.preview, 0, 0);
    const d = g.getImageData(0, 0, w, h);
    const blob = await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('jpeg failed'))), 'image/jpeg', 0.92));
    return { img: { width: w, height: h, data: d.data }, jpeg: new Uint8Array(await blob.arrayBuffer()) };
  }

  capabilities(): Record<string, unknown> | null {
    return (this.track?.getCapabilities?.() as Record<string, unknown> | undefined) ?? null;
  }

  settings(): Record<string, unknown> | null {
    return (this.track?.getSettings() as Record<string, unknown> | undefined) ?? null;
  }

  async setZoom(z: number): Promise<void> {
    await this.track?.applyConstraints({ advanced: [{ zoom: z } as MediaTrackConstraintSet] });
  }

  /** Lock exposure, white balance and focus where supported, so LED colours stay stable. */
  async lockExposure(): Promise<LockResult> {
    const applied: Record<string, unknown> = {};
    const failed: Record<string, string> = {};
    const t = this.track;
    if (!t) return { applied, failed: { track: 'camera not running' }, settings: null };
    const caps = (t.getCapabilities?.() ?? {}) as Record<string, unknown>;
    const cur = t.getSettings() as Record<string, unknown>;
    const tryApply = async (name: string, c: Record<string, unknown>) => {
      try {
        await t.applyConstraints({ advanced: [c as MediaTrackConstraintSet] });
        applied[name] = c;
      } catch (err) {
        failed[name] = err instanceof Error ? err.message : String(err);
      }
    };
    const modes = (k: string) => (Array.isArray(caps[k]) ? (caps[k] as string[]) : []);
    if (modes('exposureMode').includes('manual')) {
      const c: Record<string, unknown> = { exposureMode: 'manual' };
      if (cur.exposureTime !== undefined) c.exposureTime = cur.exposureTime;
      await tryApply('exposure', c);
    } else if (caps.exposureCompensation !== undefined) {
      await tryApply('exposure', { exposureCompensation: cur.exposureCompensation ?? 0 });
    } else failed.exposure = 'not supported';
    if (modes('whiteBalanceMode').includes('manual')) {
      const c: Record<string, unknown> = { whiteBalanceMode: 'manual' };
      if (cur.colorTemperature !== undefined) c.colorTemperature = cur.colorTemperature;
      await tryApply('whiteBalance', c);
    } else failed.whiteBalance = 'not supported';
    if (modes('focusMode').includes('manual')) {
      const c: Record<string, unknown> = { focusMode: 'manual' };
      if (cur.focusDistance !== undefined) c.focusDistance = cur.focusDistance;
      await tryApply('focus', c);
    } else if (modes('focusMode').includes('single-shot')) await tryApply('focus', { focusMode: 'single-shot' });
    else failed.focus = 'not supported';
    return { applied, failed, settings: this.settings() };
  }
}
