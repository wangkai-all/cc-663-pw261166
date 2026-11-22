// Structural validation over a trace's span set.
// Conflict samples are NEVER dropped to make a tree render. Every span stays in
// the span list; findings are reported separately and attached to spans.

const FUTURE_TOLERANCE_MS = 60 * 60 * 1000; // 1h clock skew tolerance
const PAST_FLOOR_MS = Date.UTC(2000, 0, 1);

function nanoToMs(nano) {
  try {
    return Number(BigInt(nano || '0') / 1_000_000n);
  } catch {
    return 0;
  }
}

/**
 * Analyze one trace.
 * @param {Array} spans flat normalized span list (same traceId)
 * @returns {{findings: Array, spanIssues: Map<string, Array>, graph: object}}
 */
export function analyzeTrace(spans) {
  const findings = [];
  const spanIssues = new Map();
  const flag = (spanId, issue) => {
    if (!spanIssues.has(spanId)) spanIssues.set(spanId, []);
    spanIssues.get(spanId).push(issue);
  };

  const byId = new Map();
  const idSet = new Set();

  // 1) Duplicate span identifiers — keep every copy, mark all of them.
  for (const span of spans) {
    if (!span.spanId) {
      findings.push({
        code: 'EMPTY_SPAN_ID',
        severity: 'error',
        message: 'Span has an empty spanId',
        spanId: '',
        spanName: span.name,
      });
      continue;
    }
    if (idSet.has(span.spanId)) {
      const first = byId.get(span.spanId);
      const signature = spanSignature(span);
      const identical = first && spanSignature(first) === signature;
      const issue = {
        code: 'DUPLICATE_SPAN_ID',
        severity: 'error',
        message: identical
          ? `Duplicate spanId ${span.spanId}: identical retransmission (all copies retained)`
          : `Duplicate spanId ${span.spanId}: conflicting content — all copies retained`,
        spanId: span.spanId,
        spanName: span.name,
        duplicate: true,
        conflicting: !identical,
      };
      findings.push(issue);
      flag(span.spanId, issue.code);
      // also flag the first occurrence once
      if (first && !(spanIssues.get(span.spanId) ?? []).includes(issue.code)) {
        flag(span.spanId, issue.code);
      }
    } else {
      idSet.add(span.spanId);
      byId.set(span.spanId, span);
    }
  }

  // 2) External parents (parent not present in this batch) — preserved, not invented.
  const externalParents = [];
  for (const span of spans) {
    if (span.parentSpanId && !idSet.has(span.parentSpanId)) {
      externalParents.push({
        spanId: span.parentSpanId,
        childSpanId: span.spanId,
        childName: span.name,
      });
      const issue = {
        code: 'EXTERNAL_PARENT',
        severity: 'info',
        message: `Parent ${span.parentSpanId} is outside this receive batch — retained as external parent`,
        spanId: span.spanId,
        parentSpanId: span.parentSpanId,
      };
      findings.push(issue);
      flag(span.spanId, issue.code);
    }
  }

  // 3) Parent-child cycles via DFS coloring over parent edges.
  const cycles = detectCycles(spans, idSet);
  for (const cycle of cycles) {
    const issue = {
      code: 'PARENT_CYCLE',
      severity: 'error',
      message: `Parent-child cycle detected: ${cycle.join(' -> ')}`,
      cycle,
    };
    findings.push(issue);
    for (const sid of cycle) flag(sid, issue.code);
  }

  // 4) Unreasonable time intervals.
  const now = Date.now();
  for (const span of spans) {
    const startMs = nanoToMs(span.start.unixNano);
    const endMs = nanoToMs(span.end.unixNano);
    const durationMs = endMs - startMs;
    if (startMs === 0 && endMs === 0) {
      const issue = {
        code: 'MISSING_TIMESTAMP',
        severity: 'warning',
        message: 'Span has no start/end timestamps',
        spanId: span.spanId,
        spanName: span.name,
      };
      findings.push(issue);
      flag(span.spanId, issue.code);
    } else if (durationMs < 0) {
      const issue = {
        code: 'NEGATIVE_DURATION',
        severity: 'error',
        message: `End time is ${Math.abs(durationMs)}ms before start time`,
        spanId: span.spanId,
        spanName: span.name,
      };
      findings.push(issue);
      flag(span.spanId, issue.code);
    } else if (durationMs === 0) {
      const issue = {
        code: 'ZERO_DURATION',
        severity: 'warning',
        message: 'Zero-duration span (start == end)',
        spanId: span.spanId,
        spanName: span.name,
      };
      findings.push(issue);
      flag(span.spanId, issue.code);
    }
    if (startMs > now + FUTURE_TOLERANCE_MS) {
      const issue = {
        code: 'FUTURE_TIMESTAMP',
        severity: 'warning',
        message: `Start time is in the future (${new Date(startMs).toISOString()})`,
        spanId: span.spanId,
        spanName: span.name,
      };
      findings.push(issue);
      flag(span.spanId, issue.code);
    }
    if (startMs > 0 && startMs < PAST_FLOOR_MS) {
      const issue = {
        code: 'ANCIENT_TIMESTAMP',
        severity: 'warning',
        message: `Start time predates year 2000 (${new Date(startMs).toISOString()})`,
        spanId: span.spanId,
        spanName: span.name,
      };
      findings.push(issue);
      flag(span.spanId, issue.code);
    }
    // Child interval should sit within its (present) parent's interval.
    if (span.parentSpanId && idSet.has(span.parentSpanId)) {
      const parent = byId.get(span.parentSpanId);
      if (parent) {
        const pStart = nanoToMs(parent.start.unixNano);
        const pEnd = nanoToMs(parent.end.unixNano);
        if (pStart > 0 && (startMs < pStart - 1 || endMs > pEnd + 1)) {
          const issue = {
            code: 'OUT_OF_PARENT_INTERVAL',
            severity: 'warning',
            message: 'Child time interval extends outside the parent interval',
            spanId: span.spanId,
            parentSpanId: span.parentSpanId,
          };
          findings.push(issue);
          flag(span.spanId, issue.code);
        }
      }
    }
  }

  // 5) Links are NOT parent edges — report them separately for the UI to draw
  // as associations rather than tree edges.
  const links = [];
  for (const span of spans) {
    for (const link of span.links ?? []) {
      links.push({
        fromSpanId: span.spanId,
        fromName: span.name,
        toTraceId: link.traceId,
        toSpanId: link.spanId,
      });
    }
  }

  const graph = buildGraph(spans, idSet, cycles);

  return { findings, spanIssues, externalParents, links, graph };
}

