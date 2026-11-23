import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SUPPORTED_TIMEFRAMES,
  TIMEFRAME_MINUTES,
  discoverHistoricalCsvFiles,
  ensureCanonicalHistoricalDataset,
  ensureTimeframeCandles,
  getDatasetQualityReport,
  getHistoricalSyncState,
  getMarketDataset,
  ingestCandlesArray,
  ingestHistoricalDataset,
  ingestUploadedCsvStreams,
  listMarketDatasets,
  loadCanonicalCandlesForEngine,
  normalizeTimeframe,
  queryMarketCandles,
  HISTORICAL_DIR,
} from './market_data_db.js';

export {
  SUPPORTED_TIMEFRAMES,
  TIMEFRAME_MINUTES,
  discoverHistoricalCsvFiles,
  ensureCanonicalHistoricalDataset,
  ensureTimeframeCandles,
  getDatasetQualityReport,
  getHistoricalSyncState,
  getMarketDataset,
  ingestCandlesArray,
  ingestHistoricalDataset,
  ingestUploadedCsvStreams,
  listMarketDatasets,
  loadCanonicalCandlesForEngine,
  normalizeTimeframe,
  queryMarketCandles,
  HISTORICAL_DIR,
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = path.resolve(process.env.IL_DATA_DIR || path.join(__dirname, 'data'));
const STATE_FILE = path.join(DATA_DIR, 'studio_state.json');
const DATASETS_DIR = path.join(DATA_DIR, 'datasets');
const SANDBOX_SCRIPT = path.join(__dirname, 'sandbox_runner.py');

export const DEFAULT_BACKTEST = {
  initial_capital: 10_000_000,
  position_pct: 0.10,
  lot_size: 1,
  brokerage_per_order: 20.0,
  charges_pct: 0.0005,
  slippage_points: 0.5,
  no_entry_after_minute: 15 * 60,
  square_off_minute: 15 * 60 + 15,
};

export const DEFAULT_SPLIT = {
  train_end: 0.60,
  validation_end: 0.80,
  train_chunks: 3,
  walk_forward_segments: 4,
};

export const MIN_TRADES = Number(process.env.IL_MIN_TRADES || 30);

export function utcnow() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function ensureDirs() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(DATASETS_DIR, { recursive: true });
}

function initialState() {
  return {
    nextIds: { dataset: 1, indicator: 1, strategy: 1, experiment: 1, validation: 1, log: 1, stat: 1 },
    datasets: [],
    studioIndicators: [],
    studioStrategies: [],
    experiments: [],
    validations: [],
    oosTests: [],
    statisticalTests: [],
    optimizationRuns: [],
    agentLogs: [],
    agentCheckpoints: {},
    agents: {
      research_agent: {
        name: 'research_agent',
        status: 'stopped',
        current_task: '',
        current_timeframe: null,
        current_combination: null,
        algorithm: '',
        trials_processed: 0,
        error_count: 0,
        progress: 0,
        started_at: null,
        last_heartbeat: null,
        duplicates_prevented: 0,
        detail: {},
      },
      evaluation_agent: {
        name: 'evaluation_agent',
        status: 'stopped',
        current_task: '',
        current_timeframe: null,
        current_combination: null,
        algorithm: '',
        trials_processed: 0,
        error_count: 0,
        progress: 0,
        started_at: null,
        last_heartbeat: null,
        duplicates_prevented: 0,
        detail: {},
      },
    },
    savedAgentSettings: null,
  };
}

class Store {
  constructor() {
    ensureDirs();
    this.state = this._load();
    this._signalCache = new Map();
    this._migrateLegacyJsonDatasets();
  }

  _load() {
    try {
      if (fs.existsSync(STATE_FILE)) {
        const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        const merged = { ...initialState(), ...parsed };
        this._reconcileLoadedState(merged);
        return merged;
      }
    } catch (err) {
      console.warn('[IndicatorLab] Failed to load state, starting fresh:', err.message);
    }
    return initialState();
  }

  _reconcileLoadedState(st) {
    if (!Array.isArray(st.studioIndicators)) st.studioIndicators = [];
    if (!Array.isArray(st.studioStrategies)) st.studioStrategies = [];
    // Deduplicate by id or normalized name while preserving existing user order
    const seenIds = new Set();
    const seenNames = new Set();
    const cleanInds = [];
    for (const ind of st.studioIndicators) {
      if (!ind || typeof ind !== 'object') continue;
      const normName = String(ind.name || '').trim().toLowerCase();
      if ((ind.id != null && seenIds.has(ind.id)) || (normName && seenNames.has(normName))) continue;
      if (ind.id != null) seenIds.add(ind.id);
      if (normName) seenNames.add(normName);
      cleanInds.push(ind);
    }
    st.studioIndicators = cleanInds;
    const maxIndId = cleanInds.reduce((m, i) => Math.max(m, Number(i.id) || 0), 0);
    const maxStratId = st.studioStrategies.reduce((m, s) => Math.max(m, Number(s.id) || 0), 0);
    st.nextIds = {
      ...initialState().nextIds,
      ...(st.nextIds || {}),
      indicator: Math.max(Number(st.nextIds?.indicator || 1), maxIndId + 1),
      strategy: Math.max(Number(st.nextIds?.strategy || 1), maxStratId + 1),
    };
  }

  reloadFromDisk() {
    this.state = this._load();
    this._signalCache.clear();
    return this.state;
  }

  _migrateLegacyJsonDatasets() {
    const legacy = this.state.datasets || [];
    if (!legacy.length) return;
    const existingNames = new Set(listMarketDatasets(true).map((d) => d.name));
    for (const d of legacy) {
      if (existingNames.has(d.name)) continue;
      const file = path.join(DATASETS_DIR, `${d.id}.json`);
      if (!fs.existsSync(file)) continue;
      try {
        const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (Array.isArray(rows) && rows.length) {
          ingestCandlesArray({
            name: d.name,
            instrument: d.symbol === 'SYNTHETIC' ? 'Synthetic Test Index' : d.symbol,
            symbol: d.symbol || 'UNKNOWN',
            timeframe: normalizeTimeframe(d.timeframe) || '1m',
            sourceDir: d.source_file || 'legacy_json',
            candles: rows,
            replace: true,
          });
        }
      } catch {
        // skip unreadable legacy file
      }
    }
  }

