import { useEffect, useRef, useState } from 'react';
import type { LogEvent } from '../../core/log/events';
import { useTicker } from '../hooks';
import { getLab } from '../lab';

type Filter = 'tx' | 'rx' | 'err' | 'test' | 'other';
const FILTERS: Filter[] = ['tx', 'rx', 'err', 'test', 'other'];

const HISTORY_KEY = 'rally-lab.console.history';
const FAV_KEY = 'rally-lab.console.favourites';
const DEFAULT_FAVS = ['PING', '?LINE', '?DIST', '?ACCEL', 'HL,255,255,255', 'HO', 'BEEP', 'S'];

function load(key: string, dflt: string[]): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? 'null') as unknown;
    return Array.isArray(v) ? (v as string[]) : dflt;
  } catch {
    return dflt;
  }
}
function save(key: string, v: string[]) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    // ignore
  }
}

function classOf(e: LogEvent): Filter {
  if (e.k === 'ble.tx' || e.k === 'ble.drop') return 'tx';
  if (e.k === 'ble.rx' || e.k === 'sensor') return 'rx';
  if (e.k === 'ble.err' || (e.k === 'app' && e.event === 'error')) return 'err';
  if (e.k.startsWith('test.')) return 'test';
  return 'other';
}

function line(e: LogEvent): string {
  const t = (e.t / 1000).toFixed(3).padStart(9);
  switch (e.k) {
    case 'ble.tx': return `${t} → ${e.cmd}  [${e.ch}] ${e.err ? `ERR ${e.err}` : `${Math.round(Number(e.tDone) - Number(e.tEnq))}ms`}`;
    case 'ble.drop': return `${t} ✕ ${e.cmd}  [${e.ch}] ${e.status}${e.message ? ` ${e.message}` : ''}`;
    case 'ble.rx': return `${t} ← ${e.raw}`;
    case 'sensor': {
      const v = e.value === null ? '' : ` ${Array.isArray(e.value) ? e.value.join(',') : String(e.value)}`;
      return `${t} ← ${e.type}${v}${e.rttMs !== undefined ? `  rtt ${e.rttMs}ms` : ''}`;
    }
    case 'ble.err': return `${t} ! ${e.op}: ${e.message}${e.cmd ? ` (${e.cmd})` : ''}`;
    case 'ble.state': return `${t} ● ${e.state}${e.reason ? ` (${e.reason})` : ''}${e.durMs !== undefined ? ` ${e.durMs}ms` : ''}`;
    case 'test.start': return `${t} ▶ ${e.testId} ${JSON.stringify(e.params)}`;
    case 'test.end': return `${t} ■ ${e.testId} ${e.status}`;
    case 'test.sample': return `${t}   ${e.testId} ${JSON.stringify(e.data)}`;
    case 'note': return `${t} ✎ ${e.text}`;
    case 'app': return `${t} · ${e.event} ${typeof e.detail === 'string' ? e.detail : ''}`;
    default: {
      const { t: _t, k, ...rest } = e;
      return `${t} ${k} ${JSON.stringify(rest)}`;
    }
  }
}

export function ConsoleScreen() {
  const lab = getLab();
  const [paused, setPaused] = useState(false);
  const [filters, setFilters] = useState<Set<Filter>>(new Set(['tx', 'rx', 'err', 'test']));
  const [text, setText] = useState('');
  const [history, setHistory] = useState(() => load(HISTORY_KEY, []));
  const [favs, setFavs] = useState(() => load(FAV_KEY, DEFAULT_FAVS));
  const [frozen, setFrozen] = useState<LogEvent[] | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  useTicker(200, !paused);

  const events = (paused && frozen ? frozen : lab.logger.ring.last(1500)).filter((e) => {
    // too fast to read here; ble.rx is shown through its parsed `sensor` line
    if (e.k === 'cam.pose' || e.k === 'input' || e.k === 'ble.rx') return false;
    return filters.has(classOf(e));
  }).slice(-300);

  useEffect(() => {
    if (!paused && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  });

  const send = (raw: string) => {
    const cmd = raw.trim();
    if (!cmd) return;
    // Text containing '#' goes out exactly as typed (one write); otherwise one command.
    void lab.link.send(cmd, cmd.includes('#') ? { literal: true } : { ch: 'raw' });
    const h = [cmd, ...history.filter((x) => x !== cmd)].slice(0, 30);
    setHistory(h);
    save(HISTORY_KEY, h);
    setText('');
  };

  const toggleFav = (cmd: string) => {
    const f = favs.includes(cmd) ? favs.filter((x) => x !== cmd) : [...favs, cmd];
    setFavs(f);
    save(FAV_KEY, f);
  };

  return (
    <div>
      <form className="row" onSubmit={(e) => { e.preventDefault(); send(text); }}>
        <input
          className="mono"
          style={{ flex: 1, minWidth: 0 }}
          placeholder="command, e.g. MS,40,40 or PING#PING#"
          value={text}
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          onChange={(e) => setText(e.target.value)}
        />
        <button className="btn btn-primary" type="submit">Send</button>
        <button className="btn" type="button" title="favourite" onClick={() => text.trim() && toggleFav(text.trim())}>
          {favs.includes(text.trim()) ? '★' : '☆'}
        </button>
      </form>
      <div className="row" style={{ margin: '8px 0' }}>
        {favs.map((f) => (
          <button key={f} className="chip mono" onClick={() => send(f)} onContextMenu={(e) => { e.preventDefault(); toggleFav(f); }}>
            {f}
          </button>
        ))}
      </div>
      {history.length > 0 && (
        <div className="row" style={{ marginBottom: 8, flexWrap: 'nowrap', overflowX: 'auto' }}>
          {history.slice(0, 12).map((h) => (
            <button key={h} className="chip mono" style={{ flex: 'none', opacity: 0.8 }} onClick={() => setText(h)}>
              {h}
            </button>
          ))}
        </div>
      )}
      <div className="row" style={{ marginBottom: 8 }}>
        {FILTERS.map((f) => (
          <button
            key={f}
            className={`chip ${filters.has(f) ? 'chip-on' : ''}`}
            onClick={() => {
              const n = new Set(filters);
              if (n.has(f)) n.delete(f);
              else n.add(f);
              setFilters(n);
            }}
          >
            {f}
          </button>
        ))}
        <span className="spacer" />
        <button
          className={`chip ${paused ? 'chip-on' : ''}`}
          onClick={() => {
            setFrozen(paused ? null : lab.logger.ring.last(1500));
            setPaused(!paused);
          }}
        >
          {paused ? 'Paused' : 'Pause'}
        </button>
      </div>
      <div className="console-log" ref={logRef}>
        {events.map((e, i) => (
          <div key={`${e.t}-${i}`} className={`log-${e.k === 'ble.tx' ? 'tx' : e.k === 'ble.drop' ? 'drop' : classOf(e) === 'rx' ? 'rx' : classOf(e) === 'err' ? 'err' : classOf(e) === 'test' ? 'test' : 'app'}`}>
            {line(e)}
          </div>
        ))}
      </div>
      <p className="hint">Long-press a favourite to remove it. Text with # is sent as one literal write (e.g. PING#PING#).</p>
    </div>
  );
}
