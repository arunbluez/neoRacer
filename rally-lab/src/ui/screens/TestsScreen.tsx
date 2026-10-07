import { useEffect, useState } from 'react';
import { ALL_TESTS, testById } from '../../core/tests/registry';
import { defaultParams, type Params, type TestDefinition, type TestGroup, type TestRun } from '../../core/tests/types';
import { errorMessage } from '../../core/util/async';
import { useApp } from '../appStore';
import { ParamForm } from '../components/ParamForm';
import { SummaryView, TableView } from '../components/Results';
import { fmt, useLabVersion, useTicker } from '../hooks';
import { getLab, labUi } from '../lab';

const GROUPS: TestGroup[] = ['Link', 'Sensors', 'Motion', 'Camera'];
const PARAMS_KEY = 'rally-lab.testParams.v1';

function loadParams(def: TestDefinition): Params {
  try {
    const all = JSON.parse(localStorage.getItem(PARAMS_KEY) ?? '{}') as Record<string, Params>;
    return { ...defaultParams(def), ...(all[def.id] ?? {}) };
  } catch {
    return defaultParams(def);
  }
}

function saveParams(id: string, p: Params) {
  try {
    const all = JSON.parse(localStorage.getItem(PARAMS_KEY) ?? '{}') as Record<string, Params>;
    all[id] = p;
    localStorage.setItem(PARAMS_KEY, JSON.stringify(all));
  } catch {
    // ignore
  }
}

function headline(run: TestRun): string {
  if (!run.summary) return run.error ?? run.status;
  const v = Object.entries(run.summary.values).slice(0, 3).map(([k, x]) => `${k} ${typeof x === 'number' ? fmt(x, 1) : String(x)}`);
  return v.join(' · ');
}

async function confirmSetup(def: TestDefinition): Promise<boolean> {
  const lab = getLab();
  const lines: string[] = [def.setup];
  if (def.needs.wheelsUp) lines.push('Motors will spin: put the robot on a stand with the wheels in the air.');
  if (def.needs.motion) lines.push('The robot will drive: put it on the mat with clear space. STOP aborts at any time.');
  if (def.needs.tracking && !lab.pose?.active) lines.push('Camera tracking is off: you will be asked to measure by hand.');
  const h = labUi.prompt({ title: `${def.id} ${def.title}`, text: lines.join('\n\n'), buttons: ['Start', 'Cancel'] });
  const r = await h.result;
  return r.button === 'Start';
}

