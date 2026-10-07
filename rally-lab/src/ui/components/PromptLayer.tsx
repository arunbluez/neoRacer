import { useState } from 'react';
import { useApp, type OpenPrompt } from '../appStore';
import { getLab } from '../lab';

function PromptCard({ p, banner }: { p: OpenPrompt; banner?: boolean }) {
  const [values, setValues] = useState<Record<string, string>>(() => {
    const v: Record<string, string> = {};
    for (const f of p.req.fields ?? []) {
      const d = 'default' in f ? f.default : undefined;
      v[f.key] = d === undefined ? '' : String(d);
    }
    return v;
  });
  const [, force] = useState(0);
  const buttons = p.req.buttons ?? ['Next'];
  const press = (button: string) => {
    force((n) => n + 1);
    const out: Record<string, number | string> = {};
    for (const f of p.req.fields ?? []) {
      const raw = values[f.key] ?? '';
      out[f.key] = f.type === 'number' ? (raw.trim() === '' ? NaN : Number(raw)) : raw;
    }
    p.resolve({ button, values: out });
  };
  return (
    <div className={banner ? 'banner' : 'prompt-card'}>
      <div className="prompt-title">{p.req.title}</div>
      {p.req.text && <div className="prompt-text">{p.req.text}</div>}
      {(p.req.fields ?? []).map((f) => (
        <label key={f.key} className="field">
          <span>{f.label}{'unit' in f && f.unit ? ` (${f.unit})` : ''}</span>
          {f.type === 'select' ? (
            <select value={values[f.key]} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}>
              {f.options.map((o) => <option key={o}>{o}</option>)}
            </select>
          ) : (
            <input
              inputMode={f.type === 'number' ? 'decimal' : 'text'}
              value={values[f.key]}
              onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
            />
          )}
          {'hint' in f && f.hint && <small className="hint">{f.hint}</small>}
        </label>
      ))}
      <div className="prompt-buttons">
        {buttons.map((b, i) => (
          <button key={b} className={i === 0 ? 'btn btn-primary btn-big' : 'btn btn-big'} onClick={() => press(b)}>
            {b}{p.req.live && p.taps.filter((t) => t.button === b).length > 0 ? ` (${p.taps.filter((t) => t.button === b).length})` : ''}
          </button>
        ))}
        {!banner && (
          <button className="btn btn-danger btn-big" onClick={() => getLab().stopAll('prompt abort')}>Abort</button>
        )}
      </div>
    </div>
  );
}

export function PromptLayer() {
  const prompts = useApp((s) => s.prompts);
  const dialogs = prompts.filter((p) => !p.req.banner);
  const top = dialogs[dialogs.length - 1];
  if (!top) return null;
  return (
    <div className="prompt-overlay">
      <PromptCard key={top.id} p={top} />
    </div>
  );
}

export function BannerLayer() {
  const prompts = useApp((s) => s.prompts);
  useApp((s) => s.version);
  const banners = prompts.filter((p) => p.req.banner);
  if (banners.length === 0) return null;
  return (
    <div className="banners">
      {banners.map((p) => <PromptCard key={p.id} p={p} banner />)}
    </div>
  );
}

export function Toast() {
  const toast = useApp((s) => s.toast);
  if (!toast) return null;
  return <div className={`toast toast-${toast.kind}`}>{toast.text}</div>;
}
