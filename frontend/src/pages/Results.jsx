import { useEffect, useState } from 'react';
import { get, fmtMoney, fmtPct, fmtNum, fmtTime, specText } from '../api.js';
import { useApp, saveStrategy } from '../context.js';
import { Card, Badge, Table, ErrorBox, useAsync } from '../components/ui.jsx';
import { useNavigate } from 'react-router-dom';

const TABS = [
  ['profit', 'Highest profit'], ['win_rate', 'Highest win rate'], ['profit_factor', 'Profit factor'],
  ['drawdown', 'Lowest drawdown'], ['risk_adjusted', 'Risk-adjusted'], ['walk_forward', 'Walk-forward validated'],
];

export default function Results() {
  const { datasetId } = useApp();
  const navigate = useNavigate();
  const [tab, setTab] = useState('profit');
  const [top, setTop] = useState(10);
  const [split, setSplit] = useState('train');
  const [rows, setRows] = useState([]);
  const [detail, setDetail] = useState(null);
  const { error, run } = useAsync();

  useEffect(() => {
    if (!datasetId) return;
    run(async () => setRows(await get(`/api/results/rankings/${tab}?dataset_id=${datasetId}&top=${top}&split=${split}`)));
  }, [datasetId, tab, top, split]);

  const open = (row) => run(async () => setDetail(await get(`/api/results/strategies/${row.strategy_hash}?dataset_id=${datasetId}`)));
  const toBacktest = () => {
    if (!detail) return;
    const s = detail.spec;
    saveStrategy({ indicators: s.indicators, min_votes: s.min_votes, direction: s.direction,
      stop_loss_pct: s.stop_loss_pct, target_pct: s.target_pct });
    navigate('/backtest');
  };

  const isValid = (r) => (r.validated ? <Badge status="validated" /> : r.validation ? <Badge status="pending" /> : <span className="muted">not checked</span>);
  const best = detail && detail.experiments.find((e) => e.split === 'train');

  return (
    <>
      <div className="page-head"><div><h1>Results</h1><div className="muted">Ranked from stored experiments. Only eligible strategies (minimum trade count met) appear.</div></div></div>
      <ErrorBox error={error} />
      <Card>
        <div className="tabs">
          {TABS.map(([k, label]) => <button key={k} className={`tab ${tab === k ? 'active' : ''}`} onClick={() => setTab(k)}>{label}</button>)}
        </div>
        <div className="pill-row" style={{ marginBottom: 12 }}>
          <button className={`tab ${top === 10 ? 'active' : ''}`} onClick={() => setTop(10)}>Top 10</button>
          <button className={`tab ${top === 50 ? 'active' : ''}`} onClick={() => setTop(50)}>Top 50</button>
          <select value={split} onChange={(e) => setSplit(e.target.value)} style={{ marginLeft: 'auto' }}>
            <option value="train">Ranked on train</option>
            <option value="validation">Ranked on validation</option>
          </select>
        </div>
        <Table
          rowKey={(r) => r.strategy_hash}
          onRowClick={open}
          selectedKey={detail?.hash}
          columns={[
            { key: 'rank', label: '#', align: 'right' },
            { key: 'description', label: 'Strategy', render: (r) => <span className="mono">{specText(r.spec)}</span> },
            { key: 'net_profit', label: 'Net profit', align: 'right', render: (r) => fmtMoney(r.metrics.net_profit) },
            { key: 'win_rate', label: 'Win rate', align: 'right', render: (r) => fmtPct(r.metrics.win_rate) },
            { key: 'profit_factor', label: 'PF', align: 'right', render: (r) => fmtNum(r.metrics.profit_factor) },
            { key: 'max_drawdown', label: 'Max DD', align: 'right', render: (r) => `${fmtMoney(r.metrics.max_drawdown)} (${fmtPct(r.metrics.max_drawdown_pct)})` },
            { key: 'trades', label: 'Trades', align: 'right', render: (r) => r.metrics.trades },
            { key: 'validation', label: 'Validation', render: (r) => isValid(r) },
          ]}
          rows={rows}
          empty={datasetId ? 'No eligible strategies yet. Run the agents or an optimization study.' : 'Import a dataset first.'}
        />
      </Card>
      {detail && (
        <Card title={`Strategy detail · ${detail.hash}`} actions={<button className="primary" onClick={toBacktest}>Open in Backtest</button>}>
          <div className="split-2">
            <div>
              <h3 style={{ marginBottom: 8 }}>Configuration</h3>
              <div className="mono" style={{ marginBottom: 10 }}>{specText(detail.spec)}</div>
              <table>
                <thead><tr><th>Indicator</th><th>Parameters</th></tr></thead>
                <tbody>
                  {detail.spec.indicators.map((i) => (
                    <tr key={i.name}><td className="mono">{i.name}</td>
                      <td className="mono">{Object.entries(i.params).map(([k, v]) => `${k}=${v}`).join(', ')}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div>
              <h3 style={{ marginBottom: 8 }}>Performance by split</h3>
              <Table
                rowKey={(e, i) => i}
                columns={[
                  { key: 'split', label: 'Split' },
                  { key: 'net', label: 'Net', align: 'right', render: (e) => fmtMoney(e.metrics.net_profit) },
                  { key: 'win', label: 'Win %', align: 'right', render: (e) => fmtPct(e.metrics.win_rate) },
                  { key: 'pf', label: 'PF', align: 'right', render: (e) => fmtNum(e.metrics.profit_factor) },
                  { key: 'dd', label: 'Max DD %', align: 'right', render: (e) => fmtPct(e.metrics.max_drawdown_pct) },
                  { key: 'tr', label: 'Trades', align: 'right', render: (e) => e.metrics.trades },
                ]}
                rows={detail.experiments}
              />
              {best && <div className="muted" style={{ marginTop: 6 }}>Recorded {fmtTime(best.created_at)} by {best.agent}{best.study ? ` · study ${best.study}` : ''}</div>}
            </div>
          </div>
          <h3 style={{ margin: '16px 0 8px' }}>Walk-forward validation</h3>
          <Table
            rowKey={(v) => v.id}
            columns={[
              { key: 'created_at', label: 'Checked', render: (v) => fmtTime(v.created_at) },
              { key: 'profitable_segments', label: 'Profitable segments', align: 'right', render: (v) => `${v.profitable_segments} / ${v.total_segments}` },
              { key: 'validation_net_profit', label: 'Validation net', align: 'right', render: (v) => fmtMoney(v.validation_net_profit) },
              { key: 'validated', label: 'Status', render: (v) => <Badge status={v.validated ? 'validated' : 'failed'} /> },
            ]}
            rows={detail.validations}
            empty="Not walk-forward validated yet."
          />
          <h3 style={{ margin: '16px 0 8px' }}>Out-of-sample</h3>
          {detail.out_of_sample
            ? <div className="info-box">Net {fmtMoney(detail.out_of_sample.metrics.net_profit)} · {detail.out_of_sample.metrics.trades} trades · win rate {fmtPct(detail.out_of_sample.metrics.win_rate)} · recorded {fmtTime(detail.out_of_sample.created_at)}</div>
            : <div className="muted">Not run. Run it once from the Backtest page when the strategy is final.</div>}
        </Card>
      )}
    </>
  );
}
