import { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';
import TraceList from './components/TraceList.jsx';
import TraceDetail from './components/TraceDetail.jsx';
import RulesPage from './components/RulesPage.jsx';

export default function App() {
  const [traces, setTraces] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [page, setPage] = useState('traces'); // traces | rules
  const [loading, setLoading] = useState(false);
  const [health, setHealth] = useState('checking…');

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.listTraces();
      setTraces(data.traces);
    } catch (e) {
      setHealth(`server unreachable: ${e.message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    api
      .health()
      .then(() => setHealth('receiver online'))
      .catch((e) => setHealth(`offline: ${e.message}`));
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, [refresh]);

  const clear = async () => {
    await api.clear();
    setSelectedId(null);
    refresh();
  };

  return (
    <div className="app">
      <TraceList
        traces={traces}
        selectedId={selectedId}
        loading={loading}
        onSelect={(id) => {
          setSelectedId(id);
          setPage('traces');
        }}
        onRefresh={refresh}
        onClear={clear}
        page={page}
        onPage={setPage}
        health={health}
      />
      <main className="main">
        <div className="flex mb-16" style={{ justifyContent: 'space-between' }}>
          <div className="nav-row" style={{ marginBottom: 0 }}>
            <button className={page === 'traces' ? 'primary' : ''} onClick={() => setPage('traces')}>
              Traces
            </button>
            <button className={page === 'rules' ? 'primary' : ''} onClick={() => setPage('rules')}>
              Collection &amp; retention rules
            </button>
          </div>
          <span className="badge">{health}</span>
        </div>

        {page === 'rules' ? (
          <RulesPage />
        ) : selectedId ? (
          <TraceDetail traceId={selectedId} />
        ) : (
          <div className="panel empty">
            Select a trace on the left, or send demo data:
            <pre className="raw" style={{ textAlign: 'left', marginTop: 12 }}>
              npm run demo          # sends the same events as JSON and as Protobuf
            </pre>
          </div>
        )}
      </main>
    </div>
  );
}
