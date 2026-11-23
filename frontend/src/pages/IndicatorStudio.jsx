import { useEffect, useMemo, useRef, useState } from 'react';
import { get, post, api, fmtNum, fmtTime } from '../api.js';
import { useApp } from '../context.js';
import { Card, Badge, Field, ErrorBox, Stat, Table, useAsync } from '../components/ui.jsx';
import CodeEditor from '../components/CodeEditor.jsx';

// Structural skeleton only (no predefined trading logic or indicator formula)
const EMPTY_SKELETON = `def compute(df, **params):
    """Return a causal Series/list (numeric values or {-1, 0, 1} signals) or a dict of named Series.
    Available columns: df['open'], df['high'], df['low'], df['close'], df['volume'].
    """
    n = len(df)
    return [0.0] * n
`;

function defaultSignalRule(rule = null) {
  if (!rule || typeof rule !== 'object') {
    return { mode: 'none', buy_below: '', sell_above: '', level: 0, output_key: '' };
  }
  return {
    mode: rule.mode || 'none',
    buy_below: rule.buy_below ?? '',
    sell_above: rule.sell_above ?? '',
    level: rule.level ?? 0,
    output_key: rule.output_key || '',
  };
}

function serializeSignalRule(rule) {
  if (!rule || !rule.mode || rule.mode === 'none') return null;
  return {
    mode: rule.mode,
    buy_below: rule.buy_below === '' || rule.buy_below === null ? null : Number(rule.buy_below),
    sell_above: rule.sell_above === '' || rule.sell_above === null ? null : Number(rule.sell_above),
    level: rule.level === '' || rule.level === null ? 0 : Number(rule.level),
    output_key: rule.output_key ? String(rule.output_key).trim() : null,
  };
}

function blankDraft() {
  return {
    id: null,
    name: '',
    version: '1.0.0',
    category: 'Custom',
    description: '',
    output_type: 'auto',
    signal_rule: defaultSignalRule(null),
    params: [],
    code: EMPTY_SKELETON,
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
    category: item.category || 'Custom',
    description: item.description || '',
    output_type: item.output_type || 'auto',
    signal_rule: defaultSignalRule(item.signal_rule),
    params: (item.params || []).map((p) => ({ ...p })),
    code: item.code || EMPTY_SKELETON,
    status: item.status,
    registered: Boolean(item.registered),
    has_draft_changes: Boolean(item.has_draft_changes),
  };
}

