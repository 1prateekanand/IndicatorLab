import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import {
  DATA_DIR,
  DEFAULT_BACKTEST,
  HISTORICAL_DIR,
  MIN_TRADES,
  RANKINGS,
  SUPPORTED_TIMEFRAMES,
  TIMEFRAME_MINUTES,
  addAgentLog,
  agentsStatus,
  buildEvaluationSnapshot,
  buildStrategySpec,
  computeDsrForDataset,
  controlAgent,
  controlOptimizationStudy,
  describeSpec,
  discoverHistoricalCsvFiles,
  ensureCanonicalHistoricalDataset,
  ensureTimeframeCandles,
  evaluateSpecFull,
  generateSyntheticCandles,
  getDatasetQualityReport,
  getHistoricalSyncState,
  getLeaderboard,
  getMarketDataset,
  getOptimizationRuns,
  getRegisteredIndicators,
  getRegisteredStrategies,
  indicatorDefaults,
  ingestHistoricalDataset,
  ingestUploadedCsvStreams,
  listMarketDatasets,
  loadCanonicalCandlesForEngine,
  normalizeParamSpecs,
  normalizeTimeframe,
  parseCsvCandles,
  probeCandles,
  queryMarketCandles,
  recoverAfterRestart,
  reloadRegistryFromDisk,
  resampleCandles,
  resolveRegisteredIndicator,
  resolveRegisteredStrategy,
  runPythonSandbox,
  specHash,
  splitBounds,
  startAutonomousAgents,
  startOptimizationStudy,
  store,
  systemMetrics,
  upsertDataset,
  utcnow,
} from './server_engine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const IS_PROD = process.env.NODE_ENV === 'production';

const app = express();
app.use(express.json({ limit: '100mb' }));

const recoveredAgents = recoverAfterRestart();

function errDetail(res, status, message, extra = {}) {
  return res.status(status).json({ detail: String(message), ...extra });
}

function findDataset(datasetId) {
  return getMarketDataset(Number(datasetId));
}

function makeEquityPayload(bt, metrics, maxPoints = 3000) {
  const eq = bt.equity || [];
  const ts = bt.timestamps || [];
  if (!eq.length) return { timestamps: [], equity: [], drawdown: [], metrics };
  let peak = -Infinity;
  const dd = eq.map((v) => {
    if (v > peak) peak = v;
    return peak - v;
  });
  const step = Math.max(1, Math.floor(eq.length / maxPoints));
  const timestamps = [];
  const equity = [];
  const drawdown = [];
  for (let i = 0; i < eq.length; i += step) {
    timestamps.push(ts[i]);
    equity.push(Math.round(eq[i] * 100) / 100);
    drawdown.push(Math.round(dd[i] * 100) / 100);
  }
  return { timestamps, equity, drawdown, metrics };
}

// ---------------------------------------------------------------------------
// System & Dashboard
// ---------------------------------------------------------------------------
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', recovered_agents: recoveredAgents, runtime: 'node+python3-sandbox' });
});

app.get('/api/system', (_req, res) => {
  res.json(systemMetrics());
});

app.get('/api/dashboard', (req, res) => {
  const datasets = listMarketDatasets();
  const dsId = req.query.dataset_id
    ? Number(req.query.dataset_id)
    : (datasets[datasets.length - 1]?.id ?? null);

  const exps = dsId ? store.state.experiments.filter((e) => e.dataset_id === dsId) : store.state.experiments;
  const completed = exps.filter((e) => e.status === 'completed').length;
  const failed = exps.filter((e) => e.status === 'failed').length;
  const pruned = exps.filter((e) => e.status === 'pruned').length;

  const distinctHashes = new Set(exps.map((e) => e.strategy_hash));
  let bestNetProfit = null;
  let bestWinRate = null;
  let bestSharpe = null;
  let bestProfitFactor = null;
  let lowestDrawdownPct = null;
  let bestOverallStrategy = null;
  let eligibleStrategies = 0;
  let validatedStrategies = 0;

  if (dsId) {
    const trainEligible = exps.filter(
      (e) => e.dataset_id === dsId && e.split === 'train' && e.status === 'completed' && e.eligible && e.metrics
    );
    const byKey = new Map();
    for (const e of trainEligible) byKey.set(`${e.strategy_hash}::${e.timeframe || '1m'}`, e);
    eligibleStrategies = byKey.size;
    for (const e of byKey.values()) {
      const m = e.metrics;
      if (bestNetProfit === null || m.net_profit > bestNetProfit) {
        bestNetProfit = m.net_profit;
        bestOverallStrategy = {
          strategy_hash: e.strategy_hash,
          strategy_name: e.spec?.strategy_name || e.strategy_hash,
          timeframe: e.timeframe || e.spec?.timeframe || '1m',
          net_profit: m.net_profit,
          win_rate: m.win_rate,
          profit_factor: m.profit_factor,
          max_drawdown_pct: m.max_drawdown_pct,
        };
      }
      if (bestWinRate === null || m.win_rate > bestWinRate) bestWinRate = m.win_rate;
      if (bestSharpe === null || (m.sharpe_ratio ?? -999) > bestSharpe) bestSharpe = m.sharpe_ratio;
      if (bestProfitFactor === null || (m.profit_factor ?? 0) > bestProfitFactor) bestProfitFactor = m.profit_factor;
      if (m.net_profit > 0 && (lowestDrawdownPct === null || m.max_drawdown_pct < lowestDrawdownPct)) {
        lowestDrawdownPct = m.max_drawdown_pct;
      }
    }
    const valHashes = new Set(
      store.state.validations.filter((v) => v.dataset_id === dsId && v.validated).map((v) => v.strategy_hash)
    );
    validatedStrategies = valHashes.size;
  }

  const regInds = getRegisteredIndicators();
  const regStrats = getRegisteredStrategies();
  const recent = [...store.state.agentLogs].slice(-15).reverse();
  const agentList = agentsStatus().agents;
  const rAgent = agentList.find((a) => a.name === 'research_agent');

  res.json({
    system: systemMetrics(),
    market_datasets: datasets.length,
    indicators: regInds.length,
    indicators_total: store.state.studioIndicators.length,
    strategies_registered: regStrats.length,
    strategies_total: store.state.studioStrategies.length,
    strategies_discovered: distinctHashes.size,
    trials: { completed, pruned, failed, running: rAgent?.alive ? 1 : 0 },
    experiments: { completed, failed, pruned },
    best_net_profit: bestNetProfit,
    best_win_rate: bestWinRate,
    best_sharpe_ratio: bestSharpe,
    best_profit_factor: bestProfitFactor,
    lowest_drawdown_pct: lowestDrawdownPct,
    best_overall_strategy: bestOverallStrategy,
    current_timeframe: rAgent?.current_timeframe || null,
    current_combination: rAgent?.current_combination || null,
    eligible_strategies: eligibleStrategies,
    validated_strategies: validatedStrategies,
    agents: agentList,
    recent_activity: recent,
  });
});

// ---------------------------------------------------------------------------
// Market Data Terminal & Canonical SQLite Ingestion / Resampling / Overlays
// ---------------------------------------------------------------------------
app.get('/api/market-data/status', (_req, res) => {
  const discovered = discoverHistoricalCsvFiles(HISTORICAL_DIR);
  const datasets = listMarketDatasets(true);
  const nifty = datasets.find((d) => d.name === 'NIFTY50_1MIN' && d.status === 'complete' && d.rows > 0) || null;
  let sync = getHistoricalSyncState();
  if (!nifty && sync.state === 'idle') {
    ensureCanonicalHistoricalDataset().catch(() => {});
    sync = getHistoricalSyncState();
  }
  res.json({
    historical_dir: 'data/historical',
    discovered_files_count: discovered.length,
    discovered_files: discovered.map((f) => ({ relative_path: f.relative_path, size_bytes: f.size_bytes })),
    nifty_dataset: nifty,
    datasets,
    sync,
    supported_timeframes: SUPPORTED_TIMEFRAMES,
  });
});

