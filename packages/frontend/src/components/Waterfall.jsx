// Gantt-style span waterfall.
// Design rules applied (dataviz skill): thin bars <=14px with 4px rounded ends,
// 2px surface gaps, hit targets larger than marks (full 26px row), tooltips,
// status colors reserved for error/warn state (icon+label, never color alone),
// service identity uses the validated categorical palette in fixed order.

import { memo, useMemo, useState } from 'react';

const SERVICE_COLORS = [
  'var(--series-1)',
  'var(--series-2)',
  'var(--series-3)',
  'var(--series-4)',
  'var(--series-5)',
  'var(--series-6)',
  'var(--series-7)',
  'var(--series-8)',
];

export function buildServiceColorMap(spans) {
  const services = [...new Set(spans.map(serviceOf).filter(Boolean))].sort();
  return Object.fromEntries(services.map((s, i) => [s, SERVICE_COLORS[i % SERVICE_COLORS.length]]));
}

export function serviceOf(span) {
  return span.resource?.attributes?.find((a) => a.key === 'service.name')?.value ?? 'unknown';
}

function toMs(span, field) {
  return Number(BigInt(span[field].unixNano || '0') / 1_000_000n);
}

export function formatDuration(nano) {
  const n = Number(BigInt(nano || '0'));
  if (n < 1000) return `${n}ns`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}µs`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(2)}ms`;
  return `${(n / 1_000_000_000).toFixed(3)}s`;
}

function Tooltip({ tip }) {
  if (!tip) return null;
  const { x, y, span, offsetMs, durationMs, issues } = tip;
  const left = Math.min(x + 14, window.innerWidth - 360);
  const top = Math.min(y + 14, window.innerHeight - 220);
  return (
    <div className="tooltip" style={{ left, top }}>
      <div className="tt-title">{span.name}</div>
      <dl>
        <dt>service</dt>
        <dd>{serviceOf(span)}</dd>
        <dt>spanId</dt>
        <dd className="mono">{span.spanId}</dd>
        <dt>kind</dt>
        <dd>{span.kindName}</dd>
        <dt>start</dt>
        <dd>+{offsetMs.toFixed(1)}ms</dd>
        <dt>duration</dt>
        <dd>{durationMs < 0 ? `${durationMs.toFixed(1)}ms (invalid)` : `${durationMs.toFixed(1)}ms`}</dd>
        <dt>status</dt>
        <dd>{span.status?.codeName ?? 'UNSET'}{span.status?.message ? ` — ${span.status.message}` : ''}</dd>
        {issues?.length ? (
          <>
            <dt>issues</dt>
            <dd>{issues.join(', ')}</dd>
          </>
        ) : null}
      </dl>
    </div>
  );
}

function WaterfallRow({ span, range, color, isSelected, onSelect, externalParent, cycleEdge, duplicate, onHover }) {
  const startMs = toMs(span, 'start');
  const endMs = toMs(span, 'end');
  const [minMs, maxMs] = range;
  const total = Math.max(1, maxMs - minMs);
  const leftPct = ((startMs - minMs) / total) * 100;
  const widthPct = Math.max(0.3, (Math.abs(endMs - startMs) / total) * 100);
  const isError = span.status?.code === 2;

  const classes = [
    'bar',
    isError ? 'error' : '',
    externalParent ? 'external-start' : '',
    duplicate ? 'duplicate' : '',
    cycleEdge ? 'cycle' : '',
  ].filter(Boolean).join(' ');

  return (
    <div className="waterfall-row">
      {[0.25, 0.5, 0.75].map((g) => (
        <div key={g} className="gridline" style={{ left: `${g * 100}%` }} />
      ))}
      <div
        className="waterfall-hit"
        style={{ left: `${leftPct}%`, width: `${Math.max(widthPct, 4)}%` }}
        onMouseMove={(e) => onHover({ x: e.clientX, y: e.clientY, span })}
        onMouseLeave={() => onHover(null)}
        onFocus={(e) => onHover({ x: e.target.getBoundingClientRect().left, y: e.target.getBoundingClientRect().top, span })}
        onBlur={() => onHover(null)}
        onClick={() => onSelect(span)}
        role="button"
        tabIndex={0}
        aria-label={`${span.name}, ${formatDuration(span.durationNano)}${isError ? ', error' : ''}`}
      >
        <div
          className={classes}
          style={{
            left: 0,
            width: '100%',
            background: isError ? undefined : color,
            outline: isSelected ? '2px solid var(--text-primary)' : undefined,
          }}
        />
      </div>
    </div>
  );
}

function WaterfallImpl({ spans, orderedKeys, spanByKey, colorMap, selectedKey, onSelect, graph }) {
  const [tip, setTip] = useState(null);

  const range = useMemo(() => {
    const starts = spans.map((s) => toMs(s, 'start'));
    const ends = spans.map((s) => toMs(s, 'end'));
    const minMs = Math.min(...starts);
    const maxMs = Math.max(...ends, minMs + 1);
    return [minMs, maxMs];
  }, [spans]);

  const cycleEdges = graph?.cycleEdges ?? [];
  const duplicateIds = new Set(
    spans.filter((s) => (s.duplicateInstances ?? 1) > 1).map((s) => s.spanId),
  );
  const externalIds = new Set((graph?.roots ?? []).filter((r) => r.external).map((r) => r.spanId));

  return (
    <div className="waterfall">
      {orderedKeys.map((key) => {
        const span = spanByKey.get(key);
        if (!span) return null;
        const isCycle = span.issues?.includes('PARENT_CYCLE');
        return (
          <WaterfallRow
            key={key}
            span={span}
            range={range}
            color={colorMap[serviceOf(span)] ?? 'var(--series-1)'}
            isSelected={selectedKey === key}
            onSelect={onSelect}
            externalParent={externalIds.has(span.spanId)}
            cycleEdge={isCycle || cycleEdges.some((e) => e.startsWith(span.spanId))}
            duplicate={duplicateIds.has(span.spanId)}
            onHover={(pos) =>
              setTip(
                pos
                  ? {
                      ...pos,
                      offsetMs: toMs(pos.span, 'start') - range[0],
                      durationMs: toMs(pos.span, 'end') - toMs(pos.span, 'start'),
                      issues: pos.span.issues,
                    }
                  : null,
              )
            }
          />
        );
      })}
      <div className="axis">
        <span>0ms</span>
        <span>{((range[1] - range[0]) * 0.5).toFixed(1)}ms</span>
        <span>{(range[1] - range[0]).toFixed(1)}ms</span>
      </div>
      <Tooltip tip={tip} />
    </div>
  );
}

export const Waterfall = memo(WaterfallImpl);
