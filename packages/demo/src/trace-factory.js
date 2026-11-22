// Builds the demo scenario as OTLP ExportTraceServiceRequest objects (plain JS,
// OTLP JSON shape). The same in-memory object is sent twice by send.js — once
// as JSON and once as Protobuf — so results can be cross-checked across
// encodings.
//
// Scenarios:
//   1. gateway -> checkout -> [inventory, payment (parallel)] -> postgres
//      cross-service call with parallel children, one error span
//   2. external parent (parentSpanId points outside the batch)
//   3. span link (association, NOT a parent edge)
//   4. parent-child cycle (A->B->A)
//   5. duplicate spanId (identical retransmit + conflicting copy)
//   6. bad time interval (negative duration + future timestamp)

let counter = 0;
function spanId() {
  counter += 1;
  return counter.toString(16).padStart(16, '0');
}
function traceId(seed) {
  return seed.repeat(8).padStart(32, '0').slice(0, 32);
}

const NANOS_PER_MS = 1_000_000n;
const t = (ms) => String(BigInt(ms) * NANOS_PER_MS);

function str(v) { return { stringValue: v }; }
function int(v) { return { intValue: String(v) }; }
function kv(key, value) { return { key, value }; }

const RES = {
  gateway: {
    attributes: [
      kv('service.name', str('api-gateway')),
      kv('service.version', str('2.4.1')),
      kv('deployment.environment', str('demo')),
      // Same key exists on span/scope layers on purpose: proves layering is kept.
      kv('http.request.id', str('resource-layer-value')),
    ],
  },
  checkout: {
    attributes: [
      kv('service.name', str('checkout-service')),
      kv('service.version', str('1.8.0')),
      kv('deployment.environment', str('demo')),
    ],
  },
  inventory: {
    attributes: [
      kv('service.name', str('inventory-service')),
      kv('service.version', str('3.0.2')),
    ],
  },
  payment: {
    attributes: [
      kv('service.name', str('payment-service')),
      kv('service.version', str('0.9.7')),
    ],
  },
};

function scope(name, version, extraAttrs = []) {
  return {
    scope: {
      name,
      version,
      attributes: [
        kv('scope.internal.pipeline', str('otlp-demo')),
        kv('http.request.id', str('scope-layer-value')),
        ...extraAttrs,
      ],
    },
  };
}

const baseMs = Date.now() - 60_000;

// --- Scenario 1: main cross-service trace with parallel calls + error ------
function buildMainTrace() {
  const tid = traceId('a1');
  const gwId = spanId();
  const checkoutId = spanId();
  const inventoryId = spanId();
  const paymentId = spanId();
  const dbId = spanId();

  const gatewaySpan = {
    traceId: tid,
    spanId: gwId,
    parentSpanId: '',
    name: 'POST /checkout',
    kind: 2, // SERVER
    startTimeUnixNano: t(baseMs + 0),
    endTimeUnixNano: t(baseMs + 420),
    status: { code: 2, message: 'downstream payment failure' },
    attributes: [
      kv('http.request.method', str('POST')),
      kv('url.path', str('/checkout')),
      kv('http.request.id', str('span-layer-value')),
      kv('user.id', str('user-4821')),
      kv('auth.token', str('Bearer eyJ-secret-demo-token')),
    ],
    events: [
      {
        timeUnixNano: t(baseMs + 20),
        name: 'request.received',
        attributes: [kv('event.severity', str('info'))],
      },
    ],
    links: [],
  };

  const checkoutSpan = {
    traceId: tid,
    spanId: checkoutId,
    parentSpanId: gwId,
    name: 'checkout.workflow',
    kind: 1, // INTERNAL
    startTimeUnixNano: t(baseMs + 30),
    endTimeUnixNano: t(baseMs + 380),
    status: { code: 0 },
    attributes: [
      kv('order.id', str('ORD-99001')),
      kv('checkout.items', int(3)),
    ],
    events: [],
    links: [],
  };

  // Two children of checkout with overlapping time windows -> parallel calls.
  const inventorySpan = {
    traceId: tid,
    spanId: inventoryId,
    parentSpanId: checkoutId,
    name: 'GET inventory/reserve',
    kind: 3, // CLIENT
    startTimeUnixNano: t(baseMs + 60),
    endTimeUnixNano: t(baseMs + 150),
    status: { code: 1 }, // OK
    attributes: [
      kv('http.request.method', str('GET')),
      kv('server.address', str('inventory.internal')),
      kv('peer.service', str('inventory-service')),
    ],
    events: [],
    links: [],
  };

  const paymentSpan = {
    traceId: tid,
    spanId: paymentId,
    parentSpanId: checkoutId,
    name: 'POST payment/charge',
    kind: 3,
    startTimeUnixNano: t(baseMs + 70), // overlaps inventory -> parallel
    endTimeUnixNano: t(baseMs + 300),
    status: { code: 2, message: 'card declined: issuer timeout' },
    attributes: [
      kv('http.request.method', str('POST')),
      kv('server.address', str('payment.internal')),
      kv('peer.service', str('payment-service')),
      kv('payment.amount', int(12999)),
      kv('error.type', str('PaymentGatewayTimeout')),
      kv('error.message', str('card declined: issuer timeout')),
    ],
    events: [
      {
        timeUnixNano: t(baseMs + 280),
        name: 'exception',
        attributes: [
          kv('exception.type', str('PaymentGatewayTimeout')),
          kv('exception.message', str('card declined: issuer timeout')),
          kv('exception.stacktrace', str('at PaymentClient.charge (payment.js:42)')),
        ],
      },
    ],
    links: [],
  };

  const dbSpan = {
    traceId: tid,
    spanId: dbId,
    parentSpanId: paymentId,
    name: 'SELECT payments FOR UPDATE',
    kind: 1,
    startTimeUnixNano: t(baseMs + 90),
    endTimeUnixNano: t(baseMs + 130),
    status: { code: 0 },
    attributes: [
      kv('db.system', str('postgresql')),
      kv('db.statement', str('SELECT * FROM payments WHERE order_id=$1 FOR UPDATE')),
    ],
    events: [],
    links: [],
  };

  return {
    resourceSpans: [
      {
        resource: RES.gateway,
        scopeSpans: [
          {
            ...scope('demo.gateway', '1.0.0'),
            spans: [gatewaySpan],
          },
        ],
      },
      {
        resource: RES.checkout,
        scopeSpans: [
          {
            ...scope('demo.checkout', '1.0.0'),
            spans: [checkoutSpan],
          },
        ],
      },
      {
        resource: RES.inventory,
        scopeSpans: [
          {
            ...scope('demo.inventory', '1.0.0'),
            spans: [inventorySpan],
          },
        ],
      },
      {
        resource: RES.payment,
        scopeSpans: [
          {
            ...scope('demo.payment', '1.0.0'),
            spans: [paymentSpan, dbSpan],
          },
        ],
      },
    ],
  };
}

