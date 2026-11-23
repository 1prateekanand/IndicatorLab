"""Isolated Python 3.11 sandbox for validating and executing user-written indicators and strategies.

Runs in `python3 -I` (isolated mode) as a separate child process with CPU & memory limits.
Provides a pure-Python Pandas/NumPy-compatible API (`pd`, `np`) plus built-in technical
helpers (`crossover`, `crossunder`, `sma`, `ema`, `rma`) so vectorized indicators and
strategies work reliably without external binary dependencies, while maintaining strict AST
and runtime sandboxing.

Supported compatibility scope (documented, not exaggerated):
- `pd.Series`: rolling(window, min_periods, center) [.mean, .sum, .min, .max, .std, .var, .median,
  .quantile, .count, .apply, .corr, .cov], ewm(com, span, halflife, alpha, min_periods, adjust,
  ignore_na) [.mean, .std, .var], shift, diff, pct_change, clip, abs, round, fillna, ffill, bfill,
  dropna, replace, where, mask, isna/isnull/notna/notnull, cumsum/cumprod/cummax/cummin, astype,
  head, tail, copy, apply, map, between, rank, mean, std, var, sum, min, max, median, quantile,
  tolist/to_list/to_numpy, iloc, loc, elementwise arithmetic (+, -, *, /, //, %, **), comparisons,
  and NaN-safe bitwise boolean logic (&, |, ^, ~).
- `pd.DataFrame`: OHLCV columns, column assignment `df[col] = ...`, multi-column slice `df[[...]]`,
  assign, copy, dropna, fillna, head, tail, isna/notna, shift, diff, rolling, apply, iloc, to_records.
- `np`: nan, inf, pi, e, float64/float32/int64/int32/int8/bool_, array/asarray, zeros, ones, full,
  empty, arange, linspace, where, select, clip, abs/fabs, sign, round, maximum/minimum, fmax/fmin,
  sqrt, exp, log, log10, log2, power, square, sin/cos/tan/tanh/arctan, isnan/isinf/isfinite,
  nan_to_num, mean, std, var, sum, prod, min, max, nanmean/nanstd/nanmin/nanmax/nansum, median,
  percentile, quantile, diff, roll, cumsum, argmax, argmin, corrcoef.
- Unsupported: C-extension pandas internals (MultiIndex, GroupBy-merge-join, DatetimeIndex resampling,
  complex ndarray broadcasting >1D), filesystem I/O, networking, OS/process calls, and third-party C libs.
"""
from __future__ import annotations

import ast
import bisect
import builtins
import datetime as _dt
import json
import math
import statistics
import sys
import time
import traceback

try:
    import resource
except ImportError:
    resource = None


SAFE_MODULES = {
    "pandas",
    "numpy",
    "math",
    "statistics",
    "collections",
    "itertools",
    "functools",
    "datetime",
    "re",
    "json",
    "decimal",
    "fractions",
    "typing",
    "dataclasses",
    "enum",
    "indicatorlab",
}

BANNED_CALLS = {
    "eval", "exec", "compile", "__import__", "open", "input",
    "breakpoint", "globals", "locals", "vars", "dir", "memoryview",
}

BANNED_DUNDER_ATTRS = {
    "__class__", "__bases__", "__base__", "__mro__", "__subclasses__",
    "__globals__", "__locals__", "__builtins__", "__import__", "__code__",
    "__closure__", "__dict__", "__getattribute__", "__setattr__", "__delattr__",
    "__reduce__", "__reduce_ex__", "__loader__", "__spec__", "__init_subclass__",
}


def apply_resource_limits(cpu_seconds: int = 5, mem_mb: int = 256) -> None:
    if resource is None:
        return
    try:
        if cpu_seconds and cpu_seconds > 0:
            lim = int(cpu_seconds)
            resource.setrlimit(resource.RLIMIT_CPU, (lim, lim))
    except Exception:
        pass
    try:
        if mem_mb and mem_mb > 0:
            limit = int(mem_mb) * 1024 * 1024
            _soft, hard = resource.getrlimit(resource.RLIMIT_AS)
            target = limit if hard == resource.RLIM_INFINITY else min(limit, hard)
            resource.setrlimit(resource.RLIMIT_AS, (target, hard))
    except Exception:
        pass


def check_ast_safety(code: str) -> tuple[bool, dict | None]:
    try:
        tree = ast.parse(code)
    except SyntaxError as exc:
        return False, {
            "type": type(exc).__name__,
            "line": exc.lineno or 1,
            "column": exc.offset or 1,
            "message": exc.msg or str(exc),
            "text": (exc.text or "").rstrip("\n"),
        }

    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                root_mod = alias.name.split(".")[0]
                if root_mod not in SAFE_MODULES:
                    return False, {
                        "type": "SecurityError",
                        "line": getattr(node, "lineno", 1),
                        "column": getattr(node, "col_offset", 0) + 1,
                        "message": f"Import of '{alias.name}' is not allowed inside the isolated sandbox. Allowed modules: {', '.join(sorted(SAFE_MODULES))}.",
                    }
        elif isinstance(node, ast.ImportFrom):
            mod = (node.module or "").split(".")[0]
            if not mod or mod not in SAFE_MODULES:
                return False, {
                    "type": "SecurityError",
                    "line": getattr(node, "lineno", 1),
                    "column": getattr(node, "col_offset", 0) + 1,
                    "message": f"Import from '{node.module}' is not allowed inside the isolated sandbox.",
                }
        elif isinstance(node, ast.Attribute):
            if node.attr in BANNED_DUNDER_ATTRS:
                return False, {
                    "type": "SecurityError",
                    "line": getattr(node, "lineno", 1),
                    "column": getattr(node, "col_offset", 0) + 1,
                    "message": f"Access to internal attribute '{node.attr}' is blocked inside the sandbox.",
                }
        elif isinstance(node, ast.Call):
            if isinstance(node.func, ast.Name) and node.func.id in BANNED_CALLS:
                return False, {
                    "type": "SecurityError",
                    "line": getattr(node, "lineno", 1),
                    "column": getattr(node, "col_offset", 0) + 1,
                    "message": f"Call to '{node.func.id}()' is blocked inside the isolated sandbox.",
                }
    return True, None


# ---------------------------------------------------------------------------
# Pure-Python Pandas / NumPy compatibility layer
# ---------------------------------------------------------------------------
def _is_nan(v) -> bool:
    return v is None or (isinstance(v, float) and math.isnan(v))


def _is_inf(v) -> bool:
    return isinstance(v, float) and math.isinf(v)


def _is_missing(v) -> bool:
    return v is None or (isinstance(v, float) and math.isnan(v))


def _is_finite(v) -> bool:
    if v is None or isinstance(v, str):
        return False
    if isinstance(v, bool):
        return True
    try:
        return math.isfinite(float(v))
    except (TypeError, ValueError):
        return False


def _to_float(v) -> float:
    if v is None:
        return math.nan
    if isinstance(v, bool):
        return 1.0 if v else 0.0
    if isinstance(v, (int, float)):
        return float(v)
    try:
        return float(v)
    except (TypeError, ValueError):
        return math.nan


def _to_bool(v) -> bool:
    if v is None:
        return False
    if isinstance(v, float) and math.isnan(v):
        return False
    return bool(v)


def _quantile_sorted(sorted_vals: list[float], q: float) -> float:
    n = len(sorted_vals)
    if n == 0:
        return math.nan
    if n == 1:
        return sorted_vals[0]
    pos = max(0.0, min(1.0, float(q))) * (n - 1)
    lo = int(math.floor(pos))
    hi = int(math.ceil(pos))
    if lo == hi:
        return sorted_vals[lo]
    frac = pos - lo
    return sorted_vals[lo] * (1.0 - frac) + sorted_vals[hi] * frac


def _series_vals(obj, n: int | None = None) -> list:
    if isinstance(obj, Series):
        vals = obj._data
        if n is not None and len(vals) != n:
            raise ValueError(f"Length mismatch: expected {n}, got {len(vals)}")
        return vals
    if isinstance(obj, (list, tuple)):
        vals = list(obj)
        if n is not None and len(vals) != n:
            raise ValueError(f"Length mismatch: expected {n}, got {len(vals)}")
        return vals
    if n is None:
        return [obj]
    return [obj] * n


class _ILocSeriesIndexer:
    def __init__(self, series: "Series"):
        self._s = series

    def __getitem__(self, key):
        if isinstance(key, slice):
            return Series(self._s._data[key], index=self._s.index[key])
        if isinstance(key, Series):
            return Series(
                [v for v, keep in zip(self._s._data, key._data) if _to_bool(keep)],
                index=[ix for ix, keep in zip(self._s.index, key._data) if _to_bool(keep)],
            )
        if isinstance(key, (list, tuple)):
            return Series(
                [self._s._data[int(i)] for i in key],
                index=[self._s.index[int(i)] for i in key],
            )
        return self._s._data[int(key)]

    def __setitem__(self, key, value):
        self._s.__setitem__(key, value)


class _LocSeriesIndexer:
    def __init__(self, series: "Series"):
        self._s = series

    def __getitem__(self, key):
        if isinstance(key, Series):
            return self._s[key]
        if isinstance(key, (list, tuple)) and len(key) == len(self._s._data) and all(isinstance(x, bool) for x in key):
            return Series(
                [v for v, keep in zip(self._s._data, key) if keep],
                index=[ix for ix, keep in zip(self._s.index, key) if keep],
            )
        pos_map = {ix: i for i, ix in enumerate(self._s.index)}
        if isinstance(key, (list, tuple)):
            return Series([self._s._data[pos_map[k]] for k in key], index=list(key))
        return self._s._data[pos_map[key]]