app.post('/api/market-data/import-historical', async (req, res) => {
  try {
    const replace = Boolean(req.body?.replace);
    const name = String(req.body?.name || 'NIFTY50_1MIN').trim();
    const files = discoverHistoricalCsvFiles(HISTORICAL_DIR);
    if (!files.length) {
      return errDetail(res, 404, 'No CSV files found in data/historical/. Place historical NIFTY50 CSV files in data/historical/ or upload CSV files directly.');
    }
    const result = await ingestHistoricalDataset({
      files,
      name,
      instrument: 'NIFTY 50 INDEX',
      symbol: 'NIFTY50',
      timeframe: '1m',
      sourceDir: HISTORICAL_DIR,
      replace,
    });
    store.clearSignalCache();
    res.json(result);
  } catch (err) {
    errDetail(res, 400, err.message);
  }
});

app.post('/api/market-data/upload', async (req, res) => {
  try {
    const {
      files,
      csv_text,
      file_name = 'upload.csv',
      name = 'NIFTY50_1MIN',
      symbol = 'NIFTY50',
      replace = true,
    } = req.body || {};
    const fileList = Array.isArray(files) && files.length
      ? files
      : (csv_text ? [{ name: file_name, content: String(csv_text) }] : []);
    if (!fileList.length) return errDetail(res, 400, 'At least one CSV file or csv_text payload is required');
    const result = await ingestUploadedCsvStreams({
      files: fileList,
      name: String(name).trim() || 'NIFTY50_1MIN',
      symbol: String(symbol).trim() || 'NIFTY50',
      replace: Boolean(replace),
    });
    store.clearSignalCache();
    res.json(result);
  } catch (err) {
    errDetail(res, 400, err.message);
  }
});

app.get('/api/market-data/datasets', (_req, res) => {
  res.json(listMarketDatasets(false));
});

app.get('/api/market-data/datasets/:id', (req, res) => {
  try {
    res.json(getMarketDataset(Number(req.params.id)));
  } catch (err) {
    errDetail(res, err.status || 404, err.message);
  }
});

app.get('/api/market-data/datasets/:id/quality', (req, res) => {
  try {
    res.json(getDatasetQualityReport(Number(req.params.id)));
  } catch (err) {
    errDetail(res, err.status || 404, err.message);
  }
});

app.get('/api/market-data/datasets/:id/timeframes', (req, res) => {
  try {
    const ds = getMarketDataset(Number(req.params.id));
    res.json({
      dataset_id: ds.id,
      symbol: ds.symbol,
      instrument: ds.instrument,
      source_timeframe: ds.timeframe,
      timeframes: SUPPORTED_TIMEFRAMES.map((tf) => ({
        timeframe: tf,
        minutes: TIMEFRAME_MINUTES[tf],
        cached: ds.cached_timeframes.includes(tf),
      })),
    });
  } catch (err) {
    errDetail(res, err.status || 404, err.message);
  }
});

app.get('/api/market-data/datasets/:id/candles', (req, res) => {
  try {
    const data = queryMarketCandles(Number(req.params.id), {
      timeframe: req.query.timeframe || '1m',
      startDate: req.query.start_date || null,
      endDate: req.query.end_date || null,
      before: req.query.before || null,
      after: req.query.after || null,
      limit: Number(req.query.limit || 1000),
      offset: Number(req.query.offset || 0),
      includePartial: req.query.include_partial !== 'false',
    });
    res.json(data);
  } catch (err) {
    errDetail(res, err.status || 400, err.message);
  }
});

app.post('/api/market-data/datasets/:id/overlays', async (req, res) => {
  try {
    const id = Number(req.params.id);
    getMarketDataset(id);
    const body = req.body || {};
    const timeframe = normalizeTimeframe(body.timeframe || '1m') || '1m';
    const reqInds = Array.isArray(body.indicators) ? body.indicators : [];
    if (!reqInds.length) return res.json({ ok: true, bars: 0, results: [] });

    const regMap = Object.fromEntries(getRegisteredIndicators().map((i) => [i.name, i]));
    const studioMap = Object.fromEntries(store.state.studioIndicators.map((i) => [i.name, i]));

    // Use provided viewport bars or query matching range + warmup bars so rolling indicators behave identically to backtest
    const limit = Math.min(5000, Math.max(50, Number(body.limit || 1000)));
    const warmup = 250;
    const viewport = queryMarketCandles(id, {
      timeframe,
      startDate: body.start_date || null,
      endDate: body.end_date || null,
      before: body.before || null,
      after: body.after || null,
      limit,
      offset: Number(body.offset || 0),
    });
    const visibleBars = viewport.bars;
    if (!visibleBars.length) {
      return res.json({ ok: true, bars: 0, volume_available: false, results: [] });
    }
    const firstVisTs = visibleBars[0].time;
    const warmupRes = queryMarketCandles(id, {
      timeframe,
      before: firstVisTs,
      limit: warmup,
    });
    const combined = [...warmupRes.bars, ...visibleBars];
    const warmLen = warmupRes.bars.length;

    const payloadInds = [];
    for (const item of reqInds) {
      const def = regMap[item.name] || studioMap[item.name];
      if (!def) continue;
      const defaults = indicatorDefaults(def);
      const merged = { ...defaults, ...(item.params || {}) };
      payloadInds.push({
        name: def.name,
        code: def.code,
        output_type: def.output_type || 'auto',
        params: merged,
      });
    }
    if (!payloadInds.length) return res.json({ ok: true, bars: visibleBars.length, volume_available: viewport.volume_available, results: [] });

    const sbRes = await runPythonSandbox({
      mode: 'overlay',
      candles: combined,
      indicators: payloadInds,
    });
    if (!sbRes.ok) {
      return errDetail(res, 400, sbRes.error?.message || 'Overlay computation failed');
    }

    // Slice away warmup prefix so arrays align 1:1 with visibleBars
    const slicedResults = (sbRes.results || []).map((r) => {
      if (!r.ok) return r;
      const sliceObjMap = (m) => {
        const out = {};
        for (const [k, arr] of Object.entries(m || {})) {
          out[k] = Array.isArray(arr) ? arr.slice(warmLen) : arr;
        }
        return out;
      };
      return {
        ...r,
        signals: Array.isArray(r.signals) ? r.signals.slice(warmLen) : [],
        overlays: sliceObjMap(r.overlays),
        oscillators: sliceObjMap(r.oscillators),
      };
    });

    res.json({
      ok: true,
      timeframe,
      bars: visibleBars.length,
      timestamps: visibleBars.map((b) => b.time),
      volume_available: viewport.volume_available,
      results: slicedResults,
    });
  } catch (err) {
    errDetail(res, err.status || 400, err.message);
  }
});

// ---------------------------------------------------------------------------
// Datasets (list, synthetic, CSV upload, local path import, candles) — backed by SQLite
// ---------------------------------------------------------------------------
app.get('/api/datasets', (_req, res) => {
  res.json(listMarketDatasets(false));
});

app.post('/api/datasets/synthetic', (req, res) => {
  try {
    const name = String(req.body?.name || 'SYNTH_1m_demo').trim();
    const days = Math.min(500, Math.max(5, Number(req.body?.days || 60)));
    const seed = Number(req.body?.seed || 42);
    const candles = generateSyntheticCandles(days, seed);
    const row = upsertDataset({
      name,
      instrument: 'Synthetic Test Index',
      symbol: 'SYNTHETIC',
      timeframe: '1m',
      source_file: 'synthetic_generator',
      candles,
      replace: true,
    });
    res.json(row);
  } catch (err) {
    errDetail(res, 400, err.message);
  }
});

app.post('/api/datasets/upload', async (req, res) => {
  try {
    const { csv_text, name, symbol, replace = true } = req.body || {};
    if (!csv_text || !name || !symbol) {
      return errDetail(res, 400, 'csv_text, name, and symbol are required');
    }
    const result = await ingestUploadedCsvStreams({
      files: [{ name: `${String(name).trim()}.csv`, content: String(csv_text) }],
      name: String(name).trim(),
      symbol: String(symbol).trim(),
      replace: Boolean(replace),
    });
    store.clearSignalCache();
    res.json(result.dataset);
  } catch (err) {
    errDetail(res, 400, err.message);
  }
});

