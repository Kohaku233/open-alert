import { CandlestickSeries, ColorType, CrosshairMode, HistogramSeries, LineStyle, createChart } from 'lightweight-charts';
import type { IChartApi, IPriceLine, ISeriesApi, MouseEventParams, UTCTimestamp } from 'lightweight-charts';
import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Alert } from '../../src/contracts/domain.js';
import type { CandlePage, CandleTimeframe } from '../../src/markets/candles.js';
import type { MarketQuote } from '../../src/markets/quotes.js';
import { request, errorText } from '../api.js';
import { t } from '../i18n.js';
import { useTheme } from '../theme.js';
import { formatQuotePrice } from '../utils.js';
import { EmptyState, LoadingStatus } from './Surface.js';
import { Button } from './ui/button.js';

const FRAMES: CandleTimeframe[] = ['1m', '5m', '15m', '1h', '4h', '1d', '1w'];
const STEP: Record<CandleTimeframe, number> = { '1m': 60_000, '5m': 300_000, '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000, '1w': 604_800_000 };
const FRAME_KEY = 'open-alert-chart-frame';
type Bar = { time: number; open: number; high: number; low: number; close: number; volume: number };

// Lightweight Charts renders UTC; shift into the viewer's zone so axis labels read as local time.
const offset = (ms: number) => -new Date(ms).getTimezoneOffset() * 60_000;
const toChart = (ms: number) => ((ms + offset(ms)) / 1000) as UTCTimestamp;
function readFrame(): CandleTimeframe {
  try { const saved = localStorage.getItem(FRAME_KEY); if (FRAMES.includes(saved as CandleTimeframe)) return saved as CandleTimeframe; } catch { /* default */ }
  return '4h';
}
function decimals(tickSize: string) { const [, fraction = ''] = tickSize.split('.'); return Math.min(10, fraction.replace(/0+$/, '').length); }
function cssVar(name: string, fallback: string) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback; }