// --- Scenario 2: external parent (not present in this receive batch) --------
function buildExternalParentTrace() {
  const tid = traceId('b2');
  const child = spanId();
  return {
    resourceSpans: [
      {
        resource: { attributes: [kv('service.name', str('edge-worker'))] },
        scopeSpans: [
          {
            ...scope('demo.edge', '1.0.0'),
            spans: [
              {
                traceId: tid,
                spanId: child,
                parentSpanId: 'fedcba9876543210', // exists upstream only
                name: 'worker.process job',
                kind: 5, // CONSUMER
                startTimeUnixNano: t(baseMs + 500),
                endTimeUnixNano: t(baseMs + 720),
                status: { code: 0 },
                attributes: [kv('messaging.system', str('kafka'))],
                events: [],
                links: [],
              },
            ],
          },
        ],
      },
    ],
  };
}

// --- Scenario 3: span link (association to another trace, not parent) -------
function buildLinkTrace() {
  const tid = traceId('c3');
  const producer = spanId();
  const linkedConsumer = spanId();
  const otherTraceId = traceId('d4');
  const linkedSpanId = spanId();
  return {
    resourceSpans: [
      {
        resource: { attributes: [kv('service.name', str('async-pipeline'))] },
        scopeSpans: [
          {
            ...scope('demo.async', '1.0.0'),
            spans: [
              {
                traceId: tid,
                spanId: producer,
                parentSpanId: '',
                name: 'publish event',
                kind: 4, // PRODUCER
                startTimeUnixNano: t(baseMs + 800),
                endTimeUnixNano: t(baseMs + 840),
                status: { code: 0 },
                attributes: [kv('messaging.destination', str('orders.events'))],
                events: [],
                links: [],
              },
              {
                traceId: tid,
                spanId: linkedConsumer,
                parentSpanId: producer,
                name: 'consume event',
                kind: 5,
                startTimeUnixNano: t(baseMs + 900),
                endTimeUnixNano: t(baseMs + 980),
                status: { code: 0 },
                attributes: [kv('messaging.system', str('kafka'))],
                events: [],
                links: [
                  {
                    traceId: otherTraceId,
                    spanId: linkedSpanId,
                    traceState: '',
                    attributes: [kv('link.reason', str('batch-retry-correlation'))],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

// --- Scenario 4: parent-child cycle A -> B -> A -----------------------------
function buildCycleTrace() {
  const tid = traceId('e5');
  const a = spanId();
  const b = spanId();
  return {
    resourceSpans: [
      {
        resource: { attributes: [kv('service.name', str('broken-orchestrator'))] },
        scopeSpans: [
          {
            ...scope('demo.cycle', '1.0.0'),
            spans: [
              {
                traceId: tid,
                spanId: a,
                parentSpanId: b,
                name: 'orchestrator.step-a',
                kind: 1,
                startTimeUnixNano: t(baseMs + 1000),
                endTimeUnixNano: t(baseMs + 1100),
                status: { code: 0 },
                attributes: [],
                events: [],
                links: [],
              },
              {
                traceId: tid,
                spanId: b,
                parentSpanId: a,
                name: 'orchestrator.step-b',
                kind: 1,
                startTimeUnixNano: t(baseMs + 1020),
                endTimeUnixNano: t(baseMs + 1120),
                status: { code: 0 },
                attributes: [],
                events: [],
                links: [],
              },
            ],
          },
        ],
      },
    ],
  };
}

// --- Scenario 5: duplicate span identifiers --------------------------------
function buildDuplicateTrace() {
  const tid = traceId('f6');
  const dupId = spanId();
  const parent = spanId();
  const identicalCopy = {
    traceId: tid,
    spanId: dupId,
    parentSpanId: parent,
    name: 'idempotent.retry',
    kind: 1,
    startTimeUnixNano: t(baseMs + 1200),
    endTimeUnixNano: t(baseMs + 1250),
    status: { code: 0 },
    attributes: [kv('attempt', int(1))],
    events: [],
    links: [],
  };
  return {
    resourceSpans: [
      {
        resource: { attributes: [kv('service.name', str('retry-service'))] },
        scopeSpans: [
          {
            ...scope('demo.dup', '1.0.0'),
            spans: [
              {
                traceId: tid,
                spanId: parent,
                parentSpanId: '',
                name: 'retry.parent',
                kind: 1,
                startTimeUnixNano: t(baseMs + 1180),
                endTimeUnixNano: t(baseMs + 1280),
                status: { code: 0 },
                attributes: [],
                events: [],
                links: [],
              },
              structuredClone(identicalCopy),
              structuredClone(identicalCopy), // identical retransmission
              {
                // same spanId, DIFFERENT content -> conflicting duplicate
                traceId: tid,
                spanId: dupId,
                parentSpanId: parent,
                name: 'idempotent.retry (conflicting copy)',
                kind: 3,
                startTimeUnixNano: t(baseMs + 1210),
                endTimeUnixNano: t(baseMs + 1290),
                status: { code: 2, message: 'conflicting status reported' },
                attributes: [kv('attempt', int(2)), kv('error.type', str('Conflict'))],
                events: [],
                links: [],
              },
            ],
          },
        ],
      },
    ],
  };
}

// --- Scenario 6: unreasonable time intervals --------------------------------
function buildBadTimeTrace() {
  const tid = traceId('a7');
  const neg = spanId();
  const future = spanId();
  return {
    resourceSpans: [
      {
        resource: { attributes: [kv('service.name', str('clock-skew-service'))] },
        scopeSpans: [
          {
            ...scope('demo.time', '1.0.0'),
            spans: [
              {
                traceId: tid,
                spanId: neg,
                parentSpanId: '',
                name: 'negative.duration',
                kind: 1,
                startTimeUnixNano: t(baseMs + 2000),
                endTimeUnixNano: t(baseMs + 1900), // ends before it starts
                status: { code: 0 },
                attributes: [],
                events: [],
                links: [],
              },
              {
                traceId: tid,
                spanId: future,
                parentSpanId: neg,
                name: 'future.timestamp',
                kind: 1,
                startTimeUnixNano: t(Date.now() + 90 * 24 * 3600 * 1000),
                endTimeUnixNano: t(Date.now() + 90 * 24 * 3600 * 1000 + 50),
                status: { code: 0 },
                attributes: [],
                events: [],
                links: [],
              },
            ],
          },
        ],
      },
    ],
  };
}

/** All scenarios merged into one OTLP request (same events -> JSON & protobuf). */
export function buildDemoRequest() {
  const parts = [
    buildMainTrace(),
    buildExternalParentTrace(),
    buildLinkTrace(),
    buildCycleTrace(),
    buildDuplicateTrace(),
    buildBadTimeTrace(),
  ];
  return {
    resourceSpans: parts.flatMap((p) => p.resourceSpans),
  };
}

export const SCENARIO_SUMMARY = [
  { seed: 'a1...', name: 'cross-service trace with parallel calls + error span' },
  { seed: 'b2...', name: 'external parent (parent outside receive batch)' },
  { seed: 'c3...', name: 'span link rendered as association, not parent' },
  { seed: 'e5...', name: 'parent-child cycle A->B->A' },
  { seed: 'f6...', name: 'duplicate spanId (identical + conflicting copies)' },
  { seed: 'a7...', name: 'negative duration and future timestamp' },
];
