import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { decodeTraceRequest } from './proto-loader.js';
import { store } from './store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? '0.0.0.0';

// Logger deliberately omits request/response bodies: raw OTLP payloads contain
// business attributes and must never land in ordinary logs.
const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? 'info',
    redact: {
      paths: ['req.body', 'request.body', '*.body'],
      censor: '[body not logged]',
    },
  },
  bodyLimit: 16 * 1024 * 1024,
});

await app.register(cors, { origin: true });

// --- Content-type parsers -------------------------------------------------

// OTLP protobuf: application/x-protobuf (and the grpc-web flavored variants).
const PROTO_CONTENT_TYPES = [
  'application/x-protobuf',
  'application/protobuf',
  'application/vnd.google.protobuf',
];
app.addContentTypeParser(PROTO_CONTENT_TYPES, { parseAs: 'buffer' }, async (req, body) => {
  try {
    const decoded = await decodeTraceRequest(body);
    return { __otlpTransport: 'protobuf', payload: decoded };
  } catch (err) {
    const e = new Error(`invalid protobuf body: ${err.message}`);
    e.statusCode = 400;
    throw e;
  }
});

// OTLP JSON: the spec content type, plus plain application/json for convenience.
app.addContentTypeParser(
  ['application/json', 'application/x-www-form-urlencoded'],
  { parseAs: 'string' },
  async (req, raw) => {
    if (!raw) return { __otlpTransport: 'json', payload: {} };
    try {
      return { __otlpTransport: 'json', payload: JSON.parse(raw) };
    } catch (err) {
      const e = new Error(`invalid JSON body: ${err.message}`);
      e.statusCode = 400;
      throw e;
    }
  },
);

// --- OTLP receiver endpoints ----------------------------------------------
// Both share one normalization/storage pipeline so the same events can be
// cross-checked across encodings.

app.post('/v1/traces', async (req, reply) => {
  const transport = req.body?.__otlpTransport ?? inferTransport(req.headers['content-type']);
  const payload = req.body?.payload ?? req.body;
  const result = store.ingest(payload, transport);
  req.log.info(
    { transport, ingestId: result.ingestId, spanCount: result.spanCount },
    'otlp ingest accepted (body not logged)',
  );
  // OTLP ExportTraceServiceResponse: partialSuccess omitted on full success.
  reply.code(200).type('application/json').send({});
});

function inferTransport(ct) {
  return String(ct ?? '').includes('protobuf') ? 'protobuf' : 'json';
}

// --- Read / management API -------------------------------------------------

app.get('/api/health', async () => ({ ok: true, ts: new Date().toISOString() }));

app.get('/api/traces', async () => ({ traces: store.listTraces() }));

app.get('/api/traces/:traceId', async (req, reply) => {
  const transport = req.query.transport;
  const trace = store.getTrace(req.params.traceId, transport);
  if (!trace) {
    reply.code(404).send({ error: 'trace not found' });
    return;
  }
  return trace;
});

app.get('/api/ingests', async () => ({ ingests: store.listIngests() }));

app.get('/api/rules', async () => ({ rules: store.getRules() }));

app.put('/api/rules', async (req, reply) => {
  const rules = req.body?.payload?.rules ?? req.body?.rules;
  if (!Array.isArray(rules)) {
    reply.code(400).send({ error: 'rules must be an array' });
    return;
  }
  const validationError = validateRules(rules);
  if (validationError) {
    reply.code(400).send({ error: validationError });
    return;
  }
  await store.setRules(rules);
  return { rules: store.getRules() };
});

app.get('/api/preview', async (req, reply) => {
  const result = store.preview(req.query.ingestId);
  if (!result) {
    reply.code(404).send({ error: 'no ingest available to preview' });
    return;
  }
  return result;
});

app.delete('/api/traces', async () => {
  store.clear();
  return { cleared: true };
});

function validateRules(rules) {
  const validLayers = new Set(['resource', 'scope', 'span', 'any']);
  const validMatch = new Set(['exact', 'prefix', 'suffix', 'regex', 'wildcard']);
  const validAction = new Set(['keep', 'drop', 'redact']);
  for (const [i, r] of rules.entries()) {
    if (!r || typeof r !== 'object') return `rule[${i}] is not an object`;
    if (!validLayers.has(r.layer)) return `rule[${i}].layer invalid`;
    if (!validMatch.has(r.match)) return `rule[${i}].match invalid`;
    if (!validAction.has(r.action)) return `rule[${i}].action invalid`;
    if (typeof r.pattern !== 'string' || r.pattern.length === 0) {
      return `rule[${i}].pattern required`;
    }
    if (r.match === 'regex') {
      try {
        const inline = /^\(\?([imsu]+)\)/.exec(r.pattern);
        const body = inline ? r.pattern.slice(inline[0].length) : r.pattern;
        new RegExp(body, inline ? inline[1] : '');
      } catch (e) {
        return `rule[${i}].pattern invalid regex: ${e.message}`;
      }
    }
  }
  return null;
}

// --- Static frontend (production build) -----------------------------------

const distDir = path.resolve(__dirname, '..', '..', 'frontend', 'dist');
if (fs.existsSync(distDir)) {
  await app.register(fastifyStatic, { root: distDir, wildcard: false, list: false });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/') || req.url.startsWith('/v1/')) {
      reply.code(404).send({ error: 'not found' });
    } else {
      reply.sendFile('index.html');
    }
  });
}

await store.loadRules();

app.listen({ port: PORT, host: HOST }).then(() => {
  app.log.info(`OTLP trace viewer listening on http://${HOST}:${PORT}`);
  app.log.info('OTLP endpoints: POST /v1/traces (application/json | application/x-protobuf)');
});
