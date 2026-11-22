"""FastAPI application. Every metric returned here is computed from stored data or live workers."""
from __future__ import annotations

import json
from contextlib import asynccontextmanager
from pathlib import Path

import numpy as np
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from . import analytics, data, ranking, significance
from .agents.controller import AgentController
from .agents.research import ResearchSettings
from .agents.runtime import system_metrics
from .config import DATA_DIR, DEFAULT_BACKTEST, DEFAULT_SPLIT, MIN_TRADES, BacktestConfig, CostModel
from .db import get_db
from .evaluator import Evaluator, ResearchConfig
from .optimizer import OBJECTIVES, PRUNERS, SAMPLERS, OptimizationConfig
from .registry import REGISTRY
from .strategy import (DIRECTIONS, MAX_INDICATORS, STOP_LOSS_CHOICES, TARGET_CHOICES, StrategySpec,
                       spec_from_dict)

controller = AgentController()


@asynccontextmanager
async def lifespan(app: FastAPI):
    get_db()
    REGISTRY.discover()
    recovered = controller.recover_after_restart()
    app.state.recovered = recovered
    yield
    controller.stop_all(wait=5.0)


app = FastAPI(title="Indicator Lab API", version="1.0.0", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
                   allow_methods=["*"], allow_headers=["*"])


# -- request models -------------------------------------------------------------------------
class IndicatorIn(BaseModel):
    name: str
    params: dict[str, float] = Field(default_factory=dict)


class StrategyIn(BaseModel):
    indicators: list[IndicatorIn] = Field(min_length=1, max_length=MAX_INDICATORS)
    min_votes: int = 1
    direction: str = "both"
    stop_loss_pct: float = 0.5
    target_pct: float = 1.0


class ImportIn(BaseModel):
    path: str
    name: str
    symbol: str
    timeframe: str = "1min"
    replace: bool = False


class SyntheticIn(BaseModel):
    name: str = "SYNTH_1m_demo"
    days: int = Field(60, ge=5, le=500)
    seed: int = 42


class BacktestIn(BaseModel):
    dataset_id: int
    strategy: StrategyIn
    split: str = "validation"
    initial_capital: float | None = None
    position_pct: float | None = None
    brokerage_per_order: float | None = None
    charges_pct: float | None = None
    slippage_points: float | None = None
    chart_timeframe: str = "5min"


class AgentsStartIn(BaseModel):
    dataset_id: int
    cycles: int = 1
    population_size: int = 16
    generations: int = 6
    hill_climb_steps: int = 20
    tuning_trials: int = 30
    walk_forward_top_k: int = 5
    max_indicators: int = 4
    seed: int = 42


class OptimizationIn(BaseModel):
    dataset_id: int
    study_name: str = Field(min_length=1, max_length=80)
    n_trials: int = 100
    sampler: str = "tpe"
    pruner: str = "median"
    n_jobs: int = 1
    objective: str = "net_profit"
    max_indicators: int = 4
    choices_per_param: int = 5
    seed: int | None = 42


# -- helpers -------------------------------------------------------------------------------
def _research_config(min_trades: int = MIN_TRADES) -> ResearchConfig:
    return ResearchConfig(backtest=DEFAULT_BACKTEST, split=DEFAULT_SPLIT, min_trades=min_trades)


def _spec(body: StrategyIn) -> StrategySpec:
    try:
        return StrategySpec.build([i.model_dump() for i in body.indicators], min_votes=body.min_votes,
                                  direction=body.direction, stop_loss_pct=body.stop_loss_pct,
                                  target_pct=body.target_pct)
    except (ValueError, KeyError) as exc:
        raise HTTPException(400, str(exc)) from exc