export default function IndicatorStudio() {
  const { datasetId } = useApp();
  const [items, setItems] = useState([]);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [draft, setDraft] = useState(blankDraft);
  const [savedSnapshot, setSavedSnapshot] = useState(JSON.stringify(blankDraft()));
  const [validation, setValidation] = useState(null);
  const [notice, setNotice] = useState(null);
  const [warnings, setWarnings] = useState([]);
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
    setWarnings([]);
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
    setWarnings([]);
    setError(null);
    setPendingNav(null);
    setPendingDelete(null);
  };

  const loadList = async (selectId = null) => {
    const res = await get('/api/studio/indicators');
    const list = res.items || [];
    setItems(list);
    if (selectId) {
      const found = list.find((i) => i.id === selectId);
      if (found) applySelection(found);
    }
    return list;
  };

  useEffect(() => {
    run(async () => {
      const res = await get('/api/studio/indicators');
      const list = res.items || [];
      setItems(list);
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

  const requestNewIndicator = () => {
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
    return items.filter((i) => {
      if (statusFilter === 'registered' && !i.registered) return false;
      if (statusFilter === 'draft' && i.registered) return false;
      if (statusFilter === 'error' && i.status !== 'error') return false;
      if (!q) return true;
      return (
        i.name.toLowerCase().includes(q) ||
        (i.description || '').toLowerCase().includes(q) ||
        (i.category || '').toLowerCase().includes(q)
      );
    });
  }, [items, query, statusFilter]);

  const addParam = () => {
    setDraft((d) => ({
      ...d,
      params: [...d.params, { name: `param_${d.params.length + 1}`, kind: 'int', default: 14, low: 2, high: 100, step: 1 }],
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
    category: draft.category,
    description: draft.description,
    output_type: draft.output_type,
    signal_rule: serializeSignalRule(draft.signal_rule),
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
    setWarnings([]);
    const payload = buildPayload();
    const saved = draft.id
      ? await api(`/api/studio/indicators/${draft.id}`, { method: 'PUT', body: payload })
      : await post('/api/studio/indicators', payload);

    await loadList(saved.id);
    if (Array.isArray(saved.rename_warnings) && saved.rename_warnings.length > 0) {
      setWarnings(saved.rename_warnings);
    }
    setNotice(
      saved.registered
        ? `Saved draft edits for '${saved.name}' v${saved.version}. Active registry continues using the last validated code until you click Update Indicator.`
        : `Saved draft '${saved.name}' v${saved.version}. Click Update Indicator to validate and register it in the Research Agent catalogue.`
    );
  });

  const validateCode = (syntaxOnly = false) => guardExclusive(async () => {
    setNotice(null);
    setWarnings([]);
    const res = await post('/api/studio/indicators/validate', {
      code: draft.code,
      params: draft.params,
      output_type: draft.output_type,
      signal_rule: serializeSignalRule(draft.signal_rule),
      dataset_id: datasetId,
      syntax_only: syntaxOnly,
    });
    setValidation(res);
    if (!res.ok) {
      setError(`${res.error?.type || 'ValidationError'} on line ${res.error?.line || 1}: ${res.error?.message}`);
    } else if (syntaxOnly) {
      setNotice('Python AST syntax and sandbox security checks passed.');
    } else {
      setNotice(`Executed cleanly on ${res.bars} bars (${res.output_type || 'numeric'}). Click Update Indicator to save and register.`);
    }
  });

  const updateIndicator = () => guardExclusive(async () => {
    setNotice(null);
    setWarnings([]);
    const payload = buildPayload();
    let targetId = draft.id;

    // Create record once if brand new, and immediately bind ID in state so any validation failure below never orphans draft.id
    if (!targetId) {
      const created = await post('/api/studio/indicators', payload);
      targetId = created.id;
      const committed = draftFromItem(created);
      setDraft(committed);
      setSavedSnapshot(JSON.stringify(committed));
      setItems((prev) => [...prev, created]);
    }

    try {
      const res = await post(`/api/studio/indicators/${targetId}/update`, {
        ...payload,
        dataset_id: datasetId,
      });
      setValidation(res.validation);
      await loadList(res.indicator.id);
      if (Array.isArray(res.rename_warnings) && res.rename_warnings.length > 0) {
        setWarnings(res.rename_warnings);
      }
      setNotice(res.message);
    } catch (err) {
      if (err.data?.validation) {
        setValidation(err.data.validation);
      }
      // Refresh list metadata without overwriting the user's current editor text so they can fix the error
      const listRes = await get('/api/studio/indicators').catch(() => null);
      if (listRes?.items) setItems(listRes.items);
      if (err.data?.preserved_working_version) {
        setNotice('Validation failed; the previous working registered version remains active in the catalogue. Fix the editor code below and retry Update Indicator.');
      }
      throw err;
    }
  });

  const confirmDeleteIndicator = (item) => guardExclusive(async () => {
    setNotice(null);
    setWarnings([]);
    setPendingDelete(null);
    await api(`/api/studio/indicators/${item.id}`, { method: 'DELETE' });
    const res = await get('/api/studio/indicators');
    const remaining = res.items || [];
    setItems(remaining);
    if (draft.id === item.id) {
      if (remaining.length) applySelection(remaining[0]);
      else applyNewBlank();
    }
    setNotice(`Deleted indicator '${item.name}' and removed it from the dynamic registry.`);
  });

  const registeredCount = items.filter((i) => i.registered && i.available).length;
  const errorLine = validation && !validation.ok ? (validation.error?.line || null) : null;
  const outputKeys = validation?.output_keys || (validation?.sample?.[0]?.values ? Object.keys(validation.sample[0].values) : []);
  const numericEntries = validation?.numeric_stats ? Object.entries(validation.numeric_stats) : [];

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Indicator Studio</h1>
          <div className="muted">
            Code-first custom technical indicators. Author numerical series, multi-output dicts (e.g. MACD/Bollinger), or discrete signals in an isolated Python 3.11 sandbox.
          </div>
        </div>
        <div className="card-actions">
          <span className="badge info">Python 3.11 Sandbox</span>
          <button className="primary" onClick={requestNewIndicator}>+ New Indicator</button>
        </div>
      </div>

      <div className="grid stats" style={{ marginBottom: 14 }}>
        <Stat label="Custom Indicators" value={items.length} hint="unlimited user-owned registry" />
        <Stat label="Registered & Active" value={registeredCount} tone="good" hint="visible to Research Agent" />
        <Stat label="Drafts / Errors" value={items.length - registeredCount} tone={items.some((i) => i.status === 'error') ? 'bad' : ''} />
        <Stat label="Test Dataset" value={datasetId ? `#${datasetId}` : 'Probe (400 bars)'} hint={datasetId ? 'train split historical candles' : 'import CSV or synthetic data'} />
      </div>

      {pendingNav && (
        <div className="info-box" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, borderColor: 'var(--warn)' }}>
          <span>
            You have unsaved edits in <strong>{draft.name || 'New Indicator'}</strong>. Discard changes and switch?
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
            Delete indicator <strong className="mono">{pendingDelete.name}</strong> (ID #{pendingDelete.id})? Strategies referencing it will require updating.
          </span>
          <div className="card-actions">
            <button type="button" onClick={() => setPendingDelete(null)}>Cancel</button>
            <button type="button" className="primary" onClick={() => confirmDeleteIndicator(pendingDelete)}>Confirm Delete</button>
          </div>
        </div>
      )}

      <ErrorBox error={error} />
      {notice && <div className="info-box">{notice}</div>}
      {warnings.map((w, idx) => (
        <div key={idx} className="info-box" style={{ borderColor: 'var(--warn)' }}>
          Rename notice: {w.message}
        </div>
      ))}

      <div className="studio-shell">
        <aside className="studio-list">
          <div className="studio-toolbar">
            <strong>Custom Indicators ({items.length})</strong>
          </div>
          <input
            placeholder="Search indicators..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="all">All ({items.length})</option>
            <option value="registered">Registered ({registeredCount})</option>
            <option value="draft">Drafts ({items.filter((i) => !i.registered).length})</option>
            <option value="error">Errors ({items.filter((i) => i.status === 'error').length})</option>
          </select>

          {filtered.length === 0 && (
            <div className="empty" style={{ padding: 14 }}>
              No custom indicators match. Click <strong>+ New Indicator</strong> to author your first Python indicator.
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
                #{item.id} · v{item.version} · {item.output_type || 'auto'} · {(item.params || []).length} param(s)
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
                : `Creating New Indicator${dirty ? ' • Unsaved' : ''}`
            }
            actions={
              <>
                <button type="button" disabled={busy} onClick={saveDraft}>Save Draft</button>
                <button type="button" disabled={busy} onClick={() => validateCode(true)}>Validate Syntax</button>
                <button type="button" disabled={busy} onClick={() => validateCode(false)}>Test on Historical Data</button>
                <button type="button" className="primary" disabled={busy} onClick={updateIndicator}>Update Indicator</button>
              </>
            }
          >
            {draft.has_draft_changes && (
              <div className="info-box" style={{ marginBottom: 10, borderColor: 'var(--warn)' }}>
                This indicator has saved draft edits that are not yet validated. Click <strong>Update Indicator</strong> to promote them to the active Research Agent catalogue.
              </div>
            )}

            <div className="form-grid" style={{ marginBottom: 12 }}>
              <Field label="Indicator Name (snake_case)" hint="Normalized to lowercase snake_case">
                <input
                  className="mono"
                  placeholder="e.g. custom_rsi_14"
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
              <Field label="Category">
                <input
                  placeholder="Trend / Momentum / Volatility / Custom"
                  value={draft.category}
                  onChange={(e) => setDraft({ ...draft, category: e.target.value })}
                />
              </Field>
              <Field label="Output Type" hint="Numerical outputs work directly in Strategies or via Signal Rule below">
                <select
                  value={draft.output_type}
                  onChange={(e) => setDraft({ ...draft, output_type: e.target.value })}
                >
                  <option value="auto">auto (Signal or Numeric/Multi)</option>
                  <option value="numeric">numeric (Series e.g. RSI, ATR, EMA)</option>
                  <option value="multi">multi (Dict e.g. MACD, Bollinger)</option>
                  <option value="signal">signal (Strict {'{-1, 0, 1}'})</option>
                </select>
              </Field>
              <Field label="Description">
                <input
                  placeholder="What does this indicator compute?"
                  value={draft.description}
                  onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                />
              </Field>
            </div>

            <div style={{ marginBottom: 12, padding: 10, borderRadius: 8, border: '1px solid var(--border)' }}>
              <div className="studio-toolbar" style={{ marginBottom: 6 }}>
                <span style={{ color: 'var(--muted)', fontSize: 13 }}>
                  Optional Signal Conversion Rule (converts numerical output into {'{-1, 0, 1}'} for standalone Backtest &amp; Agents)
                </span>
              </div>
              <div className="form-grid">
                <Field label="Conversion Mode">
                  <select
                    value={draft.signal_rule?.mode || 'none'}
                    onChange={(e) => setDraft((d) => ({ ...d, signal_rule: { ...d.signal_rule, mode: e.target.value } }))}
                  >
                    <option value="none">None (keep numerical / handled by Strategy Studio)</option>
                    <option value="threshold">Threshold (Buy &le; X, Sell &ge; Y, e.g. RSI 30/70)</option>
                    <option value="cross_zero">Level Cross (Cross above/below level, e.g. MACD 0)</option>
                    <option value="price_cross">Price Cross (Close crosses indicator series)</option>
                    <option value="trend_above">Trend Regime (Close &gt; indicator = +1, &lt; = -1)</option>
                  </select>
                </Field>
                {draft.signal_rule?.mode === 'threshold' && (
                  <>
                    <Field label="Buy Below (<=)">
                      <input
                        type="number"
                        step="any"
                        placeholder="e.g. 30"
                        value={draft.signal_rule.buy_below}
                        onChange={(e) => setDraft((d) => ({ ...d, signal_rule: { ...d.signal_rule, buy_below: e.target.value } }))}
                      />
                    </Field>
                    <Field label="Sell Above (>=)">
                      <input
                        type="number"
                        step="any"
                        placeholder="e.g. 70"
                        value={draft.signal_rule.sell_above}
                        onChange={(e) => setDraft((d) => ({ ...d, signal_rule: { ...d.signal_rule, sell_above: e.target.value } }))}
                      />
                    </Field>
                  </>
                )}
                {draft.signal_rule?.mode === 'cross_zero' && (
                  <Field label="Cross Level">
                    <input
                      type="number"
                      step="any"
                      value={draft.signal_rule.level}
                      onChange={(e) => setDraft((d) => ({ ...d, signal_rule: { ...d.signal_rule, level: e.target.value } }))}
                    />
                  </Field>
                )}
                {draft.signal_rule?.mode && draft.signal_rule.mode !== 'none' && (
                  <Field label="Output Key (optional)" hint="For multi-output dicts, e.g. histogram or middle">
                    <input
                      className="mono"
                      placeholder="auto (first output)"
                      value={draft.signal_rule.output_key || ''}
                      onChange={(e) => setDraft((d) => ({ ...d, signal_rule: { ...d.signal_rule, output_key: e.target.value } }))}
                    />
                  </Field>
                )}
              </div>
            </div>

            <div style={{ marginBottom: 12 }}>
              <div className="studio-toolbar" style={{ marginBottom: 6 }}>
                <span style={{ color: 'var(--muted)', fontSize: 13 }}>
                  Custom Parameters ({draft.params.length}) — exposed to Strategy Studio &amp; Research Agent search spaces
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
              filename={`${draft.name || 'new_indicator'}.py`}
              errorLine={errorLine}
              dirty={dirty}
              height={360}
            />
          </Card>

          <Card
            title="Validation &amp; Historical Candle Execution"
            actions={validation ? <Badge status={validation.ok ? 'ok' : 'error'} /> : null}
          >
            {!validation && (
              <div className="empty">
                Click <strong>Validate Syntax</strong>, <strong>Test on Historical Data</strong>, or <strong>Update Indicator</strong> to run your Python code inside the isolated sandbox.
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
              <>
                {validation.volume_warning && (
                  <div className="info-box" style={{ marginBottom: 10, borderColor: 'var(--warn)' }}>
                    {validation.volume_warning}
                  </div>
                )}
                <div className="grid stats" style={{ marginBottom: 12 }}>
                  <Stat label="Output Mode" value={validation.output_type || 'numeric'} />
                  <Stat label="Execution Time" value={`${validation.execution_ms} ms`} />
                  <Stat label="Bars Evaluated" value={validation.bars} hint={validation.data_source} />
                  {validation.signal_counts && (
                    <>
                      <Stat label="Bullish (+1)" value={validation.signal_counts.bullish ?? 0} tone="good" />
                      <Stat label="Bearish (-1)" value={validation.signal_counts.bearish ?? 0} tone="bad" />
                      <Stat label="Neutral (0)" value={validation.signal_counts.neutral ?? 0} />
                    </>
                  )}
                  <Stat
                    label="Causality Check"
                    value={validation.causal ? 'Causal' : 'Look-ahead'}
                    tone={validation.causal ? 'good' : 'bad'}
                    hint={validation.causality_note}
                  />
                </div>

                {numericEntries.length > 0 && (
                  <div style={{ marginBottom: 12 }}>
                    <Table
                      rowKey={(r) => r.key}
                      columns={[
                        { key: 'key', label: 'Output Series', render: (r) => <span className="mono">{r.key}</span> },
                        { key: 'min', label: 'Min', align: 'right', render: (r) => r.min === null ? '—' : fmtNum(r.min, 4) },
                        { key: 'mean', label: 'Mean', align: 'right', render: (r) => r.mean === null ? '—' : fmtNum(r.mean, 4) },
                        { key: 'max', label: 'Max', align: 'right', render: (r) => r.max === null ? '—' : fmtNum(r.max, 4) },
                        { key: 'latest', label: 'Latest', align: 'right', render: (r) => r.latest === null ? '—' : fmtNum(r.latest, 4) },
                        { key: 'finite', label: 'Finite / NaN', align: 'right', render: (r) => `${r.finite_count} / ${r.nan_count}` },
                      ]}
                      rows={numericEntries.map(([key, st]) => ({ key, ...st }))}
                    />
                  </div>
                )}

                {validation.sample && validation.sample.length > 0 && (
                  <Table
                    rowKey={(r, i) => i}
                    columns={[
                      { key: 'time', label: 'Timestamp', render: (r) => <span className="mono">{r.time}</span> },
                      { key: 'close', label: 'Close', align: 'right', render: (r) => Number(r.close).toFixed(2) },
                      ...outputKeys.map((k) => ({
                        key: `val_${k}`,
                        label: k,
                        align: 'right',
                        render: (r) => {
                          const v = r.values?.[k] ?? (k === 'value' ? r.value : undefined);
                          return v === null || v === undefined ? <span className="muted">NaN</span> : <span className="mono">{Number(v).toFixed(4)}</span>;
                        },
                      })),
                      ...(validation.signal_counts
                        ? [{
                            key: 'signal',
                            label: 'Signal',
                            align: 'right',
                            render: (r) => <Badge status={r.signal === 1 ? 'ok' : r.signal === -1 ? 'error' : 'muted'} />,
                          }]
                        : []),
                    ]}
                    rows={validation.sample}
                  />
                )}
              </>
            )}
            {draft.id && items.find((i) => i.id === draft.id)?.last_validated_at && (
              <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>
                Last validated: {fmtTime(items.find((i) => i.id === draft.id).last_validated_at)}
              </div>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