app.post('/api/datasets/import', async (req, res) => {
  try {
    const { path: filePath, name, symbol, timeframe = '1m', replace = false } = req.body || {};
    if (!filePath || !name || !symbol) return errDetail(res, 400, 'path, name, and symbol are required');
    if (!fs.existsSync(filePath)) return errDetail(res, 400, `File not found: ${filePath}`);
    const result = await ingestHistoricalDataset({
      files: [{ path: filePath, relative_path: path.basename(filePath), size_bytes: fs.statSync(filePath).size }],
      name: String(name).trim(),
      instrument: `${symbol} Index`,
      symbol: String(symbol).trim(),
      timeframe: normalizeTimeframe(timeframe) || '1m',
      sourceDir: path.dirname(filePath),
      replace: Boolean(replace),
    });
    store.clearSignalCache();
    res.json(result.dataset);
  } catch (err) {
    errDetail(res, 400, err.message);
  }
});

app.get('/api/datasets/:id/candles', (req, res) => {
  try {
    const data = queryMarketCandles(Number(req.params.id), {
      timeframe: req.query.timeframe || '5m',
      limit: Math.min(3000, Math.max(10, Number(req.query.limit || 500))),
    });
    res.json({ timeframe: data.timeframe, bars: data.bars });
  } catch (err) {
    errDetail(res, err.status || 400, err.message);
  }
});

// ---------------------------------------------------------------------------
// Dynamic Indicator Registry (read by Agents, Optimization, Backtest, Studio)
// ---------------------------------------------------------------------------
function formatRegistryIndicator(ind) {
  const active = resolveRegisteredIndicator(ind) || ind;
  const outputKeys = active.last_validation?.output_keys || ['signal'];
  return {
    id: ind.id,
    name: ind.name,
    category: active.category,
    version: active.version,
    description: active.description,
    params: active.params,
    defaults: indicatorDefaults(active),
    output_type: active.output_type || 'auto',
    signal_rule: active.signal_rule || null,
    outputs: outputKeys,
    available: Boolean(ind.registered && ind.available),
    registered: Boolean(ind.registered),
    has_draft_changes: Boolean(ind.has_draft_changes),
    status: ind.status,
    status_reason: ind.status_reason || (ind.registered ? 'ok' : 'draft (not registered)'),
    module: `studio.indicators.${ind.name}`,
  };
}

app.get('/api/indicators', (_req, res) => {
  const all = store.state.studioIndicators.map(formatRegistryIndicator);
  const categories = {};
  for (const d of all) categories[d.category] = (categories[d.category] || 0) + 1;
  res.json({
    summary: {
      total: all.length,
      available: all.filter((d) => d.available).length,
      unavailable: all.filter((d) => !d.available).length,
      categories,
      load_errors: [],
    },
    indicators: all,
  });
});

app.get('/api/indicators/:name', (req, res) => {
  const target = normalizeIndicatorName(req.params.name);
  const found = store.state.studioIndicators.find((i) => normalizeIndicatorName(i.name) === target);
  if (!found) return errDetail(res, 404, `unknown indicator '${req.params.name}'`);
  const active = resolveRegisteredIndicator(found) || found;
  res.json({ ...active, defaults: indicatorDefaults(active), has_draft_changes: Boolean(found.has_draft_changes) });
});

app.post('/api/indicators/reload', (_req, res) => {
  const summary = reloadRegistryFromDisk();
  res.json({
    ...summary,
    reloaded: true,
    indicators: store.state.studioIndicators.map(formatRegistryIndicator),
  });
});

// ---------------------------------------------------------------------------
// Indicator Studio API (Code-First, Unlimited Custom Indicators, Isolated Sandbox)
// ---------------------------------------------------------------------------
function resolveValidationCandles(datasetId, maxBars = 1500, timeframe = '1m') {
  if (datasetId) {
    const tf = normalizeTimeframe(timeframe) || '1m';
    const raw = loadCanonicalCandlesForEngine(datasetId, { timeframe: tf, completedOnly: true }).candles;
    const bounds = splitBounds(raw.length);
    const trainSlice = raw.slice(bounds.train[0], bounds.train[1]);
    return { candles: trainSlice.slice(-maxBars), source: `dataset #${datasetId} (${tf}, train split)` };
  }
  return { candles: probeCandles(400), source: 'synthetic probe bars (import a dataset for historical market testing)' };
}

function normalizeIndicatorName(raw) {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}

function normalizeOutputType(raw) {
  const val = String(raw || 'auto').trim().toLowerCase();
  if (!['auto', 'numeric', 'signal', 'multi'].includes(val)) {
    throw new Error(`Invalid output_type '${raw}'. Use one of: auto, numeric, signal, multi.`);
  }
  return val;
}

function normalizeSignalRule(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const mode = String(raw.mode || 'none').trim().toLowerCase();
  if (!['none', 'threshold', 'cross_zero', 'price_cross', 'trend_above'].includes(mode)) {
    throw new Error(`Unsupported signal_rule mode '${raw.mode}'.`);
  }
  if (mode === 'none') return null;
  const toOptNum = (v, field) => {
    if (v === undefined || v === null || v === '') return null;
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`signal_rule.${field} must be a finite number.`);
    return n;
  };
  return {
    mode,
    buy_below: toOptNum(raw.buy_below, 'buy_below'),
    sell_above: toOptNum(raw.sell_above, 'sell_above'),
    level: toOptNum(raw.level, 'level') ?? 0,
    output_key: raw.output_key ? String(raw.output_key).trim() : null,
  };
}

function snapshotIndicatorWorking(item) {
  return {
    version: item.version,
    category: item.category,
    description: item.description,
    code: item.code,
    params: (item.params || []).map((p) => ({ ...p })),
    output_type: item.output_type || 'auto',
    signal_rule: item.signal_rule ? { ...item.signal_rule } : null,
  };
}

function migrateIndicatorRename(oldName, newName) {
  const warnings = [];
  if (!oldName || oldName === newName) return warnings;
  const escaped = oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const codeRefRe = new RegExp(`["']${escaped}["']|\\b${escaped}\\b`);

  for (const s of store.state.studioStrategies) {
    if (Array.isArray(s.linked_indicators) && s.linked_indicators.includes(oldName)) {
      const next = s.linked_indicators.map((n) => (n === oldName ? newName : n));
      s.linked_indicators = [...new Set(next)];
    }
    if (typeof s.code === 'string' && codeRefRe.test(s.code)) {
      warnings.push({
        strategy_id: s.id,
        strategy_name: s.name,
        message: `Strategy '${s.name}' Python code may still reference '${oldName}'; update indicators["${newName}"] if needed.`,
      });
    }
  }
  store.clearSignalCache(oldName);
  store.clearSignalCache(newName);
  return warnings;
}

function validateIndicatorMeta(body, existingId = null) {
  const name = normalizeIndicatorName(body.name);
  if (!/^[a-z][a-z0-9_]{1,63}$/.test(name)) {
    const err = new Error('Indicator name must be snake_case (2-64 chars, letters/digits/underscores, starting with a letter).');
    err.status = 400;
    throw err;
  }
  const dup = store.state.studioIndicators.find(
    (i) => normalizeIndicatorName(i.name) === name && i.id !== existingId
  );
  if (dup) {
    const err = new Error(`An indicator named '${name}' already exists (ID #${dup.id}).`);
    err.status = 409;
    err.code = 'DUPLICATE_INDICATOR_NAME';
    err.existing_id = dup.id;
    throw err;
  }
  const version = String(body.version || '1.0.0').trim() || '1.0.0';
  const category = String(body.category || 'Custom').trim() || 'Custom';
  const description = String(body.description || '').trim();
  const code = String(body.code || '');
  if (!code.trim()) {
    const err = new Error('Python code cannot be empty.');
    err.status = 400;
    throw err;
  }
  const params = normalizeParamSpecs(body.params || []);
  const output_type = normalizeOutputType(body.output_type);
  const signal_rule = normalizeSignalRule(body.signal_rule);
  return { name, version, category, description, code, params, output_type, signal_rule };
}

