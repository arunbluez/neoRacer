// Edit the track code: each section's straights (length, cone offsets) and
// turns (radius). Saved in the settings; "Reset" goes back to the measured track.

import { useState } from 'react';
import { checkRoute, closureError, RALLY_ROUTE, type RoutePart, type RouteSpec } from '../../core/race/route';
import { getLab } from '../lab';
import { useApp } from '../appStore';

function Num({ value, onCommit, width = 64 }: { value: number; onCommit: (v: number) => void; width?: number }) {
  const [text, setText] = useState(String(value));
  const [was, setWas] = useState(value);
  if (value !== was) {
    setWas(value);
    setText(String(value));
  }
  return (
    <input
      inputMode="decimal"
      style={{ width, padding: '4px 6px' }}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        const v = Number(text.replace(',', '.'));
        if (Number.isFinite(v)) onCommit(v);
        else setText(String(value));
      }}
    />
  );
}

export function TrackEditor() {
  const lab = getLab();
  const toast = useApp((s) => s.showToast);
  const route = lab.settings.auto.route ?? RALLY_ROUTE;
  const edited = !!lab.settings.auto.route;

  const save = (r: RouteSpec | undefined) => {
    if (r) {
      const problems = checkRoute(r);
      if (problems.length) {
        toast(problems[0], 'error');
        return;
      }
    }
    void lab.setSettings({ auto: { ...lab.settings.auto, route: r } });
  };
  const setPart = (si: number, pi: number, patch: Partial<RoutePart>) => {
    const r: RouteSpec = JSON.parse(JSON.stringify(route));
    Object.assign(r.sections[si].parts[pi], patch);
    save(r);
  };
  const setOffset = (si: number, pi: number, oi: number, key: 'from' | 'to' | 'offsetCm', v: number) => {
    const r: RouteSpec = JSON.parse(JSON.stringify(route));
    const p = r.sections[si].parts[pi];
    if (p.kind === 'straight' && p.offsets) p.offsets[oi][key] = v;
    save(r);
  };
  const close = closureError(route);

  return (
    <div>
      <p className="hint" style={{ marginTop: 0 }}>
        Lengths are the straight parts between curves, in cm (measured from the venue photo). Offsets shift the line to
        follow around cones: positive = to the right of the driving direction. The lap {close < 2 ? 'closes' : `misses the start by ${close.toFixed(1)} cm`}.
      </p>
      {route.sections.map((sec, si) => (
        <div key={sec.id} style={{ borderTop: '1px solid #333', padding: '6px 0' }}>
          <div><b>{sec.id}</b> <span className="muted">{sec.note}</span></div>
          {sec.parts.map((p, pi) => (
            <div key={pi} className="row" style={{ gap: 6, margin: '4px 0', flexWrap: 'wrap' }}>
              {p.kind === 'straight' ? (
                <>
                  <span style={{ width: 70 }}>straight</span>
                  <Num value={p.lengthCm} onCommit={(v) => setPart(si, pi, { lengthCm: v })} />
                  <span className="muted">cm</span>
                  {p.offsets?.map((o, oi) => (
                    <span key={oi} className="row" style={{ gap: 4 }}>
                      <span className="muted">· {oi === 0 ? 'offset' : 'then'}</span>
                      <Num width={48} value={o.from} onCommit={(v) => setOffset(si, pi, oi, 'from', v)} />–
                      <Num width={48} value={o.to} onCommit={(v) => setOffset(si, pi, oi, 'to', v)} />
                      <span className="muted">cm:</span>
                      <Num width={48} value={o.offsetCm} onCommit={(v) => setOffset(si, pi, oi, 'offsetCm', v)} />
                    </span>
                  ))}
                </>
              ) : (
                <>
                  <span style={{ width: 70 }}>{p.deg < 0 ? 'left' : 'right'} {Math.abs(p.deg)}°</span>
                  <span className="muted">radius</span>
                  <Num value={p.radiusCm} onCommit={(v) => setPart(si, pi, { radiusCm: v })} />
                  <span className="muted">cm</span>
                </>
              )}
            </div>
          ))}
        </div>
      ))}
      <div className="row" style={{ marginTop: 8 }}>
        <span className="muted">Start x</span>
        <Num value={route.start.x} onCommit={(v) => save({ ...route, start: { ...route.start, x: v } })} />
        <span className="muted">y</span>
        <Num value={route.start.y} onCommit={(v) => save({ ...route, start: { ...route.start, y: v } })} />
      </div>
      <div className="row" style={{ marginTop: 8 }}>
        <button className="btn btn-small" disabled={!edited} onClick={() => save(undefined)}>Reset to the measured track</button>
        <button className="btn btn-small" onClick={() => {
          void navigator.clipboard?.writeText(JSON.stringify(route, null, 2)).then(() => toast('Track code copied'), () => toast('Copy failed', 'error'));
        }}>Copy track code</button>
      </div>
    </div>
  );
}
