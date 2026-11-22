// Span detail with the THREE attribute layers rendered separately.
// Resource / Instrumentation Scope / Span attributes never share a table,
// so a key repeated across layers can never appear to overwrite another.

function formatValue(attr) {
  if (attr.type === 'array') {
    return `[${(attr.value ?? []).map((v) => formatValue(v)).join(', ')}]`;
  }
  if (attr.type === 'kvlist') {
    return `{${(attr.value ?? []).map((kv) => `${kv.key}=${formatValue(kv)}`).join(', ')}}`;
  }
  if (attr.type === 'bytes') return `b64:${attr.value}`;
  return String(attr.value);
}

function AttrTable({ attributes, emptyHint }) {
  if (!attributes?.length) return <div className="muted small-text">{emptyHint}</div>;
  return (
    <table className="attr-table">
      <thead>
        <tr>
          <th style={{ width: '38%' }}>key</th>
          <th style={{ width: '14%' }}>type</th>
          <th>value</th>
        </tr>
      </thead>
      <tbody>
        {attributes.map((attr, i) => (
          <tr
            key={`${attr.key}-${i}`}
            className={[attr.action === 'redact' ? 'redacted' : '', attr.action === 'drop' ? 'dropped' : '']
              .filter(Boolean)
              .join(' ')}
          >
            <td className="key">{attr.key}</td>
            <td className="muted">{attr.type}</td>
            <td className="value val">
              {attr.action === 'redact' ? attr.value : formatValue(attr)}
              {attr.action === 'drop' && <span className="badge warn" style={{ marginLeft: 8 }}>dropped by rule</span>}
              {attr.action === 'redact' && <span className="badge error" style={{ marginLeft: 8 }}>redacted</span>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function LayerCard({ title, tag, attrs, emptyHint, meta }) {
  return (
    <div className="layer-card">
      <h4>
        <span className="layer-tag">{tag}</span>
        <span>{title}</span>
        {meta && <span className="muted small-text">{meta}</span>}
      </h4>
      <AttrTable attributes={attrs} emptyHint={emptyHint} />
    </div>
  );
}

export default function SpanDetail({ span }) {
  if (!span) return <div className="empty">Select a span to inspect its three attribute layers.</div>;
  return (
    <div>
      <div className="flex flex-wrap mb-16">
        <strong style={{ fontSize: 15 }}>{span.name}</strong>
        <span className="badge">{span.kindName}</span>
        <span
          className={`badge ${span.status?.code === 2 ? 'error' : span.status?.code === 1 ? 'good' : ''}`}
        >
          {span.status?.codeName ?? 'STATUS_CODE_UNSET'}
        </span>
        {span.transport && <span className={`badge ${span.transport}`}>{span.transport}</span>}
        {span.issues?.map((issue) => (
          <span key={issue} className="badge error">
            {issue}
          </span>
        ))}
      </div>

      <div className="detail-grid">
        <div>
          <LayerCard
            title="Resource attributes"
            tag="resource"
            attrs={span.resource?.attributes}
            emptyHint="no resource attributes"
            meta={span.resourceSchemaUrl ? `schema: ${span.resourceSchemaUrl}` : null}
          />
          <LayerCard
            title="Instrumentation scope attributes"
            tag="scope"
            attrs={span.scope?.attributes}
            emptyHint="no scope attributes"
            meta={[span.scopeName, span.scopeVersion].filter(Boolean).join(' @ ')}
          />
          <LayerCard
            title="Span attributes"
            tag="span"
            attrs={span.attributes}
            emptyHint="no span attributes"
            meta={`droppedAttributesCount=${span.droppedAttributesCount}`}
          />
        </div>

        <div>
          <div className="layer-card">
            <h4>Identity & timing</h4>
            <table className="attr-table">
              <tbody>
                <tr><td className="key">traceId</td><td className="val">{span.traceId}</td></tr>
                <tr><td className="key">spanId</td><td className="val">{span.spanId}</td></tr>
                <tr><td className="key">parentSpanId</td>
                  <td className="val">
                    {span.parentSpanId || '(root)'}
                    {span.issues?.includes('EXTERNAL_PARENT') && (
                      <span className="badge info" style={{ marginLeft: 8 }}>external — not in batch</span>
                    )}
                  </td>
                </tr>
                <tr><td className="key">start</td><td className="val">{span.start.iso} ({span.start.unixNano})</td></tr>
                <tr><td className="key">end</td><td className="val">{span.end.iso} ({span.end.unixNano})</td></tr>
                <tr><td className="key">duration</td><td className="val">{span.durationNano} ns</td></tr>
                <tr><td className="key">traceState / flags</td><td className="val">{span.traceState || '-'} / {span.flags}</td></tr>
                <tr><td className="key">duplicate instances</td><td className="val">{span.duplicateInstances ?? 1}</td></tr>
              </tbody>
            </table>
          </div>

          {span.status?.message && (
            <div className="layer-card">
              <h4><span className="badge error">error origin</span> Status message</h4>
              <pre className="raw">{span.status.message}</pre>
            </div>
          )}

          <div className="layer-card">
            <h4>Events ({span.events?.length ?? 0})</h4>
            {!span.events?.length && <div className="muted small-text">no events</div>}
            {span.events?.map((ev, i) => (
              <div key={i} style={{ marginBottom: 8 }}>
                <div className="flex">
                  <strong className="small-text">{ev.name}</strong>
                  <span className="muted small-text mono">{ev.timeUnixNano.iso}</span>
                </div>
                <AttrTable attributes={ev.attributes} emptyHint="" />
              </div>
            ))}
          </div>

          <div className="layer-card">
            <h4>Links ({span.links?.length ?? 0}) — associations, not parent edges</h4>
            {!span.links?.length && <div className="muted small-text">no links</div>}
            {span.links?.map((link, i) => (
              <div key={i} className="link-row">
                <span className="link-arrow">↗</span>
                <div>
                  <div className="mono small-text">trace {link.traceId}</div>
                  <div className="mono small-text">span {link.spanId}</div>
                  <AttrTable attributes={link.attributes} emptyHint="" />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