app.get('/api/studio/indicators', (_req, res) => {
  res.json({
    total: store.state.studioIndicators.length,
    registered_count: getRegisteredIndicators().length,
    items: store.state.studioIndicators,
  });
});

app.post('/api/studio/indicators', (req, res) => {
  try {
    const meta = validateIndicatorMeta(req.body || {});
    const now = utcnow();
    const item = {
      id: store.state.nextIds.indicator++,
      ...meta,
      status: 'draft',
      registered: false,
      available: false,
      has_draft_changes: false,
      working_snapshot: null,
      status_reason: 'draft — click Update Indicator to validate and register',
      last_validated_at: null,
      last_validation: null,
      last_failed_validation: null,
      created_at: now,
      updated_at: now,
    };
    store.state.studioIndicators.push(item);
    store.save();
    res.json(item);
  } catch (err) {
    errDetail(res, err.status || 400, err.message, err.code ? { code: err.code, existing_id: err.existing_id } : {});
  }
});

app.put('/api/studio/indicators/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    const idx = store.state.studioIndicators.findIndex((i) => i.id === id);
    if (idx < 0) return errDetail(res, 404, 'Indicator not found');
    const prev = store.state.studioIndicators[idx];
    const meta = validateIndicatorMeta(req.body || {}, id);
    const renameWarnings = migrateIndicatorRename(prev.name, meta.name);

    let workingSnapshot = prev.working_snapshot || null;
    let hasDraftChanges = false;
    if (prev.registered) {
      if (!workingSnapshot) {
        workingSnapshot = snapshotIndicatorWorking(prev);
      }
      hasDraftChanges =
        workingSnapshot.code !== meta.code ||
        workingSnapshot.output_type !== meta.output_type ||
        JSON.stringify(workingSnapshot.params) !== JSON.stringify(meta.params) ||
        JSON.stringify(workingSnapshot.signal_rule || null) !== JSON.stringify(meta.signal_rule || null);
      if (!hasDraftChanges) {
        workingSnapshot = null;
      }
    }

    const updated = {
      ...prev,
      ...meta,
      status: prev.registered ? 'registered' : (prev.status === 'error' ? 'error' : 'draft'),
      working_snapshot: workingSnapshot,
      has_draft_changes: hasDraftChanges,
      updated_at: utcnow(),
    };
    store.state.studioIndicators[idx] = updated;
    store.clearSignalCache(prev.id);
    store.clearSignalCache(prev.name);
    store.clearSignalCache(meta.name);
    store.save();
    res.json({ ...updated, rename_warnings: renameWarnings });
  } catch (err) {
    errDetail(res, err.status || 400, err.message, err.code ? { code: err.code, existing_id: err.existing_id } : {});
  }
});

app.delete('/api/studio/indicators/:id', (req, res) => {
  const id = Number(req.params.id);
  const idx = store.state.studioIndicators.findIndex((i) => i.id === id);
  if (idx < 0) return errDetail(res, 404, 'Indicator not found');
  const [removed] = store.state.studioIndicators.splice(idx, 1);
  store.clearSignalCache(removed.id);
  store.clearSignalCache(removed.name);
  addAgentLog('research_agent', 'info', `Indicator '${removed.name}' deleted and removed from catalogue`);
  store.save();
  res.json({ deleted: true, id, name: removed.name });
});

app.post('/api/studio/indicators/validate', async (req, res) => {
  try {
    const {
      code,
      params = [],
      dataset_id = null,
      timeframe = '1m',
      syntax_only = false,
      output_type = 'auto',
      signal_rule = null,
    } = req.body || {};
    if (!code || !String(code).trim()) return errDetail(res, 400, 'Python code cannot be empty.');
    const normParams = normalizeParamSpecs(params);
    const normOutputType = normalizeOutputType(output_type);
    const normRule = normalizeSignalRule(signal_rule);
    const defaults = Object.fromEntries(normParams.map((p) => [p.name, p.default]));
    const { candles, source } = syntax_only
      ? { candles: [], source: 'syntax check only' }
      : resolveValidationCandles(dataset_id, 1500, timeframe);
    const result = await runPythonSandbox({
      mode: 'indicator',
      code: String(code),
      candles,
      params: defaults,
      output_type: normOutputType,
      signal_rule: normRule,
      syntax_only: Boolean(syntax_only),
    });
    res.json({ ...result, data_source: source });
  } catch (err) {
    errDetail(res, err.status || 400, err.message);
  }
});

// Explicit Update Indicator flow: validate -> save -> register -> update Research Agent catalogue -> NEVER auto-start optimization
// On failure, if indicator already had a working registered version, preserve that working version untouched!
app.post('/api/studio/indicators/:id/update', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const idx = store.state.studioIndicators.findIndex((i) => i.id === id);
    if (idx < 0) return errDetail(res, 404, 'Indicator not found');
    const prev = store.state.studioIndicators[idx];
    const meta = validateIndicatorMeta(req.body || {}, id);
    const defaults = Object.fromEntries(meta.params.map((p) => [p.name, p.default]));
    const datasetId = req.body?.dataset_id || null;
    const timeframe = req.body?.timeframe || '1m';
    const { candles, source } = resolveValidationCandles(datasetId, 1500, timeframe);

    // 1. Validate code & execute in isolated Python sandbox BEFORE touching persisted working version
    const validation = await runPythonSandbox({
      mode: 'indicator',
      code: meta.code,
      candles,
      params: defaults,
      output_type: meta.output_type,
      signal_rule: meta.signal_rule,
      syntax_only: false,
    });

    if (!validation.ok) {
      const reason = `${validation.error?.type || 'ValidationError'} (line ${validation.error?.line || 1}): ${validation.error?.message}`;
      const failedVal = { ...validation, data_source: source, failed_at: utcnow() };

      if (prev.registered) {
        // Preserve the last validated working version so active strategies/agents are never broken
        const preserved = prev.working_snapshot
          ? {
              ...prev,
              ...prev.working_snapshot,
              working_snapshot: null,
              has_draft_changes: false,
            }
          : { ...prev };
        preserved.status = 'registered';
        preserved.registered = true;
        preserved.available = true;
        preserved.last_failed_validation = failedVal;
        store.state.studioIndicators[idx] = preserved;
        store.save();
        return res.status(400).json({
          detail: `${reason} — Previous working registered version '${preserved.name}' v${preserved.version} was preserved.`,
          validation: failedVal,
          indicator: preserved,
          preserved_working_version: true,
        });
      }

      const failed = {
        ...prev,
        ...meta,
        status: 'error',
        registered: false,
        available: false,
        has_draft_changes: false,
        working_snapshot: null,
        status_reason: reason,
        last_validated_at: utcnow(),
        last_validation: failedVal,
        last_failed_validation: failedVal,
        updated_at: utcnow(),
      };
      store.state.studioIndicators[idx] = failed;
      store.save();
      return res.status(400).json({
        detail: reason,
        validation: failedVal,
        indicator: failed,
        preserved_working_version: false,
      });
    }

    // 2-5. Save, register in dynamic registry, update Research Agent catalogue, do NOT auto-start optimization
    const renameWarnings = migrateIndicatorRename(prev.name, meta.name);
    const outLabel = validation.output_type || meta.output_type || 'signal';
    const registeredItem = {
      ...prev,
      ...meta,
      status: 'registered',
      registered: true,
      available: true,
      working_snapshot: null,
      has_draft_changes: false,
      last_failed_validation: null,
      status_reason: validation.causal
        ? `ok (${outLabel}, causal verified)`
        : `registered (${outLabel}, warning: prefix check flagged look-ahead)`,
      last_validated_at: utcnow(),
      last_validation: { ...validation, data_source: source },
      updated_at: utcnow(),
    };
    store.state.studioIndicators[idx] = registeredItem;
    store.clearSignalCache(prev.id);
    store.clearSignalCache(prev.name);
    store.clearSignalCache(meta.name);
    addAgentLog(
      'research_agent',
      'info',
      `Indicator '${meta.name}' v${meta.version} (${outLabel}) registered in dynamic catalogue (${getRegisteredIndicators().length} total available). No optimization started automatically.`
    );
    store.save();

    res.json({
      indicator: registeredItem,
      validation: registeredItem.last_validation,
      catalogue_size: getRegisteredIndicators().length,
      auto_started_optimization: false,
      rename_warnings: renameWarnings,
      message: `Indicator '${meta.name}' v${meta.version} (${outLabel}) validated, saved, and registered in the Research Agent catalogue. No optimization run was started automatically.`,
    });
  } catch (err) {
    errDetail(res, err.status || 400, err.message, err.code ? { code: err.code, existing_id: err.existing_id } : {});
  }
});

