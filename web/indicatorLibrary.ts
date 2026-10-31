/** Indicators come from lightweight-charts-indicators (MIT): TradingView's built-in studies ported from Pine,
 * with their own inputs, plot styles and renderer. The package is about 15 MB of source, so it loads on first use. */
import type { IndicatorRegistryEntry } from 'lightweight-charts-indicators';
import type { IndicatorRenderer } from 'lightweight-charts-indicators/render';

export type Study = IndicatorRegistryEntry;
export type StudyInput = Study['inputConfig'][number];
/** The 1,500+ community scripts are user-published Pine ports of uneven quality; only TradingView's own studies are offered. */
const OFFERED = new Set<Study['group']>(['standard', 'candlestick']);
/** These read other symbols' bars (request.security of another ticker); this chart has no such feed. */
const UNSUPPORTED = new Set(['correlation-coefficient', 'performance']);

export type IndicatorLibrary = { studies: Study[]; byId: Map<string, Study>; Renderer: typeof IndicatorRenderer };
let loading: Promise<IndicatorLibrary> | null = null;
export function loadIndicatorLibrary(): Promise<IndicatorLibrary> {
  loading ??= Promise.all([import('lightweight-charts-indicators'), import('lightweight-charts-indicators/render')]).then(([core, render]) => {
    const studies = core.indicatorRegistry.filter(entry => OFFERED.has(entry.group) && !UNSUPPORTED.has(entry.id));
    return { studies, byId: new Map(studies.map(entry => [entry.id, entry])), Renderer: render.IndicatorRenderer };
  }).catch(error => { loading = null; throw error; });
  return loading;
}

/** Inputs shown in the settings form. Pine's display.none inputs are internal and keep their defaults;
 * symbol/session/timeframe inputs need data this chart does not have. */
export const editableInputs = (study: Study) => study.inputConfig.filter(input =>
  input.display !== 'none' && input.type !== 'symbol' && input.type !== 'session' && input.type !== 'timeframe' && input.type !== 'text_area' && input.type !== 'time');

/** Saved inputs merged over the study defaults, keeping only known ids with values of the right type. */
export function resolveInputs(study: Study, saved: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...study.defaultInputs };
  for (const input of editableInputs(study)) {
    const value = saved[input.id];
    if (value === undefined) continue;
    const ok = input.type === 'int' || input.type === 'float' ? typeof value === 'number' && Number.isFinite(value)
      : input.type === 'bool' ? typeof value === 'boolean'
      : typeof value === 'string' && value.length <= 200 && (!input.options || input.options.includes(value));
    if (ok) out[input.id] = input.type === 'int' ? Math.round(value as number) : value;
  }
  return out;
}

/** Legend title in TradingView's style, e.g. "RSI 14 close": the short name plus the visible numeric/choice inputs. */
export function studyTitle(study: Study, inputs: Record<string, unknown>) {
  const parts = editableInputs(study).filter(input => input.type === 'int' || input.type === 'float' || input.type === 'source' || (input.type === 'string' && input.options))
    .slice(0, 4).map(input => String(inputs[input.id] ?? input.defval));
  return [study.shortName, ...parts].join(' ');
}

