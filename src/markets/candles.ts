import type { Market, MarketType, Venue } from '../contracts/domain.js';
import { parseInstrumentIdentity } from '../contracts/domain.js';
import { createPublicCcxtFactory, type BinanceEndpoints } from './ccxt.js';
import type { CcxtExchange, ExchangeFactory } from './source.js';
import { bucketEnd, bucketStart, timeframeMs, timeframePlan, type Timeframe } from '../contracts/timeframes.js';

/** Display-only OHLCV pages for the built-in chart. Never used by alert evaluation. */
export const CANDLE_TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h', '1d', '1w'] as const;
/** Any canonical timeframe (see timeframes.ts); the exchange-native ones are fetched directly. */
export type CandleTimeframe = Timeframe;
export const TIMEFRAME_MS: Record<typeof CANDLE_TIMEFRAMES[number], number> = {
  '1m': 60_000, '5m': 300_000, '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000, '1w': 604_800_000,
};
/** [openTime ms, open, high, low, close, volume] */
export type Candle = [number, number, number, number, number, number];
export interface CandlePage { instrument: string; timeframe: CandleTimeframe; candles: Candle[]; done: boolean }
export const CANDLE_PAGE = 300;
/** Per-request bar caps: OKX serves 300, Binance and MEXC at least 1000. */
const CHUNK: Record<Venue, number> = { okx: 300, binance: 1000, mexc: 1000 };
const MAX_REQUESTS = 20;

type OhlcvExchange = CcxtExchange & { fetchOHLCV?(symbol: string, timeframe: string, since?: number, limit?: number): Promise<unknown> };

export function parseCandles(raw: unknown, before: number, now: number): Candle[] {
  if (!Array.isArray(raw)) throw new Error('invalid_candles');
  const rows = new Map<number, Candle>();
  for (const row of raw) {
    if (!Array.isArray(row) || row.length < 5) continue;
    const [time, open, high, low, close, volume] = row as unknown[];
    const values = [open, high, low, close];
    if (!Number.isSafeInteger(time) || (time as number) < 0 || (time as number) >= before || (time as number) > now + 60_000) continue;
    if (!values.every(v => typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 1e12)) continue;
    rows.set(time as number, [time as number, open as number, high as number, low as number, close as number,
      typeof volume === 'number' && Number.isFinite(volume) && volume >= 0 ? volume : 0]);
  }
  return [...rows.values()].sort((a, b) => a[0] - b[0]);
}
/** Fold exchange bars into requested buckets. Input is sorted; a bucket keeps first open, last close. */
export function aggregateCandles(rows: readonly Candle[], timeframe: Timeframe): Candle[] {
  const out: Candle[] = [];
  for (const [time, open, high, low, close, volume] of rows) {
    const start = bucketStart(time, timeframe), last = out.at(-1);
    if (last && last[0] === start) { last[2] = Math.max(last[2], high); last[3] = Math.min(last[3], low); last[4] = close; last[5] += volume; }
    else out.push([start, open, high, low, close, volume]);
  }
  return out;
}

export function createCandleService(options: { factory?: ExchangeFactory; now?: () => number; binanceEndpoints?: BinanceEndpoints } = {}) {
  const now = options.now ?? Date.now;
  const factory = options.factory ?? createPublicCcxtFactory(options.binanceEndpoints ? { binanceEndpoints: options.binanceEndpoints } : {});
  const clients = new Map<string, OhlcvExchange>();
  // Closed historical pages never change; the newest page is reused briefly to absorb bursts.
  const cache = new Map<string, { page: CandlePage; at: number; final: boolean }>();
  const pending = new Map<string, Promise<CandlePage>>();
  let stopped = false;
  function client(venue: Venue, type: MarketType) {
    const key = `${venue}:${type}`;
    let exchange = clients.get(key);
    if (!exchange) {
      exchange = factory(venue, { mode: 'polling', product: type, timeoutMs: 10_000, tradesLimit: 100 }) as OhlcvExchange;
      clients.set(key, exchange);
    }
    return exchange;
  }
  async function get(market: Market, timeframe: CandleTimeframe, before?: number): Promise<CandlePage> {
    if (stopped) throw new Error('candles_stopped');
    const identity = parseInstrumentIdentity(market.instrument);
    if (!identity || !market.symbol) throw new Error('invalid_market_identity');
    const plan = timeframePlan(identity.venue, identity.type, timeframe);
    const step = timeframeMs(timeframe), baseStep = timeframeMs(plan.base), at = now();
    // The latest page ends at the close of the forming bucket, so no request reaches into the future.
    const end = Math.min(before ?? Infinity, bucketEnd(bucketStart(at, timeframe), timeframe));
    const key = `${market.instrument}|${timeframe}|${before ?? 'latest'}`;
    const hit = cache.get(key);
    if (hit && (hit.final || at - hit.at < 2000)) { cache.delete(key); cache.set(key, hit); return hit.page; }
    const running = pending.get(key);
    if (running) return running;
    if (pending.size >= 8) throw new Error('candles_capacity');
    const work = (async () => {
      const exchange = client(identity.venue, identity.type);
      exchange.seedMarket?.(market);
      if (!exchange.fetchOHLCV) throw new Error('candles_unsupported');
      // Walk back whole buckets (intraday buckets restart at UTC midnight, so lengths vary).
      const bars = Math.min(CANDLE_PAGE, Math.floor(1800 / plan.factor));
      let since = bucketStart(end - 1, timeframe);
      for (let i = 1; i < bars && since > 0; i++) since = bucketStart(since - 1, timeframe);
      since = Math.max(0, since);
      // Read forward in venue-sized chunks until the page end; an empty reply means no more data.
      const rows: Candle[] = [];
      for (let cursor = since, i = 0; cursor < end && i < MAX_REQUESTS; i++) {
        const want = Math.min(CHUNK[identity.venue], Math.ceil((end - cursor) / baseStep));
        const part = parseCandles(await exchange.fetchOHLCV(market.symbol!, plan.base, cursor, want), end, at).filter(row => row[0] >= cursor);
        // An empty window can sit before a listing date; skip it rather than drop the rest of the page.
        if (!part.length) { cursor += want * baseStep; continue; }
        rows.push(...part);
        cursor = part.at(-1)![0] + baseStep;
      }
      const candles = plan.factor === 1 ? rows : aggregateCandles(rows, timeframe);
      // An empty page means the exchange has no older data (listing date or retention limit).
      const page: CandlePage = { instrument: market.instrument, timeframe, candles, done: candles.length === 0 };
      if (stopped) throw new Error('candles_stopped');
      cache.set(key, { page, at, final: before !== undefined && before <= at - step });
      while (cache.size > 300) cache.delete(cache.keys().next().value!);
      return page;
    })().finally(() => { pending.delete(key); });
    pending.set(key, work);
    return work;
  }
  return {
    get,
    async stop() { stopped = true; cache.clear(); await Promise.allSettled([...clients.values()].map(c => c.close())); },
  };
}
