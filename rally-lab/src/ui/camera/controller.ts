// Keeps the camera, the active calibration and the tracking pipeline alive
// across tabs (tests on the Tests tab use tracking), and implements the
// CameraControl the camera tests call.

import { MockTransport } from '../../adapters/ble/MockTransport';
import { decodeImage, encodeImage } from '../../adapters/camera/imageIo';
import { SimFrameSource } from '../../adapters/camera/SimFrameSource';
import type { CameraSource, LockResult } from '../../adapters/camera/types';
import type { FromWorker, ToWorker } from '../../adapters/camera/trackWorker';
import { dumpAllCapabilities, UserMediaFrameSource } from '../../adapters/camera/UserMediaFrameSource';
import type { CameraControl, MarkerProbe } from '../../core/tests/camera';
import type { Frame } from '../../core/types';
import { errorMessage } from '../../core/util/async';
import type { TrackCalibration } from '../../core/vision/calibration';
import type { TrackMask } from '../../core/sim/track';
import { classesToImage, classifyImage, DEFAULT_CLASS_THRESHOLDS, PIXEL_CLASS, type ClassThresholds } from '../../core/vision/color';
import { TrackingPipeline } from '../../core/vision/pipeline';
import { rectify, type ImageBuf } from '../../core/vision/rectify';
import { useApp } from '../appStore';
import { parkPreview } from './views';
import { clock, getLab, getSimTrack, mockMask, store } from '../lab';

const ACTIVE_KEY = 'rally-lab.activeCalibration';

export type PointRequest = { count: number; resolve: (pts: { img: { x: number; y: number }; mat: { x: number; y: number } }[]) => void; reject: (e: Error) => void };

class CameraController implements CameraControl {
  source?: CameraSource;
  pipeline?: TrackingPipeline;
  calibration?: TrackCalibration;
  /** The last still captured for calibration. */
  still?: { img: ImageBuf; jpeg: Uint8Array; at: string };
  map?: ImageBuf;
  lastFrame?: Frame;
  lock?: LockResult;
  error?: string;
  pointRequest?: PointRequest;
  private frameTimes: number[] = [];
  private worker: Worker | null = null;
  private workerBusy = false;
  private workerCfg = '';
  private off?: () => void;
  private fpsTimer: ReturnType<typeof setInterval> | null = null;

  get running(): boolean {
    return !!this.source;
  }

  get calibrationId(): string | undefined {
    return this.calibration?.id;
  }

  private bump() {
    useApp.getState().bump();
  }

  private ensurePipeline(): TrackingPipeline {
    return (this.pipeline ??= new TrackingPipeline(getLab().logger, clock));
  }

  async init(): Promise<void> {
    let id: string | null = null;
    try {
      id = localStorage.getItem(ACTIVE_KEY);
    } catch {
      // ignore
    }
    if (!id) return;
    const cal = await store.getCalibration(id);
    if (cal) await this.activate(cal);
  }

  async activate(cal: TrackCalibration | undefined): Promise<void> {
    this.calibration = cal;
    this.map = undefined;
    try {
      if (cal) localStorage.setItem(ACTIVE_KEY, cal.id);
      else localStorage.removeItem(ACTIVE_KEY);
    } catch {
      // ignore
    }
    if (cal?.stillImageId) {
      const img = await store.getImage(cal.stillImageId);
      if (img) {
        const buf = await decodeImage(img.bytes, img.mime);
        this.still = { img: buf, jpeg: img.bytes, at: img.createdAt };
        this.map = rectify(buf, cal.Hinv, cal.matWidthCm, cal.matHeightCm, cal.mmPerPx ?? getLab().settings.mmPerPx);
      }
    }
    getLab().setCalibration(cal);
    this.applyMaskToMock();
    this.bump();
  }

  /** The calibrated track as line-sensor surfaces for the mock robot. */
  trackMask(): TrackMask | undefined {
    const cal = this.calibration;
    if (!cal || !this.map) return undefined;
    const { classes } = classifyImage(this.map, cal.classThresholds ?? DEFAULT_CLASS_THRESHOLDS);
    for (let i = 0; i < classes.length; i++) if (classes[i] === PIXEL_CLASS.none) classes[i] = PIXEL_CLASS.offtrack;
    return { width: this.map.width, height: this.map.height, cmPerPx: (cal.mmPerPx ?? getLab().settings.mmPerPx) / 10, classes };
  }

  private applyMaskToMock(): void {
    const mock = getLab().mockTransport;
    const mask = this.trackMask();
    if (mock instanceof MockTransport && mask) {
      mock.world.mask = mask;
      getLab().logger.log('app', { event: 'mock', detail: `line sensors read the mask of ${this.calibration?.id}` });
    }
  }

