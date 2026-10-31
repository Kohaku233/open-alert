import { CandlestickSeries, ColorType, CrosshairMode, HistogramSeries, LineStyle, PriceScaleMode, createChart } from 'lightweight-charts';
import type { IChartApi, IPriceLine, ISeriesApi, MouseEventParams, Time, UTCTimestamp } from 'lightweight-charts';
import type { IndicatorRenderer } from 'lightweight-charts-indicators/render';
import { DrawingManager } from 'lightweight-charts-drawing';
import type { Drawing, DrawingKind } from 'lightweight-charts-drawing';
import type { CSSProperties } from 'react';
import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Alert } from '../../src/contracts/domain.js';
import type { CandlePage, CandleTimeframe } from '../../src/markets/candles.js';
import { bucketEnd, bucketStart, parseTimeframe, timeframeSupported } from '../../src/contracts/timeframes.js';
import { TimeframeMenu } from './TimeframeMenu.js';
import { DrawingEditBar } from './DrawingEditBar.js';
import { IndicatorButton, IndicatorRow, IndicatorSearchDialog, IndicatorSettingsDialog } from './ChartIndicators.js';
import { MAX_STUDIES, loadIndicatorLibrary, migrateLegacyIndicators, parseSavedStudies, resolveInputs, studyTitle } from '../indicatorLibrary.js';
import type { IndicatorLibrary, SavedStudy, Study } from '../indicatorLibrary.js';
import { ALL_TOOLS, DrawingToolbar } from './DrawingToolbar.js';
import type { MarketQuote } from '../../src/markets/quotes.js';
import { request, errorText } from '../api.js';
import { t } from '../i18n.js';
import { useTheme } from '../theme.js';
import { formatQuotePrice } from '../utils.js';
import { EmptyState, LoadingStatus } from './Surface.js';
import { Button } from './ui/button.js';
import { ChevronDown } from 'lucide-react';
import { useCompactLayout } from '../useCompactLayout.js';

const FRAME_KEY = 'open-alert-chart-frame';
const DRAWINGS_KEY = 'open-alert-drawings:';
const LOG_KEY = 'open-alert-chart-log';
const STUDIES_KEY = 'open-alert-chart-studies';
const LEGACY_INDICATORS_KEY = 'open-alert-chart-indicators';
type ShownStudy = SavedStudy & { hidden?: boolean };
type StudyOutput = { title: string; color: string; values: Map<number, number> };
type Bar = { time: number; open: number; high: number; low: number; close: number; volume: number };

