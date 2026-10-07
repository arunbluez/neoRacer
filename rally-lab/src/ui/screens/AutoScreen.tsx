// Camera-assisted auto run: hold the phone so the track is in view, the app
// finds the track (by its lane) and our robot (by its blinking lights) in
// every frame, and the robot drives the route with the camera correcting it.
// Start slow, export the logs, and the route and tuning get corrected from them.

import { useEffect, useState } from 'react';
import { shareOrDownload } from '../../adapters/export/share';
import type { AutoSettings } from '../../core/race/autoRun';
import { errorMessage } from '../../core/util/async';
import { useApp } from '../appStore';
import { cameraController as cc } from '../camera/controller';
import { LiveView } from '../camera/views';
import { fmt, useLabVersion, useTicker } from '../hooks';
import { getLab } from '../lab';
import { autoController as ac } from '../race/autoController';
import { TrackEditor } from '../race/TrackEditor';
import { drawLiveOverlay, MatMap } from '../race/views';
import { SIDES } from '../../core/vision/handheld';

const COLORS: { name: string; rgb: { r: number; g: number; b: number } }[] = [
  { name: 'green', rgb: { r: 0, g: 255, b: 0 } },
  { name: 'cyan', rgb: { r: 0, g: 255, b: 255 } },
  { name: 'yellow', rgb: { r: 255, g: 255, b: 0 } },
];

