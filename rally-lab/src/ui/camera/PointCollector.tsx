import { useState } from 'react';
import { useLabVersion } from '../hooks';
import { cameraController as cc } from './controller';
import { dot, LiveView } from './views';

/** T4.2: tap points with known mat coordinates in the live view. */
export function PointCollector() {
  useLabVersion();
  const req = cc.pointRequest;
  const [pts, setPts] = useState<{ img: { x: number; y: number }; mat: { x: number; y: number } }[]>([]);
  const [pending, setPending] = useState<{ x: number; y: number } | null>(null);
  const [xy, setXy] = useState({ x: '', y: '' });
  if (!req) return null;
  const cal = cc.calibration;
  const f = cc.frameSize;
  // live-view taps are in processed-frame pixels; the calibration is in full-size pixels
  const k = cal && f ? cal.imageWidth / f.width : 1;
  const landmarks = cal?.landmarks ?? [];
  return (
    <div className="card" style={{ borderColor: 'var(--accent)' }}>
      <h3 style={{ marginTop: 0 }}>T4.2: tap {req.count} known points ({pts.length} done)</h3>
      <LiveView
        onTap={(x, y) => setPending({ x, y })}
        draw={(g, s) => {
          for (const p of pts) dot(g, (p.img.x / k) * s, (p.img.y / k) * s, 5, '#3fb950', `${p.mat.x},${p.mat.y}`);
          if (pending) dot(g, pending.x * s, pending.y * s, 6, '#d2a8ff');
        }}
      />
      {pending && (
        <div style={{ marginTop: 8 }}>
          {landmarks.length > 0 && (
            <div className="row" style={{ marginBottom: 6 }}>
              {landmarks.map((l) => <button key={l.name} className="chip" onClick={() => setXy({ x: String(l.xCm), y: String(l.yCm) })}>{l.name}</button>)}
            </div>
          )}
          <div className="grid2">
            <label className="field"><span>x (cm)</span><input inputMode="decimal" value={xy.x} onChange={(e) => setXy({ ...xy, x: e.target.value })} /></label>
            <label className="field"><span>y (cm)</span><input inputMode="decimal" value={xy.y} onChange={(e) => setXy({ ...xy, y: e.target.value })} /></label>
          </div>
          <button
            className="btn btn-primary btn-block"
            disabled={!Number.isFinite(parseFloat(xy.x)) || !Number.isFinite(parseFloat(xy.y))}
            onClick={() => {
              const next = [...pts, { img: { x: pending.x * k, y: pending.y * k }, mat: { x: parseFloat(xy.x), y: parseFloat(xy.y) } }];
              setPts(next);
              setPending(null);
              setXy({ x: '', y: '' });
              if (next.length >= req.count) {
                req.resolve(next);
                setPts([]);
              }
            }}
          >
            Add point
          </button>
        </div>
      )}
      <button className="btn btn-block" style={{ marginTop: 8 }} onClick={() => req.reject(new Error('point collection cancelled'))}>Cancel</button>
    </div>
  );
}
