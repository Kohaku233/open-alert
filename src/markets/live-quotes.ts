import type { Market, MarketType, Venue } from '../contracts/domain.js';
import { parseInstrumentIdentity } from '../contracts/domain.js';
import { createPublicCcxtFactory, type BinanceEndpoints } from './ccxt.js';
import { record } from './normalize.js';
import type { MarketQuote } from './quotes.js';
import type { CcxtExchange, ExchangeFactory } from './source.js';

/** Display-only trade stream for browsers. Never feeds alert evaluation, which
 * keeps its own fenced source. One exchange socket per venue/product is shared
 * by every viewer, and a symbol is subscribed only while someone watches it. */
export interface LiveQuoteHub {
  subscribe(market: Market, listener: (quote: MarketQuote) => void): () => void;
  instruments(): number;
  stop(): Promise<void>;
}
export interface LiveQuoteHubOptions {
  factory?: ExchangeFactory;
  binanceEndpoints?: BinanceEndpoints;
  /** REST snapshot used for the first value and while a market is quiet. */
  snapshot?: (market: Market) => Promise<MarketQuote>;
  now?: () => number;
  maxInstruments?: number;
  /** Coalesce bursts: at most one push per instrument per interval. */
  minIntervalMs?: number;
  quietRefreshMs?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
}
interface Entry {
  market: Market; listeners: Set<(quote: MarketQuote) => void>; active: boolean;
  latest: MarketQuote | null; sentAt: number; flush: ReturnType<typeof setTimeout> | null;
  quiet: ReturnType<typeof setInterval> | null; refreshing: boolean;
  /** True once an exchange subscription resolved; only then is unWatch needed. */
  subscribed: boolean;
}

export function createLiveQuoteHub(options: LiveQuoteHubOptions = {}): LiveQuoteHub {
  const now = options.now ?? Date.now;
  const factory = options.factory ?? createPublicCcxtFactory(options.binanceEndpoints ? { binanceEndpoints: options.binanceEndpoints } : {});
  const maxInstruments = options.maxInstruments ?? 64;
  const minInterval = options.minIntervalMs ?? 50;
  const quietMs = options.quietRefreshMs ?? 5000;
  const retryBase = options.retryBaseMs ?? 1000, retryMax = options.retryMaxMs ?? 30_000;
  const clients = new Map<string, Promise<CcxtExchange>>();
  const entries = new Map<string, Entry>();
  let stopped = false;

  function client(venue: Venue, type: MarketType): Promise<CcxtExchange> {
    const key = `${venue}:${type}`;
    let work = clients.get(key);
    if (!work) {
      work = Promise.resolve(factory(venue, { mode: 'stream', product: type, timeoutMs: 10_000, tradesLimit: 1000 }));
      clients.set(key, work);
      work.catch(() => { clients.delete(key); });
    }
    return work;
  }
  const valid = (q: MarketQuote) => Number.isFinite(q.price) && q.price > 0 && q.price <= 1e12 &&
    (q.timestamp === null || Number.isSafeInteger(q.timestamp) && q.timestamp >= 0 && q.timestamp <= now() + 5000);
  function emit(entry: Entry) {
    if (!entry.active || !entry.latest) return;
    const wait = entry.sentAt + minInterval - now();
    if (wait > 0) { entry.flush ??= setTimeout(() => { entry.flush = null; emit(entry); }, wait); return; }
    entry.sentAt = now();
    const quote = { ...entry.latest };
    for (const listener of [...entry.listeners]) { try { listener(quote); } catch { /* one viewer cannot break others */ } }
  }
  function offer(entry: Entry, quote: MarketQuote) {
    if (!entry.active || !valid(quote)) return;
    const last = entry.latest;
    // Never move the display backwards in exchange time.
    if (last?.timestamp != null && quote.timestamp != null && quote.timestamp < last.timestamp) return;
    entry.latest = quote; emit(entry);
  }
  async function refresh(entry: Entry) {
    if (!options.snapshot || entry.refreshing || !entry.active) return;
    if (entry.latest && now() - entry.latest.observedAt < quietMs) return;
    entry.refreshing = true;
    try { offer(entry, await options.snapshot(entry.market)); } catch { /* the stream may still recover */ }
    finally { entry.refreshing = false; }
  }
  async function run(entry: Entry) {
    const identity = parseInstrumentIdentity(entry.market.instrument)!;
    let failures = 0;
    while (entry.active && !stopped) {
      try {
        const exchange = await client(identity.venue, identity.type);
        if (!exchange.watchTrades) throw new Error('trades_unsupported');
        exchange.seedMarket?.(entry.market);
        const raw = await exchange.watchTrades(entry.market.symbol!);
        entry.subscribed = true;
        if (!entry.active || stopped) return;
        failures = 0;
        if (!Array.isArray(raw)) continue;
        let newest: Record<string, unknown> | null = null;
        for (const row of raw) if (record(row) && row.symbol === entry.market.symbol && typeof row.price === 'number' &&
          typeof row.timestamp === 'number' && Number.isSafeInteger(row.timestamp) && (!newest || row.timestamp >= (newest.timestamp as number))) newest = row;
        if (newest) offer(entry, { instrument: entry.market.instrument, price: newest.price as number, timestamp: newest.timestamp as number, observedAt: now() });
      } catch {
        if (!entry.active || stopped) return;
        failures++;
        await new Promise(resolve => setTimeout(resolve, Math.min(retryMax, retryBase * 2 ** Math.min(failures - 1, 10))));
      }
    }
  }
  function release(entry: Entry, unwatch = true) {
    entry.active = false; entries.delete(entry.market.instrument);
    if (entry.flush) clearTimeout(entry.flush);
    if (entry.quiet) clearInterval(entry.quiet);
    // Never open a connection merely to unsubscribe from something never subscribed.
    if (!entry.subscribed || !unwatch) return;
    const identity = parseInstrumentIdentity(entry.market.instrument);
    const work = identity ? clients.get(`${identity.venue}:${identity.type}`) : undefined;
    void work?.then(exchange => exchange.unWatchTrades?.(entry.market.symbol!)).catch(() => {});
  }
  return {
    subscribe(market, listener) {
      if (stopped) throw new Error('live_stopped');
      if (!market.symbol || !parseInstrumentIdentity(market.instrument)) throw new Error('invalid_market_identity');
      let entry = entries.get(market.instrument);
      if (!entry) {
        if (entries.size >= maxInstruments) throw new Error('live_capacity');
        entry = { market, listeners: new Set(), active: true, latest: null, sentAt: 0, flush: null, quiet: null, refreshing: false, subscribed: false };
        entries.set(market.instrument, entry);
        const created = entry;
        created.quiet = setInterval(() => void refresh(created), quietMs);
        void refresh(created);
        void run(created);
      }
      entry.listeners.add(listener);
      if (entry.latest) { try { listener({ ...entry.latest }); } catch { /* ignore */ } }
      const owned = entry;
      return () => { owned.listeners.delete(listener); if (!owned.listeners.size && owned.active) release(owned); };
    },
    instruments: () => entries.size,
    async stop() {
      stopped = true;
      // Closing drops every subscription; an unwatch racing close would send on a closing socket.
      for (const entry of [...entries.values()]) release(entry, false);
      const all = [...clients.values()]; clients.clear();
      await Promise.allSettled(all.map(async work => (await work).close()));
    },
  };
}
