import { useEffect, useState } from 'react';
import { listCameras } from '../../adapters/camera/UserMediaFrameSource';
import type { CameraInfo } from '../../adapters/camera/types';
import { errorMessage } from '../../core/util/async';
import { matOutline } from '../../core/vision/calibration';
import { useApp } from '../appStore';
import { useLabVersion } from '../hooks';
import { getLab } from '../lab';
import { cameraController as cc } from './controller';
import { LiveView, polyline } from './views';

export function SetupView() {
  useLabVersion();
  const lab = getLab();
  const toast = useApp((s) => s.showToast);
  const [cams, setCams] = useState<CameraInfo[]>([]);
  const [pick, setPick] = useState<string>(lab.settings.mockRobot ? 'sim' : lab.settings.cameraId ?? '');
  const [busy, setBusy] = useState(false);
  const [zoom, setZoom] = useState<number | null>(null);
  const [check, setCheck] = useState(true);

  useEffect(() => {
    void listCameras().then(setCams).catch(() => setCams([]));
  }, []);

  const caps = cc.source?.capabilities() as { zoom?: { min: number; max: number; step?: number } } | null | undefined;
  const settings = cc.source?.settings();

  const start = async () => {
    setBusy(true);
    try {
      await cc.start(pick);
      const z = cc.source?.capabilities() as { zoom?: { min: number } } | null;
      if (z?.zoom) {
        // widest view by default
        await cc.source!.setZoom(z.zoom.min);
        setZoom(z.zoom.min);
      }
      void listCameras().then(setCams);
    } catch (err) {
      toast(`Camera: ${errorMessage(err)}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const outline = cc.calibration && cc.frameSize
    ? matOutline(cc.calibration, 16).map((p) => ({ x: (p.x * cc.frameSize!.width) / cc.calibration!.imageWidth, y: (p.y * cc.frameSize!.width) / cc.calibration!.imageWidth }))
    : null;

  return (
    <div>
      <div className="card">
        <label className="field">
          <span>Camera</span>
          <select value={pick} onChange={(e) => setPick(e.target.value)} disabled={cc.running}>
            <option value="">Default back camera</option>
            {cams.map((c) => <option key={c.deviceId} value={c.deviceId}>{c.label}</option>)}
            <option value="sim">Simulated camera (mock robot)</option>
          </select>
        </label>
        <div className="row">
          {cc.running ? (
            <button className="btn btn-big" onClick={() => cc.stop()}>Stop camera</button>
          ) : (
            <button className="btn btn-primary btn-big" disabled={busy} onClick={() => void start()}>{busy ? 'Starting…' : 'Start camera'}</button>
          )}
          <button className="btn btn-big" disabled={!cc.running} onClick={() => void cc.lockExposure().then((r) => r && toast(`Locked: ${Object.keys(r.applied).join(', ') || 'nothing'}${Object.keys(r.failed).length ? ` · not: ${Object.keys(r.failed).join(', ')}` : ''}`))}>
            Lock exposure
          </button>
        </div>
        {cc.error && <p className="bad-text">{cc.error}</p>}
        {pick === 'sim' && !lab.settings.mockRobot && <p className="warn-text">The simulated camera shows the mock robot: turn on the mock in Data → Settings.</p>}
      </div>

      {cc.running && (
        <>
          <LiveView draw={(g, s) => check && outline && polyline(g, outline, s, '#3fb950', true, 2)} />
          <div className="row" style={{ margin: '8px 0' }}>
            <label className="row"><input type="checkbox" checked={check} onChange={(e) => setCheck(e.target.checked)} /> <span>Check: draw the calibrated mat outline</span></label>
          </div>
          {caps?.zoom && (
            <label className="field">
              <span>Zoom {zoom ?? ''}</span>
              <input
                type="range" min={caps.zoom.min} max={caps.zoom.max} step={caps.zoom.step ?? 0.1} value={zoom ?? caps.zoom.min}
                onChange={(e) => { const z = Number(e.target.value); setZoom(z); void cc.source?.setZoom(z); }}
              />
            </label>
          )}
          <details className="card">
            <summary>Granted settings</summary>
            <pre className="mono" style={{ fontSize: 11, whiteSpace: 'pre-wrap' }}>{JSON.stringify({ settings, lock: cc.lock }, null, 1)}</pre>
          </details>
        </>
      )}
      <p className="hint">Requests {lab.settings.cameraWidth}×{lab.settings.cameraHeight} at {lab.settings.cameraFps} fps; tracking runs on frames scaled to {lab.settings.procWidth} px. Frame once, then lock exposure so LED colours stay stable.</p>
    </div>
  );
}
