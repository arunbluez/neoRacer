import { useState } from 'react';
import { lightCommand } from '../../core/tests/cameraTests';
import type { MarkerHsv, MarkerSource, MarkerSpec } from '../../core/settings';
import { matchesMarker, sampleMarker } from '../../core/vision/color';
import { useApp } from '../appStore';
import { useLabVersion } from '../hooks';
import { getLab } from '../lab';
import { cameraController as cc } from './controller';
import { LiveView } from './views';

const SOURCES: MarkerSource[] = ['headlights', 'headlightLeft', 'headlightRight', 'underglow'];
const hex = (c: { r: number; g: number; b: number }) => `#${[c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
const fromHex = (h: string) => ({ r: parseInt(h.slice(1, 3), 16), g: parseInt(h.slice(3, 5), 16), b: parseInt(h.slice(5, 7), 16) });

function MarkerEditor({ which }: { which: 'markerA' | 'markerB' }) {
  const lab = getLab();
  const spec = lab.settings[which];
  const set = (patch: Partial<MarkerSpec>) => void lab.setSettings({ [which]: { ...spec, ...patch } });
  const setHsv = (patch: Partial<MarkerHsv>) => spec.hsv && set({ hsv: { ...spec.hsv, ...patch } });
  return (
    <div className="card">
      <div className="row-between">
        <h3 style={{ margin: 0 }}>{which === 'markerA' ? 'Marker A (front)' : 'Marker B (centre)'}</h3>
        <span className="mono muted" style={{ fontSize: 12 }}>{lightCommand(spec.source, spec.rgb)}</span>
      </div>
      <div className="grid2" style={{ marginTop: 8 }}>
        <label className="field">
          <span>Light</span>
          <select value={spec.source} onChange={(e) => set({ source: e.target.value as MarkerSource, hsv: undefined })}>
            {SOURCES.map((s) => <option key={s}>{s}</option>)}
          </select>
        </label>
        <label className="field">
          <span>Colour</span>
          <input type="color" value={hex(spec.rgb)} onChange={(e) => set({ rgb: fromHex(e.target.value), hsv: undefined })} />
        </label>
      </div>
      {spec.hsv ? (
        <div>
          <p className="mono" style={{ fontSize: 12 }}>h {spec.hsv.h.toFixed(0)}° s {spec.hsv.s.toFixed(2)} v {spec.hsv.v.toFixed(2)}</p>
          <label className="field"><span>Hue tolerance {spec.hsv.hTol.toFixed(0)}°</span><input type="range" min={3} max={60} step={1} value={spec.hsv.hTol} onChange={(e) => setHsv({ hTol: Number(e.target.value) })} /></label>
          <label className="field"><span>Min saturation {spec.hsv.sMin.toFixed(2)}</span><input type="range" min={0} max={1} step={0.01} value={spec.hsv.sMin} onChange={(e) => setHsv({ sMin: Number(e.target.value) })} /></label>
          <label className="field"><span>Min brightness {spec.hsv.vMin.toFixed(2)}</span><input type="range" min={0} max={1} step={0.01} value={spec.hsv.vMin} onChange={(e) => setHsv({ vMin: Number(e.target.value) })} /></label>
        </div>
      ) : <p className="warn-text">Not calibrated: light it up, then tap it in the live view.</p>}
    </div>
  );
}

export function MarkersView() {
  useLabVersion();
  const lab = getLab();
  const toast = useApp((s) => s.showToast);
  const [target, setTarget] = useState<'markerA' | 'markerB'>('markerA');
  const [mask, setMask] = useState(true);
  const a = lab.settings.markerA;
  const b = lab.settings.markerB;

  const lightUp = async () => {
    await lab.link.send('HO');
    await lab.link.send(lightCommand(a.source, a.rgb));
    await lab.link.send(lightCommand(b.source, b.rgb));
  };

  return (
    <div>
      <div className="row" style={{ marginBottom: 8 }}>
        <button className="btn btn-primary" disabled={!lab.link.connected} onClick={() => void lightUp()}>Light up A and B</button>
        <button className={`chip ${target === 'markerA' ? 'chip-on' : ''}`} onClick={() => setTarget('markerA')}>Tap sets A</button>
        <button className={`chip ${target === 'markerB' ? 'chip-on' : ''}`} onClick={() => setTarget('markerB')}>Tap sets B</button>
        <button className={`chip ${mask ? 'chip-on' : ''}`} onClick={() => setMask(!mask)}>Mask</button>
      </div>
      {cc.workerActive && <p className="warn-text">Tracking runs in a worker: stop tracking to sample marker colours here.</p>}
      <LiveView
        onTap={(x, y) => {
          const f = cc.lastFrame;
          if (!f) return;
          try {
            const m = sampleMarker(f, x, y, 5);
            void lab.setSettings({ [target]: { ...lab.settings[target], hsv: m } });
            lab.logger.log('app', { event: 'marker', detail: { which: target, x, y, hsv: m } });
            toast(`${target === 'markerA' ? 'A' : 'B'}: hue ${m.h.toFixed(0)}°, s ${m.s.toFixed(2)}, v ${m.v.toFixed(2)}`);
            if (target === 'markerA') setTarget('markerB');
          } catch (err) {
            toast(String(err), 'error');
          }
        }}
        draw={(g, s) => {
          const f = cc.lastFrame;
          if (!f || !mask) return;
          const ma = lab.settings.markerA.hsv;
          const mb = lab.settings.markerB.hsv;
          const d = f.data;
          const step = 2;
          for (let y = 0; y < f.height; y += step) {
            for (let x = 0; x < f.width; x += step) {
              const o = (y * f.width + x) * 4;
              const isA = ma && matchesMarker(d[o], d[o + 1], d[o + 2], ma);
              const isB = !isA && mb && matchesMarker(d[o], d[o + 1], d[o + 2], mb);
              if (isA || isB) {
                g.fillStyle = isA ? '#ff00ff' : '#00ffff';
                g.fillRect(x * s, y * s, step * s, step * s);
              }
            }
          }
        }}
      />
      <p className="hint">Magenta = marker A pixels, cyan = marker B. Watch for false positives: red cones, white borders, the yellow battery labels.</p>
      <MarkerEditor which="markerA" />
      <MarkerEditor which="markerB" />
    </div>
  );
}
