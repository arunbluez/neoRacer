import { useMemo, useRef, useState } from 'react';
import { drawImageBuf } from '../../adapters/camera/imageIo';
import { errorMessage } from '../../core/util/async';
import { buildCalibration, matOutline, type TrackCalibration } from '../../core/vision/calibration';
import type { Pt } from '../../core/vision/linalg';
import { useApp } from '../appStore';
import { useLabVersion } from '../hooks';
import { getLab } from '../lab';
import { cameraController as cc } from './controller';
import { dot, polyline, StillView } from './views';

const CORNER_NAMES = ['TL', 'TR', 'BR', 'BL'];

export function CalibrateView() {
  useLabVersion();
  const lab = getLab();
  const toast = useApp((s) => s.showToast);
  const [corners, setCorners] = useState<Pt[]>(() => cc.calibration?.corners ?? []);
  const [extras, setExtras] = useState<{ img: Pt; mat: Pt }[]>(() => cc.calibration?.extraPoints ?? []);
  const [mode, setMode] = useState<'corners' | 'extra'>('corners');
  const [matW, setMatW] = useState(lab.settings.matWidthCm);
  const [matH, setMatH] = useState(lab.settings.matHeightCm);
  const [drag, setDrag] = useState<{ i: number; kind: 'corner' | 'extra' } | null>(null);
  const [loupe, setLoupe] = useState<Pt | null>(null);
  const [pendingExtra, setPendingExtra] = useState<Pt | null>(null);
  const [ex, setEx] = useState({ x: '', y: '' });
  const [saving, setSaving] = useState(false);
  const loupeRef = useRef<HTMLCanvasElement>(null);
  const still = cc.still;

  const solved: TrackCalibration | null = useMemo(() => {
    if (!still || corners.length !== 4) return null;
    try {
      return buildCalibration({
        id: `cal-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`,
        createdAt: new Date().toISOString(),
        imageWidth: still.img.width, imageHeight: still.img.height, corners, extraPoints: extras,
        matWidthCm: matW, matHeightCm: matH,
        cameraId: cc.source?.deviceId, cameraLabel: cc.source?.label, cameraSettings: cc.source?.settings() ?? undefined,
      });
    } catch {
      return null;
    }
  }, [still, corners, extras, matW, matH]);

  // The still drawn once, so the loupe can copy from it cheaply.
  const stillCanvas = useMemo(() => {
    if (!still) return null;
    const c = document.createElement('canvas');
    drawImageBuf(c, still.img);
    return c;
  }, [still]);

  const drawLoupe = (p: Pt) => {
    const c = loupeRef.current;
    if (!c || !stillCanvas) return;
    const S = 120;
    const zoom = 4;
    const r = S / zoom / 2;
    c.width = S;
    c.height = S;
    const g = c.getContext('2d')!;
    g.imageSmoothingEnabled = false;
    g.fillStyle = '#000';
    g.fillRect(0, 0, S, S);
    g.drawImage(stillCanvas, p.x - r, p.y - r, 2 * r, 2 * r, 0, 0, S, S);
    g.strokeStyle = '#f85149';
    g.beginPath();
    g.moveTo(S / 2, 0); g.lineTo(S / 2, S); g.moveTo(0, S / 2); g.lineTo(S, S / 2);
    g.stroke();
  };

  const near = (p: Pt, list: Pt[], tol: number) => list.findIndex((q) => Math.hypot(q.x - p.x, q.y - p.y) < tol);

  if (!still) {
    return (
      <div className="card">
        <p>Mount the phone, frame the whole mat, then capture a still to calibrate on.</p>
        <button className="btn btn-primary btn-big btn-block" disabled={!cc.running} onClick={() => void cc.captureStill().catch((e) => toast(errorMessage(e), 'error'))}>
          Capture still
        </button>
        {!cc.running && <p className="warn-text">Start the camera in Setup first.</p>}
      </div>
    );
  }

  const tol = still.img.width / 25;
  return (
    <div>
      <div className="row" style={{ marginBottom: 8 }}>
        <button className={`chip ${mode === 'corners' ? 'chip-on' : ''}`} onClick={() => setMode('corners')}>Corners {corners.length}/4</button>
        <button className={`chip ${mode === 'extra' ? 'chip-on' : ''}`} onClick={() => setMode('extra')}>Extra points {extras.length}/8</button>
        <span className="spacer" />
        <button className="btn btn-small" disabled={!cc.running} onClick={() => void cc.captureStill()}>New still</button>
      </div>
      <p className="hint" style={{ marginTop: 0 }}>
        {mode === 'corners'
          ? corners.length < 4 ? `Tap the ${CORNER_NAMES[corners.length]} mat corner (start/finish at the top left). Drag to adjust.` : 'Drag corners to adjust.'
          : 'Tap a point whose mat position you measured, then enter it in cm (from the top-left corner).'}
      </p>
      <div style={{ position: 'relative' }}>
        <StillView
          img={still.img}
          redrawKey={`${corners.length}-${extras.length}-${matW}-${matH}`}
          draw={(g, s) => {
            if (solved) polyline(g, matOutline(solved, 16), s, '#3fb950', true, 2);
            else if (corners.length > 1) polyline(g, corners, s, '#d29922', corners.length === 4, 2);
            corners.forEach((c, i) => dot(g, c.x * s, c.y * s, 7, '#f85149', CORNER_NAMES[i]));
            extras.forEach((e) => dot(g, e.img.x * s, e.img.y * s, 5, '#58a6ff', `${e.mat.x},${e.mat.y}`));
            if (pendingExtra) dot(g, pendingExtra.x * s, pendingExtra.y * s, 6, '#d2a8ff');
          }}
          onDown={(x, y) => {
            const p = { x, y };
            const ci = near(p, corners, tol);
            if (ci >= 0) {
              setDrag({ i: ci, kind: 'corner' });
            } else if (mode === 'corners' && corners.length < 4) {
              setCorners([...corners, p]);
              setDrag({ i: corners.length, kind: 'corner' });
            } else if (mode === 'extra') {
              const ei = near(p, extras.map((e) => e.img), tol);
              if (ei >= 0) setDrag({ i: ei, kind: 'extra' });
              else if (extras.length < 8) setPendingExtra(p);
            }
            setLoupe(p);
            drawLoupe(p);
          }}
          onMove={(x, y) => {
            if (!drag) return;
            const p = { x: Math.max(0, Math.min(still.img.width, x)), y: Math.max(0, Math.min(still.img.height, y)) };
            if (drag.kind === 'corner') setCorners(corners.map((c, i) => (i === drag.i ? p : c)));
            else setExtras(extras.map((e, i) => (i === drag.i ? { ...e, img: p } : e)));
            setLoupe(p);
            drawLoupe(p);
          }}
          onUp={() => {
            setDrag(null);
            setLoupe(null);
          }}
        />
        <canvas ref={loupeRef} className="loupe" style={{ display: loupe ? 'block' : 'none', top: 8, right: 8 }} />
      </div>

      {pendingExtra && (
        <div className="card" style={{ marginTop: 8 }}>
          <div className="grid2">
            <label className="field"><span>x (cm)</span><input inputMode="decimal" value={ex.x} onChange={(e) => setEx({ ...ex, x: e.target.value })} /></label>
            <label className="field"><span>y (cm)</span><input inputMode="decimal" value={ex.y} onChange={(e) => setEx({ ...ex, y: e.target.value })} /></label>
          </div>
          <div className="row">
            <button className="btn btn-primary" disabled={!Number.isFinite(parseFloat(ex.x)) || !Number.isFinite(parseFloat(ex.y))} onClick={() => {
              setExtras([...extras, { img: pendingExtra, mat: { x: parseFloat(ex.x), y: parseFloat(ex.y) } }]);
              setPendingExtra(null);
              setEx({ x: '', y: '' });
            }}>Add point</button>
            <button className="btn" onClick={() => setPendingExtra(null)}>Cancel</button>
          </div>
        </div>
      )}

      <div className="card" style={{ marginTop: 8 }}>
        <div className="grid2">
          <label className="field"><span>Mat width (cm, tape)</span><input inputMode="decimal" value={matW} onChange={(e) => setMatW(Number(e.target.value) || 0)} /></label>
          <label className="field"><span>Mat height (cm, tape)</span><input inputMode="decimal" value={matH} onChange={(e) => setMatH(Number(e.target.value) || 0)} /></label>
        </div>
        {solved ? (
          <p>
            Solved: reprojection rms <b>{solved.reprojErrorCm.rms.toFixed(2)} cm</b>, max {solved.reprojErrorCm.max.toFixed(2)} cm
            {extras.length === 0 ? ' (exact with 4 corners — add extra points or run T4.2 to check)' : ''}. The green outline must sit on the mat edges.
          </p>
        ) : <p className="muted">Tap all four corners to solve.</p>}
        <div className="row">
          <button
            className="btn btn-primary btn-big"
            disabled={!solved || saving}
            onClick={async () => {
              if (!solved) return;
              setSaving(true);
              try {
                await lab.setSettings({ matWidthCm: matW, matHeightCm: matH });
                const saved = await cc.saveCalibration(solved);
                toast(`Calibration ${saved.id} saved: lane ${saved.classPercentages?.lane.toFixed(0)} % of the mat`);
              } catch (err) {
                toast(errorMessage(err), 'error');
              } finally {
                setSaving(false);
              }
            }}
          >
            {saving ? 'Saving…' : 'Save calibration'}
          </button>
          <button className="btn btn-big" onClick={() => { setCorners([]); setExtras([]); }}>Reset</button>
        </div>
        {cc.calibration && <p className="hint">Active: {cc.calibration.id} · rms {cc.calibration.reprojErrorCm.rms.toFixed(2)} cm</p>}
      </div>
    </div>
  );
}
