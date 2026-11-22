// Collection page: retention rule editor + live preview against the latest raw
// ingest. Rule decisions are computed server-side from the stored raw record,
// which itself never leaves the store and is never written to logs.

import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';

const LAYERS = ['resource', 'scope', 'span', 'any'];
const MATCHES = ['exact', 'prefix', 'suffix', 'wildcard', 'regex'];
const ACTIONS = ['keep', 'drop', 'redact'];

function emptyRule() {
  return {
    id: crypto.randomUUID(),
    layer: 'span',
    match: 'prefix',
    pattern: '',
    action: 'keep',
    enabled: true,
  };
}

function RuleEditor({ rules, onChange, onSave, saving, error }) {
  const update = (id, patch) =>
    onChange(rules.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const remove = (id) => onChange(rules.filter((r) => r.id !== id));
  const add = () => onChange([...rules, emptyRule()]);

  return (
    <div className="panel">
      <h2 style={{ marginTop: 0 }}>Attribute retention rules</h2>
      <p className="muted small-text">
        First matching enabled rule wins per layer. Rules target one of the three stored layers
        (resource / scope / span) or all layers. Unmatched attributes are kept. Raw payloads are
        stored in memory only and never written to application logs.
      </p>
      <div className="rule-row header">
        <span>layer</span>
        <span>match</span>
        <span>pattern</span>
        <span>action</span>
        <span>enabled</span>
        <span />
      </div>
      {rules.map((rule) => (
        <div className="rule-row" key={rule.id}>
          <select value={rule.layer} onChange={(e) => update(rule.id, { layer: e.target.value })}>
            {LAYERS.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
          <select value={rule.match} onChange={(e) => update(rule.id, { match: e.target.value })}>
            {MATCHES.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
          <input
            value={rule.pattern}
            placeholder='e.g. http.  or  (?i)secret'
            onChange={(e) => update(rule.id, { pattern: e.target.value })}
          />
          <select value={rule.action} onChange={(e) => update(rule.id, { action: e.target.value })}>
            {ACTIONS.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
          <input
            type="checkbox"
            style={{ width: 'auto' }}
            checked={rule.enabled !== false}
            onChange={(e) => update(rule.id, { enabled: e.target.checked })}
          />
          <button className="small danger" onClick={() => remove(rule.id)}>✕</button>
        </div>
      ))}
      <div className="row-actions mt-12">
        <button onClick={add}>+ add rule</button>
        <button className="primary" onClick={onSave} disabled={saving}>
          {saving ? 'saving…' : 'save rules'}
        </button>
        {error && <span className="badge error">{error}</span>}
      </div>
    </div>
  );
}

function PreviewTable({ preview }) {
  if (!preview) return <div className="empty">No ingest received yet — run the demo sender first.</div>;
  const layerOrder = ['resource', 'scope', 'span'];
  return (
    <div className="panel">
      <h2 style={{ marginTop: 0 }}>
        Preview on latest ingest
        <span className={`badge ${preview.transport}`} style={{ marginLeft: 8 }}>
          {preview.transport}
        </span>
        <span className="mono muted small-text" style={{ marginLeft: 8 }}>{preview.ingestId}</span>
      </h2>
      <div className="preview-summary">
        {layerOrder.map((layer) => {
          const l = preview.layers[layer];
          return (
            <div className="stat-tile" key={layer}>
              <div className="label">{layer} layer</div>
              <div className="value">{l.kept + l.redacted + l.dropped}</div>
              <div className="small-text">
                <span style={{ color: 'var(--status-good)' }}>{l.kept} kept</span> ·{' '}
                <span style={{ color: 'var(--status-warning)' }}>{l.redacted} redacted</span> ·{' '}
                <span style={{ color: 'var(--status-critical)' }}>{l.dropped} dropped</span>
              </div>
            </div>
          );
        })}
      </div>
      {layerOrder.map((layer) => (
        <div key={layer}>
          <h3>{layer} attributes</h3>
          <table className="attr-table">
            <thead>
              <tr><th>key</th><th>type</th><th>sample value (raw)</th><th>decision</th><th>matched rule</th></tr>
            </thead>
            <tbody>
              {preview.layers[layer].rows.map((row, i) => (
                <tr key={`${row.key}-${i}`} className={row.action === 'drop' ? 'dropped' : row.action === 'redact' ? 'redacted' : ''}>
                  <td className="key">{row.key}</td>
                  <td className="muted">{row.type}</td>
                  <td className="val">{row.sampleValue}</td>
                  <td>
                    <span className={`badge ${row.action === 'drop' ? 'error' : row.action === 'redact' ? 'warn' : 'good'}`}>
                      {row.action}
                    </span>
                  </td>
                  <td className="muted small-text">{row.pattern}</td>
                </tr>
              ))}
              {!preview.layers[layer].rows.length && (
                <tr><td colSpan={5} className="muted">no attributes in this layer</td></tr>
              )}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}

export default function RulesPage() {
  const [rules, setRules] = useState([]);
  const [previewData, setPreviewData] = useState(null);
  const [ingests, setIngests] = useState([]);
  const [selectedIngest, setSelectedIngest] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const refresh = useMemo(
    () => async (ingestId = selectedIngest) => {
      const [rulesRes, ingestsRes, previewRes] = await Promise.all([
        api.getRules(),
        api.listIngests(),
        api.preview(ingestId || undefined).catch(() => null),
      ]);
      setRules(rulesRes.rules);
      setIngests(ingestsRes.ingests);
      if (previewRes) setPreviewData(previewRes.preview);
    },
    [selectedIngest],
  );

  useEffect(() => {
    refresh('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const rerunPreview = async (ingestId) => {
    setSelectedIngest(ingestId);
    const res = await api.preview(ingestId || undefined).catch(() => null);
    if (res) setPreviewData(res.preview);
  };

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      const res = await api.saveRules(rules);
      setRules(res.rules);
      const res2 = await api.preview(selectedIngest || undefined).catch(() => null);
      if (res2) setPreviewData(res2.preview);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <div className="panel">
        <h2 style={{ marginTop: 0 }}>Received ingests ({ingests.length})</h2>
        <p className="muted small-text">
          Bodies stay in server memory (redacted from all logs). Pick one to preview rule
          decisions against its raw attributes.
        </p>
        <div className="flex flex-wrap">
          <select value={selectedIngest} onChange={(e) => rerunPreview(e.target.value)} style={{ maxWidth: 420 }}>
            <option value="">latest ingest</option>
            {ingests.map((ing) => (
              <option key={ing.ingestId} value={ing.ingestId}>
                {ing.receivedAt} · {ing.transport} · {ing.spanCount} spans
              </option>
            ))}
          </select>
          <button onClick={() => rerunPreview(selectedIngest)}>re-run preview</button>
        </div>
      </div>
      <RuleEditor rules={rules} onChange={setRules} onSave={save} saving={saving} error={error} />
      <PreviewTable preview={previewData} />
    </div>
  );
}
