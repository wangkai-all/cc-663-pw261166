// Sends the SAME demo events twice: once as OTLP/HTTP JSON, once as
// OTLP/HTTP Protobuf — so the receiver can be cross-checked across encodings.
//
// Usage:
//   node src/send.js            # send both encodings
//   node src/send.js --json     # JSON only
//   node src/send.js --proto    # Protobuf only
// Env: ENDPOINT (default http://localhost:8080/v1/traces)

import { buildDemoRequest, SCENARIO_SUMMARY } from './trace-factory.js';
import { encodeProtobuf } from './proto-loader.js';

const ENDPOINT = process.env.ENDPOINT ?? 'http://localhost:8080/v1/traces';
const args = new Set(process.argv.slice(2));
const sendJson = !args.has('--proto');
const sendProto = !args.has('--json');

async function post(body, { contentType, label }) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': contentType },
    body,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${label} ingest failed: HTTP ${res.status} ${text}`);
  }
  console.log(`[${label}] HTTP ${res.status} ${res.statusText} (${body.length} bytes, ${contentType})`);
}

async function main() {
  const request = buildDemoRequest();
  const spanCount = request.resourceSpans.reduce(
    (n, rs) => n + rs.scopeSpans.reduce((m, ss) => m + ss.spans.length, 0),
    0,
  );
  console.log(`Demo: ${spanCount} spans across ${SCENARIO_SUMMARY.length} scenarios`);
  for (const s of SCENARIO_SUMMARY) console.log(`  - ${s.seed} ${s.name}`);

  if (sendJson) {
    await post(JSON.stringify(request), {
      contentType: 'application/json',
      label: 'json',
    });
  }
  if (sendProto) {
    const buf = await encodeProtobuf(request);
    await post(new Uint8Array(buf), {
      contentType: 'application/x-protobuf',
      label: 'protobuf',
    });
  }
  console.log('Done. Open the viewer and compare the json/protobuf copies of each trace.');
}

main().catch((err) => {
  console.error('demo sender failed:', err.message);
  process.exit(1);
});