export function AutoScreen() {
  useLabVersion();
  useTicker(200);
  const lab = getLab();
  const toast = useApp((s) => s.showToast);
  const s = lab.settings.auto;
  const [busy, setBusy] = useState(false);
  const [showTrack, setShowTrack] = useState(false);
  const [showAdv, setShowAdv] = useState(false);
  const [full, setFull] = useState(false);
  const auto = lab.auto;
  const running = auto?.state === 'running';
  const last = ac.last;
  const set = (patch: Partial<AutoSettings>) => void lab.setSettings({ auto: { ...lab.settings.auto, ...patch } });

  useEffect(() => {
    ac.attach();
    return () => ac.detach();
  }, []);

  const startCamera = async () => {
    setBusy(true);
    try {
      await cc.start(lab.settings.mockRobot ? 'sim' : lab.settings.cameraId ?? '');
      const z = cc.source?.capabilities() as { zoom?: { min: number } } | null;
      if (z?.zoom) await cc.source!.setZoom(z.zoom.min); // widest view
      // Let auto exposure settle on the scene, then lock it so the lights keep their colour.
      setTimeout(() => void cc.lockExposure().catch(() => {}), 2500);
      ac.attach();
    } catch (err) {
      toast(`Camera: ${errorMessage(err)}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const go = async () => {
    try {
      await ac.run();
      const sum = ac.summary;
      if (sum) toast(sum.finished ? `Lap done in ${(sum.timeMs / 1000).toFixed(1)} s` : `Stopped: ${sum.reason}`, sum.finished ? 'info' : 'error');
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };

  const exportLogs = async () => {
    try {
      const { name, bytes } = await lab.exportZip();
      await shareOrDownload(name, bytes);
    } catch (err) {
      toast(`Export: ${errorMessage(err)}`, 'error');
    }
  };

  const enterFull = () => {
    setFull(true);
    // Best effort: real full screen and landscape (Android Chrome allows the lock only in full screen).
    void document.documentElement.requestFullscreen?.().then(() => {
      const o = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> };
      return o.lock?.('landscape');
    }).catch(() => {});
  };
  const exitFull = () => {
    setFull(false);
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
  };

  const findRobot = async () => {
    try {
      const r = await ac.findRobot();
      const st = ac.route.start;
      if (r) toast(`Found it: ${Math.round(Math.hypot(r.pos.x - st.x, r.pos.y - st.y))} cm from the start line`);
      else toast('No light blinked along: is the robot in the picture?', 'error');
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };

  const live = auto?.live();
  const plan = ac.plan();
  const matOk = !!last?.corners && last.matAgeMs < 500;
  const robotOk = !!last?.fix;
  const portrait = !!cc.source && cc.source.size.h > cc.source.size.w;
  const side = last?.side ?? null;
  const gateWhy = ac.gate?.why;
  const robotText = ac.blinking ? 'robot: blinking…' : robotOk
    ? `robot ✓ ${gateWhy === 'blink' ? '(found by blinking)' : gateWhy === 'start' ? '(at the start line)' : ''}`
    : `robot ✗ ${gateWhy === 'start' ? '(none at the start line)' : ''}`;
  const matText = matOk ? `track ✓ from ${side ? SIDES[side] ?? side : '?'} · fit ${fmt((last?.fit?.score ?? 0) * 100, 0)} %` : `track ✗ ${ac.tracker?.lastReject ?? ''}`;
  const zoom = (cc.source?.capabilities() as { zoom?: { min: number; max: number } } | null | undefined)?.zoom;

  if (full && cc.running) {
    const size = cc.frameSize ?? { width: 4, height: 3 };
    const aspect = size.width / size.height;
    return (
      <div className="runview">
        <div className="runview-cam" style={{ width: `min(100vw, ${(100 * aspect).toFixed(2)}vh)` }}>
          <LiveView draw={(g, scale) => drawLiveOverlay(g, scale, ac.last, plan, ac.route, auto, ac.gate)} />
        </div>
        <div className="runview-status">
          <span className="badge">{matText}</span>
          <span className="badge">{robotText}</span>
          <span className="badge">{s.speedCmS} cm/s · {s.style === 'spin' ? 'spins' : 'curves'}</span>
        </div>
        <button className="btn runview-close" onClick={exitFull} disabled={running} aria-label="Close full screen">✕ Close</button>
        <div className="runview-actions">
          {!running && <button className="btn runview-mid" onClick={() => void findRobot()} disabled={!lab.link.connected || ac.blinking}>{ac.blinking ? 'Blinking…' : 'Find my robot'}</button>}
          {!running && <button className="btn runview-mid" onClick={() => ac.redetect()}>Re-detect track</button>}
          {running ? (
            <button className="btn btn-danger runview-big" onClick={() => lab.stopAll('STOP (auto, full screen)')}>STOP</button>
          ) : (
            <button className="btn btn-ok runview-big" disabled={!lab.link.connected} onClick={() => void go()}>Start</button>
          )}
        </div>
        {live && (running || live.reason) && (
          <div className="runview-line">
            {running ? 'running' : live.reason} · {live.section} · {fmt(live.progress, 0)}/{fmt(live.lengthCm, 0)} cm · {fmt(live.t / 1000, 1)} s
            {live.step && live.step.kind === 'path' ? ` · off ${fmt(live.step.e, 1)} cm` : ''}
          </div>
        )}
      </div>
    );
  }

  return (
    <div>
      {!lab.link.connected && <div className="card warn-text">Robot not connected{lab.settings.mockRobot ? ' (mock robot is on: connect it on the Connect tab)' : ''}.</div>}

      <div className="row" style={{ gap: 6, marginBottom: 8, flexWrap: 'wrap' }}>
        <span className={`badge ${cc.running ? '' : 'badge-busy'}`}>camera {cc.running ? `${fmt(useApp.getState().camFps, 0)} fps` : 'off'}</span>
        <span className={`badge ${matOk ? '' : 'badge-busy'}`}>{matText}</span>
        <span className={`badge ${robotOk ? '' : 'badge-busy'}`}>{robotText}</span>
        {last && <span className="muted">{fmt(last.procMs, 0)} ms/frame</span>}
        {zoom && <span className="muted">zoom {zoom.min}–{zoom.max}{zoom.min < 1 ? ' (ultra-wide in use)' : ''}</span>}
      </div>

      {cc.running ? (
        <LiveView
          draw={(g, scale) => drawLiveOverlay(g, scale, ac.last, plan, ac.route, auto, ac.gate)}
          onTap={(x, y) => {
            if (ac.pickMarker) void ac.sampleAt(x, y).then(() => toast('Marker colour saved'));
          }}
        />
      ) : (
        <div className="card">
          <p style={{ marginTop: 0 }}>
            Hold the phone <b>in landscape</b> so the whole <b>track</b> (the coloured lane) is in the picture; the mat's
            black edges don't need to be. Best from a <b>long side</b> of the mat (the bridge side or the start side): the
            3 m length then runs across the picture, so you can stand much closer than behind an end. Hold it high and
            fairly still; it doesn't need to be perfectly steady.
          </p>
          <button className="btn btn-primary btn-big btn-block" disabled={busy} onClick={() => void startCamera()}>
            {busy ? 'Starting…' : lab.settings.mockRobot ? 'Start simulated camera' : 'Start camera'}
          </button>
        </div>
      )}
      {portrait && <div className="card warn-text">The camera is in portrait: turn the phone to landscape so the track fits.</div>}
      {ac.pickMarker && <div className="card">Tap the robot's lights on the picture.</div>}

      {cc.running && (
        <div className="row" style={{ gap: 6, margin: '8px 0', flexWrap: 'wrap' }}>
          <button className="btn btn-small btn-primary" onClick={enterFull}>Full screen</button>
          <button className="btn btn-small" onClick={() => void findRobot()} disabled={running || !lab.link.connected || ac.blinking}>{ac.blinking ? 'Blinking…' : 'Find my robot'}</button>
          <button className="btn btn-small" onClick={() => ac.redetect()} disabled={running}>Re-detect track</button>
          <button className="btn btn-small" onClick={() => ac.lightsOn()} disabled={!lab.link.connected}>Lights on</button>
          <button className="btn btn-small" onClick={() => cc.stop()} disabled={running}>Camera off</button>
        </div>
      )}
      {cc.running && (
        <p className="hint" style={{ marginTop: 0 }}>
          The coloured line is the route the robot will drive, drawn where the app found the track: it should sit on the
          lane all the way round (if not, <b>Re-detect track</b>). The circle is where it looks for your robot: the start
          line, or where <b>Find my robot</b> saw its lights blink (other robots' lights are ignored). Start also blinks
          first when needed.
        </p>
      )}

      <div className="card">
        <label className="field">
          <span>Speed {s.speedCmS} cm/s {s.speedCmS <= 24 ? '(slowest)' : ''}</span>
          <input type="range" min={18} max={60} step={1} value={s.speedCmS} disabled={running} onChange={(e) => set({ speedCmS: Number(e.target.value) })} />
          <small className="hint">The robot can't go slower than ~22 cm/s (its deadband). In curves it speeds up so the inner wheel keeps turning: ~26 cm/s in the corners, ~33 cm/s in the zigzag's hairpins.</small>
        </label>
        <div className="row" style={{ gap: 6, marginBottom: 8 }}>
          <span>Turns</span>
          <button className={`chip ${s.style === 'arc' ? 'chip-on' : ''}`} disabled={running} onClick={() => set({ style: 'arc' })}>Follow the curves</button>
          <button className={`chip ${s.style === 'spin' ? 'chip-on' : ''}`} disabled={running} onClick={() => set({ style: 'spin' })}>Spin on the spot</button>
        </div>
        <div className="row" style={{ gap: 6, marginBottom: 8 }}>
          <span>Lights</span>
          {COLORS.map((c) => (
            <button
              key={c.name}
              className={`chip ${s.lightColor.r === c.rgb.r && s.lightColor.g === c.rgb.g && s.lightColor.b === c.rgb.b ? 'chip-on' : ''}`}
              disabled={running}
              onClick={() => {
                // a new colour: forget a colour picked from the picture
                void lab.setSettings({ auto: { ...lab.settings.auto, lightColor: c.rgb }, markerA: { ...lab.settings.markerA, hsv: undefined } }).then(() => {
                  ac.reconfigure();
                  ac.lightsOn();
                });
              }}
            >{c.name}</button>
          ))}
          <button className="chip" disabled={!cc.running || running} onClick={() => { ac.pickMarker = true; useApp.getState().bump(); }}>tap to calibrate</button>
        </div>
        <label className="row" style={{ marginBottom: 6, flexWrap: 'nowrap' }}>
          <input type="checkbox" checked={s.cameraAssist} disabled={running} onChange={(e) => set({ cameraAssist: e.target.checked })} />
          <span>Camera corrects the robot</span>
        </label>
        <label className="row" style={{ marginBottom: 10, flexWrap: 'nowrap' }}>
          <input type="checkbox" checked={s.lineGuard} disabled={running} onChange={(e) => set({ lineGuard: e.target.checked })} />
          <span>Line sensors stop it off the lane</span>
        </label>
        {running ? (
          <button className="btn btn-danger btn-big btn-block" style={{ minHeight: 70, fontSize: 24 }} onClick={() => lab.stopAll('STOP (auto)')}>STOP</button>
        ) : (
          <button className="btn btn-ok btn-big btn-block" style={{ minHeight: 70, fontSize: 22 }} disabled={!lab.link.connected} onClick={() => void go()}>
            Start lap {s.cameraAssist && !robotOk ? '(camera can’t see the robot!)' : ''}
          </button>
        )}
        <small className="hint">Place the robot on the start line facing section a (towards side b), then start. All four lights go {COLORS.find((c) => c.rgb.g === s.lightColor.g && c.rgb.r === s.lightColor.r && c.rgb.b === s.lightColor.b)?.name ?? 'on'}; the app blinks them to find your robot first.</small>
        {ac.error && <div className="bad-text">{ac.error}</div>}
        {live && (running || live.reason) && (
          <div className="mono" style={{ marginTop: 8 }}>
            {running ? 'running' : live.reason} · section {live.section} · {fmt(live.progress, 0)}/{fmt(live.lengthCm, 0)} cm · {fmt(live.t / 1000, 1)} s
            {live.step && live.step.kind === 'path' ? ` · off ${fmt(live.step.e, 1)} cm` : ''}
            {running ? ` · camera ${Number.isFinite(live.lastFixAgeMs) ? `${fmt(live.lastFixAgeMs, 0)} ms ago` : 'none'}` : ''}
          </div>
        )}
      </div>

      <div className="card">
        <MatMap plan={plan} lane={ac.lane()} route={ac.route} fixes={ac.trail} est={ac.estTrail} auto={auto} />
        <small className="hint">Map seen from side b. Green: camera fixes. Pink: where the robot thinks it is. Yellow dots: turns on the spot.</small>
      </div>

      {ac.summary && <Summary />}

      <div className="row" style={{ gap: 6, margin: '8px 0' }}>
        <button className="btn" onClick={() => void exportLogs()}>Export logs (session zip)</button>
        <button className="btn" onClick={() => void ac.saveViews('manual').then(() => toast('View saved to the session'))} disabled={!cc.running}>Save view</button>
      </div>

      <div className="card">
        <button className="link-btn" onClick={() => setShowTrack(!showTrack)}>{showTrack ? '▾' : '▸'} Track code {lab.settings.auto.route ? '(edited)' : '(measured)'}</button>
        {showTrack && <TrackEditor />}
      </div>
      <div className="card">
        <button className="link-btn" onClick={() => setShowAdv(!showAdv)}>{showAdv ? '▾' : '▸'} Tuning</button>
        {showAdv && <Advanced set={set} s={s} disabled={running} />}
      </div>
    </div>
  );
}

function Summary() {
  const sum = ac.summary!;
  return (
    <div className="card">
      <b>{sum.finished ? 'Lap finished' : `Stopped: ${sum.reason}`}</b> — {(sum.timeMs / 1000).toFixed(1)} s, {sum.progressCm} of {sum.lengthCm} cm
      <div className="table-wrap">
        <table>
          <thead><tr><th>section</th><th>s</th><th>max off cm</th><th>mean off cm</th><th>fixes</th></tr></thead>
          <tbody>
            {sum.sections.map((x) => (
              <tr key={x.id}><td>{x.id}</td><td>{(x.timeMs / 1000).toFixed(1)}</td><td>{x.maxErrCm}</td><td>{x.meanErrCm}</td><td>{x.fixes}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
      <small className="hint">
        Camera fixes used {sum.fixes.used}/{sum.fixes.total}. Learned: pulls {sum.learned.biasDegS > 0 ? 'right' : 'left'} {Math.abs(sum.learned.biasDegS)} °/s,
        speed ×{sum.learned.speedScale}, turning ×{sum.learned.turnScale}. Export the logs and send them over.
      </small>
    </div>
  );
}

function Advanced({ s, set, disabled }: { s: AutoSettings; set: (p: Partial<AutoSettings>) => void; disabled: boolean }) {
  const row = (label: string, key: keyof AutoSettings, min: number, max: number, step: number, unit = '') => (
    <label className="field" key={key}>
      <span>{label} {String(s[key])}{unit}</span>
      <input type="range" min={min} max={max} step={step} value={Number(s[key])} disabled={disabled} onChange={(e) => set({ [key]: Number(e.target.value) } as Partial<AutoSettings>)} />
    </label>
  );
  return (
    <div>
      {row('Correction distance (smaller = sharper)', 'settleCm', 10, 60, 1, ' cm')}
      {row('Speed limit in arcs', 'curveSpeedCmS', 20, 60, 1, ' cm/s')}
      {row('Largest spin', 'maxSpinDeg', 15, 90, 15, '°')}
      {row('Spin wheel command', 'spinCmd', 15, 50, 1)}
      {row('End spins early by', 'spinLeadMs', 0, 150, 5, ' ms')}
      {row('Stand still before a spin', 'settleMs', 0, 500, 10, ' ms')}
      {row('Stand still after a spin', 'afterSpinMs', 0, 800, 10, ' ms')}
      {row('Stop when off the path by', 'offTrackStopCm', 0, 40, 1, ' cm')}
      {row('Lights height above the mat', 'markerHeightCm', 0, 8, 0.5, ' cm')}
      {row('Lights ahead of the wheels', 'markerAheadCm', 0, 10, 0.5, ' cm')}
      {row('Command delay', 'cmdLatencyMs', 0, 150, 5, ' ms')}
      <small className="hint">Leave these alone for the first runs; the logs say what to change.</small>
    </div>
  );
}
