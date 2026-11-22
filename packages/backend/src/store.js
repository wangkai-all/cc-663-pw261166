// In-memory trace store.
//
// Raw OTLP request bodies live ONLY here (process memory). They are never
// written to stdout/stderr or to disk; the Fastify logger is configured not to
// log request bodies. Retention rules are applied at read time, so changing a
// rule re-processes the same raw data and previews stay truthful.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeRequest } from './normalizer.js';
import { analyzeTrace } from './conflict-analyzer.js';
import { defaultRules, processIngest, previewRules } from './rules-engine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '..', 'data');
const RULES_FILE = path.join(DATA_DIR, 'retention-rules.json');
const MAX_INGESTS = 200;

class TraceStore {
  constructor() {
    /** raw normalized ingests, keyed by ingestId (not flattened across layers) */
    this.ingests = new Map();
    /** traceId -> array of ingestIds, in receive order */
    this.traceIndex = new Map();
    /** instance key -> span instance */
    this.spanInstances = new Map();
    /** traceId -> Map<spanId, instanceKey[]> for duplicate detection across batches */
    this.traceSpanIds = new Map();
    this.rules = defaultRules();
    this.rulesLoaded = false;
    this._instanceCounter = 0;
  }

  async loadRules() {
    if (this.rulesLoaded) return;
    this.rulesLoaded = true;
    try {
      const raw = await readFile(RULES_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) this.rules = parsed;
    } catch {
      // first run: keep defaults
    }
  }

  async saveRules() {
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(RULES_FILE, JSON.stringify(this.rules, null, 2), 'utf8');
  }

  getRules() {
    return this.rules;
  }

  async setRules(rules) {
    this.rules = rules;
    await this.saveRules();
  }

  /**
   * @param {object} payload OTLP JSON object or protobufjs-decoded object
   * @param {'json'|'protobuf'} transport
   */
  ingest(payload, transport) {
    const receivedAt = new Date().toISOString();
    const normalized = normalizeRequest(payload, { transport, receivedAt });
    this.ingests.set(normalized.ingestId, normalized);
    this.enforceIngestLimit();

    // Flatten spans into independently addressable instances while remembering
    // each span's resource/scope layer membership.
    for (const group of normalized.groups) {
      for (const scopeGroup of group.scopes) {
        for (const span of scopeGroup.spans) {
          const instanceKey = `${normalized.ingestId}:${this._instanceCounter++}`;
          span._instanceKey = instanceKey;
          span.ingestId = normalized.ingestId;
          span.transport = transport;
          span.receivedAt = receivedAt;
          span.resource = group.resource;
          span.resourceSchemaUrl = group.schemaUrl;
          span.scope = scopeGroup.scope;
          this.spanInstances.set(instanceKey, span);

          if (!this.traceIndex.has(span.traceId)) this.traceIndex.set(span.traceId, []);
          const idx = this.traceIndex.get(span.traceId);
          if (!idx.includes(normalized.ingestId)) idx.push(normalized.ingestId);

          if (!this.traceSpanIds.has(span.traceId)) this.traceSpanIds.set(span.traceId, new Map());
          const idMap = this.traceSpanIds.get(span.traceId);
          if (!idMap.has(span.spanId)) idMap.set(span.spanId, []);
          idMap.get(span.spanId).push(instanceKey);
        }
      }
    }
    return {
      ingestId: normalized.ingestId,
      resourceSpans: normalized.groups.length,
      spanCount: countSpans(normalized),
    };
  }

  enforceIngestLimit() {
    if (this.ingests.size <= MAX_INGESTS) return;
    const excess = this.ingests.size - MAX_INGESTS;
    const keys = [...this.ingests.keys()].slice(0, excess);
    for (const key of keys) {
      const ingest = this.ingests.get(key);
      for (const group of ingest.groups) {
        for (const sg of group.scopes) {
          for (const span of sg.spans) this.spanInstances.delete(span._instanceKey);
        }
      }
      this.ingests.delete(key);
      for (const [traceId, ids] of this.traceIndex) {
        const filtered = ids.filter((id) => id !== key);
        if (filtered.length) this.traceIndex.set(traceId, filtered);
        else this.traceIndex.delete(traceId);
      }
    }
  }