  async start(deviceId: string | 'sim'): Promise<void> {
    this.stop();
    const lab = getLab();
    const s = lab.settings;
    let src: CameraSource;
    if (deviceId === 'sim') {
      const t = getSimTrack();
      src = new SimFrameSource(clock, () => (lab.mockTransport instanceof MockTransport ? lab.mockTransport.world : undefined), {
        image: t.image, matWidthCm: t.matWidthCm, matHeightCm: t.matHeightCm,
      });
    } else src = new UserMediaFrameSource();
    try {
      await src.start({ deviceId: deviceId === 'sim' ? undefined : deviceId || undefined, width: s.cameraWidth, height: s.cameraHeight, fps: s.cameraFps, procWidth: s.procWidth });
    } catch (err) {
      this.error = errorMessage(err);
      lab.logger.log('app', { event: 'camera', detail: `start failed: ${this.error}` });
      this.bump();
      throw err;
    }
    this.error = undefined;
    this.source = src;
    parkPreview(src.preview);
    const pipe = this.ensurePipeline();
    this.off = src.onFrame((f) => {
      this.lastFrame = f;
      this.frameTimes.push(f.tCaptureMs);
      pipe.dropped = src.dropped;
      pipe.process(f);
    });
    lab.camera = this;
    lab.logger.log('app', { event: 'camera', detail: { started: src.label, deviceId: src.deviceId, settings: src.settings() } });
    if (deviceId !== 'sim' && deviceId) void lab.setSettings({ cameraId: deviceId });
    this.fpsTimer = setInterval(() => {
      const now = clock.now();
      this.frameTimes = this.frameTimes.filter((t) => now - t < 2000);
      useApp.getState().setCamFps(this.frameTimes.length / 2);
    }, 500);
    this.bump();
  }

  stop(): void {
    this.stopTracking();
    this.off?.();
    this.off = undefined;
    this.source?.stop();
    this.source?.preview.remove();
    if (this.source) getLab().logger.log('app', { event: 'camera', detail: 'stopped' });
    this.source = undefined;
    if (this.fpsTimer !== null) clearInterval(this.fpsTimer);
    this.fpsTimer = null;
    useApp.getState().setCamFps(undefined);
    const lab = getLab();
    if (lab.camera === this) lab.camera = undefined;
    this.bump();
  }

  async lockExposure(): Promise<LockResult | undefined> {
    if (!this.source) return undefined;
    this.lock = await this.source.lockExposure();
    getLab().logger.log('app', { event: 'camera.lock', detail: this.lock });
    this.bump();
    return this.lock;
  }

  /** Start tracking with the active calibration and the calibrated markers. */
  /** Size of the frames being processed, from either path. */
  get frameSize(): { width: number; height: number } | undefined {
    return this.worker ? this.pipeline?.frameMeta : this.lastFrame;
  }

  get workerActive(): boolean {
    return this.worker !== null;
  }

  private startWorker(src: UserMediaFrameSource, pipe: TrackingPipeline): void {
    this.stopWorker();
    const worker = new Worker(new URL('../../adapters/camera/trackWorker.ts', import.meta.url), { type: 'module' });
    this.worker = worker;
    this.workerBusy = false;
    this.workerCfg = '';
    worker.onmessage = (e: MessageEvent<FromWorker>) => {
      const m = e.data;
      this.workerBusy = false;
      this.frameTimes.push(m.t);
      if (m.res && m.version === pipe.configVersion) {
        pipe.ingest({ width: m.width, height: m.height, tCaptureMs: m.t, grabMs: m.grabMs }, m.res, m.procMs, m.probe);
      }
    };
    worker.onerror = (e) => {
      getLab().logger.log('app', { event: 'error', detail: `tracking worker: ${e.message}` });
      this.stopWorker();
    };
    src.bitmapSink = (bmp, t) => {
      if (this.workerBusy || !pipe.config) return false;
      pipe.calibrationMismatch = !pipe.aspectMatches(bmp.width, bmp.height);
      if (pipe.calibrationMismatch) return false;
      const key = `${pipe.configVersion}:${bmp.width}x${bmp.height}`;
      if (key !== this.workerCfg) {
        const msg: ToWorker = { type: 'config', version: pipe.configVersion, cfg: pipe.trackerConfig(bmp.width, bmp.height) };
        worker.postMessage(msg);
        this.workerCfg = key;
      }
      this.workerBusy = true;
      const msg: ToWorker = { type: 'frame', bitmap: bmp, t, probe: pipe.wantsProbe };
      worker.postMessage(msg, [bmp]);
      return true;
    };
    getLab().logger.log('app', { event: 'tracking', detail: 'worker on' });
  }

  private stopWorker(): void {
    if (this.source instanceof UserMediaFrameSource) this.source.bitmapSink = null;
    this.worker?.terminate();
    this.worker = null;
  }

