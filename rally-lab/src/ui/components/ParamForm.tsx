import type { ParamDef, Params } from '../../core/tests/types';

export function ParamForm({ defs, value, onChange, disabled }: { defs: ParamDef[]; value: Params; onChange: (p: Params) => void; disabled?: boolean }) {
  const set = (k: string, v: Params[string]) => onChange({ ...value, [k]: v });
  return (
    <div>
      {defs.map((d) => {
        const v = value[d.key] ?? d.default;
        switch (d.type) {
          case 'number':
            return (
              <label key={d.key} className="field">
                <span>{d.label}{d.unit ? ` (${d.unit})` : ''}</span>
                <input inputMode="decimal" disabled={disabled} value={String(v)} onChange={(e) => set(d.key, e.target.value === '' ? d.default : Number(e.target.value))} />
                {d.help && <small className="hint">{d.help}</small>}
              </label>
            );
          case 'numbers':
            return (
              <label key={d.key} className="field">
                <span>{d.label}{d.unit ? ` (${d.unit})` : ''}</span>
                <input
                  inputMode="text"
                  disabled={disabled}
                  defaultValue={(v as number[]).join(', ')}
                  onBlur={(e) => set(d.key, e.target.value.split(/[ ,;]+/).map(Number).filter((x) => Number.isFinite(x)))}
                />
                {d.help && <small className="hint">{d.help}</small>}
              </label>
            );
          case 'select':
            return (
              <label key={d.key} className="field">
                <span>{d.label}</span>
                <select disabled={disabled} value={String(v)} onChange={(e) => set(d.key, e.target.value)}>
                  {d.options.map((o) => <option key={o}>{o}</option>)}
                </select>
              </label>
            );
          case 'multi': {
            const cur = new Set(v as string[]);
            return (
              <div key={d.key} className="field">
                <span>{d.label}</span>
                <div className="row">
                  {d.options.map((o) => (
                    <button
                      key={o}
                      type="button"
                      disabled={disabled}
                      className={`chip mono ${cur.has(o) ? 'chip-on' : ''}`}
                      onClick={() => {
                        const n = new Set(cur);
                        if (n.has(o)) n.delete(o);
                        else n.add(o);
                        set(d.key, d.options.filter((x) => n.has(x)));
                      }}
                    >
                      {o}
                    </button>
                  ))}
                </div>
              </div>
            );
          }
          case 'text':
            return (
              <label key={d.key} className="field">
                <span>{d.label}</span>
                <input disabled={disabled} value={String(v)} onChange={(e) => set(d.key, e.target.value)} />
              </label>
            );
          case 'boolean':
            return (
              <label key={d.key} className="row" style={{ marginBottom: 10 }}>
                <input type="checkbox" disabled={disabled} checked={Boolean(v)} onChange={(e) => set(d.key, e.target.checked)} />
                <span>{d.label}</span>
              </label>
            );
        }
      })}
    </div>
  );
}
