import { useEffect, useRef } from 'react';
import Plotly from 'plotly.js-dist-min';

const THEME = {
  paper_bgcolor: 'rgba(0,0,0,0)',
  plot_bgcolor: 'rgba(0,0,0,0)',
  font: { color: '#c9d1e0', family: 'Inter, system-ui, sans-serif', size: 12 },
  xaxis: { gridcolor: '#232a38', zerolinecolor: '#232a38' },
  yaxis: { gridcolor: '#232a38', zerolinecolor: '#232a38' },
  margin: { l: 56, r: 20, t: 36, b: 44 },
  legend: { orientation: 'h', y: -0.2 },
};

// Renders Plotly figures. ``figure`` is {data, layout}; layout is merged with the dark theme.
export default function Plot({
  data,
  layout = {},
  height = 360,
  config = {},
  plotRef,
  onHover,
  onClick,
  onUnhover,
  onRelayout,
  onRelayouting,
  onWheel,
  onPointerDown,
  onPointerUp,
  onTouchStart,
  onTouchMove,
  onTouchEnd,
  touchAction,
}) {
  const ref = useRef(null);
  const handlersRef = useRef({
    onHover,
    onClick,
    onUnhover,
    onRelayout,
    onRelayouting,
    onWheel,
  });
  handlersRef.current = {
    onHover,
    onClick,
    onUnhover,
    onRelayout,
    onRelayouting,
    onWheel,
  };

  useEffect(() => {
    const el = ref.current;
    if (!el || !data) return;
    const merged = {
      ...THEME,
      ...layout,
      height,
      xaxis: { ...THEME.xaxis, ...(layout.xaxis || {}) },
      yaxis: { ...THEME.yaxis, ...(layout.yaxis || {}) },
    };
    Plotly.react(el, data, merged, {
      displaylogo: false,
      responsive: true,
      scrollZoom: true,
      ...config,
    });

    if (plotRef) {
      plotRef.current = {
        el,
        relayout: (update) => Plotly.relayout(el, update),
      };
    }

    if (typeof el.removeAllListeners === 'function') {
      el.removeAllListeners('plotly_hover');
      el.removeAllListeners('plotly_click');
      el.removeAllListeners('plotly_unhover');
      el.removeAllListeners('plotly_relayout');
      el.removeAllListeners('plotly_relayouting');
    }
    if (typeof el.on === 'function') {
      el.on('plotly_hover', (ev) => handlersRef.current.onHover?.(ev));
      el.on('plotly_click', (ev) => handlersRef.current.onClick?.(ev));
      el.on('plotly_unhover', (ev) => handlersRef.current.onUnhover?.(ev));
      el.on('plotly_relayout', (ev) => handlersRef.current.onRelayout?.(ev, el));
      el.on('plotly_relayouting', (ev) => handlersRef.current.onRelayouting?.(ev, el));
    }
    return () => {};
  }, [data, layout, height, config, plotRef]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const wheelListener = (e) => {
      if (handlersRef.current.onWheel) {
        handlersRef.current.onWheel(e, el);
      }
    };
    el.addEventListener('wheel', wheelListener, { passive: false, capture: true });
    return () => {
      el.removeEventListener('wheel', wheelListener, { capture: true });
    };
  }, []);

  useEffect(() => () => {
    if (plotRef) plotRef.current = null;
    if (ref.current) Plotly.purge(ref.current);
  }, [plotRef]);

  return (
    <div
      ref={ref}
      style={{ width: '100%', height, ...(touchAction ? { touchAction } : {}) }}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchEnd}
    />
  );
}
