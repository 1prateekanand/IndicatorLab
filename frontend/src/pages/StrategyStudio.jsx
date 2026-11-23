import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { get, post, api, fmtMoney, fmtPct, fmtNum, fmtTime } from '../api.js';
import { useApp, saveStrategy } from '../context.js';
import { Card, Badge, Field, ErrorBox, Stat, useAsync } from '../components/ui.jsx';
import CodeEditor from '../components/CodeEditor.jsx';

// Structural skeleton only (no predefined entry/exit logic or strategy template)
const EMPTY_STRATEGY_SKELETON = `def generate_signals(df, indicators, **params):
    """Return bar signals in {-1, 0, 1} or a dict:
      {'signals': [...], 'exit_signals': [...], 'stop_loss_pct': 0.5, 'target_pct': 1.0}
    'df' provides OHLCV series; 'indicators' maps registered indicator names to Series or IndicatorOutput dicts.
    """
    n = len(df)
    return {
        "signals": [0] * n,
        "exit_signals": [0] * n,
    }
`;

function blankDraft() {
  return {
    id: null,
    name: '',
    version: '1.0.0',
    description: '',
    direction: 'both',
    stop_loss_pct: 0.5,
    target_pct: 1.0,
    entry_notes: '',
    exit_notes: '',
    linked_indicators: [],
    params: [],
    code: EMPTY_STRATEGY_SKELETON,
    status: 'new',
    registered: false,
    has_draft_changes: false,
  };
}

function draftFromItem(item) {
  return {
    id: item.id,
    name: item.name,
    version: item.version || '1.0.0',
    description: item.description || '',
    direction: item.direction || 'both',
    stop_loss_pct: item.stop_loss_pct ?? 0.5,
    target_pct: item.target_pct ?? 1.0,
    entry_notes: item.entry_notes || '',
    exit_notes: item.exit_notes || '',
    linked_indicators: [...(item.linked_indicators || [])],
    params: (item.params || []).map((p) => ({ ...p })),
    code: item.code || EMPTY_STRATEGY_SKELETON,
    status: item.status,
    registered: Boolean(item.registered),
    has_draft_changes: Boolean(item.has_draft_changes),
  };
}