// Lightweight Charts renders UTC; shift into the viewer's zone so axis labels read as local time.
const offset = (ms: number) => -new Date(ms).getTimezoneOffset() * 60_000;
const toChart = (ms: number) => ((ms + offset(ms)) / 1000) as UTCTimestamp;
function readFrame(): CandleTimeframe {
  try { const saved = localStorage.getItem(FRAME_KEY); if (saved && parseTimeframe(saved) === saved) return saved; } catch { /* default */ }
  return '4h';
}
function readStudies(): ShownStudy[] {
  try {
    const saved = localStorage.getItem(STUDIES_KEY);
    if (saved !== null) return parseSavedStudies(saved).map((entry, i) => ({ ...entry, hidden: (JSON.parse(saved) as { hidden?: unknown }[])[i]?.hidden === true }));
    // One-time move from the first release's own five indicators.
    const legacy = migrateLegacyIndicators(localStorage.getItem(LEGACY_INDICATORS_KEY));
    if (legacy.length) localStorage.setItem(STUDIES_KEY, JSON.stringify(legacy));
    localStorage.removeItem(LEGACY_INDICATORS_KEY);
    return legacy;
  } catch { return []; }
}
const IANA_ZONE = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Etc/UTC'; } catch { return 'Etc/UTC'; } })();
/** Pine timeframe strings: minutes as a bare number, then D / W. */
const pineTimeframe = (frame: string) => { const n = Number(frame.slice(0, -1)), unit = frame.slice(-1); return unit === 'm' ? String(n) : unit === 'h' ? String(n * 60) : unit === 'd' ? `${n}D` : `${n}W`; };
/** Copy of an indicator result with every bar time passed through `move` (plots, drawings, markers, colours). */
function remapTimes<T>(result: T, move: (time: number) => number): T {
  const walk = (value: unknown, key = ''): unknown => {
    if (Array.isArray(value)) return value.map(item => walk(item));
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) out[k] = walk(v, k);
      return out;
    }
    return typeof value === 'number' && (key === 'time' || key === 'time1' || key === 'time2') ? move(value) : value;
  };
  return walk(result) as T;
}
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
  const [axis, setAxis] = useState<{ width: number; timeHeight: number; lastY: number | null; autoScale: boolean; mainBottom: number; paneTops: number[] }>({ width: 0, timeHeight: 0, lastY: null, autoScale: true, mainBottom: 0, paneTops: [] });
  const [logScale, setLogScale] = useState(readLog);
  const [studies, setStudies] = useState(readStudies);
  const studiesRef = useRef(studies);
  studiesRef.current = studies;
  const [library, setLibrary] = useState<IndicatorLibrary | null>(null);
  const [libraryError, setLibraryError] = useState('');
  const [libraryAttempt, setLibraryAttempt] = useState(0);
  const libraryRef = useRef(library);
  libraryRef.current = library;
  const [searching, setSearching] = useState(false);
  // Phones have little room above the candles, so overlay legend rows start collapsed there (TradingView does the same).
  const compact = useCompactLayout();
  const [legendOpen, setLegendOpen] = useState<boolean | null>(null);
  const overlaysShown = legendOpen ?? !compact;
  const [editing, setEditing] = useState<string | null>(null);
  // One renderer per shown study; outputs keep each plot's values by chart time for the legend.
  const renderers = useRef(new Map<string, IndicatorRenderer>());
  // Pane layout (count + chart instance) the default heights were last applied to; drag-resized heights survive refreshes.
  const paneLayout = useRef<{ chart: unknown; count: number } | null>(null);
  const outputs = useRef(new Map<string, StudyOutput[]>());
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
      if (drag.current || toolRef.current) return;
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
      for (const renderer of renderers.current.values()) renderer.clear();
      renderers.current.clear(); outputs.current.clear();
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
    renderStudies();
    drawingsRef.current?.redraw();
    setRevision(value => value + 1);
  }
  // Indicators: lightweight-charts-indicators computes each study and its renderer draws it (plots, fills, hlines,
  // markers, labels...). Overlays share the price pane; every other study gets its own pane, in list order.
  useEffect(() => {
    if (!studies.length && !searching) return;
    let live = true;
    setLibraryError('');
    loadIndicatorLibrary().then(loaded => { if (live) setLibrary(loaded); }).catch(cause => { if (live) setLibraryError(t('指标库加载失败：{0}', errorText(cause))); });
    return () => { live = false; };
  }, [studies.length > 0 || searching, libraryAttempt]);
  function chartBars() { return bars.current.map(b => ({ time: (b.time / 1000), open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume })); }
  function renderStudies(reuseSeries = false) {
    const current = chartRef.current, loaded = libraryRef.current;
    if (!current || !loaded) return;
    const keep = new Set<string>();
    let pane = 0;
    const plan: { saved: ShownStudy; study: Study; pane: number }[] = [];
    for (const saved of studiesRef.current) {
      const study = loaded.byId.get(saved.study);
      if (!study || saved.hidden) continue;
      plan.push({ saved, study, pane: study.overlay ? 0 : ++pane });
    }
    // Drop renderers of removed/hidden studies first, highest pane first, so pane indexes stay valid.
    for (const [id, renderer] of [...renderers.current].reverse()) if (!plan.some(entry => entry.saved.id === id)) { renderer.clear(); renderers.current.delete(id); outputs.current.delete(id); }
    // Library bars are in UTC seconds (its session and VWAP logic expects real time); the chart shows local time.
    const libBars = chartBars(), shift = new Map(libBars.map((bar, i) => [bar.time, toChart(bars.current[i]!.time) as number]));
    const shifted = libBars.map(bar => ({ ...bar, time: shift.get(bar.time)! }));
    const context = { timeframe: pineTimeframe(frame), timezone: IANA_ZONE, session: '24x7', mintick: Number(market.tickSize) || 0.01, symbolType: 'crypto',
      tickerid: market.instrument, currency: 'USDT', lastBarConfirmed: false, foregroundColor: cssVar('--text', '#f3f0e5'), backgroundColor: cssVar('--deep', '#0d1113') };
    for (const { saved, study, pane: index } of plan) {
      keep.add(saved.id);
      let renderer = renderers.current.get(saved.id);
      if (!renderer) { renderer = new loaded.Renderer(current.chart, { paneIndex: Math.max(1, index), mainSeries: current.candles }); renderers.current.set(saved.id, renderer); }
      else renderer.setPaneIndex(Math.max(1, index));
      const inputs = resolveInputs(study, saved.inputs);
      let result;
      try { result = study.calculate(libBars, inputs, context); } catch { renderer.clear(); outputs.current.delete(saved.id); continue; }
      // Move every output time from UTC onto the chart's local-time axis.
      const move = (time: number) => shift.get(time) ?? time + (toChart(time * 1000) - time);
      const remapped = remapTimes(result, move);
      renderer.render(study, remapped, shifted, { inputs, reuseSeries, lastValueVisible: index > 0 });
      outputs.current.set(saved.id, study.plotConfig.filter(plot => plot.display !== 'none' && remapped.plots?.[plot.id]).map(plot => ({
        title: plot.title ?? plot.id, color: plot.color ?? cssVar('--text', '#f3f0e5'),
        values: new Map((remapped.plots[plot.id] as { time: number; value: number }[]).filter(point => Number.isFinite(point.value)).map(point => [point.time, point.value])),
      // Outputs switched off by default inputs (e.g. RSI's Bollinger bands) have no values; leave them out of the legend.
      })).filter(output => output.values.size > 0));
    }
    // Panes copy the price pane's scale options (log, manual range) when created; oscillators need linear, auto-fitted axes.
    const panes = current.chart.panes();
    for (const sub of panes.slice(1)) sub.priceScale('right').applyOptions({ mode: PriceScaleMode.Normal, autoScale: true });
    // Only reset heights when panes are added or removed; live ticks re-render studies every update and must not undo a drag.
    if (paneLayout.current?.chart !== current.chart || paneLayout.current.count !== panes.length) {
      panes[0]?.setStretchFactor(pane > 1 ? 2.5 : 3);
      for (const sub of panes.slice(1)) sub.setStretchFactor(1);
      paneLayout.current = { chart: current.chart, count: panes.length };
    }
    // The library lays new panes out on its next frame; measure legend positions after that.
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => setRevision(value => value + 1)));
  }
  useEffect(() => { renderStudies(); }, [studies, library, market.instrument, market.tickSize, theme, frame]);
  function saveStudies(next: ShownStudy[]) {
    setStudies(next);
    try { if (next.length) localStorage.setItem(STUDIES_KEY, JSON.stringify(next)); else localStorage.removeItem(STUDIES_KEY); } catch { /* keep in-memory choice */ }
  }
  function addStudy(study: Study) {
    if (studies.length >= MAX_STUDIES) return;
    const id = `${study.id.slice(0, 40)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    saveStudies([...studies, { id, study: study.id, inputs: {} }]);
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
    renderStudies(true);
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
  const shownTime = shown ? toChart(shown.time) as number : null;
  const formatValue = (value: number) => Math.abs(value) >= 1e6 ? volumeFormat.format(value) : formatQuotePrice(Number(value.toPrecision(6)));
  const studyRow = (saved: ShownStudy) => {
    const study = library?.byId.get(saved.study);
    if (!study) return null;
    const values = (outputs.current.get(saved.id) ?? []).slice(0, 6).map(output => {
      const value = shownTime === null ? undefined : output.values.get(shownTime);
      return { text: value === undefined ? '—' : formatValue(value), color: output.color, label: output.title };
    });
    const title = studyTitle(study, resolveInputs(study, saved.inputs));
    return <IndicatorRow key={saved.id} title={title} values={values} hidden={saved.hidden === true}
      onToggle={() => saveStudies(studies.map(entry => entry.id === saved.id ? { ...entry, hidden: !entry.hidden } : entry))}
      onSettings={() => setEditing(saved.id)} onRemove={() => saveStudies(studies.filter(entry => entry.id !== saved.id))}/>;
  };
  const known = studies.filter(saved => library?.byId.has(saved.study));
  const mainStudies = known.filter(saved => library!.byId.get(saved.study)!.overlay || saved.hidden);
  const subStudies = known.filter(saved => !library!.byId.get(saved.study)!.overlay && !saved.hidden);
  const editingStudy = editing ? studies.find(entry => entry.id === editing) : undefined;
  const editingDefinition = editingStudy ? library?.byId.get(editingStudy.study) : undefined;
  return <>
    <div className="native-chart-bar" role="group" aria-label={t('K 线周期')}>
      <TimeframeMenu value={frame} onChange={chooseFrame} supported={supported} keyboardScope={shell}/>
      <span className="native-chart-divider" aria-hidden="true"/>
      <IndicatorButton count={studies.length} onOpen={() => setSearching(true)}/>
      <span className="native-chart-status" role="status">{olderState === 'loading' ? t('正在加载更早的 K 线…') : olderState === 'done' ? t('已到交易所最早数据') : ''}</span>
    </div>
    <div ref={shell} className="chart-shell native-chart-shell" data-selected-line={selected ? 'true' : 'false'} data-drawing={tool ? 'true' : 'false'} style={{ '--price-scale-width': `${axis.width}px`, '--time-scale-height': `${axis.timeHeight}px`, '--main-pane-bottom': `${axis.mainBottom || axis.timeHeight}px`, '--indicator-panes': subStudies.length } as CSSProperties}>
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
        {mainStudies.length > 0 && <Button type="button" variant="ghost" className="chart-legend-toggle" aria-expanded={overlaysShown}
          aria-label={overlaysShown ? t('收起 {0} 个指标', mainStudies.length) : t('展开 {0} 个指标', mainStudies.length)} onClick={() => setLegendOpen(!overlaysShown)}>
          <ChevronDown aria-hidden="true"/>{!overlaysShown && <span>{t('{0} 个指标', mainStudies.length)}</span>}</Button>}
        {overlaysShown && mainStudies.map(studyRow)}
      </div>}
      {state === 'ready' && subStudies.map((saved, i) => axis.paneTops[i] !== undefined && <div key={saved.id} className="chart-legend chart-pane-legend" style={{ top: axis.paneTops[i]! + 4 }}>{studyRow(saved)}</div>)}
      {state === 'ready' && axis.lastY !== null && <div className={`chart-countdown ${last && last.close >= last.open ? 'up' : 'down'}`} style={{ top: axis.lastY }} aria-hidden="true">{remaining}</div>}
      {state !== 'failed' && <div className="chart-scale-modes" role="group" aria-label={t('价格坐标')}>
        <button type="button" aria-pressed={logScale} title={t('对数坐标')} aria-label={t('对数坐标')} onClick={toggleLogScale}>log</button>
        <button type="button" aria-pressed={axis.autoScale} title={t('自动缩放价格坐标')} aria-label={t('自动缩放价格坐标')} onClick={toggleAutoScale}>auto</button>
      </div>}
      {tool && toolLabel && <div className="chart-tool-hint" role="status">{t('{0}：在图表上点击放置，Esc 取消', t(toolLabel))}</div>}
      {state === 'loading' && <div className="chart-loading"><LoadingStatus>{t('正在读取 {0} K 线…', source)}</LoadingStatus><div className="skeleton-chart-grid" aria-hidden="true"/></div>}
      {state === 'failed' && <EmptyState className="chart-fallback" role="status"><strong>{t('K 线暂时不可用')}</strong><p>{error || t('交易所暂时没有返回数据。')}</p><Button variant="default" className="primary" onClick={() => setRetry(value => value + 1)}>{t('重试')}</Button></EmptyState>}
      {dragLabel && <div className="chart-drag-label" style={{ top: dragLabel.y }} aria-live="polite">{t('松开后确认')} · {formatQuotePrice(dragLabel.price)}</div>}
      {canCreate && hover && !dragLabel && !tool && state === 'ready' && <Button type="button" className="chart-create-at" style={{ top: hover.y }}
        onPointerEnter={() => { hoverHold.current = true; }} onPointerLeave={() => { hoverHold.current = false; setHover(null); }}
        onClick={() => { hoverHold.current = false; callbacks.current.onCreateAt(hover.price); setHover(null); }}
        aria-label={t('在 {0} 创建警报', formatQuotePrice(hover.price))}>+ {formatQuotePrice(hover.price)}</Button>}
    </div>
    {searching && <IndicatorSearchDialog library={library} error={libraryError} count={studies.length} onAdd={addStudy} onClose={() => setSearching(false)} onRetry={() => setLibraryAttempt(value => value + 1)}/>}
    {editingStudy && editingDefinition && <IndicatorSettingsDialog study={editingDefinition} inputs={resolveInputs(editingDefinition, editingStudy.inputs)}
      onChange={inputs => saveStudies(studies.map(entry => entry.id === editingStudy.id ? { ...entry, inputs } : entry))}
      onReset={() => saveStudies(studies.map(entry => entry.id === editingStudy.id ? { ...entry, inputs: {} } : entry))} onClose={() => setEditing(null)}/>}
    <div className="chart-bottom"><div className="chart-caption"><span role="status">{selectedAlert ? t('已选中「{0}」，按住这条线上下拖动改价。', selectedAlert.name) : t('拖动警报线改价；悬停或长按图表后点 + 在该价位创建警报。')}</span></div><span className="chart-disclaimer">{t('内置图表 · K 线来自 {0}，与警报使用同一交易所数据。', source)}</span></div>
  </>;
});