class _Rolling:
    def __init__(self, series: "Series", window: int, min_periods: int | None = None, center: bool = False):
        w = int(window)
        if w < 1:
            raise ValueError("window must be an integer >= 1")
        self._s = series
        self._data = series._data
        self._w = w
        if min_periods is None:
            self._min_periods = w
        else:
            mp = int(min_periods)
            if mp < 0:
                raise ValueError("min_periods must be >= 0")
            if mp > w:
                raise ValueError(f"min_periods {mp} must be <= window {w}")
            self._min_periods = max(1, mp)
        self._center = bool(center)

    def _window_bounds(self, i: int, n: int) -> tuple[int, int]:
        w = self._w
        if self._center:
            half_left = (w - 1) // 2
            half_right = w - 1 - half_left
            return max(0, i - half_left), min(n, i + half_right + 1)
        return max(0, i - w + 1), i + 1

    def count(self) -> "Series":
        d = self._data
        n = len(d)
        fvals = [_to_float(x) for x in d]
        is_ok = [1 if math.isfinite(v) else 0 for v in fvals]
        out = [0.0] * n
        if not self._center:
            running = 0
            w = self._w
            for i in range(n):
                running += is_ok[i]
                if i >= w:
                    running -= is_ok[i - w]
                out[i] = float(running)
        else:
            for i in range(n):
                a, b = self._window_bounds(i, n)
                out[i] = float(sum(is_ok[a:b]))
        return Series(out, index=self._s.index)

    def sum(self) -> "Series":
        d = self._data
        n = len(d)
        w = self._w
        mp = self._min_periods
        fvals = [_to_float(x) for x in d]
        if not self._center:
            out = [math.nan] * n
            running = 0.0
            valid_cnt = 0
            inf_cnt = 0
            for i in range(n):
                v = fvals[i]
                if math.isfinite(v):
                    running += v
                    valid_cnt += 1
                elif _is_inf(v):
                    inf_cnt += 1
                if i >= w:
                    old = fvals[i - w]
                    if math.isfinite(old):
                        running -= old
                        valid_cnt -= 1
                    elif _is_inf(old):
                        inf_cnt -= 1
                if valid_cnt >= mp and inf_cnt == 0:
                    # Periodically re-center to avoid float drift on large series
                    if i % 512 == 0 and valid_cnt > 0:
                        a = max(0, i - w + 1)
                        running = sum(fvals[j] for j in range(a, i + 1) if math.isfinite(fvals[j]))
                    out[i] = running
            return Series(out, index=self._s.index)
        out = []
        for i in range(n):
            a, b = self._window_bounds(i, n)
            chunk = [fvals[j] for j in range(a, b) if not math.isnan(fvals[j])]
            out.append(sum(chunk) if len(chunk) >= mp else math.nan)
        return Series(out, index=self._s.index)

    def mean(self) -> "Series":
        d = self._data
        n = len(d)
        w = self._w
        mp = self._min_periods
        fvals = [_to_float(x) for x in d]
        if not self._center:
            out = [math.nan] * n
            running = 0.0
            valid_cnt = 0
            inf_cnt = 0
            for i in range(n):
                v = fvals[i]
                if math.isfinite(v):
                    running += v
                    valid_cnt += 1
                elif _is_inf(v):
                    inf_cnt += 1
                if i >= w:
                    old = fvals[i - w]
                    if math.isfinite(old):
                        running -= old
                        valid_cnt -= 1
                    elif _is_inf(old):
                        inf_cnt -= 1
                if valid_cnt >= mp and inf_cnt == 0:
                    if i % 512 == 0 and valid_cnt > 0:
                        a = max(0, i - w + 1)
                        running = sum(fvals[j] for j in range(a, i + 1) if math.isfinite(fvals[j]))
                    out[i] = running / valid_cnt
            return Series(out, index=self._s.index)
        out = []
        for i in range(n):
            a, b = self._window_bounds(i, n)
            chunk = [fvals[j] for j in range(a, b) if math.isfinite(fvals[j])]
            out.append(sum(chunk) / len(chunk) if len(chunk) >= mp else math.nan)
        return Series(out, index=self._s.index)

    def min(self) -> "Series":
        d = self._data
        n = len(d)
        w = self._w
        mp = self._min_periods
        fvals = [_to_float(x) for x in d]
        if not self._center:
            from collections import deque
            dq = deque()
            valid_cnt = 0
            out = [math.nan] * n
            for i in range(n):
                v = fvals[i]
                if not math.isnan(v):
                    valid_cnt += 1
                    while dq and fvals[dq[-1]] >= v:
                        dq.pop()
                    dq.append(i)
                if i >= w:
                    if not math.isnan(fvals[i - w]):
                        valid_cnt -= 1
                    if dq and dq[0] <= i - w:
                        dq.popleft()
                if valid_cnt >= mp and dq:
                    out[i] = fvals[dq[0]]
            return Series(out, index=self._s.index)
        out = []
        for i in range(n):
            a, b = self._window_bounds(i, n)
            chunk = [fvals[j] for j in range(a, b) if not math.isnan(fvals[j])]
            out.append(min(chunk) if len(chunk) >= mp else math.nan)
        return Series(out, index=self._s.index)

    def max(self) -> "Series":
        d = self._data
        n = len(d)
        w = self._w
        mp = self._min_periods
        fvals = [_to_float(x) for x in d]
        if not self._center:
            from collections import deque
            dq = deque()
            valid_cnt = 0
            out = [math.nan] * n
            for i in range(n):
                v = fvals[i]
                if not math.isnan(v):
                    valid_cnt += 1
                    while dq and fvals[dq[-1]] <= v:
                        dq.pop()
                    dq.append(i)
                if i >= w:
                    if not math.isnan(fvals[i - w]):
                        valid_cnt -= 1
                    if dq and dq[0] <= i - w:
                        dq.popleft()
                if valid_cnt >= mp and dq:
                    out[i] = fvals[dq[0]]
            return Series(out, index=self._s.index)
        out = []
        for i in range(n):
            a, b = self._window_bounds(i, n)
            chunk = [fvals[j] for j in range(a, b) if not math.isnan(fvals[j])]
            out.append(max(chunk) if len(chunk) >= mp else math.nan)
        return Series(out, index=self._s.index)

    def var(self, ddof: int = 1) -> "Series":
        d = self._data
        n = len(d)
        mp = self._min_periods
        fvals = [_to_float(x) for x in d]
        # Shifted-anchor O(n) sliding variance when trailing, immune to catastrophic cancellation
        if not self._center and n > 0:
            anchor = next((x for x in fvals if math.isfinite(x)), 0.0)
            w = self._w
            out = [math.nan] * n
            s1 = 0.0
            s2 = 0.0
            cnt = 0
            inf_cnt = 0
            for i in range(n):
                v = fvals[i]
                if math.isfinite(v):
                    dv = v - anchor
                    s1 += dv
                    s2 += dv * dv
                    cnt += 1
                elif _is_inf(v):
                    inf_cnt += 1
                if i >= w:
                    old = fvals[i - w]
                    if math.isfinite(old):
                        do = old - anchor
                        s1 -= do
                        s2 -= do * do
                        cnt -= 1
                    elif _is_inf(old):
                        inf_cnt -= 1
                if cnt >= mp and (cnt - ddof) > 0 and inf_cnt == 0:
                    if i % 256 == 0:
                        a = max(0, i - w + 1)
                        chunk = [fvals[j] for j in range(a, i + 1) if math.isfinite(fvals[j])]
                        mu = sum(chunk) / len(chunk)
                        out[i] = max(0.0, sum((x - mu) ** 2 for x in chunk) / (len(chunk) - ddof))
                    else:
                        var_num = s2 - (s1 * s1) / cnt
                        out[i] = max(0.0, var_num / (cnt - ddof))
            return Series(out, index=self._s.index)
        out = []
        for i in range(n):
            a, b = self._window_bounds(i, n)
            chunk = [fvals[j] for j in range(a, b) if math.isfinite(fvals[j])]
            k = len(chunk)
            if k < mp or k - ddof <= 0:
                out.append(math.nan)
            else:
                mu = sum(chunk) / k
                out.append(max(0.0, sum((x - mu) ** 2 for x in chunk) / (k - ddof)))
        return Series(out, index=self._s.index)

    def std(self, ddof: int = 1) -> "Series":
        v = self.var(ddof=ddof)
        return Series([math.sqrt(x) if not math.isnan(x) else math.nan for x in v._data], index=self._s.index)

    def median(self) -> "Series":
        d = self._data
        n = len(d)
        mp = self._min_periods
        fvals = [_to_float(x) for x in d]
        out = []
        for i in range(n):
            a, b = self._window_bounds(i, n)
            chunk = sorted(fvals[j] for j in range(a, b) if not math.isnan(fvals[j]))
            if len(chunk) < mp:
                out.append(math.nan)
            else:
                out.append(_quantile_sorted(chunk, 0.5))
        return Series(out, index=self._s.index)

    def quantile(self, q: float = 0.5) -> "Series":
        d = self._data
        n = len(d)
        mp = self._min_periods
        fvals = [_to_float(x) for x in d]
        out = []
        for i in range(n):
            a, b = self._window_bounds(i, n)
            chunk = sorted(fvals[j] for j in range(a, b) if not math.isnan(fvals[j]))
            out.append(_quantile_sorted(chunk, q) if len(chunk) >= mp else math.nan)
        return Series(out, index=self._s.index)

    def apply(self, func, raw: bool = False) -> "Series":
        d = self._data
        n = len(d)
        mp = self._min_periods
        out = []
        for i in range(n):
            a, b = self._window_bounds(i, n)
            sl = d[a:b]
            valid = sum(1 for x in sl if not _is_nan(x))
            if valid < mp:
                out.append(math.nan)
            else:
                arg = sl if raw else Series(sl, index=self._s.index[a:b])
                out.append(func(arg))
        return Series(out, index=self._s.index)

    def cov(self, other: "Series", ddof: int = 1) -> "Series":
        o_vals = _series_vals(other, len(self._data))
        n = len(self._data)
        mp = self._min_periods
        xvals = [_to_float(x) for x in self._data]
        yvals = [_to_float(y) for y in o_vals]
        out = []
        for i in range(n):
            a, b = self._window_bounds(i, n)
            pairs = [(xvals[j], yvals[j]) for j in range(a, b) if math.isfinite(xvals[j]) and math.isfinite(yvals[j])]
            k = len(pairs)
            if k < mp or k - ddof <= 0:
                out.append(math.nan)
            else:
                mx = sum(p[0] for p in pairs) / k
                my = sum(p[1] for p in pairs) / k
                out.append(sum((p[0] - mx) * (p[1] - my) for p in pairs) / (k - ddof))
        return Series(out, index=self._s.index)

    def corr(self, other: "Series") -> "Series":
        o_vals = _series_vals(other, len(self._data))
        n = len(self._data)
        mp = self._min_periods
        xvals = [_to_float(x) for x in self._data]
        yvals = [_to_float(y) for y in o_vals]
        out = []
        for i in range(n):
            a, b = self._window_bounds(i, n)
            pairs = [(xvals[j], yvals[j]) for j in range(a, b) if math.isfinite(xvals[j]) and math.isfinite(yvals[j])]
            k = len(pairs)
            if k < mp or k < 2:
                out.append(math.nan)
            else:
                mx = sum(p[0] for p in pairs) / k
                my = sum(p[1] for p in pairs) / k
                vx = sum((p[0] - mx) ** 2 for p in pairs)
                vy = sum((p[1] - my) ** 2 for p in pairs)
                denom = math.sqrt(vx * vy)
                out.append(sum((p[0] - mx) * (p[1] - my) for p in pairs) / denom if denom > 0 else math.nan)
        return Series(out, index=self._s.index)


class _EWM:
    def __init__(
        self,
        series: "Series",
        com: float | None = None,
        span: float | None = None,
        halflife: float | None = None,
        alpha: float | None = None,
        min_periods: int = 0,
        adjust: bool = True,
        ignore_na: bool = False,
    ):
        self._s = series
        self._data = series._data
        specified = sum(x is not None for x in (com, span, halflife, alpha))
        if specified == 0:
            raise ValueError("Must pass one of com, span, halflife, or alpha to ewm()")
        if specified > 1:
            raise ValueError("com, span, halflife, and alpha are mutually exclusive")
        if alpha is not None:
            a = float(alpha)
            if not (0.0 < a <= 1.0):
                raise ValueError(f"alpha must satisfy 0 < alpha <= 1, got {alpha}")
            self._alpha = a
        elif span is not None:
            sp = float(span)
            if sp < 1.0:
                raise ValueError(f"span must be >= 1, got {span}")
            self._alpha = 2.0 / (sp + 1.0)
        elif com is not None:
            c = float(com)
            if c < 0.0:
                raise ValueError(f"com must be >= 0, got {com}")
            self._alpha = 1.0 / (1.0 + c)
        else:
            hl = float(halflife)
            if hl <= 0.0:
                raise ValueError(f"halflife must be > 0, got {halflife}")
            self._alpha = 1.0 - math.exp(-math.log(2.0) / hl)
        self._min_periods = max(0, int(min_periods))
        self._adjust = bool(adjust)
        self._ignore_na = bool(ignore_na)

    def mean(self) -> "Series":
        a = self._alpha
        one_minus_a = 1.0 - a
        mp = max(1, self._min_periods)
        out = []
        valid_count = 0

        if not self._adjust:
            prev = None
            na_gap = 0
            for raw in self._data:
                v = _to_float(raw)
                if math.isnan(v):
                    if prev is None:
                        out.append(math.nan)
                    else:
                        if not self._ignore_na:
                            na_gap += 1
                        out.append(prev if valid_count >= mp else math.nan)
                    continue
                valid_count += 1
                if prev is None:
                    prev = v
                else:
                    if not self._ignore_na and na_gap > 0:
                        decay = one_minus_a ** (na_gap + 1)
                        prev = (1.0 - decay) * v + decay * prev if a == 1.0 else (a * v + one_minus_a * (one_minus_a ** na_gap) * prev) / (a + one_minus_a * (one_minus_a ** na_gap))
                    else:
                        prev = a * v + one_minus_a * prev
                na_gap = 0
                out.append(prev if valid_count >= mp else math.nan)
            return Series(out, index=self._s.index)

        # adjust=True exact pandas weighted average recursion
        num = 0.0
        den = 0.0
        prev_out = math.nan
        for raw in self._data:
            v = _to_float(raw)
            if math.isnan(v):
                if not self._ignore_na and den > 0.0:
                    num *= one_minus_a
                    den *= one_minus_a
                out.append(prev_out if valid_count >= mp else math.nan)
                continue
            valid_count += 1
            num = v + one_minus_a * num
            den = 1.0 + one_minus_a * den
            prev_out = num / den if den > 0 else math.nan
            out.append(prev_out if valid_count >= mp else math.nan)
        return Series(out, index=self._s.index)

    def var(self, bias: bool = False) -> "Series":
        a = self._alpha
        one_minus_a = 1.0 - a
        mp = max(1 if bias else 2, self._min_periods)
        out = []
        mean_val = None
        var_val = 0.0
        sum_w = 0.0
        sum_w2 = 0.0
        valid_count = 0

        for raw in self._data:
            v = _to_float(raw)
            if math.isnan(v):
                out.append(math.nan)
                continue
            valid_count += 1
            if mean_val is None:
                mean_val = v
                var_val = 0.0
                sum_w = 1.0
                sum_w2 = 1.0
            else:
                if self._adjust:
                    sum_w = 1.0 + one_minus_a * sum_w
                    sum_w2 = 1.0 + (one_minus_a * one_minus_a) * sum_w2
                    w = 1.0 / sum_w
                    diff = v - mean_val
                    incr = w * diff
                    mean_val = mean_val + incr
                    var_val = (1.0 - w) * (var_val + diff * incr)
                else:
                    sum_w = a + one_minus_a * sum_w
                    sum_w2 = (a * a) + (one_minus_a * one_minus_a) * sum_w2
                    diff = v - mean_val
                    incr = a * diff
                    mean_val = mean_val + incr
                    var_val = one_minus_a * (var_val + diff * incr)
            if valid_count < mp:
                out.append(math.nan)
            elif bias:
                out.append(max(0.0, var_val))
            else:
                denom = (sum_w * sum_w) - sum_w2
                corr = (sum_w * sum_w) / denom if denom > 1e-15 else math.nan
                out.append(max(0.0, var_val * corr) if not math.isnan(corr) else math.nan)
        return Series(out, index=self._s.index)

    def std(self, bias: bool = False) -> "Series":
        v = self.var(bias=bias)
        return Series([math.sqrt(x) if not math.isnan(x) else math.nan for x in v._data], index=self._s.index)