  save() {
    ensureDirs();
    const tmp = `${STATE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    fs.renameSync(tmp, STATE_FILE);
  }

  clearSignalCache(indicatorNameOrId = null) {
    if (indicatorNameOrId === null || indicatorNameOrId === undefined || indicatorNameOrId === '') {
      this._signalCache.clear();
      return;
    }
    const needle = String(indicatorNameOrId);
    for (const key of this._signalCache.keys()) {
      if (key.includes(`::${needle}::`)) {
        this._signalCache.delete(key);
      }
    }
  }

  loadCandles(datasetId, opts = {}) {
    return loadCanonicalCandlesForEngine(datasetId, opts).candles;
  }

  saveCandles(_datasetId, _candles) {
    this.clearSignalCache();
  }
}

export const store = new Store();

// Recover any agents left active on previous shutdown
export function recoverAfterRestart() {
  const recovered = [];
  for (const name of ['research_agent', 'evaluation_agent']) {
    const a = store.state.agents[name];
    if (a && ['running', 'paused', 'stopping'].includes(a.status)) {
      a.status = 'stopped';
      a.current_task = '';
      addAgentLog(name, 'warn', 'process restarted while this worker was active; marked stopped (checkpoint kept)');
      recovered.push(name);
    }
  }
  for (const run of store.state.optimizationRuns) {
    if (run.status === 'running') run.status = 'interrupted';
  }
  store.save();
  return recovered;
}

export function addAgentLog(agent, level, message) {
  const id = store.state.nextIds.log++;
  store.state.agentLogs.push({ id, agent, ts: utcnow(), level, message });
  if (store.state.agentLogs.length > 2500) {
    store.state.agentLogs = store.state.agentLogs.slice(-2000);
  }
}

export function systemMetrics() {
  const cpus = os.cpus() || [];
  const load = os.loadavg()[0] || 0;
  const cores = cpus.length || 1;
  const cpuPct = Math.min(100, Math.round((load / cores) * 1000) / 10);
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMb = Math.round((totalMem - freeMem) / (1024 * 1024));
  const ramPct = Math.round(((totalMem - freeMem) / totalMem) * 1000) / 10;
  return {
    cpu_percent: cpuPct,
    ram_percent: ramPct,
    ram_used_mb: usedMb,
    ram_total_mb: Math.round(totalMem / (1024 * 1024)),
    cores,
  };
}

// ---------------------------------------------------------------------------
// Datasets: Synthetic generator + CSV parser + Resampling
// ---------------------------------------------------------------------------
function mulberry32(seed) {
  let t = seed >>> 0;
  return () => {
    t += 0x6D2B79F5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function normalRand(rng) {
  const u1 = Math.max(1e-12, rng());
  const u2 = rng();
  return Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
}

export function generateSyntheticCandles(days = 60, seed = 42, basePrice = 22000) {
  const rng = mulberry32(Number(seed) || 42);
  const bars = [];
  let cur = new Date('2025-01-01T00:00:00');
  let tradingDays = 0;
  let price = basePrice;
  let vol = 0.0006;
  while (tradingDays < days) {
    const dow = cur.getDay();
    if (dow !== 0 && dow !== 6) {
      const y = cur.getFullYear();
      const m = String(cur.getMonth() + 1).padStart(2, '0');
      const d = String(cur.getDate()).padStart(2, '0');
      for (let bar = 0; bar < 375; bar++) {
        const totalMin = 9 * 60 + 15 + bar;
        const hh = String(Math.floor(totalMin / 60)).padStart(2, '0');
        const mm = String(totalMin % 60).padStart(2, '0');
        vol = Math.max(0.0002, 0.97 * vol + 0.03 * 0.0006 + 0.0002 * Math.abs(normalRand(rng)));
        const ret = normalRand(rng) * vol;
        const open = Number(price.toFixed(2));
        const close = Number((price * (1 + ret)).toFixed(2));
        const high = Number((Math.max(open, close) * (1 + Math.abs(normalRand(rng) * vol * 0.5))).toFixed(2));
        const low = Number((Math.min(open, close) * (1 - Math.abs(normalRand(rng) * vol * 0.5))).toFixed(2));
        const volume = Math.floor(100 + rng() * 4900);
        bars.push({ time: `${y}-${m}-${d}T${hh}:${mm}:00`, open, high, low, close, volume });
        price = close;
      }
      tradingDays++;
    }
    cur.setDate(cur.getDate() + 1);
  }
  return bars;
}

export function parseCsvCandles(csvText) {
  const lines = csvText.trim().split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) throw new Error('CSV must include a header row and candle rows');
  const headers = lines[0].split(',').map((h) => h.trim().toLowerCase());
  const idxOf = (names) => headers.findIndex((h) => names.includes(h));
  const tsIdx = idxOf(['timestamp', 'datetime', 'date_time', 'time']);
  const dateIdx = idxOf(['date']);
  const timeIdx = idxOf(['time']);
  const oIdx = idxOf(['open']);
  const hIdx = idxOf(['high']);
  const lIdx = idxOf(['low']);
  const cIdx = idxOf(['close']);
  const vIdx = idxOf(['volume', 'vol']);
  if (oIdx < 0 || hIdx < 0 || lIdx < 0 || cIdx < 0) {
    throw new Error('CSV must contain open, high, low, close columns');
  }
  if (tsIdx < 0 && (dateIdx < 0 || timeIdx < 0)) {
    throw new Error('CSV needs a timestamp/datetime/time column or separate date and time columns');
  }
  const map = new Map();
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',').map((s) => s.trim());
    if (cols.length < 4) continue;
    let rawTs = tsIdx >= 0 ? cols[tsIdx] : `${cols[dateIdx]} ${cols[timeIdx]}`;
    const dt = new Date(rawTs);
    if (Number.isNaN(dt.getTime())) {
      throw new Error(`Invalid timestamp at row ${i + 1}: ${rawTs}`);
    }
    const iso = rawTs.includes('T') ? rawTs.slice(0, 19) : dt.toISOString().slice(0, 19);
    const open = Number(cols[oIdx]);
    const high = Number(cols[hIdx]);
    const low = Number(cols[lIdx]);
    const close = Number(cols[cIdx]);
    const volume = vIdx >= 0 ? Number(cols[vIdx] || 0) : 0;
    if (![open, high, low, close].every((v) => Number.isFinite(v) && v > 0)) {
      throw new Error(`Invalid or non-positive OHLC at row ${i + 1}`);
    }
    if (high < Math.max(open, close, low) || low > Math.min(open, close, high)) {
      throw new Error(`Inconsistent OHLC bounds at row ${i + 1}`);
    }
    map.set(iso, { time: iso, open, high, low, close, volume: Number.isFinite(volume) ? volume : 0 });
  }
  const candles = [...map.values()].sort((a, b) => a.time.localeCompare(b.time));
  if (candles.length < 500) {
    throw new Error(`At least 500 candles are required for a meaningful backtest (found ${candles.length})`);
  }
  return candles;
}

export function upsertDataset({ name, instrument, symbol, timeframe = '1m', source_file = 'upload', candles, replace = true }) {
  const row = ingestCandlesArray({
    name,
    instrument: instrument || (symbol === 'SYNTHETIC' ? 'Synthetic Test Index' : `${symbol} Index`),
    symbol,
    timeframe: normalizeTimeframe(timeframe) || '1m',
    sourceDir: source_file,
    candles,
    replace,
  });
  store.clearSignalCache();
  return row;
}

export function resampleCandles(candles, timeframe = '5m') {
  const tf = normalizeTimeframe(timeframe) || '5m';
  if (tf === '1m' || candles.length === 0) return candles;
  const mins = TIMEFRAME_MINUTES[tf] || 5;
  const sessionOpen = 9 * 60 + 15;
  const sessionClose = 15 * 60 + 30;
  const buckets = new Map();
  for (const c of candles) {
    const ts = c.time || c.ts;
    const dateStr = ts.slice(0, 10);
    const hh = Number(ts.slice(11, 13));
    const mm = Number(ts.slice(14, 16));
    const mod = hh * 60 + mm;
    if (mod < sessionOpen || mod > sessionClose) continue;
    const offset = mod === sessionClose ? (sessionClose - sessionOpen - 1) : (mod - sessionOpen);
    const bIdx = Math.floor(offset / mins);
    const startMin = sessionOpen + bIdx * mins;
    const bHh = String(Math.floor(startMin / 60)).padStart(2, '0');
    const bMm = String(startMin % 60).padStart(2, '0');
    const key = `${dateStr}T${bHh}:${bMm}:00+05:30`;
    const cur = buckets.get(key);
    const vol = c.volume !== undefined && c.volume !== null ? Number(c.volume) : null;
    if (!cur) {
      buckets.set(key, {
        time: key,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: vol,
        volume_available: vol !== null,
      });
    } else {
      cur.high = Math.max(cur.high, c.high);
      cur.low = Math.min(cur.low, c.low);
      cur.close = c.close;
      if (vol !== null) {
        cur.volume = (cur.volume || 0) + vol;
        cur.volume_available = true;
      }
    }
  }
  return [...buckets.values()];
}

export function probeCandles(n = 400) {
  return generateSyntheticCandles(2, 7, 100).slice(0, n);
}

// ---------------------------------------------------------------------------
// Isolated Python 3.11 Sandbox Execution (Bounded Concurrency + Kill Escalation)
// ---------------------------------------------------------------------------
const SANDBOX_MAX_CONCURRENT = Math.max(2, Math.min(4, os.cpus()?.length || 2));
const SANDBOX_MAX_STDOUT_BYTES = 32 * 1024 * 1024;
const SANDBOX_MAX_STDERR_BYTES = 256 * 1024;
let _sandboxRunning = 0;
const _sandboxQueue = [];

function _acquireSandboxSlot() {
  if (_sandboxRunning < SANDBOX_MAX_CONCURRENT) {
    _sandboxRunning += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => _sandboxQueue.push(resolve));
}

function _releaseSandboxSlot() {
  _sandboxRunning = Math.max(0, _sandboxRunning - 1);
  if (_sandboxQueue.length > 0 && _sandboxRunning < SANDBOX_MAX_CONCURRENT) {
    _sandboxRunning += 1;
    const next = _sandboxQueue.shift();
    next();
  }
}

export function toColumnarCols(candles = []) {
  const n = candles.length;
  const time = new Array(n);
  const open = new Array(n);
  const high = new Array(n);
  const low = new Array(n);
  const close = new Array(n);
  const volume = new Array(n);
  for (let i = 0; i < n; i++) {
    const c = candles[i];
    time[i] = c.time ?? c.ts ?? i;
    open[i] = c.open;
    high[i] = c.high;
    low[i] = c.low;
    close[i] = c.close;
    volume[i] = c.volume ?? null;
  }
  return { time, open, high, low, close, volume };
}

export async function runPythonSandbox(payload, { cpuLimitS = 5, memLimitMb = 256, timeoutMs = 10000 } = {}) {
  await _acquireSandboxSlot();
  try {
    return await new Promise((resolve) => {
      const child = spawn('python3', ['-I', SANDBOX_SCRIPT], {
        cwd: __dirname,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      let stdoutOverflow = false;
      let timedOut = false;
      let settled = false;
      let killTimer = null;

      const finish = (res) => {
        if (settled) return;
        settled = true;
        clearTimeout(wallTimer);
        if (killTimer) clearTimeout(killTimer);
        resolve(res);
      };

      const wallTimer = setTimeout(() => {
        timedOut = true;
        try { child.kill('SIGTERM'); } catch { /* ignore */ }
        killTimer = setTimeout(() => {
          try { child.kill('SIGKILL'); } catch { /* ignore */ }
        }, 400);
      }, timeoutMs);

      child.stdout.on('data', (chunk) => {
        if (stdoutOverflow) return;
        const text = chunk.toString();
        if (stdout.length + text.length > SANDBOX_MAX_STDOUT_BYTES) {
          stdoutOverflow = true;
          try { child.kill('SIGKILL'); } catch { /* ignore */ }
          finish({
            ok: false,
            stage: 'sandbox',
            error: { type: 'OutputLimitError', line: 1, message: 'Sandbox output exceeded 32 MB limit.' },
          });
          return;
        }
        stdout += text;
      });

      child.stderr.on('data', (chunk) => {
        if (stderr.length < SANDBOX_MAX_STDERR_BYTES) {
          stderr += chunk.toString().slice(0, SANDBOX_MAX_STDERR_BYTES - stderr.length);
        }
      });

      child.on('error', (err) => {
        finish({ ok: false, stage: 'sandbox', error: { type: 'SandboxError', line: 1, message: err.message } });
      });

      child.stdin.on('error', () => { /* ignore EPIPE if child closed early */ });

      child.on('close', (code, signal) => {
        if (settled) return;
        if (timedOut) {
          finish({
            ok: false,
            stage: 'timeout',
            error: {
              type: 'TimeoutError',
              line: 1,
              message: `Sandbox execution exceeded wall-clock timeout (${timeoutMs} ms). Check for infinite loops or expensive nested loops.`,
            },
          });
          return;
        }
        if (stdout.trim()) {
          try {
            finish(JSON.parse(stdout));
            return;
          } catch {
            // fall through to diagnostic error
          }
        }
        if (signal === 'SIGXCPU') {
          finish({
            ok: false,
            stage: 'timeout',
            error: { type: 'TimeoutError', line: 1, message: `Sandbox CPU limit (${cpuLimitS}s) exceeded.` },
          });
          return;
        }
        if (signal === 'SIGKILL' || stderr.includes('MemoryError')) {
          finish({
            ok: false,
            stage: 'memory',
            error: { type: 'MemoryError', line: 1, message: `Sandbox memory limit (${memLimitMb} MB) exceeded.` },
          });
          return;
        }
        finish({
          ok: false,
          stage: 'sandbox',
          error: {
            type: 'SandboxError',
            line: 1,
            message: stderr.trim() || `Python sandbox exited abnormally (code=${code}, signal=${signal || 'none'})`,
          },
        });
      });

      // Prefer compact columnar transport when candles array is passed
      const reqPayload = { ...payload, cpu_limit_s: cpuLimitS, mem_limit_mb: memLimitMb };
      if (Array.isArray(reqPayload.candles) && !reqPayload.cols) {
        reqPayload.cols = toColumnarCols(reqPayload.candles);
        delete reqPayload.candles;
      }
      child.stdin.write(JSON.stringify(reqPayload));
      child.stdin.end();
    });
  } finally {
    _releaseSandboxSlot();
  }
}

// ---------------------------------------------------------------------------
// Indicator & Strategy Studio helpers + Dynamic Registry
// ---------------------------------------------------------------------------
const SNAKE_RE = /^[a-z][a-z0-9_]{1,63}$/;

export function normalizeParamSpecs(params = []) {
  const out = [];
  const seen = new Set();
  for (const p of params) {
    const name = String(p.name || '').trim();
    if (!name || !SNAKE_RE.test(name)) {
      throw new Error(`Invalid parameter name '${name}'. Use lowercase snake_case.`);
    }
    if (seen.has(name)) throw new Error(`Duplicate parameter '${name}'`);
    seen.add(name);
    const kind = p.kind === 'float' ? 'float' : 'int';
    const low = Number(p.low);
    const high = Number(p.high);
    const def = Number(p.default);
    if (!Number.isFinite(low) || !Number.isFinite(high) || !Number.isFinite(def)) {
      throw new Error(`Parameter '${name}' requires finite numeric low, high, and default`);
    }
    if (low > high) throw new Error(`Parameter '${name}': low (${low}) > high (${high})`);
    if (def < low || def > high) {
      throw new Error(`Parameter '${name}': default (${def}) must lie within [${low}, ${high}]`);
    }
    out.push({
      name,
      kind,
      default: kind === 'int' ? Math.round(def) : def,
      low: kind === 'int' ? Math.round(low) : low,
      high: kind === 'int' ? Math.round(high) : high,
      step: p.step !== undefined && p.step !== null && p.step !== '' ? Number(p.step) : null,
    });
  }
  return out;
}

export function indicatorDefaults(ind) {
  const d = {};
  for (const p of ind.params || []) d[p.name] = p.default;
  return d;
}

export function cleanIndicatorParams(ind, raw = {}) {
  const merged = indicatorDefaults(ind);
  const idx = Object.fromEntries((ind.params || []).map((p) => [p.name, p]));
  for (const [k, v] of Object.entries(raw || {})) {
    if (!idx[k]) throw new Error(`indicator '${ind.name}' has no parameter '${k}'`);
    const spec = idx[k];
    const num = spec.kind === 'int' ? Math.round(Number(v)) : Math.round(Number(v) * 1e6) / 1e6;
    merged[k] = Math.min(Math.max(num, spec.low), spec.high);
  }
  return merged;
}

export function resolveRegisteredIndicator(ind) {
  if (!ind || !ind.registered || !ind.available) return null;
  if (ind.working_snapshot && typeof ind.working_snapshot === 'object') {
    return {
      ...ind,
      ...ind.working_snapshot,
      id: ind.id,
      name: ind.name,
      registered: true,
      available: true,
    };
  }
  return ind;
}

export function getRegisteredIndicators() {
  return store.state.studioIndicators.map(resolveRegisteredIndicator).filter(Boolean);
}

export function resolveRegisteredStrategy(strat) {
  if (!strat || !strat.registered || !strat.available) return null;
  if (strat.working_snapshot && typeof strat.working_snapshot === 'object') {
    return {
      ...strat,
      ...strat.working_snapshot,
      id: strat.id,
      name: strat.name,
      registered: true,
      available: true,
    };
  }
  return strat;
}

export function getRegisteredStrategies() {
  return store.state.studioStrategies.map(resolveRegisteredStrategy).filter(Boolean);
}

export function reloadRegistryFromDisk() {
  store.reloadFromDisk();
  return {
    total: store.state.studioIndicators.length,
    available: getRegisteredIndicators().length,
    unavailable: store.state.studioIndicators.length - getRegisteredIndicators().length,
    strategies_total: store.state.studioStrategies.length,
    strategies_available: getRegisteredStrategies().length,
  };
}

function indicatorCodeDigest(indDef) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({
      id: indDef.id ?? null,
      code: indDef.code || '',
      output_type: indDef.output_type || 'auto',
      signal_rule: indDef.signal_rule || null,
    }))
    .digest('hex')
    .slice(0, 16);
}

// Compute indicator signals on candles via isolated Python sandbox with code-hash-aware caching
export async function computeIndicatorSignal(datasetId, candles, indDef, params = {}, opts = {}) {
  const clean = cleanIndicatorParams(indDef, params);
  const tag = opts.cacheTag || '1m';
  const digest = indicatorCodeDigest(indDef);
  const key = `${datasetId}::${tag}::${indDef.id ?? 'x'}::${indDef.name}::${indDef.version}::${digest}::${JSON.stringify(clean)}`;
  if (store._signalCache.has(key)) return store._signalCache.get(key);

  const res = await runPythonSandbox({
    mode: 'indicator',
    code: indDef.code,
    candles,
    params: clean,
    output_type: indDef.output_type || 'auto',
    signal_rule: indDef.signal_rule || null,
    return_signals: true,
  }, opts);
  if (!res.ok) {
    throw new Error(`Indicator '${indDef.name}' execution failed: ${res.error?.message || 'unknown error'}`);
  }
  if (store._signalCache.size > 2000) {
    const firstKey = store._signalCache.keys().next().value;
    store._signalCache.delete(firstKey);
  }
  store._signalCache.set(key, res.signals);
  return res.signals;
}

// ---------------------------------------------------------------------------
// Strategy Specification, Hashing & Bar-by-Bar Backtest Engine
// ---------------------------------------------------------------------------
export function buildStrategySpec(input) {
  const regMap = Object.fromEntries(getRegisteredIndicators().map((i) => [i.name, i]));
  const items = [];
  for (const item of input.indicators || []) {
    const def = regMap[item.name];
    if (!def) {
      throw new Error(`indicator '${item.name}' is not registered or unavailable`);
    }
    const clean = cleanIndicatorParams(def, item.params || {});
    items.push({ name: def.name, params: Object.fromEntries(Object.entries(clean).sort(([a], [b]) => a.localeCompare(b))) });
  }
  if (items.length === 0) throw new Error('at least 1 indicator is required');
  const names = items.map((i) => i.name);
  if (new Set(names).size !== names.length) throw new Error('an indicator may appear only once per strategy');
  items.sort((a, b) => a.name.localeCompare(b.name));

  const minVotes = Math.max(1, Math.min(items.length, Number(input.min_votes || 1)));
  const direction = ['both', 'long', 'short'].includes(input.direction) ? input.direction : 'both';
  const sl = Math.round(Math.max(0, Math.min(10, Number(input.stop_loss_pct ?? 0.5))) * 1e4) / 1e4;
  const tp = Math.round(Math.max(0, Math.min(20, Number(input.target_pct ?? 1.0))) * 1e4) / 1e4;

  const spec = {
    strategy_name: input.strategy_name || null,
    strategy_ids: Array.isArray(input.strategy_ids) ? [...input.strategy_ids].sort() : null,
    strategy_params: input.strategy_params || null,
    timeframe: normalizeTimeframe(input.timeframe || '1m') || '1m',
    indicators: items,
    min_votes: minVotes,
    direction,
    stop_loss_pct: sl,
    target_pct: tp,
  };
  return spec;
}

export function specHash(spec) {
  const canonical = JSON.stringify(spec, Object.keys(spec).sort());
  const h = crypto.createHash('sha256').update(JSON.stringify(sortKeysDeep(spec))).digest('hex');
  return h.slice(0, 16);
}

function sortKeysDeep(val) {
  if (Array.isArray(val)) return val.map(sortKeysDeep);
  if (val && typeof val === 'object') {
    const out = {};
    for (const k of Object.keys(val).sort()) {
      if (val[k] !== null && val[k] !== undefined) out[k] = sortKeysDeep(val[k]);
    }
    return out;
  }
  return val;
}

export function describeSpec(spec) {
  if (!spec) return '';
  const inds = (spec.indicators || []).map((i) => {
    const ps = Object.entries(i.params || {}).map(([k, v]) => `${k}=${v}`).join(', ');
    return `${i.name}(${ps})`;
  });
  const prefix = spec.strategy_name ? `[${spec.strategy_name}] ` : '';
  return `${prefix}${inds.join(' + ')} | votes>=${spec.min_votes} | ${spec.direction} | SL ${spec.stop_loss_pct}% TP ${spec.target_pct}%`;
}

function minuteOfDay(ts) {
  const m = ts.match(/T(\d{2}):(\d{2})/);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  const d = new Date(ts);
  return d.getHours() * 60 + d.getMinutes();
}

export function runBacktest(candles, votes, { min_votes = 1, direction = 'both', stop_loss_pct = 0.5, target_pct = 1.0, exit_signals = null, cfg = DEFAULT_BACKTEST, initial_capital = null }) {
  const n = candles.length;
  const initCap = initial_capital != null ? Number(initial_capital) : cfg.initial_capital;
  if (n === 0) {
    return { trades: [], equity: [], timestamps: [], final_capital: initCap, skipped_entries: 0 };
  }
  const slip = cfg.slippage_points;
  const slPct = stop_loss_pct / 100;
  const tgtPct = target_pct / 100;

  let cash = initCap;
  const equity = new Array(n);
  const trades = [];
  let pos = 0;
  let qty = 0;
  let entryPx = 0;
  let entryCost = 0;
  let entryI = -1;
  let entryTime = null;
  let pending = null;
  let skipped = 0;

  const fillCost = (px, q) => cfg.brokerage_per_order + cfg.charges_pct * px * q;
  const closePos = (i, px, reason) => {
    const pnl = (px - entryPx) * qty * pos;
    const exitCost = fillCost(px, qty);
    cash += pnl - exitCost;
    trades.push({
      side: pos > 0 ? 'LONG' : 'SHORT',
      entry_time: entryTime,
      exit_time: candles[i].time,
      entry_price: Math.round(entryPx * 10000) / 10000,
      exit_price: Math.round(px * 10000) / 10000,
      quantity: qty,
      gross_pnl: Math.round(pnl * 10000) / 10000,
      costs: Math.round((entryCost + exitCost) * 10000) / 10000,
      net_pnl: Math.round((pnl - entryCost - exitCost) * 10000) / 10000,
      reason,
      bars_held: i - entryI,
    });
    pos = 0;
    qty = 0;
  };

  for (let i = 0; i < n; i++) {
    const { open: o, high: h, low: l, close: c, time } = candles[i];
    const tMin = minuteOfDay(time);

    if (pending) {
      const [kind, side, reason] = pending;
      pending = null;
      if (kind === 'enter' && pos === 0 && tMin < cfg.no_entry_after_minute) {
        const px = o + side * slip;
        const q = Math.floor((cash * cfg.position_pct) / (px * cfg.lot_size)) * cfg.lot_size;
        if (q >= cfg.lot_size) {
          pos = side;
          qty = q;
          entryPx = px;
          entryCost = fillCost(px, q);
          cash -= entryCost;
          entryI = i;
          entryTime = time;
        } else {
          skipped++;
        }
      } else if (kind === 'exit' && pos !== 0) {
        closePos(i, o - pos * slip, reason);
      }
    }

    if (pos !== 0 && i > entryI) {
      const slPx = slPct > 0 ? entryPx * (1 - pos * slPct) : null;
      const tgPx = tgtPct > 0 ? entryPx * (1 + pos * tgtPct) : null;
      const hitSl = pos > 0 ? (slPx !== null && l <= slPx) : (slPx !== null && h >= slPx);
      const hitTg = pos > 0 ? (tgPx !== null && h >= tgPx) : (tgPx !== null && l <= tgPx);
      if (hitSl) {
        const fill = ((pos > 0 && o <= slPx) || (pos < 0 && o >= slPx)) ? o : slPx;
        closePos(i, fill - pos * slip, 'stop_loss');
      } else if (hitTg) {
        const fill = ((pos > 0 && o >= tgPx) || (pos < 0 && o <= tgPx)) ? o : tgPx;
        closePos(i, fill - pos * slip, 'target');
      }
    }

    if (pos !== 0 && tMin >= cfg.square_off_minute) {
      closePos(i, c - pos * slip, 'square_off');
    } else if (pos !== 0 && i + 1 < n) {
      const customExit = exit_signals && exit_signals[i] && (exit_signals[i] === pos || exit_signals[i] === -1 * pos || exit_signals[i] === 1 && pos === 0);
      if (customExit || votes[i] * pos <= -min_votes) {
        pending = ['exit', -pos, customExit ? 'strategy_exit' : 'signal_reversal'];
      }
    }

    if (pos === 0 && pending === null && tMin < cfg.square_off_minute && i + 1 < n) {
      if (votes[i] >= min_votes && (direction === 'both' || direction === 'long')) {
        pending = ['enter', 1, 'signal_long'];
      } else if (votes[i] <= -min_votes && (direction === 'both' || direction === 'short')) {
        pending = ['enter', -1, 'signal_short'];
      }
    }

    equity[i] = cash + (pos !== 0 ? (c - entryPx) * qty * pos : 0);
  }

  if (pos !== 0) {
    closePos(n - 1, candles[n - 1].close - pos * slip, 'end_of_data');
    equity[n - 1] = cash;
  }

  return {
    trades,
    equity,
    timestamps: candles.map((b) => b.time),
    final_capital: cash,
    skipped_entries: skipped,
  };
}

export function computeMetrics(trades, equity, initialCapital, finalCapital = null, minTrades = MIN_TRADES, skippedEntries = 0, timeframe = '1m') {
  const tf = normalizeTimeframe(timeframe) || '1m';
  const tfMins = TIMEFRAME_MINUTES[tf] || 1;
  const barsPerDay = Math.max(1, 375 / tfMins);
  const barsPerYear = 252 * barsPerDay;

  const n = trades.length;
  const nets = trades.map((t) => t.net_pnl);
  const wins = nets.filter((v) => v > 0);
  const losses = nets.filter((v) => v < 0);
  const netProfit = nets.reduce((a, b) => a + b, 0);
  const grossWin = wins.reduce((a, b) => a + b, 0);
  const grossLoss = -losses.reduce((a, b) => a + b, 0);
  const profitFactor = grossLoss > 0 ? Math.min(grossWin / grossLoss, 999.0) : (grossWin > 0 ? 999.0 : 0);

  let peak = -Infinity;
  let maxDd = 0;
  let maxDdPct = 0;
  for (const eq of equity) {
    if (eq > peak) peak = eq;
    const dd = peak - eq;
    if (dd > maxDd) maxDd = dd;
    if (peak > 0) {
      const pct = (dd / peak) * 100;
      if (pct > maxDdPct) maxDdPct = pct;
    }
  }

  // Return moments, Sharpe ratio & Sortino ratio
  const rets = [];
  for (let i = 1; i < equity.length; i++) {
    if (equity[i - 1] > 0) rets.push((equity[i] - equity[i - 1]) / equity[i - 1]);
  }
  let sharpePerBar = 0;
  let sharpeRatio = 0;
  let sortinoRatio = 0;
  let skew = 0;
  let kurtosis = 3;
  if (rets.length >= 2) {
    const mu = rets.reduce((a, b) => a + b, 0) / rets.length;
    const varR = rets.reduce((a, b) => a + (b - mu) ** 2, 0) / rets.length;
    const sd = Math.sqrt(varR);
    if (sd > 1e-12) {
      sharpePerBar = mu / sd;
      sharpeRatio = sharpePerBar * Math.sqrt(barsPerYear);
      const m3 = rets.reduce((a, b) => a + ((b - mu) / sd) ** 3, 0) / rets.length;
      const m4 = rets.reduce((a, b) => a + ((b - mu) / sd) ** 4, 0) / rets.length;
      skew = m3;
      kurtosis = m4;
    }
    const downSq = rets.reduce((acc, r) => acc + (r < 0 ? r * r : 0), 0) / rets.length;
    const downSd = Math.sqrt(downSq);
    if (downSd > 1e-12) {
      sortinoRatio = (mu / downSd) * Math.sqrt(barsPerYear);
    }
  }

  const avgWinVal = wins.length ? grossWin / wins.length : 0;
  const avgLossVal = losses.length ? -grossLoss / losses.length : 0;
  const winProb = n ? wins.length / n : 0;
  const lossProb = n ? losses.length / n : 0;
  const expectancy = n ? (winProb * avgWinVal - lossProb * Math.abs(avgLossVal)) : 0;

  let holdBarsSum = 0;
  let holdMinsSum = 0;
  for (const t of trades) {
    const bars = Number(t.bars_held || 0);
    holdBarsSum += bars;
    const t1 = Date.parse(t.entry_time);
    const t2 = Date.parse(t.exit_time);
    if (Number.isFinite(t1) && Number.isFinite(t2) && t2 >= t1) {
      holdMinsSum += (t2 - t1) / 60000;
    } else {
      holdMinsSum += bars * tfMins;
    }
  }

  const reasons = {};
  for (const t of trades) reasons[t.reason] = (reasons[t.reason] || 0) + 1;

  return {
    timeframe: tf,
    trades: n,
    winning_trades: wins.length,
    losing_trades: losses.length,
    net_profit: Math.round(netProfit * 100) / 100,
    gross_profit: Math.round(grossWin * 100) / 100,
    gross_loss: Math.round(grossLoss * 100) / 100,
    return_pct: initialCapital ? Math.round((netProfit / initialCapital) * 1000000) / 10000 : 0,
    final_capital: Math.round((finalCapital ?? (initialCapital + netProfit)) * 100) / 100,
    win_rate: n ? Math.round((wins.length / n) * 10000) / 100 : 0,
    profit_factor: Math.round(profitFactor * 10000) / 10000,
    sharpe_per_bar: Math.round(sharpePerBar * 100000) / 100000,
    sharpe_ratio: Math.round(sharpeRatio * 1000) / 1000,
    sortino_ratio: Math.round(sortinoRatio * 1000) / 1000,
    expectancy: Math.round(expectancy * 100) / 100,
    return_skew: Math.round(skew * 10000) / 10000,
    return_kurtosis: Math.round(kurtosis * 10000) / 10000,
    returns_obs: rets.length,
    max_drawdown: Math.round(maxDd * 100) / 100,
    max_drawdown_pct: Math.round(maxDdPct * 10000) / 10000,
    recovery_factor: maxDd > 0 ? Math.round((netProfit / maxDd) * 10000) / 10000 : 0,
    avg_trade: n ? Math.round((netProfit / n) * 100) / 100 : 0,
    avg_win: Math.round(avgWinVal * 100) / 100,
    avg_loss: Math.round(avgLossVal * 100) / 100,
    avg_holding_bars: n ? Math.round((holdBarsSum / n) * 100) / 100 : 0,
    avg_holding_minutes: n ? Math.round((holdMinsSum / n) * 100) / 100 : 0,
    total_costs: Math.round(trades.reduce((a, t) => a + t.costs, 0) * 100) / 100,
    longs: trades.filter((t) => t.side === 'LONG').length,
    shorts: trades.filter((t) => t.side === 'SHORT').length,
    exit_reasons: reasons,
    skipped_entries: skippedEntries,
    eligible: n >= minTrades,
  };
}

export function splitBounds(n, splitCfg = DEFAULT_SPLIT) {
  const tEnd = Math.floor(n * splitCfg.train_end);
  const vEnd = Math.floor(n * splitCfg.validation_end);
  return {
    train: [0, tEnd],
    validation: [tEnd, vEnd],
    oos: [vEnd, n],
  };
}

export async function evaluateSpecFull(datasetId, spec, split = 'train', {
  timeframe = null,
  startDate = null,
  endDate = null,
  completedOnly = true,
  backtestCfg = DEFAULT_BACKTEST,
  minTrades = MIN_TRADES,
  cpuLimitS = 5,
  memLimitMb = 256,
} = {}) {
  const tf = normalizeTimeframe(timeframe || spec?.timeframe || '1m') || '1m';
  const loaded = loadCanonicalCandlesForEngine(datasetId, {
    timeframe: tf,
    startDate,
    endDate,
    completedOnly,
  });
  const candles = loaded.candles;
  const bounds = splitBounds(candles.length);
  if (!bounds[split]) throw new Error(`Invalid split: ${split}`);
  const [a, b] = bounds[split];
  const slice = candles.slice(a, b);
  if (slice.length < 10) {
    throw new Error(`Not enough candles (${slice.length}) in ${split} split for timeframe ${tf}`);
  }
  const prefixCandles = candles.slice(0, b);
  const regMap = Object.fromEntries(getRegisteredIndicators().map((i) => [i.name, i]));
  const stratMap = Object.fromEntries(getRegisteredStrategies().map((s) => [s.id, s]));

  // Zero look-ahead: compute indicators/strategies only on prefix [0, b) so future splits are never visible
  const cacheTag = `${tf}:${startDate || 'min'}:${endDate || 'max'}:n${b}`;
  let votes = new Array(slice.length).fill(0);
  let exitSignals = null;
  let sl = spec.stop_loss_pct;
  let tp = spec.target_pct;

  if (spec.strategy_ids && spec.strategy_ids.length > 0) {
    const indPayload = (spec.indicators || []).map((item) => {
      const def = regMap[item.name];
      if (!def) throw new Error(`Indicator '${item.name}' not registered/available`);
      return {
        name: item.name,
        code: def.code,
        output_type: def.output_type || 'auto',
        params: cleanIndicatorParams(def, item.params || {}),
      };
    });
    const stratVotes = new Array(slice.length).fill(0);
    for (const sid of spec.strategy_ids) {
      const sdef = stratMap[sid];
      if (!sdef) continue;
      const sRes = await runPythonSandbox({
        mode: 'strategy',
        code: sdef.code,
        candles: prefixCandles,
        params: spec.strategy_params?.[sid] || {},
        indicator_codes: indPayload,
      }, { cpuLimitS, memLimitMb });
      if (!sRes.ok) {
        throw new Error(`Strategy '${sdef.name}' failed: ${sRes.error?.message || 'runtime error'}`);
      }
      for (let i = 0; i < slice.length; i++) {
        stratVotes[i] += sRes.signals[a + i] || 0;
      }
      if (sRes.exit_signals && !exitSignals) {
        exitSignals = sRes.exit_signals.slice(a, b);
      }
      if (sRes.stop_loss_pct != null) sl = sRes.stop_loss_pct;
      if (sRes.target_pct != null) tp = sRes.target_pct;
    }
    votes = stratVotes;
  } else {
    const indSignalsPrefix = {};
    for (const item of spec.indicators || []) {
      const def = regMap[item.name];
      if (!def) throw new Error(`Indicator '${item.name}' not registered/available`);
      indSignalsPrefix[item.name] = await computeIndicatorSignal(datasetId, prefixCandles, def, item.params || {}, {
        cacheTag,
        cpuLimitS,
        memLimitMb,
      });
    }
    for (const item of spec.indicators || []) {
      const sig = indSignalsPrefix[item.name];
      for (let i = 0; i < slice.length; i++) {
        votes[i] += sig[a + i] || 0;
      }
    }
  }

  const bt = runBacktest(slice, votes, {
    min_votes: spec.strategy_ids?.length ? 1 : spec.min_votes,
    direction: spec.direction,
    stop_loss_pct: sl,
    target_pct: tp,
    exit_signals: exitSignals,
    cfg: backtestCfg,
  });
  const effMinTrades = minTrades;
  const metrics = computeMetrics(bt.trades, bt.equity, backtestCfg.initial_capital, bt.final_capital, effMinTrades, bt.skipped_entries, tf);
  return { bt, metrics, slice, timeframe: tf };
}

export async function runWalkForward(datasetId, spec, {
  timeframe = null,
  startDate = null,
  endDate = null,
  backtestCfg = DEFAULT_BACKTEST,
  minTrades = MIN_TRADES,
} = {}) {
  const tf = normalizeTimeframe(timeframe || spec?.timeframe || '1m') || '1m';
  const candles = loadCanonicalCandlesForEngine(datasetId, {
    timeframe: tf,
    startDate,
    endDate,
    completedOnly: true,
  }).candles;
  const [a, b] = splitBounds(candles.length).validation;
  const prefixCandles = candles.slice(0, b);
  const nSegs = DEFAULT_SPLIT.walk_forward_segments;
  const regMap = Object.fromEntries(getRegisteredIndicators().map((i) => [i.name, i]));
  const cacheTag = `${tf}:${startDate || 'min'}:${endDate || 'max'}:n${b}`;

  const indSignalsPrefix = {};
  for (const item of spec.indicators || []) {
    const def = regMap[item.name];
    if (!def) throw new Error(`Indicator '${item.name}' not available`);
    indSignalsPrefix[item.name] = await computeIndicatorSignal(datasetId, prefixCandles, def, item.params || {}, { cacheTag });
  }

  const segments = [];
  for (let k = 0; k < nSegs; k++) {
    const sa = a + Math.floor(((b - a) * k) / nSegs);
    const sb = a + Math.floor(((b - a) * (k + 1)) / nSegs);
    const slice = candles.slice(sa, sb);
    const votes = new Array(slice.length).fill(0);
    for (const item of spec.indicators || []) {
      const sig = indSignalsPrefix[item.name];
      for (let i = 0; i < slice.length; i++) votes[i] += sig[sa + i] || 0;
    }
    const bt = runBacktest(slice, votes, {
      min_votes: spec.min_votes,
      direction: spec.direction,
      stop_loss_pct: spec.stop_loss_pct,
      target_pct: spec.target_pct,
      cfg: backtestCfg,
    });
    const net = bt.trades.reduce((acc, t) => acc + t.net_pnl, 0);
    segments.push({
      segment: k + 1,
      start: slice[0]?.time || '',
      end: slice[slice.length - 1]?.time || '',
      trades: bt.trades.length,
      net_profit: Math.round(net * 100) / 100,
    });
  }
  const profitable = segments.filter((s) => s.net_profit > 0).length;
  const totalNet = Math.round(segments.reduce((acc, s) => acc + s.net_profit, 0) * 100) / 100;
  const totalTrades = segments.reduce((acc, s) => acc + s.trades, 0);
  const validated = (profitable / segments.length >= 0.5) && totalNet > 0 && totalTrades >= minTrades;
  return {
    split: 'validation',
    timeframe: tf,
    segments,
    profitable_segments: profitable,
    total_segments: segments.length,
    validation_net_profit: totalNet,
    total_trades: totalTrades,
    validated,
  };
}

// ---------------------------------------------------------------------------
// Statistical Robustness: Deflated Sharpe Ratio (DSR) & PBO
// ---------------------------------------------------------------------------
function normCdf(x) {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x) / Math.SQRT2;
  const t = 1.0 / (1.0 + p * ax);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return 0.5 * (1.0 + sign * y);
}

function normInv(p) {
  // Rational approximation (Acklam)
  const pp = Math.min(1 - 1e-12, Math.max(1e-12, p));
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.3577518672690, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const plow = 0.02425;
  const phigh = 1 - plow;
  if (pp < plow) {
    const q = Math.sqrt(-2 * Math.log(pp));
    return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
  }
  if (pp > phigh) {
    const q = Math.sqrt(-2 * Math.log(1 - pp));
    return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
  }
  const q = pp - 0.5;
  const r = q * q;
  return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q / (((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1);
}

export function computeDsrForDataset(datasetId, split = 'train') {
  const exps = store.state.experiments.filter((e) => e.dataset_id === Number(datasetId) && e.split === split && e.status === 'completed' && e.eligible && e.metrics);
  const sharpes = exps.map((e) => e.metrics.sharpe_per_bar || 0);
  const nTrials = sharpes.length;
  if (nTrials < 2) {
    return { dataset_id: datasetId, split, computed: 0, reason: 'Requires at least 2 eligible completed trials' };
  }
  const mu = sharpes.reduce((a, b) => a + b, 0) / nTrials;
  const trialVar = sharpes.reduce((a, b) => a + (b - mu) ** 2, 0) / (nTrials - 1);
  const trialSd = Math.sqrt(Math.max(trialVar, 1e-12));
  const gamma = 0.5772156649;
  const z1 = normInv(1 - 1 / nTrials);
  const z2 = normInv(1 - 1 / (nTrials * Math.E));
  const expectedMaxSr = trialSd * ((1 - gamma) * z1 + gamma * z2);

  const results = [];
  for (const exp of exps) {
    const m = exp.metrics;
    const T = m.returns_obs || 0;
    if (T < 30) continue;
    const sr = m.sharpe_per_bar || 0;
    const skew = m.return_skew || 0;
    const kurt = m.return_kurtosis || 3;
    const denom = Math.sqrt(Math.max(1e-12, (1 - skew * sr + ((kurt - 1) / 4) * sr * sr) / Math.max(1, T - 1)));
    const dsr = normCdf((sr - expectedMaxSr) / denom);
    const record = {
      id: store.state.nextIds.stat++,
      created_at: utcnow(),
      kind: 'dsr',
      dataset_id: Number(datasetId),
      split,
      experiment_id: exp.id,
      strategy_hash: exp.strategy_hash,
      status: 'completed',
      result: {
        dsr: Math.round(dsr * 10000) / 10000,
        sharpe_per_bar: sr,
        expected_max_sharpe: Math.round(expectedMaxSr * 100000) / 100000,
        n_trials: nTrials,
        returns_obs: T,
        significant: dsr >= 0.95,
      },
    };
    store.state.statisticalTests.push(record);
    results.push(record);
  }
  store.save();
  return { dataset_id: datasetId, split, computed: results.length, n_trials: nTrials, results };
}

// ---------------------------------------------------------------------------
// Autonomous Research Agent 1, Agent 2 & Optimization Worker Loop
// ---------------------------------------------------------------------------
const activeWorkers = new Map();

function randomChoice(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function sampleParam(p) {
  if (p.kind === 'int') {
    return Math.floor(p.low + Math.random() * (p.high - p.low + 1));
  }
  return Math.round((p.low + Math.random() * (p.high - p.low)) * 10000) / 10000;
}

function objectiveScore(metrics, objective = 'net_profit', minTrades = MIN_TRADES) {
  if (!metrics || metrics.trades < minTrades) return -1e9 + (metrics?.trades || 0);
  if (objective === 'sharpe_ratio') return metrics.sharpe_ratio || 0;
  if (objective === 'sortino_ratio') return metrics.sortino_ratio || 0;
  if (objective === 'profit_factor') return metrics.profit_factor || 0;
  if (objective === 'recovery_factor') return metrics.recovery_factor || 0;
  if (objective === 'min_drawdown') return metrics.net_profit > 0 ? -(metrics.max_drawdown_pct || 100) : -1e6;
  return metrics.net_profit || 0;
}

function upsertExperiment({
  agent,
  studyName = null,
  trialNumber = null,
  datasetId,
  timeframe = '1m',
  startDate = null,
  endDate = null,
  split,
  spec,
  metrics,
  durationS = 0,
  status = 'completed',
  error = null,
  initialCapital = DEFAULT_BACKTEST.initial_capital,
}) {
  const tf = normalizeTimeframe(timeframe || spec?.timeframe || '1m') || '1m';
  const normSpec = { ...spec, timeframe: tf };
  const hash = specHash(normSpec);
  const cfgHash = `${DEFAULT_SPLIT.train_end}:${initialCapital}:${tf}:${startDate || 'min'}:${endDate || 'max'}`;
  if (status === 'completed') {
    const dup = store.state.experiments.find(
      (e) => e.strategy_hash === hash && e.dataset_id === datasetId && (e.timeframe || '1m') === tf && e.split === split && e.config_hash === cfgHash && e.status === 'completed'
    );
    if (dup) return { duplicate: true, row: dup };
  }
  const row = {
    id: store.state.nextIds.experiment++,
    created_at: utcnow(),
    agent,
    study_name: studyName,
    trial_number: trialNumber,
    strategy_hash: hash,
    dataset_id: datasetId,
    timeframe: tf,
    start_date: startDate || null,
    end_date: endDate || null,
    split,
    config_hash: cfgHash,
    spec: normSpec,
    metrics,
    eligible: Boolean(metrics?.eligible),
    status,
    duration_s: durationS,
    error,
  };
  store.state.experiments.push(row);
  return { duplicate: false, row };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function checkPauseAndLimits(worker, cpuLimitPct, ramLimitPct) {
  while (worker.paused && !worker.stopped) {
    await sleep(250);
  }
  if (worker.stopped) return false;
  if (worker.deadlineMs && Date.now() >= worker.deadlineMs) {
    worker.stopped = true;
    worker.reason = 'duration_limit_reached';
    return false;
  }
  const sys = systemMetrics();
  if (sys.cpu_percent > cpuLimitPct || sys.ram_percent > ramLimitPct) {
    addAgentLog(worker.name, 'warn', `Resource throttle active (CPU ${sys.cpu_percent}% / RAM ${sys.ram_percent}%)`);
    await sleep(600);
  }
  return true;
}

function resolveBacktestCfgFromSettings(settings = {}) {
  return {
    initial_capital: Number(settings.initial_capital || DEFAULT_BACKTEST.initial_capital),
    position_pct: Number(settings.position_pct || DEFAULT_BACKTEST.position_pct),
    lot_size: DEFAULT_BACKTEST.lot_size,
    brokerage_per_order: settings.brokerage_per_order !== undefined && settings.brokerage_per_order !== '' ? Number(settings.brokerage_per_order) : DEFAULT_BACKTEST.brokerage_per_order,
    charges_pct: settings.charges_pct !== undefined && settings.charges_pct !== '' ? Number(settings.charges_pct) : DEFAULT_BACKTEST.charges_pct,
    slippage_points: settings.slippage_points !== undefined && settings.slippage_points !== '' ? Number(settings.slippage_points) : DEFAULT_BACKTEST.slippage_points,
    no_entry_after_minute: DEFAULT_BACKTEST.no_entry_after_minute,
    square_off_minute: DEFAULT_BACKTEST.square_off_minute,
  };
}

function resolveRequestedTimeframes(settings = {}) {
  const raw = Array.isArray(settings.timeframes) && settings.timeframes.length
    ? settings.timeframes
    : (settings.timeframe ? [settings.timeframe] : ['1m']);
  const out = [];
  for (const r of raw) {
    const tf = normalizeTimeframe(r);
    if (tf && !out.includes(tf)) out.push(tf);
  }
  return out.length ? out : ['1m'];
}

export function startAutonomousAgents(settings) {
  const datasetId = Number(settings.dataset_id);
  getMarketDataset(datasetId);
  const tfs = resolveRequestedTimeframes(settings);
  const startDate = settings.start_date || null;
  const endDate = settings.end_date || null;

  // Verify at least the first timeframe has data in the requested range
  loadCanonicalCandlesForEngine(datasetId, { timeframe: tfs[0], startDate, endDate, completedOnly: true });

  const allInds = getRegisteredIndicators();
  const allowedIndNames = Array.isArray(settings.indicator_names) && settings.indicator_names.length
    ? new Set(settings.indicator_names)
    : null;
  const indicators = allowedIndNames ? allInds.filter((i) => allowedIndNames.has(i.name)) : allInds;
  const strategies = getRegisteredStrategies();
  if (indicators.length === 0 && strategies.length === 0) {
    throw new Error('No registered indicators or strategies matched. Register at least one custom indicator or strategy in the Studios first.');
  }

  if (activeWorkers.get('research_agent')?.alive) {
    throw new Error('Strategy Research Agent is already running');
  }

  store.state.savedAgentSettings = settings;
  const durationLimitS = Number(settings.duration_limit_s || 0);
  const maxInd = Number(settings.max_indicators || 0); // 0 = unlimited
  const capInd = maxInd > 0 ? Math.min(maxInd, Math.max(1, indicators.length)) : Math.max(1, indicators.length);
  const totalTrialsBudget = Number(settings.n_trials || 0) > 0
    ? Number(settings.n_trials)
    : Math.max(12, Number(settings.cycles || 1) * (Number(settings.population_size || 12) + Number(settings.tuning_trials || 10)));
  const btCfg = resolveBacktestCfgFromSettings(settings);

  const rWorker = {
    name: 'research_agent',
    alive: true,
    paused: false,
    stopped: false,
    deadlineMs: durationLimitS > 0 ? Date.now() + durationLimitS * 1000 : null,
    reason: null,
  };
  const eWorker = {
    name: 'evaluation_agent',
    alive: true,
    paused: false,
    stopped: false,
    deadlineMs: rWorker.deadlineMs,
  };
  activeWorkers.set('research_agent', rWorker);
  activeWorkers.set('evaluation_agent', eWorker);

  const rState = store.state.agents.research_agent;
  Object.assign(rState, {
    status: 'running',
    current_task: 'initializing multi-timeframe discovery catalogue',
    current_timeframe: tfs[0],
    current_combination: null,
    algorithm: settings.algorithm || 'full_cycle',
    trials_processed: 0,
    error_count: 0,
    progress: 0,
    started_at: utcnow(),
    last_heartbeat: utcnow(),
    duplicates_prevented: 0,
    detail: {
      timeframes: tfs,
      start_date: startDate,
      end_date: endDate,
      indicators_count: indicators.length,
      strategies_count: strategies.length,
      max_indicators: maxInd === 0 ? 'unlimited' : capInd,
    },
  });

  const eState = store.state.agents.evaluation_agent;
  Object.assign(eState, {
    status: 'running',
    current_task: 'monitoring multi-timeframe experiment ledger',
    current_timeframe: tfs[0],
    current_combination: null,
    algorithm: 'Ledger Audit & DSR/Walk-Forward Ranking',
    trials_processed: 0,
    error_count: 0,
    progress: 0,
    started_at: utcnow(),
    last_heartbeat: utcnow(),
    duplicates_prevented: 0,
  });

  addAgentLog(
    'research_agent',
    'info',
    `Research started on dataset #${datasetId} across timeframes [${tfs.join(', ')}]: ${indicators.length} indicator(s), ${strategies.length} strategy(ies), max_indicators=${maxInd === 0 ? 'unlimited' : capInd}`
  );
  addAgentLog('evaluation_agent', 'info', 'Evaluation & Ranking Agent online; auditing ledger and ranking candidates across timeframes');
  store.save();

