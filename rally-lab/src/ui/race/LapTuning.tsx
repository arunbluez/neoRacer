// Lap tuning on the Auto screen: the speeds the robot drives section by
// section, the runs so far, and the two ways to the next tuning: the quick
// tune (rules, on the phone) or the race engineer (Claude: the laptop command
// reads the session export and writes a plan; or copy the brief into the
// Claude app and paste its answer back). Every change is shown before it
// applies, and one step can be undone.

import { useEffect, useMemo, useRef, useState } from 'react';
import { copyText, shareOrDownload } from '../../adapters/export/share';
import type { RunAnalysis } from '../../core/race/lapAnalysis';
import { quickTune } from '../../core/race/learner';
import { constantTuning, tuningDiff } from '../../core/race/tuning';
import { errorMessage } from '../../core/util/async';
import { useApp } from '../appStore';
import { getLab } from '../lab';
import { autoController as ac } from './autoController';
import { applyTuning, briefText, reviewPlan, tuningInUse, undoTuning, type PlanReview as Review } from './engineerFlow';

const s1 = (ms: number) => (ms / 1000).toFixed(1);

export function LapTuning({ disabled }: { disabled: boolean }) {
  const lab = getLab();
  const toast = useApp((x) => x.showToast);
  const s = lab.settings.auto;
  const { ids, base, profile, current, predictOf } = useMemo(() => tuningInUse(s, lab.profile), [s, lab.profile]);
  const [runs, setRuns] = useState<RunAnalysis[]>([]);
  const [review, setReview] = useState<Review | null>(null);
  const [withRoute, setWithRoute] = useState(false);
  const [paste, setPaste] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // Read the runs again after every run (the summary is a new object each time).
  const lastSummary = ac.summary;

  useEffect(() => {
    void lab.autoRunAnalyses().then(setRuns).catch(() => setRuns([]));
  }, [lab, lastSummary]);

  const quick = () => {
    const last = runs[runs.length - 1];
    if (!last) return toast('Drive a lap first: the quick tune learns from the last run.', 'error');
    const q = quickTune(last, current, last.n);
    const t = { ...q.tuning, label: `quick after run ${last.n}` };
    const warn = [...q.warnings];
    if (last.tuning.label !== base.label) warn.unshift(`The last run drove "${last.tuning.label}", not the tuning in use ("${base.label}").`);
    setWithRoute(false);
    setReview({
      title: t.label, tuning: t, diff: tuningDiff(current, t), notes: q.reasons, watch: [], warnings: warn,
      predictedS: predictOf(t), routeApplied: [], routeRejected: [],
    });
  };

  const loadPlan = (text: string) => {
    const { review: r, error } = reviewPlan(text);
    if (!r) return toast(error ?? 'No plan found', 'error');
    setWithRoute(false);
    setPaste(null);
    setReview(r);
  };

  const apply = async (r: Review) => {
    await applyTuning(r.tuning, withRoute ? r.route : undefined);
    setReview(null);
    toast(`Tuning "${r.tuning.label}" set: predicted lap ${r.predictedS} s`);
  };

  const undo = async () => {
    if (!s.tuningPrev) return;
    const back = await undoTuning();
    toast(`Back to "${back?.label ?? 'constant speed'}"`);
  };

  const toConstant = async () => {
    const a = lab.settings.auto;
    await lab.setSettings({ auto: { ...a, tuning: undefined, tuningPrev: a.tuning } });
  };

  const best = runs.filter((r) => r.finished && r.tuning.label === base.label).sort((a, b) => a.timeMs - b.timeMs)[0];
  const keepForRace = async () => {
    if (!s.tuning || !best) return;
    await lab.setSettings({ auto: { ...lab.settings.auto, raceTuning: { tuning: s.tuning, lapMs: best.timeMs, at: new Date().toISOString() } } });
    toast(`Kept "${s.tuning.label}" (lap ${s1(best.timeMs)} s) for the race`);
  };
  const takeRaceTuning = async () => {
    const a = lab.settings.auto;
    if (!a.raceTuning) return;
    await lab.setSettings({ auto: { ...a, tuning: a.raceTuning.tuning, tuningPrev: a.tuning ?? constantTuning(a, ids) } });
  };

  const sendRuns = async () => {
    try {
      const { name, bytes } = await lab.exportZip();
      const how = await shareOrDownload(name, bytes);
      if (how === 'downloaded') toast(`Saved ${name}: give it to the engineer (npm run engineer -- ${name})`);
    } catch (err) {
      toast(`Export: ${errorMessage(err)}`, 'error');
    }
  };

  const copyBrief = async () => {
    if (!runs.length) return toast('Drive a lap first.', 'error');
    try {
      const ok = await copyText(briefText(runs));
      toast(ok ? 'Brief copied: paste it into the Claude app, then paste its answer here (Paste plan).' : 'Copy failed', ok ? 'info' : 'error');
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 6 }}>
        <b>Lap tuning: {base.label}</b>
        <span className="muted">predicted lap {profile.predictedS} s</span>
      </div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>section</th><th>straights</th><th>turns</th><th>pred. s</th></tr></thead>
          <tbody>
            {ids.map((id) => {
              const sec = profile.sections.find((x) => x.id === id);
              return (
                <tr key={id}>
                  <td>{id}</td>
                  <td>{current.sections[id]?.straightCmS ?? '–'}</td>
                  <td>{current.sections[id]?.turnCmS ?? '–'}{sec?.floorBinds ? '*' : ''}</td>
                  <td>{sec?.timeS ?? '–'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <small className="hint">
        cm/s. Speeding up {current.accelCmS2}, braking {current.decelCmS2}, grip {current.latAccelCmS2} cm/s²; steering {current.settleCm ?? s.settleCm} cm.
        {' '}* the robot can't take this turn slower (its inner wheel must keep turning).
      </small>

      {runs.length > 0 && (
        <div className="table-wrap" style={{ marginTop: 8 }}>
          <table>
            <thead><tr><th>run</th><th>tuning</th><th>result</th><th>pred.</th><th>worst off</th><th>lines</th></tr></thead>
            <tbody>
              {runs.slice(-8).map((r) => {
                const worst = Math.max(0, ...r.sections.map((x) => Math.max(x.straight?.maxOffCm ?? 0, x.turn?.maxOffCm ?? 0)));
                return (
                  <tr key={r.id}>
                    <td>{r.n}</td>
                    <td>{r.tuning.label}</td>
                    <td className={r.finished ? '' : 'bad-text'}>{r.finished ? `${s1(r.timeMs)} s` : `stop ${r.stop?.section ?? '?'}`}</td>
                    <td>{r.predictedS ?? '–'}</td>
                    <td>{worst} cm</td>
                    <td>{r.lineEvents}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {review ? (
        <ReviewBox r={review} current={profile.predictedS} withRoute={withRoute} setWithRoute={setWithRoute} onApply={() => void apply(review)} onDiscard={() => setReview(null)} disabled={disabled} />
      ) : (
        <>
          <div className="row" style={{ gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
            <button className="btn btn-small btn-primary" disabled={disabled || !runs.length} onClick={quick}>Quick tune</button>
            <button className="btn btn-small" onClick={() => void sendRuns()}>Send runs to the engineer</button>
            <button className="btn btn-small" disabled={disabled} onClick={() => fileRef.current?.click()}>Load plan</button>
            <button className="btn btn-small" disabled={disabled} onClick={() => setPaste(paste === null ? '' : null)}>Paste plan</button>
            <button className="btn btn-small" disabled={!runs.length} onClick={() => void copyBrief()}>Copy brief for the Claude app</button>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept=".json,application/json,text/plain"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) void f.text().then(loadPlan).catch((err) => toast(errorMessage(err), 'error'));
            }}
          />
          {paste !== null && (
            <div style={{ marginTop: 8 }}>
              <textarea rows={5} style={{ width: '100%' }} placeholder="Paste the engineer's plan (JSON) or the Claude app's answer" value={paste} onChange={(e) => setPaste(e.target.value)} />
              <button className="btn btn-small btn-primary" disabled={!paste.trim()} onClick={() => loadPlan(paste)}>Read plan</button>
            </div>
          )}
          <div className="row" style={{ gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
            <button className="btn btn-small" disabled={disabled || !s.tuningPrev} onClick={() => void undo()}>Undo ({s.tuningPrev?.label ?? '–'})</button>
            {s.tuning && <button className="btn btn-small" disabled={disabled} onClick={() => void toConstant()}>Constant speed</button>}
            {s.tuning && best && <button className="btn btn-small" disabled={disabled} onClick={() => void keepForRace()}>Keep for the race ({s1(best.timeMs)} s)</button>}
            {s.raceTuning && s.raceTuning.tuning.label !== s.tuning?.label && (
              <button className="btn btn-small" disabled={disabled} onClick={() => void takeRaceTuning()}>Use race tuning ({s.raceTuning.tuning.label}, {s1(s.raceTuning.lapMs)} s)</button>
            )}
          </div>
          <small className="hint">
            Drive a lap, then <b>Quick tune</b> (rules, on the phone) or ask the race engineer: <b>Send runs to the engineer</b> and run
            {' '}<code>npm run engineer -- &lt;the zip&gt;</code> on the laptop (Claude, with your login), then <b>Load plan</b>. No laptop:
            {' '}<b>Copy brief</b>, paste it into the Claude app, and paste its answer back. Every change shows here before it applies; raises are
            {' '}capped at 25 % a lap. For the final, keep the best tuning that finished cleanly.
          </small>
        </>
      )}
    </div>
  );
}

function ReviewBox({ r, current, withRoute, setWithRoute, onApply, onDiscard, disabled }: {
  r: Review; current: number; withRoute: boolean; setWithRoute: (v: boolean) => void; onApply: () => void; onDiscard: () => void; disabled: boolean;
}) {
  return (
    <div style={{ marginTop: 10, borderTop: '1px solid var(--line)', paddingTop: 8 }}>
      <b>{r.title}</b> · predicted lap <b>{r.predictedS} s</b> (now {current} s)
      {r.summary && <p style={{ margin: '6px 0' }}>{r.summary}</p>}
      {r.diff.length ? (
        <div className="table-wrap">
          <table>
            <thead><tr><th>change</th><th>now</th><th>next</th></tr></thead>
            <tbody>{r.diff.map((d) => <tr key={d.key}><td>{d.key}</td><td>{d.from ?? '–'}</td><td>{d.to ?? '–'}</td></tr>)}</tbody>
          </table>
        </div>
      ) : <p className="muted">No changes to the speeds.</p>}
      {r.notes.length > 0 && <ul style={{ margin: '6px 0', paddingLeft: 18 }}>{r.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
      {r.watch.length > 0 && <div className="hint">Watch: {r.watch.join(' · ')}</div>}
      {r.warnings.map((w, i) => <div key={i} className="warn-text">{w}</div>)}
      {(r.routeApplied.length > 0 || r.routeRejected.length > 0) && (
        <div style={{ marginTop: 6 }}>
          {r.routeApplied.length > 0 && (
            <label className="row" style={{ flexWrap: 'nowrap', gap: 6 }}>
              <input type="checkbox" checked={withRoute} onChange={(e) => setWithRoute(e.target.checked)} />
              <span>
                Also change the track code: {r.routeApplied.map((e) => `${e.section}/${e.part} ${e.lengthCm !== undefined ? `length ${e.lengthCm}` : `radius ${e.radiusCm}`} cm`).join(', ')}
                {r.closure ? ` (lap closes within ${r.closure.after} cm, now ${r.closure.before})` : ''}
              </span>
            </label>
          )}
          {r.routeRejected.map((x, i) => <div key={i} className="warn-text">Track edit {x.edit.section}/{x.edit.part} left out: {x.why}</div>)}
        </div>
      )}
      <div className="row" style={{ gap: 6, marginTop: 8 }}>
        <button className="btn btn-ok" disabled={disabled} onClick={onApply}>Apply</button>
        <button className="btn" onClick={onDiscard}>Discard</button>
      </div>
    </div>
  );
}