class Series:
    def __init__(self, data, index=None, dtype=None, name=None):
        if isinstance(data, Series):
            vals = list(data._data)
            idx = list(index) if index is not None else list(data.index)
            name = name if name is not None else data.name
        elif isinstance(data, dict):
            if index is not None:
                idx = list(index)
                vals = [data.get(k, math.nan) for k in idx]
            else:
                idx = list(data.keys())
                vals = list(data.values())
        elif isinstance(data, (list, tuple)):
            vals = list(data)
            idx = list(index) if index is not None else list(range(len(vals)))
        elif isinstance(data, (int, float, bool, str)) or data is None:
            n = len(index) if index is not None else 1
            vals = [data] * n
            idx = list(index) if index is not None else list(range(n))
        else:
            vals = list(data)
            idx = list(index) if index is not None else list(range(len(vals)))

        if len(idx) != len(vals):
            raise ValueError(f"Length of values ({len(vals)}) does not match length of index ({len(idx)})")

        self._data = vals
        self.index = idx
        self.name = name

        if dtype is not None:
            converted = self.astype(dtype)
            self._data = converted._data

    def __len__(self) -> int:
        return len(self._data)

    def __iter__(self):
        return iter(self._data)

    def __repr__(self) -> str:
        head = self._data[:8]
        suffix = ", ..." if len(self._data) > 8 else ""
        return f"Series({head!r}{suffix}, len={len(self._data)})"

    @property
    def values(self) -> list:
        return list(self._data)

    @property
    def shape(self) -> tuple[int]:
        return (len(self._data),)

    @property
    def size(self) -> int:
        return len(self._data)

    @property
    def ndim(self) -> int:
        return 1

    @property
    def empty(self) -> bool:
        return len(self._data) == 0

    @property
    def iloc(self) -> _ILocSeriesIndexer:
        return _ILocSeriesIndexer(self)

    @property
    def loc(self) -> _LocSeriesIndexer:
        return _LocSeriesIndexer(self)

    def __getitem__(self, item):
        if isinstance(item, slice):
            return Series(self._data[item], index=self.index[item], name=self.name)
        if isinstance(item, Series):
            return Series(
                [v for v, keep in zip(self._data, item._data) if _to_bool(keep)],
                index=[ix for ix, keep in zip(self.index, item._data) if _to_bool(keep)],
                name=self.name,
            )
        if isinstance(item, (list, tuple)):
            if len(item) == len(self._data) and all(isinstance(x, bool) for x in item):
                return Series(
                    [v for v, keep in zip(self._data, item) if keep],
                    index=[ix for ix, keep in zip(self.index, item) if keep],
                    name=self.name,
                )
            return Series([self._data[int(i)] for i in item], index=[self.index[int(i)] for i in item], name=self.name)
        return self._data[item]

    def __setitem__(self, key, value):
        if isinstance(key, Series):
            mask = key._data
            if isinstance(value, Series):
                for i, (keep, v) in enumerate(zip(mask, value._data)):
                    if _to_bool(keep) and i < len(self._data):
                        self._data[i] = v
            elif isinstance(value, (list, tuple)):
                for i, (keep, v) in enumerate(zip(mask, value)):
                    if _to_bool(keep) and i < len(self._data):
                        self._data[i] = v
            else:
                for i, keep in enumerate(mask):
                    if _to_bool(keep) and i < len(self._data):
                        self._data[i] = value
            return
        if isinstance(key, slice):
            indices = range(*key.indices(len(self._data)))
            if isinstance(value, (Series, list, tuple)):
                vlist = value._data if isinstance(value, Series) else list(value)
                for pos, idx_val in enumerate(indices):
                    if pos < len(vlist):
                        self._data[idx_val] = vlist[pos]
            else:
                for idx_val in indices:
                    self._data[idx_val] = value
            return
        if isinstance(key, (list, tuple)):
            if len(key) == len(self._data) and all(isinstance(x, bool) for x in key):
                for i, keep in enumerate(key):
                    if keep and i < len(self._data):
                        self._data[i] = value._data[i] if isinstance(value, Series) else value
            else:
                vlist = value._data if isinstance(value, Series) else (list(value) if isinstance(value, (list, tuple)) else None)
                for pos, idx_val in enumerate(key):
                    self._data[int(idx_val)] = vlist[pos] if vlist is not None else value
            return
        self._data[int(key)] = value

    def copy(self) -> "Series":
        return Series(list(self._data), index=list(self.index), name=self.name)

    def head(self, n: int = 5) -> "Series":
        k = max(0, int(n))
        return Series(self._data[:k], index=self.index[:k], name=self.name)

    def tail(self, n: int = 5) -> "Series":
        k = max(0, int(n))
        if k == 0:
            return Series([], index=[], name=self.name)
        return Series(self._data[-k:], index=self.index[-k:], name=self.name)

    def tolist(self) -> list:
        return list(self._data)

    def to_list(self) -> list:
        return list(self._data)

    def to_numpy(self, dtype=None) -> "Series":
        return self.astype(dtype) if dtype is not None else self.copy()

    def rolling(self, window: int, min_periods: int | None = None, center: bool = False) -> _Rolling:
        return _Rolling(self, window, min_periods=min_periods, center=center)

    def ewm(
        self,
        com: float | None = None,
        span: float | None = None,
        halflife: float | None = None,
        alpha: float | None = None,
        min_periods: int = 0,
        adjust: bool = True,
        ignore_na: bool = False,
    ) -> _EWM:
        return _EWM(
            self,
            com=com,
            span=span,
            halflife=halflife,
            alpha=alpha,
            min_periods=min_periods,
            adjust=adjust,
            ignore_na=ignore_na,
        )

    def shift(self, periods: int = 1, fill_value=math.nan) -> "Series":
        p = int(periods)
        n = len(self._data)
        if p == 0:
            return Series(list(self._data), index=self.index, name=self.name)
        if p > 0:
            k = min(p, n)
            return Series([fill_value] * k + self._data[:max(0, n - p)], index=self.index, name=self.name)
        k = min(-p, n)
        return Series(self._data[k:] + [fill_value] * k, index=self.index, name=self.name)

    def diff(self, periods: int = 1) -> "Series":
        return self - self.shift(periods)

    def pct_change(self, periods: int = 1) -> "Series":
        prev = self.shift(periods)
        out = []
        for a, b in zip(self._data, prev._data):
            fa, fb = _to_float(a), _to_float(b)
            if math.isnan(fa) or math.isnan(fb):
                out.append(math.nan)
            elif fb == 0.0:
                out.append(math.nan if fa == 0.0 else (math.inf if fa > 0 else -math.inf))
            else:
                out.append((fa - fb) / fb)
        return Series(out, index=self.index, name=self.name)

    def clip(self, lower=None, upper=None) -> "Series":
        lo_list = _series_vals(lower, len(self._data)) if isinstance(lower, (Series, list, tuple)) else None
        hi_list = _series_vals(upper, len(self._data)) if isinstance(upper, (Series, list, tuple)) else None
        lo_val = None if (lower is None or lo_list is not None) else _to_float(lower)
        hi_val = None if (upper is None or hi_list is not None) else _to_float(upper)
        out = []
        for i, v in enumerate(self._data):
            fv = _to_float(v)
            if math.isnan(fv):
                out.append(math.nan)
                continue
            lo = _to_float(lo_list[i]) if lo_list is not None else lo_val
            hi = _to_float(hi_list[i]) if hi_list is not None else hi_val
            if lo is not None and not math.isnan(lo):
                fv = max(fv, lo)
            if hi is not None and not math.isnan(hi):
                fv = min(fv, hi)
            out.append(fv)
        return Series(out, index=self.index, name=self.name)

    def abs(self) -> "Series":
        return Series([math.nan if _is_nan(v) else abs(_to_float(v)) for v in self._data], index=self.index, name=self.name)

    def round(self, decimals: int = 0) -> "Series":
        d = int(decimals)
        out = []
        for v in self._data:
            fv = _to_float(v)
            out.append(round(fv, d) if math.isfinite(fv) else fv)
        return Series(out, index=self.index, name=self.name)

    def isna(self) -> "Series":
        return Series([_is_nan(v) for v in self._data], index=self.index, name=self.name)

    def isnull(self) -> "Series":
        return self.isna()

    def notna(self) -> "Series":
        return Series([not _is_nan(v) for v in self._data], index=self.index, name=self.name)

    def notnull(self) -> "Series":
        return self.notna()

    def dropna(self) -> "Series":
        vals = []
        idx = []
        for ix, v in zip(self.index, self._data):
            if not _is_nan(v):
                idx.append(ix)
                vals.append(v)
        return Series(vals, index=idx, name=self.name)

    def ffill(self, limit: int | None = None) -> "Series":
        out = []
        last = None
        has_last = False
        consec = 0
        lim = int(limit) if limit is not None else None
        for v in self._data:
            if not _is_nan(v):
                last = v
                has_last = True
                consec = 0
                out.append(v)
            else:
                if has_last and (lim is None or consec < lim):
                    out.append(last)
                    consec += 1
                else:
                    out.append(math.nan)
        return Series(out, index=self.index, name=self.name)

    def bfill(self, limit: int | None = None) -> "Series":
        rev = list(reversed(self._data))
        filled_rev = Series(rev).ffill(limit=limit)._data
        return Series(list(reversed(filled_rev)), index=self.index, name=self.name)

    def fillna(self, value=None, method: str | None = None, limit: int | None = None) -> "Series":
        if method is not None:
            m = str(method).lower()
            if m in ("ffill", "pad"):
                return self.ffill(limit=limit)
            if m in ("bfill", "backfill"):
                return self.bfill(limit=limit)
            raise ValueError(f"Unsupported fillna method '{method}'")
        if isinstance(value, Series):
            vlist = self._align_other(value)
            out = [vlist[i] if _is_nan(v) else v for i, v in enumerate(self._data)]
            return Series(out, index=self.index, name=self.name)
        if isinstance(value, (list, tuple)):
            if len(value) != len(self._data):
                raise ValueError("fillna sequence length mismatch")
            return Series([value[i] if _is_nan(v) else v for i, v in enumerate(self._data)], index=self.index, name=self.name)
        out = []
        replaced = 0
        lim = int(limit) if limit is not None else None
        for v in self._data:
            if _is_nan(v) and (lim is None or replaced < lim):
                out.append(value)
                replaced += 1
            else:
                out.append(v)
        return Series(out, index=self.index, name=self.name)

    def replace(self, to_replace, value) -> "Series":
        targets = list(to_replace) if isinstance(to_replace, (list, tuple, set)) else [to_replace]
        out = []
        for v in self._data:
            matched = False
            for t in targets:
                if _is_nan(t) and _is_nan(v):
                    matched = True
                    break
                if not _is_nan(t) and v == t:
                    matched = True
                    break
            out.append(value if matched else v)
        return Series(out, index=self.index, name=self.name)

    def where(self, cond, other=math.nan) -> "Series":
        c_src = cond(self) if callable(cond) else cond
        c_list = self._align_other(c_src) if isinstance(c_src, Series) else _series_vals(c_src, len(self._data))
        o_src = other(self) if callable(other) else other
        o_list = self._align_other(o_src) if isinstance(o_src, Series) else _series_vals(o_src, len(self._data))
        return Series(
            [a if _to_bool(c) else b for a, c, b in zip(self._data, c_list, o_list)],
            index=self.index,
            name=self.name,
        )

    def mask(self, cond, other=math.nan) -> "Series":
        c_src = cond(self) if callable(cond) else cond
        c_list = self._align_other(c_src) if isinstance(c_src, Series) else _series_vals(c_src, len(self._data))
        o_src = other(self) if callable(other) else other
        o_list = self._align_other(o_src) if isinstance(o_src, Series) else _series_vals(o_src, len(self._data))
        return Series(
            [b if _to_bool(c) else a for a, c, b in zip(self._data, c_list, o_list)],
            index=self.index,
            name=self.name,
        )

    def cumsum(self) -> "Series":
        acc = 0.0
        out = []
        for v in self._data:
            fv = _to_float(v)
            if math.isnan(fv):
                out.append(math.nan)
            else:
                acc += fv
                out.append(acc)
        return Series(out, index=self.index, name=self.name)

    def cumprod(self) -> "Series":
        acc = 1.0
        out = []
        for v in self._data:
            fv = _to_float(v)
            if math.isnan(fv):
                out.append(math.nan)
            else:
                acc *= fv
                out.append(acc)
        return Series(out, index=self.index, name=self.name)

    def cummax(self) -> "Series":
        cur = None
        out = []
        for v in self._data:
            fv = _to_float(v)
            if math.isnan(fv):
                out.append(math.nan)
            else:
                cur = fv if cur is None else max(cur, fv)
                out.append(cur)
        return Series(out, index=self.index, name=self.name)

    def cummin(self) -> "Series":
        cur = None
        out = []
        for v in self._data:
            fv = _to_float(v)
            if math.isnan(fv):
                out.append(math.nan)
            else:
                cur = fv if cur is None else min(cur, fv)
                out.append(cur)
        return Series(out, index=self.index, name=self.name)

    def apply(self, func) -> "Series":
        return Series([func(v) for v in self._data], index=self.index, name=self.name)

    def map(self, arg) -> "Series":
        if callable(arg):
            return self.apply(arg)
        if isinstance(arg, dict):
            return Series([arg.get(v, math.nan) for v in self._data], index=self.index, name=self.name)
        raise TypeError("Series.map() expects a callable or dict")

    def between(self, left, right, inclusive: str = "both") -> "Series":
        if inclusive == "both":
            return (self >= left) & (self <= right)
        if inclusive == "neither":
            return (self > left) & (self < right)
        if inclusive == "left":
            return (self >= left) & (self < right)
        if inclusive == "right":
            return (self > left) & (self <= right)
        raise ValueError(f"Invalid inclusive value '{inclusive}'")

    def rank(self, ascending: bool = True) -> "Series":
        indexed = [(i, _to_float(v)) for i, v in enumerate(self._data) if not _is_nan(v)]
        indexed.sort(key=lambda x: x[1], reverse=not ascending)
        ranks = [math.nan] * len(self._data)
        i = 0
        while i < len(indexed):
            j = i + 1
            while j < len(indexed) and indexed[j][1] == indexed[i][1]:
                j += 1
            avg_rank = (i + 1 + j) / 2.0
            for k in range(i, j):
                ranks[indexed[k][0]] = avg_rank
            i = j
        return Series(ranks, index=self.index, name=self.name)

    def astype(self, dtype) -> "Series":
        if dtype in (int, "int", "int8", "int16", "int32", "int64"):
            out = []
            for v in self._data:
                if _is_nan(v):
                    out.append(0)
                else:
                    fv = _to_float(v)
                    if not math.isfinite(fv):
                        raise ValueError("Cannot convert non-finite value (inf/NaN) to integer")
                    out.append(int(fv))
            return Series(out, index=self.index, name=self.name)
        if dtype in (float, "float", "float32", "float64"):
            return Series([_to_float(v) for v in self._data], index=self.index, name=self.name)
        if dtype in (bool, "bool"):
            return Series([_to_bool(v) for v in self._data], index=self.index, name=self.name)
        if dtype in (str, "str", "object"):
            return Series(["" if v is None else str(v) for v in self._data], index=self.index, name=self.name)
        return Series(list(self._data), index=self.index, name=self.name)

    def sum(self, skipna: bool = True) -> float:
        if not skipna and any(_is_nan(v) for v in self._data):
            return math.nan
        clean = [_to_float(v) for v in self._data if not _is_nan(v)]
        return sum(clean) if clean else 0.0

    def mean(self, skipna: bool = True) -> float:
        if not skipna and any(_is_nan(v) for v in self._data):
            return math.nan
        clean = [_to_float(v) for v in self._data if not _is_nan(v)]
        return sum(clean) / len(clean) if clean else math.nan

    def var(self, ddof: int = 1, skipna: bool = True) -> float:
        if not skipna and any(_is_nan(v) for v in self._data):
            return math.nan
        clean = [_to_float(v) for v in self._data if math.isfinite(_to_float(v))]
        n = len(clean)
        if n - ddof <= 0:
            return math.nan
        mu = sum(clean) / n
        return max(0.0, sum((x - mu) ** 2 for x in clean) / (n - ddof))

    def std(self, ddof: int = 1, skipna: bool = True) -> float:
        v = self.var(ddof=ddof, skipna=skipna)
        return math.sqrt(v) if not math.isnan(v) else math.nan

    def min(self, skipna: bool = True) -> float:
        if not skipna and any(_is_nan(v) for v in self._data):
            return math.nan
        clean = [_to_float(v) for v in self._data if not _is_nan(v)]
        return min(clean) if clean else math.nan

    def max(self, skipna: bool = True) -> float:
        if not skipna and any(_is_nan(v) for v in self._data):
            return math.nan
        clean = [_to_float(v) for v in self._data if not _is_nan(v)]
        return max(clean) if clean else math.nan

    def median(self, skipna: bool = True) -> float:
        if not skipna and any(_is_nan(v) for v in self._data):
            return math.nan
        clean = sorted(_to_float(v) for v in self._data if not _is_nan(v))
        return _quantile_sorted(clean, 0.5)

    def quantile(self, q: float = 0.5) -> float:
        clean = sorted(_to_float(v) for v in self._data if not _is_nan(v))
        return _quantile_sorted(clean, q)

    def any(self) -> bool:
        return any(_to_bool(v) for v in self._data)

    def all(self) -> bool:
        return all(_to_bool(v) for v in self._data)

    def _align_other(self, other: "Series") -> list:
        if len(other._data) == len(self._data) and (other.index is self.index or other.index == self.index):
            return other._data
        idx_map = {}
        for ix, val in zip(other.index, other._data):
            if ix not in idx_map:
                idx_map[ix] = val
        return [idx_map.get(ix, math.nan) for ix in self.index]

    def _resolve_other(self, other) -> list:
        if isinstance(other, Series):
            return self._align_other(other)
        if isinstance(other, (list, tuple)):
            if len(other) != len(self._data):
                raise ValueError(f"Operand length mismatch: {len(self._data)} vs {len(other)}")
            return list(other)
        return [other] * len(self._data)

    def _binop(self, other, fn):
        o = self._resolve_other(other)
        out = []
        for a, b in zip(self._data, o):
            if _is_nan(a) or _is_nan(b):
                out.append(math.nan)
            else:
                fa = 1.0 if isinstance(a, bool) else a
                fb = 1.0 if isinstance(b, bool) else b
                out.append(fn(fa, fb))
        return Series(out, index=self.index, name=self.name)

    def _cmp(self, other, fn, nan_result: bool = False):
        o = self._resolve_other(other)
        out = []
        for a, b in zip(self._data, o):
            if _is_nan(a) or _is_nan(b):
                out.append(nan_result)
            else:
                try:
                    out.append(bool(fn(a, b)))
                except TypeError:
                    out.append(nan_result)
        return Series(out, index=self.index, name=self.name)

    @staticmethod
    def _safe_div(a, b):
        if b == 0:
            if a == 0:
                return math.nan
            return math.inf if a > 0 else -math.inf
        return a / b

    @staticmethod
    def _safe_floordiv(a, b):
        if b == 0:
            return math.nan
        return a // b

    @staticmethod
    def _safe_mod(a, b):
        if b == 0:
            return math.nan
        return a % b

    @staticmethod
    def _safe_pow(a, b):
        try:
            res = a ** b
            if isinstance(res, complex):
                return math.nan
            return res
        except (ZeroDivisionError, ValueError, OverflowError):
            return math.nan

    def __add__(self, o): return self._binop(o, lambda a, b: a + b)
    def __radd__(self, o): return self._binop(o, lambda a, b: b + a)
    def __sub__(self, o): return self._binop(o, lambda a, b: a - b)
    def __rsub__(self, o): return self._binop(o, lambda a, b: b - a)
    def __mul__(self, o): return self._binop(o, lambda a, b: a * b)
    def __rmul__(self, o): return self._binop(o, lambda a, b: b * a)
    def __truediv__(self, o): return self._binop(o, self._safe_div)
    def __rtruediv__(self, o): return self._binop(o, lambda a, b: self._safe_div(b, a))
    def __floordiv__(self, o): return self._binop(o, self._safe_floordiv)
    def __rfloordiv__(self, o): return self._binop(o, lambda a, b: self._safe_floordiv(b, a))
    def __mod__(self, o): return self._binop(o, self._safe_mod)
    def __rmod__(self, o): return self._binop(o, lambda a, b: self._safe_mod(b, a))
    def __pow__(self, o): return self._binop(o, self._safe_pow)
    def __rpow__(self, o): return self._binop(o, lambda a, b: self._safe_pow(b, a))
    def __neg__(self): return Series([-v if not _is_nan(v) else math.nan for v in self._data], index=self.index, name=self.name)
    def __pos__(self): return Series([+v if not _is_nan(v) else math.nan for v in self._data], index=self.index, name=self.name)
    def __gt__(self, o): return self._cmp(o, lambda a, b: a > b)
    def __ge__(self, o): return self._cmp(o, lambda a, b: a >= b)
    def __lt__(self, o): return self._cmp(o, lambda a, b: a < b)
    def __le__(self, o): return self._cmp(o, lambda a, b: a <= b)
    def __eq__(self, o): return self._cmp(o, lambda a, b: a == b, nan_result=False)
    def __ne__(self, o): return self._cmp(o, lambda a, b: a != b, nan_result=True)

    def __and__(self, o):
        ol = self._resolve_other(o)
        return Series([_to_bool(a) and _to_bool(b) for a, b in zip(self._data, ol)], index=self.index, name=self.name)

    def __rand__(self, o):
        return self.__and__(o)

    def __or__(self, o):
        ol = self._resolve_other(o)
        return Series([_to_bool(a) or _to_bool(b) for a, b in zip(self._data, ol)], index=self.index, name=self.name)

    def __ror__(self, o):
        return self.__or__(o)

    def __xor__(self, o):
        ol = self._resolve_other(o)
        return Series([_to_bool(a) ^ _to_bool(b) for a, b in zip(self._data, ol)], index=self.index, name=self.name)

    def __invert__(self):
        return Series([not _to_bool(a) for a in self._data], index=self.index, name=self.name)


