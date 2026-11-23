import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = path.resolve(process.env.IL_DATA_DIR || path.join(__dirname, 'data'));
export const HISTORICAL_DIR = path.resolve(process.env.IL_HISTORICAL_DIR || path.join(DATA_DIR, 'historical'));
export const DB_PATH = path.resolve(process.env.IL_DB_PATH || path.join(DATA_DIR, 'indicator_lab.db'));

export const TIMEFRAME_MINUTES = {
  '1m': 1,
  '5m': 5,
  '10m': 10,
  '1H': 60,
  '4H': 240,
};

export const SUPPORTED_TIMEFRAMES = ['1m', '5m', '10m', '1H', '4H'];

export function normalizeTimeframe(tf) {
  const s = String(tf || '1m').trim();
  if (SUPPORTED_TIMEFRAMES.includes(s)) return s;
  const low = s.toLowerCase();
  if (low === '1min' || low === '1m') return '1m';
  if (low === '5min' || low === '5m') return '5m';
  if (low === '10min' || low === '10m') return '10m';
  if (low === '60min' || low === '1h' || low === '60m') return '1H';
  if (low === '240min' || low === '4h' || low === '240m') return '4H';
  return null;
}

function utcnow() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

fs.mkdirSync(DATA_DIR, { recursive: true });
export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode=WAL;');
db.exec('PRAGMA synchronous=NORMAL;');
db.exec('PRAGMA foreign_keys=ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS md_datasets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  instrument TEXT NOT NULL DEFAULT 'NIFTY 50 INDEX',
  symbol TEXT NOT NULL,
  timeframe TEXT NOT NULL DEFAULT '1m',
  timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  source_dir TEXT,
  source_files_json TEXT NOT NULL DEFAULT '[]',
  rows INTEGER NOT NULL DEFAULT 0,
  volume_rows INTEGER NOT NULL DEFAULT 0,
  start_ts TEXT,
  end_ts TEXT,
  status TEXT NOT NULL DEFAULT 'complete',
  imported_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS md_candles (
  dataset_id INTEGER NOT NULL REFERENCES md_datasets(id) ON DELETE CASCADE,
  ts TEXT NOT NULL,
  open REAL NOT NULL,
  high REAL NOT NULL,
  low REAL NOT NULL,
  close REAL NOT NULL,
  volume REAL,
  PRIMARY KEY (dataset_id, ts)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS ix_md_candles_ds_ts ON md_candles(dataset_id, ts);

CREATE TABLE IF NOT EXISTS md_resampled_candles (
  dataset_id INTEGER NOT NULL REFERENCES md_datasets(id) ON DELETE CASCADE,
  timeframe TEXT NOT NULL,
  ts TEXT NOT NULL,
  open REAL NOT NULL,
  high REAL NOT NULL,
  low REAL NOT NULL,
  close REAL NOT NULL,
  volume REAL,
  volume_available INTEGER NOT NULL DEFAULT 0,
  is_partial INTEGER NOT NULL DEFAULT 0,
  source_count INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (dataset_id, timeframe, ts)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS ix_md_resampled_ds_tf_ts ON md_resampled_candles(dataset_id, timeframe, ts);

CREATE TABLE IF NOT EXISTS md_imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dataset_name TEXT NOT NULL,
  dataset_id INTEGER,
  status TEXT NOT NULL,
  total_files INTEGER NOT NULL DEFAULT 0,
  processed_files INTEGER NOT NULL DEFAULT 0,
  total_rows INTEGER NOT NULL DEFAULT 0,
  accepted_rows INTEGER NOT NULL DEFAULT 0,
  rejected_rows INTEGER NOT NULL DEFAULT 0,
  duplicate_rows INTEGER NOT NULL DEFAULT 0,
  volume_rows INTEGER NOT NULL DEFAULT 0,
  source_files_json TEXT NOT NULL DEFAULT '[]',
  errors_json TEXT NOT NULL DEFAULT '[]',
  started_at TEXT NOT NULL,
  completed_at TEXT
);
`);

// Add source_signature column cleanly for existing databases
try {
  db.exec('ALTER TABLE md_datasets ADD COLUMN source_signature TEXT;');
} catch { /* column already exists */ }

// Recover any interrupted imports from an unexpected shutdown
db.prepare("UPDATE md_imports SET status='interrupted' WHERE status='importing'").run();
db.prepare("UPDATE md_datasets SET status='incomplete' WHERE status='importing'").run();

// ---------------------------------------------------------------------------
// Timestamp & IST (Asia/Kolkata, UTC+05:30) Normalization
// ---------------------------------------------------------------------------
const IST_OFFSET_MS = 330 * 60 * 1000;

export function epochToIstIso(epochRaw) {
  const num = Number(epochRaw);
  if (!Number.isFinite(num) || num <= 0) return null;
  const ms = num > 1e12 ? num : num * 1000;
  const ist = new Date(ms + IST_OFFSET_MS);
  if (Number.isNaN(ist.getTime())) return null;
  const y = ist.getUTCFullYear();
  const m = String(ist.getUTCMonth() + 1).padStart(2, '0');
  const d = String(ist.getUTCDate()).padStart(2, '0');
  const hh = String(ist.getUTCHours()).padStart(2, '0');
  const mm = String(ist.getUTCMinutes()).padStart(2, '0');
  const ss = String(ist.getUTCSeconds()).padStart(2, '0');
  return `${y}-${m}-${d}T${hh}:${mm}:${ss}+05:30`;
}

export function normalizeIstTimestamp(rawTs, rawEpoch = null) {
  const s = String(rawTs || '').trim();
  if (s) {
    // Match YYYY-MM-DD[ T]HH:MM(:SS)? with optional timezone
    let m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(?:\s*([+-]\d{2}:?\d{2}|Z))?$/);
    if (m) {
      const [, y, mo, d, hh, mm, ss = '00', tz] = m;
      if (tz && tz !== '+05:30' && tz !== '+0530') {
        const parsed = Date.parse(s);
        if (Number.isFinite(parsed)) return epochToIstIso(parsed);
      }
      return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}T${hh.padStart(2, '0')}:${mm}:${ss}+05:30`;
    }
    // Match DD-MM-YYYY HH:MM(:SS)?
    m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (m) {
      const [, d, mo, y, hh, mm, ss = '00'] = m;
      return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}T${hh.padStart(2, '0')}:${mm}:${ss}+05:30`;
    }
    const parsed = Date.parse(s);
    if (Number.isFinite(parsed)) return epochToIstIso(parsed);
  }
  if (rawEpoch !== null && rawEpoch !== undefined && String(rawEpoch).trim() !== '') {
    return epochToIstIso(rawEpoch);
  }
  return null;
}

export function istDateOf(ts) {
  return ts.slice(0, 10);
}

export function istMinuteOfDay(ts) {
  const hh = Number(ts.slice(11, 13));
  const mm = Number(ts.slice(14, 16));
  return hh * 60 + mm;
}

// ---------------------------------------------------------------------------
// Recursive CSV Discovery (sorted chronologically)
// ---------------------------------------------------------------------------
function chronoSortKey(relPath) {
  const m = relPath.match(/(\d{4})(?:[-_](\d{1,2}))?/);
  if (m) {
    return `${m[1]}-${(m[2] || '00').padStart(2, '0')}-${relPath}`;
  }
  return `9999-99-${relPath}`;
}

export function discoverHistoricalCsvFiles(dir = HISTORICAL_DIR) {
  if (!fs.existsSync(dir)) return [];
  const found = [];
  function walk(cur) {
    const entries = fs.readdirSync(cur, { withFileTypes: true });
    for (const ent of entries) {
      const full = path.join(cur, ent.name);
      if (ent.isDirectory()) {
        walk(full);
      } else if (ent.isFile() && ent.name.toLowerCase().endsWith('.csv')) {
        const rel = path.relative(dir, full).replace(/\\/g, '/');
        const st = fs.statSync(full);
        found.push({ path: full, relative_path: rel, size_bytes: st.size });
      }
    }
  }
  walk(dir);
  found.sort((a, b) => chronoSortKey(a.relative_path).localeCompare(chronoSortKey(b.relative_path)));
  return found;
}

export function computeFilesSignature(files = []) {
  const normalized = [...files]
    .map((f) => `${f.relative_path || path.basename(f.path)}:${Number(f.size_bytes || 0)}`)
    .sort()
    .join('|');
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// Streaming Chunked Ingestion Pipeline
// ---------------------------------------------------------------------------
function parseHeaderIndices(headerLine) {
  const cols = headerLine.split(',').map((c) => c.trim().toLowerCase());
  const idx = (names) => cols.findIndex((c) => names.includes(c));
  const epochIdx = idx(['epoch', 'unix', 'unix_time']);
  const tsIdx = idx(['timestamp', 'datetime', 'date_time', 'time']);
  const dateIdx = idx(['date']);
  const timeIdx = idx(['time']);
  const openIdx = idx(['open', 'o']);
  const highIdx = idx(['high', 'h']);
  const lowIdx = idx(['low', 'l']);
  const closeIdx = idx(['close', 'c']);
  const volIdx = idx(['volume', 'vol', 'v']);

  if (openIdx < 0 || highIdx < 0 || lowIdx < 0 || closeIdx < 0) {
    throw new Error('CSV header missing required OHLC columns (Open, High, Low, Close)');
  }
  if (tsIdx < 0 && epochIdx < 0 && (dateIdx < 0 || timeIdx < 0)) {
    throw new Error('CSV header missing Timestamp, Epoch, or Date+Time columns');
  }
  return { epochIdx, tsIdx, dateIdx, timeIdx, openIdx, highIdx, lowIdx, closeIdx, volIdx };
}

function parseOptionalVolume(raw) {
  if (raw === undefined || raw === null) return null;
  const s = String(raw).trim();
  if (!s || s.toLowerCase() === 'nan' || s.toLowerCase() === 'null' || s.toLowerCase() === 'none' || s === '-') {
    return null;
  }
  const v = Number(s);
  if (!Number.isFinite(v) || v < 0) return null;
  return v;
}

async function streamCsvFileInBatches(filePath, datasetId, insertStmt, batchSize = 25000) {
  const stats = {
    total_rows: 0,
    accepted_rows: 0,
    rejected_rows: 0,
    duplicate_rows: 0,
    volume_rows: 0,
    has_volume_column: false,
    errors: [],
  };

  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: 'utf8', highWaterMark: 512 * 1024 }),
    crlfDelay: Infinity,
  });

  let mapIdx = null;
  let lineNo = 0;
  let batch = [];

  const flushBatch = () => {
    if (!batch.length) return;
    db.exec('BEGIN IMMEDIATE;');
    try {
      for (const row of batch) {
        const info = insertStmt.run(datasetId, row.ts, row.open, row.high, row.low, row.close, row.volume);
        if (Number(info.changes) === 0) {
          stats.duplicate_rows++;
        } else {
          stats.accepted_rows++;
          if (row.volume !== null) stats.volume_rows++;
        }
      }
      db.exec('COMMIT;');
    } catch (err) {
      db.exec('ROLLBACK;');
      throw err;
    }
    batch = [];
  };

  for await (const rawLine of rl) {
    lineNo++;
    const line = rawLine.trim();
    if (!line) continue;

    if (!mapIdx) {
      mapIdx = parseHeaderIndices(line);
      stats.has_volume_column = mapIdx.volIdx >= 0;
      continue;
    }

    stats.total_rows++;
    const cols = line.split(',');
    const rawTs = mapIdx.tsIdx >= 0
      ? cols[mapIdx.tsIdx]
      : (mapIdx.dateIdx >= 0 && mapIdx.timeIdx >= 0 ? `${cols[mapIdx.dateIdx]} ${cols[mapIdx.timeIdx]}` : '');
    const rawEpoch = mapIdx.epochIdx >= 0 ? cols[mapIdx.epochIdx] : null;
    const ts = normalizeIstTimestamp(rawTs, rawEpoch);
    if (!ts) {
      stats.rejected_rows++;
      if (stats.errors.length < 25) stats.errors.push(`Line ${lineNo}: invalid timestamp '${rawTs || rawEpoch}'`);
      continue;
    }

    const open = Number(cols[mapIdx.openIdx]);
    const high = Number(cols[mapIdx.highIdx]);
    const low = Number(cols[mapIdx.lowIdx]);
    const close = Number(cols[mapIdx.closeIdx]);
    if (![open, high, low, close].every((v) => Number.isFinite(v) && v > 0)) {
      stats.rejected_rows++;
      if (stats.errors.length < 25) stats.errors.push(`Line ${lineNo}: non-positive or non-numeric OHLC`);
      continue;
    }
    if (high < Math.max(open, close, low) || low > Math.min(open, close, high)) {
      stats.rejected_rows++;
      if (stats.errors.length < 25) stats.errors.push(`Line ${lineNo}: inconsistent OHLC bounds (${open},${high},${low},${close})`);
      continue;
    }

    const volume = mapIdx.volIdx >= 0 ? parseOptionalVolume(cols[mapIdx.volIdx]) : null;
    batch.push({ ts, open, high, low, close, volume });

    if (batch.length >= batchSize) {
      flushBatch();
    }
  }
  flushBatch();
  return stats;
}

export async function ingestHistoricalDataset({
  files,
  name = 'NIFTY50_1MIN',
  instrument = 'NIFTY 50 INDEX',
  symbol = 'NIFTY50',
  timeframe = '1m',
  sourceDir = HISTORICAL_DIR,
  replace = false,
}) {
  if (!files || files.length === 0) {
    throw new Error(`No CSV files provided or discovered in ${sourceDir}`);
  }

  const existing = db.prepare('SELECT * FROM md_datasets WHERE name = ?').get(name);
  if (existing && existing.status === 'complete' && !replace) {
    throw new Error(`Dataset '${name}' is already imported (${existing.rows.toLocaleString()} candles). Pass replace=true to re-import.`);
  }

  const importRec = db.prepare(`
    INSERT INTO md_imports (dataset_name, status, total_files, source_files_json, started_at)
    VALUES (?, 'importing', ?, ?, ?)
  `).run(name, files.length, JSON.stringify(files.map((f) => f.relative_path || path.basename(f.path))), utcnow());
  const importId = Number(importRec.lastInsertRowid);

  // Create staging dataset or reuse incomplete staging dataset
  let datasetId;
  if (existing) {
    datasetId = existing.id;
    db.prepare('DELETE FROM md_candles WHERE dataset_id = ?').run(datasetId);
    db.prepare('DELETE FROM md_resampled_candles WHERE dataset_id = ?').run(datasetId);
    db.prepare("UPDATE md_datasets SET status='importing', source_dir=?, source_files_json=?, rows=0, volume_rows=0, start_ts=NULL, end_ts=NULL, imported_at=? WHERE id=?")
      .run(sourceDir, JSON.stringify(files.map((f) => f.relative_path || path.basename(f.path))), utcnow(), datasetId);
  } else {
    const ins = db.prepare(`
      INSERT INTO md_datasets (name, instrument, symbol, timeframe, timezone, source_dir, source_files_json, status, imported_at)
      VALUES (?, ?, ?, ?, 'Asia/Kolkata', ?, ?, 'importing', ?)
    `).run(name, instrument, symbol, timeframe, sourceDir, JSON.stringify(files.map((f) => f.relative_path || path.basename(f.path))), utcnow());
    datasetId = Number(ins.lastInsertRowid);
  }

  db.prepare('UPDATE md_imports SET dataset_id = ? WHERE id = ?').run(datasetId, importId);

  const sig = computeFilesSignature(files);
  const insertStmt = db.prepare('INSERT OR IGNORE INTO md_candles (dataset_id, ts, open, high, low, close, volume) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const updateImportStmt = db.prepare(`
    UPDATE md_imports SET processed_files=?, total_rows=?, accepted_rows=?, rejected_rows=?, duplicate_rows=?, volume_rows=?, errors_json=? WHERE id=?
  `);

  let processedFiles = 0;
  let totalRows = 0;
  let acceptedRows = 0;
  let rejectedRows = 0;
  let duplicateRows = 0;
  let volumeRows = 0;
  const errors = [];

  try {
    for (const f of files) {
      const label = f.relative_path || path.basename(f.path);
      try {
        const s = await streamCsvFileInBatches(f.path, datasetId, insertStmt);
        totalRows += s.total_rows;
        acceptedRows += s.accepted_rows;
        rejectedRows += s.rejected_rows;
        duplicateRows += s.duplicate_rows;
        volumeRows += s.volume_rows;
        for (const e of s.errors) {
          if (errors.length < 100) errors.push({ file: label, error: e });
        }
      } catch (fileErr) {
        errors.push({ file: label, error: fileErr.message });
      }
      processedFiles++;
      updateImportStmt.run(processedFiles, totalRows, acceptedRows, rejectedRows, duplicateRows, volumeRows, JSON.stringify(errors), importId);
    }

    const summary = db.prepare('SELECT COUNT(*) AS cnt, MIN(ts) AS min_ts, MAX(ts) AS max_ts, SUM(CASE WHEN volume IS NOT NULL THEN 1 ELSE 0 END) AS vol_cnt FROM md_candles WHERE dataset_id = ?').get(datasetId);
    const actualCount = Number(summary?.cnt || 0);
    if (actualCount === 0) {
      throw new Error('No valid OHLC candles were imported from the provided CSV files.');
    }

    const actualVolCount = Number(summary?.vol_cnt || 0);
    db.prepare(`
      UPDATE md_datasets SET rows=?, volume_rows=?, start_ts=?, end_ts=?, status='complete', source_signature=?, imported_at=? WHERE id=?
    `).run(actualCount, actualVolCount, summary.min_ts, summary.max_ts, sig, utcnow(), datasetId);

    db.prepare("UPDATE md_imports SET status='complete', completed_at=? WHERE id=?").run(utcnow(), importId);

    return {
      dataset: getMarketDataset(datasetId),
      import_report: getImportReport(importId),
    };
  } catch (err) {
    db.prepare("UPDATE md_datasets SET status='failed' WHERE id=?").run(datasetId);
    db.prepare("UPDATE md_imports SET status='failed', errors_json=?, completed_at=? WHERE id=?")
      .run(JSON.stringify([...errors, { file: 'pipeline', error: err.message }]), utcnow(), importId);
    throw err;
  }
}

export async function ingestUploadedCsvStreams({ files, name = 'NIFTY50_1MIN', symbol = 'NIFTY50', replace = true }) {
  const tempDir = path.join(DATA_DIR, '_upload_tmp', String(Date.now()));
  fs.mkdirSync(tempDir, { recursive: true });
  try {
    const prepared = [];
    for (const f of files) {
      const safeName = path.basename(f.name || `upload_${prepared.length}.csv`);
      const target = path.join(tempDir, safeName);
      fs.writeFileSync(target, f.content, 'utf8');
      prepared.push({ path: target, relative_path: safeName, size_bytes: Buffer.byteLength(f.content, 'utf8') });
    }
    prepared.sort((a, b) => chronoSortKey(a.relative_path).localeCompare(chronoSortKey(b.relative_path)));
    return await ingestHistoricalDataset({
      files: prepared,
      name,
      symbol,
      sourceDir: 'browser_upload',
      replace,
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

export function ingestCandlesArray({ name, instrument = 'NIFTY 50 INDEX', symbol = 'SYNTHETIC', timeframe = '1m', sourceDir = 'synthetic_generator', candles, replace = true }) {
  const existing = db.prepare('SELECT id, status FROM md_datasets WHERE name = ?').get(name);
  if (existing && existing.status === 'complete' && !replace) {
    throw new Error(`dataset '${name}' already exists; pass replace=true to overwrite`);
  }
  let datasetId;
  if (existing) {
    datasetId = existing.id;
    db.prepare('DELETE FROM md_candles WHERE dataset_id = ?').run(datasetId);
    db.prepare('DELETE FROM md_resampled_candles WHERE dataset_id = ?').run(datasetId);
    db.prepare("UPDATE md_datasets SET instrument=?, symbol=?, timeframe=?, source_dir=?, status='importing', imported_at=? WHERE id=?")
      .run(instrument, symbol, timeframe, sourceDir, utcnow(), datasetId);
  } else {
    const res = db.prepare(`
      INSERT INTO md_datasets (name, instrument, symbol, timeframe, timezone, source_dir, source_files_json, status, imported_at)
      VALUES (?, ?, ?, ?, 'Asia/Kolkata', ?, '[]', 'importing', ?)
    `).run(name, instrument, symbol, timeframe, sourceDir, utcnow());
    datasetId = Number(res.lastInsertRowid);
  }

  const ins = db.prepare('INSERT OR REPLACE INTO md_candles (dataset_id, ts, open, high, low, close, volume) VALUES (?, ?, ?, ?, ?, ?, ?)');
  db.exec('BEGIN IMMEDIATE;');
  let volRows = 0;
  try {
    for (const c of candles) {
      const ts = normalizeIstTimestamp(c.time || c.ts);
      if (!ts) continue;
      const vol = c.volume !== undefined && c.volume !== null ? Number(c.volume) : null;
      if (vol !== null && Number.isFinite(vol)) volRows++;
      ins.run(datasetId, ts, c.open, c.high, c.low, c.close, Number.isFinite(vol) ? vol : null);
    }
    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }

  const summary = db.prepare('SELECT COUNT(*) AS cnt, MIN(ts) AS min_ts, MAX(ts) AS max_ts FROM md_candles WHERE dataset_id = ?').get(datasetId);
  db.prepare("UPDATE md_datasets SET rows=?, volume_rows=?, start_ts=?, end_ts=?, status='complete' WHERE id=?")
    .run(Number(summary.cnt), volRows, summary.min_ts, summary.max_ts, datasetId);
  return getMarketDataset(datasetId);
}

// ---------------------------------------------------------------------------
// Dataset Metadata & Import Reports
// ---------------------------------------------------------------------------
function formatDatasetRow(r) {
  if (!r) return null;
  const sourceFiles = JSON.parse(r.source_files_json || '[]');
  const cachedTfs = db.prepare('SELECT DISTINCT timeframe FROM md_resampled_candles WHERE dataset_id = ?').all(r.id).map((x) => x.timeframe);
  return {
    id: r.id,
    name: r.name,
    instrument: r.instrument,
    symbol: r.symbol,
    timeframe: r.timeframe,
    timezone: r.timezone,
    source_dir: r.source_dir,
    source_files: sourceFiles,
    rows: r.rows,
    volume_rows: r.volume_rows,
    volume_available: r.volume_rows > 0,
    volume_coverage_pct: r.rows > 0 ? Math.round((r.volume_rows / r.rows) * 10000) / 100 : 0,
    start_ts: r.start_ts,
    end_ts: r.end_ts,
    status: r.status,
    imported_at: r.imported_at,
    available_timeframes: SUPPORTED_TIMEFRAMES,
    cached_timeframes: ['1m', ...cachedTfs],
  };
}

export function listMarketDatasets(includeIncomplete = false) {
  const sql = includeIncomplete
    ? 'SELECT * FROM md_datasets ORDER BY id'
    : "SELECT * FROM md_datasets WHERE status = 'complete' ORDER BY id";
  return db.prepare(sql).all().map(formatDatasetRow);
}

export function getMarketDataset(datasetId) {
  const r = db.prepare('SELECT * FROM md_datasets WHERE id = ?').get(Number(datasetId));
  if (!r) throw Object.assign(new Error(`dataset ${datasetId} not found`), { status: 404 });
  return formatDatasetRow(r);
}

export function getMarketDatasetByName(name) {
  const r = db.prepare('SELECT * FROM md_datasets WHERE name = ?').get(name);
  return formatDatasetRow(r);
}

export function getImportReport(importId) {
  const r = db.prepare('SELECT * FROM md_imports WHERE id = ?').get(Number(importId));
  if (!r) return null;
  return {
    ...r,
    source_files: JSON.parse(r.source_files_json || '[]'),
    errors: JSON.parse(r.errors_json || '[]'),
  };
}

export function getDatasetQualityReport(datasetId) {
  const id = Number(datasetId);
  const ds = getMarketDataset(id);
  const imports = db.prepare('SELECT * FROM md_imports WHERE dataset_id = ? ORDER BY id DESC LIMIT 10').all(id).map((r) => ({
    ...r,
    source_files: JSON.parse(r.source_files_json || '[]'),
    errors: JSON.parse(r.errors_json || '[]'),
  }));
  const volBounds = db.prepare('SELECT MIN(ts) AS vol_start, MAX(ts) AS vol_end FROM md_candles WHERE dataset_id = ? AND volume IS NOT NULL').get(id);
  const latest = imports[0] || null;
  return {
    dataset: ds,
    volume_start_ts: volBounds?.vol_start || null,
    volume_end_ts: volBounds?.vol_end || null,
    latest_import: latest,
    totals: {
      accepted_rows: latest?.accepted_rows ?? ds.rows,
      rejected_rows: latest?.rejected_rows ?? 0,
      duplicate_rows: latest?.duplicate_rows ?? 0,
      missing_volume_rows: Math.max(0, ds.rows - ds.volume_rows),
    },
    imports,
  };
}

// ---------------------------------------------------------------------------
// NSE Session-Anchored Multi-Timeframe Aggregation & Cache
// ---------------------------------------------------------------------------
const SESSION_OPEN_MIN = 9 * 60 + 15; // 09:15 IST
const SESSION_CLOSE_MIN = 15 * 60 + 30; // 15:30 IST

function formatMinuteOfDay(dateStr, minOfDay) {
  const hh = String(Math.floor(minOfDay / 60)).padStart(2, '0');
  const mm = String(minOfDay % 60).padStart(2, '0');
  return `${dateStr}T${hh}:${mm}:00+05:30`;
}

export function ensureTimeframeCandles(datasetId, rawTf = '1m') {
  const tf = normalizeTimeframe(rawTf);
  if (!tf) throw new Error(`Unsupported timeframe '${rawTf}'. Supported: ${SUPPORTED_TIMEFRAMES.join(', ')}`);
  const id = Number(datasetId);
  getMarketDataset(id);
  if (tf === '1m') return tf;

  const existing = db.prepare('SELECT COUNT(*) AS cnt FROM md_resampled_candles WHERE dataset_id = ? AND timeframe = ?').get(id, tf);
  if (Number(existing?.cnt || 0) > 0) return tf;

  const tfMin = TIMEFRAME_MINUTES[tf];
  const stmt = db.prepare('SELECT ts, open, high, low, close, volume FROM md_candles WHERE dataset_id = ? ORDER BY ts');
  const ins = db.prepare(`
    INSERT OR REPLACE INTO md_resampled_candles
      (dataset_id, timeframe, ts, open, high, low, close, volume, volume_available, is_partial, source_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let curKey = null;
  let bucket = null;
  let batch = [];

  const flushBucket = () => {
    if (!bucket) return;
    const isPartial = bucket.sourceCount < tfMin ? 1 : 0;
    batch.push([
      id,
      tf,
      bucket.ts,
      bucket.open,
      bucket.high,
      bucket.low,
      bucket.close,
      bucket.volAvailable ? bucket.volSum : null,
      bucket.volAvailable ? 1 : 0,
      isPartial,
      bucket.sourceCount,
    ]);
    bucket = null;
  };

  const commitBatch = () => {
    if (!batch.length) return;
    db.exec('BEGIN IMMEDIATE;');
    try {
      for (const row of batch) ins.run(...row);
      db.exec('COMMIT;');
    } catch (err) {
      db.exec('ROLLBACK;');
      throw err;
    }
    batch = [];
  };

  for (const c of stmt.iterate(id)) {
    const dateStr = istDateOf(c.ts);
    const mod = istMinuteOfDay(c.ts);
    if (mod < SESSION_OPEN_MIN || mod > SESSION_CLOSE_MIN) continue;
    const offset = mod === SESSION_CLOSE_MIN ? (SESSION_CLOSE_MIN - SESSION_OPEN_MIN - 1) : (mod - SESSION_OPEN_MIN);
    const bucketIdx = Math.floor(offset / tfMin);
    const startMin = SESSION_OPEN_MIN + bucketIdx * tfMin;
    const bTs = formatMinuteOfDay(dateStr, startMin);

    if (curKey !== bTs) {
      flushBucket();
      if (batch.length >= 10000) commitBatch();
      curKey = bTs;
      bucket = {
        ts: bTs,
        startMin,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volSum: c.volume !== null ? c.volume : 0,
        volAvailable: c.volume !== null,
        sourceCount: 1,
      };
    } else {
      bucket.high = Math.max(bucket.high, c.high);
      bucket.low = Math.min(bucket.low, c.low);
      bucket.close = c.close;
      if (c.volume !== null) {
        bucket.volSum += c.volume;
        bucket.volAvailable = true;
      }
      bucket.sourceCount++;
    }
  }
  flushBucket();
  commitBatch();
  return tf;
}

// ---------------------------------------------------------------------------
// Querying Candles (Paginated / Viewport / Date Range / Engine Slice)
// ---------------------------------------------------------------------------
function normalizeRangeEnd(endDate) {
  if (!endDate) return null;
  const s = String(endDate).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${s}T23:59:59+05:30`;
  return s;
}

function normalizeRangeStart(startDate) {
  if (!startDate) return null;
  const s = String(startDate).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${s}T00:00:00+05:30`;
  return s;
}

export function queryMarketCandles(datasetId, {
  timeframe = '1m',
  startDate = null,
  endDate = null,
  before = null,
  after = null,
  limit = 1000,
  offset = 0,
  includePartial = true,
} = {}) {
  const id = Number(datasetId);
  const tf = ensureTimeframeCandles(id, timeframe);
  const safeLimit = Math.min(5000, Math.max(1, Number(limit || 1000)));
  const startIso = normalizeRangeStart(startDate);
  const endIso = normalizeRangeEnd(endDate);

  const table = tf === '1m' ? 'md_candles' : 'md_resampled_candles';
  const baseWhere = ['dataset_id = ?'];
  const baseParams = [id];
  if (tf !== '1m') {
    baseWhere.push('timeframe = ?');
    baseParams.push(tf);
    if (!includePartial) baseWhere.push('is_partial = 0');
  }
  if (startIso) { baseWhere.push('ts >= ?'); baseParams.push(startIso); }
  if (endIso) { baseWhere.push('ts <= ?'); baseParams.push(endIso); }

  const where = [...baseWhere];
  const params = [...baseParams];
  if (before) { where.push('ts < ?'); params.push(before); }
  if (after) { where.push('ts > ?'); params.push(after); }

  const clause = where.join(' AND ');
  const baseClause = baseWhere.join(' AND ');
  const countRow = db.prepare(`SELECT COUNT(*) AS total, MIN(ts) AS min_ts, MAX(ts) AS max_ts FROM ${table} WHERE ${clause}`).get(...params);

  const cols = tf === '1m'
    ? 'ts, open, high, low, close, volume, (CASE WHEN volume IS NOT NULL THEN 1 ELSE 0 END) AS volume_available, 0 AS is_partial, 1 AS source_count'
    : 'ts, open, high, low, close, volume, volume_available, is_partial, source_count';

  // When no `after` cursor is given and `offset` is 0, fetch the LATEST `safeLimit` bars in chronological order
  let rows;
  if (after || Number(offset) > 0) {
    rows = db.prepare(`SELECT ${cols} FROM ${table} WHERE ${clause} ORDER BY ts ASC LIMIT ? OFFSET ?`)
      .all(...params, safeLimit, Number(offset || 0));
  } else {
    rows = db.prepare(`SELECT ${cols} FROM ${table} WHERE ${clause} ORDER BY ts DESC LIMIT ?`)
      .all(...params, safeLimit).reverse();
  }

  const bars = rows.map((r) => ({
    time: r.ts,
    open: r.open,
    high: r.high,
    low: r.low,
    close: r.close,
    volume: r.volume,
    volume_available: Boolean(r.volume_available),
    is_partial: Boolean(r.is_partial),
    source_count: r.source_count,
  }));

  const hasMoreEarlier = bars.length > 0
    ? Boolean(db.prepare(`SELECT 1 FROM ${table} WHERE ${baseClause} AND ts < ? LIMIT 1`).get(...baseParams, bars[0].time))
    : false;
  const hasMoreNewer = bars.length > 0
    ? Boolean(db.prepare(`SELECT 1 FROM ${table} WHERE ${baseClause} AND ts > ? LIMIT 1`).get(...baseParams, bars[bars.length - 1].time))
    : false;

  const anyVol = bars.some((b) => b.volume_available);
  return {
    dataset_id: id,
    timeframe: tf,
    total_in_range: Number(countRow?.total || 0),
    range_start_ts: countRow?.min_ts || null,
    range_end_ts: countRow?.max_ts || null,
    returned: bars.length,
    has_more_earlier: hasMoreEarlier,
    has_more_newer: hasMoreNewer,
    volume_available: anyVol,
    bars,
  };
}

// Load canonical candles for backtest / agent splits (chronological, completed candles by default for HTF)
export function loadCanonicalCandlesForEngine(datasetId, {
  timeframe = '1m',
  startDate = null,
  endDate = null,
  completedOnly = true,
  maxBars = 250000,
} = {}) {
  const id = Number(datasetId);
  const tf = ensureTimeframeCandles(id, timeframe);
  const table = tf === '1m' ? 'md_candles' : 'md_resampled_candles';
  const where = ['dataset_id = ?'];
  const params = [id];
  if (tf !== '1m') {
    where.push('timeframe = ?');
    params.push(tf);
    if (completedOnly) where.push('is_partial = 0');
  }
  const startIso = normalizeRangeStart(startDate);
  const endIso = normalizeRangeEnd(endDate);
  if (startIso) { where.push('ts >= ?'); params.push(startIso); }
  if (endIso) { where.push('ts <= ?'); params.push(endIso); }

  const clause = where.join(' AND ');
  const cols = tf === '1m'
    ? 'ts, open, high, low, close, volume, (CASE WHEN volume IS NOT NULL THEN 1 ELSE 0 END) AS volume_available, 0 AS is_partial'
    : 'ts, open, high, low, close, volume, volume_available, is_partial';

  const countRow = db.prepare(`SELECT COUNT(*) AS cnt FROM ${table} WHERE ${clause}`).get(...params);
  const total = Number(countRow?.cnt || 0);
  if (total === 0) throw new Error(`Dataset ${id} has no candles for timeframe ${tf} in the requested date range`);

  // If total exceeds memory cap, take most recent `maxBars` chronologically
  let rows;
  if (total > maxBars) {
    rows = db.prepare(`SELECT ${cols} FROM ${table} WHERE ${clause} ORDER BY ts DESC LIMIT ?`).all(...params, maxBars).reverse();
  } else {
    rows = db.prepare(`SELECT ${cols} FROM ${table} WHERE ${clause} ORDER BY ts ASC`).all(...params);
  }
  return {
    timeframe: tf,
    total_available: total,
    truncated: total > maxBars,
    candles: rows.map((r) => ({
      time: r.ts,
      open: r.open,
      high: r.high,
      low: r.low,
      close: r.close,
      volume: r.volume,
      volume_available: Boolean(r.volume_available),
      is_partial: Boolean(r.is_partial),
    })),
  };
}

// ---------------------------------------------------------------------------
// Automatic Repository Historical Data Discovery, Sync & Canonical Startup
// ---------------------------------------------------------------------------
const GITHUB_REPO = process.env.IL_GITHUB_REPO || '1prateekanand/IndicatorLab';
const GITHUB_BRANCH = process.env.IL_GITHUB_BRANCH || 'main';

const syncState = {
  state: 'idle', // 'idle' | 'syncing' | 'ready' | 'error'
  phase: null,
  message: null,
  diagnostic: null,
  source: null,
  files_total: 0,
  files_done: 0,
  current_file: null,
  last_checked_at: null,
};

let activeSyncPromise = null;

export function getHistoricalSyncState() {
  return { ...syncState };
}

async function listGitHubHistoricalCsvPaths() {
  const headers = { 'User-Agent': 'IndicatorLab/1.0', Accept: 'application/vnd.github+json' };
  // Fast single-request git tree discovery
  const treeUrl = `https://api.github.com/repos/${GITHUB_REPO}/git/trees/${GITHUB_BRANCH}?recursive=1`;
  const treeRes = await fetch(treeUrl, { headers });
  if (treeRes.ok) {
    const json = await treeRes.json();
    const entries = (json.tree || [])
      .filter((t) => t.type === 'blob' && t.path.startsWith('data/historical/') && t.path.toLowerCase().endsWith('.csv'))
      .map((t) => ({
        relative_path: t.path.slice('data/historical/'.length),
        repo_path: t.path,
        size_bytes: Number(t.size || 0),
        download_url: `https://raw.githubusercontent.com/${GITHUB_REPO}/${GITHUB_BRANCH}/${t.path}`,
      }));
    if (entries.length > 0) {
      entries.sort((a, b) => chronoSortKey(a.relative_path).localeCompare(chronoSortKey(b.relative_path)));
      return entries;
    }
  }

  // Fallback recursive directory listing via contents API
  const collected = [];
  async function walkContents(apiPath) {
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${apiPath}?ref=${GITHUB_BRANCH}`, { headers });
    if (!res.ok) {
      throw new Error(`GitHub API returned HTTP ${res.status} for ${apiPath}`);
    }
    const items = await res.json();
    for (const item of items) {
      if (item.type === 'dir') {
        await walkContents(item.path);
      } else if (item.type === 'file' && item.name.toLowerCase().endsWith('.csv')) {
        collected.push({
          relative_path: item.path.slice('data/historical/'.length),
          repo_path: item.path,
          size_bytes: Number(item.size || 0),
          download_url: item.download_url || `https://raw.githubusercontent.com/${GITHUB_REPO}/${GITHUB_BRANCH}/${item.path}`,
        });
      }
    }
  }
  await walkContents('data/historical');
  collected.sort((a, b) => chronoSortKey(a.relative_path).localeCompare(chronoSortKey(b.relative_path)));
  return collected;
}

