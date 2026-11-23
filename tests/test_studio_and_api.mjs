import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitForHealth(baseUrl, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/api/health`);
      if (res.ok) return await res.json();
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Server at ${baseUrl} did not become healthy within ${timeoutMs}ms`);
}

function startIsolatedServer(dataDir, port) {
  const child = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      HOST: '127.0.0.1',
      PORT: String(port),
      IL_DATA_DIR: dataDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return child;
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      resolve();
    }, 3000);
    child.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

async function apiJson(baseUrl, urlPath, { method = 'GET', body } = {}) {
  const res = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, ok: res.ok, data };
}

const RSI_CODE = `
def compute(df, **params):
    period = int(params.get("period", 14))
    close = df["close"].astype(float)
    delta = close.diff()
    gain = delta.clip(lower=0)
    loss = -delta.clip(upper=0)
    avg_gain = gain.ewm(alpha=1 / period, min_periods=period, adjust=False).mean()
    avg_loss = loss.ewm(alpha=1 / period, min_periods=period, adjust=False).mean()
    rs = avg_gain / avg_loss
    rsi = 100 - (100 / (1 + rs))
    rsi = rsi.mask((avg_loss == 0) & (avg_gain > 0), 100)
    rsi = rsi.mask((avg_loss == 0) & (avg_gain == 0), 50)
    return rsi.fillna(50).tolist()
`;

const RSI_INVERTED_CODE = `
def compute(df, **params):
    period = int(params.get("period", 14))
    close = df["close"].astype(float)
    delta = close.diff()
    gain = delta.clip(lower=0)
    loss = -delta.clip(upper=0)
    avg_gain = gain.ewm(alpha=1 / period, min_periods=period, adjust=False).mean()
    avg_loss = loss.ewm(alpha=1 / period, min_periods=period, adjust=False).mean()
    rs = avg_gain / avg_loss
    rsi = 100 - (100 / (1 + rs))
    rsi = rsi.mask((avg_loss == 0) & (avg_gain > 0), 100)
    rsi = rsi.mask((avg_loss == 0) & (avg_gain == 0), 50)
    return (100.0 - rsi.fillna(50)).tolist()
`;

const MACD_CODE = `
def compute(df, **params):
    close = df["close"].astype(float)
    fast = close.ewm(span=12, adjust=False).mean()
    slow = close.ewm(span=26, adjust=False).mean()
    macd = fast - slow
    signal = macd.ewm(span=9, adjust=False).mean()
    histogram = macd - signal
    return {"macd": macd, "signal": signal, "histogram": histogram}
`;

