import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { get, fmtMoney, fmtPct, fmtNum, fmtTime } from '../api.js';
import { useApp } from '../context.js';
import { Card, Stat, Badge, Table, ErrorBox } from '../components/ui.jsx';

export default function Dashboard() {
  const { datasetId } = useApp();
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const q = datasetId ? `?dataset_id=${datasetId}` : '';
        const r = await get(`/api/dashboard${q}`);
        if (alive) { setD(r); setError(null); }
      } catch (e) { if (alive) setError(e.message); }
    };
    load();
    const timer = setInterval(load, 4000);
    return () => { alive = false; clearInterval(timer); };
  }, [datasetId]);

  if (!d) return <><h1>Dashboard</h1><ErrorBox error={error} />{!error && <div className="muted">Loading…</div>}</>;
  const t = d.trials;
  const totalTrials = t.completed + t.pruned + t.failed + t.running;
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Dashboard</h1>
          <div className="muted">Live figures from the dynamic custom registries, database ledger, and autonomous workers</div>
        </div>
        <div className="card-actions">
          <Link to="/indicator-studio"><button>+ Indicator Studio</button></Link>
          <Link to="/strategy-studio"><button className="primary">+ Strategy Studio</button></Link>
        </div>
      </div>
      <ErrorBox error={error} />
      <div className="grid stats">
        <Stat label="Custom Indicators" value={d.indicators} hint={`${d.indicators_total ?? d.indicators} total in studio`} />
        <Stat label="Custom Strategies" value={d.strategies_registered ?? 0} hint={`${d.strategies_total ?? 0} total in studio`} />
        <Stat label="Combinations Tested" value={d.strategies_discovered} hint={`${d.eligible_strategies} eligible · ${d.validated_strategies} validated`} />
        <Stat label="Total Trials" value={totalTrials} hint={`${t.completed} complete · ${t.pruned} pruned · ${t.failed} failed`} />
        <Stat label="Best Net Profit" value={d.best_net_profit === null ? '—' : fmtMoney(d.best_net_profit)} hint="eligible, train split" />
        <Stat label="Best Sharpe Ratio" value={d.best_sharpe_ratio === null || d.best_sharpe_ratio === undefined ? '—' : fmtNum(d.best_sharpe_ratio)} hint="annualized, train split" />
        <Stat label="Best Win Rate" value={d.best_win_rate === null ? '—' : fmtPct(d.best_win_rate)} hint="eligible, train split" />
      </div>
      <div className="split-2" style={{ marginTop: 14 }}>
        <Card title="System status">
          <div className="grid stats">
            <Stat label="CPU" value={fmtPct(d.system.cpu_percent, 0)} />
            <Stat label="RAM" value={fmtPct(d.system.ram_percent, 0)} hint={`${d.system.ram_used_mb} MB used`} />
            <Stat label="Cores" value={d.system.cores} />
          </div>
        </Card>
        <Card title="Agents">
          <Table
            rowKey={(r) => r.name}
            columns={[
              { key: 'name', label: 'Agent' },
              { key: 'status', label: 'Status', render: (r) => <Badge status={r.status} /> },
              { key: 'trials_processed', label: 'Processed', align: 'right' },
              { key: 'last_heartbeat', label: 'Heartbeat', render: (r) => fmtTime(r.last_heartbeat) },
            ]}
            rows={d.agents}
          />
        </Card>
      </div>
      <Card title="Recent activity">
        <Table
          rowKey={(r, i) => i}
          columns={[
            { key: 'ts', label: 'Time', render: (r) => fmtTime(r.ts) },
            { key: 'agent', label: 'Source' },
            { key: 'level', label: 'Level', render: (r) => <Badge status={r.level === 'error' ? 'error' : r.level === 'warn' ? 'warn' : 'muted'} /> },
            { key: 'message', label: 'Message' },
          ]}
          rows={d.recent_activity}
          empty="No activity yet. Register indicators or strategies in the Studios, then start the agents or an optimization run."
        />
      </Card>
    </>
  );
}
