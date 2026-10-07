// The single Lab instance and the browser glue around it.

import { MockTransport } from '../adapters/ble/MockTransport';
import { WebBluetoothTransport } from '../adapters/ble/WebBluetoothTransport';
import { environment, onVisibility, vibrate, WakeLockKeeper } from '../adapters/device/device';
import { DexieLogStore, IndexedDbSink, requestPersistentStorage } from '../adapters/storage/DexieLogStore';
import { DevSync } from '../adapters/storage/devSync';
import { loadLastRobotId, loadSettings, saveLastRobotId, saveSettings } from '../adapters/storage/localSettings';
import { Lab } from '../core/lab';
import { makeSyntheticTrack } from '../core/sim/track';
import { SimWorld } from '../core/sim/world';
import type { PromptHandle, PromptRequest, PromptResponse, TestUi } from '../core/tests/types';
import type { Clock } from '../core/types';
import { useApp } from './appStore';

export const clock: Clock = { now: () => performance.now() };

let lab: Lab | null = null;
export const store = new DexieLogStore();
export const devSync = new DevSync();
let wakeLock: WakeLockKeeper | null = null;
let promptSeq = 0;

export function getLab(): Lab {
  if (!lab) throw new Error('Lab not initialised');
  return lab;
}

export const labUi: TestUi = {
  prompt(req: PromptRequest): PromptHandle {
    const id = ++promptSeq;
    let resolve!: (r: PromptResponse) => void;
    const result = new Promise<PromptResponse>((r) => (resolve = r));
    const taps: { button: string; t: number }[] = [];
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      useApp.getState().removePrompt(id);
    };
    useApp.getState().addPrompt({
      id,
      req,
      taps,
      resolve: (r) => {
        taps.push({ button: r.button, t: clock.now() });
        if (!req.live) {
          close();
          resolve(r);
        } else if (r.button === (req.buttons ?? ['Next'])[0] || r.button === 'Done' || r.button === 'Finish') {
          resolve(r);
        }
      },
    });
    void result.then(() => {
      if (!req.live) close();
    });
    return { result, taps, close };
  },
};

let simTrack: ReturnType<typeof makeSyntheticTrack> | null = null;
export function getSimTrack() {
  return (simTrack ??= makeSyntheticTrack({ cmPerPx: 0.5 }));
}

export async function initLab(): Promise<Lab> {
  if (lab) return lab;
  void requestPersistentStorage();
  void devSync.probe();
  const real = new WebBluetoothTransport();
  const settings = loadSettings();
  lab = await Lab.create({
    clock,
    wallClock: () => new Date(),
    store,
    sinks: [new IndexedDbSink(store), devSync],
    artifact: (sessionId, path, data) => void devSync.artifact(sessionId, path, data),
    env: environment(),
    realTransport: () => real,
    mockTransport: () => {
      const track = getSimTrack();
      const world = new SimWorld(clock.now(), { mask: track.mask, pose: track.start });
      world.shade = track.bridge;
      return new MockTransport(clock, {}, world);
    },
    settings,
    saveSettings,
    lastRobotId: loadLastRobotId(),
    saveLastRobotId,
    ui: labUi,
  });
  const l = lab;
  // Handy in chrome://inspect and for browser smoke tests.
  if (import.meta.env.DEV) (window as unknown as { __lab?: Lab }).__lab = l;
  real.setLog((k, fields) => l.logger.log(k, fields));
  l.logger.log('app', { event: 'start', detail: { build: __BUILD_ID__, buildTime: __BUILD_TIME__, mode: import.meta.env.MODE } });

  wakeLock = new WakeLockKeeper((event, detail) => l.logger.log('app', { event, detail }));
  l.link.onState((s, info) => {
    void wakeLock?.set(s === 'connected' || s === 'connecting');
    if (s === 'disconnected' && info?.reason && info.reason !== 'user') vibrate([200, 100, 200]);
    useApp.getState().bump();
  });
  l.subscribe(() => useApp.getState().bump());
  l.runner.subscribe(() => useApp.getState().bump());
  devSync.subscribe(() => useApp.getState().bump());

  onVisibility((hidden) => {
    if (hidden) l.onHidden();
    else l.onVisible();
  });
  void import('./camera/controller').then(({ cameraController }) => cameraController.init()).catch((err: unknown) => {
    l.logger.log('app', { event: 'error', detail: `loading calibration failed: ${String(err)}` });
  });
  window.addEventListener('error', (e) => l.logger.log('app', { event: 'error', detail: String(e.message) }));
  window.addEventListener('unhandledrejection', (e) => l.logger.log('app', { event: 'error', detail: String(e.reason) }));
  return l;
}