class _IlocIndexer:
    def __init__(self, df: "DataFrame"):
        self._df = df

    def __getitem__(self, key):
        if isinstance(key, slice):
            cols = {k: s._data[key] for k, s in self._df._cols.items()}
            idx = self._df.index[key]
            return DataFrame(cols, index=idx, volume_available=self._df.volume_available)
        if isinstance(key, (list, tuple)):
            cols = {k: [s._data[int(i)] for i in key] for k, s in self._df._cols.items()}
            idx = [self._df.index[int(i)] for i in key]
            return DataFrame(cols, index=idx, volume_available=self._df.volume_available)
        i = int(key)
        return {k: s._data[i] for k, s in self._df._cols.items()}


class DataFrame:
    def __init__(self, cols: dict, index=None, volume_available: bool = False):
        raw_cols = dict(cols or {})
        inferred_len = 0
        for v in raw_cols.values():
            if isinstance(v, (Series, list, tuple)):
                inferred_len = len(v)
                break
        if index is None:
            first_s = next((v for v in raw_cols.values() if isinstance(v, Series)), None)
            self.index = list(first_s.index) if first_s is not None else list(range(inferred_len))
        else:
            self.index = list(index)
        self._cols = {}
        for k, v in raw_cols.items():
            if isinstance(v, Series):
                s = v.copy()
                s.name = str(k)
                self._cols[str(k)] = s
            else:
                self._cols[str(k)] = Series(v, index=self.index, name=str(k))
        self.volume_available = volume_available

    def __len__(self) -> int:
        first = next(iter(self._cols.values()), None)
        return len(first) if first is not None else len(self.index)

    def __getitem__(self, key):
        if isinstance(key, (list, tuple)):
            missing = [k for k in key if k not in self._cols]
            if missing:
                raise KeyError(f"Columns {missing} not found in DataFrame")
            return DataFrame({k: self._cols[k].copy() for k in key}, index=self.index, volume_available=self.volume_available)
        if isinstance(key, Series):
            keep_mask = [_to_bool(x) for x in key._data]
            idx = [ix for ix, keep in zip(self.index, keep_mask) if keep]
            cols = {k: [v for v, keep in zip(s._data, keep_mask) if keep] for k, s in self._cols.items()}
            return DataFrame(cols, index=idx, volume_available=self.volume_available)
        if key not in self._cols:
            raise KeyError(f"Column '{key}' not found in DataFrame")
        return self._cols[key]

    def __setitem__(self, key: str, value):
        n = len(self)
        k = str(key)
        if isinstance(value, Series):
            if len(value) != n:
                aligned = Series(value, index=self.index) if len(value) == len(self.index) else Series({ix: v for ix, v in zip(value.index, value._data)}, index=self.index)
                aligned.name = k
                self._cols[k] = aligned
            else:
                s = value.copy()
                s.index = list(self.index)
                s.name = k
                self._cols[k] = s
        elif isinstance(value, (list, tuple)):
            if len(value) != n:
                raise ValueError(f"Length of values ({len(value)}) does not match length of DataFrame ({n})")
            self._cols[k] = Series(list(value), index=list(self.index), name=k)
        else:
            self._cols[k] = Series([value] * n, index=list(self.index), name=k)

    def __contains__(self, key: str) -> bool:
        return key in self._cols

    def get(self, key: str, default=None):
        return self._cols.get(key, default)

    @property
    def columns(self) -> list[str]:
        return list(self._cols.keys())

    @property
    def shape(self) -> tuple[int, int]:
        return (len(self), len(self._cols))

    @property
    def empty(self) -> bool:
        return len(self) == 0

    @property
    def iloc(self) -> _IlocIndexer:
        return _IlocIndexer(self)

    def copy(self) -> "DataFrame":
        return DataFrame({k: s.copy() for k, s in self._cols.items()}, index=list(self.index), volume_available=self.volume_available)

    def assign(self, **kwargs) -> "DataFrame":
        cp = self.copy()
        for k, v in kwargs.items():
            cp[k] = v(cp) if callable(v) else v
        return cp

    def head(self, n: int = 5) -> "DataFrame":
        return self.iloc[:max(0, int(n))]

    def tail(self, n: int = 5) -> "DataFrame":
        k = max(0, int(n))
        return DataFrame({c: [] for c in self._cols}, index=[], volume_available=self.volume_available) if k == 0 else self.iloc[-k:]

    def isna(self) -> "DataFrame":
        return DataFrame({k: s.isna() for k, s in self._cols.items()}, index=self.index)

    def notna(self) -> "DataFrame":
        return DataFrame({k: s.notna() for k, s in self._cols.items()}, index=self.index)

    def fillna(self, value=None, method: str | None = None) -> "DataFrame":
        return DataFrame({k: s.fillna(value=value, method=method) for k, s in self._cols.items()}, index=self.index, volume_available=self.volume_available)

    def dropna(self) -> "DataFrame":
        n = len(self)
        keep = [all(not _is_nan(s._data[i]) for s in self._cols.values()) for i in range(n)]
        idx = [ix for ix, kp in zip(self.index, keep) if kp]
        cols = {k: [s._data[i] for i in range(n) if keep[i]] for k, s in self._cols.items()}
        return DataFrame(cols, index=idx, volume_available=self.volume_available)

    def shift(self, periods: int = 1) -> "DataFrame":
        return DataFrame({k: s.shift(periods) for k, s in self._cols.items()}, index=self.index, volume_available=self.volume_available)

    def diff(self, periods: int = 1) -> "DataFrame":
        return DataFrame({k: s.diff(periods) for k, s in self._cols.items()}, index=self.index, volume_available=self.volume_available)

    def abs(self) -> "DataFrame":
        return DataFrame({k: s.abs() for k, s in self._cols.items()}, index=self.index, volume_available=self.volume_available)

    def _reduce_axis(self, fn_name: str, axis: int = 0, skipna: bool = True, **kwargs) -> Series:
        if axis == 1:
            n = len(self)
            cols = list(self._cols.values())
            out = []
            for i in range(n):
                row_vals = [c._data[i] for c in cols]
                if not skipna and any(_is_nan(v) for v in row_vals):
                    out.append(math.nan)
                    continue
                clean = [_to_float(v) for v in row_vals if not _is_nan(v)]
                if not clean:
                    out.append(math.nan if fn_name != "sum" else 0.0)
                elif fn_name == "max":
                    out.append(max(clean))
                elif fn_name == "min":
                    out.append(min(clean))
                elif fn_name == "sum":
                    out.append(sum(clean))
                elif fn_name == "mean":
                    out.append(sum(clean) / len(clean))
                elif fn_name == "std":
                    ddof = int(kwargs.get("ddof", 1))
                    if len(clean) - ddof <= 0:
                        out.append(math.nan)
                    else:
                        mu = sum(clean) / len(clean)
                        out.append(math.sqrt(sum((x - mu) ** 2 for x in clean) / (len(clean) - ddof)))
            return Series(out, index=list(self.index))
        col_names = list(self._cols.keys())
        vals = [getattr(self._cols[k], fn_name)(skipna=skipna, **kwargs) for k in col_names]
        return Series(vals, index=col_names)

    def max(self, axis: int = 0, skipna: bool = True) -> Series:
        return self._reduce_axis("max", axis=axis, skipna=skipna)

    def min(self, axis: int = 0, skipna: bool = True) -> Series:
        return self._reduce_axis("min", axis=axis, skipna=skipna)

    def sum(self, axis: int = 0, skipna: bool = True) -> Series:
        return self._reduce_axis("sum", axis=axis, skipna=skipna)

    def mean(self, axis: int = 0, skipna: bool = True) -> Series:
        return self._reduce_axis("mean", axis=axis, skipna=skipna)

    def std(self, axis: int = 0, ddof: int = 1, skipna: bool = True) -> Series:
        return self._reduce_axis("std", axis=axis, skipna=skipna, ddof=ddof)

    def to_records(self) -> list[dict]:
        n = len(self)
        keys = list(self._cols.keys())
        return [{k: self._cols[k]._data[i] for k in keys} for i in range(n)]


