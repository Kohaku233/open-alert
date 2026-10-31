/** Technical indicators for the built-in chart, using the standard definitions TradingView's
 * ta.sma / ta.ema / ta.rma / ta.stdev / ta.rsi / ta.macd follow. Every output array is aligned
 * with the input closes; warm-up positions are null. */
export type Values = (number | null)[];

export function sma(values: readonly number[], period: number): Values {
  const out: Values = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i]!;
    if (i >= period) sum -= values[i - period]!;
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/** Exponential average seeded with the simple average of the first full window. Leading nulls are skipped. */
export function ema(values: readonly (number | null)[], period: number, alpha = 2 / (period + 1)): Values {
  const out: Values = new Array(values.length).fill(null);
  let seen = 0, seed = 0, last: number | null = null;
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    if (value === null || value === undefined) continue;
    if (last === null) {
      seed += value; seen++;
      if (seen === period) { last = seed / period; out[i] = last; }
    } else { last = alpha * value + (1 - alpha) * last; out[i] = last; }
  }
  return out;
}

/** Wilder's smoothing (ta.rma), used by RSI. */
export const rma = (values: readonly (number | null)[], period: number) => ema(values, period, 1 / period);

export function rsi(closes: readonly number[], period: number): Values {
  const gains: (number | null)[] = [], losses: (number | null)[] = [];
  for (let i = 0; i < closes.length; i++) {
    const change = i === 0 ? null : closes[i]! - closes[i - 1]!;
    gains.push(change === null ? null : Math.max(change, 0)); losses.push(change === null ? null : Math.max(-change, 0));
  }
  const up = rma(gains, period), down = rma(losses, period);
  return up.map((u, i) => {
    const d = down[i];
    if (u === null || d === null || d === undefined) return null;
    return d === 0 ? 100 : u === 0 ? 0 : 100 - 100 / (1 + u / d);
  });
}

export function macd(closes: readonly number[], fast: number, slow: number, signal: number) {
  const f = ema(closes, fast), s = ema(closes, slow);
  const line: Values = f.map((value, i) => value === null || s[i] === null ? null : value - s[i]!);
  const signalLine = ema(line, signal);
  const histogram: Values = line.map((value, i) => value === null || signalLine[i] === null ? null : value - signalLine[i]!);
  return { macd: line, signal: signalLine, histogram };
}

/** Bollinger Bands: SMA basis ± multiplier × population standard deviation (ta.stdev). */
export function bollinger(closes: readonly number[], period: number, multiplier: number) {
  const basis = sma(closes, period);
  const upper: Values = new Array(closes.length).fill(null), lower: Values = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    const mean = basis[i]!;
    let squares = 0;
    for (let j = i - period + 1; j <= i; j++) squares += (closes[j]! - mean) ** 2;
    const deviation = Math.sqrt(squares / period) * multiplier;
    upper[i] = mean + deviation; lower[i] = mean - deviation;
  }
  return { basis, upper, lower };
}

export type IndicatorKind = 'ma' | 'ema' | 'boll' | 'rsi' | 'macd';
export type IndicatorParam = { key: string; label: string; min: number; max: number; step: number; value: number };
export type IndicatorLine = { key: string; label: string; style: 'line' | 'dashed' | 'histogram' };
export type IndicatorDefinition = { kind: IndicatorKind; short: string; name: string; pane: 'main' | 'sub'; params: readonly IndicatorParam[]; lines: readonly IndicatorLine[] };

