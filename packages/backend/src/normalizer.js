// Normalizes OTLP ExportTraceServiceRequest payloads (JSON or decoded protobuf)
// into a canonical internal shape.
//
// LAYERING IS PRESERVED — these three attribute layers are stored separately and
// never flattened together (same attribute key in different layers would
// otherwise silently overwrite each other):
//   resource.attributes
//   scope.attributes
//   span.attributes
//
// Numeric protobuf enums (protobufjs output) and symbolic enum names (OTLP JSON)
// are both accepted; the canonical form always carries numeric code + name.

import { randomUUID } from 'node:crypto';

export const SPAN_KIND_NAMES = {
  0: 'SPAN_KIND_UNSPECIFIED',
  1: 'SPAN_KIND_INTERNAL',
  2: 'SPAN_KIND_SERVER',
  3: 'SPAN_KIND_CLIENT',
  4: 'SPAN_KIND_PRODUCER',
  5: 'SPAN_KIND_CONSUMER',
};

export const STATUS_CODE_NAMES = {
  0: 'STATUS_CODE_UNSET',
  1: 'STATUS_CODE_OK',
  2: 'STATUS_CODE_ERROR',
};

function bytesToHex(value) {
  if (value == null) return '';
  if (typeof value === 'string') {
    // OTLP JSON: hex string for trace/span ids. Already hex.
    return value.toLowerCase();
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return Buffer.from(value).toString('hex');
  }
  return String(value);
}

// AnyValue -> { type, value }. 64-bit ints stay strings to avoid precision loss.
function normalizeAnyValue(any) {
  if (any == null || typeof any !== 'object') {
    return { type: 'string', value: String(any) };
  }
  if (any.stringValue !== undefined) return { type: 'string', value: any.stringValue };
  if (any.boolValue !== undefined) return { type: 'boolean', value: Boolean(any.boolValue) };
  if (any.intValue !== undefined) return { type: 'int64', value: String(any.intValue) };
  if (any.doubleValue !== undefined) return { type: 'double', value: Number(any.doubleValue) };
  if (any.bytesValue !== undefined) {
    const buf = Buffer.isBuffer(any.bytesValue)
      ? any.bytesValue
      : Buffer.from(any.bytesValue ?? '');
    return { type: 'bytes', value: buf.toString('base64') };
  }
  if (any.arrayValue !== undefined) {
    return {
      type: 'array',
      value: (any.arrayValue.values ?? []).map(normalizeAnyValue),
    };
  }
  if (any.kvlistValue !== undefined) {
    return {
      type: 'kvlist',
      value: normalizeAttributes(any.kvlistValue.values ?? []),
    };
  }
  return { type: 'empty', value: null };
}

// KeyValue list -> array of { key, type, value } (duplicate keys are KEPT,
// because collapsing them into an object would itself be an overwrite).
export function normalizeAttributes(kvs) {
  if (!Array.isArray(kvs)) return [];
  return kvs.map((kv) => {
    const v = normalizeAnyValue(kv.value);
    return { key: String(kv.key ?? ''), type: v.type, value: v.value };
  });
}

function resolveEnum(input, names, fallback = 0) {
  if (typeof input === 'string') {
    const lower = input.toUpperCase();
    const found = Object.entries(names).find(([, name]) => name === lower);
    if (found) return { code: Number(found[0]), name: found[1] };
    const num = Number(input);
    if (Number.isInteger(num)) return { code: num, name: names[num] ?? `UNKNOWN_${num}` };
    return { code: fallback, name: names[fallback] };
  }
  const code = Number(input ?? fallback);
  return { code, name: names[code] ?? `UNKNOWN_${code}` };
}

// nanos since epoch -> { unixNano: string, iso: string }
function normalizeTime(unixNano) {
  const raw = String(unixNano ?? '0');
  let millis = 0;
  try {
    const nano = BigInt(raw || '0');
    millis = Number(nano / 1000000n);
  } catch {
    millis = 0;
  }
  const iso = millis > 0 ? new Date(millis).toISOString() : '';
  return { unixNano: raw, iso, epochMs: millis };
}

