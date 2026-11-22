// Attribute retention rules.
// Rules apply PER LAYER (resource / scope / span) — the layers stay separate
// end to end. Each rule:
//   { id, layer: 'resource'|'scope'|'span'|'any',
//     match: 'exact'|'prefix'|'suffix'|'regex'|'wildcard',
//     pattern, action: 'keep'|'drop'|'redact', enabled }
// First matching enabled rule wins; unmatched attributes are kept by default.

import { randomUUID } from 'node:crypto';

export const LAYERS = ['resource', 'scope', 'span'];

export function defaultRules() {
  return [
    {
      id: randomUUID(),
      layer: 'span',
      match: 'prefix',
      pattern: 'http.',
      action: 'keep',
      enabled: true,
    },
    {
      id: randomUUID(),
      layer: 'any',
      match: 'regex',
      pattern: '(?i)(token|password|secret|apikey|authorization)',
      action: 'redact',
      enabled: true,
    },
    {
      id: randomUUID(),
      layer: 'span',
      match: 'exact',
      pattern: 'peer.service',
      action: 'keep',
      enabled: true,
    },
  ];
}

function ruleAppliesToLayer(rule, layer) {
  return rule.layer === 'any' || rule.layer === layer;
}

function compileRegex(pattern) {
  // Accept the common (?i) inline flag (OTEL config style); JS RegExp needs it
  // as a real flag instead.
  let body = pattern;
  let flags = '';
  const inline = /^\(\?([imsu]+)\)/.exec(pattern);
  if (inline) {
    flags = inline[1];
    body = pattern.slice(inline[0].length);
  }
  return new RegExp(body, flags);
}

function patternMatches(key, rule) {
  const p = rule.pattern ?? '';
  switch (rule.match) {
    case 'exact':
      return key === p;
    case 'prefix':
      return key.startsWith(p);
    case 'suffix':
      return key.endsWith(p);
    case 'wildcard': {
      const escaped = p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
      return new RegExp(`^${escaped}$`).test(key);
    }
    case 'regex': {
      try {
        return compileRegex(p).test(key);
      } catch {
        return false;
      }
    }
    default:
      return false;
  }
}

function findRule(rules, layer, key) {
  return (rules ?? []).find(
    (r) => r.enabled !== false && ruleAppliesToLayer(r, layer) && patternMatches(key, r),
  );
}

const REDACTED = '[REDACTED]';

/** Apply rules to one normalized attribute list; returns a new list with per-attr decision. */
export function applyRules(attributes, rules, layer) {
  return (attributes ?? []).map((attr) => {
    const rule = findRule(rules, layer, attr.key);
    if (!rule) {
      return { ...attr, retained: true, action: 'keep', ruleId: null };
    }
    if (rule.action === 'drop') {
      return { ...attr, retained: false, action: 'drop', ruleId: rule.id };
    }
    if (rule.action === 'redact') {
      return { ...attr, value: REDACTED, retained: true, action: 'redact', ruleId: rule.id };
    }
    return { ...attr, retained: true, action: 'keep', ruleId: rule.id };
  });
}

/**
 * Preview rules against a normalized ingest record (see normalizer output).
 * Returns, per layer, every attribute with the decision that would be made.
 * Nothing here mutates the stored raw record.
 */
export function previewRules(ingest, rules) {
  const preview = {
    ingestId: ingest.ingestId,
    transport: ingest.transport,
    layers: Object.fromEntries(LAYERS.map((l) => [l, { kept: 0, redacted: 0, dropped: 0, rows: [] }])),
  };
  for (const group of ingest.groups) {
    for (const attr of group.resource.attributes) {
      pushPreview(preview, 'resource', attr, rules);
    }
    for (const scopeGroup of group.scopes) {
      for (const attr of scopeGroup.scope.attributes) {
        pushPreview(preview, 'scope', attr, rules);
      }
      for (const span of scopeGroup.spans) {
        for (const attr of span.attributes) {
          pushPreview(preview, 'span', attr, rules);
        }
      }
    }
  }
  return preview;
}

function pushPreview(preview, layer, attr, rules) {
  const rule = findRule(rules, layer, attr.key);
  const action = rule ? rule.action : 'keep';
  const row = {
    layer,
    key: attr.key,
    type: attr.type,
    sampleValue: summarizeValue(attr.value),
    action,
    ruleId: rule?.id ?? null,
    pattern: rule ? `${rule.layer}:${rule.match}(${rule.pattern})` : '(no rule — default keep)',
  };
  preview.layers[layer].rows.push(row);
  if (action === 'drop') preview.layers[layer].dropped += 1;
  else if (action === 'redact') preview.layers[layer].redacted += 1;
  else preview.layers[layer].kept += 1;
}

function summarizeValue(value) {
  if (value === null) return 'null';
  if (typeof value === 'string') return value.length > 80 ? `${value.slice(0, 77)}...` : value;
  if (Array.isArray(value)) return `[array: ${value.length} items]`;
  if (typeof value === 'object') return '{object}';
  return String(value);
}

/** Apply rules to a full normalized ingest; returns a processed deep copy. */
export function processIngest(ingest, rules) {
  const copy = structuredClone(ingest);
  for (const group of copy.groups) {
    group.resource.attributes = applyRules(group.resource.attributes, rules, 'resource');
    for (const scopeGroup of group.scopes) {
      scopeGroup.scope.attributes = applyRules(scopeGroup.scope.attributes, rules, 'scope');
      for (const span of scopeGroup.spans) {
        span.attributes = applyRules(span.attributes, rules, 'span');
      }
    }
  }
  copy.processed = true;
  return copy;
}
