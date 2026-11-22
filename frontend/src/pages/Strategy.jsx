import { useEffect, useMemo, useState } from 'react';
import { get, post, specText } from '../api.js';
import { loadStrategy, saveStrategy } from '../context.js';
import { Card, Field, ErrorBox, useAsync } from '../components/ui.jsx';
import { useNavigate } from 'react-router-dom';

export default function Strategy() {
  const navigate = useNavigate();
  const [indicators, setIndicators] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [options, setOptions] = useState(null);
  const [spec, setSpec] = useState(() => loadStrategy() || { indicators: [], min_votes: 1, direction: 'both', stop_loss_pct: 0.5, target_pct: 1.0 });
  const [description, setDescription] = useState('');
  const { error, run } = useAsync();

  useEffect(() => {
    get('/api/indicators').then((r) => setIndicators(r.indicators.filter((i) => i.available))).catch(() => {});
    get('/api/strategy/templates').then(setTemplates).catch(() => {});
    get('/api/strategy/options').then(setOptions).catch(() => {});
  }, []);

  const byName = useMemo(() => Object.fromEntries(indicators.map((i) => [i.name, i])), [indicators]);

  const addIndicator = (name) => {
    if (!name || spec.indicators.some((i) => i.name === name)) return;
    setSpec({ ...spec, indicators: [...spec.indicators, { name, params: { ...byName[name].defaults } }] });
  };
  const removeIndicator = (name) => setSpec({ ...spec, indicators: spec.indicators.filter((i) => i.name !== name) });
  const setParam = (name, key, value) => setSpec({ ...spec, indicators: spec.indicators.map((i) =>
    i.name === name ? { ...i, params: { ...i.params, [key]: value === '' ? '' : Number(value) } } : i) });
  const set = (k) => (e) => setSpec({ ...spec, [k]: e.target.type === 'number' ? Number(e.target.value) : e.target.value });

  const describeNow = () => run(async () => {
    const r = await post('/api/strategy/describe', spec);
    setDescription(r.description);
    saveStrategy(spec);
  });
  const useTemplate = (t) => setSpec(JSON.parse(JSON.stringify(t.spec)));
  const toBacktest = () => { saveStrategy(spec); navigate('/backtest'); };

  const maxVotes = Math.max(1, spec.indicators.length);
  return (
    <>
      <div className="page-head"><div><h1>Strategy</h1><div className="muted">Entry and exit rules are built from registered indicators. Votes decide entries; risk limits decide exits.</div></div></div>
      <ErrorBox error={error} />
      <div className="split-2">
        <Card title="Templates">
          {templates.length === 0 && <div className="muted">No available indicators; add indicator plugins first.</div>}
          <div className="pill-row">
            {templates.map((t) => <button key={t.id} onClick={() => useTemplate(t)} title={t.description}>{t.label}</button>)}
          </div>
          <p className="muted" style={{ marginTop: 10 }}>Templates use the first available indicators in the registry, with default parameters.</p>
        </Card>
        <Card title="Entry and exit rules">
          <ul className="muted" style={{ margin: 0, paddingLeft: 18 }}>
            <li>Long when the vote total reaches +{spec.min_votes}; short at −{spec.min_votes}.</li>
            <li>Orders decided on a bar's close fill at the next bar's open, plus slippage.</li>
            <li>Stop-loss {spec.stop_loss_pct}% and target {spec.target_pct}% are checked intrabar; a stop wins if both are touched.</li>
            <li>Opposite confirmed votes reverse the position; all positions square off at the configured minute.</li>
          </ul>
        </Card>
      </div>
      <Card title="Indicators in this strategy">
        <div className="form-grid" style={{ marginBottom: 12 }}>
          <Field label="Add indicator">
            <select value="" onChange={(e) => addIndicator(e.target.value)}>
              <option value="">Select…</option>
              {indicators.filter((i) => !spec.indicators.some((s) => s.name === i.name)).map((i) => (
                <option key={i.name} value={i.name}>{i.name} ({i.category})</option>
              ))}
            </select>
          </Field>
        </div>
        {spec.indicators.length === 0 && <div className="empty">Add at least one indicator.</div>}
        {spec.indicators.map((item) => {
          const def = byName[item.name];
          return (
            <div key={item.name} className="ind-card" style={{ marginBottom: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <strong className="mono">{item.name}</strong>
                <button className="ghost" onClick={() => removeIndicator(item.name)}>Remove</button>
              </div>
              {def && (
                <div className="form-grid">
                  {def.params.map((p) => (
                    <Field key={p.name} label={`${p.name} (${p.low}–${p.high})`}>
                      <input type="number" step={p.kind === 'float' ? '0.01' : '1'} min={p.low} max={p.high}
                        value={item.params[p.name] ?? ''} onChange={(e) => setParam(item.name, p.name, e.target.value)} />
                    </Field>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </Card>
      <Card title="Risk management and voting">
        <div className="form-grid">
          <Field label={`Minimum votes (1–${maxVotes})`}>
            <input type="number" min="1" max={maxVotes} value={spec.min_votes} onChange={set('min_votes')} />
          </Field>
          <Field label="Direction">
            <select value={spec.direction} onChange={set('direction')}>
              {(options?.directions || ['both', 'long', 'short']).map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </Field>
          <Field label="Stop-loss (%)" hint="0 disables">
            <input type="number" step="0.05" min="0" value={spec.stop_loss_pct} onChange={set('stop_loss_pct')} />
          </Field>
          <Field label="Target (%)" hint="0 disables">
            <input type="number" step="0.05" min="0" value={spec.target_pct} onChange={set('target_pct')} />
          </Field>
        </div>
        <div className="pill-row" style={{ marginTop: 14 }}>
          <button className="primary" disabled={spec.indicators.length === 0} onClick={describeNow}>Validate strategy</button>
          <button disabled={spec.indicators.length === 0} onClick={toBacktest}>Open in Backtest</button>
        </div>
        {description && <div className="info-box mono">{description}</div>}
        <div className="muted" style={{ marginTop: 8 }}>Current spec: {specText({ ...spec, indicators: spec.indicators.map((i) => ({ name: i.name, params: i.params })) })}</div>
      </Card>
    </>
  );
}
