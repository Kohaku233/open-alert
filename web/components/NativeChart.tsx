import { CandlestickSeries, ColorType, CrosshairMode, HistogramSeries, LineSeries, LineStyle, PriceScaleMode, createChart } from 'lightweight-charts';
import type { HistogramData, IChartApi, IPriceLine, ISeriesApi, LineData, MouseEventParams, Time, UTCTimestamp } from 'lightweight-charts';
import { DrawingManager } from 'lightweight-charts-drawing';
import type { Drawing, DrawingKind } from 'lightweight-charts-drawing';
import type { CSSProperties } from 'react';
import { X } from 'lucide-react';
import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Alert } from '../../src/contracts/domain.js';
import type { CandlePage, CandleTimeframe } from '../../src/markets/candles.js';
import { bucketEnd, bucketStart, parseTimeframe, timeframeSupported } from '../../src/contracts/timeframes.js';
import { TimeframeMenu } from './TimeframeMenu.js';
import { DrawingEditBar } from './DrawingEditBar.js';
import { IndicatorMenu, IndicatorRow } from './ChartIndicators.js';
import { INDICATOR_COLORS, MAX_INDICATORS, computeIndicator, createIndicator, indicatorDefinition, parseIndicators } from '../indicators.js';
import type { IndicatorInstance, IndicatorKind, IndicatorResult } from '../indicators.js';
import { ALL_TOOLS, DrawingToolbar } from './DrawingToolbar.js';
import type { MarketQuote } from '../../src/markets/quotes.js';
import { request, errorText } from '../api.js';
import { t } from '../i18n.js';
import { useTheme } from '../theme.js';
import { formatQuotePrice } from '../utils.js';
import { EmptyState, LoadingStatus } from './Surface.js';
import { Button } from './ui/button.js';

const FRAME_KEY = 'open-alert-chart-frame';
const DRAWINGS_KEY = 'open-alert-drawings:';
const LOG_KEY = 'open-alert-chart-log';
const INDICATORS_KEY = 'open-alert-chart-indicators';
// Fallbacks match the light-theme tokens in chart.css.
const INDICATOR_FALLBACKS = ['#2f6fd6', '#b8650f', '#8a45c4', '#c2357a', '#13857a'];
type IndicatorSeries = ISeriesApi<'Line'> | ISeriesApi<'Histogram'>;
type Bar = { time: number; open: number; high: number; low: number; close: number; volume: number };

// Lightweight Charts renders UTC; shift into the viewer's zone so axis labels read as local time.
const offset = (ms: number) => -new Date(ms).getTimezoneOffset() * 60_000;
const toChart = (ms: number) => ((ms + offset(ms)) / 1000) as UTCTimestamp;
function readFrame(): CandleTimeframe {
  try { const saved = localStorage.getItem(FRAME_KEY); if (saved && parseTimeframe(saved) === saved) return saved; } catch { /* default */ }
  return '4h';
}
function readIndicators() { try { return parseIndicators(localStorage.getItem(INDICATORS_KEY)); } catch { return []; } }
const indicatorColor = (index: number) => cssVar(`--indicator-${index % INDICATOR_COLORS + 1}`, INDICATOR_FALLBACKS[index % INDICATOR_COLORS]!);
/** Line colours per indicator output, in definition order; MACD's histogram is coloured per bar instead. */
function indicatorColors(item: IndicatorInstance) {
  const own = indicatorColor(item.color);
  return indicatorDefinition(item.kind).lines.map(line => item.kind === 'macd' && line.key === 'signal' ? indicatorColor(item.color + 1) : own);
}
const macdBar = (value: number, previous: number | null | undefined) => {
  const strong = previous === null || previous === undefined || Math.abs(value) >= Math.abs(previous);
  return (value >= 0 ? cssVar('--signal', '#d6ff4f') : cssVar('--danger', '#ff8b8b')) + (strong ? 'cc' : '66');
};
function readLog() { try { return localStorage.getItem(LOG_KEY) === '1'; } catch { return false; } }
function decimals(tickSize: string) {
  // Market metadata uses scientific notation for small ticks (e.g. "1e-8").
  const [coefficient = '', exponent = '0'] = tickSize.toLowerCase().split('e');
  const [, fraction = ''] = coefficient.split('.');
  return Math.min(10, Math.max(0, fraction.replace(/0+$/, '').length - Number(exponent)));
}
function cssVar(name: string, fallback: string) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback; }
const volumeFormat = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 });
function countdown(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000)), days = Math.floor(total / 86_400);
  const pad = (value: number) => String(value).padStart(2, '0');
  const h = Math.floor(total / 3600) % 24, m = Math.floor(total / 60) % 60, s = total % 60;
  const clock = h || days ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  return days ? `${days}D ${clock}` : clock;
}
// Bars are sorted by time and toChart is monotonic, so the hovered chart time maps back by binary search.
function barIndexAt(list: Bar[], time: Time) {
  let lo = 0, hi = list.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1, at = toChart(list[mid]!.time);
    if (at === time) return mid;
    if (at < (time as number)) lo = mid + 1; else hi = mid - 1;
  }
  return -1;
}
function readDrawings(instrument: string) { try { return localStorage.getItem(DRAWINGS_KEY + instrument) ?? '[]'; } catch { return '[]'; } }
function saveDrawings(instrument: string, json: string) {
  try { if (json === '[]') localStorage.removeItem(DRAWINGS_KEY + instrument); else localStorage.setItem(DRAWINGS_KEY + instrument, json); } catch { /* storage full or blocked */ }
}