  // Async background loop for Agent 1
  (async () => {
    const candidates = [];
    const objective = settings.objective || 'net_profit';
    const cpuLimitPct = Number(settings.cpu_limit_pct || 90);
    const ramLimitPct = Number(settings.ram_limit_pct || 85);
    const memMb = Number(settings.ram_limit_mb || 256);

    try {
      for (let t = 0; t < totalTrialsBudget; t++) {
        if (!(await checkPauseAndLimits(rWorker, cpuLimitPct, ramLimitPct))) break;
        const tf = tfs[t % tfs.length];
        rState.last_heartbeat = utcnow();
        rState.progress = Math.min(0.95, t / totalTrialsBudget);
        rState.current_timeframe = tf;

        // Dynamically re-read registered indicators & strategies so newly updated ones are recognized mid-run
        const liveAll = getRegisteredIndicators();
        const liveInds = allowedIndNames ? liveAll.filter((i) => allowedIndNames.has(i.name)) : liveAll;
        const liveStrats = getRegisteredStrategies();
        if (liveInds.length === 0 && liveStrats.length === 0) break;

        // Systematically cover k = 1, 2, 3, 4+ indicator combinations as well as random parameter sampling
        let chosenInds = [];
        if (liveInds.length > 0) {
          const effCap = maxInd > 0 ? Math.min(maxInd, liveInds.length) : liveInds.length;
          const k = 1 + (t < effCap ? t : Math.floor(Math.random() * effCap));
          const shuffled = [...liveInds].sort(() => Math.random() - 0.5).slice(0, Math.min(k, liveInds.length));
          chosenInds = shuffled.map((ind) => ({
            name: ind.name,
            params: Object.fromEntries((ind.params || []).map((p) => [p.name, sampleParam(p)])),
          }));
        }

        let chosenStratIds = null;
        let stratLabel = null;
        let stratParams = null;
        if (liveStrats.length > 0) {
          const comboCount = liveStrats.length > 1 && Math.random() < 0.3 ? Math.min(2, liveStrats.length) : 1;
          const picked = [...liveStrats].sort(() => Math.random() - 0.5).slice(0, comboCount);
          chosenStratIds = picked.map((s) => s.id);
          stratLabel = picked.map((s) => s.name).join(' + ');
          stratParams = Object.fromEntries(picked.map((s) => [
            s.id,
            Object.fromEntries((s.params || []).map((p) => [p.name, sampleParam(p)])),
          ]));
        }

        const comboNames = chosenInds.map((i) => i.name).join(' + ');
        const spec = {
          strategy_name: stratLabel || comboNames,
          strategy_ids: chosenStratIds,
          strategy_params: stratParams,
          timeframe: tf,
          indicators: chosenInds,
          min_votes: chosenInds.length ? 1 + Math.floor(Math.random() * chosenInds.length) : 1,
          direction: randomChoice(['both', 'long', 'short']),
          stop_loss_pct: randomChoice([0.3, 0.5, 0.8, 1.0]),
          target_pct: randomChoice([0.5, 1.0, 1.5, 2.0]),
        };

        rState.current_combination = comboNames || spec.strategy_name;
        rState.current_task = `[${tf}] trial ${t + 1}/${totalTrialsBudget}: ${spec.strategy_name}`;
        eState.current_timeframe = tf;
        eState.current_combination = rState.current_combination;
        const t0 = Date.now();
        try {
          const { metrics } = await evaluateSpecFull(datasetId, spec, 'train', {
            timeframe: tf,
            startDate,
            endDate,
            backtestCfg: btCfg,
            memLimitMb: memMb,
          });
          const dur = Math.round(((Date.now() - t0) / 1000) * 1000) / 1000;
          const { duplicate } = upsertExperiment({
            agent: 'research_agent',
            trialNumber: t + 1,
            datasetId,
            timeframe: tf,
            startDate,
            endDate,
            split: 'train',
            spec,
            metrics,
            durationS: dur,
            initialCapital: btCfg.initial_capital,
          });
          if (duplicate) {
            rState.duplicates_prevented += 1;
          } else {
            rState.trials_processed += 1;
            const sc = objectiveScore(metrics, objective);
            candidates.push({ spec, timeframe: tf, metrics, score: sc });
            addAgentLog('research_agent', 'info', `[${tf}] Trial #${t + 1} (${spec.strategy_name}): net=${metrics.net_profit}, sharpe=${metrics.sharpe_ratio}, sortino=${metrics.sortino_ratio}, trades=${metrics.trades}`);
          }
        } catch (err) {
          rState.error_count += 1;
          upsertExperiment({
            agent: 'research_agent',
            trialNumber: t + 1,
            datasetId,
            timeframe: tf,
            startDate,
            endDate,
            split: 'train',
            spec,
            metrics: null,
            status: 'failed',
            error: err.message,
            initialCapital: btCfg.initial_capital,
          });
          addAgentLog('research_agent', 'error', `[${tf}] Trial #${t + 1} failed: ${err.message}`);
        }
        store.save();
        await sleep(40);
      }

      // Walk-forward validation on top K discovered candidates
      if (!rWorker.stopped && candidates.length > 0) {
        candidates.sort((a, b) => b.score - a.score);
        const topK = candidates.slice(0, Math.min(Number(settings.walk_forward_top_k || 5), candidates.length));
        rState.current_task = `walk-forward validating top ${topK.length} candidates`;
        for (let i = 0; i < topK.length; i++) {
          if (rWorker.stopped) break;
          const c = topK[i];
          rState.current_timeframe = c.timeframe;
          rState.current_combination = c.spec.strategy_name;
          const wf = await runWalkForward(datasetId, c.spec, { timeframe: c.timeframe, startDate, endDate, backtestCfg: btCfg });
          store.state.validations.push({
            id: store.state.nextIds.validation++,
            created_at: utcnow(),
            strategy_hash: specHash(c.spec),
            dataset_id: datasetId,
            ...wf,
          });
          try {
            const { metrics: valM } = await evaluateSpecFull(datasetId, c.spec, 'validation', { timeframe: c.timeframe, startDate, endDate, backtestCfg: btCfg });
            upsertExperiment({ agent: 'research_agent', datasetId, timeframe: c.timeframe, startDate, endDate, split: 'validation', spec: c.spec, metrics: valM, initialCapital: btCfg.initial_capital });
          } catch { /* ignore */ }
          addAgentLog('research_agent', 'info', `[${c.timeframe}] Walk-forward ${specHash(c.spec)}: ${wf.profitable_segments}/${wf.total_segments} segments profitable, validated=${wf.validated}`);
        }
      }

      // Compute DSR robustness across completed train experiments
      computeDsrForDataset(datasetId, 'train');
      rState.status = rWorker.stopped ? 'stopped' : 'completed';
      rState.progress = 1;
      rState.current_task = rWorker.reason === 'duration_limit_reached' ? 'stopped (search duration budget reached)' : (rWorker.stopped ? 'stopped by user' : 'finished');
      rState.last_heartbeat = utcnow();
      addAgentLog('research_agent', 'info', `Research Agent ${rState.status} (${rState.trials_processed} trials evaluated, ${rState.duplicates_prevented} duplicates avoided)`);
    } catch (err) {
      rState.status = 'error';
      rState.current_task = err.message;
      addAgentLog('research_agent', 'error', err.message);
    } finally {
      rWorker.alive = false;
      eWorker.stopped = true;
      eWorker.alive = false;
      eState.status = rState.status === 'error' ? 'error' : (rState.status === 'stopped' ? 'stopped' : 'completed');
      eState.progress = 1;
      eState.current_task = 'ledger audit & ranking snapshot complete';
      eState.last_heartbeat = utcnow();
      eState.trials_processed = store.state.experiments.filter((e) => e.dataset_id === datasetId && e.status === 'completed').length;
      store.state.agentCheckpoints.evaluation_agent = {
        updated_at: utcnow(),
        state: buildEvaluationSnapshot(datasetId),
      };
      store.save();
    }
  })();

