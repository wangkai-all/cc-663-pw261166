// Trace detail: transport cross-check toggle, span tree + waterfall aligned in
// two columns, three-layer detail, and findings/locate panel.

import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import SpanTree from './SpanTree.jsx';
import SpanDetail from './SpanDetail.jsx';
import FindingsPanel from './FindingsPanel.jsx';
import { Waterfall, buildServiceColorMap } from './Waterfall.jsx';

export default function TraceDetail({ traceId }) {
  const [trace, setTrace] = useState(null);
  const [transport, setTransport] = useState('all');
  const [selectedKey, setSelectedKey] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setTrace(null);
    setSelectedKey(null);
    api
      .getTrace(traceId, transport === 'all' ? undefined : transport)
      .then((data) => {
        if (!cancelled) setTrace(data);
      })
      .catch((e) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [traceId, transport]);

  const colorMap = useMemo(() => (trace ? buildServiceColorMap(trace.spans) : {}), [trace]);

  // DFS order over the backend graph; duplicate extras append at the end so the
  // tree column and the waterfall share one identical row order.
  const orderedKeys = useMemo(() => {
    if (!trace) return [];
    const { graph } = trace.analysis;
    const spanByKey = new Map(trace.spans.map((s) => [s._instanceKey, s]));
    const out = [];
    const seenSpan = new Set();
    const walk = (key) => {
      const span = spanByKey.get(key);
      if (!span || seenSpan.has(span.spanId)) return;
      seenSpan.add(span.spanId);
      out.push(key);
      for (const child of graph.childrenOf[span.spanId] ?? []) walk(child);
    };
    for (const root of graph.roots) {
      if (root.spanId) walk(root.indexKey);
    }
    for (const span of trace.spans) {
      if (!out.includes(span._instanceKey)) out.push(span._instanceKey);
    }
    return out;
  }, [trace]);

  if (error) return <div className="panel badge error">{error}</div>;
  if (!trace) return <div className="empty">Loading trace…</div>;

  const spanByKey = new Map(trace.spans.map((s) => [s._instanceKey, s]));
  const selectedSpan = selectedKey ? spanByKey.get(selectedKey) : null;

  return (
    <div>
      <div className="panel">
        <div className="flex flex-wrap" style={{ justifyContent: 'space-between' }}>
          <div>
            <h2 style={{ margin: 0 }}>
              Trace <span className="mono small-text">{trace.traceId}</span>
            </h2>
            <div className="muted small-text">
              {trace.spans.length} spans · transports stored: {trace.transports.join(', ')}
            </div>
          </div>
          <div className="transport-toggle" role="group" aria-label="transport filter">
            <button className={transport === 'all' ? 'active' : ''} onClick={() => setTransport('all')}>
              all
            </button>
            {trace.transports.map((t) => (
              <button key={t} className={transport === t ? 'active' : ''} onClick={() => setTransport(t)}>
                {t} only
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="panel">
        <h2 style={{ marginTop: 0 }}>Span tree &amp; parallel timeline</h2>
        <p className="muted small-text">
          Overlapping bars under the same parent are parallel calls. Red bars carry an error
          status — click any bar or tree row to see exactly which span produced it. Dashed
          outline = duplicate id; inset ring = cycle edge; dashed left edge = external parent.
        </p>
        <div className="scroll-x">
          <div style={{ minWidth: 760 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(300px, 420px) 1fr', gap: 12 }}>
              <div>
                <SpanTree
                  trace={trace}
                  selectedKey={selectedKey}
                  onSelect={(s) => setSelectedKey(s._instanceKey)}
                  orderedKeys={orderedKeys}
                />
              </div>
              <Waterfall
                spans={trace.spans}
                orderedKeys={orderedKeys}
                spanByKey={spanByKey}
                graph={trace.analysis.graph}
                colorMap={colorMap}
                selectedKey={selectedKey}
                onSelect={(s) => setSelectedKey(s._instanceKey)}
              />
            </div>
          </div>
        </div>
      </div>

      <div className="panel">
        <h2 style={{ marginTop: 0 }}>Span detail — three attribute layers kept separate</h2>
        <SpanDetail span={selectedSpan} />
      </div>

      <FindingsPanel
        analysis={trace.analysis}
        spans={trace.spans}
        onLocate={(span) => setSelectedKey(span._instanceKey)}
      />
    </div>
  );
}