class _PDShim:
    Series = Series
    DataFrame = DataFrame

    @staticmethod
    def isna(obj):
        if isinstance(obj, (Series, DataFrame)):
            return obj.isna()
        if isinstance(obj, (list, tuple)):
            return [_is_nan(v) for v in obj]
        return _is_nan(obj)

    @staticmethod
    def isnull(obj):
        return _PDShim.isna(obj)

    @staticmethod
    def notna(obj):
        if isinstance(obj, (Series, DataFrame)):
            return obj.notna()
        if isinstance(obj, (list, tuple)):
            return [not _is_nan(v) for v in obj]
        return not _is_nan(obj)

    @staticmethod
    def notnull(obj):
        return _PDShim.notna(obj)

    @staticmethod
    def to_numeric(arg, errors: str = "raise"):
        vals = arg._data if isinstance(arg, Series) else (list(arg) if isinstance(arg, (list, tuple)) else [arg])
        out = []
        for v in vals:
            if v is None or (isinstance(v, float) and math.isnan(v)):
                out.append(math.nan)
                continue
            try:
                out.append(float(v))
            except (TypeError, ValueError):
                if errors == "coerce":
                    out.append(math.nan)
                elif errors == "ignore":
                    out.append(v)
                else:
                    raise
        return Series(out, index=arg.index) if isinstance(arg, Series) else (Series(out) if isinstance(arg, (list, tuple)) else out[0])

    @staticmethod
    def concat(objs, axis: int = 0):
        objs = list(objs)
        if not objs:
            return Series([])
        if axis == 1:
            cols = {}
            idx = objs[0].index
            for i, o in enumerate(objs):
                if isinstance(o, Series):
                    cols[o.name if o.name is not None else f"col_{i}"] = o
                elif isinstance(o, DataFrame):
                    for k, s in o._cols.items():
                        cols[k] = s
            return DataFrame(cols, index=idx)
        vals = []
        idx = []
        for o in objs:
            if isinstance(o, Series):
                vals.extend(o._data)
                idx.extend(o.index)
        return Series(vals, index=idx)

    @staticmethod
    def unique(s):
        seen = []
        vals = s._data if isinstance(s, Series) else list(s)
        for v in vals:
            if not _is_nan(v) and v not in seen:
                seen.append(v)
        return seen


def _broadcast_length(*items) -> int:
    for it in items:
        if isinstance(it, (Series, list, tuple)):
            return len(it)
    return 1


def _expand_arg(arg, n: int) -> list:
    if isinstance(arg, Series):
        if len(arg) != n:
            raise ValueError(f"Array length mismatch: {len(arg)} vs {n}")
        return arg._data
    if isinstance(arg, (list, tuple)):
        if len(arg) != n:
            raise ValueError(f"Array length mismatch: {len(arg)} vs {n}")
        return list(arg)
    return [arg] * n


def _elementwise_1arg(x, fn):
    if isinstance(x, Series):
        return Series([fn(_to_float(v)) for v in x._data], index=x.index, name=x.name)
    if isinstance(x, (list, tuple)):
        return Series([fn(_to_float(v)) for v in x])
    return fn(_to_float(x))