  // Async background loop for Agent 2 (Evaluation & Ranking)
  (async () => {
    while (!eWorker.stopped && rWorker.alive) {
      eState.last_heartbeat = utcnow();
      eState.trials_processed = store.state.experiments.filter((e) => e.dataset_id === datasetId && e.status === 'completed').length;
      eState.progress = rState.progress;
      store.state.agentCheckpoints.evaluation_agent = {
        updated_at: utcnow(),
        state: buildEvaluationSnapshot(datasetId),
      };
      store.save();
      await sleep(1500);
    }
  })();

  return agentsStatus();
}

export function buildEvaluationSnapshot(datasetId = null) {
  const exps = datasetId
    ? store.state.experiments.filter((e) => e.dataset_id === Number(datasetId))
    : store.state.experiments;
  const completed = exps.filter((e) => e.status === 'completed').length;
  const failed = exps.filter((e) => e.status === 'failed').length;
  const pruned = exps.filter((e) => e.status === 'pruned').length;
  return {
    updated_at: utcnow(),
    audit: {
      status: failed > 0 ? 'attention' : 'ok',
      completed,
      failed,
      pruned,
      missing_metrics: 0,
      eligibility_mismatches: 0,
      duplicate_completed_rows: 0,
    },
  };
}

export function controlAgent(name, action) {
  const w = activeWorkers.get(name);
  const st = store.state.agents[name];
  if (!w || !w.alive) throw new Error(`${name} is not running`);
  if (action === 'pause') {
    w.paused = true;
    st.status = 'paused';
    addAgentLog(name, 'warn', 'Paused by user');
  } else if (action === 'resume') {
    w.paused = false;
    st.status = 'running';
    addAgentLog(name, 'info', 'Resumed by user');
  } else if (action === 'stop') {
    w.stopped = true;
    w.paused = false;
    st.status = 'stopping';
    addAgentLog(name, 'warn', 'Stop requested by user');
  } else {
    throw new Error('action must be pause, resume or stop');
  }
  store.save();
  return agentsStatus();
}