// ---------------------------------------------------------------------------
// Strategy Studio API (Code-First, Unlimited Custom Strategies, Isolated Sandbox)
// ---------------------------------------------------------------------------
function validateStrategyMeta(body, existingId = null) {
  const name = String(body.name || '').trim();
  if (!/^[a-zA-Z][a-zA-Z0-9_\- ]{1,79}$/.test(name)) {
    const err = new Error('Strategy name must be 2-80 characters and start with a letter.');
    err.status = 400;
    throw err;
  }
  const dup = store.state.studioStrategies.find((s) => s.name.toLowerCase() === name.toLowerCase() && s.id !== existingId);
  if (dup) {
    const err = new Error(`A strategy named '${name}' already exists (ID #${dup.id}).`);
    err.status = 409;
    err.code = 'DUPLICATE_STRATEGY_NAME';
    err.existing_id = dup.id;
    throw err;
  }
  const version = String(body.version || '1.0.0').trim() || '1.0.0';
  const description = String(body.description || '').trim();
  const direction = ['both', 'long', 'short'].includes(body.direction) ? body.direction : 'both';
  const stop_loss_pct = Math.max(0, Math.min(25, Number(body.stop_loss_pct ?? 0.5)));
  const target_pct = Math.max(0, Math.min(50, Number(body.target_pct ?? 1.0)));
  const entry_notes = String(body.entry_notes || '').trim();
  const exit_notes = String(body.exit_notes || '').trim();
  const linked_indicators = Array.isArray(body.linked_indicators) ? [...new Set(body.linked_indicators.map(String))] : [];
  const code = String(body.code || '');
  if (!code.trim()) {
    const err = new Error('Python strategy code cannot be empty.');
    err.status = 400;
    throw err;
  }
  const params = normalizeParamSpecs(body.params || []);
  return {
    name, version, description, direction, stop_loss_pct, target_pct,
    entry_notes, exit_notes, linked_indicators, code, params,
  };
}

function snapshotStrategyWorking(item) {
  return {
    version: item.version,
    description: item.description,
    direction: item.direction,
    stop_loss_pct: item.stop_loss_pct,
    target_pct: item.target_pct,
    entry_notes: item.entry_notes,
    exit_notes: item.exit_notes,
    linked_indicators: [...(item.linked_indicators || [])],
    params: (item.params || []).map((p) => ({ ...p })),
    code: item.code,
  };
}

app.get('/api/studio/strategies', (_req, res) => {
  res.json({
    total: store.state.studioStrategies.length,
    registered_count: getRegisteredStrategies().length,
    items: store.state.studioStrategies,
  });
});

app.post('/api/studio/strategies', (req, res) => {
  try {
    const meta = validateStrategyMeta(req.body || {});
    const now = utcnow();
    const item = {
      id: store.state.nextIds.strategy++,
      ...meta,
      status: 'draft',
      registered: false,
      available: false,
      has_draft_changes: false,
      working_snapshot: null,
      status_reason: 'draft — click Update Strategy to validate and register',
      last_validated_at: null,
      last_validation: null,
      last_failed_validation: null,
      created_at: now,
      updated_at: now,
    };
    store.state.studioStrategies.push(item);
    store.save();
    res.json(item);
  } catch (err) {
    errDetail(res, err.status || 400, err.message, err.code ? { code: err.code, existing_id: err.existing_id } : {});
  }
});

app.put('/api/studio/strategies/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    const idx = store.state.studioStrategies.findIndex((s) => s.id === id);
    if (idx < 0) return errDetail(res, 404, 'Strategy not found');
    const prev = store.state.studioStrategies[idx];
    const meta = validateStrategyMeta(req.body || {}, id);

    let workingSnapshot = prev.working_snapshot || null;
    let hasDraftChanges = false;
    if (prev.registered) {
      if (!workingSnapshot) workingSnapshot = snapshotStrategyWorking(prev);
      hasDraftChanges =
        workingSnapshot.code !== meta.code ||
        workingSnapshot.direction !== meta.direction ||
        workingSnapshot.stop_loss_pct !== meta.stop_loss_pct ||
        workingSnapshot.target_pct !== meta.target_pct ||
        JSON.stringify(workingSnapshot.linked_indicators) !== JSON.stringify(meta.linked_indicators) ||
        JSON.stringify(workingSnapshot.params) !== JSON.stringify(meta.params);
      if (!hasDraftChanges) workingSnapshot = null;
    }

    const updated = {
      ...prev,
      ...meta,
      status: prev.registered ? 'registered' : (prev.status === 'error' ? 'error' : 'draft'),
      working_snapshot: workingSnapshot,
      has_draft_changes: hasDraftChanges,
      updated_at: utcnow(),
    };
    store.state.studioStrategies[idx] = updated;
    store.save();
    res.json(updated);
  } catch (err) {
    errDetail(res, err.status || 400, err.message, err.code ? { code: err.code, existing_id: err.existing_id } : {});
  }
});

app.delete('/api/studio/strategies/:id', (req, res) => {
  const id = Number(req.params.id);
  const idx = store.state.studioStrategies.findIndex((s) => s.id === id);
  if (idx < 0) return errDetail(res, 404, 'Strategy not found');
  const [removed] = store.state.studioStrategies.splice(idx, 1);
  addAgentLog('research_agent', 'info', `Strategy '${removed.name}' deleted and removed from catalogue`);
  store.save();
  res.json({ deleted: true, id, name: removed.name });
});

async function executeStrategyValidation({ code, params = [], linked_indicators = [], direction = 'both', stop_loss_pct = 0.5, target_pct = 1.0, dataset_id = null, timeframe = '1m', syntax_only = false }) {
  const normParams = normalizeParamSpecs(params);
  const defaults = Object.fromEntries(normParams.map((p) => [p.name, p.default]));
  const regMap = Object.fromEntries(getRegisteredIndicators().map((i) => [i.name, i]));
  const indicatorCodes = [];
  if (!syntax_only) {
    for (const indName of linked_indicators) {
      const indDef = regMap[indName];
      if (!indDef) {
        throw new Error(`Linked indicator '${indName}' is not registered or unavailable. Update it in Indicator Studio first.`);
      }
      indicatorCodes.push({
        name: indDef.name,
        code: indDef.code,
        output_type: indDef.output_type || 'auto',
        params: indicatorDefaults(indDef),
      });
    }
  }
  const { candles, source } = syntax_only
    ? { candles: [], source: 'syntax check only' }
    : resolveValidationCandles(dataset_id, 1500, timeframe);
  const sandboxRes = await runPythonSandbox({
    mode: 'strategy',
    code: String(code),
    candles,
    params: defaults,
    indicator_codes: indicatorCodes,
    syntax_only: Boolean(syntax_only),
  });
  if (!sandboxRes.ok || syntax_only) {
    return { ...sandboxRes, data_source: source, metrics: null };
  }
  const { runBacktest, computeMetrics } = await import('./server_engine.js');
  const bt = runBacktest(candles, sandboxRes.signals, {
    min_votes: 1,
    direction,
    stop_loss_pct: sandboxRes.stop_loss_pct ?? stop_loss_pct,
    target_pct: sandboxRes.target_pct ?? target_pct,
    exit_signals: sandboxRes.exit_signals,
  });
  const metrics = computeMetrics(bt.trades, bt.equity, DEFAULT_BACKTEST.initial_capital, bt.final_capital, MIN_TRADES, bt.skipped_entries, normalizeTimeframe(timeframe) || '1m');
  return {
    ...sandboxRes,
    signals: undefined,
    exit_signals: undefined,
    data_source: source,
    metrics,
  };
}

