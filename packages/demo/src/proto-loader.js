// Loads the same vendored official proto definitions used by the receiver.
import path from 'node:path';
import fs from 'node:fs';
import protobuf from 'protobufjs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function locateProtoDir() {
  const candidates = [
    process.env.OTEL_PROTO_DIR,
    path.resolve(__dirname, '..', '..', 'backend', 'proto'),
    path.resolve(__dirname, '..', 'proto'),
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'opentelemetry', 'proto', 'trace', 'v1', 'trace.proto'))) {
      return c;
    }
  }
  throw new Error('official OTLP proto directory not found; set OTEL_PROTO_DIR');
}

const PROTO_DIR = locateProtoDir();
const PROTO_FILES = [
  'opentelemetry/proto/common/v1/common.proto',
  'opentelemetry/proto/resource/v1/resource.proto',
  'opentelemetry/proto/trace/v1/trace.proto',
  'opentelemetry/proto/collector/trace/v1/trace_service.proto',
];

let typesPromise;

export async function getTypes() {
  if (typesPromise) return typesPromise;
  typesPromise = (async () => {
    const root = new protobuf.Root();
    root.resolvePath = (origin, target) => {
      if (!path.isAbsolute(target) && !target.startsWith('.')) {
        return path.join(PROTO_DIR, target);
      }
      return protobuf.util.path.resolve(origin, target);
    };
    // Sequential: concurrent root.load calls race on shared namespaces.
    for (const f of PROTO_FILES) {
      // eslint-disable-next-line no-await-in-loop
      await root.load(path.join(PROTO_DIR, f));
    }
    root.resolveAll();
    return {
      ExportTraceServiceRequest: root.lookupType(
        'opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest',
      ),
    };
  })();
  return typesPromise;
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** Convert hex id fields to byte arrays in place (OTLP JSON shape -> protobufjs input). */
export function prepareForProtobuf(node) {
  if (Array.isArray(node)) {
    node.forEach(prepareForProtobuf);
    return node;
  }
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (
        (key === 'traceId' || key === 'spanId' || key === 'parentSpanId') &&
        typeof value === 'string'
      ) {
        node[key] = value ? hexToBytes(value) : new Uint8Array(0);
      } else {
        prepareForProtobuf(value);
      }
    }
  }
  return node;
}

export async function encodeProtobuf(requestObj) {
  const { ExportTraceServiceRequest } = await getTypes();
  const cloned = prepareForProtobuf(structuredClone(requestObj));
  // fromObject first: it converts uint64/int64 strings to Long; verify only
  // accepts the converted instance, not the JSON-shaped input.
  const message = ExportTraceServiceRequest.fromObject(cloned);
  const verifyError = ExportTraceServiceRequest.verify(message);
  if (verifyError) throw new Error(`proto verify: ${verifyError}`);
  return ExportTraceServiceRequest.encode(message).finish();
}