function normalizeStatus(status) {
  if (!status) return null;
  const code = resolveEnum(status.code, STATUS_CODE_NAMES, 0);
  return {
    code: code.code,
    codeName: code.name,
    message: status.message ?? '',
  };
}

function normalizeLink(link) {
  return {
    traceId: bytesToHex(link.traceId),
    spanId: bytesToHex(link.spanId),
    traceState: link.traceState ?? '',
    attributes: normalizeAttributes(link.attributes),
    droppedAttributesCount: Number(link.droppedAttributesCount ?? 0),
    flags: Number(link.flags ?? 0),
  };
}

function normalizeEvent(event) {
  return {
    timeUnixNano: normalizeTime(event.timeUnixNano),
    name: event.name ?? '',
    attributes: normalizeAttributes(event.attributes),
    droppedAttributesCount: Number(event.droppedAttributesCount ?? 0),
  };
}

/**
 * Convert an ExportTraceServiceRequest into normalized ResourceSpan groups.
 * @param {object} payload raw OTLP JSON object, or protobufjs toObject() result
 * @param {{transport: 'json'|'protobuf', receivedAt: string}} meta
 */
export function normalizeRequest(payload, meta) {
  const resourceSpans = Array.isArray(payload?.resourceSpans) ? payload.resourceSpans : [];
  const groups = resourceSpans.map((rs, groupIndex) => {
    const resource = {
      attributes: normalizeAttributes(rs.resource?.attributes),
      droppedAttributesCount: Number(rs.resource?.droppedAttributesCount ?? 0),
    };
    const scopeSpans = Array.isArray(rs.scopeSpans) ? rs.scopeSpans : [];
    const scopes = scopeSpans.map((ss, scopeIndex) => {
      const scope = {
        name: ss.scope?.name ?? '',
        version: ss.scope?.version ?? '',
        schemaUrl: ss.schemaUrl ?? rs.schemaUrl ?? '',
        attributes: normalizeAttributes(ss.scope?.attributes),
        droppedAttributesCount: Number(ss.scope?.droppedAttributesCount ?? 0),
      };
      const spans = Array.isArray(ss.spans) ? ss.spans : [];
      return {
        scopeIndex,
        scope,
        spans: spans.map((span) => normalizeSpan(span, scope, groupIndex, scopeIndex)),
      };
    });
    return {
      resourceSpanIndex: groupIndex,
      resource,
      schemaUrl: rs.schemaUrl ?? '',
      scopes,
    };
  });
  return {
    ingestId: randomUUID(),
    transport: meta.transport,
    receivedAt: meta.receivedAt,
    groups,
  };
}

function normalizeSpan(span, scope, groupIndex, scopeIndex) {
  const kind = resolveEnum(span.kind, SPAN_KIND_NAMES, 0);
  const start = normalizeTime(span.startTimeUnixNano);
  const end = normalizeTime(span.endTimeUnixNano);
  const durationNano = (() => {
    try {
      return String(BigInt(end.unixNano || '0') - BigInt(start.unixNano || '0'));
    } catch {
      return '0';
    }
  })();
  return {
    // Identity
    traceId: bytesToHex(span.traceId),
    spanId: bytesToHex(span.spanId),
    parentSpanId: bytesToHex(span.parentSpanId),
    traceState: span.traceState ?? '',
    flags: Number(span.flags ?? 0),
    // Content
    name: span.name ?? '',
    kindCode: kind.code,
    kindName: kind.name,
    start: start,
    end: end,
    durationNano,
    status: normalizeStatus(span.status),
    attributes: normalizeAttributes(span.attributes),
    droppedAttributesCount: Number(span.droppedAttributesCount ?? 0),
    events: (span.events ?? []).map(normalizeEvent),
    links: (span.links ?? []).map(normalizeLink),
    // Layer membership (kept explicit so the UI can render three layers)
    resourceSpanIndex: groupIndex,
    scopeSpanIndex: scopeIndex,
    scopeName: scope.name,
    scopeVersion: scope.version,
    // Bookkeeping filled in later by the store
    ingestId: null,
    transport: null,
  };
}
