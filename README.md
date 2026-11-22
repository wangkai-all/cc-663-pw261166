# OTLP Trace Viewer

A from-scratch web application that receives OpenTelemetry OTLP traces over HTTP,
stores them in memory with strict attribute layering, validates span graph
structure without ever dropping a conflicting node, and visualizes each trace as
an expandable span tree + parallel-call waterfall. A built-in demo sender emits
the **same events twice — once as OTLP JSON and once as OTLP Protobuf** — so the
two encodings can be cross-checked against one pipeline.

## What it demonstrates

| Requirement | Where it lives |
|---|---|
| JSON **and** Protobuf OTLP intake, same pipeline | `POST /v1/traces`, content-type routed in `packages/backend/src/server.js` |
| Resource / Instrumentation Scope / Span attributes stored in **three separate layers**, never flattened | `normalizer.js` → separate `resource.attributes`, `scope.attributes`, `span.attributes`; rendered in three separate cards |
| External parent preserved when the parent span is outside the receive batch | `conflict-analyzer.js` (`EXTERNAL_PARENT`), rendered as a root with an `ext-parent` marker and dashed bar edge |
| Span Links drawn as associations, never treated as parent/child edges | links kept out of the parent graph entirely; rendered in a dedicated "Span links" panel and per-span detail |
| Duplicate span identifiers detected, every copy retained and expandable | `DUPLICATE_SPAN_ID` (identical retransmit vs conflicting content), duplicate copies listed separately |
| Parent-child cycles detected and rendered without losing nodes | `PARENT_CYCLE`; the back-edge is broken for layout and explicitly marked, both spans stay visible |
| Unreasonable time intervals detected | negative/zero duration, missing timestamps, future/ancient timestamps, child interval outside parent |
| Attribute retention rules with field-level preview | Collection page: keep / drop / redact per layer, exact/prefix/suffix/wildcard/regex matching, live preview of every attribute's decision |
| Raw request bodies never written to ordinary logs | Fastify logger redacts bodies; only ingest metadata (transport, counts, id) is logged |
| Error segment can be located back to its span | error spans get red bars + ERROR badges; every finding has a **locate** button that selects the span |

## Architecture

```
packages/
  backend/        Fastify 5 receiver + in-memory store + analysis
    proto/        OFFICIAL OpenTelemetry .proto definitions (vendored, see SOURCE.txt + LICENSE)
    src/
      server.js             HTTP endpoints, content-type parsers, body-safe logging
      proto-loader.js       protobufjs load/encode/decode against the official protos
      normalizer.js         OTLP payload -> canonical model; three attribute layers
      conflict-analyzer.js  duplicates / cycles / time validation / renderable graph
      rules-engine.js       retention rules + preview
      store.js              in-memory ingest & trace store (raw bodies never leave it)
  frontend/       React 19 + Vite SPA (trace list, tree, waterfall, detail, rules page)
  demo/           Sender that produces all scenarios and posts them as JSON and Protobuf
```

Both OTLP encodings share one normalization path. The Protobuf parser and the
JSON parser converge on the same canonical span model, so the viewer can show
`json`-only, `protobuf`-only, or merged views of the same trace and the results
can be diffed directly.

## Quick start

```bash
npm install          # installs all three workspaces
npm run build        # build the React SPA (served by the backend in production)
npm start            # start the receiver on http://localhost:8080
# in another terminal:
npm run demo         # sends the same 16-span scenario set as JSON and as Protobuf
```

Then open http://localhost:8080.

For development with hot reload (Vite dev server on :5173 proxying to :8080):

```bash
npm run dev
```

### Demo sender options

```bash
npm run demo:json    # only application/json
npm run demo:proto   # only application/x-protobuf
ENDPOINT=http://host:8080/v1/traces npm run demo
```

## Demo scenarios

The sender (`packages/demo/src/trace-factory.js`) generates six scenarios in
one request:

1. **Cross-service trace** — `api-gateway → checkout → [inventory ∥ payment] → postgres`,
   with two overlapping (parallel) client calls and an error span whose status
   message and exception event explain the failure.
2. **External parent** — a span whose `parentSpanId` points to a span not present
   in the batch.
3. **Span link** — a consumer span linking to another trace; the link is rendered
   as an association, never as a tree edge.
4. **Parent-child cycle** — two spans claiming each other as parent.
5. **Duplicate spanId** — an identical retransmission plus a conflicting copy,
   same id, different content.
6. **Bad time intervals** — negative duration and a future timestamp.

Because the identical request is posted in both encodings, the trace list shows
each trace with both `json` and `protobuf` badges; use the transport toggle on a
trace to compare them.

## HTTP API

| Method & path | Purpose |
|---|---|
| `POST /v1/traces` | OTLP receiver (`application/json` or `application/x-protobuf`) |
| `GET /api/traces` | trace list with issue/error counts |
| `GET /api/traces/:traceId?transport=json\|protobuf` | full trace: spans, layered attributes, graph, findings |
| `GET /api/ingests` | received batches (metadata only) |
| `GET /api/rules` / `PUT /api/rules` | retention rule configuration (persisted to `backend/data/`) |
| `GET /api/preview?ingestId=…` | per-attribute keep/drop/redact decisions against a raw ingest |
| `DELETE /api/traces` | clear the in-memory store |

## Data handling notes

- Raw OTLP bodies exist only in server memory and are redacted from all logs.
- Retention rules are applied at **read time** on a deep copy; stored raw data is
  never mutated, so editing a rule re-processes history and previews stay truthful.
- Attribute keys repeated across layers are kept in full: the demo intentionally
  puts `http.request.id` on all three layers with different values.
- Duplicate keys within one attribute list are also retained (the layer stores an
  array, not a map), so no within-layer overwrite can occur either.

## Vendored protobuf definitions

`packages/backend/proto/` is an unmodified subset of
[open-telemetry/opentelemetry-proto](https://github.com/open-telemetry/opentelemetry-proto)
(trace-related protos plus LICENSE); the exact upstream revision is recorded in
`proto/SOURCE.txt`. Both the backend and the demo sender load these same files
via protobufjs — no hand-written wire schema is used.
