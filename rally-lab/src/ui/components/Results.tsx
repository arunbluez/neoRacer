import type { ResultTable, TestSummary } from '../../core/tests/types';

const show = (v: unknown) => (v === null || v === undefined || (typeof v === 'number' && !Number.isFinite(v)) ? '–' : typeof v === 'boolean' ? (v ? 'yes' : 'no') : String(v));

export function TableView({ t }: { t: ResultTable }) {
  return (
    <div className="table-wrap" style={{ marginTop: 8 }}>
      {t.title && <div className="muted" style={{ fontSize: 13, marginBottom: 4 }}>{t.title}</div>}
      <table>
        <thead>
          <tr>{t.columns.map((c) => <th key={c}>{c}</th>)}</tr>
        </thead>
        <tbody>
          {t.rows.slice(0, 60).map((r, i) => (
            <tr key={i}>{r.map((v, j) => <td key={j}>{show(v)}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function SummaryView({ s }: { s: TestSummary }) {
  return (
    <div>
      <div className="kv">
        {Object.entries(s.values).map(([k, v]) => (
          <span key={k} style={{ display: 'contents' }}>
            <span>{k}</span>
            <span className="mono">{show(v)}</span>
          </span>
        ))}
      </div>
      {s.notes.map((n, i) => <p key={i} style={{ margin: '6px 0' }}>{n}</p>)}
      {s.tables.map((t, i) => <TableView key={i} t={t} />)}
    </div>
  );
}