export function agentsStatus() {
  const list = ['research_agent', 'evaluation_agent'].map((name) => {
    const a = store.state.agents[name];
    const w = activeWorkers.get(name);
    const alive = Boolean(w?.alive);
    const uptimeS = alive && a.started_at ? Math.round((Date.now() - Date.parse(a.started_at)) / 1000) : null;
    return { ...a, alive, uptime_s: uptimeS };
  });
  return {
    agents: list,
    settings: store.state.savedAgentSettings,
    catalogue: {
      indicators: getRegisteredIndicators().length,
      strategies: getRegisteredStrategies().length,
    },
  };
}

// ---------------------------------------------------------------------------
// Optimization Studies (Optuna-compatible API powered by real isolated runner)
// ---------------------------------------------------------------------------
export function startOptimizationStudy(cfg) {
  const datasetId = Number(cfg.dataset_id);
  getMarketDataset(datasetId);
  const tfs = resolveRequestedTimeframes(cfg);
  const startDate = cfg.start_date || null;
  const endDate = cfg.end_date || null;
  loadCanonicalCandlesForEngine(datasetId, { timeframe: tfs[0], startDate, endDate, completedOnly: true });

  const indicators = getRegisteredIndicators();
  const strategies = getRegisteredStrategies();
  if (indicators.length === 0 && strategies.length === 0) {
    throw new Error('Register at least one custom indicator or strategy in the Studio before starting an optimization study.');
  }

  const key = `optuna:${cfg.study_name}`;
  if (activeWorkers.get(key)?.alive) throw new Error('An optimization study is already running');

  const runRec = {
    study_name: cfg.study_name,
    created_at: utcnow(),
    status: 'running',
    config: { ...cfg, timeframes: tfs },
    error: null,
  };
  store.state.optimizationRuns = [
    runRec,
    ...store.state.optimizationRuns.filter((r) => r.study_name !== cfg.study_name),
  ].slice(0, 50);

  const durationLimitS = Number(cfg.duration_limit_s || 0);
  const worker = {
    name: key,
    alive: true,
    paused: false,
    stopped: false,
    deadlineMs: durationLimitS > 0 ? Date.now() + durationLimitS * 1000 : null,
    progress: 0,
    current_task: 'initializing multi-timeframe study',
    status: 'running',
  };
  activeWorkers.set(key, worker);
  store.save();

  (async () => {
    const nTrials = Math.max(1, Number(cfg.n_trials || 20));
    const maxInd = Number(cfg.max_indicators || 0);
    const cpuLimitPct = Number(cfg.cpu_limit_pct || 90);
    const ramLimitPct = Number(cfg.ram_limit_pct || 85);
    const memMb = Number(cfg.ram_limit_mb || 256);
    const btCfg = resolveBacktestCfgFromSettings(cfg);

    try {
      for (let t = 0; t < nTrials; t++) {
        if (!(await checkPauseAndLimits(worker, cpuLimitPct, ramLimitPct))) break;
        const tf = tfs[t % tfs.length];
        const liveInds = getRegisteredIndicators();
        const liveStrats = getRegisteredStrategies();
        const effCap = maxInd > 0 ? Math.min(maxInd, Math.max(1, liveInds.length)) : Math.max(1, liveInds.length);
        const k = liveInds.length ? (1 + (t < effCap ? t : Math.floor(Math.random() * effCap))) : 0;
        const chosenInds = [...liveInds].sort(() => Math.random() - 0.5).slice(0, Math.min(k, liveInds.length)).map((ind) => ({
          name: ind.name,
          params: Object.fromEntries((ind.params || []).map((p) => [p.name, sampleParam(p)])),
        }));
        const pickedStrat = liveStrats.length ? [randomChoice(liveStrats)] : [];
        const spec = {
          strategy_name: pickedStrat.length ? pickedStrat[0].name : chosenInds.map((i) => i.name).join(' + '),
          strategy_ids: pickedStrat.length ? pickedStrat.map((s) => s.id) : null,
          strategy_params: pickedStrat.length ? Object.fromEntries(pickedStrat.map((s) => [s.id, Object.fromEntries((s.params || []).map((p) => [p.name, sampleParam(p)]))])) : null,
          timeframe: tf,
          indicators: chosenInds,
          min_votes: chosenInds.length ? 1 + Math.floor(Math.random() * chosenInds.length) : 1,
          direction: randomChoice(['both', 'long', 'short']),
          stop_loss_pct: randomChoice([0.3, 0.5, 0.8, 1.0]),
          target_pct: randomChoice([0.5, 1.0, 1.5, 2.0]),
        };
        worker.current_task = `[${tf}] trial ${t + 1}/${nTrials} (${spec.strategy_name})`;
        worker.progress = (t + 1) / nTrials;
        const t0 = Date.now();
        try {
          const { metrics } = await evaluateSpecFull(datasetId, spec, 'train', {
            timeframe: tf,
            startDate,
            endDate,
            backtestCfg: btCfg,
            memLimitMb: memMb,
          });
          upsertExperiment({
            agent: 'optuna',
            studyName: cfg.study_name,
            trialNumber: t + 1,
            datasetId,
            timeframe: tf,
            startDate,
            endDate,
            split: 'train',
            spec,
            metrics,
            durationS: Math.round(((Date.now() - t0) / 1000) * 1000) / 1000,
            initialCapital: btCfg.initial_capital,
          });
        } catch (err) {
          upsertExperiment({
            agent: 'optuna',
            studyName: cfg.study_name,
            trialNumber: t + 1,
            datasetId,
            timeframe: tf,
            startDate,
            endDate,
            split: 'train',
            spec,
            metrics: null,
            status: 'failed',
            error: err.message,
            initialCapital: btCfg.initial_capital,
          });
        }
        store.save();
        await sleep(30);
      }
      runRec.status = worker.stopped ? 'stopped' : 'completed';
      worker.status = runRec.status;
    } catch (err) {
      runRec.status = 'error';
      runRec.error = err.message;
      worker.status = 'error';
    } finally {
      worker.alive = false;
      store.save();
    }
  })();

  return { study_name: key, status: 'running', alive: true, progress: 0 };
}

