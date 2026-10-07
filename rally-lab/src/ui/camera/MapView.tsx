import { useMemo, useState } from 'react';
import { encodeImage } from '../../adapters/camera/imageIo';
import { errorMessage } from '../../core/util/async';
import type { Landmark } from '../../core/vision/calibration';
import { classesToImage, classifyImage, DEFAULT_CLASS_THRESHOLDS, hsvToRgb, hueHistogram, suggestMarkerHues, type ClassThresholds } from '../../core/vision/color';
import { useApp } from '../appStore';
import { useLabVersion } from '../hooks';
import { getLab, store } from '../lab';
import { cameraController as cc } from './controller';
import { dot, StillView } from './views';

const LANDMARKS = ['start/finish', 'bridge entry', 'bridge exit', 'hairpin 1', 'hairpin 2', 'hairpin 3', 'hairpin 4', 'cone 1', 'cone 2', 'cone 3', 'cone 4', 'ramp 1', 'ramp 2'];

const SLIDERS: { key: keyof ClassThresholds; label: string; min: number; max: number; step: number }[] = [
  { key: 'darkV', label: 'offtrack: V below', min: 0, max: 1, step: 0.01 },
  { key: 'borderSMax', label: 'border: S below', min: 0, max: 1, step: 0.01 },
  { key: 'borderVMin', label: 'border: V above', min: 0, max: 1, step: 0.01 },
  { key: 'laneSMin', label: 'lane: S above', min: 0, max: 1, step: 0.01 },
  { key: 'laneVMin', label: 'lane: V above', min: 0, max: 1, step: 0.01 },
  { key: 'laneHueMin', label: 'lane: hue from', min: 0, max: 360, step: 1 },
  { key: 'laneHueMax', label: 'lane: hue to', min: 0, max: 360, step: 1 },
];