export type ChartLineAction = { alert: Alert; price: number };
export const NativeChart = memo(function NativeChart({ market, tick, alerts, source, canCreate, onRetarget, onCreateAt }: {
  market: { instrument: string; tickSize: string }; tick: MarketQuote | undefined; alerts: Alert[]; source: string; canCreate: boolean;
  onRetarget: (action: ChartLineAction) => void; onCreateAt: (price: number) => void;
}) {
  const { theme } = useTheme();
  const host = useRef<HTMLDivElement>(null);
  const chartRef = useRef<{ chart: IChartApi; candles: ISeriesApi<'Candlestick'>; volume: ISeriesApi<'Histogram'> } | null>(null);
  const bars = useRef<Bar[]>([]);
  const paging = useRef({ loading: false, done: false, epoch: 0 });
  const lines = useRef(new Map<string, { line: IPriceLine; alert: Alert }>());
  const drag = useRef<{ id: string; pointerId: number; from: number; price: number } | null>(null);
  const callbacks = useRef({ onRetarget, onCreateAt });
  callbacks.current = { onRetarget, onCreateAt };
  const [frame, setFrame] = useState(readFrame);
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [dragLabel, setDragLabel] = useState<{ y: number; price: number } | null>(null);
  const [hover, setHover] = useState<{ y: number; price: number } | null>(null);
  const [olderState, setOlderState] = useState<'idle' | 'loading' | 'done'>('idle');
  const hoverHold = useRef(false);
  const tickSize = Number(market.tickSize) || 0.01;
  const round = (price: number) => Number((Math.round(price / tickSize) * tickSize).toFixed(decimals(market.tickSize)));

  // Chart instance: rebuilt per market so price formatting matches the instrument tick size.
  useLayoutEffect(() => {
    const container = host.current!;
    const chart = createChart(container, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: cssVar('--muted-foreground', '#959c94'), fontFamily: cssVar('--mono-font', 'monospace'), fontSize: 11, attributionLogo: true },
      grid: { vertLines: { color: 'transparent' }, horzLines: { color: cssVar('--line', 'rgba(128,128,128,.2)') } },
      rightPriceScale: { borderColor: cssVar('--line', '#333') },
      timeScale: { borderColor: cssVar('--line', '#333'), timeVisible: true, secondsVisible: false, rightOffset: 6 },
      crosshair: { mode: CrosshairMode.Normal },
    });
    const precision = decimals(market.tickSize);
    const up = cssVar('--signal', '#d6ff4f'), down = cssVar('--danger', '#ff8b8b');
    const candles = chart.addSeries(CandlestickSeries, { upColor: up, downColor: down, borderUpColor: up, borderDownColor: down, wickUpColor: up, wickDownColor: down,
      priceFormat: { type: 'price', precision, minMove: Number(market.tickSize) || 0.01 } });
    const volume = chart.addSeries(HistogramSeries, { priceScaleId: 'volume', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false });
    chart.priceScale('volume').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    chartRef.current = { chart, candles, volume };
    const onCrosshair = (param: MouseEventParams) => {
      if (drag.current) return;
      if (!param.point) { window.setTimeout(() => { if (!hoverHold.current) setHover(null); }, 500); return; }
      const price = candles.coordinateToPrice(param.point.y);
      if (price !== null) setHover({ y: param.point.y, price: round(price) });
    };
    chart.subscribeCrosshairMove(onCrosshair);
    return () => { chart.unsubscribeCrosshairMove(onCrosshair); lines.current.clear(); chartRef.current = null; chart.remove(); };
  }, [market.instrument, market.tickSize]);

  useEffect(() => {
    const current = chartRef.current;
    if (!current) return;
    const up = cssVar('--signal', '#d6ff4f'), down = cssVar('--danger', '#ff8b8b'), line = cssVar('--line', '#333');
    current.chart.applyOptions({ layout: { textColor: cssVar('--muted-foreground', '#959c94') }, grid: { horzLines: { color: line } }, rightPriceScale: { borderColor: line }, timeScale: { borderColor: line } });
    current.candles.applyOptions({ upColor: up, downColor: down, borderUpColor: up, borderDownColor: down, wickUpColor: up, wickDownColor: down });
    paint();
  }, [theme, market.instrument]);

  function paint() {
    const current = chartRef.current;
    if (!current) return;
    const upVolume = cssVar('--signal', '#d6ff4f') + '55', downVolume = cssVar('--danger', '#ff8b8b') + '55';
    current.candles.setData(bars.current.map(b => ({ time: toChart(b.time), open: b.open, high: b.high, low: b.low, close: b.close })));
    current.volume.setData(bars.current.map(b => ({ time: toChart(b.time), value: b.volume, color: b.close >= b.open ? upVolume : downVolume })));
  }
  const merge = (incoming: Bar[]) => {
    const byTime = new Map(bars.current.map(b => [b.time, b]));
    for (const bar of incoming) byTime.set(bar.time, bar);
    bars.current = [...byTime.values()].sort((a, b) => a.time - b.time);
  };
  const fromPage = (page: CandlePage): Bar[] => page.candles.map(([time, open, high, low, close, volume]) => ({ time, open, high, low, close, volume }));
  const url = (before?: number) => `/api/candles?instrument=${encodeURIComponent(market.instrument)}&timeframe=${frame}${before === undefined ? '' : `&before=${before}`}`;

  // Latest page per market/timeframe, then older pages on demand as the user scrolls left.
  useEffect(() => {
    const current = chartRef.current;
    if (!current) return;
    const epoch = ++paging.current.epoch;
    paging.current.loading = false; paging.current.done = false;
    bars.current = []; paint(); setState('loading'); setError(''); setOlderState('idle');
    const controller = new AbortController();
    void request<CandlePage>(url(), 'GET', undefined, { signal: controller.signal }).then(page => {
      if (epoch !== paging.current.epoch) return;
      bars.current = fromPage(page); paint();
      paging.current.done = page.done;
      current.chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, bars.current.length - 120), to: bars.current.length + 6 });
      setState(bars.current.length ? 'ready' : 'failed');
      if (!bars.current.length) setError(t('交易所暂未返回这个周期的 K 线。'));
    }).catch(cause => { if (epoch === paging.current.epoch && !controller.signal.aborted) { setState('failed'); setError(errorText(cause)); } });
    const older = () => {
      const range = current.chart.timeScale().getVisibleLogicalRange();
      if (!range || range.from > 30 || paging.current.loading || paging.current.done || !bars.current.length) return;
      paging.current.loading = true; setOlderState('loading');
      void request<CandlePage>(url(bars.current[0]!.time), 'GET', undefined, { signal: controller.signal }).then(page => {
        if (epoch !== paging.current.epoch) return;
        const before = bars.current.length;
        merge(fromPage(page));
        const added = bars.current.length - before;
        const view = current.chart.timeScale().getVisibleLogicalRange();
        paint();
        if (view && added) current.chart.timeScale().setVisibleLogicalRange({ from: view.from + added, to: view.to + added });
        paging.current.done = page.done || added === 0;
        setOlderState(paging.current.done ? 'done' : 'idle');
      }).catch(() => { if (epoch === paging.current.epoch) setOlderState('idle'); })
        .finally(() => { if (epoch === paging.current.epoch) paging.current.loading = false; });
    };
    current.chart.timeScale().subscribeVisibleLogicalRangeChange(older);
    // Reconcile the forming bar's true OHLCV with the exchange once a minute.
    const reconcile = window.setInterval(() => {
      if (document.visibilityState === 'hidden' || !bars.current.length) return;
      void request<CandlePage>(url(), 'GET', undefined, { signal: controller.signal }).then(page => {
        if (epoch !== paging.current.epoch) return;
        const last = bars.current.at(-1)!.time;
        for (const bar of fromPage(page)) if (bar.time >= last) apply(bar);
      }).catch(() => {});
    }, 60_000);
    return () => { controller.abort(); window.clearInterval(reconcile); current.chart.timeScale().unsubscribeVisibleLogicalRangeChange(older); };
  }, [market.instrument, frame, retry]);

  function apply(bar: Bar) {
    const current = chartRef.current, last = bars.current.at(-1);
    if (!current || !last || bar.time < last.time) return;
    if (bar.time === last.time) bars.current[bars.current.length - 1] = bar; else bars.current.push(bar);
    current.candles.update({ time: toChart(bar.time), open: bar.open, high: bar.high, low: bar.low, close: bar.close });
    current.volume.update({ time: toChart(bar.time), value: bar.volume, color: (bar.close >= bar.open ? cssVar('--signal', '#d6ff4f') : cssVar('--danger', '#ff8b8b')) + '55' });
  }
  // Each live trade moves the forming candle; a new bucket opens a fresh bar.
  useEffect(() => {
    if (!tick || tick.instrument !== market.instrument || state !== 'ready') return;
    const last = bars.current.at(-1);
    if (!last) return;
    const step = STEP[frame], at = tick.timestamp ?? tick.observedAt;
    const bucket = Math.floor(at / step) * step;
    if (bucket < last.time) return;
    apply(bucket === last.time
      ? { ...last, high: Math.max(last.high, tick.price), low: Math.min(last.low, tick.price), close: tick.price }
      : { time: bucket, open: last.close, high: Math.max(last.close, tick.price), low: Math.min(last.close, tick.price), close: tick.price, volume: 0 });
  }, [tick, frame, state, market.instrument]);

  const draggable = (alert: Alert) => !alert.pending;
  // Alert lines mirror saved thresholds; a line under drag keeps its preview price.
  useEffect(() => {
    const current = chartRef.current;
    if (!current) return;
    const up = cssVar('--signal', '#d6ff4f'), down = cssVar('--danger', '#ff8b8b'), muted = cssVar('--muted-foreground', '#959c94');
    const keep = new Set<string>();
    for (const alert of alerts) {
      keep.add(alert.id);
      const live = alert.enabled && !alert.triggered;
      const focused = selected === alert.id || drag.current?.id === alert.id;
      const options = { price: drag.current?.id === alert.id ? drag.current.price : alert.threshold,
        color: live ? alert.side === 'upper' ? up : down : muted, lineWidth: (focused ? 2 : 1) as 1 | 2,
        lineStyle: live ? LineStyle.Solid : LineStyle.Dashed, axisLabelVisible: true,
        title: `${alert.side === 'upper' ? '↑' : '↓'} ${[...alert.name].slice(0, 14).join('')}` };
      const existing = lines.current.get(alert.id);
      if (existing) { existing.line.applyOptions(options); existing.alert = alert; }
      else lines.current.set(alert.id, { line: current.candles.createPriceLine(options), alert });
    }
    for (const [id, entry] of lines.current) if (!keep.has(id)) { current.candles.removePriceLine(entry.line); lines.current.delete(id); }
    if (selected && !keep.has(selected)) setSelected(null);
  }, [alerts, selected, market.instrument, theme, dragLabel === null]);

  // Pointer handling: mouse drags a line directly; touch selects a line first, then drags it.
  useEffect(() => {
    const container = host.current!, current = chartRef.current;
    if (!current) return;
    const nearest = (y: number, radius: number) => {
      let best: { id: string; distance: number } | null = null;
      for (const [id, entry] of lines.current) {
        if (!draggable(entry.alert)) continue;
        const coordinate = current.candles.priceToCoordinate(entry.alert.threshold);
        if (coordinate === null) continue;
        const distance = Math.abs(coordinate - y);
        if (distance <= radius && (!best || distance < best.distance)) best = { id, distance };
      }
      return best?.id ?? null;
    };
    const localY = (event: PointerEvent) => event.clientY - container.getBoundingClientRect().top;
    const lock = (locked: boolean) => current.chart.applyOptions({ handleScroll: !locked, handleScale: !locked });
    const down = (event: PointerEvent) => {
      if (event.button > 0) return;
      const y = localY(event), touch = event.pointerType !== 'mouse';
      const id = nearest(y, touch ? 16 : 7);
      if (!id) { if (touch) setSelected(null); return; }
      if (touch && selectedRef.current !== id) { setSelected(id); event.stopPropagation(); return; }
      const entry = lines.current.get(id)!;
      drag.current = { id, pointerId: event.pointerId, from: entry.alert.threshold, price: entry.alert.threshold };
      lock(true); setHover(null); setSelected(id);
      container.setPointerCapture(event.pointerId);
      event.preventDefault(); event.stopPropagation();
      setDragLabel({ y, price: entry.alert.threshold });
    };
    const move = (event: PointerEvent) => {
      const active = drag.current;
      if (!active) {
        if (event.pointerType === 'mouse') container.classList.toggle('is-line-hover', nearest(localY(event), 7) !== null);
        return;
      }
      if (event.pointerId !== active.pointerId) return;
      event.preventDefault(); event.stopPropagation();
      const y = localY(event), raw = current.candles.coordinateToPrice(y);
      if (raw === null || raw <= 0) return;
      active.price = round(raw);
      lines.current.get(active.id)?.line.applyOptions({ price: active.price });
      setDragLabel({ y, price: active.price });
    };
    const up = (event: PointerEvent) => {
      const active = drag.current;
      if (!active || event.pointerId !== active.pointerId) return;
      drag.current = null; lock(false); setDragLabel(null);
      if (container.hasPointerCapture(event.pointerId)) container.releasePointerCapture(event.pointerId);
      const entry = lines.current.get(active.id);
      if (!entry) return;
      entry.line.applyOptions({ price: entry.alert.threshold });
      if (event.type === 'pointerup' && Math.abs(active.price - active.from) >= tickSize / 2) callbacks.current.onRetarget({ alert: entry.alert, price: active.price });
    };
    // Block the browser's own pan/scroll while a line is held on touch screens.
    const touchMove = (event: TouchEvent) => { if (drag.current) event.preventDefault(); };
    container.addEventListener('pointerdown', down, { capture: true });
    container.addEventListener('pointermove', move, { capture: true });
    container.addEventListener('pointerup', up, { capture: true });
    container.addEventListener('pointercancel', up, { capture: true });
    container.addEventListener('touchmove', touchMove, { capture: true, passive: false });
    return () => {
      container.removeEventListener('pointerdown', down, { capture: true });
      container.removeEventListener('pointermove', move, { capture: true });
      container.removeEventListener('pointerup', up, { capture: true });
      container.removeEventListener('pointercancel', up, { capture: true });
      container.removeEventListener('touchmove', touchMove, { capture: true });
      if (drag.current) { drag.current = null; lock(false); }
    };
  }, [market.instrument, market.tickSize]);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  function chooseFrame(next: CandleTimeframe) {
    setFrame(next);
    try { localStorage.setItem(FRAME_KEY, next); } catch { /* keep in-memory choice */ }
  }
  const selectedAlert = alerts.find(alert => alert.id === selected);
  return <>
    <div className="native-chart-bar" role="group" aria-label={t('K 线周期')}>
      {FRAMES.map(value => <Button key={value} type="button" variant="ghost" aria-pressed={frame === value} onClick={() => chooseFrame(value)}>{value === '1d' ? '1D' : value === '1w' ? '1W' : value}</Button>)}
      <span className="native-chart-status" role="status">{olderState === 'loading' ? t('正在加载更早的 K 线…') : olderState === 'done' ? t('已到交易所最早数据') : ''}</span>
    </div>
    <div className="chart-shell native-chart-shell" data-selected-line={selected ? 'true' : 'false'}>
      <div ref={host} className="native-chart" data-chart-state={state}/>
      {state === 'loading' && <div className="chart-loading"><LoadingStatus>{t('正在读取 {0} K 线…', source)}</LoadingStatus><div className="skeleton-chart-grid" aria-hidden="true"/></div>}
      {state === 'failed' && <EmptyState className="chart-fallback" role="status"><strong>{t('K 线暂时不可用')}</strong><p>{error || t('交易所暂时没有返回数据。')}</p><Button variant="default" className="primary" onClick={() => setRetry(value => value + 1)}>{t('重试')}</Button></EmptyState>}
      {dragLabel && <div className="chart-drag-label" style={{ top: dragLabel.y }} aria-live="polite">{t('松开后确认')} · {formatQuotePrice(dragLabel.price)}</div>}
      {canCreate && hover && !dragLabel && state === 'ready' && <Button type="button" className="chart-create-at" style={{ top: hover.y }}
        onPointerEnter={() => { hoverHold.current = true; }} onPointerLeave={() => { hoverHold.current = false; setHover(null); }}
        onClick={() => { hoverHold.current = false; callbacks.current.onCreateAt(hover.price); setHover(null); }}
        aria-label={t('在 {0} 创建警报', formatQuotePrice(hover.price))}>+ {formatQuotePrice(hover.price)}</Button>}
    </div>
    <div className="chart-bottom"><div className="chart-caption"><span role="status">{selectedAlert ? t('已选中「{0}」，按住这条线上下拖动改价。', selectedAlert.name) : t('拖动警报线改价；悬停或长按图表后点 + 在该价位创建警报。')}</span></div><span className="chart-disclaimer">{t('内置图表 · K 线来自 {0}，与警报使用同一交易所数据。', source)}</span></div>
  </>;
});
