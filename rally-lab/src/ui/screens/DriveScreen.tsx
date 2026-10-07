import { useCallback, useEffect, useRef, useState } from 'react';
import { onTilt, vibrate, type Tilt } from '../../adapters/device/device';
import { arcade, tiltToStick } from '../../core/model/drive';
import { useApp } from '../appStore';
import { fmt, fmtTime, useLabVersion, useTicker } from '../hooks';
import { getLab } from '../lab';

type Stick = { x: number; y: number; active: boolean };

function Joystick({ onChange }: { onChange: (s: Stick) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<Stick>({ x: 0, y: 0, active: false });
  const pointer = useRef<number | null>(null);

  const update = (e: React.PointerEvent) => {
    const el = ref.current!;
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const rad = r.width / 2 * 0.8;
    let x = (e.clientX - cx) / rad;
    let y = -(e.clientY - cy) / rad;
    const m = Math.hypot(x, y);
    if (m > 1) {
      x /= m;
      y /= m;
    }
    const s = { x, y, active: true };
    setPos(s);
    onChange(s);
  };
  const release = () => {
    pointer.current = null;
    const s = { x: 0, y: 0, active: false };
    setPos(s);
    onChange(s);
  };

  return (
    <div
      ref={ref}
      className={`joystick ${pos.active ? 'joystick-active' : ''}`}
      onPointerDown={(e) => {
        if (pointer.current !== null) return;
        pointer.current = e.pointerId;
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        update(e);
      }}
      onPointerMove={(e) => {
        if (e.pointerId === pointer.current) update(e);
      }}
      onPointerUp={(e) => e.pointerId === pointer.current && release()}
      onPointerCancel={(e) => e.pointerId === pointer.current && release()}
      onLostPointerCapture={(e) => e.pointerId === pointer.current && release()}
    >
      <div className="joystick-base" />
      <div className="joystick-knob" style={{ left: `${50 + pos.x * 40}%`, top: `${50 - pos.y * 40}%` }} />
    </div>
  );
}

function LapTimer() {
  useTicker(100);
  const lab = getLab();
  const [t0, setT0] = useState<number | null>(null);
  const [laps, setLaps] = useState<number[]>([]);
  const [lastLapAt, setLastLapAt] = useState<number | null>(null);
  const now = lab.logger.now();
  return (
    <div className="card">
      <div className="row-between">
        <h3 style={{ margin: 0 }}>Lap timer</h3>
        <span className="mono" style={{ fontSize: 22 }}>{t0 === null ? '00:00.0' : `${fmtTime(now - (lastLapAt ?? t0))}.${Math.floor(((now - (lastLapAt ?? t0)) % 1000) / 100)}`}</span>
      </div>
      <div className="row" style={{ marginTop: 8 }}>
        {t0 === null ? (
          <button className="btn btn-primary btn-big" onClick={() => { setT0(now); setLastLapAt(now); setLaps([]); lab.note('lap timer start', ['lap']); }}>Start</button>
        ) : (
          <>
            <button
              className="btn btn-primary btn-big"
              onClick={() => {
                const lap = now - (lastLapAt ?? t0);
                setLaps([...laps, lap]);
                setLastLapAt(now);
                lab.logger.log('note', { text: `lap ${laps.length + 1}: ${(lap / 1000).toFixed(2)} s`, tags: ['lap'], lapMs: Math.round(lap) });
              }}
            >
              Lap
            </button>
            <button className="btn btn-big" onClick={() => { setT0(null); lab.note(`lap timer stop after ${laps.length} laps`, ['lap']); }}>Stop</button>
          </>
        )}
      </div>
      {laps.length > 0 && (
        <div className="mono muted" style={{ marginTop: 6 }}>{laps.map((l, i) => `#${i + 1} ${(l / 1000).toFixed(2)} s`).join(' · ')}</div>
      )}
    </div>
  );
}

export function DriveScreen() {
  useLabVersion();
  useTicker(150);
  const lab = getLab();
  const toast = useApp((s) => s.showToast);
  const d = lab.settings.drive;
  const [mode, setMode] = useState<'stick' | 'tilt'>('stick');
  const [cap, setCap] = useState(d.speedCap);
  const [expo, setExpo] = useState(d.expo);
  const [trim, setTrim] = useState(lab.profile?.trim ?? 0);
  const [overlay, setOverlay] = useState(d.lineOverlay);
  const [tiltHeld, setTiltHeld] = useState(false);
  const stick = useRef<Stick>({ x: 0, y: 0, active: false });
  const tilt = useRef<Tilt | null>(null);
  const neutral = useRef<{ beta: number; gamma: number } | null>(null);
  const last = useRef({ l: 0, r: 0, at: 0 });
  const [out, setOut] = useState({ l: 0, r: 0 });

  // Live config for the send loop without restarting it.
  const cfg = useRef({ cap, expo, trim, mode, tiltHeld });
  cfg.current = { cap, expo, trim, mode, tiltHeld };

  useEffect(() => setTrim(lab.profile?.trim ?? 0), [lab.profile?.trim]);

  // Tilt sensor
  useEffect(() => {
    if (mode !== 'tilt') return;
    return onTilt((t) => {
      tilt.current = t;
      neutral.current ??= { beta: t.beta, gamma: t.gamma };
    });
  }, [mode]);

  // Line sensor overlay: poll ?LINE while this screen is open.
  useEffect(() => {
    if (!overlay) return;
    const hz = Math.min(lab.profile?.safePollHz ?? 10, 20);
    const prev = lab.poller.set([...lab.poller.entries.filter((e) => e.cmd !== '?LINE'), { cmd: '?LINE', hz }], 'drive');
    return () => {
      lab.poller.set(prev.entries, prev.source);
    };
  }, [overlay, lab]);

  const sendNow = useCallback((l: number, r: number, raw: unknown, force = false) => {
    const now = performance.now();
    if (!force && l === last.current.l && r === last.current.r && now - last.current.at < 300) return;
    last.current = { l, r, at: now };
    setOut({ l, r });
    lab.logger.log('input', { mode: cfg.current.mode, left: l, right: r, raw });
    void lab.link.send(l === 0 && r === 0 ? 'S' : `MS,${l},${r}`).then((rec) => {
      if (rec.status === 'error' || rec.status === 'rejected') vibrate(80);
    });
  }, [lab]);

  // Send loop at the write gap (or the configured rate, whichever is slower).
  useEffect(() => {
    const hz = lab.settings.drive.sendHz;
    const period = Math.max(lab.settings.minWriteGapMs, hz > 0 ? 1000 / hz : 0, 10);
    let wasActive = false;
    const h = setInterval(() => {
      if (!lab.link.connected) return;
      const c = cfg.current;
      let x = 0;
      let y = 0;
      let active = false;
      if (c.mode === 'stick') {
        ({ x, y, active } = stick.current);
      } else if (c.tiltHeld && tilt.current && neutral.current) {
        ({ x, y } = tiltToStick(tilt.current.beta, tilt.current.gamma, neutral.current, lab.settings.drive.tiltMaxDeg));
        active = true;
      }
      if (!active) {
        // Dead-man: lifting the finger stops the robot.
        if (wasActive) sendNow(0, 0, { x: 0, y: 0, released: true }, true);
        wasActive = false;
        return;
      }
      wasActive = true;
      const { l, r } = arcade(x, y, { speedCap: c.cap, expo: c.expo, trim: c.trim });
      sendNow(l, r, { x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100 });
    }, period);
    return () => {
      clearInterval(h);
      if (wasActive) void lab.link.stop();
    };
  }, [lab, sendNow]);

  const lineEv = lab.link.latest.get('line');
  const code = lineEv?.reply.type === 'line' && performance.now() - lineEv.tRx < 1000 ? lineEv.reply.code : undefined;
  const snap = lab.link.snapshot();

  const saveDriveSettings = () => void lab.setSettings({ drive: { ...lab.settings.drive, speedCap: cap, expo, lineOverlay: overlay } });

  return (
    <div>
      {!lab.link.connected && <div className="card warn-text">Not connected.</div>}
      <div className="row-between" style={{ marginBottom: 8 }}>
        <div className="row">
          <button className={`chip ${mode === 'stick' ? 'chip-on' : ''}`} onClick={() => setMode('stick')}>Stick</button>
          <button className={`chip ${mode === 'tilt' ? 'chip-on' : ''}`} onClick={() => { neutral.current = null; setMode('tilt'); }}>Tilt</button>
          <button className={`chip ${overlay ? 'chip-on' : ''}`} onClick={() => setOverlay(!overlay)}>Line</button>
        </div>
        <div className="mono" style={{ fontSize: 15 }}>L {fmt(out.l)} · R {fmt(out.r)}</div>
      </div>

      {overlay && (
        <div className="row-between" style={{ marginBottom: 8 }}>
          <div className="line-squares" style={{ margin: 0 }}>
            <div className={`line-square ${code === 2 || code === 3 ? 'line-black' : 'line-white'}`} style={{ opacity: code === undefined ? 0.3 : 1 }}>L</div>
            <div className={`line-square ${code === 1 || code === 3 ? 'line-black' : 'line-white'}`} style={{ opacity: code === undefined ? 0.3 : 1 }}>R</div>
          </div>
          <span className="muted">rtt {fmt(snap.rttMed, 0)} ms · {snap.txps.toFixed(0)} tx/s</span>
        </div>
      )}

      {mode === 'stick' ? (
        <Joystick onChange={(s) => (stick.current = s)} />
      ) : (
        <div className="card">
          <p className="muted" style={{ marginTop: 0 }}>Hold the button and tilt the phone: away = forward, sideways = turn. Neutral is the pose when tilt mode started.</p>
          <button
            className={`btn btn-big btn-block ${tiltHeld ? 'btn-primary' : ''}`}
            style={{ minHeight: 160, fontSize: 22, touchAction: 'none' }}
            onPointerDown={() => setTiltHeld(true)}
            onPointerUp={() => setTiltHeld(false)}
            onPointerCancel={() => setTiltHeld(false)}
            onPointerLeave={() => setTiltHeld(false)}
          >
            {tiltHeld ? 'DRIVING' : 'Hold to drive'}
          </button>
          <button className="btn btn-small" style={{ marginTop: 8 }} onClick={() => { neutral.current = tilt.current ? { beta: tilt.current.beta, gamma: tilt.current.gamma } : null; toast('Neutral reset'); }}>
            Reset neutral
          </button>
        </div>
      )}

      <div className="card" style={{ marginTop: 12 }}>
        <label className="field">
          <span>Speed cap {cap}</span>
          <input type="range" min={10} max={100} step={5} value={cap} onChange={(e) => setCap(Number(e.target.value))} onPointerUp={saveDriveSettings} />
        </label>
        <label className="field">
          <span>Expo {expo.toFixed(2)}</span>
          <input type="range" min={0} max={1} step={0.05} value={expo} onChange={(e) => setExpo(Number(e.target.value))} onPointerUp={saveDriveSettings} />
        </label>
        <label className="field">
          <span>Trim {(trim * 100).toFixed(1)} % (right wheel){lab.profile ? '' : ' — connect to save it'}</span>
          <input
            type="range" min={-20} max={20} step={0.5} value={trim * 100}
            onChange={(e) => setTrim(Number(e.target.value) / 100)}
            onPointerUp={() => void lab.updateProfile({ trim })}
          />
        </label>
      </div>
      <LapTimer />
    </div>
  );
}