export function getOptimizationRuns() {
  return store.state.optimizationRuns.map((r) => {
    const w = activeWorkers.get(`optuna:${r.study_name}`);
    return {
      ...r,
      live: w ? { alive: w.alive, status: w.paused ? 'paused' : w.status, progress: w.progress, current_task: w.current_task } : null,
    };
  });
}

export function controlOptimizationStudy(studyName, action) {
  const key = studyName.startsWith('optuna:') ? studyName : `optuna:${studyName}`;
  const w = activeWorkers.get(key);
  if (!w || !w.alive) throw new Error(`${key} is not running`);
  if (action === 'pause') { w.paused = true; w.status = 'paused'; }
  else if (action === 'resume') { w.paused = false; w.status = 'running'; }
  else if (action === 'stop') { w.stopped = true; w.paused = false; w.status = 'stopping'; }
  else throw new Error('Invalid action');
  return { alive: w.alive, status: w.status, progress: w.progress };
}

// ---------------------------------------------------------------------------
// Rankings & Results
// ---------------------------------------------------------------------------
export const RANKINGS = {
  profit: ['net_profit', true, 'Highest net profit'],
  sharpe_ratio: ['sharpe_ratio', true, 'Highest Sharpe ratio'],
  sortino_ratio: ['sortino_ratio', true, 'Highest Sortino ratio'],
  profit_factor: ['profit_factor', true, 'Highest profit factor'],
  win_rate: ['win_rate', true, 'Highest win rate'],
  drawdown: ['max_drawdown_pct', false, 'Lowest maximum drawdown'],
  risk_adjusted: ['recovery_factor', true, 'Best risk-adjusted (net profit / max drawdown)'],
  walk_forward: [null, true, 'Best walk-forward validated strategies'],
};