/** Case-insensitive search over short name, name, id, description and category, best matches first. */
export function searchStudies(studies: readonly Study[], query: string): Study[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...studies];
  const scored: [number, Study][] = [];
  for (const study of studies) {
    const short = study.shortName.toLowerCase(), name = study.name.toLowerCase(), alias = STUDY_ALIASES[study.id]?.toLowerCase() ?? '';
    const score = short === q ? 0 : short.startsWith(q) ? 1 : name.startsWith(q) ? 2 : name.split(/[\s/()'-]+/).some(word => word.startsWith(q)) ? 3
      : name.includes(q) || short.includes(q) || study.id.includes(q) || alias.includes(q) ? 4
      : (study.description ?? '').toLowerCase().includes(q) || study.category.toLowerCase().includes(q) ? 5 : -1;
    if (score >= 0) scored.push([score, study]);
  }
  return scored.sort((a, b) => a[0] - b[0] || a[1].name.localeCompare(b[1].name)).map(([, study]) => study);
}

export type SavedStudy = { id: string; study: string; inputs: Record<string, unknown> };
export const MAX_STUDIES = 10;
/** Saved list from localStorage with malformed entries dropped. Study ids are checked against the registry once it loads. */
export function parseSavedStudies(json: string | null): SavedStudy[] {
  let raw: unknown;
  try { raw = JSON.parse(json ?? '[]'); } catch { return []; }
  if (!Array.isArray(raw)) return [];
  const out: SavedStudy[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const { id, study, inputs } = item as Record<string, unknown>;
    if (typeof id !== 'string' || !id || id.length > 60 || typeof study !== 'string' || !study || study.length > 120 || out.some(entry => entry.id === id)) continue;
    out.push({ id, study, inputs: inputs && typeof inputs === 'object' && !Array.isArray(inputs) ? inputs as Record<string, unknown> : {} });
    if (out.length === MAX_STUDIES) break;
  }
  return out;
}

/** The first release saved its own five kinds under this shape; map them onto the library's studies once. */
const LEGACY: Record<string, (params: Record<string, unknown>) => Omit<SavedStudy, 'id'>> = {
  ma: p => ({ study: 'sma', inputs: { len: p.period } }),
  ema: p => ({ study: 'ema', inputs: { length: p.period } }),
  boll: p => ({ study: 'bb', inputs: { length: p.period, mult: p.multiplier } }),
  rsi: p => ({ study: 'rsi', inputs: { length: p.period } }),
  macd: p => ({ study: 'macd', inputs: { fastLength: p.fast, slowLength: p.slow, signalLength: p.signal } }),
};
export function migrateLegacyIndicators(json: string | null): SavedStudy[] {
  let raw: unknown;
  try { raw = JSON.parse(json ?? '[]'); } catch { return []; }
  if (!Array.isArray(raw)) return [];
  const out: SavedStudy[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const { id, kind, params } = item as Record<string, unknown>;
    const map = typeof kind === 'string' ? LEGACY[kind] : undefined;
    if (!map || typeof id !== 'string' || !id || out.some(entry => entry.id === id)) continue;
    const mapped = map(params && typeof params === 'object' ? params as Record<string, unknown> : {});
    out.push({ id, study: mapped.study, inputs: Object.fromEntries(Object.entries(mapped.inputs).filter(([, value]) => typeof value === 'number' && Number.isFinite(value))) });
    if (out.length === MAX_STUDIES) break;
  }
  return out;
}

/** Category names in the library (TradingView's grouping), in the order the menu lists them. */
export const CATEGORIES = ['Moving Averages', 'Oscillators', 'Momentum', 'Trend', 'Volatility', 'Channels & Bands', 'Volume', 'Candlestick Patterns'] as const;
export const CATEGORY_LABELS: Record<string, string> = {
  'Moving Averages': '均线', Oscillators: '振荡指标', Momentum: '动量', Trend: '趋势', Volatility: '波动率', 'Channels & Bands': '通道与带', Volume: '成交量', 'Candlestick Patterns': 'K 线形态',
};
/** Chinese search terms for the common studies; the library's own names are English. */
export const STUDY_ALIASES: Record<string, string> = {
  sma: '均线 简单移动平均 移动平均线', ema: '均线 指数移动平均', wma: '加权移动平均', bb: '布林带 布林线 boll', rsi: '相对强弱', macd: '指数平滑异同',
  stoch: '随机指标 kd', kdj: '随机指标', atr: '平均真实波幅 真实波幅', vwap: '成交量加权平均价', supertrend: '超级趋势', 'parabolic-sar': '抛物线 sar',
  ichimoku: '一目均衡表', donchian: '唐奇安通道', keltner: '肯特纳通道', 'williams-r': '威廉指标', obv: '能量潮', cci: '顺势指标', adx: '平均趋向', dmi: '趋向指标',
  mfi: '资金流量', 'stoch-rsi': '随机相对强弱', 'auto-fib-retracement': '斐波那契回撤', 'pivot-points-standard': '枢轴点', zigzag: '之字转向', momentum: '动量', roc: '变动率',
};