app.post('/api/studio/strategies/validate', async (req, res) => {
  try {
    const body = req.body || {};
    if (!body.code || !String(body.code).trim()) return errDetail(res, 400, 'Python strategy code cannot be empty.');
    const result = await executeStrategyValidation(body);
    res.json(result);
  } catch (err) {
    errDetail(res, err.status || 400, err.message);
  }
});

// Explicit Update Strategy flow: validate -> save -> register -> update Research Agent catalogue -> NEVER auto-start optimization
app.post('/api/studio/strategies/:id/update', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const idx = store.state.studioStrategies.findIndex((s) => s.id === id);
    if (idx < 0) return errDetail(res, 404, 'Strategy not found');
    const prev = store.state.studioStrategies[idx];
    const meta = validateStrategyMeta(req.body || {}, id);
    const datasetId = req.body?.dataset_id || null;
    const timeframe = req.body?.timeframe || '1m';

    const validation = await executeStrategyValidation({
      ...meta,
      dataset_id: datasetId,
      timeframe,
      syntax_only: false,
    });

    if (!validation.ok) {
      const reason = `${validation.error?.type || 'ValidationError'} (line ${validation.error?.line || 1}): ${validation.error?.message}`;
      const failedVal = { ...validation, failed_at: utcnow() };

      if (prev.registered) {
        const preserved = prev.working_snapshot
          ? { ...prev, ...prev.working_snapshot, working_snapshot: null, has_draft_changes: false }
          : { ...prev };
        preserved.status = 'registered';
        preserved.registered = true;
        preserved.available = true;
        preserved.last_failed_validation = failedVal;
        store.state.studioStrategies[idx] = preserved;
        store.save();
        return res.status(400).json({
          detail: `${reason} — Previous working registered strategy '${preserved.name}' v${preserved.version} was preserved.`,
          validation: failedVal,
          strategy: preserved,
          preserved_working_version: true,
        });
      }

      const failed = {
        ...prev,
        ...meta,
        status: 'error',
        registered: false,
        available: false,
        has_draft_changes: false,
        working_snapshot: null,
        status_reason: reason,
        last_validated_at: utcnow(),
        last_validation: failedVal,
        last_failed_validation: failedVal,
        updated_at: utcnow(),
      };
      store.state.studioStrategies[idx] = failed;
      store.save();
      return res.status(400).json({
        detail: reason,
        validation: failedVal,
        strategy: failed,
        preserved_working_version: false,
      });
    }

    const registeredItem = {
      ...prev,
      ...meta,
      status: 'registered',
      registered: true,
      available: true,
      working_snapshot: null,
      has_draft_changes: false,
      last_failed_validation: null,
      status_reason: 'ok (validated in isolated sandbox)',
      last_validated_at: utcnow(),
      last_validation: validation,
      updated_at: utcnow(),
    };
    store.state.studioStrategies[idx] = registeredItem;
    addAgentLog(
      'research_agent',
      'info',
      `Strategy '${meta.name}' v${meta.version} registered in dynamic catalogue (${getRegisteredStrategies().length} total available). No optimization started automatically.`
    );
    store.save();

    res.json({
      strategy: registeredItem,
      validation,
      catalogue_size: getRegisteredStrategies().length,
      auto_started_optimization: false,
      message: `Strategy '${meta.name}' v${meta.version} validated, saved, and registered in the Research Agent catalogue. No optimization run was started automatically.`,
    });
  } catch (err) {
    errDetail(res, err.status || 400, err.message, err.code ? { code: err.code, existing_id: err.existing_id } : {});
  }
});

// ---------------------------------------------------------------------------
// Strategy options & describe (without hardcoded templates)
// ---------------------------------------------------------------------------
app.get('/api/strategy/templates', (_req, res) => {
  res.json([]);
});

app.get('/api/strategy/options', (_req, res) => {
  res.json({
    directions: ['both', 'long', 'short'],
    stop_loss_choices: [0, 0.2, 0.3, 0.5, 0.8, 1.0],
    target_choices: [0, 0.3, 0.5, 0.8, 1.0, 1.5, 2.0],
    max_indicators: null, // unlimited
    defaults: { ...DEFAULT_BACKTEST, min_trades: MIN_TRADES },
  });
});

app.post('/api/strategy/describe', (req, res) => {
  try {
    const spec = buildStrategySpec(req.body || {});
    res.json({ hash: specHash(spec), description: describeSpec(spec), spec });
  } catch (err) {
    errDetail(res, 400, err.message);
  }
});

// ---------------------------------------------------------------------------
// Backtest & Out-of-Sample
// ---------------------------------------------------------------------------
function makeBacktestConfig(body) {
  return {
    initial_capital: Number(body.initial_capital || DEFAULT_BACKTEST.initial_capital),
    position_pct: Number(body.position_pct || DEFAULT_BACKTEST.position_pct),
    lot_size: DEFAULT_BACKTEST.lot_size,
    brokerage_per_order: body.brokerage_per_order !== undefined ? Number(body.brokerage_per_order) : DEFAULT_BACKTEST.brokerage_per_order,
    charges_pct: body.charges_pct !== undefined ? Number(body.charges_pct) : DEFAULT_BACKTEST.charges_pct,
    slippage_points: body.slippage_points !== undefined ? Number(body.slippage_points) : DEFAULT_BACKTEST.slippage_points,
    no_entry_after_minute: DEFAULT_BACKTEST.no_entry_after_minute,
    square_off_minute: DEFAULT_BACKTEST.square_off_minute,
  };
}

app.post('/api/backtest', async (req, res) => {
  try {
    const body = req.body || {};
    findDataset(body.dataset_id);
    if (!['train', 'validation'].includes(body.split || 'validation')) {
      return errDetail(res, 400, 'use /api/backtest/oos for the out-of-sample split');
    }
    const tf = normalizeTimeframe(body.timeframe || body.strategy?.timeframe || body.chart_timeframe || '1m') || '1m';
    const startDate = body.start_date || null;
    const endDate = body.end_date || null;
    const spec = body.strategy?.strategy_ids?.length
      ? {
          strategy_name: body.strategy.strategy_name || 'Custom Strategy',
          strategy_ids: body.strategy.strategy_ids,
          strategy_params: body.strategy.strategy_params || {},
          timeframe: tf,
          indicators: body.strategy.indicators || [],
          min_votes: body.strategy.min_votes || 1,
          direction: body.strategy.direction || 'both',
          stop_loss_pct: Number(body.strategy.stop_loss_pct ?? 0.5),
          target_pct: Number(body.strategy.target_pct ?? 1.0),
        }
      : buildStrategySpec({ ...(body.strategy || {}), timeframe: tf });

    const cfg = makeBacktestConfig(body);
    const { bt, metrics, slice, timeframe: usedTf } = await evaluateSpecFull(body.dataset_id, spec, body.split || 'validation', {
      timeframe: tf,
      startDate,
      endDate,
      backtestCfg: cfg,
    });
    const chart = slice.slice(-1500);
    res.json({
      strategy: { hash: specHash(spec), description: describeSpec(spec), spec },
      split: body.split || 'validation',
      timeframe: usedTf,
      metrics,
      trades: bt.trades,
      equity: makeEquityPayload(bt, metrics),
      candles: chart,
    });
  } catch (err) {
    errDetail(res, err.status || 400, err.message);
  }
});