  listTraces() {
    const out = [];
    for (const [traceId, ingestIds] of this.traceIndex) {
      const spans = this.spansForTrace(traceId);
      if (!spans.length) continue;
      const transports = [...new Set(spans.map((s) => s.transport))].sort();
      const startMs = Math.min(...spans.map((s) => Number(BigInt(s.start.unixNano || '0') / 1_000_000n)));
      const endMs = Math.max(...spans.map((s) => Number(BigInt(s.end.unixNano || '0') / 1_000_000n)));
      const errorCount = spans.filter((s) => s.status?.code === 2).length;
      const analysis = analyzeTrace(spans);
      out.push({
        traceId,
        spanCount: spans.length,
        services: [...new Set(spans.map(serviceName).filter(Boolean))],
        transports,
        receivedAt: spans.map((s) => s.receivedAt).sort()[0],
        startIso: startMs ? new Date(startMs).toISOString() : '',
        durationMs: Math.max(0, endMs - startMs),
        errorCount,
        issueCount: analysis.findings.filter((f) => f.severity === 'error').length,
        warningCount: analysis.findings.filter((f) => f.severity === 'warning').length,
      });
    }
    return out.sort((a, b) => (a.receivedAt < b.receivedAt ? 1 : -1));
  }

  spansForTrace(traceId) {
    const ingestIds = this.traceIndex.get(traceId) ?? [];
    const spans = [];
    for (const id of ingestIds) {
      const ingest = this.ingests.get(id);
      if (!ingest) continue;
      for (const group of ingest.groups) {
        for (const sg of group.scopes) {
          for (const span of sg.spans) {
            if (span.traceId === traceId) spans.push(span);
          }
        }
      }
    }
    return spans;
  }

  /** Full trace view: rule-processed copy plus structural analysis. */
  getTrace(traceId, transportFilter) {
    let spans = this.spansForTrace(traceId);
    if (transportFilter === 'json' || transportFilter === 'protobuf') {
      spans = spans.filter((s) => s.transport === transportFilter);
    }
    if (!spans.length) return null;

    const analysis = analyzeTrace(spans);

    // Apply retention rules per layer on a copy; raw data in the store is untouched.
    const processedSpans = spans.map((span) => {
      const copy = structuredClone({
        ...span,
        attributes: span.attributes,
        resource: span.resource,
        scope: span.scope,
      });
      delete copy.resource;
      delete copy.scope;
      copy.resource = {
        ...span.resource,
        attributes: applyLayer(span.resource.attributes, this.rules, 'resource'),
      };
      copy.scope = {
        ...span.scope,
        attributes: applyLayer(span.scope.attributes, this.rules, 'scope'),
      };
      copy.attributes = applyLayer(span.attributes, this.rules, 'span');
      copy.issues = analysis.spanIssues.get(span.spanId) ?? [];
      copy.duplicateInstances = (this.traceSpanIds.get(traceId)?.get(span.spanId) ?? []).length;
      return copy;
    });

    // Group processed spans back by ingest for the layered view.
    const ingests = [];
    const byIngest = new Map();
    for (const span of processedSpans) {
      if (!byIngest.has(span.ingestId)) {
        const rec = {
          ingestId: span.ingestId,
          transport: span.transport,
          receivedAt: span.receivedAt,
          spans: [],
        };
        byIngest.set(span.ingestId, rec);
        ingests.push(rec);
      }
      byIngest.get(span.ingestId).spans.push(span);
    }

    return {
      traceId,
      transports: [...new Set(spans.map((s) => s.transport))].sort(),
      ingests,
      spans: processedSpans,
      analysis: {
        findings: analysis.findings,
        externalParents: analysis.externalParents,
        links: analysis.links,
        graph: analysis.graph,
      },
      rules: this.rules,
    };
  }

  /** Preview rule decisions against the most recent raw ingest (or a given one). */
  preview(ingestId) {
    let ingest;
    if (ingestId) {
      ingest = this.ingests.get(ingestId);
    } else {
      ingest = [...this.ingests.values()].at(-1);
    }
    if (!ingest) return null;
    const processed = processIngest(ingest, this.rules);
    return {
      preview: previewRules(ingest, this.rules),
      processed,
    };
  }

  listIngests() {
    return [...this.ingests.values()].map((ing) => ({
      ingestId: ing.ingestId,
      transport: ing.transport,
      receivedAt: ing.receivedAt,
      spanCount: countSpans(ing),
      traceIds: [...new Set(flattenSpans(ing).map((s) => s.traceId))],
    }));
  }

  clear() {
    this.ingests.clear();
    this.traceIndex.clear();
    this.spanInstances.clear();
    this.traceSpanIds.clear();
  }
}

function applyLayer(attributes, rules, layer) {
  // Local import avoided for hot path; reimplement via rules-engine export.
  return applyRulesImport(attributes, rules, layer);
}

import { applyRules as applyRulesImport } from './rules-engine.js';

function countSpans(ingest) {
  return flattenSpans(ingest).length;
}

function flattenSpans(ingest) {
  const out = [];
  for (const group of ingest.groups) {
    for (const sg of group.scopes) out.push(...sg.spans);
  }
  return out;
}

function serviceName(span) {
  const attr = span.resource?.attributes?.find((a) => a.key === 'service.name');
  return attr ? String(attr.value) : '';
}

export const store = new TraceStore();
