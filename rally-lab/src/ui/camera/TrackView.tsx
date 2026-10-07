import { useMemo, useRef } from 'react';
import { drawImageBuf } from '../../adapters/camera/imageIo';
import { errorMessage } from '../../core/util/async';
import { matOutline } from '../../core/vision/calibration';
import { useApp } from '../appStore';
import { fmt, useAnimationFrame, useLabVersion, useTicker } from '../hooks';
import { getLab } from '../lab';
import { cameraController as cc } from './controller';
import { dot, LiveView, polyline, speedColor } from './views';

function MiniMap() {
  const ref = useRef<HTMLCanvasElement>(null);
  const cal = cc.calibration;
  const map = cc.map;
  const base = useMemo(() => {
    if (!map) return null;
    const c = document.createElement('canvas');
    drawImageBuf(c, map);
    return c;
  }, [map]);
  useAnimationFrame(() => {
    const c = ref.current;
    const pipe = cc.pipeline;
    if (!c || !cal) return;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth;
    const h = (w * cal.matHeightCm) / cal.matWidthCm;
    c.style.height = `${h}px`;
    if (c.width !== Math.round(w * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    const g = c.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const s = w / cal.matWidthCm; // px per cm
    if (base) g.drawImage(base, 0, 0, w, h);
    else {
      g.fillStyle = '#111';
      g.fillRect(0, 0, w, h);
    }
    for (const l of cal.landmarks) dot(g, l.xCm * s, l.yCm * s, 3, '#58a6ff');
    if (!pipe) return;
    const trail = pipe.poses.last(600);
    for (let i = 1; i < trail.length; i++) {
      const a = trail[i - 1];
      const b = trail[i];
      if (b.tFrame - a.tFrame > 500) continue;
      g.strokeStyle = speedColor(b.speedCmS);
      g.lineWidth = 2.5;
      g.beginPath();
      g.moveTo(a.fx * s, a.fy * s);
      g.lineTo(b.fx * s, b.fy * s);
      g.stroke();
    }
    const r = pipe.lastResult;
    if (r?.filtered) {
      const f = r.filtered;
      dot(g, f.x * s, f.y * s, 5, '#ffffff');
      const th = (f.headingDeg * Math.PI) / 180;
      g.strokeStyle = '#fff';
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(f.x * s, f.y * s);
      g.lineTo((f.x + Math.cos(th) * 12) * s, (f.y + Math.sin(th) * 12) * s);
      g.stroke();
    }
    if (r?.predicted) dot(g, r.predicted.x * s, r.predicted.y * s, 4, '#d29922');
  }, !!cal);
  if (!cal) return null;
  return <canvas ref={ref} style={{ width: '100%', display: 'block', borderRadius: 10, marginTop: 8 }} />;
}

export function TrackView() {
  useLabVersion();
  useTicker(250);
  const lab = getLab();
  const toast = useApp((s) => s.showToast);
  const pipe = cc.pipeline;
  const cal = cc.calibration;
  const st = pipe?.stats;
  const last = pipe?.latest();
  const lr = pipe?.lastResult;
  const fresh = last && performance.now() - last.tFrame < 500;

  const outline = cal && cc.lastFrame
    ? matOutline(cal, 12).map((p) => ({ x: (p.x * cc.lastFrame!.width) / cal.imageWidth, y: (p.y * cc.lastFrame!.width) / cal.imageWidth }))
    : null;

  return (
    <div>
      <div className="row" style={{ marginBottom: 8 }}>
        {cc.tracking ? (
          <button className="btn btn-big" onClick={() => cc.stopTracking()}>Stop tracking</button>
        ) : (
          <button className="btn btn-primary btn-big" disabled={!cc.running} onClick={() => { try { cc.startTracking(); } catch (err) { toast(errorMessage(err), 'error'); } }}>Start tracking</button>
        )}
      </div>
      {!cal && <p className="warn-text">No calibration yet.</p>}
      {!lab.settings.markerA.hsv && <p className="warn-text">Marker A is not calibrated (Markers tab).</p>}
      <LiveView
        draw={(g, s) => {
          if (outline) polyline(g, outline, s, '#3fb95088', true, 1.5);
          if (!cc.tracking || !lr) return;
          if (lr.a) {
            g.strokeStyle = '#ff00ff';
            g.lineWidth = 2;
            g.beginPath();
            g.arc(lr.a.cx * s, lr.a.cy * s, Math.max(6, Math.sqrt(lr.a.area) * s), 0, Math.PI * 2);
            g.stroke();
          }
          if (lr.b) {
            g.strokeStyle = '#00ffff';
            g.lineWidth = 2;
            g.beginPath();
            g.arc(lr.b.cx * s, lr.b.cy * s, Math.max(6, Math.sqrt(lr.b.area) * s), 0, Math.PI * 2);
            g.stroke();
          }
        }}
      />
      <div className="tiles" style={{ marginTop: 8 }}>
        <div className="tile">
          <div className="tile-label">Pose</div>
          <div className="mono" style={{ fontSize: 15 }}>
            {fresh && last ? `${fmt(last.fx, 1)}, ${fmt(last.fy, 1)} cm` : 'not detected'}
          </div>
          <div className="tile-sub">{fresh && last ? `${fmt(last.fHeadingDeg, 0)}° · ${fmt(last.speedCmS, 0)} cm/s · conf ${fmt(last.conf, 2)}` : ''}</div>
        </div>
        <div className="tile">
          <div className="tile-label">Frames</div>
          <div className="mono" style={{ fontSize: 15 }}>{fmt(st?.fps, 0)} fps · {fmt(st?.procMs, 1)} ms</div>
          <div className="tile-sub">p95 {fmt(st?.procP95, 1)} ms · detect {fmt((st?.detectRate ?? 0) * 100, 0)} % · drop {st?.dropped ?? 0}</div>
        </div>
      </div>
      <MiniMap />
      <p className="hint">Trail coloured by speed (blue slow → red fast); white = filtered pose with heading, orange = predicted {lab.settings.trackingLatencyMs} ms ahead.</p>
    </div>
  );
}