app.post('/api/backtest/oos', async (req, res) => {
  try {
    const body = req.body || {};
    findDataset(body.dataset_id);
    const tf = normalizeTimeframe(body.timeframe || body.strategy?.timeframe || '1m') || '1m';
    const startDate = body.start_date || null;
    const endDate = body.end_date || null;
    const spec = body.strategy?.strategy_ids?.length
      ? { ...body.strategy, timeframe: tf }
      : buildStrategySpec({ ...(body.strategy || {}), timeframe: tf });
    const hash = specHash(spec);
    const existing = store.state.oosTests.find(
      (o) => o.strategy_hash === hash && o.dataset_id === Number(body.dataset_id) && (o.timeframe || '1m') === tf
    );
    if (existing) {
      return res.json({ already_run: true, created_at: existing.created_at, timeframe: tf, metrics: existing.metrics });
    }
    const cfg = makeBacktestConfig(body);
    const { metrics } = await evaluateSpecFull(body.dataset_id, spec, 'oos', {
      timeframe: tf,
      startDate,
      endDate,
      backtestCfg: cfg,
    });
    const rec = { strategy_hash: hash, dataset_id: Number(body.dataset_id), timeframe: tf, created_at: utcnow(), metrics };
    store.state.oosTests.push(rec);
    store.save();
    res.json({ already_run: false, timeframe: tf, metrics });
  } catch (err) {
    errDetail(res, err.status || 400, err.message);
  }
});

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------
app.get('/api/agents', (_req, res) => {
  res.json(agentsStatus());
});

app.post('/api/agents/start', (req, res) => {
  try {
    findDataset(req.body?.dataset_id);
    res.json(startAutonomousAgents(req.body));
  } catch (err) {
    errDetail(res, err.status || 400, err.message);
  }
});

app.post('/api/agents/:name/:action', (req, res) => {
  try {
    res.json(controlAgent(req.params.name, req.params.action));
  } catch (err) {
    errDetail(res, 400, err.message);
  }
});

app.get('/api/agents/:name/logs', (req, res) => {
  const after = Number(req.query.after || 0);
  const limit = Math.min(1000, Number(req.query.limit || 200));
  const rows = store.state.agentLogs
    .filter((l) => l.agent === req.params.name && l.id > after)
    .slice(-limit);
  res.json(rows);
});

app.get('/api/agents/evaluation/snapshot', (_req, res) => {
  res.json(store.state.agentCheckpoints.evaluation_agent?.state || buildEvaluationSnapshot());
});

// ---------------------------------------------------------------------------
// Optimization
// ---------------------------------------------------------------------------
app.get('/api/optimization/options', (_req, res) => {
  res.json({
    samplers: ['tpe', 'ga', 'forward', 'backward', 'hill', 'nsga2', 'random', 'grid'],
    pruners: ['median', 'none'],
    objectives: ['net_profit', 'sharpe_ratio', 'sortino_ratio', 'profit_factor', 'recovery_factor', 'min_drawdown', 'multi_objective'],
    timeframes: SUPPORTED_TIMEFRAMES,
    max_indicators: null,
    catalogue: {
      indicators: getRegisteredIndicators().length,
      strategies: getRegisteredStrategies().length,
    },
    notes: {
      grid: 'exhaustive over discretised choices; size is capped by trial budget',
      cmaes: 'continuous-only sampler; categorical choices fall back to independent sampling',
      nsga2: 'multi-objective: net profit and drawdown; pruning is disabled',
    },
  });
});

app.get('/api/optimization/runs', (_req, res) => {
  res.json(getOptimizationRuns());
});

app.post('/api/optimization/start', (req, res) => {
  try {
    findDataset(req.body?.dataset_id);
    res.json(startOptimizationStudy(req.body));
  } catch (err) {
    errDetail(res, err.status || 400, err.message);
  }
});

app.post('/api/optimization/:study/:action', (req, res) => {
  try {
    res.json(controlOptimizationStudy(req.params.study, req.params.action));
  } catch (err) {
    errDetail(res, 400, err.message);
  }
});

app.get('/api/optimization/studies/:study', (req, res) => {
  const name = req.params.study;
  const run = store.state.optimizationRuns.find((r) => r.study_name === name);
  if (!run) return errDetail(res, 404, `study '${name}' not found`);
  const trials = store.state.experiments.filter((e) => e.study_name === name);
  const complete = trials.filter((t) => t.status === 'completed');
  const best = complete.length
    ? complete.reduce((a, b) => ((b.metrics?.net_profit ?? -1e12) > (a.metrics?.net_profit ?? -1e12) ? b : a))
    : null;
  res.json({
    study_name: name,
    trials: trials.length,
    states: {
      complete: complete.length,
      pruned: trials.filter((t) => t.status === 'pruned').length,
      failed: trials.filter((t) => t.status === 'failed').length,
      running: 0,
    },
    best: best ? { value: best.metrics.net_profit, timeframe: best.timeframe || '1m', params: describeSpec(best.spec), strategy_hash: best.strategy_hash } : null,
  });
});

// ---------------------------------------------------------------------------
// Results & Experiments
// ---------------------------------------------------------------------------
app.get('/api/results/rankings', (req, res) => {
  try {
    const datasetId = Number(req.query.dataset_id);
    findDataset(datasetId);
    const top = Math.min(200, Math.max(1, Number(req.query.top || 50)));
    const split = String(req.query.split || 'train');
    const timeframe = String(req.query.timeframe || 'all');
    const indicator = String(req.query.indicator || '');
    const numIndicators = Number(req.query.num_indicators || 0);
    const out = {};
    for (const key of Object.keys(RANKINGS)) {
      out[key] = getLeaderboard(key, datasetId, { top, split, timeframe, indicator, numIndicators });
    }
    res.json(out);
  } catch (err) {
    errDetail(res, err.status || 400, err.message);
  }
});

app.get('/api/results/rankings/:key', (req, res) => {
  try {
    const datasetId = Number(req.query.dataset_id);
    findDataset(datasetId);
    const top = Math.min(200, Math.max(1, Number(req.query.top || 50)));
    const split = String(req.query.split || 'train');
    const timeframe = String(req.query.timeframe || 'all');
    const indicator = String(req.query.indicator || '');
    const numIndicators = Number(req.query.num_indicators || 0);
    res.json(getLeaderboard(req.params.key, datasetId, { top, split, timeframe, indicator, numIndicators }));
  } catch (err) {
    errDetail(res, err.status || 400, err.message);
  }
});

app.get('/api/results/strategies/:hash', (req, res) => {
  const datasetId = Number(req.query.dataset_id);
  const rows = store.state.experiments.filter(
    (e) => e.strategy_hash === req.params.hash && e.dataset_id === datasetId && e.status === 'completed'
  );
  if (!rows.length) return errDetail(res, 404, 'strategy not found');
  const validations = store.state.validations.filter((v) => v.strategy_hash === req.params.hash && v.dataset_id === datasetId).reverse();
  const oos = store.state.oosTests.find((o) => o.strategy_hash === req.params.hash && o.dataset_id === datasetId) || null;
  const dsr = store.state.statisticalTests.filter((s) => s.strategy_hash === req.params.hash && s.dataset_id === datasetId && s.kind === 'dsr').slice(-1)[0] || null;
  res.json({
    hash: req.params.hash,
    spec: rows[0].spec,
    timeframe: rows[0].timeframe || rows[0].spec?.timeframe || '1m',
    experiments: rows.map((r) => ({ split: r.split, timeframe: r.timeframe || r.spec?.timeframe || '1m', metrics: r.metrics, created_at: r.created_at, agent: r.agent, study: r.study_name })),
    validations,
    out_of_sample: oos ? { timeframe: oos.timeframe || rows[0].timeframe || '1m', metrics: oos.metrics, created_at: oos.created_at } : null,
    dsr: dsr?.result || null,
  });
});

