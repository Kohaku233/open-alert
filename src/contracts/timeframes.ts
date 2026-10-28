/** Chart timeframes shared by the candle service and the web chart. Pure: no imports.
 * Canonical text is `<n><unit>` with unit m/h/d/w, e.g. 7m, 90m -> 90m, 60m -> 1h, 7d -> 1w. */
export type Timeframe = string;
export type TimeframeUnit = 'm' | 'h' | 'd' | 'w';
const UNIT_MS: Record<TimeframeUnit, number> = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
const UNIT_MAX: Record<TimeframeUnit, number> = { m: 1440, h: 168, d: 60, w: 8 };
/** Weekly buckets open on Monday 00:00 UTC (the Unix epoch was a Thursday). */
const WEEK_OFFSET = 4 * UNIT_MS.d;

/** Presets offered in the chart menu; any other valid value can be typed. */
export const TIMEFRAME_PRESETS: readonly Timeframe[] = ['1m', '3m', '5m', '15m', '30m', '45m', '1h', '2h', '3h', '4h', '6h', '8h', '12h', '1d', '2d', '3d', '1w', '2w'];
export const DEFAULT_FAVORITE_TIMEFRAMES: readonly Timeframe[] = ['1m', '5m', '15m', '1h', '4h', '1d', '1w'];

/** Parse user or query text into a canonical timeframe, or null when unsupported.
 * Accepts TradingView-style input: a bare number is minutes, H hours, D days, W weeks,
 * and a bare unit letter means one of it (D = 1d). */
export function parseTimeframe(input: string): Timeframe | null {
  const match = /^\s*(\d{0,4})\s*([mhdw]?)\s*$/i.exec(input);
  if (!match || (!match[1] && !match[2])) return null;
  // TradingView writes months as 1M; this chart has no month bars, so an upper-case M is rejected.
  if (match[2] === 'M') return null;
  const count = match[1] ? Number(match[1]) : 1;
  let unit = (match[2] || 'm').toLowerCase() as TimeframeUnit;
  if (!Number.isSafeInteger(count) || count < 1 || count > UNIT_MAX[unit]) return null;
  let value = count;
  // Normalise to the largest unit that divides evenly so equal durations share one cache entry.
  if (unit === 'm' && value % 60 === 0) { value /= 60; unit = 'h'; }
  if (unit === 'h' && value % 24 === 0) { value /= 24; unit = 'd'; }
  if (unit === 'd' && value % 7 === 0) { value /= 7; unit = 'w'; }
  if (value > UNIT_MAX[unit]) return null;
  return `${value}${unit}`;
}
export function timeframeParts(timeframe: Timeframe): { count: number; unit: TimeframeUnit } {
  const canonical = parseTimeframe(timeframe);
  if (!canonical || canonical !== timeframe) throw new Error('invalid_timeframe');
  return { count: Number(canonical.slice(0, -1)), unit: canonical.slice(-1) as TimeframeUnit };
}
export function timeframeMs(timeframe: Timeframe): number {
  const { count, unit } = timeframeParts(timeframe);
  return count * UNIT_MS[unit];
}
/** Open time of the bucket holding `at`. Intraday frames restart at every UTC midnight (as
 * TradingView does for 24/7 markets, so 7m has a short last bar); days count from the epoch;
 * weeks open on Monday. */
export function bucketStart(at: number, timeframe: Timeframe): number {
  const step = timeframeMs(timeframe);
  if (step < UNIT_MS.d) { const day = Math.floor(at / UNIT_MS.d) * UNIT_MS.d; return day + Math.floor((at - day) / step) * step; }
  const offset = timeframe.endsWith('w') ? WEEK_OFFSET : 0;
  return Math.floor((at - offset) / step) * step + offset;
}
/** Close time of the bucket that opens at `start`. */
export function bucketEnd(start: number, timeframe: Timeframe): number {
  const step = timeframeMs(timeframe);
  if (step >= UNIT_MS.d) return start + step;
  return Math.min(start + step, Math.floor(start / UNIT_MS.d) * UNIT_MS.d + UNIT_MS.d);
}
/** Short button label in the TradingView style: 15m, 4H, 1D, 1W. */
export function timeframeLabel(timeframe: Timeframe): string {
  return timeframe.endsWith('m') ? timeframe : timeframe.toUpperCase();
}

export type TimeframeVenue = 'binance' | 'okx' | 'mexc';
/** Bars each venue returns directly (CCXT keys). Others are built from the largest native divisor. */
const NATIVE: Record<TimeframeVenue, Record<'spot' | 'swap', readonly Timeframe[]>> = {
  // Binance 3d bars use the exchange's own anchor, so 3d is built from 1d like any other multiple.
  binance: { spot: ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d', '1w'], swap: ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d', '1w'] },
  okx: { spot: ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '12h', '1d', '1w'], swap: ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '12h', '1d', '1w'] },
  mexc: { spot: ['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w'], swap: ['1m', '5m', '15m', '30m', '1h', '4h', '8h', '1d', '1w'] },
};
/** At most this many exchange bars are read to build one page of a derived timeframe. */
export const MAX_BASE_BARS = 1800;
/** The exchange bar to request and how many of them make one requested bar.
 * Throws `timeframe_unsupported` when a page would hold fewer than 5 requested bars. */
export function timeframePlan(venue: TimeframeVenue, type: 'spot' | 'swap', timeframe: Timeframe): { base: Timeframe; factor: number } {
  const target = timeframeMs(timeframe), weekly = timeframe.endsWith('w');
  let best: { base: Timeframe; factor: number } | null = null;
  for (const base of NATIVE[venue][type]) {
    const step = timeframeMs(base);
    if (step > target || target % step) continue;
    // Weekly buckets start on Monday: only day or week bars share that boundary.
    if (weekly && !base.endsWith('d') && !base.endsWith('w')) continue;
    if (!best || step > timeframeMs(best.base)) best = { base, factor: target / step };
  }
  if (!best || best.factor > MAX_BASE_BARS / 5) throw new Error('timeframe_unsupported');
  return best;
}
export function timeframeSupported(venue: TimeframeVenue, type: 'spot' | 'swap', timeframe: Timeframe): boolean {
  try { timeframePlan(venue, type, timeframe); return true; } catch { return false; }
}