def _backtest_config(body: BacktestIn) -> ResearchConfig:
    costs = CostModel(
        brokerage_per_order=body.brokerage_per_order if body.brokerage_per_order is not None
        else DEFAULT_BACKTEST.costs.brokerage_per_order,
        charges_pct=body.charges_pct if body.charges_pct is not None else DEFAULT_BACKTEST.costs.charges_pct,
        slippage_points=body.slippage_points if body.slippage_points is not None
        else DEFAULT_BACKTEST.costs.slippage_points)
    bt = BacktestConfig(
        initial_capital=body.initial_capital or DEFAULT_BACKTEST.initial_capital,
        position_pct=body.position_pct or DEFAULT_BACKTEST.position_pct,
        costs=costs, no_entry_after_minute=DEFAULT_BACKTEST.no_entry_after_minute,
        square_off_minute=DEFAULT_BACKTEST.square_off_minute)
    return ResearchConfig(backtest=bt, split=DEFAULT_SPLIT, min_trades=MIN_TRADES)


def _ds_or_404(dataset_id: int) -> dict:
    try:
        return data.get_dataset(dataset_id)
    except KeyError as exc:
        raise HTTPException(404, str(exc)) from exc


def _to_jsonable(obj):
    if isinstance(obj, dict):
        return {k: _to_jsonable(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_to_jsonable(v) for v in obj]
    if isinstance(obj, np.generic):
        return obj.item()
    return obj


# -- system and dashboard ----------------------------------------------------------------------
@app.get("/api/health")
def health():
    return {"status": "ok", "recovered_agents": getattr(app.state, "recovered", [])}


@app.get("/api/system")
def system():
    return system_metrics()


@app.get("/api/dashboard")
def dashboard(dataset_id: int | None = None):
    db = get_db()
    exp = db.query("SELECT status, COUNT(*) n FROM experiments GROUP BY status")
    by_status = {r["status"]: r["n"] for r in exp}
    trial_states = {"completed": 0, "pruned": 0, "failed": 0, "running": 0}
    for run in db.query("SELECT study_name FROM optimization_runs"):
        try:
            import optuna

            from .config import OPTUNA_STORAGE
            study = optuna.load_study(study_name=run["study_name"], storage=OPTUNA_STORAGE)
            for t in study.trials:
                key = {"COMPLETE": "completed", "PRUNED": "pruned", "FAIL": "failed",
                       "RUNNING": "running"}.get(t.state.name)
                if key:
                    trial_states[key] += 1
        except Exception:  # noqa: BLE001 - a missing study is skipped, not invented
            continue
    strategies = db.one("SELECT COUNT(DISTINCT strategy_hash) n FROM experiments")
    ds = dataset_id or (db.one("SELECT id FROM datasets ORDER BY id DESC LIMIT 1") or {}).get("id")
    summary = ranking.summary(ds, db=db) if ds else {}
    recent = db.query("SELECT ts, agent, level, message FROM agent_logs ORDER BY id DESC LIMIT 15")
    return {
        "system": system_metrics(),
        "indicators": REGISTRY.summary()["available"],
        "strategies_discovered": int(strategies["n"]) if strategies else 0,
        "trials": trial_states,
        "experiments": {"completed": by_status.get("completed", 0), "failed": by_status.get("failed", 0),
                        "pruned": by_status.get("pruned", 0)},
        "best_net_profit": summary.get("best_net_profit"),
        "best_win_rate": summary.get("best_win_rate"),
        "eligible_strategies": summary.get("eligible_strategies", 0),
        "validated_strategies": summary.get("validated_strategies", 0),
        "agents": controller.agents_status()["agents"],
        "recent_activity": recent,
    }


# -- datasets ---------------------------------------------------------------------------------
@app.get("/api/datasets")
def list_datasets():
    return data.list_datasets()


@app.post("/api/datasets/import")
def import_dataset(body: ImportIn):
    try:
        return data.import_csv(Path(body.path), name=body.name, symbol=body.symbol,
                               timeframe=body.timeframe, replace=body.replace)
    except (ValueError, FileNotFoundError) as exc:
        raise HTTPException(400, str(exc)) from exc


@app.post("/api/datasets/synthetic")
def create_synthetic(body: SyntheticIn):
    """Generates SYNTHETIC test data (random walk). Not market data; for pipeline testing only."""
    path = data.generate_synthetic(DATA_DIR / "samples" / f"{body.name}.csv", days=body.days, seed=body.seed)
    return data.import_csv(path, name=body.name, symbol="SYNTHETIC", timeframe="1min", replace=True)


@app.get("/api/datasets/{dataset_id}/candles")
def candles(dataset_id: int, timeframe: str = "5min", limit: int = Query(500, le=3000)):
    _ds_or_404(dataset_id)
    df = data.load_candles(dataset_id)
    if timeframe != "1min":
        df = df.resample(timeframe, label="left", closed="left").agg(
            {"open": "first", "high": "max", "low": "min", "close": "last", "volume": "sum"}).dropna()
    df = df.tail(limit)
    return {"timeframe": timeframe, "bars": [
        {"time": t.isoformat(), "open": float(r.open), "high": float(r.high), "low": float(r.low),
         "close": float(r.close)} for t, r in zip(df.index, df.itertuples())]}


# -- indicators --------------------------------------------------------------------------------
@app.get("/api/indicators")
def indicators():
    return {"summary": REGISTRY.summary(), "indicators": [d.to_dict() for d in REGISTRY.all()]}


@app.get("/api/indicators/{name}")
def indicator(name: str):
    try:
        return REGISTRY.get(name).to_dict()
    except KeyError as exc:
        raise HTTPException(404, str(exc)) from exc


@app.post("/api/indicators/reload")
def reload_indicators():
    return REGISTRY.discover()


@app.get("/api/strategy/templates")
def templates():
    avail = [d for d in REGISTRY.available()]
    if not avail:
        return []
    names = [{"name": d.name} for d in avail]
    out = [
        {"id": "single", "label": "Single indicator", "description": "One indicator, one vote",
         "spec": {"indicators": names[:1], "min_votes": 1, "direction": "both",
                  "stop_loss_pct": 0.5, "target_pct": 1.0}},
        {"id": "pair", "label": "Two-indicator consensus", "description": "Both indicators must agree",
         "spec": {"indicators": names[:2], "min_votes": min(2, len(names)), "direction": "both",
                  "stop_loss_pct": 0.5, "target_pct": 1.0}},
        {"id": "majority", "label": "Majority vote (all available)",
         "description": "Trade when most indicators agree",
         "spec": {"indicators": names[:MAX_INDICATORS], "min_votes": max(1, min(len(names), MAX_INDICATORS) // 2 + 1),
                  "direction": "both", "stop_loss_pct": 0.3, "target_pct": 0.8}},
    ]
    return out


@app.post("/api/strategy/describe")
def describe(body: StrategyIn):
    spec = _spec(body)
    return {"hash": spec.strategy_hash, "description": spec.describe(), "spec": spec.to_dict()}


@app.get("/api/strategy/options")
def strategy_options():
    return {"directions": list(DIRECTIONS), "stop_loss_choices": list(STOP_LOSS_CHOICES),
            "target_choices": list(TARGET_CHOICES), "max_indicators": MAX_INDICATORS,
            "defaults": {"initial_capital": DEFAULT_BACKTEST.initial_capital,
                         "position_pct": DEFAULT_BACKTEST.position_pct,
                         "brokerage_per_order": DEFAULT_BACKTEST.costs.brokerage_per_order,
                         "charges_pct": DEFAULT_BACKTEST.costs.charges_pct,
                         "slippage_points": DEFAULT_BACKTEST.costs.slippage_points,
                         "min_trades": MIN_TRADES}}


# -- backtest ---------------------------------------------------------------------------------
@app.post("/api/backtest")
def backtest(body: BacktestIn):
    _ds_or_404(body.dataset_id)
    if body.split not in ("train", "validation"):
        raise HTTPException(400, "use /api/backtest/oos for the out-of-sample split")
    spec = _spec(body.strategy)
    ev = Evaluator(body.dataset_id, _backtest_config(body))
    res, metrics = ev.simulate(spec, body.split)
    frame = ev.split_frame(body.split)
    chart = data.load_candles(body.dataset_id).loc[frame.index[0]:frame.index[-1]]
    if body.chart_timeframe != "1min":
        chart = chart.resample(body.chart_timeframe, label="left", closed="left").agg(
            {"open": "first", "high": "max", "low": "min", "close": "last", "volume": "sum"}).dropna()
    chart = chart.tail(1500)
    return _to_jsonable({
        "strategy": {"hash": spec.strategy_hash, "description": spec.describe(), "spec": spec.to_dict()},
        "split": body.split, "metrics": metrics,
        "trades": res.trades, "equity": analytics.equity_payload(res, frame.index, metrics),
        "candles": [{"time": t.isoformat(), "open": float(r.open), "high": float(r.high),
                     "low": float(r.low), "close": float(r.close)}
                    for t, r in zip(chart.index, chart.itertuples())],
    })


@app.post("/api/backtest/oos")
def backtest_oos(body: BacktestIn):
    """The only route that reads the out-of-sample tail. Runs once per strategy and is then stored."""
    _ds_or_404(body.dataset_id)
    spec = _spec(body.strategy)
    db = get_db()
    existing = db.one("SELECT metrics_json, created_at FROM oos_tests WHERE strategy_hash=? AND dataset_id=?",
                      (spec.strategy_hash, body.dataset_id))
    if existing:
        return {"already_run": True, "created_at": existing["created_at"],
                "metrics": json.loads(existing["metrics_json"])}
    ev = Evaluator(body.dataset_id, _backtest_config(body))
    _, metrics = ev.simulate(spec, "oos")
    from .db import utcnow

    db.execute("INSERT INTO oos_tests(strategy_hash, dataset_id, created_at, metrics_json) VALUES (?,?,?,?)",
               (spec.strategy_hash, body.dataset_id, utcnow(), db.dumps(metrics)))
    return {"already_run": False, "metrics": _to_jsonable(metrics)}


# -- agents -----------------------------------------------------------------------------------
@app.get("/api/agents")
def agents():
    return controller.agents_status()


@app.post("/api/agents/start")
def start_agents(body: AgentsStartIn):
    _ds_or_404(body.dataset_id)
    try:
        settings = ResearchSettings(**body.model_dump())
        return controller.start_agents(settings, _research_config())
    except (ValueError, RuntimeError) as exc:
        raise HTTPException(400, str(exc)) from exc


@app.post("/api/agents/{name}/{action}")
def agent_control(name: str, action: str):
    try:
        return controller.control(name, action)
    except (ValueError, RuntimeError) as exc:
        raise HTTPException(400, str(exc)) from exc


@app.get("/api/agents/{name}/logs")
def agent_logs(name: str, after: int = 0, limit: int = Query(200, le=1000)):
    rows = get_db().query("SELECT id, ts, level, message FROM agent_logs WHERE agent=? AND id>?"
                          " ORDER BY id DESC LIMIT ?", (name, after, limit))
    return list(reversed(rows))


@app.get("/api/agents/evaluation/snapshot")
def evaluation_snapshot():
    return controller.evaluation_snapshot() or {}


# -- optimization -----------------------------------------------------------------------------
@app.get("/api/optimization/options")
def optimization_options():
    return {"samplers": list(SAMPLERS), "pruners": list(PRUNERS), "objectives": list(OBJECTIVES),
            "max_indicators": MAX_INDICATORS,
            "notes": {"grid": "exhaustive over discretised choices; size is capped",
                      "cmaes": "continuous-only sampler; categorical choices fall back to independent sampling",
                      "nsga2": "multi-objective: net profit and drawdown; pruning is disabled"}}


@app.get("/api/optimization/runs")
def optimization_runs():
    return controller.optimization_runs()


@app.post("/api/optimization/start")
def start_optimization(body: OptimizationIn):
    _ds_or_404(body.dataset_id)
    try:
        cfg = OptimizationConfig(**body.model_dump())
        return controller.start_optimization(cfg, _research_config())
    except (ValueError, RuntimeError) as exc:
        raise HTTPException(400, str(exc)) from exc


@app.post("/api/optimization/{study_name}/{action}")
def optimization_control(study_name: str, action: str):
    try:
        return controller.control_optimization(f"optuna:{study_name}", action)
    except (ValueError, RuntimeError, KeyError) as exc:
        raise HTTPException(400, str(exc)) from exc


@app.get("/api/optimization/studies/{study_name}")
def study(study_name: str):
    try:
        return controller.optimization_study(study_name)
    except KeyError as exc:
        raise HTTPException(404, str(exc)) from exc


# -- results ---------------------------------------------------------------------------------
@app.get("/api/results/rankings")
def rankings(dataset_id: int, top: int = Query(10, ge=1, le=50), split: str = "train"):
    _ds_or_404(dataset_id)
    return {key: ranking.leaderboard(key, dataset_id, top=top, split=split) for key in ranking.RANKINGS}


@app.get("/api/results/rankings/{key}")
def ranking_one(key: str, dataset_id: int, top: int = Query(10, ge=1, le=50), split: str = "train"):
    _ds_or_404(dataset_id)
    try:
        return ranking.leaderboard(key, dataset_id, top=top, split=split)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@app.get("/api/results/strategies/{strategy_hash}")
def strategy_detail(strategy_hash: str, dataset_id: int):
    db = get_db()
    rows = db.query("SELECT split, spec_json, metrics_json, created_at, agent, study_name FROM experiments"
                    " WHERE strategy_hash=? AND dataset_id=? AND status='completed' ORDER BY id",
                    (strategy_hash, dataset_id))
    if not rows:
        raise HTTPException(404, "strategy not found")
    validations = db.query("SELECT * FROM validations WHERE strategy_hash=? AND dataset_id=? ORDER BY id DESC",
                           (strategy_hash, dataset_id))
    oos = db.one("SELECT metrics_json, created_at FROM oos_tests WHERE strategy_hash=? AND dataset_id=?",
                 (strategy_hash, dataset_id))
    return _to_jsonable({
        "hash": strategy_hash,
        "spec": json.loads(rows[0]["spec_json"]),
        "experiments": [{"split": r["split"], "metrics": json.loads(r["metrics_json"]),
                         "created_at": r["created_at"], "agent": r["agent"], "study": r["study_name"]}
                        for r in rows],
        "validations": [{**v, "segments": json.loads(v.pop("segments_json")),
                         "validated": bool(v["validated"])} for v in validations],
        "out_of_sample": {"metrics": json.loads(oos["metrics_json"]), "created_at": oos["created_at"]} if oos else None,
    })


# -- experiments ----------------------------------------------------------------------------
@app.get("/api/experiments")
def experiments(dataset_id: int | None = None, study: str | None = None, status: str | None = None,
                limit: int = Query(100, le=1000), offset: int = 0):
    where, params = [], []
    if dataset_id is not None:
        where.append("dataset_id=?")
        params.append(dataset_id)
    if study:
        where.append("study_name=?")
        params.append(study)
    if status:
        where.append("status=?")
        params.append(status)
    clause = ("WHERE " + " AND ".join(where)) if where else ""
    rows = get_db().query(
        f"SELECT id, created_at, agent, study_name, trial_number, strategy_hash, split, spec_json,"
        f" metrics_json, eligible, status, duration_s, error FROM experiments {clause}"
        f" ORDER BY id DESC LIMIT ? OFFSET ?", (*params, limit, offset))
    total = get_db().one(f"SELECT COUNT(*) n FROM experiments {clause}", params)
    out = []
    for r in rows:
        spec = json.loads(r.pop("spec_json"))
        r["description"] = spec_from_dict(spec).describe()
        r["spec"] = spec
        r["metrics"] = json.loads(r.pop("metrics_json")) if r["metrics_json"] else None
        r["eligible"] = bool(r["eligible"])
        out.append(r)
    return {"total": total["n"] if total else 0, "rows": out}


@app.get("/api/experiments/{experiment_id}")
def experiment(experiment_id: int):
    row = get_db().one("SELECT * FROM experiments WHERE id=?", (experiment_id,))
    if not row:
        raise HTTPException(404, "experiment not found")
    row["spec"] = json.loads(row.pop("spec_json"))
    row["metrics"] = json.loads(row.pop("metrics_json")) if row["metrics_json"] else None
    return row


# -- analytics ------------------------------------------------------------------------------
@app.get("/api/analytics/optuna/{study_name}/{chart}")
def optuna_chart(study_name: str, chart: str):
    try:
        return analytics.optuna_chart(study_name, chart)
    except (ValueError, KeyError) as exc:
        raise HTTPException(400, str(exc)) from exc
    except Exception as exc:  # noqa: BLE001 - Optuna raises ValueError for empty studies
        raise HTTPException(400, f"{type(exc).__name__}: {exc}") from exc


@app.get("/api/analytics/equity")
def equity(dataset_id: int, strategy_hash: str, split: str = "validation"):
    rows = get_db().query("SELECT spec_json FROM experiments WHERE strategy_hash=? AND dataset_id=? LIMIT 1",
                          (strategy_hash, dataset_id))
    if not rows:
        raise HTTPException(404, "strategy not found")
    if split not in ("train", "validation"):
        raise HTTPException(400, "equity analytics supports train and validation only")
    spec = spec_from_dict(json.loads(rows[0]["spec_json"]))
    return _to_jsonable(analytics.equity_series(dataset_id, spec, split, _research_config()))


@app.get("/api/analytics/walk_forward")
def walk_forward(dataset_id: int):
    return analytics.walk_forward_board(dataset_id)


@app.get("/api/analytics/train_vs_validation")
def train_vs_validation(dataset_id: int):
    return analytics.train_vs_validation(dataset_id)


# -- statistics: deflated Sharpe ratio and PBO (train split only) --------------------------------
class DsrIn(BaseModel):
    dataset_id: int
    split: str = "train"


class PboIn(BaseModel):
    dataset_id: int
    blocks: int = Field(8, ge=4, le=16)
    max_configs: int = Field(40, ge=2, le=200)


@app.post("/api/statistics/dsr")
def run_dsr(body: DsrIn):
    _ds_or_404(body.dataset_id)
    if body.split != "train":
        raise HTTPException(400, "DSR is computed on the train split only; OOS is never used for selection")
    return significance.compute_dsr(body.dataset_id, body.split, _research_config())


@app.post("/api/statistics/pbo")
def run_pbo(body: PboIn):
    _ds_or_404(body.dataset_id)
    try:
        return significance.compute_pbo(body.dataset_id, blocks=body.blocks, max_configs=body.max_configs,
                                        research=_research_config())
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@app.get("/api/statistics")
def list_statistics(dataset_id: int, kind: str | None = Query(None, pattern="^(dsr|pbo)$")):
    _ds_or_404(dataset_id)
    return _to_jsonable(significance.list_tests(dataset_id, kind))


@app.get("/api/statistics/experiments/{experiment_id}/dsr")
def experiment_dsr(experiment_id: int):
    found = significance.dsr_for_experiment(experiment_id)
    if found is None:
        return {"status": "not_performed", "reason": "no DSR has been computed for this experiment"}
    return found
