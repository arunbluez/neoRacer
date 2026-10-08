// The race interface: one full-screen view for the final run. The camera
// with everything it draws (track fit, route by section, the robot, the
// search area), the link/track/robot status, the lap time, a sector bar a–g,
// the setup to drive (a saved lap), and START / STOP. Nothing to adjust:
// that's the classic interface's job (Data → Settings → Interface).

import { useEffect, useRef, useState } from 'react';
import { vibrate } from '../../adapters/device/device';
import { errorMessage } from '../../core/util/async';
import { snapshotAuto } from '../../core/race/savedLaps';
import { useApp } from '../appStore';
import { cameraController as cc } from '../camera/controller';
import { LiveView } from '../camera/views';
import { BannerLayer, PromptLayer, Toast } from '../components/PromptLayer';
import { useLabVersion, useTicker } from '../hooks';
import { getLab } from '../lab';
import { autoController as ac } from '../race/autoController';
import { drawLiveOverlay, SECTION_COLORS } from '../race/views';
import './race.css';

const secs = (ms: number) => (ms / 1000).toFixed(1);

function enterFullscreen(): void {
  if (document.fullscreenElement) return;
  void document.documentElement.requestFullscreen?.().then(() => {
    const o = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> };
    return o.lock?.('landscape');
  }).catch(() => {});
}