app.get('/api/experiments', (req, res) => {
  const datasetId = req.query.dataset_id ? Number(req.query.dataset_id) : null;
  const study = req.query.study || null;
  const status = req.query.status || null;
  const limit = Math.min(1000, Number(req.query.limit || 100));
  const offset = Number(req.query.offset || 0);

  let rows = [...store.state.experiments].reverse();
  if (datasetId !== null) rows = rows.filter((r) => r.dataset_id === datasetId);
  if (study) rows = rows.filter((r) => r.study_name === study);
  if (status) rows = rows.filter((r) => r.status === status);
  const total = rows.length;
  const paged = rows.slice(offset, offset + limit).map((r) => ({
    ...r,
    description: describeSpec(r.spec),
  }));
  res.json({ total, rows: paged });
});

app.get('/api/experiments/:id', (req, res) => {
  const row = store.state.experiments.find((e) => e.id === Number(req.params.id));
  if (!row) return errDetail(res, 404, 'experiment not found');
  res.json(row);
});

// ---------------------------------------------------------------------------
// Analytics & Statistics
// ---------------------------------------------------------------------------
app.get('/api/analytics/optuna/:study/:chart', (req, res) => {
  const { study, chart } = req.params;
  const trials = store.state.experiments
    .filter((e) => e.study_name === study && e.status === 'completed' && e.metrics)
    .sort((a, b) => (a.trial_number || a.id) - (b.trial_number || b.id));
  if (!trials.length) return errDetail(res, 400, `Study '${study}' has no completed trials yet`);

  if (chart === 'history') {
    const x = trials.map((t, i) => t.trial_number ?? i + 1);
    const y = trials.map((t) => t.metrics.net_profit);
    let bestSoFar = -Infinity;
    const bestCurve = y.map((v) => { bestSoFar = Math.max(bestSoFar, v); return bestSoFar; });
    return res.json({
      data: [
        { type: 'scatter', mode: 'markers', name: 'Trial Net Profit', x, y, marker: { color: '#4f8cff', size: 7 } },
        { type: 'scatter', mode: 'lines', name: 'Best Value', x, y: bestCurve, line: { color: '#22c55e', width: 2 } },
      ],
      layout: { title: `Optimization History (${study})`, xaxis: { title: 'Trial' }, yaxis: { title: 'Net Profit' } },
    });
  }
  if (chart === 'pareto') {
    return res.json({
      data: [{
        type: 'scatter', mode: 'markers', name: 'Trials',
        x: trials.map((t) => t.metrics.max_drawdown_pct),
        y: trials.map((t) => t.metrics.net_profit),
        text: trials.map((t) => describeSpec(t.spec)),
        marker: { color: '#4f8cff', size: 8 },
      }],
      layout: { title: 'Profit vs Max Drawdown %', xaxis: { title: 'Max Drawdown %' }, yaxis: { title: 'Net Profit' } },
    });
  }
  if (chart === 'importance') {
    const counts = new Map();
    for (const t of trials) {
      for (const ind of t.spec?.indicators || []) {
        const list = counts.get(ind.name) || [];
        list.push(t.metrics.net_profit);
        counts.set(ind.name, list);
      }
    }
    const entries = [...counts.entries()].map(([name, vals]) => [name, vals.reduce((a, b) => a + b, 0) / vals.length]);
    return res.json({
      data: [{ type: 'bar', orientation: 'h', y: entries.map((e) => e[0]), x: entries.map((e) => e[1]), marker: { color: '#4f8cff' } }],
      layout: { title: 'Mean Net Profit by Indicator Presence', xaxis: { title: 'Mean Net Profit' } },
    });
  }
  // Fallback slice/contour/parallel over trial numbers & sharpe
  return res.json({
    data: [{
      type: 'scatter', mode: 'markers',
      x: trials.map((t) => t.metrics.trades),
      y: trials.map((t) => t.metrics.sharpe_ratio ?? 0),
      text: trials.map((t) => describeSpec(t.spec)),
      marker: { color: trials.map((t) => t.metrics.net_profit), colorscale: 'Viridis', size: 9, showscale: true },
    }],
    layout: { title: `${chart} view (${study})`, xaxis: { title: 'Trades' }, yaxis: { title: 'Sharpe Ratio' } },
  });
});

app.get('/api/analytics/equity', async (req, res) => {
  try {
    const datasetId = Number(req.query.dataset_id);
    const hash = String(req.query.strategy_hash || '');
    const split = String(req.query.split || 'validation');
    if (!['train', 'validation'].includes(split)) return errDetail(res, 400, 'equity analytics supports train and validation only');
    const exp = store.state.experiments.find((e) => e.strategy_hash === hash && e.dataset_id === datasetId);
    if (!exp) return errDetail(res, 404, 'strategy not found');
    const { bt, metrics } = await evaluateSpecFull(datasetId, exp.spec, split, {
      timeframe: req.query.timeframe || exp.timeframe || exp.spec?.timeframe || '1m',
      startDate: exp.start_date || null,
      endDate: exp.end_date || null,
    });
    res.json({ split, timeframe: exp.timeframe || '1m', ...makeEquityPayload(bt, metrics), trades: bt.trades });
  } catch (err) {
    errDetail(res, 400, err.message);
  }
});

app.get('/api/analytics/walk_forward', (req, res) => {
  const datasetId = Number(req.query.dataset_id);
  const seen = new Set();
  const out = [];
  for (const v of [...store.state.validations].reverse()) {
    if (v.dataset_id !== datasetId || seen.has(v.strategy_hash)) continue;
    seen.add(v.strategy_hash);
    out.push(v);
  }
  res.json(out);
});

app.get('/api/analytics/train_vs_validation', (req, res) => {
  const datasetId = Number(req.query.dataset_id);
  const vals = new Map();
  for (const v of store.state.validations) {
    if (v.dataset_id === datasetId) vals.set(v.strategy_hash, v);
  }
  const out = [];
  const seen = new Set();
  for (const e of [...store.state.experiments].reverse()) {
    if (e.dataset_id !== datasetId || e.split !== 'train' || e.status !== 'completed' || seen.has(e.strategy_hash)) continue;
    const v = vals.get(e.strategy_hash);
    if (!v) continue;
    seen.add(e.strategy_hash);
    out.push({
      strategy_hash: e.strategy_hash,
      train_net_profit: e.metrics.net_profit,
      validation_net_profit: v.validation_net_profit,
      validated: Boolean(v.validated),
    });
  }
  res.json(out);
});

app.post('/api/statistics/dsr', (req, res) => {
  try {
    findDataset(req.body?.dataset_id);
    if ((req.body?.split || 'train') !== 'train') {
      return errDetail(res, 400, 'DSR is computed on the train split only');
    }
    res.json(computeDsrForDataset(req.body.dataset_id, 'train'));
  } catch (err) {
    errDetail(res, err.status || 400, err.message);
  }
});

app.get('/api/statistics', (req, res) => {
  const datasetId = Number(req.query.dataset_id);
  const kind = req.query.kind || null;
  let rows = store.state.statisticalTests.filter((s) => s.dataset_id === datasetId);
  if (kind) rows = rows.filter((s) => s.kind === kind);
  res.json(rows);
});

// ---------------------------------------------------------------------------
// Frontend Hosting (Vite dev middleware or built dist) on 0.0.0.0:3000
// ---------------------------------------------------------------------------
async function startServer() {
  if (!IS_PROD) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      root: path.join(__dirname, 'frontend'),
      configFile: path.join(__dirname, 'frontend', 'vite.config.js'),
      server: {
        middlewareMode: true,
        hmr: false,
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.join(__dirname, 'frontend', 'dist');
    app.use(express.static(distDir));
    app.get('/{*splat}', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, HOST, () => {
    console.log(`[IndicatorLab] Server listening on http://${HOST}:${PORT} (${IS_PROD ? 'production' : 'development'})`);
    ensureCanonicalHistoricalDataset().then((r) => {
      if (r?.action === 'ingested') {
        console.log(`[MarketData] Canonical NIFTY50_1MIN ready (${r.dataset?.rows?.toLocaleString()} candles).`);
      } else if (r?.action === 'error') {
        console.warn(`[MarketData] Historical auto-load diagnostic: ${r.diagnostic}`);
      }
    }).catch(() => {});
  });
}

startServer();