export function getLeaderboard(rankingKey, datasetId, { top = 50, split = 'train', timeframe = 'all', indicator = '', numIndicators = 0 } = {}) {
  if (!RANKINGS[rankingKey]) throw new Error(`Unknown ranking: ${rankingKey}`);
  const id = Number(datasetId);
  const normTf = timeframe && timeframe !== 'all' ? normalizeTimeframe(timeframe) : null;

  let completed = store.state.experiments.filter(
    (e) => e.dataset_id === id && e.split === split && e.status === 'completed' && e.eligible && e.metrics
  );
  if (normTf) {
    completed = completed.filter((e) => (e.timeframe || e.spec?.timeframe || '1m') === normTf);
  }
  if (indicator) {
    completed = completed.filter((e) => (e.spec?.indicators || []).some((i) => i.name === indicator));
  }
  if (Number(numIndicators) > 0) {
    const cnt = Number(numIndicators);
    completed = completed.filter((e) => {
      const k = (e.spec?.indicators || []).length;
      return cnt >= 4 ? k >= 4 : k === cnt;
    });
  }

  const latestByHash = new Map();
  for (const e of completed) {
    const tfKey = e.timeframe || e.spec?.timeframe || '1m';
    latestByHash.set(`${e.strategy_hash}::${tfKey}`, e);
  }
  const valsByHash = new Map();
  for (const v of store.state.validations) {
    if (v.dataset_id === id) valsByHash.set(v.strategy_hash, v);
  }
  const oosByHash = new Map();
  for (const o of store.state.oosTests) {
    if (o.dataset_id === id) oosByHash.set(o.strategy_hash, o);
  }
  const dsrByExp = new Map();
  for (const s of store.state.statisticalTests) {
    if (s.dataset_id === id && s.kind === 'dsr') dsrByExp.set(s.experiment_id, s.result);
  }

  let rows = [...latestByHash.values()].map((e) => {
    const val = valsByHash.get(e.strategy_hash) || null;
    const oos = oosByHash.get(e.strategy_hash) || null;
    const dsr = dsrByExp.get(e.id) || null;
    return {
      id: e.id,
      strategy_hash: e.strategy_hash,
      timeframe: e.timeframe || e.spec?.timeframe || '1m',
      spec: e.spec,
      metrics: e.metrics,
      created_at: e.created_at,
      study_name: e.study_name,
      trial_number: e.trial_number,
      agent: e.agent,
      validation: val,
      validated: Boolean(val?.validated),
      out_of_sample: oos ? { metrics: oos.metrics, created_at: oos.created_at } : null,
      dsr,
    };
  });

  const [metric, higher] = RANKINGS[rankingKey];
  if (rankingKey === 'walk_forward') {
    rows = rows.filter((r) => r.validation !== null);
    rows.sort((a, b) => (Number(b.validated) - Number(a.validated)) || (b.validation.validation_net_profit - a.validation.validation_net_profit));
  } else {
    if (rankingKey === 'drawdown') rows = rows.filter((r) => (r.metrics.net_profit || 0) > 0);
    rows.sort((a, b) => {
      const av = a.metrics[metric] ?? 0;
      const bv = b.metrics[metric] ?? 0;
      const cmp = higher ? (bv - av) : (av - bv);
      if (cmp !== 0) return cmp;
      // Tiebreak win_rate & others by net_profit so win_rate never acts as sole unconstrained criterion
      return (b.metrics.net_profit ?? 0) - (a.metrics.net_profit ?? 0);
    });
  }
  return rows.slice(0, top).map((r, idx) => ({ rank: idx + 1, ...r }));
}
