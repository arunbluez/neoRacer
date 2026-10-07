import { devSync, getLab } from '../lab';
import { useApp } from '../appStore';
import { fmt, fmtTime, useLabVersion, useTicker } from '../hooks';

export function Header() {
  useTicker(250);
  useLabVersion();
  const lab = getLab();
  const s = lab.link.snapshot();
  const camFps = useApp((st) => st.camFps);
  const updateReady = useApp((st) => st.updateReady);
  const applyUpdate = useApp((st) => st.applyUpdate);
  const running = lab.runner.state;
  const mock = s.transport === 'mock';
  const dot = s.state === 'connected' ? 'ok' : s.state === 'connecting' ? 'warn' : 'off';
  const sync = devSync.state;

  return (
    <header className="header">
      <div className="header-row">
        <div className="header-status">
          <span className={`dot dot-${dot}`} title={s.state} />
          <span className="robot-id">{lab.profile && s.state !== 'disconnected' ? lab.profile.robotId : s.reconnecting ? 'reconnecting' : 'no robot'}</span>
          {mock && <span className="badge badge-mock">MOCK</span>}
          <span className="stat" title="median round-trip time, 10 s">
            <small>rtt</small>{fmt(s.rttMed, 0)}<small>ms</small>
          </span>
          <span className="stat" title="queued writes">
            <small>q</small>{s.queueTotal}
          </span>
          {s.busy && <span className="badge badge-busy">busy {Math.ceil(s.busyMs / 100) / 10}s</span>}
          {camFps !== undefined && <span className="stat"><small>cam</small>{fmt(camFps, 0)}<small>fps</small></span>}
          {running.run && <span className="badge badge-test">{running.run.testId}</span>}
        </div>
        <button className="stop" onClick={() => lab.stopAll('STOP button')} aria-label="Stop">
          STOP
        </button>
      </div>
      <div className="header-sub">
        <span className={`sync sync-${sync}`} title={devSync.lastError ?? 'dev sync'}>
          ● {sync === 'ok' ? 'sync' : sync === 'failing' ? 'sync failing' : 'no dev server'}
        </span>
        <span>{fmtTime(lab.logger.now())}</span>
        <span className="mono" title={lab.header.id}>{lab.header.id}</span>
        <span className="mono build" title={`built ${__BUILD_TIME__}`}>{__BUILD_ID__}</span>
        {updateReady && (
          <button className="link-btn" onClick={() => applyUpdate?.()}>Reload new version</button>
        )}
      </div>
    </header>
  );
}
