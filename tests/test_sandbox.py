import json
import math
import os
import subprocess
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

import sandbox_runner as sb


def make_candles(n=180):
    candles = []
    price = 22000.0
    for i in range(n):
        # Deterministic oscillating + trending price series
        delta = math.sin(i * 0.27) * 28.0 + math.cos(i * 0.11) * 14.0 + (1.2 if i % 5 else -2.5)
        o = round(price, 4)
        c = round(max(100.0, price + delta), 4)
        h = round(max(o, c) + abs(math.sin(i * 0.4)) * 12.0 + 2.0, 4)
        l = round(min(o, c) - abs(math.cos(i * 0.35)) * 11.0 - 2.0, 4)
        candles.append({
            "time": f"2025-01-{(i // 60) + 1:02d}T{9 + ((15 + i) // 60):02d}:{(15 + i) % 60:02d}:00+05:30",
            "open": o,
            "high": h,
            "low": l,
            "close": c,
            "volume": 1000 + (i * 37) % 5000,
        })
        price = c
    return candles


def ref_sma(vals, period):
    out = [None] * len(vals)
    for i in range(period - 1, len(vals)):
        out[i] = sum(vals[i - period + 1 : i + 1]) / period
    return out


def ref_ema(vals, period, adjust=False):
    alpha = 2.0 / (period + 1.0)
    out = [None] * len(vals)
    if not adjust:
        cur = vals[0]
        out[0] = cur
        for i in range(1, len(vals)):
            cur = alpha * vals[i] + (1.0 - alpha) * cur
            out[i] = cur
        return out
    num = 0.0
    den = 0.0
    for i, v in enumerate(vals):
        num = v + (1.0 - alpha) * num
        den = 1.0 + (1.0 - alpha) * den
        out[i] = num / den
    return out


def ref_wilder_rsi(closes, period=14):
    n = len(closes)
    deltas = [None] + [closes[i] - closes[i - 1] for i in range(1, n)]
    gains = [None if d is None else max(d, 0.0) for d in deltas]
    losses = [None if d is None else max(-d, 0.0) for d in deltas]

    # Pandas ewm(alpha=1/period, min_periods=period, adjust=False) ignoring leading None at index 0
    alpha = 1.0 / period
    def ewm_col(seq):
        out = [None] * n
        cur = None
        count = 0
        for i, v in enumerate(seq):
            if v is None:
                continue
            count += 1
            cur = v if cur is None else alpha * v + (1.0 - alpha) * cur
            if count >= period:
                out[i] = cur
        return out

    ag = ewm_col(gains)
    al = ewm_col(losses)
    out = [None] * n
    for i in range(n):
        if ag[i] is None or al[i] is None:
            continue
        if al[i] == 0.0:
            out[i] = 100.0 if ag[i] > 0.0 else 50.0
        else:
            rs = ag[i] / al[i]
            out[i] = 100.0 - (100.0 / (1.0 + rs))
    return out


def run_subprocess_sandbox(payload, timeout=8):
    proc = subprocess.run(
        ["python3", "-I", os.path.join(ROOT, "sandbox_runner.py")],
        input=json.dumps(payload),
        text=True,
        capture_output=True,
        timeout=timeout,
    )
    return proc


