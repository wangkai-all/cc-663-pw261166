export default function TraceList({ traces, selectedId, onSelect, loading, onRefresh, onClear, page, onPage, health }) {
  return (
    <aside className="sidebar">
      <h1>OTLP Trace Viewer</h1>
      <div className="subtitle">JSON + Protobuf receiver · layered attributes · conflict-aware</div>
      <div className="nav-row">
        <button className={page === 'traces' ? 'primary' : ''} onClick={() => onPage('traces')}>Traces</button>
        <button className={page === 'rules' ? 'primary' : ''} onClick={() => onPage('rules')}>Rules</button>
      </div>
      <div className="nav-row">
        <button onClick={onRefresh} disabled={loading}>refresh</button>
        <button className="danger" onClick={onClear}>clear</button>
      </div>
      <div className="badge mb-16" style={{ marginBottom: 12 }}>{health}</div>
      <h2>Traces ({traces.length})</h2>
      {!traces.length && <div className="empty">No traces yet.<br />Run the demo sender to populate.</div>}
      {traces.map((tr) => (
        <div
          key={tr.traceId}
          className={`trace-card ${selectedId === tr.traceId ? 'selected' : ''}`}
          onClick={() => onSelect(tr.traceId)}
        >
          <div className="trace-name flex flex-wrap">
            {tr.services.join(' → ') || 'unknown services'}
            {tr.errorCount > 0 && <span className="badge error">{tr.errorCount} error</span>}
            {tr.issueCount > 0 && <span className="badge error">{tr.issueCount} issue</span>}
            {tr.warningCount > 0 && <span className="badge warn">{tr.warningCount} warn</span>}
          </div>
          <div className="trace-meta">
            <span>{tr.spanCount} spans</span>
            <span>{tr.durationMs}ms</span>
            {tr.transports.map((t) => (
              <span key={t} className={`badge ${t}`}>{t}</span>
            ))}
          </div>
          <div className="trace-id mono">{tr.traceId}</div>
        </div>
      ))}
    </aside>
  );
}
