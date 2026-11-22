async function request(path, options = {}) {
  const res = await fetch(path, {
    headers: options.body ? { 'content-type': 'application/json' } : undefined,
    ...options,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${text}`);
  }
  return res.json();
}

export const api = {
  health: () => request('/api/health'),
  listTraces: () => request('/api/traces'),
  getTrace: (traceId, transport) =>
    request(`/api/traces/${encodeURIComponent(traceId)}${transport ? `?transport=${transport}` : ''}`),
  listIngests: () => request('/api/ingests'),
  getRules: () => request('/api/rules'),
  saveRules: (rules) => request('/api/rules', { method: 'PUT', body: JSON.stringify({ rules }) }),
  preview: (ingestId) =>
    request(`/api/preview${ingestId ? `?ingestId=${encodeURIComponent(ingestId)}` : ''}`),
  clear: () => request('/api/traces', { method: 'DELETE' }),
};