export function MapView() {
  useLabVersion();
  const lab = getLab();
  const toast = useApp((s) => s.showToast);
  const cal = cc.calibration;
  const map = cc.map;
  const [th, setTh] = useState<ClassThresholds>(cal?.classThresholds ?? DEFAULT_CLASS_THRESHOLDS);
  const [showMask, setShowMask] = useState(true);
  const [landmarks, setLandmarks] = useState<Landmark[]>(cal?.landmarks ?? []);
  const [lmName, setLmName] = useState(LANDMARKS[0]);
  const [tapMode, setTapMode] = useState(false);
  const [busy, setBusy] = useState(false);

  const cls = useMemo(() => (map ? classifyImage(map, th) : null), [map, th]);
  const view = useMemo(() => (map && cls && showMask ? classesToImage(cls.classes, map.width, map.height) : map), [map, cls, showMask]);
  const hist = useMemo(() => (map ? hueHistogram(map) : null), [map]);
  const suggestions = useMemo(() => (hist ? suggestMarkerHues(hist, 4) : []), [hist]);

  if (!cal || !map || !view) return <div className="card muted">Calibrate the track first (Calibrate tab).</div>;
  const mm = cal.mmPerPx ?? lab.settings.mmPerPx;
  const pxPerCm = 10 / mm;

  const save = async () => {
    setBusy(true);
    try {
      const maskPng = await encodeImage(classesToImage(cls!.classes, map.width, map.height), 'image/png');
      const now = new Date().toISOString();
      await store.putImage({ id: `${cal.id}-mask`, calibrationId: cal.id, sessionId: lab.header.id, name: `${cal.id}-mask.png`, mime: 'image/png', bytes: maskPng, createdAt: now });
      const saved = { ...cal, classThresholds: th, classPercentages: cls!.percentages, landmarks, maskImageId: `${cal.id}-mask` };
      await store.putCalibration(saved);
      lab.artifact(`calibration/${cal.id}.json`, saved);
      lab.artifact(`calibration/${cal.id}-mask.png`, maskPng);
      await cc.activate(saved);
      toast('Map, thresholds and landmarks saved');
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  const maxBin = hist ? Math.max(...hist.bins, 1e-9) : 1;
  return (
    <div>
      <div className="row" style={{ marginBottom: 8 }}>
        <button className={`chip ${showMask ? 'chip-on' : ''}`} onClick={() => setShowMask(!showMask)}>Class mask</button>
        <button className={`chip ${tapMode ? 'chip-on' : ''}`} onClick={() => setTapMode(!tapMode)}>Tap landmarks</button>
        <span className="muted" style={{ fontSize: 12 }}>{map.width}×{map.height} px at {mm} mm/px</span>
      </div>
      <StillView
        img={view}
        redrawKey={landmarks.length}
        draw={(g, s) => {
          for (const l of landmarks) dot(g, l.xCm * pxPerCm * s, l.yCm * pxPerCm * s, 6, '#58a6ff', l.name);
        }}
        onDown={(x, y) => {
          if (!tapMode) return;
          const l = { name: lmName, xCm: Math.round((x / pxPerCm) * 10) / 10, yCm: Math.round((y / pxPerCm) * 10) / 10 };
          setLandmarks([...landmarks.filter((q) => q.name !== lmName), l]);
          const i = LANDMARKS.indexOf(lmName);
          if (i >= 0 && i < LANDMARKS.length - 1) setLmName(LANDMARKS[i + 1]);
        }}
      />
      {cls && (
        <p className="mono" style={{ fontSize: 13 }}>
          offtrack {cls.percentages.offtrack.toFixed(1)} % · border {cls.percentages.border.toFixed(1)} % · lane {cls.percentages.lane.toFixed(1)} % · other {cls.percentages.other.toFixed(1)} %
        </p>
      )}
      {tapMode && (
        <div className="card">
          <label className="field">
            <span>Next landmark</span>
            <select value={lmName} onChange={(e) => setLmName(e.target.value)}>{LANDMARKS.map((n) => <option key={n}>{n}</option>)}</select>
          </label>
          {landmarks.map((l) => (
            <div key={l.name} className="row-between">
              <span>{l.name} <span className="muted">({l.xCm}, {l.yCm}) cm</span></span>
              <button className="btn btn-small" onClick={() => setLandmarks(landmarks.filter((q) => q.name !== l.name))}>×</button>
            </div>
          ))}
        </div>
      )}
      <div className="card">
        <h3 style={{ marginTop: 0 }}>HSV thresholds</h3>
        {SLIDERS.map((sl) => (
          <label key={sl.key} className="field">
            <span>{sl.label}: {th[sl.key]}</span>
            <input type="range" min={sl.min} max={sl.max} step={sl.step} value={th[sl.key]} onChange={(e) => setTh({ ...th, [sl.key]: Number(e.target.value) })} />
          </label>
        ))}
        <button className="btn btn-small" onClick={() => setTh(DEFAULT_CLASS_THRESHOLDS)}>Defaults</button>
      </div>
      {hist && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Colour scan</h3>
          <div style={{ display: 'flex', alignItems: 'flex-end', height: 60, gap: 1 }}>
            {hist.bins.map((b, i) => {
              const hue = (i + 0.5) * (360 / hist.bins.length);
              const c = hsvToRgb(hue, 1, 1);
              return <div key={i} title={`${hue.toFixed(0)}°: ${(b * 100).toFixed(2)} %`} style={{ flex: 1, height: `${Math.max(2, (Math.sqrt(b / maxBin)) * 100)}%`, background: `rgb(${c.r},${c.g},${c.b})` }} />;
            })}
          </div>
          <p className="muted" style={{ fontSize: 13 }}>Hues that barely occur on the mat make good marker colours (tap to use for marker B):</p>
          <div className="row">
            {suggestions.map((s) => {
              const c = hsvToRgb(s.hue, 1, 1);
              return (
                <button key={s.hue} className="chip" style={{ background: `rgb(${c.r},${c.g},${c.b})`, color: '#000' }} onClick={() => void lab.setSettings({ markerB: { ...lab.settings.markerB, rgb: c } }).then(() => toast(`Marker B colour ${c.r},${c.g},${c.b}`))}>
                  {s.hue.toFixed(0)}° · {(s.fraction * 100).toFixed(2)} %
                </button>
              );
            })}
          </div>
        </div>
      )}
      <button className="btn btn-primary btn-big btn-block" disabled={busy} onClick={() => void save()}>Save map settings and landmarks</button>
    </div>
  );
}