  startTracking(): void {
    const lab = getLab();
    const cal = this.calibration;
    const a = lab.settings.markerA.hsv;
    if (!cal) throw new Error('Calibrate the track first.');
    if (!a) throw new Error('Calibrate marker A first (Markers).');
    const pipe = this.ensurePipeline();
    pipe.configure({
      calibration: cal,
      markerA: a,
      markerB: lab.settings.markerB.hsv,
      minAreaPx: lab.settings.minBlobAreaPx,
      predictMs: lab.settings.trackingLatencyMs,
    });
    pipe.start();
    if (lab.settings.trackInWorker && this.source instanceof UserMediaFrameSource) this.startWorker(this.source, pipe);
    else this.stopWorker();
    lab.pose = pipe;
    lab.logger.log('app', { event: 'tracking', detail: { calibrationId: cal.id, markerA: a, markerB: lab.settings.markerB.hsv ?? null } });
    this.bump();
  }

  stopTracking(): void {
    const lab = getLab();
    this.stopWorker();
    if (this.pipeline?.tracking) lab.logger.log('app', { event: 'tracking', detail: 'stopped' });
    this.pipeline?.stop();
    if (lab.pose === this.pipeline) lab.pose = undefined;
    this.bump();
  }

  get tracking(): boolean {
    return !!this.pipeline?.tracking;
  }

  async captureStill(): Promise<void> {
    if (!this.source) throw new Error('Start the camera first.');
    const s = await this.source.captureStill();
    this.still = { ...s, at: new Date().toISOString() };
    this.bump();
  }

  /** Save a calibration with its still, the rectified map and the track mask. */
  async saveCalibration(cal: TrackCalibration, thresholds: ClassThresholds = cal.classThresholds ?? DEFAULT_CLASS_THRESHOLDS): Promise<TrackCalibration> {
    const lab = getLab();
    const now = new Date().toISOString();
    if (!this.still) throw new Error('No still image.');
    const mmPerPx = cal.mmPerPx ?? lab.settings.mmPerPx;
    const stillId = cal.stillImageId ?? `${cal.id}-still`;
    await store.putImage({ id: stillId, calibrationId: cal.id, sessionId: lab.header.id, name: `${cal.id}-still.jpg`, mime: 'image/jpeg', bytes: this.still.jpeg, createdAt: now });
    const map = rectify(this.still.img, cal.Hinv, cal.matWidthCm, cal.matHeightCm, mmPerPx);
    this.map = map;
    const cls = classifyImage(map, thresholds);
    const mapPng = await encodeImage(map, 'image/png');
    const maskPng = await encodeImage(classesToImage(cls.classes, map.width, map.height), 'image/png');
    await store.putImage({ id: `${cal.id}-map`, calibrationId: cal.id, sessionId: lab.header.id, name: `${cal.id}-map.png`, mime: 'image/png', bytes: mapPng, createdAt: now });
    await store.putImage({ id: `${cal.id}-mask`, calibrationId: cal.id, sessionId: lab.header.id, name: `${cal.id}-mask.png`, mime: 'image/png', bytes: maskPng, createdAt: now });
    const saved: TrackCalibration = {
      ...cal, mmPerPx, stillImageId: stillId, mapImageId: `${cal.id}-map`, maskImageId: `${cal.id}-mask`,
      classThresholds: thresholds, classPercentages: cls.percentages,
    };
    await store.putCalibration(saved);
    lab.artifact(`calibration/${cal.id}.json`, saved);
    lab.artifact(`calibration/${cal.id}-still.jpg`, this.still.jpeg);
    lab.artifact(`calibration/${cal.id}-map.png`, mapPng);
    lab.artifact(`calibration/${cal.id}-mask.png`, maskPng);
    await this.activate(saved);
    if (this.tracking) this.startTracking();
    return saved;
  }

  // ---- CameraControl (used by T4 tests)

  async dumpCapabilities(): Promise<unknown> {
    const src = this.source instanceof UserMediaFrameSource ? this.source : undefined;
    const cams = await dumpAllCapabilities(src);
    if (this.source?.kind === 'sim') cams.push({ label: 'Simulated camera', capabilities: this.source.capabilities(), settings: this.source.settings() });
    return cams;
  }

  collectPoints(count: number): Promise<{ img: { x: number; y: number }; mat: { x: number; y: number } }[]> {
    return new Promise((resolve, reject) => {
      this.pointRequest = {
        count,
        resolve: (pts) => {
          this.pointRequest = undefined;
          this.bump();
          resolve(pts);
        },
        reject: (e) => {
          this.pointRequest = undefined;
          this.bump();
          reject(e);
        },
      };
      useApp.getState().setTab('camera');
      this.bump();
    });
  }

  probeMarker(cb: (p: MarkerProbe) => void): () => void {
    return this.ensurePipeline().probeMarker(cb);
  }
}

export const cameraController = new CameraController();
mockMask.provide = () => cameraController.trackMask();
if (import.meta.env.DEV) (window as unknown as { __cc?: CameraController }).__cc = cameraController;