class _NPShim:
    nan = math.nan
    inf = math.inf
    pi = math.pi
    e = math.e
    int8 = int
    int32 = int
    int64 = int
    float32 = float
    float64 = float
    bool_ = bool

    @staticmethod
    def array(x, dtype=None):
        return Series(x, dtype=dtype)

    @staticmethod
    def asarray(x, dtype=None):
        return Series(x, dtype=dtype)

    @staticmethod
    def zeros(n, dtype=float):
        v = 0 if dtype in (int, "int", "int8", "int32", "int64") else (False if dtype in (bool, "bool") else 0.0)
        return Series([v] * int(n))

    @staticmethod
    def ones(n, dtype=float):
        v = 1 if dtype in (int, "int", "int8", "int32", "int64") else (True if dtype in (bool, "bool") else 1.0)
        return Series([v] * int(n))

    @staticmethod
    def full(n, fill_value, dtype=None):
        return Series([fill_value] * int(n), dtype=dtype)

    @staticmethod
    def empty(n, dtype=float):
        return _NPShim.full(n, math.nan, dtype=dtype)

    @staticmethod
    def arange(start, stop=None, step=1):
        if stop is None:
            start, stop = 0, start
        out = []
        cur = start
        if step == 0:
            raise ValueError("step must not be zero")
        if step > 0:
            while cur < stop:
                out.append(cur)
                cur += step
        else:
            while cur > stop:
                out.append(cur)
                cur += step
        return Series(out)

    @staticmethod
    def linspace(start, stop, num=50):
        k = int(num)
        if k <= 0:
            return Series([])
        if k == 1:
            return Series([float(start)])
        step = (float(stop) - float(start)) / (k - 1)
        return Series([float(start) + i * step for i in range(k)])

    @staticmethod
    def where(cond, a=None, b=None):
        if a is None and b is None:
            c_l = cond._data if isinstance(cond, Series) else list(cond)
            return ([i for i, v in enumerate(c_l) if _to_bool(v)],)
        n = _broadcast_length(cond, a, b)
        c_l = _expand_arg(cond, n)
        a_l = _expand_arg(a, n)
        b_l = _expand_arg(b, n)
        idx = cond.index if isinstance(cond, Series) else (a.index if isinstance(a, Series) else (b.index if isinstance(b, Series) else None))
        return Series([x if _to_bool(c) else y for c, x, y in zip(c_l, a_l, b_l)], index=idx)

    @staticmethod
    def select(condlist, choicelist, default=0):
        if len(condlist) != len(choicelist):
            raise ValueError("condlist and choicelist must have same length")
        if not condlist:
            return default
        n = _broadcast_length(*condlist, *choicelist)
        conds = [_expand_arg(c, n) for c in condlist]
        choices = [_expand_arg(ch, n) for ch in choicelist]
        defs = _expand_arg(default, n)
        idx = next((c.index for c in condlist if isinstance(c, Series)), None)
        out = []
        for i in range(n):
            picked = defs[i]
            for cl, chl in zip(conds, choices):
                if _to_bool(cl[i]):
                    picked = chl[i]
                    break
            out.append(picked)
        return Series(out, index=idx)

    @staticmethod
    def clip(a, a_min=None, a_max=None):
        if isinstance(a, Series):
            return a.clip(lower=a_min, upper=a_max)
        if isinstance(a, (list, tuple)):
            return Series(a).clip(lower=a_min, upper=a_max)
        v = _to_float(a)
        if math.isnan(v):
            return math.nan
        if a_min is not None:
            v = max(v, _to_float(a_min))
        if a_max is not None:
            v = min(v, _to_float(a_max))
        return v

    @staticmethod
    def abs(x):
        return _elementwise_1arg(x, lambda v: math.nan if math.isnan(v) else abs(v))

    @staticmethod
    def fabs(x):
        return _NPShim.abs(x)

    @staticmethod
    def sign(x):
        return _elementwise_1arg(x, lambda v: math.nan if math.isnan(v) else (1.0 if v > 0 else (-1.0 if v < 0 else 0.0)))

    @staticmethod
    def round(x, decimals: int = 0):
        d = int(decimals)
        return _elementwise_1arg(x, lambda v: round(v, d) if math.isfinite(v) else v)

    @staticmethod
    def maximum(a, b):
        n = _broadcast_length(a, b)
        al = _expand_arg(a, n)
        bl = _expand_arg(b, n)
        idx = a.index if isinstance(a, Series) else (b.index if isinstance(b, Series) else None)
        out = []
        for x, y in zip(al, bl):
            fx, fy = _to_float(x), _to_float(y)
            out.append(math.nan if (math.isnan(fx) or math.isnan(fy)) else max(fx, fy))
        return Series(out, index=idx) if (isinstance(a, (Series, list, tuple)) or isinstance(b, (Series, list, tuple))) else out[0]

    @staticmethod
    def minimum(a, b):
        n = _broadcast_length(a, b)
        al = _expand_arg(a, n)
        bl = _expand_arg(b, n)
        idx = a.index if isinstance(a, Series) else (b.index if isinstance(b, Series) else None)
        out = []
        for x, y in zip(al, bl):
            fx, fy = _to_float(x), _to_float(y)
            out.append(math.nan if (math.isnan(fx) or math.isnan(fy)) else min(fx, fy))
        return Series(out, index=idx) if (isinstance(a, (Series, list, tuple)) or isinstance(b, (Series, list, tuple))) else out[0]

    @staticmethod
    def fmax(a, b):
        n = _broadcast_length(a, b)
        al = _expand_arg(a, n)
        bl = _expand_arg(b, n)
        idx = a.index if isinstance(a, Series) else (b.index if isinstance(b, Series) else None)
        out = []
        for x, y in zip(al, bl):
            fx, fy = _to_float(x), _to_float(y)
            if math.isnan(fx):
                out.append(fy)
            elif math.isnan(fy):
                out.append(fx)
            else:
                out.append(max(fx, fy))
        return Series(out, index=idx) if (isinstance(a, (Series, list, tuple)) or isinstance(b, (Series, list, tuple))) else out[0]

    @staticmethod
    def fmin(a, b):
        n = _broadcast_length(a, b)
        al = _expand_arg(a, n)
        bl = _expand_arg(b, n)
        idx = a.index if isinstance(a, Series) else (b.index if isinstance(b, Series) else None)
        out = []
        for x, y in zip(al, bl):
            fx, fy = _to_float(x), _to_float(y)
            if math.isnan(fx):
                out.append(fy)
            elif math.isnan(fy):
                out.append(fx)
            else:
                out.append(min(fx, fy))
        return Series(out, index=idx) if (isinstance(a, (Series, list, tuple)) or isinstance(b, (Series, list, tuple))) else out[0]

    @staticmethod
    def sqrt(x):
        return _elementwise_1arg(x, lambda v: math.sqrt(v) if not math.isnan(v) and v >= 0 else math.nan)

    @staticmethod
    def exp(x):
        def _exp(v):
            if math.isnan(v):
                return math.nan
            try:
                return math.exp(v)
            except OverflowError:
                return math.inf
        return _elementwise_1arg(x, _exp)

    @staticmethod
    def log(x):
        return _elementwise_1arg(x, lambda v: (-math.inf if v == 0 else math.nan) if v <= 0 or math.isnan(v) else math.log(v))

    @staticmethod
    def log10(x):
        return _elementwise_1arg(x, lambda v: (-math.inf if v == 0 else math.nan) if v <= 0 or math.isnan(v) else math.log10(v))

    @staticmethod
    def log2(x):
        return _elementwise_1arg(x, lambda v: (-math.inf if v == 0 else math.nan) if v <= 0 or math.isnan(v) else math.log2(v))

    @staticmethod
    def power(a, b):
        n = _broadcast_length(a, b)
        al = _expand_arg(a, n)
        bl = _expand_arg(b, n)
        idx = a.index if isinstance(a, Series) else (b.index if isinstance(b, Series) else None)
        out = [Series._safe_pow(_to_float(x), _to_float(y)) if not (_is_nan(x) or _is_nan(y)) else math.nan for x, y in zip(al, bl)]
        return Series(out, index=idx) if (isinstance(a, (Series, list, tuple)) or isinstance(b, (Series, list, tuple))) else out[0]

    @staticmethod
    def square(x):
        return _elementwise_1arg(x, lambda v: v * v if not math.isnan(v) else math.nan)

    @staticmethod
    def sin(x): return _elementwise_1arg(x, lambda v: math.sin(v) if math.isfinite(v) else math.nan)
    @staticmethod
    def cos(x): return _elementwise_1arg(x, lambda v: math.cos(v) if math.isfinite(v) else math.nan)
    @staticmethod
    def tan(x): return _elementwise_1arg(x, lambda v: math.tan(v) if math.isfinite(v) else math.nan)
    @staticmethod
    def tanh(x): return _elementwise_1arg(x, lambda v: math.tanh(v) if not math.isnan(v) else math.nan)
    @staticmethod
    def arctan(x): return _elementwise_1arg(x, lambda v: math.atan(v) if not math.isnan(v) else math.nan)

    @staticmethod
    def isnan(x):
        if isinstance(x, Series):
            return Series([_is_nan(v) for v in x._data], index=x.index)
        if isinstance(x, (list, tuple)):
            return Series([_is_nan(v) for v in x])
        return _is_nan(x)

    @staticmethod
    def isinf(x):
        if isinstance(x, Series):
            return Series([_is_inf(_to_float(v)) for v in x._data], index=x.index)
        if isinstance(x, (list, tuple)):
            return Series([_is_inf(_to_float(v)) for v in x])
        return _is_inf(_to_float(x))

    @staticmethod
    def isfinite(x):
        if isinstance(x, Series):
            return Series([_is_finite(v) for v in x._data], index=x.index)
        if isinstance(x, (list, tuple)):
            return Series([_is_finite(v) for v in x])
        return _is_finite(x)

    @staticmethod
    def nan_to_num(x, nan=0.0, posinf=None, neginf=None):
        def _fix(v):
            fv = _to_float(v)
            if math.isnan(fv):
                return float(nan)
            if math.isinf(fv):
                if fv > 0:
                    return float(posinf) if posinf is not None else 1e308
                return float(neginf) if neginf is not None else -1e308
            return fv
        return _elementwise_1arg(x, _fix)

    @staticmethod
    def _vals_f(x) -> list[float]:
        raw = x._data if isinstance(x, Series) else (list(x) if isinstance(x, (list, tuple)) else [x])
        return [_to_float(v) for v in raw]

    @staticmethod
    def mean(x):
        vals = _NPShim._vals_f(x)
        if any(math.isnan(v) for v in vals):
            return math.nan
        return sum(vals) / len(vals) if vals else math.nan

    @staticmethod
    def nanmean(x):
        vals = [v for v in _NPShim._vals_f(x) if not math.isnan(v)]
        return sum(vals) / len(vals) if vals else math.nan

    @staticmethod
    def sum(x):
        vals = _NPShim._vals_f(x)
        return math.nan if any(math.isnan(v) for v in vals) else sum(vals)

    @staticmethod
    def nansum(x):
        vals = [v for v in _NPShim._vals_f(x) if not math.isnan(v)]
        return sum(vals)

    @staticmethod
    def prod(x):
        vals = _NPShim._vals_f(x)
        if any(math.isnan(v) for v in vals):
            return math.nan
        p = 1.0
        for v in vals:
            p *= v
        return p

    @staticmethod
    def var(x, ddof=0):
        vals = _NPShim._vals_f(x)
        if any(math.isnan(v) for v in vals) or len(vals) - ddof <= 0:
            return math.nan
        mu = sum(vals) / len(vals)
        return sum((v - mu) ** 2 for v in vals) / (len(vals) - ddof)

    @staticmethod
    def std(x, ddof=0):
        v = _NPShim.var(x, ddof=ddof)
        return math.sqrt(v) if not math.isnan(v) else math.nan

    @staticmethod
    def nanstd(x, ddof=0):
        vals = [v for v in _NPShim._vals_f(x) if math.isfinite(v)]
        if len(vals) - ddof <= 0:
            return math.nan
        mu = sum(vals) / len(vals)
        return math.sqrt(sum((v - mu) ** 2 for v in vals) / (len(vals) - ddof))

    @staticmethod
    def min(x):
        vals = _NPShim._vals_f(x)
        return math.nan if (not vals or any(math.isnan(v) for v in vals)) else min(vals)

    @staticmethod
    def max(x):
        vals = _NPShim._vals_f(x)
        return math.nan if (not vals or any(math.isnan(v) for v in vals)) else max(vals)

    @staticmethod
    def nanmin(x):
        vals = [v for v in _NPShim._vals_f(x) if not math.isnan(v)]
        return min(vals) if vals else math.nan

    @staticmethod
    def nanmax(x):
        vals = [v for v in _NPShim._vals_f(x) if not math.isnan(v)]
        return max(vals) if vals else math.nan

    @staticmethod
    def median(x):
        vals = _NPShim._vals_f(x)
        if not vals or any(math.isnan(v) for v in vals):
            return math.nan
        return _quantile_sorted(sorted(vals), 0.5)

    @staticmethod
    def percentile(x, q):
        return _NPShim.quantile(x, float(q) / 100.0)

    @staticmethod
    def quantile(x, q):
        vals = _NPShim._vals_f(x)
        if not vals or any(math.isnan(v) for v in vals):
            return math.nan
        return _quantile_sorted(sorted(vals), float(q))

    @staticmethod
    def diff(x, n=1):
        order = int(n)
        if order < 0:
            raise ValueError(f"order must be non-negative but got {order}")
        vals = _NPShim._vals_f(x)
        if order == 0:
            return Series(vals)
        for _ in range(order):
            vals = [vals[i] - vals[i - 1] for i in range(1, len(vals))]
        return Series(vals)

    @staticmethod
    def roll(x, shift: int):
        vals = list(x._data) if isinstance(x, Series) else list(x)
        n = len(vals)
        if n == 0:
            return Series([])
        k = int(shift) % n
        return Series(vals[-k:] + vals[:-k] if k else vals, index=x.index if isinstance(x, Series) else None)

    @staticmethod
    def cumsum(x):
        return (x if isinstance(x, Series) else Series(x)).cumsum()

    @staticmethod
    def argmax(x):
        vals = _NPShim._vals_f(x)
        if not vals:
            raise ValueError("attempt to get argmax of an empty sequence")
        best_i = 0
        for i, v in enumerate(vals):
            if math.isnan(v):
                return i
            if v > vals[best_i]:
                best_i = i
        return best_i

    @staticmethod
    def argmin(x):
        vals = _NPShim._vals_f(x)
        if not vals:
            raise ValueError("attempt to get argmin of an empty sequence")
        best_i = 0
        for i, v in enumerate(vals):
            if math.isnan(v):
                return i
            if v < vals[best_i]:
                best_i = i
        return best_i

    @staticmethod
    def corrcoef(x, y):
        xs = _NPShim._vals_f(x)
        ys = _NPShim._vals_f(y)
        if len(xs) != len(ys) or len(xs) < 2:
            return [[math.nan, math.nan], [math.nan, math.nan]]
        if any(not math.isfinite(v) for v in xs) or any(not math.isfinite(v) for v in ys):
            return [[math.nan, math.nan], [math.nan, math.nan]]
        mx = sum(xs) / len(xs)
        my = sum(ys) / len(ys)
        vx = sum((a - mx) ** 2 for a in xs)
        vy = sum((b - my) ** 2 for b in ys)
        denom = math.sqrt(vx * vy)
        r = sum((a - mx) * (b - my) for a, b in zip(xs, ys)) / denom if denom > 0 else math.nan
        return [[1.0, r], [r, 1.0]]


pd_shim = _PDShim()
np_shim = _NPShim()


# ---------------------------------------------------------------------------
# Built-in quantitative helper functions (exposed to indicators & strategies)
# ---------------------------------------------------------------------------
def crossover(a, b) -> Series:
    """True on bars where `a` crosses above `b` (prev <= prev_b and curr > curr_b)."""
    sa = a if isinstance(a, Series) else Series(a)
    sb = b if isinstance(b, Series) else Series([b] * len(sa), index=sa.index)
    return (sa > sb) & (sa.shift(1) <= sb.shift(1))


def crossunder(a, b) -> Series:
    """True on bars where `a` crosses below `b` (prev >= prev_b and curr < curr_b)."""
    sa = a if isinstance(a, Series) else Series(a)
    sb = b if isinstance(b, Series) else Series([b] * len(sa), index=sa.index)
    return (sa < sb) & (sa.shift(1) >= sb.shift(1))


def sma(series, period: int = 14) -> Series:
    s = series if isinstance(series, Series) else Series(series)
    return s.rolling(int(period)).mean()


def ema(series, period: int = 14) -> Series:
    s = series if isinstance(series, Series) else Series(series)
    return s.ewm(span=int(period), min_periods=int(period), adjust=False).mean()


def rma(series, period: int = 14) -> Series:
    """Wilder's smoothed moving average (alpha = 1 / period)."""
    s = series if isinstance(series, Series) else Series(series)
    p = int(period)
    return s.ewm(alpha=1.0 / p, min_periods=p, adjust=False).mean()


class IndicatorOutput:
    """Container passed to Strategy code when an indicator returns multiple named numeric series."""
    def __init__(self, series_map: dict[str, Series], signals: Series | None = None):
        self._map = dict(series_map)
        self.signal = signals

    def __getitem__(self, key: str) -> Series:
        if key in self._map:
            return self._map[key]
        if key in ("signal", "signals") and self.signal is not None:
            return self.signal
        raise KeyError(f"Output '{key}' not found; available: {list(self._map.keys())}")

    def __getattr__(self, name: str):
        if name in self._map:
            return self._map[name]
        raise AttributeError(f"IndicatorOutput has no output '{name}'")

    def __contains__(self, key: str) -> bool:
        return key in self._map or (key in ("signal", "signals") and self.signal is not None)

    def get(self, key: str, default=None):
        if key in self._map:
            return self._map[key]
        if key in ("signal", "signals") and self.signal is not None:
            return self.signal
        return default

    def keys(self):
        return list(self._map.keys())


class ParamSpec:
    def __init__(self, name, default, low, high, kind="int", step=None):
        self.name = name
        self.default = default
        self.low = low
        self.high = high
        self.kind = kind
        self.step = step


def _make_indicator_decorator(collected):
    def indicator(
        name: str,
        *,
        category: str = "Custom",
        params=(),
        description: str = "",
        version: str = "1.0.0",
        output_type: str = "auto",
        **kwargs,
    ):
        def decorator(fn):
            collected.append({
                "kind": "indicator",
                "name": name,
                "category": category,
                "description": description,
                "version": version,
                "output_type": output_type,
                "params": [
                    {"name": p.name, "default": p.default, "low": p.low, "high": p.high, "kind": p.kind, "step": p.step}
                    if isinstance(p, ParamSpec) else p for p in params
                ],
                "fn": fn,
            })
            return fn
        return decorator
    return indicator


def _make_strategy_decorator(collected):
    def strategy(name: str, *, description: str = "", version: str = "1.0.0", params=(), **kwargs):
        def decorator(fn):
            collected.append({
                "kind": "strategy",
                "name": name,
                "description": description,
                "version": version,
                "params": [
                    {"name": p.name, "default": p.default, "low": p.low, "high": p.high, "kind": p.kind, "step": p.step}
                    if isinstance(p, ParamSpec) else p for p in params
                ],
                "fn": fn,
            })
            return fn
        return strategy
    return strategy


class _RegistryShimModule:
    def __init__(self, ind_dec, strat_dec):
        self.ParamSpec = ParamSpec
        self.indicator = ind_dec
        self.strategy = strat_dec
        self.crossover = crossover
        self.crossunder = crossunder
        self.sma = sma
        self.ema = ema
        self.rma = rma


def _safe_builtins():
    allowed = {
        "abs", "all", "any", "bool", "dict", "enumerate", "filter", "float",
        "int", "isinstance", "len", "list", "map", "max", "min", "pow",
        "print", "range", "reversed", "round", "set", "slice", "sorted",
        "str", "sum", "tuple", "zip", "Exception", "ValueError", "KeyError",
        "TypeError", "RuntimeError", "ZeroDivisionError", "IndexError", "AttributeError",
    }
    safe = {k: getattr(builtins, k) for k in allowed if hasattr(builtins, k)}
    safe["__build_class__"] = builtins.__build_class__

    def _safe_getattr(obj, attr, *default):
        if isinstance(attr, str) and (attr in BANNED_DUNDER_ATTRS or attr.startswith("_")):
            raise AttributeError(f"Access to private attribute '{attr}' is blocked in sandbox")
        return builtins.getattr(obj, attr, *default)

    def _safe_hasattr(obj, attr):
        if isinstance(attr, str) and (attr in BANNED_DUNDER_ATTRS or attr.startswith("_")):
            return False
        return builtins.hasattr(obj, attr)

    safe["getattr"] = _safe_getattr
    safe["hasattr"] = _safe_hasattr

    def _safe_import(name, globals=None, locals=None, fromlist=(), level=0):
        root = name.split(".")[0]
        if root == "pandas":
            return pd_shim
        if root == "numpy":
            return np_shim
        if root == "indicatorlab":
            return _RegistryShimModule(
                _safe_import._ind_dec,
                _safe_import._strat_dec,
            )
        if root in SAFE_MODULES:
            return builtins.__import__(name, globals, locals, fromlist, level)
        raise ImportError(f"Module '{name}' is blocked or unavailable in the isolated sandbox")

    return safe, _safe_import