test('Indicator & Strategy Studio end-to-end API, lifecycle, cache invalidation, and restart persistence', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'il-studio-test-'));
  let port = await getFreePort();
  let baseUrl = `http://127.0.0.1:${port}`;
  let server = startIsolatedServer(tmpDir, port);

  try {
    await waitForHealth(baseUrl);

    // 1. Seed isolated synthetic dataset
    const dsRes = await apiJson(baseUrl, '/api/datasets/synthetic', {
      method: 'POST',
      body: { name: 'SYNTH_TEST', days: 10, seed: 11 },
    });
    assert.equal(dsRes.status, 200);
    const datasetId = dsRes.data.id;

    // 2. Create draft indicator + verify name normalization + 409 duplicate check
    const create1 = await apiJson(baseUrl, '/api/studio/indicators', {
      method: 'POST',
      body: {
        name: 'RSI Alpha',
        version: '1.0.0',
        category: 'Momentum',
        output_type: 'numeric',
        signal_rule: { mode: 'threshold', buy_below: 45, sell_above: 55 },
        params: [{ name: 'period', kind: 'int', default: 14, low: 5, high: 30, step: 1 }],
        code: RSI_CODE,
      },
    });
    assert.equal(create1.status, 200);
    assert.equal(create1.data.name, 'rsi_alpha');
    assert.equal(create1.data.registered, false);
    const rsiId = create1.data.id;

    const dupCreate = await apiJson(baseUrl, '/api/studio/indicators', {
      method: 'POST',
      body: { name: 'rsi-alpha', code: RSI_CODE },
    });
    assert.equal(dupCreate.status, 409);

    // 3. Explicit Update Indicator -> validate -> register numerical RSI
    const upd1 = await apiJson(baseUrl, `/api/studio/indicators/${rsiId}/update`, {
      method: 'POST',
      body: {
        name: 'rsi_alpha',
        version: '1.0.0',
        category: 'Momentum',
        output_type: 'numeric',
        signal_rule: { mode: 'threshold', buy_below: 45, sell_above: 55 },
        params: [{ name: 'period', kind: 'int', default: 14, low: 5, high: 30, step: 1 }],
        code: RSI_CODE,
        dataset_id: datasetId,
      },
    });
    assert.equal(upd1.status, 200, JSON.stringify(upd1.data));
    assert.equal(upd1.data.indicator.registered, true);
    assert.equal(upd1.data.validation.output_type, 'numeric');
    assert.equal(upd1.data.auto_started_optimization, false);
    assert.ok(upd1.data.validation.numeric_stats.value.max <= 100);
    assert.ok(upd1.data.validation.numeric_stats.value.min >= 0);

    // 4. Failed Update MUST preserve previous working registered version
    const brokenUpd = await apiJson(baseUrl, `/api/studio/indicators/${rsiId}/update`, {
      method: 'POST',
      body: {
        name: 'rsi_alpha',
        version: '1.0.1',
        code: 'def compute(df, **p):\n    return [1 / 0] * len(df)\n',
        dataset_id: datasetId,
      },
    });
    assert.equal(brokenUpd.status, 400);
    assert.equal(brokenUpd.data.preserved_working_version, true);
    assert.equal(brokenUpd.data.indicator.registered, true);
    assert.equal(brokenUpd.data.indicator.version, '1.0.0');

    const regAfterFail = await apiJson(baseUrl, '/api/indicators');
    const regRsi = regAfterFail.data.indicators.find((i) => i.id === rsiId);
    assert.equal(regRsi.available, true);
    assert.equal(regRsi.version, '1.0.0');

    // 5. Save Draft on registered indicator keeps working_snapshot active until Update Indicator
    const draftSave = await apiJson(baseUrl, `/api/studio/indicators/${rsiId}`, {
      method: 'PUT',
      body: {
        name: 'rsi_alpha',
        version: '1.0.0',
        output_type: 'numeric',
        signal_rule: { mode: 'threshold', buy_below: 45, sell_above: 55 },
        params: [{ name: 'period', kind: 'int', default: 14, low: 5, high: 30, step: 1 }],
        code: RSI_INVERTED_CODE,
      },
    });
    assert.equal(draftSave.status, 200);
    assert.equal(draftSave.data.has_draft_changes, true);
    assert.equal(draftSave.data.registered, true);
    const activeBeforePromote = await apiJson(baseUrl, '/api/indicators/rsi_alpha');
    assert.ok(activeBeforePromote.data.code.includes('return rsi.fillna(50).tolist()'));

    // Promote back to original RSI_CODE via Update
    const promoteClean = await apiJson(baseUrl, `/api/studio/indicators/${rsiId}/update`, {
      method: 'POST',
      body: {
        name: 'rsi_alpha',
        version: '1.0.0',
        output_type: 'numeric',
        signal_rule: { mode: 'threshold', buy_below: 45, sell_above: 55 },
        params: [{ name: 'period', kind: 'int', default: 14, low: 5, high: 30, step: 1 }],
        code: RSI_CODE,
        dataset_id: datasetId,
      },
    });
    assert.equal(promoteClean.status, 200);
    assert.equal(promoteClean.data.indicator.has_draft_changes, false);

    // 6. Create & update MACD multi-output + Strategy linking both
    const macdDraft = await apiJson(baseUrl, '/api/studio/indicators', {
      method: 'POST',
      body: { name: 'macd_multi', output_type: 'multi', code: MACD_CODE },
    });
    assert.equal(macdDraft.status, 200);
    const macdUpd = await apiJson(baseUrl, `/api/studio/indicators/${macdDraft.data.id}/update`, {
      method: 'POST',
      body: { name: 'macd_multi', output_type: 'multi', code: MACD_CODE, dataset_id: datasetId },
    });
    assert.equal(macdUpd.status, 200);
    assert.equal(macdUpd.data.validation.output_type, 'multi');

    const stratCreate = await apiJson(baseUrl, '/api/studio/strategies', {
      method: 'POST',
      body: {
        name: 'rsi_macd_combo',
        linked_indicators: ['rsi_alpha', 'macd_multi'],
        code: `
def generate_signals(df, indicators, **params):
    rsi = indicators["rsi_alpha"]
    hist = indicators["macd_multi"]["histogram"]
    sigs = []
    for i in range(len(df)):
        r = rsi.iloc[i]
        h = hist.iloc[i]
        if r == r and h == h and r < 45 and h > 0:
            sigs.append(1)
        elif r == r and h == h and r > 55 and h < 0:
            sigs.append(-1)
        else:
            sigs.append(0)
    return sigs
`,
      },
    });
    assert.equal(stratCreate.status, 200);
    const stratUpd = await apiJson(baseUrl, `/api/studio/strategies/${stratCreate.data.id}/update`, {
      method: 'POST',
      body: {
        name: 'rsi_macd_combo',
        linked_indicators: ['rsi_alpha', 'macd_multi'],
        code: stratCreate.data.code,
        dataset_id: datasetId,
      },
    });
    assert.equal(stratUpd.status, 200, JSON.stringify(stratUpd.data));
    assert.equal(stratUpd.data.strategy.registered, true);

    // 7. Rename indicator -> updates linked_indicators and returns code ref warning
    const renameRes = await apiJson(baseUrl, `/api/studio/indicators/${rsiId}/update`, {
      method: 'POST',
      body: {
        name: 'rsi_wilder',
        version: '1.0.0',
        output_type: 'numeric',
        signal_rule: { mode: 'threshold', buy_below: 45, sell_above: 55 },
        params: [{ name: 'period', kind: 'int', default: 14, low: 5, high: 30, step: 1 }],
        code: RSI_CODE,
        dataset_id: datasetId,
      },
    });
    assert.equal(renameRes.status, 200);
    assert.ok(renameRes.data.rename_warnings.length >= 1);
    const stratsAfterRename = await apiJson(baseUrl, '/api/studio/strategies');
    assert.deepEqual(stratsAfterRename.data.items[0].linked_indicators, ['rsi_wilder', 'macd_multi']);

    // 8. Cache invalidation when code changes WITHOUT bumping version
    const bt1 = await apiJson(baseUrl, '/api/backtest', {
      method: 'POST',
      body: {
        dataset_id: datasetId,
        split: 'train',
        timeframe: '5m',
        strategy: { indicators: [{ name: 'rsi_wilder', params: { period: 14 } }], min_votes: 1, direction: 'both' },
      },
    });
    assert.equal(bt1.status, 200, JSON.stringify(bt1.data));

    const sameVerEdit = await apiJson(baseUrl, `/api/studio/indicators/${rsiId}/update`, {
      method: 'POST',
      body: {
        name: 'rsi_wilder',
        version: '1.0.0', // intentionally SAME version!
        output_type: 'numeric',
        signal_rule: { mode: 'threshold', buy_below: 45, sell_above: 55 },
        params: [{ name: 'period', kind: 'int', default: 14, low: 5, high: 30, step: 1 }],
        code: RSI_INVERTED_CODE,
        dataset_id: datasetId,
      },
    });
    assert.equal(sameVerEdit.status, 200);

    const bt2 = await apiJson(baseUrl, '/api/backtest', {
      method: 'POST',
      body: {
        dataset_id: datasetId,
        split: 'train',
        timeframe: '5m',
        strategy: { indicators: [{ name: 'rsi_wilder', params: { period: 14 } }], min_votes: 1, direction: 'both' },
      },
    });
    assert.equal(bt2.status, 200);
    assert.notDeepEqual(bt1.data.metrics, bt2.data.metrics, 'Cache must invalidate when code changes even at identical version');

    // 9. Registry reload produces no duplicates
    const reloadRes = await apiJson(baseUrl, '/api/indicators/reload', { method: 'POST' });
    assert.equal(reloadRes.status, 200);
    assert.equal(reloadRes.data.total, 2);
    assert.equal(reloadRes.data.available, 2);

    // 10. Process restart preserves indicators, strategies, and registered flags
    await stopServer(server);
    port = await getFreePort();
    baseUrl = `http://127.0.0.1:${port}`;
    server = startIsolatedServer(tmpDir, port);
    await waitForHealth(baseUrl);

    const persistedInds = await apiJson(baseUrl, '/api/studio/indicators');
    assert.equal(persistedInds.data.items.length, 2);
    assert.equal(persistedInds.data.registered_count, 2);
    const persistedStrats = await apiJson(baseUrl, '/api/studio/strategies');
    assert.equal(persistedStrats.data.items.length, 1);
    assert.equal(persistedStrats.data.registered_count, 1);
  } finally {
    await stopServer(server);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Sandbox timeout enforcement kills runaway Python loops cleanly', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'il-timeout-test-'));
  process.env.IL_DATA_DIR = tmpDir;
  try {
    const { runPythonSandbox, probeCandles } = await import('../server_engine.js');
    const res = await runPythonSandbox({
      mode: 'indicator',
      code: 'def compute(df, **p):\n    while True:\n        pass\n',
      candles: probeCandles(20),
    }, { timeoutMs: 700, cpuLimitS: 10 });
    assert.equal(res.ok, false);
    assert.equal(res.stage, 'timeout');
    assert.equal(res.error.type, 'TimeoutError');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
