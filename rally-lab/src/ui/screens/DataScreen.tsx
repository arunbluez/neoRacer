import { useCallback, useEffect, useState } from 'react';
import { copyText, shareOrDownload } from '../../adapters/export/share';
import { storageEstimate } from '../../adapters/storage/DexieLogStore';
import type { SessionSummary } from '../../core/log/session';
import type { RobotProfile } from '../../core/model/profile';
import { DEFAULT_SETTINGS, type Settings } from '../../core/settings';
import { errorMessage } from '../../core/util/async';
import { useApp } from '../appStore';
import { useLabVersion } from '../hooks';
import { getLab, labUi, store } from '../lab';

const mb = (b: number) => `${(b / 1024 / 1024).toFixed(1)} MB`;

async function confirm(title: string, text: string, yes = 'Delete'): Promise<boolean> {
  const r = await labUi.prompt({ title, text, buttons: [yes, 'Cancel'] }).result;
  return r.button === yes;
}

function Sessions() {
  const lab = getLab();
  const toast = useApp((s) => s.showToast);
  const [list, setList] = useState<SessionSummary[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [usage, setUsage] = useState<{ usage: number; quota: number } | null>(null);
  const refresh = useCallback(() => {
    void store.listSessions().then(setList);
    void storageEstimate().then(setUsage);
  }, []);
  useEffect(refresh, [refresh, lab.header.id]);

  const act = async (id: string, what: 'zip' | 'report' | 'delete') => {
    setBusy(`${id}:${what}`);
    try {
      if (what === 'zip') {
        const z = await lab.exportZip(id);
        const how = await shareOrDownload(z.name, z.bytes);
        if (how !== 'cancelled') toast(`${z.name} ${how} (${mb(z.bytes.length)})`);
      } else if (what === 'report') {
        const b = await lab.bundle(id);
        toast((await copyText(b.report)) ? 'report.md copied' : 'Copy failed', 'info');
      } else if (await confirm('Delete session?', `${id} and all its events and test runs will be removed from this phone.`)) {
        if (id === lab.header.id) await lab.newSession(lab.profile?.robotId);
        await store.deleteSession(id);
        toast('Session deleted');
      }
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setBusy(null);
      refresh();
    }
  };

  const pct = usage && usage.quota ? (100 * usage.usage) / usage.quota : 0;
  return (
    <div>
      <div className="card">
        <div className="row-between">
          <h3 style={{ margin: 0 }}>Storage</h3>
          <span className={pct > 80 ? 'bad-text' : 'muted'}>{usage ? `${mb(usage.usage)} of ${mb(usage.quota)} (${pct.toFixed(1)} %)` : 'unknown'}</span>
        </div>
        {pct > 80 && <p className="bad-text">Storage above 80 %: export and delete old sessions.</p>}
        <div className="progress" style={{ marginTop: 8 }}><div style={{ width: `${Math.min(100, pct)}%`, background: pct > 80 ? 'var(--bad)' : undefined }} /></div>
        <div className="row" style={{ marginTop: 10 }}>
          <button className="btn btn-primary btn-big" disabled={!!busy} onClick={() => void act(lab.header.id, 'zip')}>Export this session</button>
          <button className="btn btn-big" disabled={!!busy} onClick={() => void act(lab.header.id, 'report')}>Copy report</button>
        </div>
        <button
          className="btn btn-block"
          style={{ marginTop: 8 }}
          disabled={!!busy}
          onClick={async () => {
            setBusy('all');
            try {
              const z = await lab.exportAllZip();
              const how = await shareOrDownload(z.name, z.bytes);
              if (how !== 'cancelled') toast(`${z.name} ${how} (${mb(z.bytes.length)})`);
            } catch (err) {
              toast(errorMessage(err), 'error');
            } finally {
              setBusy(null);
            }
          }}
        >
          Export all sessions
        </button>
      </div>
      <h3>Sessions</h3>
      {list.map((s) => (
        <div key={s.id} className="card" style={{ borderColor: s.id === lab.header.id ? 'var(--accent)' : undefined }}>
          <div className="row-between">
            <span className="mono" style={{ fontSize: 13 }}>{s.id}</span>
            {s.id === lab.header.id && <span className="badge badge-test">current</span>}
          </div>
          <div className="muted" style={{ fontSize: 13 }}>
            {new Date(s.startedAt).toLocaleString()} · {s.robot?.id ?? 'no robot'} · {s.transport} · {s.eventCount} events · {s.testRunCount} test runs
          </div>
          <div className="row" style={{ marginTop: 8 }}>
            <button className="btn btn-small" disabled={!!busy} onClick={() => void act(s.id, 'zip')}>{busy === `${s.id}:zip` ? '…' : 'Export'}</button>
            <button className="btn btn-small" disabled={!!busy} onClick={() => void act(s.id, 'report')}>Copy report</button>
            <span className="spacer" />
            <button className="btn btn-small" disabled={!!busy} onClick={() => void act(s.id, 'delete')}>Delete</button>
          </div>
        </div>
      ))}
    </div>
  );
}

function Profiles() {
  const lab = getLab();
  const toast = useApp((s) => s.showToast);
  const [list, setList] = useState<RobotProfile[]>([]);
  const [edit, setEdit] = useState<RobotProfile | null>(null);
  const refresh = useCallback(() => void store.listProfiles().then(setList), []);
  useEffect(refresh, [refresh, lab.profile?.updatedAt]);

  const save = async (p: RobotProfile) => {
    if (lab.profile?.robotId === p.robotId) await lab.updateProfile(p);
    else await store.putProfile({ ...p, updatedAt: new Date().toISOString() });
    setEdit(null);
    refresh();
    toast(`Profile ${p.robotId} saved`);
  };

  return (
    <div>
      <h3>Robot profiles</h3>
      {list.length === 0 && <p className="muted">Profiles are created when a robot connects.</p>}
      {list.map((p) => (
        <div key={p.robotId} className="card">
          {edit?.robotId === p.robotId ? (
            <div>
              <b>{p.robotId}</b>
              <label className="field" style={{ marginTop: 8 }}>
                <span>Trim (right wheel, %) — {(edit.trim * 100).toFixed(1)}</span>
                <input type="range" min={-20} max={20} step={0.5} value={edit.trim * 100} onChange={(e) => setEdit({ ...edit, trim: Number(e.target.value) / 100 })} />
              </label>
              <label className="row" style={{ marginBottom: 10 }}>
                <input type="checkbox" checked={edit.compassCalibrated} onChange={(e) => setEdit({ ...edit, compassCalibrated: e.target.checked })} />
                <span>Compass calibrated (I did the tilt-to-fill-screen once)</span>
              </label>
              <label className="field">
                <span>MAC (from the label)</span>
                <input value={edit.mac ?? ''} onChange={(e) => setEdit({ ...edit, mac: e.target.value || undefined })} />
              </label>
              <label className="field">
                <span>Notes</span>
                <textarea rows={3} value={edit.notes} onChange={(e) => setEdit({ ...edit, notes: e.target.value })} />
              </label>
              <label className="field">
                <span>Full profile (JSON)</span>
                <textarea
                  rows={8}
                  className="mono"
                  style={{ fontSize: 12 }}
                  defaultValue={JSON.stringify(edit, null, 2)}
                  onBlur={(e) => {
                    try {
                      setEdit({ ...(JSON.parse(e.target.value) as RobotProfile), robotId: p.robotId });
                    } catch {
                      toast('Invalid JSON', 'error');
                    }
                  }}
                />
              </label>
              <div className="row">
                <button className="btn btn-primary" onClick={() => void save(edit)}>Save</button>
                <button className="btn" onClick={() => setEdit(null)}>Cancel</button>
                <span className="spacer" />
                <button
                  className="btn"
                  onClick={async () => {
                    if (await confirm('Delete profile?', `All measured values for ${p.robotId} will be lost.`)) {
                      await store.deleteProfile(p.robotId);
                      setEdit(null);
                      refresh();
                    }
                  }}
                >
                  Delete
                </button>
              </div>
            </div>
          ) : (
            <div className="row-between">
              <div>
                <b>{p.robotId}</b> <span className="muted">{p.name}</span>
                <div className="muted" style={{ fontSize: 12 }}>
                  trim {(p.trim * 100).toFixed(1)} % · {p.compassCalibrated ? 'compass ok' : 'compass not calibrated'} · updated {new Date(p.updatedAt).toLocaleString()}
                </div>
              </div>
              <button className="btn btn-small" onClick={() => setEdit(p)}>Edit</button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function NumberSetting({ label, value, unit, onChange, step }: { label: string; value: number; unit?: string; step?: number; onChange: (v: number) => void }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  return (
    <label className="field">
      <span>{label}{unit ? ` (${unit})` : ''}</span>
      <input
        inputMode="decimal"
        step={step}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          const v = Number(text);
          if (Number.isFinite(v)) onChange(v);
          else setText(String(value));
        }}
      />
    </label>
  );
}

function JsonSetting<T>({ label, value, onChange }: { label: string; value: T; onChange: (v: T) => void }) {
  const toast = useApp((s) => s.showToast);
  return (
    <label className="field">
      <span>{label}</span>
      <textarea
        rows={5}
        className="mono"
        style={{ fontSize: 12 }}
        defaultValue={JSON.stringify(value, null, 1)}
        key={JSON.stringify(value)}
        onBlur={(e) => {
          try {
            onChange(JSON.parse(e.target.value) as T);
          } catch {
            toast(`${label}: invalid JSON`, 'error');
          }
        }}
      />
    </label>
  );
}

function SettingsPanel() {
  useLabVersion();
  const lab = getLab();
  const s = lab.settings;
  const set = (patch: Partial<Settings>) => void lab.setSettings(patch);
  return (
    <div>
      <h3>Settings</h3>
      <div className="card">
        <label className="row" style={{ marginBottom: 12 }}>
          <input type="checkbox" checked={s.mockRobot} onChange={(e) => set({ mockRobot: e.target.checked })} />
          <span><b>Mock robot</b> — simulated Cutebot instead of Bluetooth</span>
        </label>
        <NumberSetting label="minWriteGapMs" unit="ms" value={s.minWriteGapMs} onChange={(v) => set({ minWriteGapMs: Math.max(0, v) })} />
        <NumberSetting label="replyTimeoutMs" unit="ms" value={s.replyTimeoutMs} onChange={(v) => set({ replyTimeoutMs: Math.max(50, v) })} />
        <label className="row" style={{ marginBottom: 6 }}>
          <input type="checkbox" checked={s.packWrites} onChange={(e) => set({ packWrites: e.target.checked })} />
          <span>packWrites — join short commands into one write</span>
        </label>
        {s.packWrites && lab.profile?.packingSafe !== true && (
          <p className="warn-text">Packing is not verified for this robot (run T1.4 first).</p>
        )}
        <JsonSetting label="Blocking table overrides (ms by command name)" value={s.blockingOverrides} onChange={(v) => set({ blockingOverrides: v })} />
        <JsonSetting label="Poller presets" value={s.pollerPresets} onChange={(v) => set({ pollerPresets: v })} />
      </div>
      <div className="card">
        <div className="grid2">
          <NumberSetting label="Mat width" unit="cm" value={s.matWidthCm} onChange={(v) => set({ matWidthCm: v })} />
          <NumberSetting label="Mat height" unit="cm" value={s.matHeightCm} onChange={(v) => set({ matHeightCm: v })} />
          <NumberSetting label="Camera width" unit="px" value={s.cameraWidth} onChange={(v) => set({ cameraWidth: v })} />
          <NumberSetting label="Camera height" unit="px" value={s.cameraHeight} onChange={(v) => set({ cameraHeight: v })} />
          <NumberSetting label="Camera fps" value={s.cameraFps} onChange={(v) => set({ cameraFps: v })} />
          <NumberSetting label="Processing width" unit="px" value={s.procWidth} onChange={(v) => set({ procWidth: Math.max(160, Math.round(v)) })} />
          <NumberSetting label="Map mm per px" value={s.mmPerPx} onChange={(v) => set({ mmPerPx: Math.max(1, v) })} />
          <NumberSetting label="Tracking latency" unit="ms" value={s.trackingLatencyMs} onChange={(v) => set({ trackingLatencyMs: v })} />
          <NumberSetting label="Min blob area" unit="px" value={s.minBlobAreaPx} onChange={(v) => set({ minBlobAreaPx: v })} />
        </div>
        <label className="row" style={{ marginBottom: 10 }}>
          <input type="checkbox" checked={s.trackInWorker} onChange={(e) => set({ trackInWorker: e.target.checked })} />
          <span>Track in a Web Worker (real camera; use when T4.4 shows grab + tracking above 15 ms)</span>
        </label>
        <JsonSetting label="Marker A (front)" value={s.markerA} onChange={(v) => set({ markerA: v })} />
        <JsonSetting label="Marker B (centre)" value={s.markerB} onChange={(v) => set({ markerB: v })} />
      </div>
      <div className="card">
        <div className="grid2">
          <NumberSetting label="Drive speed cap" value={s.drive.speedCap} onChange={(v) => set({ drive: { ...s.drive, speedCap: v } })} />
          <NumberSetting label="Drive expo (0..1)" value={s.drive.expo} onChange={(v) => set({ drive: { ...s.drive, expo: v } })} />
          <NumberSetting label="Drive send rate (0 = every write gap)" unit="Hz" value={s.drive.sendHz} onChange={(v) => set({ drive: { ...s.drive, sendHz: v } })} />
          <NumberSetting label="Tilt range" unit="°" value={s.drive.tiltMaxDeg} onChange={(v) => set({ drive: { ...s.drive, tiltMaxDeg: v } })} />
        </div>
      </div>
      <button className="btn btn-block" onClick={() => void lab.setSettings({ ...DEFAULT_SETTINGS, mockRobot: s.mockRobot })}>Reset settings to defaults</button>
    </div>
  );
}

export function DataScreen() {
  const [tab, setTab] = useState<'sessions' | 'profiles' | 'settings'>('sessions');
  return (
    <div>
      <div className="row" style={{ marginBottom: 8 }}>
        {(['sessions', 'profiles', 'settings'] as const).map((t) => (
          <button key={t} className={`chip ${tab === t ? 'chip-on' : ''}`} onClick={() => setTab(t)}>{t}</button>
        ))}
      </div>
      {tab === 'sessions' && <Sessions />}
      {tab === 'profiles' && <Profiles />}
      {tab === 'settings' && <SettingsPanel />}
    </div>
  );
}