def _build_df(candles: list[dict] | None = None, cols: dict | None = None) -> DataFrame:
    if cols is not None and isinstance(cols, dict):
        times = cols.get("time") or []
        raw_vols = cols.get("volume") or [None] * len(times)
        vols = [math.nan if v is None else _to_float(v) for v in raw_vols]
        vol_avail = any(not _is_nan(v) for v in vols)
        return DataFrame({
            "open": cols.get("open") or [],
            "high": cols.get("high") or [],
            "low": cols.get("low") or [],
            "close": cols.get("close") or [],
            "volume": vols,
        }, index=times, volume_available=vol_avail)

    candles = candles or []
    vols = [
        math.nan if c.get("volume") is None else _to_float(c.get("volume"))
        for c in candles
    ]
    vol_avail = any(not _is_nan(v) for v in vols)
    return DataFrame({
        "open": [c["open"] for c in candles],
        "high": [c["high"] for c in candles],
        "low": [c["low"] for c in candles],
        "close": [c["close"] for c in candles],
        "volume": vols,
    }, index=[c["time"] for c in candles], volume_available=vol_avail)


def _normalize_signals(raw, n: int) -> list[int]:
    if isinstance(raw, dict):
        if "signal" in raw:
            raw = raw["signal"]
        elif "signals" in raw:
            raw = raw["signals"]
    if isinstance(raw, Series):
        vals = raw._data
    elif isinstance(raw, (list, tuple)):
        vals = list(raw)
    else:
        raise ValueError("Signal output must be a Series, list, or dict with 'signal'/'signals' aligned to candle count")
    if len(vals) != n:
        raise ValueError(f"Expected {n} bar signal values, got {len(vals)}")
    out = []
    for idx, v in enumerate(vals):
        if _is_nan(v):
            out.append(0)
            continue
        if isinstance(v, bool):
            iv = int(v)
        elif isinstance(v, (int, float)):
            if not math.isfinite(v):
                raise ValueError(f"Signal at bar {idx} is non-finite ({v!r}); handle NaN/inf before returning")
            iv = int(round(v)) if abs(v - round(v)) < 1e-9 else None
        else:
            iv = None
        if iv not in (-1, 0, 1):
            raise ValueError(f"Signal at bar {idx} is {v!r}; signal indicator values must be in {{-1, 0, 1}}")
        out.append(iv)
    return out


def _normalize_numeric_series(raw, n: int, label: str = "value") -> list[float | None]:
    if isinstance(raw, Series):
        vals = raw._data
    elif isinstance(raw, (list, tuple)):
        vals = list(raw)
    else:
        raise ValueError(f"Output '{label}' must be a Series or list aligned to candle count {n}")
    if len(vals) != n:
        raise ValueError(f"Output '{label}': expected {n} bar values, got {len(vals)}")
    out = []
    for idx, v in enumerate(vals):
        if v is None:
            out.append(None)
            continue
        if isinstance(v, bool):
            out.append(1.0 if v else 0.0)
            continue
        if isinstance(v, (int, float)):
            fv = float(v)
            if math.isnan(fv):
                out.append(None)
            elif math.isinf(fv):
                raise ValueError(
                    f"Output '{label}' has non-finite value ({fv!r}) at bar {idx}; "
                    f"mask zero denominators or use .replace([np.inf, -np.inf], np.nan)"
                )
            else:
                out.append(round(fv, 8))
            continue
        raise ValueError(f"Output '{label}' at bar {idx} has non-numeric value {v!r}")
    return out


def _compute_series_stats(vals: list[float | None]) -> dict:
    finite = [v for v in vals if v is not None]
    nan_count = len(vals) - len(finite)
    if not finite:
        return {"min": None, "max": None, "mean": None, "latest": None, "finite_count": 0, "nan_count": nan_count}
    return {
        "min": round(min(finite), 6),
        "max": round(max(finite), 6),
        "mean": round(sum(finite) / len(finite), 6),
        "latest": round(finite[-1], 6),
        "finite_count": len(finite),
        "nan_count": nan_count,
    }


def _looks_like_discrete_signal(vals: list[float | None]) -> bool:
    if not vals:
        return True
    for v in vals:
        if v is None:
            continue
        if abs(v - round(v)) >= 1e-9 or int(round(v)) not in (-1, 0, 1):
            return False
    return True


def _extract_indicator_result(raw, n: int, output_type: str = "auto") -> dict:
    """Separates discrete trading signals (-1/0/+1) from numerical and multi-series outputs."""
    req_type = str(output_type or "auto").lower()
    if req_type not in ("auto", "numeric", "signal", "multi"):
        req_type = "auto"

    outputs: dict[str, list[float | None]] = {}
    overlays: dict[str, list[float | None]] = {}
    oscillators: dict[str, list[float | None]] = {}
    signals: list[int] | None = None

    if isinstance(raw, dict):
        has_structured = ("overlays" in raw or "overlay" in raw or "oscillators" in raw or "oscillator" in raw)
        ov_src = raw.get("overlays") or raw.get("overlay") or {}
        if isinstance(ov_src, dict):
            for k, v in ov_src.items():
                arr = _normalize_numeric_series(v, n, label=str(k))
                overlays[str(k)] = arr
                outputs[str(k)] = arr
        osc_src = raw.get("oscillators") or raw.get("oscillator") or {}
        if isinstance(osc_src, dict):
            for k, v in osc_src.items():
                arr = _normalize_numeric_series(v, n, label=str(k))
                oscillators[str(k)] = arr
                outputs[str(k)] = arr

        # Direct named outputs in dict (e.g. {"upper": ..., "middle": ..., "lower": ...} or {"macd": ..., "signal": ..., "histogram": ...})
        reserved = {"overlays", "overlay", "oscillators", "oscillator", "signal", "signals"}
        other_keys = [k for k in raw.keys() if str(k) not in reserved]
        for k in other_keys:
            arr = _normalize_numeric_series(raw[k], n, label=str(k))
            outputs[str(k)] = arr
            oscillators.setdefault(str(k), arr)

        sig_key = "signal" if "signal" in raw else ("signals" if "signals" in raw else None)
        if sig_key is not None:
            cand_raw = raw[sig_key]
            # If other indicator outputs exist (e.g. MACD {"macd": ..., "signal": ..., "histogram": ...}) and
            # `signal` contains continuous floats outside {-1, 0, 1}, keep it as a named numeric output!
            cand_num = _normalize_numeric_series(cand_raw, n, label=sig_key)
            if req_type == "signal" or (not other_keys and not has_structured) or _looks_like_discrete_signal(cand_num):
                signals = _normalize_signals(cand_raw, n)
                if not outputs:
                    outputs[sig_key] = [float(s) for s in signals]
            else:
                outputs[sig_key] = cand_num
                oscillators[sig_key] = cand_num

        if not outputs and signals is None:
            raise ValueError("Indicator dict return contains no recognizable signal or named numeric series")

        resolved_type = "multi" if len(outputs) > 1 else ("signal" if (signals is not None and not other_keys and not has_structured) else "numeric")
        if req_type == "signal" and signals is None:
            raise ValueError("Indicator marked as 'signal' must return a Series/list or dict with 'signal' in {-1, 0, 1}")

        return {
            "output_type": resolved_type,
            "signals": signals,
            "outputs": outputs,
            "overlays": overlays,
            "oscillators": oscillators,
            "numeric_stats": {k: _compute_series_stats(v) for k, v in outputs.items()},
        }

    # 1D Series / list / tuple
    if req_type == "signal":
        signals = _normalize_signals(raw, n)
        return {
            "output_type": "signal",
            "signals": signals,
            "outputs": {"signal": [float(s) for s in signals]},
            "overlays": {},
            "oscillators": {},
            "numeric_stats": {"signal": _compute_series_stats([float(s) for s in signals])},
        }

    num_vals = _normalize_numeric_series(raw, n, label="value")
    if req_type == "auto" and _looks_like_discrete_signal(num_vals):
        signals = _normalize_signals(raw, n)
        return {
            "output_type": "signal",
            "signals": signals,
            "outputs": {"signal": [float(s) for s in signals]},
            "overlays": {},
            "oscillators": {},
            "numeric_stats": {"signal": _compute_series_stats([float(s) for s in signals])},
        }

    return {
        "output_type": "numeric",
        "signals": None,
        "outputs": {"value": num_vals},
        "overlays": {},
        "oscillators": {"value": num_vals},
        "numeric_stats": {"value": _compute_series_stats(num_vals)},
    }


def _apply_signal_rule(extracted: dict, close_vals: list[float], rule: dict | None) -> list[int]:
    """Converts numerical indicator output to {-1, 0, 1} signals using a configurable rule."""
    if extracted["signals"] is not None and (not rule or rule.get("mode") in (None, "auto", "signal")):
        return extracted["signals"]

    n = len(close_vals)
    outputs = extracted.get("outputs") or {}
    if not outputs:
        return [0] * n

    rule = rule or {}
    mode = str(rule.get("mode") or "none").lower()
    if mode in ("none", ""):
        return extracted["signals"] if extracted["signals"] is not None else [0] * n

    out_key = str(rule.get("output_key") or next(iter(outputs.keys())))
    if out_key not in outputs:
        out_key = next(iter(outputs.keys()))
    vals = outputs[out_key]

    sig = [0] * n
    if mode == "threshold":
        buy_below = rule.get("buy_below")
        sell_above = rule.get("sell_above")
        for i, v in enumerate(vals):
            if v is None:
                continue
            if buy_below is not None and v <= float(buy_below):
                sig[i] = 1
            elif sell_above is not None and v >= float(sell_above):
                sig[i] = -1
        return sig

    if mode == "cross_zero":
        level = float(rule.get("level", 0.0))
        for i in range(1, n):
            cur, prev = vals[i], vals[i - 1]
            if cur is None or prev is None:
                continue
            if prev <= level and cur > level:
                sig[i] = 1
            elif prev >= level and cur < level:
                sig[i] = -1
        return sig

    if mode == "price_cross":
        for i in range(1, n):
            cur, prev = vals[i], vals[i - 1]
            if cur is None or prev is None:
                continue
            c_cur, c_prev = _to_float(close_vals[i]), _to_float(close_vals[i - 1])
            if c_prev <= prev and c_cur > cur:
                sig[i] = 1
            elif c_prev >= prev and c_cur < cur:
                sig[i] = -1
        return sig

    if mode == "trend_above":
        for i, v in enumerate(vals):
            if v is None:
                continue
            c_cur = _to_float(close_vals[i])
            if c_cur > v:
                sig[i] = 1
            elif c_cur < v:
                sig[i] = -1
        return sig

    return extracted["signals"] if extracted["signals"] is not None else [0] * n


def _code_uses_volume(code: str) -> bool:
    return '["volume"]' in code or "['volume']" in code or ".volume" in code


def _compile_and_load(code: str):
    collected = []
    ind_dec = _make_indicator_decorator(collected)
    strat_dec = _make_strategy_decorator(collected)
    safe_b, safe_imp = _safe_builtins()
    safe_imp._ind_dec = ind_dec
    safe_imp._strat_dec = strat_dec
    safe_b["__import__"] = safe_imp

    ns = {
        "__builtins__": safe_b,
        "__name__": "user_sandbox_module",
        "pd": pd_shim,
        "np": np_shim,
        "math": math,
        "statistics": statistics,
        "ParamSpec": ParamSpec,
        "indicator": ind_dec,
        "strategy": strat_dec,
        "crossover": crossover,
        "crossunder": crossunder,
        "sma": sma,
        "ema": ema,
        "rma": rma,
    }
    compiled = compile(code, "<studio_code>", "exec")
    exec(compiled, ns, ns)
    return ns, collected


def _find_callable(ns: dict, collected: list, preferred_names: tuple[str, ...]):
    if collected:
        return collected[-1]["fn"], collected[-1]
    for name in preferred_names:
        fn = ns.get(name)
        if callable(fn):
            return fn, None
    user_fns = [
        v for k, v in ns.items()
        if callable(v) and not k.startswith("_") and getattr(v, "__module__", "") == "user_sandbox_module"
    ]
    if user_fns:
        return user_fns[0], None
    return None, None


def _compare_prefix_causality(full_ext: dict, prefix_ext: dict, cut: int) -> tuple[bool, str]:
    if full_ext["output_type"] == "signal" and prefix_ext["output_type"] == "signal":
        if prefix_ext["signals"] != full_ext["signals"][:cut]:
            return False, "Look-ahead detected: truncated series signals differ from full series"
        return True, "Passed prefix invariance check"

    full_outs = full_ext.get("outputs") or {}
    pref_outs = prefix_ext.get("outputs") or {}
    if set(full_outs.keys()) != set(pref_outs.keys()):
        return False, "Look-ahead detected: output keys differ on truncated prefix"
    for k, pref_arr in pref_outs.items():
        full_arr = full_outs[k][:cut]
        for idx, (pv, fv) in enumerate(zip(pref_arr, full_arr)):
            if pv is None and fv is None:
                continue
            if pv is None or fv is None or abs(pv - fv) > 1e-6:
                return False, f"Look-ahead detected at bar {idx} in output '{k}' ({pv} vs {fv})"
    return True, "Passed numeric prefix invariance check"