function spanSignature(span) {
  return JSON.stringify({
    name: span.name,
    start: span.start.unixNano,
    end: span.end.unixNano,
    kind: span.kindCode,
    parent: span.parentSpanId,
    attrs: span.attributes.map((a) => `${a.key}=${a.type}:${JSON.stringify(a.value)}`),
  });
}

function detectCycles(spans, idSet) {
  const parentOf = new Map();
  for (const span of spans) {
    if (span.spanId && span.parentSpanId && idSet.has(span.parentSpanId)) {
      parentOf.set(span.spanId, span.parentSpanId);
    }
  }
  const cycles = [];
  const seenCycleKeys = new Set();
  for (const startId of parentOf.keys()) {
    const path = [];
    const position = new Map();
    let cur = startId;
    while (cur) {
      if (position.has(cur)) {
        // Nodes strictly inside the loop, without the repeated endpoint.
        const loop = path.slice(position.get(cur));
        // Canonicalize rotation so the same loop found from another start
        // produces one key (smallest id first), independent of traversal entry.
        const minIdx = loop.reduce((best, id, i) => (id < loop[best] ? i : best), 0);
        const rotated = [...loop.slice(minIdx), ...loop.slice(0, minIdx)];
        const key = rotated.join('|');
        if (!seenCycleKeys.has(key)) {
          seenCycleKeys.add(key);
          cycles.push([...rotated, rotated[0]]);
        }
        break;
      }
      position.set(cur, path.length);
      path.push(cur);
      cur = parentOf.get(cur);
    }
  }
  return cycles;
}

/**
 * Build a renderable tree WITHOUT dropping nodes:
 *  - roots = spans with no parent, external parent, or a parent edge that closes a cycle
 *  - cycle back-edges are returned separately so the UI can mark them
 *  - duplicate ids: all copies remain in flat `spans`; the tree uses the first
 *    copy and reports extras under duplicateOf
 */
function buildGraph(spans, idSet, cycles) {
  // Plain objects/arrays only: this graph is serialized over HTTP, so no Maps.
  const cycleEdges = new Set();
  for (const cycle of cycles) {
    for (let i = 0; i < cycle.length - 1; i += 1) {
      cycleEdges.add(`${cycle[i + 1]}->${cycle[i]}`);
    }
  }
  const firstSeen = new Set();
  /** @type {Array<{instanceKey: string, spanId: string}>} */
  const duplicateCopies = [];
  const roots = [];
  /** @type {Record<string, string[]>} spanId -> child instance keys */
  const childrenOf = {};

  for (const span of spans) {
    if (!span.spanId) {
      roots.push({ spanId: null, indexKey: span._instanceKey, external: false, orphan: true });
      continue;
    }
    if (firstSeen.has(span.spanId)) {
      duplicateCopies.push({ instanceKey: span._instanceKey, spanId: span.spanId });
    } else {
      firstSeen.add(span.spanId);
    }
  }

  for (const span of spans) {
    if (duplicateCopies.some((d) => d.instanceKey === span._instanceKey)) continue; // extras stay visible in flat list
    if (!span.parentSpanId || !idSet.has(span.parentSpanId)) {
      roots.push({
        spanId: span.spanId,
        indexKey: span._instanceKey,
        external: Boolean(span.parentSpanId),
        externalParentSpanId: span.parentSpanId || null,
      });
      continue;
    }
    const edgeKey = `${span.spanId}->${span.parentSpanId}`;
    if (cycleEdges.has(edgeKey)) {
      // Break the cycle for rendering; keep the node as a root and flag the edge.
      roots.push({ spanId: span.spanId, indexKey: span._instanceKey, brokenCycleEdge: edgeKey });
      continue;
    }
    if (!childrenOf[span.parentSpanId]) childrenOf[span.parentSpanId] = [];
    childrenOf[span.parentSpanId].push(span._instanceKey);
  }

  return { roots, childrenOf, duplicateCopies, cycleEdges: [...cycleEdges] };
}