class TestSandboxCompatibilityAndAccuracy(unittest.TestCase):
    def setUp(self):
        self.candles = make_candles(180)
        self.closes = [c["close"] for c in self.candles]

    def test_pandas_ewm_rolling_mask_bitwise_and_dataframe_assign(self):
        code = """
import pandas as pd
import numpy as np

def compute(df, **params):
    df2 = df.copy()
    df2['mid'] = (df2['high'] + df2['low']) / 2.0
    s = df2['close'].diff()
    # Bitwise boolean with leading NaN must NOT evaluate NaN as True
    pos_big = (s > 5.0) & (df2['mid'] > 0)
    neg_or_nan = (~pos_big).astype(float)
    r = df2['close'].rolling(10, min_periods=5).std()
    masked = r.mask(r.isna(), 0.0).where(neg_or_nan >= 0.0, 0.0)
    assert masked.iloc[0] == 0.0
    assert pos_big.iloc[0] is False
    assert len(df2[['open', 'close', 'mid']].columns) == 3
    return masked
"""
        res = sb._run_indicator({"code": code, "candles": self.candles, "return_outputs": True})
        self.assertTrue(res["ok"], res)
        self.assertEqual(res["output_type"], "numeric")
        self.assertEqual(len(res["outputs"]["value"]), len(self.candles))

    def test_numpy_broadcasting_nan_and_math_helpers(self):
        code = """
import numpy as np

def compute(df, **params):
    c = df['close'].to_numpy()
    arr = np.maximum(22000.0, c)
    assert len(arr) == len(c)
    sel = np.select([c > 22050, c < 21950], [1.0, -1.0], default=0.0)
    clean = np.nan_to_num(np.where(sel != 0, np.sqrt(np.abs(c)), np.nan), nan=0.0)
    assert np.isfinite(clean).all()
    assert abs(np.mean([1.0, 2.0, 3.0]) - 2.0) < 1e-9
    assert len(np.diff([1.0, 3.0, 6.0])) == 2
    return clean.tolist()
"""
        res = sb._run_indicator({"code": code, "candles": self.candles, "return_outputs": True})
        self.assertTrue(res["ok"], res)

    def test_sma_ema_accuracy_within_tolerance(self):
        code = """
def compute(df, **params):
    return {
        "sma14": df["close"].rolling(14).mean(),
        "ema12": df["close"].ewm(span=12, adjust=False).mean(),
        "ema12_adj": df["close"].ewm(span=12, adjust=True).mean(),
    }
"""
        res = sb._run_indicator({"code": code, "candles": self.candles, "return_outputs": True})
        self.assertTrue(res["ok"], res)
        self.assertEqual(res["output_type"], "multi")
        expected_sma = ref_sma(self.closes, 14)
        expected_ema = ref_ema(self.closes, 12, adjust=False)
        expected_ema_adj = ref_ema(self.closes, 12, adjust=True)
        for i in range(len(self.candles)):
            if expected_sma[i] is None:
                self.assertIsNone(res["outputs"]["sma14"][i])
            else:
                self.assertAlmostEqual(res["outputs"]["sma14"][i], expected_sma[i], places=5)
            self.assertAlmostEqual(res["outputs"]["ema12"][i], expected_ema[i], places=5)
            self.assertAlmostEqual(res["outputs"]["ema12_adj"][i], expected_ema_adj[i], places=5)

    def test_wilder_rsi_accuracy_and_existing_user_indicators(self):
        with open(os.path.join(ROOT, "data", "studio_state.json"), "r") as f:
            state = json.load(f)
        expected = ref_wilder_rsi(self.closes, 14)
        for ind in state["studioIndicators"]:
            res = sb._run_indicator({
                "code": ind["code"],
                "candles": self.candles,
                "params": {"period": 14},
                "return_outputs": True,
            })
            self.assertTrue(res["ok"], f"{ind['name']} failed: {res}")
            self.assertEqual(res["output_type"], "numeric")
            self.assertTrue(res["causal"])
            vals = res["outputs"]["value"]
            if ind["name"] == "rsi_macd":
                for i in range(14, len(self.candles)):
                    self.assertAlmostEqual(vals[i], expected[i], places=5)

    def test_macd_multi_output_preserves_signal_line_floats(self):
        code = """
def compute(df, **params):
    close = df["close"].astype(float)
    fast = close.ewm(span=12, adjust=False).mean()
    slow = close.ewm(span=26, adjust=False).mean()
    macd = fast - slow
    signal = macd.ewm(span=9, adjust=False).mean()
    hist = macd - signal
    return {"macd": macd, "signal": signal, "histogram": hist}
"""
        res = sb._run_indicator({"code": code, "candles": self.candles, "return_outputs": True})
        self.assertTrue(res["ok"], res)
        self.assertEqual(res["output_type"], "multi")
        self.assertEqual(set(res["output_keys"]), {"macd", "signal", "histogram"})
        # Signal line must retain continuous floats (not collapsed to -1/0/1)
        self.assertTrue(any(abs(v) > 1.5 for v in res["outputs"]["signal"] if v is not None))

    def test_atr_and_bollinger_bands_accuracy(self):
        code = """
import pandas as pd

def compute(df, **params):
    high, low, close = df["high"], df["low"], df["close"]
    prev_close = close.shift(1)
    tr = pd.concat([
        (high - low).abs(),
        (high - prev_close).abs(),
        (low - prev_close).abs(),
    ], axis=1).max(axis=1)
    atr14 = tr.ewm(alpha=1/14, min_periods=14, adjust=False).mean()
    mid = close.rolling(20).mean()
    std = close.rolling(20).std(ddof=0)
    return {
        "atr": atr14,
        "upper": mid + 2.0 * std,
        "middle": mid,
        "lower": mid - 2.0 * std,
    }
"""
        res = sb._run_indicator({"code": code, "candles": self.candles, "return_outputs": True})
        self.assertTrue(res["ok"], res)
        self.assertEqual(res["output_type"], "multi")
        # Spot-check bar 50 Bollinger Bands
        win = self.closes[31:51]
        mu = sum(win) / 20.0
        sd = math.sqrt(sum((x - mu) ** 2 for x in win) / 20.0)
        self.assertAlmostEqual(res["outputs"]["middle"][50], mu, places=5)
        self.assertAlmostEqual(res["outputs"]["upper"][50], mu + 2.0 * sd, places=5)
        self.assertAlmostEqual(res["outputs"]["lower"][50], mu - 2.0 * sd, places=5)

    def test_signal_mode_enforcement_and_conversion_rules(self):
        bad_sig_code = "def compute(df, **params):\n    return df['close']\n"
        bad = sb._run_indicator({"code": bad_sig_code, "candles": self.candles, "output_type": "signal"})
        self.assertFalse(bad["ok"])
        self.assertIn("{-1, 0, 1}", bad["error"]["message"])

        rsi_code = """
def compute(df, **params):
    close = df["close"].astype(float)
    delta = close.diff()
    gain = delta.clip(lower=0)
    loss = -delta.clip(upper=0)
    ag = gain.ewm(alpha=1/14, min_periods=14, adjust=False).mean()
    al = loss.ewm(alpha=1/14, min_periods=14, adjust=False).mean()
    rsi = 100 - (100 / (1 + ag / al))
    return rsi.mask((al == 0) & (ag > 0), 100).mask((al == 0) & (ag == 0), 50)
"""
        res = sb._run_indicator({
            "code": rsi_code,
            "candles": self.candles,
            "output_type": "numeric",
            "signal_rule": {"mode": "threshold", "buy_below": 45, "sell_above": 55},
            "return_signals": True,
        })
        self.assertTrue(res["ok"], res)
        self.assertIn(1, res["signals"])
        self.assertIn(-1, res["signals"])
        for s in res["signals"]:
            self.assertIn(s, (-1, 0, 1))

    def test_lookahead_detection_for_numeric_and_signal(self):
        lookahead_code = """
def compute(df, **params):
    return df["close"].shift(-1) - df["close"]
"""
        res = sb._run_indicator({"code": lookahead_code, "candles": self.candles})
        self.assertTrue(res["ok"], res)
        self.assertFalse(res["causal"])
        self.assertIn("Look-ahead", res["causality_note"])

    def test_strategy_consuming_numeric_and_multi_output_indicators(self):
        rsi_code = """
def compute(df, **params):
    delta = df["close"].diff()
    ag = delta.clip(lower=0).ewm(alpha=1/14, min_periods=14, adjust=False).mean()
    al = (-delta.clip(upper=0)).ewm(alpha=1/14, min_periods=14, adjust=False).mean()
    return 100 - (100 / (1 + ag / al))
"""
        bb_code = """
def compute(df, **params):
    m = df["close"].rolling(20).mean()
    s = df["close"].rolling(20).std()
    return {"upper": m + s, "middle": m, "lower": m - s}
"""
        strat_code = """
def generate_signals(df, indicators, **params):
    rsi = indicators["my_rsi"]
    bb = indicators["my_bb"]
    sigs = []
    exits = []
    for i in range(len(df)):
        r = rsi.iloc[i]
        low_b = bb.lower.iloc[i]
        up_b = bb["upper"].iloc[i]
        c = df["close"].iloc[i]
        if r == r and low_b == low_b and r < 45 and c <= bb.middle.iloc[i]:
            sigs.append(1)
        elif r == r and up_b == up_b and r > 55 and c >= bb.middle.iloc[i]:
            sigs.append(-1)
        else:
            sigs.append(0)
        exits.append(1 if (r == r and 48 < r < 52) else 0)
    return {"signals": sigs, "exit_signals": exits, "stop_loss_pct": 0.4, "target_pct": 0.9}
"""
        res = sb._run_strategy({
            "code": strat_code,
            "candles": self.candles,
            "indicator_codes": [
                {"name": "my_rsi", "code": rsi_code, "output_type": "numeric", "params": {}},
                {"name": "my_bb", "code": bb_code, "output_type": "multi", "params": {}},
            ],
        })
        self.assertTrue(res["ok"], res)
        self.assertEqual(res["bars"], len(self.candles))
        self.assertEqual(res["stop_loss_pct"], 0.4)
        self.assertGreater(res["signal_counts"]["long"] + res["signal_counts"]["short"], 0)

    def test_security_blocks_imports_dunders_and_builtins(self):
        evil_snippets = [
            "import os\ndef compute(df, **p):\n    return [0]*len(df)\n",
            "from subprocess import Popen\ndef compute(df, **p):\n    return [0]*len(df)\n",
            "def compute(df, **p):\n    return open('/etc/passwd').read()\n",
            "def compute(df, **p):\n    x = ().__class__.__bases__[0].__subclasses__()\n    return [0]*len(df)\n",
            "def compute(df, **p):\n    return eval('1+1')\n",
            "def compute(df, **p):\n    return getattr([], '__class__')\n",
        ]
        for code in evil_snippets:
            proc = run_subprocess_sandbox({"mode": "indicator", "code": code, "candles": self.candles[:100]})
            res = json.loads(proc.stdout)
            self.assertFalse(res["ok"], f"Expected failure for: {code}")
            self.assertIn(res["error"]["type"], ("SecurityError", "AttributeError"))

    def test_syntax_runtime_errors_and_resource_limits(self):
        # Syntax error exact line
        syn = run_subprocess_sandbox({
            "mode": "indicator",
            "code": "def compute(df, **p):\n    x = (\n    return [0]*len(df)\n",
            "candles": self.candles[:40],
        })
        syn_res = json.loads(syn.stdout)
        self.assertFalse(syn_res["ok"])
        self.assertEqual(syn_res["stage"], "syntax")
        self.assertEqual(syn_res["error"]["type"], "SyntaxError")

        # Runtime error exact line
        rt = run_subprocess_sandbox({
            "mode": "indicator",
            "code": "def compute(df, **p):\n    a = 1\n    b = a / 0\n    return [0]*len(df)\n",
            "candles": self.candles[:40],
        })
        rt_res = json.loads(rt.stdout)
        self.assertFalse(rt_res["ok"])
        self.assertEqual(rt_res["error"]["type"], "ZeroDivisionError")
        self.assertEqual(rt_res["error"]["line"], 3)

        # Memory limit inside python3 -I
        mem = run_subprocess_sandbox({
            "mode": "indicator",
            "code": "def compute(df, **p):\n    big = [0] * 100_000_000\n    return [0]*len(df)\n",
            "candles": self.candles[:40],
            "mem_limit_mb": 256,
        })
        mem_res = json.loads(mem.stdout)
        self.assertFalse(mem_res["ok"])
        self.assertEqual(mem_res["error"]["type"], "MemoryError")

        # Infinite loop caught by CPU limit
        cpu = run_subprocess_sandbox({
            "mode": "indicator",
            "code": "def compute(df, **p):\n    while True:\n        pass\n",
            "candles": self.candles[:40],
            "cpu_limit_s": 1,
        }, timeout=6)
        self.assertTrue(cpu.returncode != 0 or not json.loads(cpu.stdout)["ok"])


if __name__ == "__main__":
    unittest.main()