export default function StrategyStudio() {
  const { datasetId } = useApp();
  const navigate = useNavigate();
  const [items, setItems] = useState([]);
  const [regIndicators, setRegIndicators] = useState([]);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [draft, setDraft] = useState(blankDraft);
  const [savedSnapshot, setSavedSnapshot] = useState(JSON.stringify(blankDraft()));
  const [validation, setValidation] = useState(null);
  const [notice, setNotice] = useState(null);
  const [pendingNav, setPendingNav] = useState(null);
  const [pendingDelete, setPendingDelete] = useState(null);
  const inFlightRef = useRef(false);
  const { error, busy, run, setError } = useAsync();

  const applySelection = (item) => {
    const copy = draftFromItem(item);
    setDraft(copy);
    setSavedSnapshot(JSON.stringify(copy));
    setValidation(item.last_validation || null);
    setNotice(null);
    setError(null);
    setPendingNav(null);
    setPendingDelete(null);
  };

  const applyNewBlank = () => {
    const fresh = blankDraft();
    setDraft(fresh);
    setSavedSnapshot(JSON.stringify(fresh));
    setValidation(null);
    setNotice(null);
    setError(null);
    setPendingNav(null);
    setPendingDelete(null);
  };

  const loadAll = async (selectId = null) => {
    const [sRes, iRes] = await Promise.all([
      get('/api/studio/strategies'),
      get('/api/indicators'),
    ]);
    const list = sRes.items || [];
    setItems(list);
    setRegIndicators((iRes.indicators || []).filter((i) => i.available));
    if (selectId) {
      const found = list.find((s) => s.id === selectId);
      if (found) applySelection(found);
    }
    return list;
  };

  useEffect(() => {
    run(async () => {
      const list = await loadAll();
      if (list.length > 0 && !draft.id) applySelection(list[0]);
    });
  }, []);

  const dirty = JSON.stringify(draft) !== savedSnapshot;

  const requestSelectItem = (item) => {
    if (item.id === draft.id) return;
    if (dirty) {
      setPendingNav({ type: 'select', item });
      return;
    }
    applySelection(item);
  };

  const requestNewStrategy = () => {
    if (dirty) {
      setPendingNav({ type: 'new' });
      return;
    }
    applyNewBlank();
  };

  const confirmPendingNav = () => {
    if (!pendingNav) return;
    if (pendingNav.type === 'new') applyNewBlank();
    else if (pendingNav.type === 'select' && pendingNav.item) applySelection(pendingNav.item);
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((s) => {
      if (statusFilter === 'registered' && !s.registered) return false;
      if (statusFilter === 'draft' && s.registered) return false;
      if (statusFilter === 'error' && s.status !== 'error') return false;
      if (!q) return true;
      return s.name.toLowerCase().includes(q) || (s.description || '').toLowerCase().includes(q);
    });
  }, [items, query, statusFilter]);

  const toggleLinkedIndicator = (name) => {
    setDraft((d) => ({
      ...d,
      linked_indicators: d.linked_indicators.includes(name)
        ? d.linked_indicators.filter((x) => x !== name)
        : [...d.linked_indicators, name],
    }));
  };

  const addParam = () => {
    setDraft((d) => ({
      ...d,
      params: [...d.params, { name: `param_${d.params.length + 1}`, kind: 'float', default: 1.0, low: 0.1, high: 10.0, step: 0.1 }],
    }));
  };

  const updateParam = (idx, key, val) => {
    setDraft((d) => ({
      ...d,
      params: d.params.map((p, i) => (i === idx ? { ...p, [key]: val } : p)),
    }));
  };

  const removeParam = (idx) => {
    setDraft((d) => ({ ...d, params: d.params.filter((_, i) => i !== idx) }));
  };

  const buildPayload = () => ({
    name: draft.name,
    version: draft.version,
    description: draft.description,
    direction: draft.direction,
    stop_loss_pct: Number(draft.stop_loss_pct),
    target_pct: Number(draft.target_pct),
    entry_notes: draft.entry_notes,
    exit_notes: draft.exit_notes,
    linked_indicators: draft.linked_indicators,
    params: draft.params,
    code: draft.code,
  });

  const guardExclusive = async (fn) => {
    if (inFlightRef.current) return undefined;
    inFlightRef.current = true;
    try {
      return await run(fn);
    } finally {
      inFlightRef.current = false;
    }
  };

  const saveDraft = () => guardExclusive(async () => {
    setNotice(null);
    const payload = buildPayload();
    const saved = draft.id
      ? await api(`/api/studio/strategies/${draft.id}`, { method: 'PUT', body: payload })
      : await post('/api/studio/strategies', payload);
    await loadAll(saved.id);
    setNotice(
      saved.registered
        ? `Saved draft edits for '${saved.name}' v${saved.version}. Active registry keeps the previous validated strategy until you click Update Strategy.`
        : `Saved draft strategy '${saved.name}' v${saved.version}. Click Update Strategy to validate and register it in the Research Agent catalogue.`
    );
  });

  const validateCode = (syntaxOnly = false) => guardExclusive(async () => {
    setNotice(null);
    const res = await post('/api/studio/strategies/validate', {
      code: draft.code,
      params: draft.params,
      linked_indicators: draft.linked_indicators,
      direction: draft.direction,
      stop_loss_pct: Number(draft.stop_loss_pct),
      target_pct: Number(draft.target_pct),
      dataset_id: datasetId,
      syntax_only: syntaxOnly,
    });
    setValidation(res);
    if (!res.ok) {
      setError(`${res.error?.type || 'ValidationError'} on line ${res.error?.line || 1}: ${res.error?.message}`);
    } else if (syntaxOnly) {
      setNotice('Python AST syntax and sandbox safety checks passed.');
    } else {
      setNotice(`Simulated cleanly on ${res.bars} bars (${res.metrics?.trades ?? 0} trades). Click Update Strategy to register.`);
    }
  });

  const updateStrategy = () => guardExclusive(async () => {
    setNotice(null);
    const payload = buildPayload();
    let targetId = draft.id;

    if (!targetId) {
      const created = await post('/api/studio/strategies', payload);
      targetId = created.id;
      const committed = draftFromItem(created);
      setDraft(committed);
      setSavedSnapshot(JSON.stringify(committed));
      setItems((prev) => [...prev, created]);
    }

    try {
      const res = await post(`/api/studio/strategies/${targetId}/update`, {
        ...payload,
        dataset_id: datasetId,
      });
      setValidation(res.validation);
      await loadAll(res.strategy.id);
      setNotice(res.message);
    } catch (err) {
      if (err.data?.validation) {
        setValidation(err.data.validation);
      }
      const sRes = await get('/api/studio/strategies').catch(() => null);
      if (sRes?.items) setItems(sRes.items);
      if (err.data?.preserved_working_version) {
        setNotice('Validation failed; the previous working registered strategy remains active. Fix the editor code below and retry Update Strategy.');
      }
      throw err;
    }
  });

  const confirmDeleteStrategy = (item) => guardExclusive(async () => {
    setNotice(null);
    setPendingDelete(null);
    await api(`/api/studio/strategies/${item.id}`, { method: 'DELETE' });
    const remaining = await loadAll();
    if (draft.id === item.id) {
      if (remaining.length) applySelection(remaining[0]);
      else applyNewBlank();
    }
    setNotice(`Deleted strategy '${item.name}' and removed it from the strategy registry.`);
  });

  const openInBacktest = () => {
    if (!draft.id) return;
    saveStrategy({
      strategy_name: draft.name,
      strategy_ids: [draft.id],
      strategy_params: { [draft.id]: Object.fromEntries(draft.params.map((p) => [p.name, Number(p.default)])) },
      indicators: draft.linked_indicators.map((n) => ({ name: n, params: {} })),
      min_votes: 1,
      direction: draft.direction,
      stop_loss_pct: Number(draft.stop_loss_pct),
      target_pct: Number(draft.target_pct),
    });
    navigate('/backtest');
  };

  const registeredCount = items.filter((s) => s.registered && s.available).length;
  const errorLine = validation && !validation.ok ? (validation.error?.line || null) : null;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Strategy Studio</h1>
          <div className="muted">
            Code-first custom trading strategies. Combine OHLCV data with numerical, multi-output, or signal indicators in Python and simulate on historical candles.
          </div>
        </div>
        <div className="card-actions">
          <span className="badge info">Python 3.11 Sandbox + Bar-by-Bar Engine</span>
          <button className="primary" onClick={requestNewStrategy}>+ New Strategy</button>
        </div>
      </div>

      <div className="grid stats" style={{ marginBottom: 14 }}>
        <Stat label="Custom Strategies" value={items.length} hint="unlimited user-owned registry" />
        <Stat label="Registered & Active" value={registeredCount} tone="good" hint="visible to Research Agent" />
        <Stat label="Registered Indicators" value={regIndicators.length} hint="available via indicators[name]" />
        <Stat label="Test Dataset" value={datasetId ? `#${datasetId}` : 'Probe (400 bars)'} hint={datasetId ? 'train split historical candles' : 'import CSV or synthetic data'} />
      </div>

      {pendingNav && (
        <div className="info-box" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, borderColor: 'var(--warn)' }}>
          <span>
            You have unsaved edits in <strong>{draft.name || 'New Strategy'}</strong>. Discard changes and switch?
          </span>
          <div className="card-actions">
            <button type="button" onClick={() => setPendingNav(null)}>Stay &amp; Keep Editing</button>
            <button type="button" className="primary" onClick={confirmPendingNav}>Discard Unsaved Changes</button>
          </div>
        </div>
      )}

      {pendingDelete && (
        <div className="error-box" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
          <span>
            Delete strategy <strong className="mono">{pendingDelete.name}</strong> (ID #{pendingDelete.id})?
          </span>
          <div className="card-actions">
            <button type="button" onClick={() => setPendingDelete(null)}>Cancel</button>
            <button type="button" className="primary" onClick={() => confirmDeleteStrategy(pendingDelete)}>Confirm Delete</button>
          </div>
        </div>
      )}

      <ErrorBox error={error} />
      {notice && <div className="info-box">{notice}</div>}

      <div className="studio-shell">
        <aside className="studio-list">
          <div className="studio-toolbar">
            <strong>Custom Strategies ({items.length})</strong>
          </div>
          <input
            placeholder="Search strategies..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="all">All ({items.length})</option>
            <option value="registered">Registered ({registeredCount})</option>
            <option value="draft">Drafts ({items.filter((s) => !s.registered).length})</option>
            <option value="error">Errors ({items.filter((s) => s.status === 'error').length})</option>
          </select>

          {filtered.length === 0 && (
            <div className="empty" style={{ padding: 14 }}>
              No custom strategies match. Click <strong>+ New Strategy</strong> to write your own strategy logic.
            </div>
          )}

          {filtered.map((item) => (
            <div
              key={item.id}
              className={`studio-item ${draft.id === item.id ? 'active' : ''}`}
              onClick={() => requestSelectItem(item)}
            >
              <div className="studio-item-head">
                <strong className="mono">{item.name}</strong>
                <Badge status={item.registered ? 'completed' : item.status === 'error' ? 'error' : 'pending'} />
              </div>
              <div className="muted" style={{ fontSize: 12 }}>
                #{item.id} · v{item.version} · {item.direction} · SL {item.stop_loss_pct}% / TP {item.target_pct}%
              </div>
              {item.description && <div className="muted" style={{ fontSize: 11 }}>{item.description}</div>}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 4 }}>
                <small>
                  {item.registered
                    ? (item.has_draft_changes ? 'Registered (draft pending)' : 'In Agent Catalogue')
                    : (item.status === 'error' ? 'Needs fix' : 'Draft only')}
                </small>
                <button
                  type="button"
                  className="ghost"
                  style={{ padding: '2px 7px', fontSize: 11, color: 'var(--bad)' }}
                  onClick={(e) => { e.stopPropagation(); setPendingDelete(item); }}
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </aside>

        <div className="studio-workspace">
          <Card
            title={
              draft.id
                ? `Editing ID #${draft.id}: ${draft.name || '(unnamed)'}${dirty ? ' • Unsaved changes' : ''}`
                : `Creating New Strategy${dirty ? ' • Unsaved' : ''}`
            }
            actions={
              <>
                <button type="button" disabled={busy} onClick={saveDraft}>Save Draft</button>
                <button type="button" disabled={busy} onClick={() => validateCode(true)}>Validate Syntax</button>
                <button type="button" disabled={busy} onClick={() => validateCode(false)}>Test Execution</button>
                {draft.id && draft.registered && <button type="button" onClick={openInBacktest}>Open in Backtest</button>}
                <button type="button" className="primary" disabled={busy} onClick={updateStrategy}>Update Strategy</button>
              </>
            }
          >
            {draft.has_draft_changes && (
              <div className="info-box" style={{ marginBottom: 10, borderColor: 'var(--warn)' }}>
                This strategy has saved draft edits not yet validated. Click <strong>Update Strategy</strong> to promote them to the active catalogue.
              </div>
            )}

            <div className="form-grid" style={{ marginBottom: 12 }}>
              <Field label="Strategy Name">
                <input
                  className="mono"
                  placeholder="e.g. rsi_mean_reversion_v1"
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                />
              </Field>
              <Field label="Version">
                <input
                  className="mono"
                  value={draft.version}
                  onChange={(e) => setDraft({ ...draft, version: e.target.value })}
                />
              </Field>
              <Field label="Direction">
                <select value={draft.direction} onChange={(e) => setDraft({ ...draft, direction: e.target.value })}>
                  <option value="both">both</option>
                  <option value="long">long</option>
                  <option value="short">short</option>
                </select>
              </Field>
              <Field label="Stop-Loss (%)" hint="0 disables; can override in code">
                <input
                  type="number"
                  step="0.05"
                  min="0"
                  value={draft.stop_loss_pct}
                  onChange={(e) => setDraft({ ...draft, stop_loss_pct: e.target.value })}
                />
              </Field>
              <Field label="Take-Profit (%)" hint="0 disables; can override in code">
                <input
                  type="number"
                  step="0.05"
                  min="0"
                  value={draft.target_pct}
                  onChange={(e) => setDraft({ ...draft, target_pct: e.target.value })}
                />
              </Field>
              <Field label="Description">
                <input
                  placeholder="Strategy thesis and market regime"
                  value={draft.description}
                  onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                />
              </Field>
            </div>

            <div className="split-2" style={{ marginBottom: 12 }}>
              <Field label="Entry Conditions Specification">
                <textarea
                  rows={2}
                  placeholder="Document entry triggers and indicator combinations..."
                  value={draft.entry_notes}
                  onChange={(e) => setDraft({ ...draft, entry_notes: e.target.value })}
                />
              </Field>
              <Field label="Exit Conditions Specification">
                <textarea
                  rows={2}
                  placeholder="Document exit rules, trailing stops, or time exits..."
                  value={draft.exit_notes}
                  onChange={(e) => setDraft({ ...draft, exit_notes: e.target.value })}
                />
              </Field>
            </div>

            <div style={{ marginBottom: 12 }}>
              <div className="studio-toolbar" style={{ marginBottom: 6 }}>
                <span style={{ color: 'var(--muted)', fontSize: 13 }}>
                  Linked Custom Indicators ({draft.linked_indicators.length} selected) — numeric/multi indicators expose raw Series or dict outputs via <code>indicators[&quot;name&quot;]</code>
                </span>
              </div>
              {regIndicators.length === 0 ? (
                <div className="muted" style={{ fontSize: 12 }}>
                  No registered custom indicators yet. Register indicators in Indicator Studio to access them via <code>indicators[&quot;name&quot;]</code>.
                </div>
              ) : (
                <div className="pill-row">
                  {regIndicators.map((ind) => {
                    const active = draft.linked_indicators.includes(ind.name);
                    return (
                      <button
                        type="button"
                        key={ind.name}
                        className={`tab ${active ? 'active' : ''}`}
                        onClick={() => toggleLinkedIndicator(ind.name)}
                        title={`Outputs: ${(ind.outputs || ['signal']).join(', ')}`}
                      >
                        {active ? '✓ ' : '+ '}<span className="mono">{ind.name}</span>{' '}
                        <span className="muted" style={{ fontSize: 11 }}>({ind.output_type || 'auto'})</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            <div style={{ marginBottom: 12 }}>
              <div className="studio-toolbar" style={{ marginBottom: 6 }}>
                <span style={{ color: 'var(--muted)', fontSize: 13 }}>
                  Custom Strategy Parameters ({draft.params.length}) — tunable by Research Agent &amp; Optuna
                </span>
                <button type="button" onClick={addParam}>+ Add Parameter</button>
              </div>
              {draft.params.length > 0 && (
                <div className="param-row" style={{ color: 'var(--muted)', fontSize: 11, textTransform: 'uppercase' }}>
                  <span>Name</span><span>Type</span><span>Default</span><span>Min</span><span>Max</span><span>Step</span><span />
                </div>
              )}
              {draft.params.map((p, idx) => (
                <div key={idx} className="param-row">
                  <input className="mono" value={p.name} onChange={(e) => updateParam(idx, 'name', e.target.value)} />
                  <select value={p.kind} onChange={(e) => updateParam(idx, 'kind', e.target.value)}>
                    <option value="int">int</option>
                    <option value="float">float</option>
                  </select>
                  <input type="number" step="any" value={p.default} onChange={(e) => updateParam(idx, 'default', e.target.value)} />
                  <input type="number" step="any" value={p.low} onChange={(e) => updateParam(idx, 'low', e.target.value)} />
                  <input type="number" step="any" value={p.high} onChange={(e) => updateParam(idx, 'high', e.target.value)} />
                  <input type="number" step="any" placeholder="auto" value={p.step ?? ''} onChange={(e) => updateParam(idx, 'step', e.target.value)} />
                  <button type="button" className="ghost" style={{ color: 'var(--bad)' }} onClick={() => removeParam(idx)}>Remove</button>
                </div>
              ))}
            </div>

            <CodeEditor
              value={draft.code}
              onChange={(code) => setDraft({ ...draft, code })}
              filename={`${(draft.name || 'new_strategy').replace(/\s+/g, '_').toLowerCase()}.py`}
              errorLine={errorLine}
              dirty={dirty}
              height={360}
            />
          </Card>

          <Card
            title="Validation &amp; Historical Execution Preview"
            actions={validation ? <Badge status={validation.ok ? 'ok' : 'error'} /> : null}
          >
            {!validation && (
              <div className="empty">
                Click <strong>Validate Syntax</strong>, <strong>Test Execution</strong>, or <strong>Update Strategy</strong> to simulate your strategy against historical candles.
              </div>
            )}
            {validation && !validation.ok && (
              <div className="error-box">
                <strong>{validation.error?.type || 'Error'}</strong> (stage: {validation.stage || 'runtime'}, line {validation.error?.line || 1}): {validation.error?.message}
              </div>
            )}
            {validation && validation.ok && validation.stage === 'syntax' && (
              <div className="info-box">Python AST syntax and sandbox safety checks passed.</div>
            )}
            {validation && validation.ok && validation.stage === 'executed' && (
              <div className="grid stats" style={{ marginBottom: 12 }}>
                <Stat label="Execution Time" value={`${validation.execution_ms} ms`} hint={validation.data_source} />
                <Stat label="Long / Short Signals" value={`${validation.signal_counts?.long ?? 0} / ${validation.signal_counts?.short ?? 0}`} />
                {validation.metrics && (
                  <>
                    <Stat label="Simulated Trades" value={validation.metrics.trades} />
                    <Stat
                      label="Net Profit"
                      value={fmtMoney(validation.metrics.net_profit)}
                      tone={validation.metrics.net_profit >= 0 ? 'good' : 'bad'}
                    />
                    <Stat label="Win Rate" value={fmtPct(validation.metrics.win_rate)} />
                    <Stat label="Sharpe Ratio" value={fmtNum(validation.metrics.sharpe_ratio)} />
                    <Stat label="Max Drawdown" value={fmtPct(validation.metrics.max_drawdown_pct)} tone="bad" />
                  </>
                )}
              </div>
            )}
            {draft.id && items.find((s) => s.id === draft.id)?.last_validated_at && (
              <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>
                Last validated: {fmtTime(items.find((s) => s.id === draft.id).last_validated_at)}
              </div>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