export type ChartLineAction = { alert: Alert; price: number };
export type ChartArmed = 'buy' | 'sell' | 'alert' | null;
/** A trading price line: an order (draggable to amend), the position entry or its liquidation price. */
export interface ChartTradeLine {
  id: string; price: number; tone: 'buy' | 'sell' | 'position' | 'liq' | 'tp' | 'sl'; style: 'solid' | 'dashed' | 'dotted'; title?: string;
  /** action: a labelled button on the chip that calls overlay.onAction (e.g. open the position's TP/SL editor). */
  chip?: { badge: string; text: string; qty: string; pnl?: { text: string; positive: boolean }; state?: string; action?: string };
  draggable?: boolean; cancellable?: boolean;
}
/** Host-owned overlay: when armed, one click on the price pane is handed to onArmedClick instead of the chart. */
export interface ChartOverlay {
  trading: boolean; lines: ChartTradeLine[]; armed: ChartArmed; caption?: string;
  ghost: (price: number) => { tone: 'buy' | 'sell' | 'alert'; text: string; hint: string } | null;
  onArmedClick: (price: number, keepArmed: boolean) => void;
  onModify: (id: string, price: number) => void; onCancel: (id: string) => void;
  onAction?: (id: string) => void;
  /** Drag label text for a line at a candidate price (e.g. the P&L a TP/SL would book); null keeps the default. */
  preview?: (id: string, price: number) => string | null;
}
export const NativeChart = memo(function NativeChart({ market, tick, alerts, source, canCreate, onRetarget, onCreateAt, overlay }: {
  market: { instrument: string; tickSize: string; venue?: 'binance' | 'okx' | 'mexc'; type?: 'spot' | 'swap' }; tick: MarketQuote | undefined; alerts: Alert[]; source: string; canCreate: boolean;
  onRetarget: (action: ChartLineAction) => void; onCreateAt: (price: number) => void; overlay?: ChartOverlay;
}) {
  const { theme } = useTheme();
  const host = useRef<HTMLDivElement>(null);
  const chartRef = useRef<{ chart: IChartApi; candles: ISeriesApi<'Candlestick'>; volume: ISeriesApi<'Histogram'> } | null>(null);
  const drawingsRef = useRef<DrawingManager | null>(null);
  const bars = useRef<Bar[]>([]);
  const paging = useRef({ loading: false, done: false, epoch: 0 });
  const lines = useRef(new Map<string, { line: IPriceLine; alert: Alert }>());
  const drag = useRef<{ id: string; pointerId: number; from: number; price: number } | null>(null);
  const callbacks = useRef({ onRetarget, onCreateAt });
  callbacks.current = { onRetarget, onCreateAt };
  const overlayRef = useRef(overlay);
  overlayRef.current = overlay;
  const tradeLines = useRef(new Map<string, IPriceLine>());
  const tradeDrag = useRef<{ id: string; pointerId: number; from: number; price: number } | null>(null);
  const [tradeDragLabel, setTradeDragLabel] = useState<{ id: string; y: number; price: number } | null>(null);
  // y per chip; off marks a line outside the visible price range, pinned to that edge.
  const [chipYs, setChipYs] = useState<Record<string, { y: number; off: -1 | 0 | 1 }>>({});
  const supported = (value: CandleTimeframe) => !market.venue || !market.type || timeframeSupported(market.venue, market.type, value);
  const [chosenFrame, setFrame] = useState(readFrame);
  // A frame saved on another venue may not exist here (e.g. 3m on MEXC); fall back without overwriting the choice.
  const frame = supported(chosenFrame) ? chosenFrame : '1h';
  const shell = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [dragLabel, setDragLabel] = useState<{ y: number; price: number } | null>(null);
  const [hover, setHover] = useState<{ y: number; price: number } | null>(null);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [, setRevision] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [axis, setAxis] = useState<{ width: number; timeHeight: number; lastY: number | null; autoScale: boolean; mainBottom: number; paneTops: number[] }>({ width: 0, timeHeight: 0, lastY: null, autoScale: true, mainBottom: 0, paneTops: [] });
  const [logScale, setLogScale] = useState(readLog);
  const [indicators, setIndicators] = useState(readIndicators);
  const indicatorSeries = useRef(new Map<string, IndicatorSeries[]>());
  const indicatorData = useRef(new Map<string, IndicatorResult>());
  const indicatorsRef = useRef(indicators);
  indicatorsRef.current = indicators;
  const logRef = useRef(logScale);
  logRef.current = logScale;
  const [tool, setTool] = useState<DrawingKind | null>(null);
  const toolRef = useRef<DrawingKind | null>(null);
  toolRef.current = tool;
  const [drawState, setDrawState] = useState({ count: 0, selected: 0, visible: true });
  const [manager, setManager] = useState<DrawingManager | null>(null);
  // Text tools (text, note, callout) ask the host for an editor at the placed point.
  const [textEdit, setTextEdit] = useState<{ drawing: Drawing; x: number; y: number; value: string } | null>(null);
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
      rightPriceScale: { borderColor: cssVar('--line', '#333'), mode: logRef.current ? PriceScaleMode.Logarithmic : PriceScaleMode.Normal },
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
    // Drawings live in a series primitive and are saved per market in this browser.
    const drawings = new DrawingManager(chart, candles, { fontFamily: cssVar('--mono-font', 'monospace') });
    try { drawings.importJSON(readDrawings(market.instrument)); } catch { /* ignore a corrupt save */ }
    const sync = () => setDrawState({ count: drawings.drawings().length, selected: drawings.selection().length, visible: drawings.drawingsVisible() });
    const offDrawing = [
      drawings.on('change', () => { saveDrawings(market.instrument, drawings.exportJSON()); sync(); }),
      drawings.on('selection', sync), drawings.on('visibility', sync),
      drawings.on('tool', kind => { setTool(kind); if (kind) setHover(null); }),
      drawings.on('textEdit', (drawing, at) => setTextEdit({ drawing, x: at.x, y: at.y, value: drawing.text ?? '' })),
    ];
    drawingsRef.current = drawings; setManager(drawings); sync(); setTool(null); setTextEdit(null);
    const onCrosshair = (param: MouseEventParams) => {
      setHoverIndex(param.point && param.time !== undefined ? barIndexAt(bars.current, param.time) : null);
      if (drag.current || tradeDrag.current || toolRef.current) return;
      if (!param.point) { window.setTimeout(() => { if (!hoverHold.current) setHover(null); }, 500); return; }
      // Indicator panes have their own scales; only the price pane offers create-at-price.
      if (param.paneIndex) { setHover(null); return; }
      const price = candles.coordinateToPrice(param.point.y);
      if (price !== null) setHover({ y: param.point.y, price: round(price) });
    };
    chart.subscribeCrosshairMove(onCrosshair);
    return () => {
      chart.unsubscribeCrosshairMove(onCrosshair);
      for (const off of offDrawing) off();
      drawings.destroy(); drawingsRef.current = null; setManager(null);
      indicatorSeries.current.clear(); indicatorData.current.clear();
      lines.current.clear(); tradeLines.current.clear(); chartRef.current = null; chart.remove();
    };
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
    fillIndicators();
    drawingsRef.current?.redraw();
    setRevision(value => value + 1);
  }
  // Indicators: one series per output line; price overlays share the main pane, oscillators get a pane each.
  function syncIndicatorSeries() {
    const current = chartRef.current;
    if (!current) return;
    for (const list of indicatorSeries.current.values()) for (const series of list) current.chart.removeSeries(series);
    indicatorSeries.current.clear();
    const precision = decimals(market.tickSize), muted = cssVar('--muted-foreground', '#959c94');
    let sub = 0;
    for (const item of indicatorsRef.current) {
      const definition = indicatorDefinition(item.kind), colors = indicatorColors(item);
      const pane = definition.pane === 'main' ? 0 : ++sub;
      const priceFormat = item.kind === 'rsi' ? { type: 'price' as const, precision: 2, minMove: 0.01 } : { type: 'price' as const, precision: Math.max(2, precision), minMove: 10 ** -Math.max(2, precision) };
      const list = definition.lines.map((line, i): IndicatorSeries => line.style === 'histogram'
        ? current.chart.addSeries(HistogramSeries, { priceFormat, priceLineVisible: false, lastValueVisible: false }, pane)
        : current.chart.addSeries(LineSeries, { color: colors[i]!, lineWidth: 1, lineStyle: line.style === 'dashed' ? LineStyle.Dashed : LineStyle.Solid, priceFormat,
          priceLineVisible: false, lastValueVisible: pane > 0, crosshairMarkerVisible: false,
          ...(item.kind === 'rsi' ? { autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 100 } }) } : {}) }, pane));
      // New panes copy the price pane's scale options, including log mode and a manual (auto-off) range.
      // Oscillators cross zero or sit in 0–100, so their pane always starts linear and auto-fitted.
      if (pane > 0) list[0]!.priceScale().applyOptions({ mode: PriceScaleMode.Normal, autoScale: true, scaleMargins: item.kind === 'rsi' ? { top: 0.08, bottom: 0.08 } : { top: 0.1, bottom: 0.1 } });
      if (item.kind === 'rsi') for (const level of [70, 30]) list[0]!.createPriceLine({ price: level, color: muted, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false, title: '' });
      indicatorSeries.current.set(item.id, list);
    }
    const panes = current.chart.panes();
    panes[0]?.setStretchFactor(sub > 1 ? 2.5 : 3);
    for (const pane of panes.slice(1)) pane.setStretchFactor(1);
    fillIndicators();
    // The library lays new panes out on its next frame; measure legend positions after that.
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => setRevision(value => value + 1)));
  }
  function fillIndicators() {
    const closes = bars.current.map(bar => bar.close), times = bars.current.map(bar => toChart(bar.time));
    for (const item of indicatorsRef.current) {
      const result = computeIndicator(item, closes), list = indicatorSeries.current.get(item.id);
      indicatorData.current.set(item.id, result);
      indicatorDefinition(item.kind).lines.forEach((line, i) => {
        const values = result[line.key]!, series = list?.[i];
        if (!series) return;
        if (line.style === 'histogram') series.setData(values.flatMap((value, j): HistogramData[] => value === null ? [] : [{ time: times[j]!, value, color: macdBar(value, values[j - 1]) }]));
        else (series as ISeriesApi<'Line'>).setData(values.flatMap((value, j): LineData[] => value === null ? [] : [{ time: times[j]!, value }]));
      });
    }
  }
  // A live trade only moves the forming bar, so earlier indicator values are unchanged; update the last point.
  function updateIndicators() {
    const closes = bars.current.map(bar => bar.close), last = bars.current.length - 1, time = toChart(bars.current[last]!.time);
    for (const item of indicatorsRef.current) {
      const result = computeIndicator(item, closes), list = indicatorSeries.current.get(item.id);
      indicatorData.current.set(item.id, result);
      indicatorDefinition(item.kind).lines.forEach((line, i) => {
        const values = result[line.key]!, value = values[last], series = list?.[i];
        if (!series || value === null || value === undefined) return;
        if (line.style === 'histogram') series.update({ time, value, color: macdBar(value, values[last - 1]) });
        else series.update({ time, value });
      });
    }
  }
  useEffect(() => { syncIndicatorSeries(); }, [indicators, market.instrument, market.tickSize, theme]);
  function saveIndicators(next: IndicatorInstance[]) {
    setIndicators(next);
    try { if (next.length) localStorage.setItem(INDICATORS_KEY, JSON.stringify(next)); else localStorage.removeItem(INDICATORS_KEY); } catch { /* keep in-memory choice */ }
  }
  function addIndicator(kind: IndicatorKind) {
    if (indicators.length >= MAX_INDICATORS) return;
    const id = `${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    saveIndicators([...indicators, createIndicator(kind, indicators, id)]);
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
    updateIndicators();
    setRevision(value => value + 1);
  }
  // One-second clock for the candle-close countdown; the layout effect re-reads the axis geometry it is pinned to.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  useLayoutEffect(() => {
    const current = chartRef.current, last = bars.current.at(-1);
    if (!current) return;
    const width = current.chart.priceScale('right').width();
    const timeHeight = current.chart.timeScale().height();
    const autoScale = current.chart.priceScale('right').options().autoScale;
    const lastY = last && state === 'ready' ? current.candles.priceToCoordinate(last.close) : null;
    // Each indicator pane's legend sits at that pane's top edge; the scale toggles follow the price pane's bottom edge.
    const rect = host.current!.getBoundingClientRect(), top = rect.top, panes = current.chart.panes();
    const mainRect = panes.length > 1 ? panes[0]!.getHTMLElement()?.getBoundingClientRect() : undefined;
    const mainBottom = mainRect ? Math.round(rect.bottom - mainRect.bottom) : timeHeight;
    const paneTops = panes.slice(1).map(pane => Math.round((pane.getHTMLElement()?.getBoundingClientRect().top ?? top) - top));
    setAxis(previous => previous.width === width && previous.timeHeight === timeHeight && previous.lastY === lastY && previous.autoScale === autoScale
      && previous.mainBottom === mainBottom && previous.paneTops.join() === paneTops.join()
      ? previous : { width, timeHeight, lastY, autoScale, mainBottom, paneTops });
  });
  // Dragging or wheeling the price axis switches auto-scale off inside the library; re-read it right after.
  useEffect(() => {
    const container = host.current!;
    const refresh = () => window.requestAnimationFrame(() => setRevision(value => value + 1));
    container.addEventListener('pointerup', refresh);
    container.addEventListener('wheel', refresh, { passive: true });
    container.addEventListener('dblclick', refresh);
    return () => { container.removeEventListener('pointerup', refresh); container.removeEventListener('wheel', refresh); container.removeEventListener('dblclick', refresh); };
  }, []);
  // TradingView-style corner toggles: "auto" fits the visible candles, "log" switches to a logarithmic price axis.
  function toggleAutoScale() {
    const scale = chartRef.current?.chart.priceScale('right');
    if (!scale) return;
    scale.setAutoScale(!scale.options().autoScale);
    setRevision(value => value + 1);
  }
  function toggleLogScale() {
    const next = !logScale;
    setLogScale(next);
    chartRef.current?.chart.priceScale('right').applyOptions({ mode: next ? PriceScaleMode.Logarithmic : PriceScaleMode.Normal });
    try { if (next) localStorage.setItem(LOG_KEY, '1'); else localStorage.removeItem(LOG_KEY); } catch { /* keep in-memory choice */ }
  }
  // Each live trade moves the forming candle; a new bucket opens a fresh bar.
  useEffect(() => {
    if (!tick || tick.instrument !== market.instrument || state !== 'ready') return;
    const last = bars.current.at(-1);
    if (!last) return;
    const at = tick.timestamp ?? tick.observedAt;
    const bucket = bucketStart(at, frame);
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

  // Trading lines mirror the host's orders and position; a line under drag keeps its preview price.
  const lineSignature = JSON.stringify(overlay?.lines.map(line => [line.id, line.price, line.tone, line.style, line.title ?? '']) ?? []);
  useEffect(() => {
    const current = chartRef.current;
    if (!current) return;
    const colors = { buy: cssVar('--signal', '#d6ff4f'), sell: cssVar('--amber', '#f0a36b'), position: cssVar('--foreground', '#f3f0e5'), liq: cssVar('--danger', '#ff8b8b'), tp: cssVar('--signal', '#d6ff4f'), sl: cssVar('--danger', '#ff8b8b') };
    const styles = { solid: LineStyle.Solid, dashed: LineStyle.Dashed, dotted: LineStyle.Dotted };
    const keep = new Set<string>();
    for (const item of overlayRef.current?.lines ?? []) {
      keep.add(item.id);
      const dragging = tradeDrag.current?.id === item.id;
      const options = { price: dragging ? tradeDrag.current!.price : item.price, color: colors[item.tone], lineStyle: styles[item.style], lineWidth: (dragging ? 2 : 1) as 1 | 2, axisLabelVisible: true, title: item.title ?? '' };
      const existing = tradeLines.current.get(item.id);
      if (existing) existing.applyOptions(options); else tradeLines.current.set(item.id, current.candles.createPriceLine(options));
    }
    for (const [id, line] of tradeLines.current) if (!keep.has(id)) { current.candles.removePriceLine(line); tradeLines.current.delete(id); }
  }, [lineSignature, market.instrument, theme, tradeDragLabel === null]);
  // Chips ride their lines through scroll, zoom and autoscale; positions are re-read each frame while trading.
  const trading = !!overlay?.trading;
  useEffect(() => {
    if (!trading) { setChipYs({}); return; }
    let frame = 0, previous = '';
    const loop = () => {
      const current = chartRef.current;
      if (current) {
        const next: Record<string, { y: number; off: -1 | 0 | 1 }> = {};
        const height = current.chart.paneSize(0).height, edge = 16;
        for (const item of overlayRef.current?.lines ?? []) {
          if (!item.chip) continue;
          const price = tradeDrag.current?.id === item.id ? tradeDrag.current.price : item.price;
          const y = current.candles.priceToCoordinate(price);
          if (y === null || height <= edge * 2) continue;
          next[item.id] = y < edge ? { y: edge, off: -1 } : y > height - edge ? { y: height - edge, off: 1 } : { y: Math.round(y), off: 0 };
        }
        // Chips on the same side (orders left; position, TP and SL right) must not cover each other:
        // walk them top to bottom and push each one below the previous by at least one chip height.
        const gap = 30;
        for (const right of [false, true]) {
          const column = (overlayRef.current?.lines ?? []).filter(item => next[item.id] && (item.tone === 'buy' || item.tone === 'sell') !== right).sort((a, b) => next[a.id]!.y - next[b.id]!.y);
          for (let i = 1; i < column.length; i++) {
            const above = next[column[i - 1]!.id]!, here = next[column[i]!.id]!;
            if (here.y - above.y < gap) next[column[i]!.id] = { ...here, y: above.y + gap };
          }
        }
        const key = JSON.stringify(next);
        if (key !== previous) { previous = key; setChipYs(next); }
      }
      frame = window.requestAnimationFrame(loop);
    };
    frame = window.requestAnimationFrame(loop);
    return () => window.cancelAnimationFrame(frame);
  }, [trading, market.instrument]);

  // Armed clicks and order-line drags run before alert handling and stop it (same element, earlier listener).
  useEffect(() => {
    const container = host.current!, current = chartRef.current;
    if (!current) return;
    const localY = (event: PointerEvent) => event.clientY - container.getBoundingClientRect().top;
    const inPricePane = (y: number) => y >= 0 && y <= current.chart.paneSize(0).height;
    const priceAt = (y: number) => { const raw = current.candles.coordinateToPrice(y); return raw === null || raw <= 0 ? null : round(raw); };
    const nearest = (y: number, radius: number) => {
      if (!inPricePane(y)) return null;
      let best: { id: string; distance: number } | null = null;
      for (const item of overlayRef.current?.lines ?? []) {
        if (!item.draggable) continue;
        const coordinate = current.candles.priceToCoordinate(item.price);
        if (coordinate === null) continue;
        const distance = Math.abs(coordinate - y);
        if (distance <= radius && (!best || distance < best.distance)) best = { id: item.id, distance };
      }
      return best?.id ?? null;
    };
    const lock = (locked: boolean) => current.chart.applyOptions({ handleScroll: !locked, handleScale: !locked });
    const consume = (event: PointerEvent) => { event.preventDefault(); event.stopImmediatePropagation(); };
    const down = (event: PointerEvent) => {
      const live = overlayRef.current;
      if (!live || event.button > 0 || toolRef.current) return;
      const y = localY(event);
      if (live.armed) {
        if (!inPricePane(y)) return;
        consume(event);
        const price = priceAt(y);
        if (price !== null) live.onArmedClick(price, event.shiftKey);
        return;
      }
      if (!live.trading) return;
      const id = nearest(y, event.pointerType === 'mouse' ? 7 : 14);
      const item = id ? live.lines.find(line => line.id === id) : undefined;
      if (!item) return;
      tradeDrag.current = { id: item.id, pointerId: event.pointerId, from: item.price, price: item.price };
      lock(true); setHover(null);
      container.setPointerCapture(event.pointerId);
      consume(event);
      setTradeDragLabel({ id: item.id, y, price: item.price });
    };
    const move = (event: PointerEvent) => {
      const active = tradeDrag.current;
      if (!active) {
        const live = overlayRef.current;
        if (event.pointerType === 'mouse' && live?.trading) container.classList.toggle('is-order-hover', !live.armed && !toolRef.current && nearest(localY(event), 7) !== null);
        return;
      }
      if (event.pointerId !== active.pointerId) return;
      consume(event);
      const y = localY(event), price = priceAt(y);
      if (price === null) return;
      active.price = price;
      tradeLines.current.get(active.id)?.applyOptions({ price });
      setTradeDragLabel({ id: active.id, y, price });
    };
    const up = (event: PointerEvent) => {
      const active = tradeDrag.current;
      if (!active || event.pointerId !== active.pointerId) return;
      consume(event);
      tradeDrag.current = null; lock(false); setTradeDragLabel(null);
      if (container.hasPointerCapture(event.pointerId)) container.releasePointerCapture(event.pointerId);
      const item = overlayRef.current?.lines.find(line => line.id === active.id);
      if (item) tradeLines.current.get(item.id)?.applyOptions({ price: item.price });
      if (item && event.type === 'pointerup' && Math.abs(active.price - active.from) >= tickSize / 2) overlayRef.current?.onModify(item.id, active.price);
    };
    container.addEventListener('pointerdown', down, { capture: true });
    container.addEventListener('pointermove', move, { capture: true });
    container.addEventListener('pointerup', up, { capture: true });
    container.addEventListener('pointercancel', up, { capture: true });
    return () => {
      container.removeEventListener('pointerdown', down, { capture: true });
      container.removeEventListener('pointermove', move, { capture: true });
      container.removeEventListener('pointerup', up, { capture: true });
      container.removeEventListener('pointercancel', up, { capture: true });
      container.classList.remove('is-order-hover');
      if (tradeDrag.current) { tradeDrag.current = null; lock(false); setTradeDragLabel(null); }
    };
  }, [market.instrument, market.tickSize]);

  // Pointer handling: mouse drags a line directly; touch selects a line first, then drags it.
  useEffect(() => {
    const container = host.current!, current = chartRef.current;
    if (!current) return;
    const nearest = (y: number, radius: number) => {
      if (y > current.chart.paneSize(0).height) return null;
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
      if (event.button > 0 || toolRef.current) return;
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
        if (event.pointerType === 'mouse') container.classList.toggle('is-line-hover', !toolRef.current && !overlayRef.current?.armed && nearest(localY(event), 7) !== null);
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
  function commitText(save: boolean) {
    const edit = textEdit, drawings = drawingsRef.current;
    setTextEdit(null);
    if (!edit || !drawings || !save) return;
    const current = drawings.get(edit.drawing.id);
    if (current) drawings.update({ ...current, text: edit.value.trim() });
  }
  // The edit bar's "edit text" reopens the placement editor at the text's anchor (callouts keep the text at the last point).
  function editText(drawing: Drawing) {
    const current = chartRef.current, at = drawing.points.at(-1);
    if (!current || !at) return;
    const x = current.chart.timeScale().timeToCoordinate(at.time), y = current.candles.priceToCoordinate(at.price);
    if (x === null || y === null) return;
    setTextEdit({ drawing, x, y, value: drawing.text ?? '' });
  }
  const selectedAlert = alerts.find(alert => alert.id === selected);
  // TradingView-style legend: hovered candle, else the forming one; change is against the previous close.
  const index = hoverIndex !== null && hoverIndex >= 0 ? hoverIndex : bars.current.length - 1;
  const shown = bars.current[index], previous = bars.current[index - 1];
  const last = bars.current.at(-1);
  const base = shown ? previous?.close ?? shown.open : 1;
  const change = shown ? shown.close - base : 0;
  const sign = change >= 0 ? '+' : '−';
  const remaining = last ? countdown(bucketEnd(last.time, frame) - now) : '';
  const toolLabel = ALL_TOOLS.find(item => item.kind === tool)?.label;
  const ghost = overlay?.armed && hover && !tool ? overlay.ghost(hover.price) : null;
  const mainIndicators = indicators.filter(item => indicatorDefinition(item.kind).pane === 'main');
  const subIndicators = indicators.filter(item => indicatorDefinition(item.kind).pane === 'sub');
  const formatIndicator = (item: IndicatorInstance) => (value: number) => item.kind === 'rsi' ? value.toFixed(2) : formatQuotePrice(Number(value.toPrecision(item.kind === 'macd' ? 5 : 10)));
  const indicatorRow = (item: IndicatorInstance) => {
    const result = indicatorData.current.get(item.id), definition = indicatorDefinition(item.kind);
    const values = definition.lines.map(line => result?.[line.key]?.[index] ?? null);
    const colors = indicatorColors(item).map((color, i) => definition.lines[i]!.style === 'histogram' ? (values[i] ?? 0) >= 0 ? cssVar('--signal', '#d6ff4f') : cssVar('--danger', '#ff8b8b') : color);
    return <IndicatorRow key={item.id} item={item} values={values} colors={colors} format={formatIndicator(item)}
      onChange={params => saveIndicators(indicators.map(entry => entry.id === item.id ? { ...entry, params } : entry))}
      onRemove={() => saveIndicators(indicators.filter(entry => entry.id !== item.id))}/>;
  };
  return <>
    <div className="native-chart-bar" role="group" aria-label={t('K 线周期')}>
      <TimeframeMenu value={frame} onChange={chooseFrame} supported={supported} keyboardScope={shell}/>
      <span className="native-chart-divider" aria-hidden="true"/>
      <IndicatorMenu count={indicators.length} onAdd={addIndicator}/>
      <span className="native-chart-status" role="status">{olderState === 'loading' ? t('正在加载更早的 K 线…') : olderState === 'done' ? t('已到交易所最早数据') : ''}</span>
    </div>
    <div ref={shell} className="chart-shell native-chart-shell" data-selected-line={selected ? 'true' : 'false'} data-drawing={tool ? 'true' : 'false'} data-armed={overlay?.armed ?? 'none'} style={{ '--price-scale-width': `${axis.width}px`, '--time-scale-height': `${axis.timeHeight}px`, '--main-pane-bottom': `${axis.mainBottom || axis.timeHeight}px`, '--indicator-panes': subIndicators.length } as CSSProperties}>
      <div ref={host} className="native-chart" data-chart-state={state}/>
      {manager && state !== 'failed' && <DrawingToolbar manager={manager} tool={tool} state={drawState} scope={shell}/>}
      {manager && state === 'ready' && !textEdit && <DrawingEditBar manager={manager} scope={shell} onEditText={editText}/>}
      {textEdit && <form className="chart-text-edit" style={{ left: textEdit.x, top: textEdit.y }} onSubmit={event => { event.preventDefault(); commitText(true); }}>
        <textarea autoFocus aria-label={t('画线文字')} maxLength={500} value={textEdit.value} placeholder={t('输入文字，Enter 确认')}
          onChange={event => setTextEdit({ ...textEdit, value: event.target.value })} onBlur={() => commitText(true)}
          onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); commitText(false); } else if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); commitText(true); } }}/>
      </form>}
      {state === 'ready' && shown && <div className={`chart-legend ${change >= 0 ? 'up' : 'down'}`} data-testid="chart-legend">
        <span className="chart-legend-row"><span className="chart-legend-ohl"><b>O</b><em>{formatQuotePrice(shown.open)}</em><b>H</b><em>{formatQuotePrice(shown.high)}</em><b>L</b><em>{formatQuotePrice(shown.low)}</em></span><b>C</b><em>{formatQuotePrice(shown.close)}</em>
          <em className="chart-legend-change">{sign}{formatQuotePrice(Math.abs(Number(change.toPrecision(8))))} ({sign}{Math.abs(change / base * 100).toFixed(2)}%)</em></span>
        <span className="chart-legend-row"><b>{t('量')}</b><em className="plain">{volumeFormat.format(shown.volume)}</em>{index === bars.current.length - 1 && <><b>{t('收盘倒计时')}</b><em className="plain" data-testid="chart-countdown">{remaining}</em></>}</span>
        {mainIndicators.map(item => indicatorRow(item))}
      </div>}
      {state === 'ready' && subIndicators.map((item, i) => axis.paneTops[i] !== undefined && <div key={item.id} className="chart-legend chart-pane-legend" style={{ top: axis.paneTops[i]! + 4 }}>{indicatorRow(item)}</div>)}
      {state === 'ready' && axis.lastY !== null && <div className={`chart-countdown ${last && last.close >= last.open ? 'up' : 'down'}`} style={{ top: axis.lastY }} aria-hidden="true">{remaining}</div>}
      {state !== 'failed' && <div className="chart-scale-modes" role="group" aria-label={t('价格坐标')}>
        <button type="button" aria-pressed={logScale} title={t('对数坐标')} aria-label={t('对数坐标')} onClick={toggleLogScale}>log</button>
        <button type="button" aria-pressed={axis.autoScale} title={t('自动缩放价格坐标')} aria-label={t('自动缩放价格坐标')} onClick={toggleAutoScale}>auto</button>
      </div>}
      {tool && toolLabel && <div className="chart-tool-hint" role="status">{t('{0}：在图表上点击放置，Esc 取消', t(toolLabel))}</div>}
      {state === 'loading' && <div className="chart-loading"><LoadingStatus>{t('正在读取 {0} K 线…', source)}</LoadingStatus><div className="skeleton-chart-grid" aria-hidden="true"/></div>}
      {state === 'failed' && <EmptyState className="chart-fallback" role="status"><strong>{t('K 线暂时不可用')}</strong><p>{error || t('交易所暂时没有返回数据。')}</p><Button variant="default" className="primary" onClick={() => setRetry(value => value + 1)}>{t('重试')}</Button></EmptyState>}
      {dragLabel && <div className="chart-drag-label" style={{ top: dragLabel.y }} aria-live="polite">{t('松开后确认')} · {formatQuotePrice(dragLabel.price)}</div>}
      {trading && state === 'ready' && <div className="chart-chips" aria-label={t('图上订单')}>{overlay!.lines.map(item => item.chip && chipYs[item.id] !== undefined && <div key={item.id}
        className={`chart-chip ${item.tone} ${item.chip.state ? 'is-pending' : ''} ${chipYs[item.id]!.off ? 'is-offscreen' : ''}`} style={{ top: chipYs[item.id]!.y }}>
        <b>{chipYs[item.id]!.off ? `${chipYs[item.id]!.off < 0 ? '↑' : '↓'} ` : ''}{item.chip.badge}</b><span>{item.chip.text}</span>{item.chip.qty && <em>{item.chip.qty}</em>}
        {item.chip.pnl && <span className={`chip-pnl ${item.chip.pnl.positive ? 'signal-text' : 'danger-text'}`}>{item.chip.pnl.text}</span>}
        {item.chip.action && overlay!.onAction && <button type="button" className="chip-action" onClick={() => overlay!.onAction!(item.id)}>{item.chip.action}</button>}
        {item.chip.state ? <span className="chip-state">{item.chip.state}</span> : item.cancellable && <button type="button" aria-label={t('撤销 {0} {1}', item.chip.badge, formatQuotePrice(item.price))} onClick={() => overlay!.onCancel(item.id)}><X aria-hidden="true"/></button>}
      </div>)}</div>}
      {ghost && hover && !tradeDragLabel && state === 'ready' && <div className={`chart-ghost ${ghost.tone}`} style={{ top: hover.y }} aria-live="polite"><span>{ghost.text}<small>{ghost.hint}</small></span></div>}
      {tradeDragLabel && <div className="chart-drag-label" style={{ top: tradeDragLabel.y }} aria-live="polite">{overlay?.preview?.(tradeDragLabel.id, tradeDragLabel.price) ?? `${t('松开后改价')} · ${formatQuotePrice(tradeDragLabel.price)}`}</div>}
      {canCreate && !trading && !overlay?.armed && hover && !dragLabel && !tool && state === 'ready' && <Button type="button" className="chart-create-at" style={{ top: hover.y }}
        onPointerEnter={() => { hoverHold.current = true; }} onPointerLeave={() => { hoverHold.current = false; setHover(null); }}
        onClick={() => { hoverHold.current = false; callbacks.current.onCreateAt(hover.price); setHover(null); }}
        aria-label={t('在 {0} 创建警报', formatQuotePrice(hover.price))}>+ {formatQuotePrice(hover.price)}</Button>}
    </div>
    <div className="chart-bottom"><div className="chart-caption"><span role="status" className={overlay?.armed ? `armed-caption ${overlay.armed}` : undefined}>{overlay?.caption ? overlay.caption : selectedAlert ? t('已选中「{0}」，按住这条线上下拖动改价。', selectedAlert.name) : t('拖动警报线改价；悬停或长按图表后点 + 在该价位创建警报。')}</span></div><span className="chart-disclaimer">{t('内置图表 · K 线来自 {0}，与警报使用同一交易所数据。', source)}</span></div>
  </>;
});
