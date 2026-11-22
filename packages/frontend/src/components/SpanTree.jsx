// Renders span labels in the SAME row order as the Waterfall. Indentation comes
// from tree depth; the backend has already broken cycle back-edges (flagged, not
// deleted) and retained every duplicate copy.

import { useMemo } from 'react';
import { serviceOf, formatDuration } from './Waterfall.jsx';

function issueLevel(span) {
  const issues = span.issues ?? [];
  if (issues.some((i) => i.includes('CYCLE') || i.includes('DUPLICATE') || i.includes('NEGATIVE'))) {
    return 'error';
  }
  if (issues.length) return 'warn';
  if (span.status?.code === 2) return 'error';
  return null;
}

const DOT_CLASS = { error: 'error', warn: 'warn', info: 'info' };

export default function SpanTree({ trace, selectedKey, onSelect, orderedKeys }) {
  const { spans, analysis } = trace;
  const { graph } = analysis;
  const spanByKey = useMemo(() => new Map(spans.map((s) => [s._instanceKey, s])), [spans]);

  // depth per spanId via the acyclic graph the backend produced.
  const depthById = useMemo(() => {
    const depths = new Map();
    const walk = (spanId, depth) => {
      if (depths.has(spanId)) return;
      depths.set(spanId, depth);
      for (const childKey of graph.childrenOf[spanId] ?? []) {
        const child = spanByKey.get(childKey);
        if (child) walk(child.spanId, depth + 1);
      }
    };
    for (const root of graph.roots) {
      if (root.spanId) walk(root.spanId, 0);
    }
    return depths;
  }, [graph, spanByKey]);

  const seenIds = new Set();

  return (
    <div>
      {orderedKeys.map((key) => {
        const span = spanByKey.get(key);
        if (!span) return null;
        const isDupe = seenIds.has(span.spanId);
        seenIds.add(span.spanId);
        const depth = isDupe ? (depthById.get(span.spanId) ?? 0) + 1 : depthById.get(span.spanId) ?? 0;
        const level = issueLevel(span);
        const rootMeta = graph.roots.find((r) => r.indexKey === key);

        return (
          <div key={key}>
            {rootMeta?.brokenCycleEdge && (
              <div className="small-text mb-8" style={{ marginLeft: depth * 18 }}>
                <span className="badge error">cycle edge broken for layout</span>
                <span className="mono muted"> {rootMeta.brokenCycleEdge}</span>
              </div>
            )}
            <div
              className={`tree-row ${selectedKey === key ? 'selected' : ''}`}
              style={{ gridTemplateColumns: '1fr' }}
            >
              <div
                className="span-label"
                style={{ marginLeft: depth * 16, paddingLeft: 2 }}
                onClick={() => onSelect(span)}
              >
                {level ? (
                  <span className={`issue-dot ${DOT_CLASS[level]}`} title={span.issues?.join(', ')} />
                ) : (
                  <span style={{ width: 10, flexShrink: 0 }} />
                )}
                <span className="span-name">{span.name}</span>
                {span.status?.code === 2 && <span className="badge error">ERROR</span>}
                {span.issues?.includes('EXTERNAL_PARENT') && (
                  <span className="badge info" title={`external parent ${span.parentSpanId}`}>
                    ext-parent
                  </span>
                )}
                {span.issues?.includes('PARENT_CYCLE') && <span className="badge error">cycle</span>}
                {isDupe && <span className="badge warn">duplicate copy</span>}
                {(span.duplicateInstances ?? 1) > 1 && !isDupe && (
                  <span className="badge warn">×{span.duplicateInstances}</span>
                )}
                <span className="span-svc">{serviceOf(span)}</span>
                <span className="span-svc mono">{formatDuration(span.durationNano)}</span>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
