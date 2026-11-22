import { useEffect, useRef, useState } from 'react';
import { get, post, fmtTime, fmtNum } from '../api.js';
import { useApp } from '../context.js';
import { Card, Badge, Field, ErrorBox, useAsync } from '../components/ui.jsx';

const NAMES = { research_agent: 'Strategy Research Agent (Agent 1)', evaluation_agent: 'Evaluation & Ranking Agent (Agent 2)' };

export default function Agents() {
  const { datasetId } = useApp();
  const [status, setStatus] = useState(null);
  const [logs, setLogs] = useState({});
  const [evalSnap, setEvalSnap] = useState(null);
  const [form, setForm] = useState({ cycles: 1, population_size: 16, generations: 6, hill_climb_steps: 20,
    tuning_trials: 30, walk_forward_top_k: 5, max_indicators: 4, seed: 42 });
  const { error, busy, run } = useAsync();
  const lastId = useRef({});

  const refresh = async () => {
    try {
      const s = await get('/api/agents');
      setStatus(s);
      setEvalSnap(await get('/api/agents/evaluation/snapshot'));
      for (const a of s.agents) {
        const after = lastId.current[a.name] || 0;
        const rows = await get(`/api/agents/${a.name}/logs?after=${after}&limit=300`);
        if (rows.length) {
          lastId.current[a.name] = rows[rows.length - 1].id;
          setLogs((prev) => ({ ...prev, [a.name]: [...(prev[a.name] || []), ...rows].slice(-500) }));
        }
      }
    } catch { /* surfaced by the controls; polling continues */ }
  };

  useEffect(() => { refresh(); const t = setInterval(refresh, 2000); return () => clearInterval(t); }, []);

  const start = () => run(async () => {
    await post('/api/agents/start', { dataset_id: datasetId, ...form, cycles: Number(form.cycles) });
    await refresh();
  });
  const control = (name, action) => run(async () => { await post(`/api/agents/${name}/${action}`); await refresh(); });
  const setF = (k) => (e) => setForm({ ...form, [k]: Number(e.target.value) });

  const agents = status ? status.agents : [];
  const anyRunning = agents.some((a) => a.alive);
  return (
    <>
      <div className="page-head"><div><h1>AI Agents</h1><div className="muted">Two autonomous workers. Every status below comes from the worker's live state and the database.</div></div></div>
      <ErrorBox error={error} />
      <Card title="Start agents" actions={<button className="primary" disabled={busy || anyRunning || !datasetId} onClick={start}>Start agents</button>}>
        <div className="form-grid">
          <Field label="Cycles (0 = continuous)"><input type="number" min="0" value={form.cycles} onChange={setF('cycles')} /></Field>
          <Field label="Population size"><input type="number" min="4" value={form.population_size} onChange={setF('population_size')} /></Field>
          <Field label="GA generations"><input type="number" min="1" value={form.generations} onChange={setF('generations')} /></Field>
          <Field label="Hill-climb steps"><input type="number" min="0" value={form.hill_climb_steps} onChange={setF('hill_climb_steps')} /></Field>
          <Field label="Optuna tuning trials"><input type="number" min="0" value={form.tuning_trials} onChange={setF('tuning_trials')} /></Field>
          <Field label="Walk-forward top K"><input type="number" min="1" value={form.walk_forward_top_k} onChange={setF('walk_forward_top_k')} /></Field>
          <Field label="Max indicators per strategy" hint="1 to 6"><input type="number" min="1" max="6" value={form.max_indicators} onChange={setF('max_indicators')} /></Field>
          <Field label="Random seed"><input type="number" value={form.seed} onChange={setF('seed')} /></Field>
        </div>
        {!datasetId && <div className="muted" style={{ marginTop: 10 }}>Import a dataset first.</div>}
      </Card>
      <div className="grid two">
        {agents.map((a) => (
          <Card key={a.name} title={NAMES[a.name] || a.name}
            actions={<>
              <Badge status={a.status} />
              <button disabled={busy || !a.alive || a.status === 'paused'} onClick={() => control(a.name, 'pause')}>Pause</button>
              <button disabled={busy || !a.alive || a.status !== 'paused'} onClick={() => control(a.name, 'resume')}>Resume</button>
              <button className="danger" disabled={busy || !a.alive} onClick={() => control(a.name, 'stop')}>Stop</button>
            </>}>
            <dl className="kv">
              <dt>Current task</dt><dd>{a.current_task || '—'}</dd>
              <dt>Algorithm</dt><dd>{a.algorithm || '—'}</dd>
              <dt>Trials processed</dt><dd>{a.trials_processed}</dd>
              <dt>Error count</dt><dd>{a.error_count}</dd>
              <dt>Duplicates avoided</dt><dd>{a.duplicates_prevented ?? 0}</dd>
              <dt>Last heartbeat</dt><dd>{fmtTime(a.last_heartbeat)}</dd>
              <dt>Uptime</dt><dd>{a.uptime_s == null ? '—' : `${a.uptime_s}s`}</dd>
            </dl>
            <div style={{ margin: '12px 0 4px' }} className="muted">Progress {fmtNum(a.progress * 100, 0)}%</div>
            <div className="progress"><div style={{ width: `${Math.round(a.progress * 100)}%` }} /></div>
            <div style={{ marginTop: 12 }} className="log">
              {(logs[a.name] || []).map((l) => (
                <div key={l.id} className={l.level}>[{new Date(l.ts).toLocaleTimeString()}] {l.message}</div>
              ))}
              {!(logs[a.name] || []).length && <div className="muted">No log lines yet.</div>}
            </div>
          </Card>
        ))}
      </div>
      {evalSnap && evalSnap.audit && (
        <Card title="Ledger audit (Agent 2)">
          <dl className="kv">
            <dt>Status</dt><dd><Badge status={evalSnap.audit.status} /></dd>
            <dt>Completed experiments</dt><dd>{evalSnap.audit.completed}</dd>
            <dt>Failed / pruned</dt><dd>{evalSnap.audit.failed} / {evalSnap.audit.pruned}</dd>
            <dt>Missing metrics</dt><dd>{evalSnap.audit.missing_metrics}</dd>
            <dt>Eligibility mismatches</dt><dd>{evalSnap.audit.eligibility_mismatches}</dd>
            <dt>Duplicate completed rows</dt><dd>{evalSnap.audit.duplicate_completed_rows}</dd>
            <dt>Snapshot updated</dt><dd>{fmtTime(evalSnap.updated_at)}</dd>
          </dl>
        </Card>
      )}
    </>
  );
}
