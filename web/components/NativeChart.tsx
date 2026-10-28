import { CandlestickSeries, ColorType, CrosshairMode, HistogramSeries, LineStyle, createChart } from 'lightweight-charts';
import type { IChartApi, IPriceLine, ISeriesApi, MouseEventParams, Time, UTCTimestamp } from 'lightweight-charts';
import { DrawingManager } from 'lightweight-charts-drawing';
import type { DrawingKind } from 'lightweight-charts-drawing';
import { Eye, EyeOff, Minus, MousePointer2, MoveUpRight, RectangleHorizontal, Rows3, Ruler, Slash, Trash2, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { CSSProperties } from 'react';
import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Alert } from '../../src/contracts/domain.js';
import type { CandlePage, CandleTimeframe } from '../../src/markets/candles.js';
import { bucketEnd, bucketStart, parseTimeframe, timeframeSupported } from '../../src/contracts/timeframes.js';
import { TimeframeMenu } from './TimeframeMenu.js';
import type { MarketQuote } from '../../src/markets/quotes.js';
import { request, errorText } from '../api.js';
import { t } from '../i18n.js';
import { useTheme } from '../theme.js';
import { formatQuotePrice } from '../utils.js';
import { EmptyState, LoadingStatus } from './Surface.js';
import { Button } from './ui/button.js';

const FRAME_KEY = 'open-alert-chart-frame';
const DRAWINGS_KEY = 'open-alert-drawings:';
const TOOLS: { kind: DrawingKind; icon: LucideIcon; label: string }[] = [
  { kind: 'trend-line', icon: Slash, label: '趋势线' },
  { kind: 'ray', icon: MoveUpRight, label: '射线' },
  { kind: 'horizontal-line', icon: Minus, label: '水平线' },
  { kind: 'rectangle', icon: RectangleHorizontal, label: '矩形' },
  { kind: 'fib-retracement', icon: Rows3, label: '斐波那契回撤' },
  { kind: 'price-range', icon: Ruler, label: '价格区间' },
];
type Bar = { time: number; open: number; high: number; low: number; close: number; volume: number };

