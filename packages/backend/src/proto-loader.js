// Loads the OFFICIAL OpenTelemetry protobuf definitions vendored under ./proto.
// Source revision is recorded in proto/SOURCE.txt. Do not hand-roll schemas here.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import protobuf from 'protobufjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROTO_DIR = path.resolve(__dirname, '..', 'proto');

const PROTO_FILES = [
  'opentelemetry/proto/common/v1/common.proto',
  'opentelemetry/proto/resource/v1/resource.proto',
  'opentelemetry/proto/trace/v1/trace.proto',
  'opentelemetry/proto/collector/trace/v1/trace_service.proto',
];

let rootPromise = null;

export function loadProtoRoot() {
  if (!rootPromise) {
    rootPromise = (async () => {
      const root = new protobuf.Root();
      root.resolvePath = (origin, target) => {
        // Imports inside the official protos look like
        // "opentelemetry/proto/common/v1/common.proto" -> resolve from PROTO_DIR
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
      return root;
    })();
  }
  return rootPromise;
}

let cachedTypes = null;

export async function getTraceTypes() {
  if (cachedTypes) return cachedTypes;
  const root = await loadProtoRoot();
  cachedTypes = {
    ExportTraceServiceRequest: root.lookupType(
      'opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest',
    ),
    Span: root.lookupType('opentelemetry.proto.trace.v1.Span'),
  };
  return cachedTypes;
}

/** Decode a binary OTLP/HTTP request body into a plain JS object (protobufjs toObject form). */
export async function decodeTraceRequest(buffer) {
  const { ExportTraceServiceRequest } = await getTraceTypes();
  const msg = ExportTraceServiceRequest.decode(buffer);
  return ExportTraceServiceRequest.toObject(msg, {
    longs: String,
    enums: Number,
    bytes: Buffer,
    defaults: false,
    arrays: true,
    objects: true,
  });
}

/** Encode a plain JS object (OTLP JSON shape) into an OTLP protobuf buffer. */
export async function encodeTraceRequest(obj) {
  const { ExportTraceServiceRequest } = await getTraceTypes();
  // Hex traceId/spanId strings must become byte arrays before verification.
  const cloned = normalizeBytesForEncode(structuredClone(obj));
  // fromObject converts 64-bit int strings to Long; verify runs on the result.
  const message = ExportTraceServiceRequest.fromObject(cloned);
  const errMsg = ExportTraceServiceRequest.verify(message);
  if (errMsg) throw new Error(`protobuf verify failed: ${errMsg}`);
  return ExportTraceServiceRequest.encode(message).finish();
}

function normalizeBytesForEncode(node) {
  if (Array.isArray(node)) {
    for (const item of node) normalizeBytesForEncode(item);
    return node;
  }
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (
        (key === 'traceId' || key === 'spanId' || key === 'parentSpanId') &&
        typeof value === 'string'
      ) {
        node[key] = hexToBytes(value);
      } else {
        normalizeBytesForEncode(value);
      }
    }
  }
  return node;
}

export function hexToBytes(hex) {
  if (!hex) return new Uint8Array(0);
  const clean = hex.length % 2 === 0 ? hex : `0${hex}`;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