const period = (value: number): IndicatorParam => ({ key: 'period', label: '周期', min: 1, max: 500, step: 1, value });
/** Names and labels are Chinese source strings; the UI translates them through t(). */
export const INDICATORS: readonly IndicatorDefinition[] = [
  { kind: 'ma', short: 'MA', name: '移动平均线', pane: 'main', params: [period(20)], lines: [{ key: 'value', label: 'MA', style: 'line' }] },
  { kind: 'ema', short: 'EMA', name: '指数移动平均线', pane: 'main', params: [period(20)], lines: [{ key: 'value', label: 'EMA', style: 'line' }] },
  { kind: 'boll', short: 'BOLL', name: '布林带', pane: 'main', params: [period(20), { key: 'multiplier', label: '标准差倍数', min: 0.1, max: 10, step: 0.1, value: 2 }],
    lines: [{ key: 'basis', label: '中轨', style: 'dashed' }, { key: 'upper', label: '上轨', style: 'line' }, { key: 'lower', label: '下轨', style: 'line' }] },
  { kind: 'rsi', short: 'RSI', name: '相对强弱指数', pane: 'sub', params: [period(14)], lines: [{ key: 'value', label: 'RSI', style: 'line' }] },
  { kind: 'macd', short: 'MACD', name: '指数平滑异同移动平均线', pane: 'sub',
    params: [{ key: 'fast', label: '快线周期', min: 1, max: 500, step: 1, value: 12 }, { key: 'slow', label: '慢线周期', min: 1, max: 500, step: 1, value: 26 }, { key: 'signal', label: '信号线周期', min: 1, max: 500, step: 1, value: 9 }],
    lines: [{ key: 'histogram', label: '柱', style: 'histogram' }, { key: 'macd', label: 'MACD', style: 'line' }, { key: 'signal', label: '信号', style: 'line' }] },
];
export const indicatorDefinition = (kind: IndicatorKind) => INDICATORS.find(item => item.kind === kind)!;
export const MAX_INDICATORS = 8;
/** Number of line colours available to indicator instances. */
export const INDICATOR_COLORS = 5;
export type IndicatorInstance = { id: string; kind: IndicatorKind; params: Record<string, number>; color: number };
export type IndicatorResult = Record<string, Values>;
/** Common lengths, so a second MA/EMA lands on the next familiar one instead of duplicating the first. */
const LADDER = [20, 50, 100, 200];

/** Snap a parameter into its declared range and step. */
export function clampParam(param: Omit<IndicatorParam, 'value'>, value: number): number {
  const stepped = Math.round(value / param.step) * param.step;
  return Number(Math.min(param.max, Math.max(param.min, stepped)).toFixed(param.step < 1 ? 1 : 0));
}

export function computeIndicator(instance: Pick<IndicatorInstance, 'kind' | 'params'>, closes: readonly number[]): IndicatorResult {
  const p = instance.params;
  switch (instance.kind) {
    case 'ma': return { value: sma(closes, p.period!) };
    case 'ema': return { value: ema(closes, p.period!) };
    case 'boll': return bollinger(closes, p.period!, p.multiplier!);
    case 'rsi': return { value: rsi(closes, p.period!) };
    case 'macd': return macd(closes, p.fast!, p.slow!, p.signal!);
  }
}

export function createIndicator(kind: IndicatorKind, existing: readonly IndicatorInstance[], id: string): IndicatorInstance {
  const definition = indicatorDefinition(kind);
  const params = Object.fromEntries(definition.params.map(param => [param.key, param.value]));
  if (kind === 'ma' || kind === 'ema') {
    const used = new Set(existing.filter(item => item.kind === kind).map(item => item.params.period));
    params.period = LADDER.find(value => !used.has(value)) ?? params.period!;
  }
  const colors = new Set(existing.map(item => item.color));
  const color = Array.from({ length: INDICATOR_COLORS }, (_, i) => i).find(i => !colors.has(i)) ?? existing.length % INDICATOR_COLORS;
  return { id, kind, params, color };
}

/** Parse a saved indicator list, dropping anything malformed and clamping parameters into range. */
export function parseIndicators(json: string | null): IndicatorInstance[] {
  let raw: unknown;
  try { raw = JSON.parse(json ?? '[]'); } catch { return []; }
  if (!Array.isArray(raw)) return [];
  const out: IndicatorInstance[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const { id, kind, params, color } = item as Record<string, unknown>;
    const definition = INDICATORS.find(entry => entry.kind === kind);
    if (!definition || typeof id !== 'string' || !id || id.length > 40 || out.some(entry => entry.id === id) || !params || typeof params !== 'object') continue;
    const values: Record<string, number> = {};
    for (const param of definition.params) {
      const value = (params as Record<string, unknown>)[param.key];
      values[param.key] = typeof value === 'number' && Number.isFinite(value) ? clampParam(param, value) : param.value;
    }
    const validColor = typeof color === 'number' && Number.isInteger(color) && color >= 0 && color < INDICATOR_COLORS;
    out.push({ id, kind: definition.kind, params: values, color: validColor ? color : out.length % INDICATOR_COLORS });
    if (out.length === MAX_INDICATORS) break;
  }
  return out;
}