function TestCard({ def, onBack }: { def: TestDefinition; onBack: () => void }) {
  useLabVersion();
  useTicker(250);
  const lab = getLab();
  const toast = useApp((s) => s.showToast);
  const [params, setParams] = useState<Params>(() => loadParams(def));
  const [runs, setRuns] = useState<TestRun[]>([]);
  const state = lab.runner.state;
  const runningThis = state.run?.testId === def.id;
  const busy = lab.runner.running;
  const connected = lab.link.connected;

  useEffect(() => {
    setRuns(lab.runner.history.filter((r) => r.testId === def.id));
  }, [lab.runner.history, lab.runner.history.length, def.id, state.run]);

  const latest = runs[0];

  const start = async (p: Params) => {
    if (def.needs.robot && !connected) {
      toast('Connect a robot first (or turn on the mock in Data → Settings).', 'error');
      return;
    }
    if (!(await confirmSetup(def))) return;
    saveParams(def.id, p);
    try {
      const run = await lab.runner.run(def, p);
      if (run.status === 'error') toast(`${def.id} failed: ${run.error}`, 'error');
      else if (run.status === 'aborted') toast(`${def.id} aborted: ${run.error}`, 'error');
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };

  const saveProfile = async (run: TestRun) => {
    const patch = run.summary?.profilePatch;
    if (!patch || !lab.profile) return;
    // Merge map-like fields instead of replacing them.
    const merged = { ...patch };
    if (patch.surfaces) merged.surfaces = { ...(lab.profile.surfaces ?? {}), ...patch.surfaces };
    if (patch.blocking) merged.blocking = { ...patch.blocking };
    await lab.updateProfile(merged);
    toast(`Saved to profile ${lab.profile.robotId}: ${Object.keys(patch).join(', ')}`);
  };

  const agg = def.aggregate?.(lab.runner.history.filter((r) => r.testId === def.id));

  return (
    <div>
      <button className="btn btn-small" onClick={onBack}>← All tests</button>
      <h2 style={{ marginTop: 10 }}>{def.id} {def.title}</h2>
      <div className="card">
        <p style={{ marginTop: 0 }}>{def.setup}</p>
        <div className="row" style={{ marginBottom: 8 }}>
          {def.needs.wheelsUp && <span className="badge badge-busy">wheels up</span>}
          {def.needs.motion && <span className="badge badge-busy">on the mat</span>}
          {def.needs.tracking && <span className="badge">camera {lab.pose?.active ? 'tracking' : 'off → manual'}</span>}
          <span className="badge">max {Math.round(def.maxMs / 1000)} s</span>
        </div>
        <ParamForm defs={def.params} value={params} onChange={setParams} disabled={busy} />
        {runningThis ? (
          <div>
            <div className="progress"><div style={{ width: `${(state.progress.fraction * 100).toFixed(0)}%` }} /></div>
            <div className="row-between" style={{ marginTop: 6 }}>
              <span className="muted">{state.progress.text ?? 'running…'}</span>
              <button className="btn btn-danger" onClick={() => lab.stopAll(`abort ${def.id}`)}>Abort</button>
            </div>
          </div>
        ) : (
          <div className="row">
            <button className="btn btn-primary btn-big" disabled={busy} onClick={() => void start(params)}>Run</button>
            {latest && (
              <button className="btn btn-big" disabled={busy} onClick={() => { setParams(latest.params); void start(latest.params); }}>
                Run again
              </button>
            )}
          </div>
        )}
        {busy && !runningThis && <p className="warn-text">{state.run?.testId} is running.</p>}
      </div>

      {latest && (
        <div className="card">
          <div className="row-between">
            <h3 style={{ margin: 0 }}>Result · {latest.status}</h3>
            <span className="faint mono" style={{ fontSize: 11 }}>{latest.runId}</span>
          </div>
          {latest.error && <p className="bad-text">{latest.error}</p>}
          {latest.summary && <SummaryView s={latest.summary} />}
          <div className="row" style={{ marginTop: 10 }}>
            {latest.summary?.profilePatch && lab.profile && (
              <button className="btn btn-ok" onClick={() => void saveProfile(latest)}>Save to profile</button>
            )}
            {latest.summary?.settingsPatch && (
              <button className="btn" onClick={() => void lab.setSettings(latest.summary!.settingsPatch!).then(() => toast('Settings updated'))}>
                Apply to settings
              </button>
            )}
          </div>
        </div>
      )}

      {agg && runs.length > 1 && (
        <div className="card">
          <TableView t={agg} />
        </div>
      )}

      {runs.length > 0 && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>History (this session)</h3>
          {runs.map((r) => (
            <div key={r.runId} style={{ borderBottom: '1px solid var(--line)', padding: '6px 0' }}>
              <div className="row-between">
                <span className={r.status === 'done' ? 'ok-text' : 'warn-text'}>{r.status}</span>
                <span className="faint" style={{ fontSize: 12 }}>{new Date(r.startedAt).toLocaleTimeString()}</span>
              </div>
              <div className="muted" style={{ fontSize: 13 }}>{headline(r)}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function TestsScreen() {
  useLabVersion();
  const lab = getLab();
  const selected = useApp((s) => s.selectedTest ?? lab.runner.state.run?.testId ?? null);
  const setSelected = useApp((s) => s.setSelectedTest);
  const def = selected ? testById(selected) : undefined;
  if (def) return <TestCard key={def.id} def={def} onBack={() => setSelected(null)} />;
  const last = (id: string) => lab.runner.history.find((r) => r.testId === id);
  return (
    <div>
      {GROUPS.map((g) => {
        const tests = ALL_TESTS.filter((t) => t.group === g);
        if (tests.length === 0) return null;
        return (
          <div key={g}>
            <h3>{g}</h3>
            {tests.map((t) => {
              const r = last(t.id);
              return (
                <button key={t.id} className="card btn-block" style={{ textAlign: 'left', display: 'block', minHeight: 56 }} onClick={() => setSelected(t.id)}>
                  <div className="row-between">
                    <span><b>{t.id}</b> {t.title}</span>
                    {r && <span className={r.status === 'done' ? 'ok-text' : 'warn-text'} style={{ fontSize: 12 }}>{r.status}</span>}
                  </div>
                  {r && <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>{headline(r)}</div>}
                </button>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