async function syncHistoricalCsvsFromRepository() {
  syncState.phase = 'discovering_repository';
  syncState.message = `Discovering committed CSV files in GitHub repository ${GITHUB_REPO}/data/historical/…`;
  const remoteFiles = await listGitHubHistoricalCsvPaths();
  if (!remoteFiles.length) {
    throw new Error(`No historical CSV files were found in repository ${GITHUB_REPO}/data/historical/ or local directory ${HISTORICAL_DIR}.`);
  }

  fs.mkdirSync(HISTORICAL_DIR, { recursive: true });
  syncState.phase = 'downloading';
  syncState.files_total = remoteFiles.length;
  syncState.files_done = 0;

  for (const rf of remoteFiles) {
    const dest = path.join(HISTORICAL_DIR, rf.relative_path);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (fs.existsSync(dest) && fs.statSync(dest).size === rf.size_bytes && rf.size_bytes > 0) {
      syncState.files_done++;
      continue;
    }
    syncState.current_file = rf.relative_path;
    syncState.message = `Downloading ${rf.relative_path} (${syncState.files_done + 1}/${remoteFiles.length})…`;
    const res = await fetch(rf.download_url, { headers: { 'User-Agent': 'IndicatorLab/1.0' } });
    if (!res.ok) {
      throw new Error(`Failed to download ${rf.relative_path} from repository (HTTP ${res.status})`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const tmp = `${dest}.tmp`;
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, dest);
    syncState.files_done++;
  }
  syncState.current_file = null;
}

export function ensureCanonicalHistoricalDataset({ force = false } = {}) {
  if (activeSyncPromise && !force) return activeSyncPromise;

  activeSyncPromise = (async () => {
    syncState.last_checked_at = utcnow();
    syncState.diagnostic = null;
    try {
      let files = discoverHistoricalCsvFiles(HISTORICAL_DIR);
      const existingRaw = db.prepare('SELECT * FROM md_datasets WHERE name = ?').get('NIFTY50_1MIN');

      // Check if local directory already matches a complete DB dataset
      if (!force && files.length > 0 && existingRaw && existingRaw.status === 'complete' && Number(existingRaw.rows) > 0) {
        const sig = computeFilesSignature(files);
        if (existingRaw.source_signature === sig) {
          syncState.state = 'ready';
          syncState.phase = 'cached';
          syncState.source = 'local_sqlite_cache';
          syncState.files_total = files.length;
          syncState.files_done = files.length;
          syncState.message = `NIFTY50_1MIN ready (${Number(existingRaw.rows).toLocaleString()} candles across ${files.length} source files).`;
          return { action: 'cached', dataset: getMarketDataset(existingRaw.id) };
        }
      }

      // If dataset is already complete in SQLite even when local CSVs weren't checked out, use it unless force=true
      if (!force && files.length === 0 && existingRaw && existingRaw.status === 'complete' && Number(existingRaw.rows) > 0) {
        syncState.state = 'ready';
        syncState.phase = 'cached';
        syncState.source = 'sqlite_db';
        syncState.message = `NIFTY50_1MIN ready (${Number(existingRaw.rows).toLocaleString()} candles).`;
        return { action: 'cached', dataset: getMarketDataset(existingRaw.id) };
      }

      syncState.state = 'syncing';
      if (files.length === 0) {
        if (process.env.IL_DISABLE_GITHUB_SYNC === '1') {
          throw new Error(`No historical CSV files found in ${HISTORICAL_DIR} and repository sync is disabled.`);
        }
        await syncHistoricalCsvsFromRepository();
        files = discoverHistoricalCsvFiles(HISTORICAL_DIR);
      }

      if (!files.length) {
        throw new Error(`Repository historical CSV directory '${HISTORICAL_DIR}' contains 0 readable CSV files.`);
      }

      syncState.phase = 'ingesting';
      syncState.files_total = files.length;
      syncState.files_done = 0;
      syncState.message = `Processing ${files.length} CSV file(s) into canonical NIFTY50_1MIN SQLite dataset…`;

      const result = await ingestHistoricalDataset({
        files,
        name: 'NIFTY50_1MIN',
        instrument: 'NIFTY 50 INDEX',
        symbol: 'NIFTY50',
        timeframe: '1m',
        sourceDir: HISTORICAL_DIR,
        replace: true,
      });

      syncState.phase = 'caching_timeframes';
      syncState.message = 'Pre-building NSE session-anchored 5m, 10m, 1H, and 4H timeframe caches…';
      for (const tf of ['5m', '10m', '1H', '4H']) {
        ensureTimeframeCandles(result.dataset.id, tf);
      }

      syncState.state = 'ready';
      syncState.phase = 'complete';
      syncState.source = 'repository_csv';
      syncState.files_done = files.length;
      syncState.message = `Loaded ${result.dataset.rows.toLocaleString()} unique 1m candles from ${files.length} CSV file(s).`;
      return { action: 'ingested', ...result };
    } catch (err) {
      syncState.state = 'error';
      syncState.phase = 'failed';
      syncState.diagnostic = err.message;
      syncState.message = err.message;
      return { action: 'error', diagnostic: err.message };
    } finally {
      activeSyncPromise = null;
    }
  })();

  return activeSyncPromise;
}

