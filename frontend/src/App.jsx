import { useCallback, useEffect, useMemo, useState } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { AppContext } from './context.js';
import { get } from './api.js';
import Dashboard from './pages/Dashboard.jsx';
import Agents from './pages/Agents.jsx';
import Strategy from './pages/Strategy.jsx';
import Indicators from './pages/Indicators.jsx';
import Optimization from './pages/Optimization.jsx';
import Backtest from './pages/Backtest.jsx';
import Results from './pages/Results.jsx';
import Experiments from './pages/Experiments.jsx';
import Analytics from './pages/Analytics.jsx';

const NAV = [
  ['/dashboard', 'Dashboard'],
  ['/agents', 'AI Agents'],
  ['/strategy', 'Strategy'],
  ['/indicators', 'Indicators'],
  ['/optimization', 'Optimization'],
  ['/backtest', 'Backtest'],
  ['/results', 'Results'],
  ['/experiments', 'Experiments'],
  ['/analytics', 'Analytics'],
];

export default function App() {
  const [datasets, setDatasets] = useState([]);
  const [datasetId, setDatasetIdState] = useState(() => Number(localStorage.getItem('il_dataset')) || null);
  const [online, setOnline] = useState(null);

  const reloadDatasets = useCallback(async () => {
    try {
      const list = await get('/api/datasets');
      setDatasets(list);
      setOnline(true);
      setDatasetIdState((current) => {
        if (current && list.some((d) => d.id === current)) return current;
        return list.length ? list[list.length - 1].id : null;
      });
    } catch {
      setOnline(false);
    }
  }, []);

  useEffect(() => { reloadDatasets(); }, [reloadDatasets]);

  const setDatasetId = (id) => {
    localStorage.setItem('il_dataset', String(id));
    setDatasetIdState(id);
  };

  const value = useMemo(() => ({ datasets, datasetId, setDatasetId, reloadDatasets }),
    [datasets, datasetId, reloadDatasets]);

  return (
    <AppContext.Provider value={value}>
      <div className="layout">
        <aside className="sidebar">
          <div className="brand">
            <div className="brand-mark">IL</div>
            <div>
              <div className="brand-name">Indicator Lab</div>
              <div className="brand-sub">Autonomous Indicator Discovery &amp; Backtesting</div>
            </div>
          </div>
          <nav>
            {NAV.map(([to, label]) => (
              <NavLink key={to} to={to} className={({ isActive }) => (isActive ? 'nav active' : 'nav')}>
                {label}
              </NavLink>
            ))}
          </nav>
          <div className="sidebar-foot">
            <div className={`dot ${online === null ? '' : online ? 'on' : 'off'}`} />
            <span>{online === null ? 'connecting…' : online ? 'API connected' : 'API unreachable'}</span>
          </div>
        </aside>
        <main className="content">
          <div className="topbar">
            <label className="dataset-picker">
              <span>Dataset</span>
              <select value={datasetId || ''} onChange={(e) => setDatasetId(Number(e.target.value))}>
                {datasets.length === 0 && <option value="">No datasets imported</option>}
                {datasets.map((d) => (
                  <option key={d.id} value={d.id}>{d.name} ({d.symbol}, {d.rows.toLocaleString()} bars)</option>
                ))}
              </select>
            </label>
          </div>
          <Routes>
            <Route path="/" element={<Navigate to="/dashboard" replace />} />
            <Route path="/dashboard" element={<Dashboard />} />
            <Route path="/agents" element={<Agents />} />
            <Route path="/strategy" element={<Strategy />} />
            <Route path="/indicators" element={<Indicators />} />
            <Route path="/optimization" element={<Optimization />} />
            <Route path="/backtest" element={<Backtest />} />
            <Route path="/results" element={<Results />} />
            <Route path="/experiments" element={<Experiments />} />
            <Route path="/analytics" element={<Analytics />} />
          </Routes>
        </main>
      </div>
    </AppContext.Provider>
  );
}
