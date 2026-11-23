import { useEffect, useRef, useState } from 'react';
import { get, post, fmtTime, fmtNum } from '../api.js';
import { useApp } from '../context.js';
import { Card, Badge, Field, ErrorBox, Stat, useAsync } from '../components/ui.jsx';

const NAMES = {
  research_agent: 'Strategy Research Agent (Agent 1)',
  evaluation_agent: 'Evaluation & Ranking Agent (Agent 2)',
};
const ALL_TIMEFRAMES = ['1m', '5m', '10m', '1H', '4H'];

export default function Agents() {
  const { datasets, datasetId } = useApp();
  const [status, setStatus] = useState(null);
  const [logs, setLogs] = useState({});
  const [evalSnap, setEvalSnap] = useState(null);
  const [regIndicators, setRegIndicators] = useState([]);
  const [form, setForm] = useState({
    algorithm: 'full_cycle',
    objective: 'net_profit',
    timeframes: ['1m', '5m', '1H'],
    start_date: '',
    end_date: '',
    indicator_names: [],
    cycles: 1,
    n_trials: 30,
    duration_limit_s: 0,
    max_indicators: 0,
    cpu_limit_pct: 85,
    ram_limit_mb: 256,
    population_size: 16,
    generations: 6,
    hill_climb_steps: 20,
    tuning_trials: 30,
    walk_forward_top_k: 5,
    initial_capital: 10000000,
    brokerage_per_order: 20,
    charges_pct: 0.0005,
    slippage_points: 0.5,
    seed: 42,
  });
  const { error, busy, run } = useAsync();
  const lastId = useRef({});

  const activeDs = datasets.find((d) => d.id === Number(datasetId)) || null;
  const minBoundDate = activeDs?.start_ts ? activeDs.start_ts.slice(0, 10) : '';
  const maxBoundDate = activeDs?.end_ts ? activeDs.end_ts.slice(0, 10) : '';

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
    } catch { /* polling continues */ }
  };

  useEffect(() => {
    refresh();
    get('/api/indicators').then((r) => setRegIndicators((r.indicators || []).filter((i) => i.available))).catch(() => {});
    const t = setInterval(refresh, 2000);
    return () => clearInterval(t);
  }, []);

  const toggleTf = (tf) => {
    setForm((prev) => {
      const exists = prev.timeframes.includes(tf);
      const next = exists ? prev.timeframes.filter((x) => x !== tf) : [...prev.timeframes, tf];
      return { ...prev, timeframes: next.length ? next : [tf] };
    });
  };

  const toggleIndFilter = (name) => {
    setForm((prev) => {
      const exists = prev.indicator_names.includes(name);
      return {
        ...prev,
        indicator_names: exists
          ? prev.indicator_names.filter((x) => x !== name)
          : [...prev.indicator_names, name],
      };
    });
  };

  const start = () => run(async () => {
    await post('/api/agents/start', {
      dataset_id: datasetId,
      ...form,
      start_date: form.start_date || null,
      end_date: form.end_date || null,
    });
    await refresh();
  });
  const control = (name, action) => run(async () => { await post(`/api/agents/${name}/${action}`); await refresh(); });
  const setNum = (k) => (e) => setForm({ ...form, [k]: Number(e.target.value) });
  const setStr = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const agents = status ? status.agents : [];
  const anyRunning = agents.some((a) => a.alive);
  const cat = status?.catalogue || { indicators: 0, strategies: 0 };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>AI Agents</h1>
          <div className="muted">
            Autonomous multi-timeframe combination discovery across registered custom indicators and strategies. Agents explore k=1..N combinations with strict chronological train/validation splits.
          </div>
        </div>
        <div className="card-actions">
          <span className="badge info">Dynamic Catalogue · Multi-Timeframe Search</span>
        </div>
      </div>

      <div className="grid stats" style={{ marginBottom: 14 }}>
        <Stat label="Registered Indicators" value={cat.indicators} tone={cat.indicators ? 'good' : ''} hint="available to Agent 1" />
        <Stat label="Registered Strategies" value={cat.strategies} tone={cat.strategies ? 'good' : ''} hint="available to Agent 1" />
        <Stat label="Selected Timeframes" value={form.timeframes.join(', ')} hint="NSE session-anchored candles" />
        <Stat label="Combination Ceiling" value={form.max_indicators === 0 ? 'Unlimited' : `Up to ${form.max_indicators}`} hint="k=1, 2, 3, 4+ indicators" />
      </div>

      <ErrorBox error={error} />

      <Card
        title="Multi-Timeframe Discovery &amp; Cost Budget Configuration"
        actions={
          <button
            className="primary"
            disabled={busy || anyRunning || !datasetId || (cat.indicators === 0 && cat.strategies === 0)}
            onClick={start}
          >
            Start Agents
          </button>
        }
      >
        <div style={{ marginBottom: 12 }}>
          <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>Search Timeframes</div>
          <div className="pill-row">
            {ALL_TIMEFRAMES.map((tf) => (
              <button
                key={tf}
                type="button"
                className={form.timeframes.includes(tf) ? 'primary' : ''}
                onClick={() => toggleTf(tf)}
              >
                {tf}
              </button>
            ))}
          </div>
        </div>

        {regIndicators.length > 0 && (
          <div style={{ marginBottom: 12 }}>
            <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
              Indicator Search Space ({form.indicator_names.length ? `${form.indicator_names.length} selected` : 'All registered indicators active'})
            </div>
            <div className="pill-row">
              {regIndicators.map((ind) => {
                const active = form.indicator_names.includes(ind.name);
                return (
                  <button
                    key={ind.name}
                    type="button"
                    className={`tab ${active ? 'active' : ''}`}
                    onClick={() => toggleIndFilter(ind.name)}
                  >
                    {ind.name}
                  </button>
                );
              })}
              {form.indicator_names.length > 0 && (
                <button type="button" className="ghost" onClick={() => setForm({ ...form, indicator_names: [] })}>
                  Reset to All
                </button>
              )}
            </div>
          </div>
        )}

        <div className="form-grid">
          <Field label="Search Algorithm">
            <select value={form.algorithm} onChange={setStr('algorithm')}>
              <option value="full_cycle">Full Cycle (FS → BE → GA → HC → TPE → WF)</option>
              <option value="tpe">Optuna TPE</option>
              <option value="ga">Genetic Algorithm</option>
              <option value="forward">Forward Selection</option>
              <option value="backward">Backward Elimination</option>
              <option value="hill">Hill Climbing</option>
              <option value="nsga2">NSGA-II Multi-Objective</option>
            </select>
          </Field>
          <Field label="Optimization Objective">
            <select value={form.objective} onChange={setStr('objective')}>
              <option value="net_profit">Net Profit</option>
              <option value="sharpe_ratio">Sharpe Ratio</option>
              <option value="sortino_ratio">Sortino Ratio</option>
              <option value="profit_factor">Profit Factor</option>
              <option value="recovery_factor">Risk-Adjusted (Recovery Factor)</option>
              <option value="min_drawdown">Lowest Max Drawdown</option>
            </select>
          </Field>
          <Field label="Start Date (optional)" hint={minBoundDate ? `min ${minBoundDate}` : ''}>
            <input type="date" min={minBoundDate} max={maxBoundDate} value={form.start_date} onChange={setStr('start_date')} />
          </Field>
          <Field label="End Date (optional)" hint={maxBoundDate ? `max ${maxBoundDate}` : ''}>
            <input type="date" min={minBoundDate} max={maxBoundDate} value={form.end_date} onChange={setStr('end_date')} />
          </Field>
          <Field label="Trial Budget" hint="0 = derived from cycles">
            <input type="number" min="0" value={form.n_trials} onChange={setNum('n_trials')} />
          </Field>
          <Field label="Search Duration (sec)" hint="0 = unlimited">
            <input type="number" min="0" value={form.duration_limit_s} onChange={setNum('duration_limit_s')} />
          </Field>
          <Field label="Max Indicators / Combo" hint="0 = unlimited (all registered)">
            <input type="number" min="0" value={form.max_indicators} onChange={setNum('max_indicators')} />
          </Field>
          <Field label="Initial Capital">
            <input type="number" min="1000" value={form.initial_capital} onChange={setNum('initial_capital')} />
          </Field>
          <Field label="Brokerage / Order">
            <input type="number" step="0.5" min="0" value={form.brokerage_per_order} onChange={setNum('brokerage_per_order')} />
          </Field>
          <Field label="Taxes &amp; Charges (frac)">
            <input type="number" step="0.0001" min="0" value={form.charges_pct} onChange={setNum('charges_pct')} />
          </Field>
          <Field label="Slippage (points)">
            <input type="number" step="0.1" min="0" value={form.slippage_points} onChange={setNum('slippage_points')} />
          </Field>
          <Field label="Walk-Forward Top K">
            <input type="number" min="1" value={form.walk_forward_top_k} onChange={setNum('walk_forward_top_k')} />
          </Field>
          <Field label="CPU Throttle (%)">
            <input type="number" min="10" max="100" value={form.cpu_limit_pct} onChange={setNum('cpu_limit_pct')} />
          </Field>
          <Field label="Memory Limit (MB)">
            <input type="number" min="64" max="4096" step="64" value={form.ram_limit_mb} onChange={setNum('ram_limit_mb')} />
          </Field>
          <Field label="Random Seed">
            <input type="number" value={form.seed} onChange={setNum('seed')} />
          </Field>
        </div>
        {!datasetId && <div className="info-box">Import or generate a dataset from Market Data or the top bar first.</div>}
        {datasetId && cat.indicators === 0 && cat.strategies === 0 && (
          <div className="info-box">
            No custom indicators or strategies are registered yet. Author and click <strong>Update Indicator</strong> or <strong>Update Strategy</strong> in the Studios first.
          </div>
        )}
      </Card>

      <div className="grid two">
        {agents.map((a) => (
          <Card
            key={a.name}
            title={NAMES[a.name] || a.name}
            actions={
              <>
                <Badge status={a.status} />
                <button disabled={busy || !a.alive || a.status === 'paused'} onClick={() => control(a.name, 'pause')}>Pause</button>
                <button disabled={busy || !a.alive || a.status !== 'paused'} onClick={() => control(a.name, 'resume')}>Resume</button>
                <button className="danger" disabled={busy || !a.alive} onClick={() => control(a.name, 'stop')}>Stop</button>
              </>
            }
          >
            <dl className="kv">
              <dt>Current timeframe</dt><dd>{a.current_timeframe || '—'}</dd>
              <dt>Current combination</dt><dd className="mono">{a.current_combination || '—'}</dd>
              <dt>Current task</dt><dd>{a.current_task || '—'}</dd>
              <dt>Algorithm</dt><dd>{a.algorithm || '—'}</dd>
              <dt>Trials processed</dt><dd>{a.trials_processed}</dd>
              <dt>Error count</dt><dd>{a.error_count}</dd>
              <dt>Duplicates avoided</dt><dd>{a.duplicates_prevented ?? 0}</dd>
              <dt>Last heartbeat</dt><dd>{fmtTime(a.last_heartbeat)}</dd>
              <dt>Uptime</dt><dd>{a.uptime_s == null ? '—' : `${a.uptime_s}s`}</dd>
            </dl>
            <div style={{ margin: '12px 0 4px' }} className="muted">Progress {fmtNum((a.progress || 0) * 100, 0)}%</div>
            <div className="progress"><div style={{ width: `${Math.round((a.progress || 0) * 100)}%` }} /></div>
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