export function RaceApp() {
  useLabVersion();
  useTicker(100);
  const lab = getLab();
  const toast = useApp((s) => s.showToast);
  const [busy, setBusy] = useState<string | null>(null);
  const [sheet, setSheet] = useState<'laps' | 'menu' | null>(null);
  const [flash, setFlash] = useState(0);
  const camCell = useRef<HTMLDivElement>(null);
  const prev = useRef<{ recovering?: string; holding: boolean; summary?: unknown }>({ holding: false });

  useEffect(() => {
    ac.attach();
    return () => ac.detach();
  }, []);

  const auto = lab.auto;
  const running = auto?.state === 'running';
  const live = auto?.live();
  const sum = ac.summary;
  const last = ac.last;
  const plan = ac.plan();

  // Haptics on what matters: a recovery, losing the robot, the finish.
  const recovering = live?.recovering, holding = !!live?.holding;
  useEffect(() => {
    const p = prev.current;
    if (recovering && !p.recovering) vibrate([30, 40, 30]);
    if (holding && !p.holding) vibrate([20, 30, 20, 30, 20]);
    if (sum && sum !== p.summary && sum.finished) setFlash((n) => n + 1);
    prev.current = { recovering, holding, summary: sum };
  }, [recovering, holding, sum]);

  const act = async (name: string, fn: () => Promise<unknown>) => {
    setBusy(name);
    try {
      await fn();
    } catch (err) {
      toast(errorMessage(err), 'error');
      vibrate(200);
    } finally {
      setBusy(null);
    }
  };
  const connect = () => act('connect', async () => {
    enterFullscreen();
    await lab.connect();
    vibrate(40);
  });
  const camera = () => act('camera', async () => {
    enterFullscreen();
    await cc.start(lab.settings.mockRobot ? 'sim' : lab.settings.cameraId ?? '');
    const z = cc.source?.capabilities() as { zoom?: { min: number } } | null;
    if (z?.zoom) await cc.source!.setZoom(z.zoom.min);
    setTimeout(() => void cc.lockExposure().catch(() => {}), 2500);
    ac.attach();
  });
  const start = () => act('start', async () => {
    enterFullscreen();
    vibrate(25);
    await ac.run();
  });
  const stop = () => {
    lab.stopAll('STOP (race view)');
    vibrate(300);
  };
  const find = () => act('find', async () => {
    const r = await ac.findRobot();
    if (!r) throw new Error('No light blinked along: is the robot in the picture?');
  });

  // Status
  const snap = lab.link.snapshot();
  const linkOk = lab.link.connected;
  const matOk = !!last?.corners && last.matAgeMs < 500;
  const robotOk = !!last?.fix;
  const fit = last?.fit?.score;

  // Lap time
  const best = Math.min(...lab.settings.savedLaps.map((l) => l.lapMs));
  const timeMs = running ? live!.t : sum ? sum.timeMs : 0;
  const timeClass = running ? 'live' : sum?.finished ? 'done' : sum ? 'fail' : '';

  // Setup: the saved lap the settings match, if any.
  const cur = JSON.stringify({ ...snapshotAuto(lab.settings.auto), matRot: null });
  const active = lab.settings.savedLaps.find((l) => JSON.stringify({ ...snapshotAuto(l.auto), matRot: null }) === cur);
  const s = lab.settings.auto;
  const setupText = s.tuning ? s.tuning.label : `${s.speedCmS} cm/s · ${s.style === 'spin' ? 'spins' : 'curves'}`;

  // Sector bar
  const starts = plan.sectionStarts;
  const progress = running ? live!.progress : sum?.finished ? plan.lengthCm : sum ? sum.progressCm : 0;
  const recS = running ? [] : sum?.recoveries?.map((r) => r.s) ?? [];

  // Camera window size: as big as fits the cell at the frame's aspect.
  const size = cc.frameSize ?? { width: 4, height: 3 };
  const cell = camCell.current;
  const camW = cell ? Math.min(cell.clientWidth, (cell.clientHeight * size.width) / size.height) : undefined;

  const state = !running
    ? sum ? (sum.finished ? ['FINISHED', 'run'] : ['STOPPED', 'bad']) : ['READY', '']
    : live!.recovering ? ['RECOVERING', 'warn'] : live!.holding ? ['SEARCHING', 'warn'] : ['RUNNING', 'run'];

  return (
    <div className="rx">
      <header className="rx-top rx-in">
        <div className="rx-brand"><i />RALLY<b>//</b>LAB</div>
        <div className="rx-stat">
          <span className={`rx-dot ${linkOk ? (snap.rttMed && snap.rttMed > 150 ? 'warn' : 'ok') : 'bad'}`} />
          <span className="rx-label">Link</span>
          <span className="rx-v">{linkOk ? `${lab.profile?.robotId ?? 'robot'} ${snap.rttMed ? `${Math.round(snap.rttMed)}ms` : ''}` : 'offline'}</span>
        </div>
        <div className="rx-stat">
          <span className={`rx-dot ${!cc.running ? '' : matOk ? 'ok' : 'warn'}`} />
          <span className="rx-label">Track</span>
          <span className="rx-v">{!cc.running ? '—' : matOk ? `${Math.round((fit ?? 0) * 100)}%` : 'search'}</span>
        </div>
        <div className="rx-stat">
          <span className={`rx-dot ${!cc.running ? '' : robotOk ? 'ok' : ac.blinking || ac.countdown !== null ? 'warn' : 'bad'}`} />
          <span className="rx-label">Robot</span>
          <span className="rx-v">{!cc.running ? '—' : ac.blinking ? 'blink' : ac.countdown !== null ? 'lights' : robotOk ? 'lock' : 'none'}</span>
        </div>
        <span className="rx-rotate">turn the phone sideways</span>
        <div className="rx-spacer" />
        <button className="rx-menu-btn" onClick={() => setSheet('menu')} aria-label="Menu">≡ MENU</button>
      </header>

      <section className={`rx-cam ${matOk && robotOk ? 'locked' : ''}`} ref={camCell}>
        {cc.running ? (
          <div className="rx-cam-inner rx-in d1" style={{ width: camW }}>
            <LiveView draw={(g, scale) => drawLiveOverlay(g, scale, ac.last, plan, ac.route, auto, ac.gate)} />
            <span className="rx-bracket tl" /><span className="rx-bracket tr" /><span className="rx-bracket bl" /><span className="rx-bracket br" />
            {!matOk && <div className="rx-scan" />}
            {ac.countdown !== null && ac.countdown > 0 && (
              <div className="rx-lights">{[1, 2, 3, 4].map((i) => <span key={i} className={ac.countdown! >= i ? 'on' : ''} />)}</div>
            )}
            {ac.countdown === 0 && <div className="rx-go">GO</div>}
            {flash > 0 && <div className="rx-flash" key={flash} />}
            <div className="rx-cam-tag">
              <span className={`rx-state ${state[1]}`}>{state[0]}</span>
              {running && <span>{live!.section.toUpperCase()} · {Math.round(live!.progress)}/{Math.round(live!.lengthCm)} cm{live!.step?.kind === 'path' ? ` · ${live!.step.e >= 0 ? '+' : ''}${live!.step.e.toFixed(1)} cm` : ''}</span>}
            </div>
          </div>
        ) : (
          <div className="rx-empty rx-in d1">
            <div>
              <div className="rx-label">Camera</div>
              <p>Hold the phone sideways, high, from a long side of the mat, with the whole lane in the picture.</p>
            </div>
          </div>
        )}
      </section>

      <div className="rx-sect rx-in d3">
        {starts.map((st, i) => {
          const end = starts[i + 1]?.s ?? plan.lengthCm;
          const len = end - st.s;
          const fill = Math.max(0, Math.min(1, (progress - st.s) / len));
          const now = running && live!.section === st.id;
          const split = !running ? sum?.sections.find((x) => x.id === st.id) : undefined;
          const rec = recS.some((x) => x >= st.s && x < end);
          return (
            <div
              key={st.id}
              className={`rx-seg ${now ? 'now' : ''} ${fill >= 1 ? 'done' : ''} ${rec ? 'rec' : ''}`}
              style={{ flex: `${len} 1 0`, ['--seg' as string]: SECTION_COLORS[i % SECTION_COLORS.length] }}
            >
              <div className="rx-seg-bar"><div className="rx-seg-fill" style={{ width: `${fill * 100}%` }} /></div>
              <div className="rx-seg-meta"><b>{st.id.toUpperCase()}</b><span>{split && fill >= 1 ? secs(split.timeMs) : rec ? '!' : ''}</span></div>
            </div>
          );
        })}
      </div>

      <aside className="rx-side">
        <div className="rx-timer rx-in d2">
          <div className="rx-label">Lap</div>
          <div className={`rx-time ${timeClass}`}>{secs(timeMs)}<small>s</small></div>
          <div className="rx-sub">
            <span>BEST <b>{Number.isFinite(best) ? `${secs(best)} s` : '—'}</b></span>
            {sum && !running && <span>RECOV <b>{sum.recoveries?.length ?? 0}</b></span>}
            {running && <span>RECOV <b>{live!.recoveries}</b></span>}
          </div>
          {sum && !running && !sum.finished && <div className="rx-reason">{sum.reason}</div>}
        </div>
        <div className="rx-rule" />
        <button className="rx-setup rx-in d3" onClick={() => setSheet('laps')} disabled={running}>
          <span className="rx-label">Setup</span>
          <span className="rx-v">{active ? <>{active.name.split(' · ')[0]} <i>★ saved</i></> : <>{setupText} <i>▸</i></>}</span>
        </button>

        <div className="rx-actions rx-in d4">
          {!running && sum?.finished && (
            <button className="rx-btn lime" disabled={!!ac.savedId} onClick={() => void act('save', async () => {
              const l = await ac.saveLastLap();
              if (l) toast(`Saved ${l.name}`);
            })}>{ac.savedId ? '★ Lap saved' : `★ Save lap · ${secs(sum.timeMs)} s`}</button>
          )}
          {!linkOk ? (
            <button className="rx-go-btn" disabled={busy === 'connect'} onClick={connect}>{busy === 'connect' ? 'Pairing…' : 'Connect'}</button>
          ) : !cc.running ? (
            <button className="rx-go-btn" disabled={busy === 'camera'} onClick={camera}>{busy === 'camera' ? 'Starting…' : 'Camera'}</button>
          ) : running || ac.countdown !== null ? (
            <button className="rx-stop-btn" onClick={stop}>Stop</button>
          ) : (
            <>
              <button className="rx-btn" disabled={ac.blinking || !!busy} onClick={find}>{ac.blinking ? 'Blinking…' : 'Find robot'}</button>
              <button className="rx-go-btn" disabled={!!busy || ac.blinking} onClick={start}>{busy === 'start' ? 'Ready…' : 'Start'}</button>
            </>
          )}
        </div>
      </aside>

      {sheet === 'laps' && (
        <div className="rx-sheet-bg" onClick={() => setSheet(null)}>
          <div className="rx-sheet" onClick={(e) => e.stopPropagation()}>
            <h2>SAVED LAPS</h2>
            {lab.settings.savedLaps.length === 0 && <p className="rx-note">No saved laps yet. After a good lap, tap ★ Save lap: its settings are kept, to drive it again whenever.</p>}
            {lab.settings.savedLaps.map((l) => (
              <div key={l.id} className={`rx-lap ${active?.id === l.id ? 'on' : ''}`}>
                <span className="t">{secs(l.lapMs)}</span>
                <button className="d" style={{ background: 'none', border: 'none', color: 'inherit', textAlign: 'left', padding: 0 }} onClick={() => void ac.useSavedLap(l.id).then(() => { toast(`Setup: ${l.name}`); setSheet(null); })}>
                  {l.name.split(' · ').slice(1).join(' · ')}
                  {l.robotId ? <><br />{l.robotId}</> : null}
                </button>
                <button className="x" aria-label="Delete" onClick={() => void ac.deleteSavedLap(l.id)}>✕</button>
              </div>
            ))}
            <p className="rx-note">Tap a lap to drive like it: its speed or lap tuning, turn style, cone dodges and lights.</p>
          </div>
        </div>
      )}
      {sheet === 'menu' && (
        <div className="rx-sheet-bg" onClick={() => setSheet(null)}>
          <div className="rx-sheet" onClick={(e) => e.stopPropagation()}>
            <h2>MENU</h2>
            <button className="rx-btn" onClick={() => { enterFullscreen(); setSheet(null); }}>Full screen</button>
            <button className="rx-btn" disabled={!cc.running || running} onClick={() => { ac.redetect(); setSheet(null); }}>Re-detect track</button>
            <button className="rx-btn" disabled={!linkOk} onClick={() => { ac.lightsOn(); setSheet(null); }}>Lights on</button>
            <button className="rx-btn" disabled={!cc.running || running} onClick={() => { cc.stop(); setSheet(null); }}>Camera off</button>
            <button className="rx-btn" disabled={!linkOk || running} onClick={() => void lab.disconnect()}>Disconnect</button>
            <div className="rx-rule" />
            <button className="rx-btn lime" disabled={running} onClick={() => void lab.setSettings({ ui: 'classic' })}>Classic interface</button>
            <p className="rx-note">The classic interface has every tool: driving, lap tuning, the race engineer, the track code, tests.</p>
          </div>
        </div>
      )}
      <BannerLayer />
      <PromptLayer />
      <Toast />
    </div>
  );
}
