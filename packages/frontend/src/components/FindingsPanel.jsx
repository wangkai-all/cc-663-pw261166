// Findings list: every structural validation issue. Clicking a finding selects
// the offending span so the error can be traced to its exact segment.

const SEVERITY_ICON = {
  error: '⛔',
  warning: '⚠️',
  info: 'ℹ️',
};

export default function FindingsPanel({ analysis, spans, onLocate }) {
  const { findings, externalParents, links } = analysis;
  const spanByFirstId = new Map(spans.map((s) => [s.spanId, s]));

  const locate = (spanId) => {
    const span = spanByFirstId.get(spanId);
    if (span) onLocate(span);
  };

  return (
    <div className="panel">
      <h2 style={{ marginTop: 0 }}>Validation findings ({findings.length})</h2>
      {findings.length === 0 && <div className="muted small-text">No structural issues detected.</div>}
      <div className="findings">
        {findings.map((f, i) => (
          <div key={i} className={`finding ${f.severity}`} onClick={() => f.spanId && locate(f.spanId)}>
            <span aria-hidden>{SEVERITY_ICON[f.severity]}</span>
            <div className="grow">
              <div>{f.message}</div>
              <div className="code">
                {f.code}
                {f.spanId ? ` · span ${f.spanId}` : ''}
                {f.cycle ? ` · cycle ${f.cycle.join(' → ')}` : ''}
              </div>
            </div>
            {f.spanId && spanByFirstId.has(f.spanId) && (
              <button className="small" onClick={(e) => { e.stopPropagation(); locate(f.spanId); }}>
                locate
              </button>
            )}
          </div>
        ))}
      </div>

      <h2>External parents ({externalParents.length})</h2>
      <p className="muted small-text">
        Parent spans outside this receive batch are retained as placeholders — never replaced with
        invented nodes and never treated as roots silently.
      </p>
      {externalParents.map((ep, i) => (
        <div key={i} className="external-row">
          <span className="external-tag">external span</span>
          <span className="mono">{ep.spanId}</span>
          <span>← parent of</span>
          <button className="small" onClick={() => locate(ep.childSpanId)}>
            {ep.childName} <span className="mono">({ep.childSpanId})</span>
          </button>
        </div>
      ))}
      {!externalParents.length && <div className="muted small-text">none</div>}

      <h2>Span links ({links.length})</h2>
      <p className="muted small-text">
        Links are associations to other traces/spans and are drawn separately — never converted
        into parent/child edges.
      </p>
      {links.map((l, i) => (
        <div key={i} className="link-row">
          <span className="link-arrow">↗</span>
          <button className="small" onClick={() => locate(l.fromSpanId)}>{l.fromName}</button>
          <span className="muted">links to</span>
          <span className="mono small-text">
            {l.toTraceId} / {l.toSpanId}
          </span>
        </div>
      ))}
      {!links.length && <div className="muted small-text">none</div>}
    </div>
  );
}
