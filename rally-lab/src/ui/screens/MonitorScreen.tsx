import { useState } from 'react';
import type { ReplyEvent } from '../../core/link/link';
import type { PollerEntry } from '../../core/settings';
import { useApp } from '../appStore';
import { Sparkline } from '../components/Sparkline';
import { fmt, useLabVersion, useTicker } from '../hooks';
import { getLab } from '../lab';

const QUERIES = ['?LINE', '?ACCEL', '?DIST', '?LIGHT', '?TEMP', 'PING', '?COMPASS'];
const RATES = [0, 0.5, 1, 2, 5, 10, 20, 30];
const TAGS = ['battery swap', 'robot moved', 'track bumped', 'lighting change', 'glitch', 'other robot nearby'];

function age(e: ReplyEvent | undefined, now: number): string {
  if (!e) return 'no data';
  const s = (now - e.tRx) / 1000;
  return s < 1 ? 'now' : `${s.toFixed(s < 10 ? 1 : 0)} s ago`;
}

export function MonitorScreen() {
  useTicker(100);
  useLabVersion();
  const lab = getLab();
  const toast = useApp((s) => s.showToast);
  const now = performance.now();
  const latest = lab.link.latest;
  const line = latest.get('line');
  const dist = latest.get('dist');
  const accel = latest.get('accel');
  const light = latest.get('light');
  const temp = latest.get('temp');
  const compass = latest.get('compass');
  const compassOk = !!lab.profile?.compassCalibrated;
  const [note, setNote] = useState('');
  const [tags, setTags] = useState<Set<string>>(new Set());

  const code = line?.reply.type === 'line' ? line.reply.code : undefined;
  const leftBlack = code === 2 || code === 3;
  const rightBlack = code === 1 || code === 3;

  const rtt = lab.link.stats.rtt.last(400).filter((s) => now - s.t < 10_000).map((s) => [s.t, s.rtt] as [number, number]);
  const accelSeries = lab.link.replies.last(600).filter((e) => e.reply.type === 'accel' && now - e.tRx < 10_000);
  const magPts = accelSeries.map((e) => (e.reply.type === 'accel' ? [e.tRx, Math.hypot(e.reply.x, e.reply.y, e.reply.z)] : [0, 0]) as [number, number]);
  const linePts = lab.link.replies.last(600).filter((e) => e.reply.type === 'line' && now - e.tRx < 10_000)
    .map((e) => [e.tRx, e.reply.type === 'line' ? e.reply.code : 0] as [number, number]);
  const snap = lab.link.snapshot();

  const entries = lab.poller.entries;
  const rateOf = (cmd: string) => entries.find((e) => e.cmd === cmd)?.hz ?? 0;
  const setRate = (cmd: string, hz: number) => {
    const next: PollerEntry[] = [...entries.filter((e) => e.cmd !== cmd), ...(hz > 0 ? [{ cmd, hz }] : [])];
    lab.poller.set(next, 'monitor');
    lab.logger.log('app', { event: 'poller', detail: next });
    useApp.getState().bump();
  };
  const applyPreset = (name: string) => {
    const p = lab.settings.pollerPresets.find((x) => x.name === name);
    if (!p) return;
    const entries2 = p.entries.filter((e) => e.cmd !== '?COMPASS' || compassOk);
    lab.poller.set(entries2, `preset:${name}`);
    lab.logger.log('app', { event: 'poller', detail: { preset: name, entries: entries2 } });
    useApp.getState().bump();
  };

  return (
    <div>
      <div className="tiles">
        <div className="tile">
          <div className="tile-label">Line sensors</div>
          <div className="line-squares">
            <div className={`line-square ${leftBlack ? 'line-black' : 'line-white'}`}>{code === undefined ? '?' : 'L'}</div>
            <div className={`line-square ${rightBlack ? 'line-black' : 'line-white'}`}>{code === undefined ? '?' : 'R'}</div>
          </div>
          <div className="tile-sub">code {code ?? '–'} · {age(line, now)}</div>
        </div>
        <div className="tile">
          <div className="tile-label">Round trip</div>
          <div className="tile-value">{fmt(snap.rttMed, 0)}<small> ms</small></div>
          <div className="tile-sub">p95 {fmt(snap.rttP95, 0)} · last {fmt(snap.rttLast, 0)} · lost {snap.lost}</div>
        </div>
        <div className="tile tile-wide">
          <div className="row-between"><span className="tile-label">RTT, 10 s</span><span className="tile-sub">{snap.txps.toFixed(1)} tx/s · {snap.rxps.toFixed(1)} rx/s</span></div>
          <Sparkline points={rtt} min={0} />
        </div>
        <div className="tile">
          <div className="tile-label">Ultrasonic</div>
          <div className="tile-value">{dist?.reply.type === 'dist' ? dist.reply.cm : '–'}<small> cm</small></div>
          <div className="tile-sub">{age(dist, now)}</div>
        </div>
        <div className="tile">
          <div className="tile-label">Light · Temp</div>
          <div className="tile-value">{light?.reply.type === 'light' ? light.reply.level : '–'}<small> · </small>{temp?.reply.type === 'temp' ? temp.reply.celsius : '–'}<small>°C</small></div>
          <div className="tile-sub">{age(light, now)}</div>
        </div>
        <div className="tile tile-wide">
          <div className="row-between">
            <span className="tile-label">Accelerometer (mg)</span>
            <span className="tile-sub">{age(accel, now)}</span>
          </div>
          {accel?.reply.type === 'accel' ? (
            <div className="mono" style={{ fontSize: 16 }}>
              x {accel.reply.x} · y {accel.reply.y} · z {accel.reply.z} · |a| {Math.round(Math.hypot(accel.reply.x, accel.reply.y, accel.reply.z))}
            </div>
          ) : <div className="muted">–</div>}
          <Sparkline points={magPts} color="#d2a8ff" refLine={1024} />
        </div>
        <div className="tile tile-wide">
          <div className="tile-label">Line code, 10 s</div>
          <Sparkline points={linePts} min={0} max={3} color="#7ee787" height={36} />
        </div>
        {compassOk && (
          <div className="tile">
            <div className="tile-label">Compass</div>
            <div className="tile-value">{compass?.reply.type === 'compass' ? compass.reply.degrees : '–'}<small>°</small></div>
            <div className="tile-sub">{age(compass, now)}</div>
          </div>
        )}
      </div>

      <div className="card" style={{ marginTop: 12 }}>
        <div className="row-between">
          <h3 style={{ margin: 0 }}>Poller</h3>
          <span className="faint" style={{ fontSize: 12 }}>{lab.poller.source}</span>
        </div>
        <div className="row" style={{ margin: '8px 0' }}>
          {lab.settings.pollerPresets.map((p) => (
            <button key={p.name} className="chip" onClick={() => applyPreset(p.name)}>{p.name}</button>
          ))}
        </div>
        {QUERIES.map((q) => (
          <div key={q} className="row-between" style={{ marginBottom: 6 }}>
            <span className="mono" style={{ width: 90 }}>{q}</span>
            {q === '?COMPASS' && !compassOk ? (
              <span className="faint" style={{ fontSize: 12 }}>disabled until the profile marks the compass calibrated</span>
            ) : (
              <select value={String(rateOf(q))} onChange={(e) => setRate(q, Number(e.target.value))} style={{ flex: 1 }}>
                {RATES.map((r) => <option key={r} value={r}>{r === 0 ? 'off' : `${r} Hz`}</option>)}
              </select>
            )}
          </div>
        ))}
        <p className="hint">Polled queries go through the query channel; a slow link drops duplicates instead of building a backlog. Tests pause the poller while they run.</p>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Note</h3>
        <textarea rows={2} style={{ width: '100%' }} value={note} placeholder="What just happened?" onChange={(e) => setNote(e.target.value)} />
        <div className="row" style={{ margin: '8px 0' }}>
          {TAGS.map((t) => (
            <button
              key={t}
              className={`chip ${tags.has(t) ? 'chip-on' : ''}`}
              onClick={() => {
                const n = new Set(tags);
                if (n.has(t)) n.delete(t);
                else n.add(t);
                setTags(n);
              }}
            >
              {t}
            </button>
          ))}
        </div>
        <button
          className="btn btn-primary btn-block"
          disabled={!note.trim() && tags.size === 0}
          onClick={() => {
            lab.note(note.trim(), [...tags]);
            setNote('');
            setTags(new Set());
            toast('Note logged');
          }}
        >
          Log note
        </button>
      </div>
    </div>
  );
}
