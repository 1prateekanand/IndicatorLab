import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { get } from '../api.js';
import { useApp } from '../context.js';
import { Card, ErrorBox } from '../components/ui.jsx';
import Plot from '../components/Plot.jsx';

const TIMEFRAMES = ['1m', '5m', '10m', '1H', '4H'];
const CHUNK_SIZE = 1000;
const DEFAULT_VISIBLE_BARS = 150;
const MIN_VISIBLE_BARS = 15;
const MAX_VISIBLE_BARS = 2500;
const PREFETCH_THRESHOLD = 140;
const MAX_BUFFER_BARS = 15000;

function shiftYearsIso(isoDate, years) {
  if (!isoDate) return '';
  const y = Number(isoDate.slice(0, 4)) - years;
  return `${y}${isoDate.slice(4, 10)}`;
}

function formatIstAxis(ts) {
  if (!ts) return '';
  return `${ts.slice(0, 10)} ${ts.slice(11, 16)}`;
}

function fmtPrice(v) {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return '—';
  return Number(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function computeVisibleYRange(bars, range) {
  if (!bars.length) return undefined;
  const start = Math.max(0, Math.floor(range ? range[0] : 0));
  const end = Math.min(bars.length - 1, Math.ceil(range ? range[1] : bars.length - 1));
  let minLow = Infinity;
  let maxHigh = -Infinity;
  for (let i = Math.max(0, start); i <= Math.max(0, end); i++) {
    const b = bars[i];
    if (!b) continue;
    if (b.low < minLow) minLow = b.low;
    if (b.high > maxHigh) maxHigh = b.high;
  }
  if (!Number.isFinite(minLow) || !Number.isFinite(maxHigh)) return undefined;
  const span = Math.max(maxHigh - minLow, maxHigh * 0.001, 1);
  const pad = span * 0.06;
  return [minLow - pad, maxHigh + pad];
}

function clampRange(r0, r1, barCount, hasMoreEarlier, hasMoreNewer) {
  const span = Math.max(MIN_VISIBLE_BARS, r1 - r0);
  let a = r0;
  let b = r1;
  const minBound = -0.5;
  const maxBound = barCount - 0.5;

  if (!hasMoreNewer && b > maxBound) {
    b = maxBound;
    a = b - span;
  }
  if (!hasMoreEarlier && a < minBound) {
    a = minBound;
    b = Math.min(hasMoreNewer ? a + span : maxBound, a + span);
  }
  if (!hasMoreEarlier && !hasMoreNewer && b - a > barCount) {
    a = minBound;
    b = Math.max(minBound + MIN_VISIBLE_BARS, maxBound);
  }
  return [a, b];
}

export default function MarketData() {
  const { datasets, datasetId, setDatasetId, reloadDatasets } = useApp();
  const [statusInfo, setStatusInfo] = useState(null);
  const [symbol, setSymbol] = useState('NIFTY50');

  const [timeframe, setTimeframe] = useState('1m');
  const [preset, setPreset] = useState('full');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');

  const [bars, setBars] = useState([]);
  const [loadingInitial, setLoadingInitial] = useState(false);
  const [fetchingMore, setFetchingMore] = useState(false);
  const [edgeFlags, setEdgeFlags] = useState({ atOldest: false, atNewest: true });
  const [hoveredIdx, setHoveredIdx] = useState(null);
  const [lockedIdx, setLockedIdx] = useState(null);
  const [error, setError] = useState(null);

  // Imperative refs for 60fps pan/zoom without React re-renders
  const plotRef = useRef(null);
  const barsRef = useRef([]);
  const viewRangeRef = useRef(null);
  const boundaryRef = useRef({ hasMoreEarlier: false, hasMoreNewer: false });
  const edgeFlagsRef = useRef({ atOldest: false, atNewest: true });
  const cacheRef = useRef(new Map());
  const inflightRef = useRef(new Set());
  const isDraggingRef = useRef(false);
  const pendingChunksRef = useRef([]);
  const suppressRelayoutRef = useRef(false);
  const pinchRef = useRef(null);
  const activeKeyRef = useRef('');

  const niftyDataset = useMemo(() => {
    const matching = datasets.filter((d) => d.symbol === symbol);
    return matching.find((d) => d.name === 'NIFTY50_1MIN') || matching[matching.length - 1] || statusInfo?.nifty_dataset || null;
  }, [datasets, symbol, statusInfo]);

  const activeDatasetId = niftyDataset?.id || null;

  useEffect(() => {
    if (activeDatasetId && Number(datasetId) !== Number(activeDatasetId)) {
      setDatasetId(activeDatasetId);
    }
  }, [activeDatasetId, datasetId, setDatasetId]);

  const loadStatus = useCallback(async () => {
    try {
      const s = await get('/api/market-data/status');
      setStatusInfo(s);
      if (s.nifty_dataset && !datasets.some((d) => d.id === s.nifty_dataset.id)) {
        reloadDatasets();
      }
      return s;
    } catch (e) {
      setError(e.message);
      return null;
    }
  }, [datasets, reloadDatasets]);

  useEffect(() => {
    let timer = null;
    let cancelled = false;
    const poll = async () => {
      const s = await loadStatus();
      if (cancelled) return;
      if (!s?.nifty_dataset && s?.sync?.state !== 'error') {
        timer = setTimeout(poll, 1500);
      }
    };
    poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [loadStatus]);

  const minBoundDate = niftyDataset?.start_ts ? niftyDataset.start_ts.slice(0, 10) : '';
  const maxBoundDate = niftyDataset?.end_ts ? niftyDataset.end_ts.slice(0, 10) : '';

  const cacheKey = activeDatasetId ? `${activeDatasetId}::${timeframe}::${startDate}::${endDate}` : '';
  activeKeyRef.current = cacheKey;

  const saveToCache = useCallback((key, nextBars, nextBoundary, nextRange) => {
    if (!key) return;
    cacheRef.current.set(key, {
      bars: nextBars,
      hasMoreEarlier: nextBoundary.hasMoreEarlier,
      hasMoreNewer: nextBoundary.hasMoreNewer,
      viewRange: nextRange,
    });
  }, []);

  const syncEdgeFlags = useCallback((barsLen, boundary, range) => {
    const nextOldest = Boolean(barsLen > 0 && !boundary.hasMoreEarlier && range && range[0] <= 0.5);
    const nextNewest = Boolean(barsLen > 0 && !boundary.hasMoreNewer && range && range[1] >= barsLen - 1.5);
    if (edgeFlagsRef.current.atOldest !== nextOldest || edgeFlagsRef.current.atNewest !== nextNewest) {
      const next = { atOldest: nextOldest, atNewest: nextNewest };
      edgeFlagsRef.current = next;
      setEdgeFlags(next);
    }
  }, []);

  const applyViewState = useCallback((nextBars, nextBoundary, nextRange, key = activeKeyRef.current) => {
    barsRef.current = nextBars;
    boundaryRef.current = nextBoundary;
    viewRangeRef.current = nextRange;
    saveToCache(key, nextBars, nextBoundary, nextRange);
    setBars(nextBars);
    syncEdgeFlags(nextBars.length, nextBoundary, nextRange);
  }, [saveToCache, syncEdgeFlags]);

  const applyRelayoutImmediate = useCallback((r0, r1) => {
    const curBars = barsRef.current;
    if (!curBars.length) return;
    const { hasMoreEarlier, hasMoreNewer } = boundaryRef.current;
    const [cr0, cr1] = clampRange(r0, r1, curBars.length, hasMoreEarlier, hasMoreNewer);
    viewRangeRef.current = [cr0, cr1];
    if (activeKeyRef.current && cacheRef.current.has(activeKeyRef.current)) {
      cacheRef.current.get(activeKeyRef.current).viewRange = [cr0, cr1];
    }
    syncEdgeFlags(curBars.length, boundaryRef.current, [cr0, cr1]);
    const yRange = computeVisibleYRange(curBars, [cr0, cr1]);
    if (plotRef.current?.relayout) {
      suppressRelayoutRef.current = true;
      plotRef.current.relayout({
        'xaxis.range': [cr0, cr1],
        ...(yRange ? { 'yaxis.range': yRange } : {}),
      });
      requestAnimationFrame(() => { suppressRelayoutRef.current = false; });
    }
    return [cr0, cr1];
  }, [syncEdgeFlags]);

  // Load initial latest window for a (timeframe, startDate, endDate) or restore from cache
  const loadInitialOrCached = useCallback(async ({ forceLatest = false, resetZoom = false } = {}) => {
    if (!activeDatasetId || !cacheKey) {
      barsRef.current = [];
      viewRangeRef.current = null;
      setBars([]);
      return;
    }

    const cached = cacheRef.current.get(cacheKey);
    if (cached && !forceLatest) {
      const restoredRange = resetZoom
        ? [Math.max(-0.5, cached.bars.length - DEFAULT_VISIBLE_BARS - 0.5), cached.bars.length - 0.5]
        : cached.viewRange;
      applyViewState(cached.bars, {
        hasMoreEarlier: cached.hasMoreEarlier,
        hasMoreNewer: cached.hasMoreNewer,
      }, restoredRange, cacheKey);
      setHoveredIdx(null);
      setLockedIdx(null);
      return;
    }

    const reqKey = `${cacheKey}::latest`;
    if (inflightRef.current.has(reqKey)) return;
    inflightRef.current.add(reqKey);
    setLoadingInitial(true);
    setError(null);
    const keyAtStart = cacheKey;

    try {
      const params = new URLSearchParams({ timeframe, limit: String(CHUNK_SIZE) });
      if (startDate) params.set('start_date', startDate);
      if (endDate) params.set('end_date', endDate);
      const res = await get(`/api/market-data/datasets/${activeDatasetId}/candles?${params.toString()}`);
      const loaded = res.bars || [];
      const curSpan = (!resetZoom && cached?.viewRange)
        ? Math.max(MIN_VISIBLE_BARS, cached.viewRange[1] - cached.viewRange[0])
        : DEFAULT_VISIBLE_BARS;
      const visible = Math.min(loaded.length || curSpan, curSpan);
      const initRange = loaded.length
        ? [Math.max(-0.5, loaded.length - visible - 0.5), loaded.length - 0.5]
        : null;
      const nextBoundary = {
        hasMoreEarlier: Boolean(res.has_more_earlier),
        hasMoreNewer: Boolean(res.has_more_newer),
      };
      if (activeKeyRef.current === keyAtStart) {
        applyViewState(loaded, nextBoundary, initRange, keyAtStart);
        setHoveredIdx(null);
        setLockedIdx(null);
      } else {
        saveToCache(keyAtStart, loaded, nextBoundary, initRange);
      }
    } catch (e) {
      if (activeKeyRef.current === keyAtStart) setError(e.message);
    } finally {
      inflightRef.current.delete(reqKey);
      if (activeKeyRef.current === keyAtStart) setLoadingInitial(false);
    }
  }, [activeDatasetId, cacheKey, timeframe, startDate, endDate, applyViewState, saveToCache]);

  useEffect(() => {
    loadInitialOrCached();
  }, [loadInitialOrCached]);

  // Chronological deduplicated merge helper
  const mergeChunkIntoBuffer = useCallback((direction, chunkBars, hasMoreFlag, keyAtStart) => {
    const isCurrent = activeKeyRef.current === keyAtStart;
    const baseState = isCurrent
      ? {
          bars: barsRef.current,
          hasMoreEarlier: boundaryRef.current.hasMoreEarlier,
          hasMoreNewer: boundaryRef.current.hasMoreNewer,
          viewRange: viewRangeRef.current,
        }
      : cacheRef.current.get(keyAtStart);

    if (!baseState) return;
    const existing = baseState.bars;
    const seen = new Set(existing.map((b) => b.time));
    const uniqueNew = (chunkBars || []).filter((b) => !seen.has(b.time));

    let merged;
    let nextRange = baseState.viewRange ? [...baseState.viewRange] : null;
    const nextBoundary = {
      hasMoreEarlier: baseState.hasMoreEarlier,
      hasMoreNewer: baseState.hasMoreNewer,
    };

    if (direction === 'earlier') {
      merged = uniqueNew.length ? [...uniqueNew, ...existing] : existing;
      nextBoundary.hasMoreEarlier = Boolean(hasMoreFlag) && uniqueNew.length > 0;
      if (nextRange && uniqueNew.length > 0) {
        nextRange = [nextRange[0] + uniqueNew.length, nextRange[1] + uniqueNew.length];
      }
      if (merged.length > MAX_BUFFER_BARS) {
        const excess = merged.length - MAX_BUFFER_BARS;
        merged = merged.slice(0, MAX_BUFFER_BARS);
        nextBoundary.hasMoreNewer = true;
        if (nextRange && nextRange[1] > merged.length - 0.5) {
          const span = nextRange[1] - nextRange[0];
          nextRange = [Math.max(-0.5, merged.length - 0.5 - span), merged.length - 0.5];
        }
        void excess;
      }
    } else {
      merged = uniqueNew.length ? [...existing, ...uniqueNew] : existing;
      nextBoundary.hasMoreNewer = Boolean(hasMoreFlag) && uniqueNew.length > 0;
      if (merged.length > MAX_BUFFER_BARS) {
        const drop = merged.length - MAX_BUFFER_BARS;
        merged = merged.slice(drop);
        nextBoundary.hasMoreEarlier = true;
        if (nextRange) {
          nextRange = [Math.max(-0.5, nextRange[0] - drop), Math.max(MIN_VISIBLE_BARS, nextRange[1] - drop)];
        }
      }
    }

    if (isCurrent) {
      if (direction === 'earlier' && uniqueNew.length > 0) {
        setLockedIdx((prev) => (prev === null ? null : prev + uniqueNew.length));
      }
      applyViewState(merged, nextBoundary, nextRange, keyAtStart);
    } else {
      saveToCache(keyAtStart, merged, nextBoundary, nextRange);
    }
  }, [applyViewState, saveToCache]);

  const flushPendingChunks = useCallback(() => {
    if (!pendingChunksRef.current.length || isDraggingRef.current) return;
    const items = pendingChunksRef.current.splice(0, pendingChunksRef.current.length);
    for (const item of items) {
      mergeChunkIntoBuffer(item.direction, item.bars, item.hasMore, item.keyAtStart);
    }
  }, [mergeChunkIntoBuffer]);

  // Dynamic boundary fetching with deduplicated in-flight keys
  const fetchBoundaryChunk = useCallback(async (direction) => {
    const keyAtStart = activeKeyRef.current;
    const curBars = barsRef.current;
    const { hasMoreEarlier, hasMoreNewer } = boundaryRef.current;
    if (!activeDatasetId || !keyAtStart || !curBars.length) return;
    if (direction === 'earlier' && !hasMoreEarlier) return;
    if (direction === 'newer' && !hasMoreNewer) return;

    const cursor = direction === 'earlier' ? curBars[0].time : curBars[curBars.length - 1].time;
    const reqKey = `${keyAtStart}::${direction}::${cursor}`;
    if (inflightRef.current.has(reqKey)) return;

    inflightRef.current.add(reqKey);
    setFetchingMore(true);

    try {
      const params = new URLSearchParams({ timeframe, limit: String(CHUNK_SIZE) });
      if (startDate) params.set('start_date', startDate);
      if (endDate) params.set('end_date', endDate);
      if (direction === 'earlier') params.set('before', cursor);
      else params.set('after', cursor);

      const res = await get(`/api/market-data/datasets/${activeDatasetId}/candles?${params.toString()}`);
      const hasMoreFlag = direction === 'earlier' ? res.has_more_earlier : res.has_more_newer;
      if (isDraggingRef.current && activeKeyRef.current === keyAtStart) {
        pendingChunksRef.current.push({
          direction,
          bars: res.bars || [],
          hasMore: hasMoreFlag,
          keyAtStart,
        });
      } else {
        mergeChunkIntoBuffer(direction, res.bars || [], hasMoreFlag, keyAtStart);
      }
    } catch (e) {
      if (activeKeyRef.current === keyAtStart) setError(e.message);
    } finally {
      inflightRef.current.delete(reqKey);
      if (activeKeyRef.current === keyAtStart) setFetchingMore(false);
    }
  }, [activeDatasetId, timeframe, startDate, endDate, mergeChunkIntoBuffer]);

  const maybeLoadBoundary = useCallback((r0, r1) => {
    const curBars = barsRef.current;
    if (!curBars.length) return;
    if (r0 <= PREFETCH_THRESHOLD && boundaryRef.current.hasMoreEarlier) {
      fetchBoundaryChunk('earlier');
    }
    if (r1 >= curBars.length - 1 - PREFETCH_THRESHOLD && boundaryRef.current.hasMoreNewer) {
      fetchBoundaryChunk('newer');
    }
  }, [fetchBoundaryChunk]);

  // Date presets
  const applyPreset = (p) => {
    setPreset(p);
    setHoveredIdx(null);
    setLockedIdx(null);
    if (p === 'full' || !maxBoundDate) {
      setStartDate('');
      setEndDate('');
      return;
    }
    const years = p === '1y' ? 1 : p === '3y' ? 3 : p === '5y' ? 5 : 0;
    if (years > 0) {
      const targetStart = shiftYearsIso(maxBoundDate, years);
      setStartDate(minBoundDate && targetStart < minBoundDate ? minBoundDate : targetStart);
      setEndDate(maxBoundDate);
    }
  };

  // Interactive Zoom & Pan helpers
  const zoomAroundFraction = useCallback((relX, factor) => {
    const curBars = barsRef.current;
    if (!curBars.length || !viewRangeRef.current) return;
    const [r0, r1] = viewRangeRef.current;
    const span = Math.max(MIN_VISIBLE_BARS, r1 - r0);
    const maxSpan = Math.max(MIN_VISIBLE_BARS, Math.min(MAX_VISIBLE_BARS, curBars.length));
    const newSpan = Math.max(MIN_VISIBLE_BARS, Math.min(maxSpan, span * factor));
    const anchor = r0 + relX * span;
    const newR0 = anchor - relX * newSpan;
    const newR1 = newR0 + newSpan;
    const applied = applyRelayoutImmediate(newR0, newR1);
    if (applied) maybeLoadBoundary(applied[0], applied[1]);
  }, [applyRelayoutImmediate, maybeLoadBoundary]);

  const shiftViewportByBars = useCallback((deltaBars) => {
    const curBars = barsRef.current;
    if (!curBars.length || !viewRangeRef.current) return;
    const [r0, r1] = viewRangeRef.current;
    const applied = applyRelayoutImmediate(r0 + deltaBars, r1 + deltaBars);
    if (applied) maybeLoadBoundary(applied[0], applied[1]);
  }, [applyRelayoutImmediate, maybeLoadBoundary]);

  // Button handlers (Section 4 controls)
  const handleEarlier = () => {
    if (!viewRangeRef.current) return;
    const span = Math.max(MIN_VISIBLE_BARS, viewRangeRef.current[1] - viewRangeRef.current[0]);
    const step = Math.max(10, Math.round(span * 0.65));
    if (viewRangeRef.current[0] - step <= PREFETCH_THRESHOLD && boundaryRef.current.hasMoreEarlier) {
      fetchBoundaryChunk('earlier');
    }
    shiftViewportByBars(-step);
  };

  const handleNewer = () => {
    if (!viewRangeRef.current) return;
    const curBars = barsRef.current;
    const span = Math.max(MIN_VISIBLE_BARS, viewRangeRef.current[1] - viewRangeRef.current[0]);
    const step = Math.max(10, Math.round(span * 0.65));
    if (viewRangeRef.current[1] + step >= curBars.length - 1 - PREFETCH_THRESHOLD && boundaryRef.current.hasMoreNewer) {
      fetchBoundaryChunk('newer');
    }
    shiftViewportByBars(step);
  };

  const handleLatest = () => {
    const curBars = barsRef.current;
    if (!curBars.length) return;
    if (boundaryRef.current.hasMoreNewer) {
      loadInitialOrCached({ forceLatest: true, resetZoom: false });
      return;
    }
    const span = viewRangeRef.current
      ? Math.max(MIN_VISIBLE_BARS, viewRangeRef.current[1] - viewRangeRef.current[0])
      : DEFAULT_VISIBLE_BARS;
    applyRelayoutImmediate(curBars.length - span - 0.5, curBars.length - 0.5);
  };

  const handleZoomIn = () => zoomAroundFraction(0.5, 0.7);
  const handleZoomOut = () => zoomAroundFraction(0.5, 1.4);
  const handleResetView = () => {
    const curBars = barsRef.current;
    if (!curBars.length) return;
    if (boundaryRef.current.hasMoreNewer) {
      loadInitialOrCached({ forceLatest: true, resetZoom: true });
      return;
    }
    const vis = Math.min(curBars.length, DEFAULT_VISIBLE_BARS);
    applyRelayoutImmediate(Math.max(-0.5, curBars.length - vis - 0.5), curBars.length - 0.5);
  };

  // Plotly relayout / drag handler
  const syncFromPlotlyRelayout = useCallback((ev, el) => {
    if (suppressRelayoutRef.current || !ev) return;
    let r0 = ev['xaxis.range[0]'] ?? ev['xaxis.range']?.[0];
    let r1 = ev['xaxis.range[1]'] ?? ev['xaxis.range']?.[1];
    if (r0 === undefined || r1 === undefined) {
      const fullRange = el?._fullLayout?.xaxis?.range;
      if (Array.isArray(fullRange) && fullRange.length === 2) {
        r0 = fullRange[0];
        r1 = fullRange[1];
      }
    }
    if (r0 === undefined || r1 === undefined) return;
    const n0 = Number(r0);
    const n1 = Number(r1);
    if (!Number.isFinite(n0) || !Number.isFinite(n1)) return;

    const curBars = barsRef.current;
    const [cr0, cr1] = clampRange(n0, n1, curBars.length, boundaryRef.current.hasMoreEarlier, boundaryRef.current.hasMoreNewer);
    viewRangeRef.current = [cr0, cr1];
    if (activeKeyRef.current && cacheRef.current.has(activeKeyRef.current)) {
      cacheRef.current.get(activeKeyRef.current).viewRange = [cr0, cr1];
    }
    syncEdgeFlags(curBars.length, boundaryRef.current, [cr0, cr1]);

    const yRange = computeVisibleYRange(curBars, [cr0, cr1]);
    if (yRange && el) {
      suppressRelayoutRef.current = true;
      const update = { 'yaxis.range': yRange };
      if (cr0 !== n0 || cr1 !== n1) update['xaxis.range'] = [cr0, cr1];
      plotRef.current?.relayout(update);
      requestAnimationFrame(() => { suppressRelayoutRef.current = false; });
    }
    maybeLoadBoundary(cr0, cr1);
  }, [maybeLoadBoundary, syncEdgeFlags]);

  // Capture-phase wheel handler: cursor-anchored zoom, Shift+wheel & trackpad horizontal scroll, zero page scroll
  const handleChartWheel = useCallback((e, el) => {
    e.preventDefault();
    e.stopPropagation();

    const curBars = barsRef.current;
    if (!curBars.length || !viewRangeRef.current) return;
    const size = el?._fullLayout?._size;
    const plotW = Math.max(100, size?.w || el.clientWidth || 800);
    const leftPad = size?.l || 16;
    const rect = el.getBoundingClientRect();
    const relX = Math.max(0, Math.min(1, (e.clientX - rect.left - leftPad) / plotW));

    const isHorizontal = Math.abs(e.deltaX) > Math.abs(e.deltaY) || (e.shiftKey && Math.abs(e.deltaY) > 0);
    if (isHorizontal) {
      const horizPx = Math.abs(e.deltaX) >= Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      const span = Math.max(MIN_VISIBLE_BARS, viewRangeRef.current[1] - viewRangeRef.current[0]);
      const shiftBars = (horizPx / plotW) * span;
      shiftViewportByBars(shiftBars);
      return;
    }

    const clampedDelta = Math.max(-180, Math.min(180, e.deltaY));
    const factor = Math.exp(clampedDelta * 0.0018);
    zoomAroundFraction(relX, factor);
  }, [shiftViewportByBars, zoomAroundFraction]);

  // Touch pinch-to-zoom & drag release handling
  const handleTouchStart = useCallback((e) => {
    if (e.touches.length === 1) {
      isDraggingRef.current = true;
      pinchRef.current = null;
    } else if (e.touches.length === 2) {
      isDraggingRef.current = true;
      const [t1, t2] = [e.touches[0], e.touches[1]];
      const dist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
      pinchRef.current = { dist, midX: (t1.clientX + t2.clientX) / 2 };
    }
  }, []);

  const handleTouchMove = useCallback((e) => {
    if (e.touches.length === 2 && pinchRef.current && plotRef.current?.el) {
      e.preventDefault();
      const [t1, t2] = [e.touches[0], e.touches[1]];
      const dist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
      const midX = (t1.clientX + t2.clientX) / 2;
      if (dist > 10 && pinchRef.current.dist > 10) {
        const el = plotRef.current.el;
        const size = el._fullLayout?._size;
        const rect = el.getBoundingClientRect();
        const plotW = Math.max(100, size?.w || el.clientWidth || 800);
        const relX = Math.max(0, Math.min(1, (midX - rect.left - (size?.l || 16)) / plotW));
        const factor = pinchRef.current.dist / dist;
        zoomAroundFraction(relX, factor);
      }
      pinchRef.current = { dist, midX };
    }
  }, [zoomAroundFraction]);

  const handleTouchEnd = useCallback((e) => {
    if (e.touches.length < 2) pinchRef.current = null;
    if (e.touches.length === 0) {
      isDraggingRef.current = false;
      flushPendingChunks();
    }
  }, [flushPendingChunks]);

  const handlePointerDown = useCallback(() => {
    isDraggingRef.current = true;
  }, []);

  const handlePointerUp = useCallback(() => {
    if (!isDraggingRef.current) return;
    isDraggingRef.current = false;
    flushPendingChunks();
  }, [flushPendingChunks]);

  useEffect(() => {
    const release = () => {
      if (isDraggingRef.current) {
        isDraggingRef.current = false;
        pinchRef.current = null;
        flushPendingChunks();
      }
    };
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);
    window.addEventListener('blur', release);
    return () => {
      window.removeEventListener('pointerup', release);
      window.removeEventListener('pointercancel', release);
      window.removeEventListener('blur', release);
    };
  }, [flushPendingChunks]);

  const selectedBar = useMemo(() => {
    if (!bars.length) return null;
    const idx = hoveredIdx ?? lockedIdx ?? (bars.length - 1);
    return bars[idx] || bars[bars.length - 1];
  }, [bars, hoveredIdx, lockedIdx]);

  const handlePlotHover = useCallback((ev) => {
    const pt = ev?.points?.[0];
    if (pt && typeof pt.pointNumber === 'number') {
      setHoveredIdx(pt.pointNumber);
    }
  }, []);

  const handlePlotClick = useCallback((ev) => {
    const pt = ev?.points?.[0];
    if (pt && typeof pt.pointNumber === 'number') {
      setLockedIdx(pt.pointNumber);
    }
  }, []);

  const handlePlotUnhover = useCallback(() => {
    setHoveredIdx(null);
  }, []);

  const plotConfig = useMemo(() => ({
    scrollZoom: false,
    doubleClick: false,
    displayModeBar: false,
  }), []);

  const { traces, layout } = useMemo(() => {
    if (!bars.length) return { traces: null, layout: {} };
    const x = bars.map((b) => formatIstAxis(b.time));
    const hoverText = bars.map((b) => {
      const chg = b.close - b.open;
      const pct = b.open ? (chg / b.open) * 100 : 0;
      const sign = chg >= 0 ? '+' : '';
      return (
        `${formatIstAxis(b.time)} IST<br>` +
        `O: ${fmtPrice(b.open)} &nbsp; H: ${fmtPrice(b.high)}<br>` +
        `L: ${fmtPrice(b.low)} &nbsp; C: ${fmtPrice(b.close)}<br>` +
        `Chg: ${sign}${chg.toFixed(2)} (${sign}${pct.toFixed(2)}%)`
      );
    });

    const activeRange = viewRangeRef.current || [
      Math.max(-0.5, bars.length - DEFAULT_VISIBLE_BARS - 0.5),
      bars.length - 0.5,
    ];
    const yRange = computeVisibleYRange(bars, activeRange);

    const chartTraces = [
      {
        type: 'candlestick',
        name: symbol,
        x,
        open: bars.map((b) => b.open),
        high: bars.map((b) => b.high),
        low: bars.map((b) => b.low),
        close: bars.map((b) => b.close),
        text: hoverText,
        hoverinfo: 'text',
        increasing: { line: { color: '#22c55e', width: 1 }, fillcolor: '#22c55e' },
        decreasing: { line: { color: '#ef4444', width: 1 }, fillcolor: '#ef4444' },
        whiskerwidth: 0.4,
      },
    ];

    const chartLayout = {
      dragmode: 'pan',
      hovermode: 'x',
      showlegend: false,
      xaxis: {
        type: 'category',
        nticks: 10,
        range: activeRange,
        rangeslider: { visible: false },
        showspikes: true,
        spikemode: 'across',
        spikesnap: 'cursor',
        spikecolor: '#4f8cff',
        spikethickness: 1,
        tickangle: 0,
        title: { text: 'Time (IST)', standoff: 10 },
      },
      yaxis: {
        side: 'right',
        fixedrange: true,
        ...(yRange ? { range: yRange, autorange: false } : { autorange: true }),
        showspikes: true,
        spikemode: 'across',
        spikecolor: '#4f8cff',
        spikethickness: 1,
        tickformat: ',.2f',
      },
      margin: { l: 16, r: 74, t: 16, b: 48 },
    };

    return { traces: chartTraces, layout: chartLayout };
  }, [bars, symbol]);

  const barChange = selectedBar ? selectedBar.close - selectedBar.open : 0;
  const barChangePct = selectedBar && selectedBar.open ? (barChange / selectedBar.open) * 100 : 0;
  const isBull = barChange >= 0;

  const syncDiagnostic = statusInfo?.sync?.state === 'error' ? statusInfo.sync.diagnostic : null;
  const isSyncing = statusInfo?.sync?.state === 'syncing' && !activeDatasetId;
  const isAtOldestEdge = edgeFlags.atOldest;
  const isAtNewestEdge = edgeFlags.atNewest;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Market Data</h1>
        </div>
        <div className="card-actions" style={{ alignItems: 'center', gap: 12 }}>
          <select aria-label="Instrument" value={symbol} onChange={(e) => setSymbol(e.target.value)}>
            <option value="NIFTY50">NIFTY50</option>
          </select>
          <div className="pill-row">
            {TIMEFRAMES.map((tf) => (
              <button
                key={tf}
                className={timeframe === tf ? 'primary' : ''}
                disabled={!activeDatasetId || loadingInitial}
                onClick={() => {
                  setTimeframe(tf);
                  setHoveredIdx(null);
                  setLockedIdx(null);
                }}
              >
                {tf}
              </button>
            ))}
          </div>
        </div>
      </div>

      <ErrorBox error={error || syncDiagnostic} />

      {isSyncing && (
        <div className="info-box">
          {statusInfo.sync.message || 'Loading repository NIFTY50 historical CSV files…'}
        </div>
      )}

      <Card style={{ marginBottom: 0 }}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 10,
            flexWrap: 'wrap',
            marginBottom: 12,
          }}
        >
          <div className="pill-row" style={{ alignItems: 'center' }}>
            {[
              ['full', 'Full History'],
              ['1y', 'Last 1Y'],
              ['3y', 'Last 3Y'],
              ['5y', 'Last 5Y'],
            ].map(([k, lbl]) => (
              <button
                key={k}
                className={`tab ${preset === k ? 'active' : ''}`}
                disabled={!activeDatasetId}
                onClick={() => applyPreset(k)}
              >
                {lbl}
              </button>
            ))}
            <input
              aria-label="Start date"
              type="date"
              min={minBoundDate}
              max={maxBoundDate}
              value={startDate}
              disabled={!activeDatasetId}
              onChange={(e) => {
                setPreset('custom');
                setStartDate(e.target.value);
              }}
            />
            <span className="muted">→</span>
            <input
              aria-label="End date"
              type="date"
              min={minBoundDate}
              max={maxBoundDate}
              value={endDate}
              disabled={!activeDatasetId}
              onChange={(e) => {
                setPreset('custom');
                setEndDate(e.target.value);
              }}
            />
          </div>

          <div className="pill-row" style={{ alignItems: 'center' }}>
            <button disabled={!bars.length || Boolean(isAtOldestEdge)} onClick={handleEarlier}>« Earlier</button>
            <button disabled={!bars.length || Boolean(isAtNewestEdge)} onClick={handleNewer}>Newer »</button>
            <button disabled={!bars.length} onClick={handleLatest}>Latest</button>
            <button title="Zoom In" aria-label="Zoom In" disabled={!bars.length} onClick={handleZoomIn}>Zoom In</button>
            <button title="Zoom Out" aria-label="Zoom Out" disabled={!bars.length} onClick={handleZoomOut}>Zoom Out</button>
            <button title="Reset View" aria-label="Reset View" disabled={!bars.length} onClick={handleResetView}>Reset View</button>
          </div>
        </div>

        {selectedBar && (
          <div
            className="mono"
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 16,
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '6px 10px',
              marginBottom: 8,
              background: '#0b0f17',
              border: '1px solid var(--line)',
              borderRadius: 8,
              fontSize: 12,
            }}
          >
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'center' }}>
              <strong>{symbol} · {timeframe}</strong>
              <span className="muted">{formatIstAxis(selectedBar.time)} IST</span>
              <span>O <strong style={{ color: isBull ? 'var(--good)' : 'var(--bad)' }}>{fmtPrice(selectedBar.open)}</strong></span>
              <span>H <strong style={{ color: isBull ? 'var(--good)' : 'var(--bad)' }}>{fmtPrice(selectedBar.high)}</strong></span>
              <span>L <strong style={{ color: isBull ? 'var(--good)' : 'var(--bad)' }}>{fmtPrice(selectedBar.low)}</strong></span>
              <span>C <strong style={{ color: isBull ? 'var(--good)' : 'var(--bad)' }}>{fmtPrice(selectedBar.close)}</strong></span>
              <span style={{ color: isBull ? 'var(--good)' : 'var(--bad)' }}>
                {barChange >= 0 ? '+' : ''}{barChange.toFixed(2)} ({barChange >= 0 ? '+' : ''}{barChangePct.toFixed(2)}%)
              </span>
            </div>
            {(fetchingMore || loadingInitial) && (
              <span className="muted" style={{ fontSize: 11 }}>Loading candles…</span>
            )}
          </div>
        )}

        {traces ? (
          <Plot
            plotRef={plotRef}
            data={traces}
            layout={layout}
            config={plotConfig}
            height={580}
            touchAction="none"
            onHover={handlePlotHover}
            onClick={handlePlotClick}
            onUnhover={handlePlotUnhover}
            onRelayout={syncFromPlotlyRelayout}
            onRelayouting={syncFromPlotlyRelayout}
            onWheel={handleChartWheel}
            onPointerDown={handlePointerDown}
            onPointerUp={handlePointerUp}
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
          />
        ) : (
          <div className="empty" style={{ padding: '60px 18px' }}>
            {syncDiagnostic
              ? `Repository historical CSV files could not be loaded: ${syncDiagnostic}`
              : isSyncing
                ? 'Preparing NIFTY 50 historical candles from repository CSV files…'
                : loadingInitial
                  ? 'Loading historical candles…'
                  : 'No historical candles matched the selected range.'}
          </div>
        )}
      </Card>
    </>
  );
}