def _slice_df(df: DataFrame, count: int) -> DataFrame:
    return df.iloc[:count]


def _run_indicator(payload: dict) -> dict:
    code = payload["code"]
    candles = payload.get("candles")
    cols = payload.get("cols")
    params = payload.get("params") or {}
    syntax_only = bool(payload.get("syntax_only", False))
    output_type = str(payload.get("output_type") or "auto")
    signal_rule = payload.get("signal_rule")

    ok, err = check_ast_safety(code)
    if not ok:
        return {"ok": False, "stage": "syntax", "error": err}

    try:
        ns, collected = _compile_and_load(code)
    except Exception as exc:
        tb = traceback.extract_tb(exc.__traceback__)
        line = next((f.lineno for f in reversed(tb) if f.filename == "<studio_code>"), 1)
        return {"ok": False, "stage": "load", "error": {"type": type(exc).__name__, "line": line, "message": str(exc)}}

    fn, dec_meta = _find_callable(ns, collected, ("compute", "indicator_signal", "signal"))
    if fn is None:
        return {
            "ok": False,
            "stage": "contract",
            "error": {"type": "ContractError", "line": 1, "message": "Define a callable function such as `def compute(df, **params):`."},
        }

    if dec_meta and dec_meta.get("output_type") and output_type == "auto":
        output_type = dec_meta["output_type"]

    if syntax_only:
        return {"ok": True, "stage": "syntax", "detected_meta": {k: v for k, v in (dec_meta or {}).items() if k != "fn"}}

    df = _build_df(candles=candles, cols=cols)
    n = len(df)
    uses_volume = _code_uses_volume(code)
    volume_warning = None
    if uses_volume and not df.volume_available:
        volume_warning = "Dataset candles in this slice have missing volume (NULL). Volume-dependent calculations yield NaN rather than fabricated zeros."

    t0 = time.perf_counter()
    try:
        raw = fn(df, **params)
        extracted = _extract_indicator_result(raw, n, output_type=output_type)
    except MemoryError:
        return {
            "ok": False,
            "stage": "memory",
            "error": {"type": "MemoryError", "line": 1, "message": "Indicator exceeded sandbox memory limit."},
        }
    except Exception as exc:
        tb = traceback.extract_tb(exc.__traceback__)
        line = next((f.lineno for f in reversed(tb) if f.filename == "<studio_code>"), 1)
        return {"ok": False, "stage": "runtime", "error": {"type": type(exc).__name__, "line": line, "message": str(exc)}}
    elapsed_ms = round((time.perf_counter() - t0) * 1000.0, 2)

    # Causality check on prefix of candles (works for signal, numeric, and multi-output indicators)
    causal = True
    causality_note = "Passed prefix invariance check"
    if n >= 80:
        cut = n // 2
        try:
            prefix_raw = fn(_slice_df(df, cut), **params)
            prefix_ext = _extract_indicator_result(prefix_raw, cut, output_type=output_type)
            causal, causality_note = _compare_prefix_causality(extracted, prefix_ext, cut)
        except Exception as exc:
            causal = False
            causality_note = f"Causality check error: {exc}"

    close_vals = df["close"]._data
    times = df.index
    rule_signals = _apply_signal_rule(extracted, close_vals, signal_rule) if (extracted["signals"] is not None or (signal_rule and signal_rule.get("mode") not in (None, "none"))) else None

    signal_counts = None
    if rule_signals is not None:
        bullish = sum(1 for s in rule_signals if s == 1)
        bearish = sum(1 for s in rule_signals if s == -1)
        signal_counts = {"bullish": bullish, "bearish": bearish, "neutral": n - bullish - bearish}

    tail_n = min(12, n)
    outputs_map = extracted["outputs"]
    output_keys = list(outputs_map.keys())
    sample = []
    for i in range(n - tail_n, n):
        row = {"time": times[i], "close": close_vals[i]}
        if rule_signals is not None:
            row["signal"] = rule_signals[i]
        row["values"] = {k: outputs_map[k][i] for k in output_keys}
        if len(output_keys) == 1:
            row["value"] = outputs_map[output_keys[0]][i]
        sample.append(row)

    return_full = bool(payload.get("return_signals") or payload.get("return_outputs"))
    return {
        "ok": True,
        "stage": "executed",
        "execution_ms": elapsed_ms,
        "bars": n,
        "output_type": extracted["output_type"],
        "output_keys": output_keys,
        "causal": causal,
        "causality_note": causality_note,
        "volume_available": df.volume_available,
        "uses_volume": uses_volume,
        "volume_warning": volume_warning,
        "signal_counts": signal_counts,
        "numeric_stats": extracted["numeric_stats"],
        "signals": (rule_signals if rule_signals is not None else [0] * n) if return_full else None,
        "outputs": outputs_map if return_full else None,
        "overlays": extracted["overlays"] if return_full else list(extracted["overlays"].keys()),
        "oscillators": extracted["oscillators"] if return_full else list(extracted["oscillators"].keys()),
        "sample": sample,
        "detected_meta": {k: v for k, v in (dec_meta or {}).items() if k != "fn"},
    }


def _run_strategy(payload: dict) -> dict:
    code = payload["code"]
    candles = payload.get("candles")
    cols = payload.get("cols")
    params = payload.get("params") or {}
    indicator_codes = payload.get("indicator_codes") or []
    syntax_only = bool(payload.get("syntax_only", False))

    ok, err = check_ast_safety(code)
    if not ok:
        return {"ok": False, "stage": "syntax", "error": err}

    try:
        ns, collected = _compile_and_load(code)
    except Exception as exc:
        tb = traceback.extract_tb(exc.__traceback__)
        line = next((f.lineno for f in reversed(tb) if f.filename == "<studio_code>"), 1)
        return {"ok": False, "stage": "load", "error": {"type": type(exc).__name__, "line": line, "message": str(exc)}}

    fn, dec_meta = _find_callable(ns, collected, ("generate_signals", "evaluate", "compute_strategy", "strategy_signals"))
    if fn is None:
        return {
            "ok": False,
            "stage": "contract",
            "error": {"type": "ContractError", "line": 1, "message": "Define a callable function such as `def generate_signals(df, indicators, **params):`."},
        }

    if syntax_only:
        return {"ok": True, "stage": "syntax", "detected_meta": {k: v for k, v in (dec_meta or {}).items() if k != "fn"}}

    df = _build_df(candles=candles, cols=cols)
    n = len(df)
    ind_values = {}
    t0 = time.perf_counter()

    # Compute each registered indicator referenced by this strategy inside the isolated sandbox
    for ind in indicator_codes:
        i_ok, i_err = check_ast_safety(ind["code"])
        if not i_ok:
            return {"ok": False, "stage": "indicator", "error": {"type": "IndicatorError", "line": 1, "message": f"Indicator '{ind['name']}': {i_err['message']}"}}
        try:
            i_ns, i_col = _compile_and_load(ind["code"])
            i_fn, i_meta = _find_callable(i_ns, i_col, ("compute", "indicator_signal", "signal"))
            if i_fn is None:
                raise ValueError(f"Indicator '{ind['name']}' has no compute() function")
            out_type = ind.get("output_type") or (i_meta.get("output_type") if i_meta else "auto") or "auto"
            raw_out = i_fn(df, **(ind.get("params") or {}))
            ext = _extract_indicator_result(raw_out, n, output_type=out_type)
            if ext["output_type"] == "signal" and ext["signals"] is not None:
                ind_values[ind["name"]] = Series(ext["signals"], index=df.index, name=ind["name"])
            elif len(ext["outputs"]) == 1:
                only_key = next(iter(ext["outputs"]))
                vals = [math.nan if v is None else v for v in ext["outputs"][only_key]]
                ind_values[ind["name"]] = Series(vals, index=df.index, name=ind["name"])
            else:
                series_map = {
                    k: Series([math.nan if v is None else v for v in arr], index=df.index, name=k)
                    for k, arr in ext["outputs"].items()
                }
                sig_s = Series(ext["signals"], index=df.index) if ext["signals"] is not None else None
                ind_values[ind["name"]] = IndicatorOutput(series_map, signals=sig_s)
        except Exception as exc:
            return {"ok": False, "stage": "indicator", "error": {"type": type(exc).__name__, "line": 1, "message": f"Indicator '{ind['name']}' failed: {exc}"}}

    try:
        res = fn(df, ind_values, **params)
        exit_signals = [0] * n
        sl_override = None
        tp_override = None
        if isinstance(res, dict):
            entry_raw = res.get("signals") if "signals" in res else res.get("entry_signals")
            if entry_raw is None:
                raise ValueError("Strategy dict return must include 'signals' or 'entry_signals'")
            signals = _normalize_signals(entry_raw, n)
            if res.get("exit_signals") is not None:
                exit_signals = _normalize_signals(res["exit_signals"], n)
            if res.get("stop_loss_pct") is not None:
                sl_override = float(res["stop_loss_pct"])
            if res.get("target_pct") is not None:
                tp_override = float(res["target_pct"])
        else:
            signals = _normalize_signals(res, n)
    except MemoryError:
        return {
            "ok": False,
            "stage": "memory",
            "error": {"type": "MemoryError", "line": 1, "message": "Strategy exceeded sandbox memory limit."},
        }
    except Exception as exc:
        tb = traceback.extract_tb(exc.__traceback__)
        line = next((f.lineno for f in reversed(tb) if f.filename == "<studio_code>"), 1)
        return {"ok": False, "stage": "runtime", "error": {"type": type(exc).__name__, "line": line, "message": str(exc)}}

    elapsed_ms = round((time.perf_counter() - t0) * 1000.0, 2)
    long_signals = sum(1 for s in signals if s == 1)
    short_signals = sum(1 for s in signals if s == -1)

    return {
        "ok": True,
        "stage": "executed",
        "execution_ms": elapsed_ms,
        "bars": n,
        "signal_counts": {"long": long_signals, "short": short_signals, "flat": n - long_signals - short_signals},
        "signals": signals,
        "exit_signals": exit_signals,
        "stop_loss_pct": sl_override,
        "target_pct": tp_override,
        "detected_meta": {k: v for k, v in (dec_meta or {}).items() if k != "fn"},
    }


def _run_overlays(payload: dict) -> dict:
    candles = payload.get("candles")
    cols = payload.get("cols")
    indicators = payload.get("indicators") or []
    df = _build_df(candles=candles, cols=cols)
    n = len(df)
    results = []

    for ind in indicators:
        name = ind.get("name") or "indicator"
        code = ind.get("code") or ""
        params = ind.get("params") or {}
        output_type = ind.get("output_type") or "auto"
        uses_vol = _code_uses_volume(code)
        vol_warn = (
            "Selected candle range has no volume data (NULL); volume-based series may be unavailable or NaN."
            if (uses_vol and not df.volume_available)
            else None
        )
        ok, err = check_ast_safety(code)
        if not ok:
            results.append({"name": name, "ok": False, "error": err["message"], "uses_volume": uses_vol, "volume_warning": vol_warn})
            continue
        t0 = time.perf_counter()
        try:
            ns, collected = _compile_and_load(code)
            fn, meta = _find_callable(ns, collected, ("compute", "indicator_signal", "signal"))
            if fn is None:
                raise ValueError(f"Indicator '{name}' defines no compute(df, **params) callable")
            if meta and meta.get("output_type") and output_type == "auto":
                output_type = meta["output_type"]
            raw = fn(df, **params)
            ext = _extract_indicator_result(raw, n, output_type=output_type)
            results.append({
                "name": name,
                "ok": True,
                "output_type": ext["output_type"],
                "execution_ms": round((time.perf_counter() - t0) * 1000.0, 2),
                "uses_volume": uses_vol,
                "volume_warning": vol_warn,
                "signals": ext["signals"] if ext["signals"] is not None else [0] * n,
                "outputs": ext["outputs"],
                "overlays": ext["overlays"],
                "oscillators": ext["oscillators"],
            })
        except Exception as exc:
            results.append({
                "name": name,
                "ok": False,
                "error": str(exc),
                "uses_volume": uses_vol,
                "volume_warning": vol_warn,
            })

    return {
        "ok": True,
        "bars": n,
        "volume_available": df.volume_available,
        "results": results,
    }


def main() -> None:
    try:
        raw = sys.stdin.read()
        payload = json.loads(raw)
        apply_resource_limits(
            cpu_seconds=int(payload.get("cpu_limit_s", 5)),
            mem_mb=int(payload.get("mem_limit_mb", 256)),
        )
        mode = payload.get("mode")
        if mode == "indicator":
            result = _run_indicator(payload)
        elif mode == "strategy":
            result = _run_strategy(payload)
        elif mode == "overlay":
            result = _run_overlays(payload)
        else:
            result = {"ok": False, "stage": "input", "error": {"type": "ValueError", "line": 1, "message": f"Unknown mode: {mode}"}}
    except MemoryError:
        result = {"ok": False, "stage": "memory", "error": {"type": "MemoryError", "line": 1, "message": "Sandbox memory limit exceeded."}}
    except Exception as exc:
        result = {"ok": False, "stage": "sandbox", "error": {"type": type(exc).__name__, "line": 1, "message": str(exc)}}
    sys.stdout.write(json.dumps(result))


if __name__ == "__main__":
    main()