// Lightweight Charts renders UTC; shift into the viewer's zone so axis labels read as local time.
const offset = (ms: number) => -new Date(ms).getTimezoneOffset() * 60_000;
const toChart = (ms: number) => ((ms + offset(ms)) / 1000) as UTCTimestamp;
function readFrame(): CandleTimeframe {
  try { const saved = localStorage.getItem(FRAME_KEY); if (saved && parseTimeframe(saved) === saved) return saved; } catch { /* default */ }
  return '4h';
}
function decimals(tickSize: string) { const [, fraction = ''] = tickSize.split('.'); return Math.min(10, fraction.replace(/0+$/, '').length); }
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
export const NativeChart = memo(function NativeChart({ market, tick, alerts, source, canCreate, onRetarget, onCreateAt }: {
  market: { instrument: string; tickSize: string; venue?: 'binance' | 'okx' | 'mexc'; type?: 'spot' | 'swap' }; tick: MarketQuote | undefined; alerts: Alert[]; source: string; canCreate: boolean;
  onRetarget: (action: ChartLineAction) => void; onCreateAt: (price: number) => void;
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
  const [axis, setAxis] = useState<{ width: number; lastY: number | null }>({ width: 0, lastY: null });
  const [tool, setTool] = useState<DrawingKind | null>(null);
  const toolRef = useRef<DrawingKind | null>(null);
  toolRef.current = tool;
  const [drawState, setDrawState] = useState({ count: 0, selected: 0, visible: true });
  const [confirmClear, setConfirmClear] = useState(false);
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
    // Drawings live in a series primitive and are saved per market in this browser.
    const drawings = new DrawingManager(chart, candles, { fontFamily: cssVar('--mono-font', 'monospace') });
    try { drawings.importJSON(readDrawings(market.instrument)); } catch { /* ignore a corrupt save */ }
    const sync = () => setDrawState({ count: drawings.drawings().length, selected: drawings.selection().length, visible: drawings.drawingsVisible() });
    const offDrawing = [
      drawings.on('change', () => { saveDrawings(market.instrument, drawings.exportJSON()); sync(); }),
      drawings.on('selection', sync), drawings.on('visibility', sync),
      drawings.on('tool', kind => { setTool(kind); if (kind) setHover(null); }),
    ];
    drawingsRef.current = drawings; sync(); setTool(null);
    const onCrosshair = (param: MouseEventParams) => {
      setHoverIndex(param.point && param.time !== undefined ? barIndexAt(bars.current, param.time) : null);
      if (drag.current || toolRef.current) return;
      if (!param.point) { window.setTimeout(() => { if (!hoverHold.current) setHover(null); }, 500); return; }
      const price = candles.coordinateToPrice(param.point.y);
      if (price !== null) setHover({ y: param.point.y, price: round(price) });
    };
    chart.subscribeCrosshairMove(onCrosshair);
    return () => {
      chart.unsubscribeCrosshairMove(onCrosshair);
      for (const off of offDrawing) off();
      drawings.destroy(); drawingsRef.current = null;
      lines.current.clear(); chartRef.current = null; chart.remove();
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
    drawingsRef.current?.redraw();
    setRevision(value => value + 1);
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
    const lastY = last && state === 'ready' ? current.candles.priceToCoordinate(last.close) : null;
    setAxis(previous => previous.width === width && previous.lastY === lastY ? previous : { width, lastY });
  });
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
        if (event.pointerType === 'mouse') container.classList.toggle('is-line-hover', !toolRef.current && nearest(localY(event), 7) !== null);
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
  function chooseTool(kind: DrawingKind | null) {
    const drawings = drawingsRef.current;
    if (!drawings) return;
    drawings.setTool(drawings.tool() === kind ? null : kind);
    setSelected(null);
  }
  function clearDrawings() {
    if (!confirmClear) { setConfirmClear(true); window.setTimeout(() => setConfirmClear(false), 3000); return; }
    drawingsRef.current?.clear(); setConfirmClear(false);
  }
  const removeSelected = () => { const drawings = drawingsRef.current; if (drawings) for (const id of [...drawings.selection()]) drawings.remove(id); };
  const selectedAlert = alerts.find(alert => alert.id === selected);
  // TradingView-style legend: hovered candle, else the forming one; change is against the previous close.
  const index = hoverIndex !== null && hoverIndex >= 0 ? hoverIndex : bars.current.length - 1;
  const shown = bars.current[index], previous = bars.current[index - 1];
  const last = bars.current.at(-1);
  const base = shown ? previous?.close ?? shown.open : 1;
  const change = shown ? shown.close - base : 0;
  const sign = change >= 0 ? '+' : '−';
  const remaining = last ? countdown(bucketEnd(last.time, frame) - now) : '';
  const toolLabel = TOOLS.find(item => item.kind === tool)?.label;
  return <>
    <div className="native-chart-bar" role="group" aria-label={t('K 线周期')}>
      <TimeframeMenu value={frame} onChange={chooseFrame} supported={supported} keyboardScope={shell}/>
      <span className="native-chart-status" role="status">{olderState === 'loading' ? t('正在加载更早的 K 线…') : olderState === 'done' ? t('已到交易所最早数据') : ''}</span>
      <div className="native-draw-tools" role="toolbar" aria-label={t('画线工具')}>
        <Button type="button" variant="ghost" aria-pressed={tool === null} aria-label={t('光标')} title={t('光标')} onClick={() => chooseTool(null)}><MousePointer2 aria-hidden="true"/></Button>
        {TOOLS.map(({ kind, icon: Icon, label }) => <Button key={kind} type="button" variant="ghost" aria-pressed={tool === kind} aria-label={t(label)} title={t(label)} onClick={() => chooseTool(kind)}><Icon aria-hidden="true"/></Button>)}
        <span className="native-draw-divider" aria-hidden="true"/>
        <Button type="button" variant="ghost" aria-label={drawState.visible ? t('隐藏画线') : t('显示画线')} title={drawState.visible ? t('隐藏画线') : t('显示画线')} disabled={!drawState.count}
          onClick={() => drawingsRef.current?.setDrawingsVisible(!drawState.visible)}>{drawState.visible ? <Eye aria-hidden="true"/> : <EyeOff aria-hidden="true"/>}</Button>
        {drawState.selected > 0 && <Button type="button" variant="ghost" aria-label={t('删除选中画线')} title={t('删除选中画线')} onClick={removeSelected}><X aria-hidden="true"/></Button>}
        <Button type="button" variant="ghost" className={confirmClear ? 'is-confirming' : undefined} aria-label={confirmClear ? t('再点一次清空') : t('清空画线')} title={confirmClear ? t('再点一次清空') : t('清空画线')} disabled={!drawState.count} onClick={clearDrawings}>
          <Trash2 aria-hidden="true"/>{confirmClear && <span>{t('再点一次清空')}</span>}</Button>
      </div>
    </div>
    <div ref={shell} className="chart-shell native-chart-shell" data-selected-line={selected ? 'true' : 'false'} data-drawing={tool ? 'true' : 'false'} style={{ '--price-scale-width': `${axis.width}px` } as CSSProperties}>
      <div ref={host} className="native-chart" data-chart-state={state}/>
      {state === 'ready' && shown && <div className={`chart-legend ${change >= 0 ? 'up' : 'down'}`} data-testid="chart-legend">
        <span className="chart-legend-row"><span className="chart-legend-ohl"><b>O</b><em>{formatQuotePrice(shown.open)}</em><b>H</b><em>{formatQuotePrice(shown.high)}</em><b>L</b><em>{formatQuotePrice(shown.low)}</em></span><b>C</b><em>{formatQuotePrice(shown.close)}</em>
          <em className="chart-legend-change">{sign}{formatQuotePrice(Math.abs(Number(change.toPrecision(8))))} ({sign}{Math.abs(change / base * 100).toFixed(2)}%)</em></span>
        <span className="chart-legend-row"><b>{t('量')}</b><em className="plain">{volumeFormat.format(shown.volume)}</em>{index === bars.current.length - 1 && <><b>{t('收盘倒计时')}</b><em className="plain" data-testid="chart-countdown">{remaining}</em></>}</span>
      </div>}
      {state === 'ready' && axis.lastY !== null && <div className={`chart-countdown ${last && last.close >= last.open ? 'up' : 'down'}`} style={{ top: axis.lastY }} aria-hidden="true">{remaining}</div>}
      {tool && toolLabel && <div className="chart-tool-hint" role="status">{t('{0}：在图表上点击放置，Esc 取消', t(toolLabel))}</div>}
      {state === 'loading' && <div className="chart-loading"><LoadingStatus>{t('正在读取 {0} K 线…', source)}</LoadingStatus><div className="skeleton-chart-grid" aria-hidden="true"/></div>}
      {state === 'failed' && <EmptyState className="chart-fallback" role="status"><strong>{t('K 线暂时不可用')}</strong><p>{error || t('交易所暂时没有返回数据。')}</p><Button variant="default" className="primary" onClick={() => setRetry(value => value + 1)}>{t('重试')}</Button></EmptyState>}
      {dragLabel && <div className="chart-drag-label" style={{ top: dragLabel.y }} aria-live="polite">{t('松开后确认')} · {formatQuotePrice(dragLabel.price)}</div>}
      {canCreate && hover && !dragLabel && !tool && state === 'ready' && <Button type="button" className="chart-create-at" style={{ top: hover.y }}
        onPointerEnter={() => { hoverHold.current = true; }} onPointerLeave={() => { hoverHold.current = false; setHover(null); }}
        onClick={() => { hoverHold.current = false; callbacks.current.onCreateAt(hover.price); setHover(null); }}
        aria-label={t('在 {0} 创建警报', formatQuotePrice(hover.price))}>+ {formatQuotePrice(hover.price)}</Button>}
    </div>
    <div className="chart-bottom"><div className="chart-caption"><span role="status">{selectedAlert ? t('已选中「{0}」，按住这条线上下拖动改价。', selectedAlert.name) : t('拖动警报线改价；悬停或长按图表后点 + 在该价位创建警报。')}</span></div><span className="chart-disclaimer">{t('内置图表 · K 线来自 {0}，与警报使用同一交易所数据。', source)}</span></div>
  </>;
});
