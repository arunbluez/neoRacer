import { useEffect, useState } from 'react';
import { webBluetoothAvailable } from '../../adapters/ble/WebBluetoothTransport';
import type { SessionSummary } from '../../core/log/session';
import { summarize } from '../../core/util/stats';
import { errorMessage } from '../../core/util/async';
import { useApp } from '../appStore';
import { fmt, useLabVersion, useTicker } from '../hooks';
import { getLab, store } from '../lab';

export function ConnectScreen() {
  useTicker(500);
  useLabVersion();
  const lab = getLab();
  const s = lab.link.snapshot();
  const toast = useApp((st) => st.showToast);
  const [busy, setBusy] = useState(false);
  const [pingResult, setPingResult] = useState<string>('');
  const [last, setLast] = useState<SessionSummary | undefined>();
  const p = lab.profile;
  const mock = lab.settings.mockRobot;

  useEffect(() => {
    void store.listSessions().then((list) => setLast(list.find((x) => x.id !== lab.header.id)));
  }, [lab.header.id]);

  const connect = async () => {
    setBusy(true);
    try {
      await lab.connect();
    } catch (err) {
      const msg = errorMessage(err);
      if (!/cancel/i.test(msg)) toast(msg, 'error');
    } finally {
      setBusy(false);
    }
  };

  const pings = async () => {
    setPingResult('pinging…');
    const rtts: number[] = [];
    let lost = 0;
    for (let i = 0; i < 10; i++) {
      const r = await lab.link.query('PING');
      if (r.status === 'ok') rtts.push(r.rttMs);
      else lost++;
    }
    const sm = summarize(rtts);
    setPingResult(`min ${fmt(sm.min)} · median ${fmt(sm.median)} · max ${fmt(sm.max)} ms · lost ${lost}/10`);
    lab.note(`quick check: 10 × PING ${JSON.stringify({ min: sm.min, median: sm.median, max: sm.max, lost })}`, ['quick-check']);
  };

  return (
    <div>
      <div className="card">
        <div className="row-between">
          <div>
            <div style={{ fontSize: 20, fontWeight: 700 }}>
              {s.device ? s.device.name : mock ? 'Mock robot' : 'No robot'}
            </div>
            <div className="muted">
              {s.state}{s.reconnecting ? ' (reconnecting)' : ''} · {s.transport}{s.writeMode ? ` · ${s.writeMode}` : ''}
            </div>
          </div>
          {mock && <span className="badge badge-mock">MOCK</span>}
        </div>
        <div className="row" style={{ marginTop: 12 }}>
          {s.state === 'disconnected' ? (
            <button className="btn btn-primary btn-big" disabled={busy} onClick={connect}>
              {busy ? 'Connecting…' : 'Connect'}
            </button>
          ) : (
            <button className="btn btn-big" onClick={() => void lab.disconnect()}>Disconnect</button>
          )}
        </div>
        {!mock && !webBluetoothAvailable() && (
          <p className="warn-text">
            Web Bluetooth is not available here. Use Chrome on Android, served over HTTPS or http://localhost
            (adb reverse). You can still try everything with the mock robot (Data → Settings).
          </p>
        )}
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Quick checks</h3>
        <div className="row">
          <button className="btn" disabled={!s.state.startsWith('connected')} onClick={() => void pings()}>10 × PING</button>
          <button className="btn" disabled={s.state !== 'connected'} onClick={() => void lab.link.send('HL,255,255,255')}>Headlights white</button>
          <button className="btn" disabled={s.state !== 'connected'} onClick={() => { void lab.link.stop(); void lab.link.send('HO'); }}>All off</button>
        </div>
        {pingResult && <p className="mono">{pingResult}</p>}
      </div>

      <div className="card">
        <div className="row-between">
          <h3 style={{ margin: 0 }}>Session</h3>
          <button className="btn btn-small" onClick={() => void lab.newSession(lab.profile?.robotId).then(() => toast('New session started'))}>
            New session
          </button>
        </div>
        <div className="kv" style={{ marginTop: 8 }}>
          <span>id</span><span className="mono">{lab.header.id}</span>
          <span>events</span><span>{[...lab.logger.counts.values()].reduce((a, b) => a + b, 0)}</span>
          <span>test runs</span><span>{lab.runner.history.length}</span>
        </div>
        {last && (
          <p className="muted" style={{ marginBottom: 0 }}>
            Last session: <span className="mono">{last.id}</span> · {last.eventCount} events · {last.testRunCount} test runs
          </p>
        )}
      </div>

      {p && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Robot profile · {p.robotId}</h3>
          <div className="kv">
            <span>trim</span><span>{fmt(p.trim * 100, 1)} % (right wheel)</span>
            <span>deadband</span><span>{p.deadband ? `LF ${p.deadband.lf} · LB ${p.deadband.lb} · RF ${p.deadband.rf} · RB ${p.deadband.rb}` : '–'}</span>
            <span>speed table</span><span>{p.speedTable?.map((r) => `${r.cmd}→${fmt(r.cmPerS, 1)}`).join(' · ') || '–'}</span>
            <span>spin table</span><span>{p.spinTable?.map((r) => `${r.cmd}→${fmt(r.degPerS, 0)}°/s`).join(' · ') || '–'}</span>
            <span>track width</span><span>{fmt(p.trackWidthCm, 1, ' cm')}</span>
            <span>safe gap / poll</span><span>{fmt(p.safeWriteGapMs, 0, ' ms')} · {fmt(p.safePollHz, 0, ' Hz')}</span>
            <span>packing</span><span>{p.packingSafe === undefined ? 'not tested' : p.packingSafe ? 'safe' : 'unsafe'}</span>
            <span>blocking</span><span>{p.blocking ? Object.entries(p.blocking).map(([k, v]) => `${k} ${Math.round(v)}`).join(' · ') : 'defaults'}</span>
            <span>compass</span><span>{p.compassCalibrated ? 'calibrated' : 'not calibrated'}</span>
          </div>
        </div>
      )}
    </div>
  );
}
