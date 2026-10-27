import type { Market, Venue, MarketType } from '../contracts/domain.js';
import { parseInstrumentIdentity } from '../contracts/domain.js';
import { createPublicCcxtFactory, type BinanceEndpoints } from './ccxt.js';
import { normalizeCatalog, record } from './normalize.js';
import type { CcxtExchange, ExchangeFactory } from './source.js';
import { createVercelRelayReader, type VercelRelayOptions } from './vercel-relay.js';

/** Display snapshot only. Never passed to alert evaluation. observedAt is response
 * capture time; timestamp is the exchange timestamp and can be absent/old. */
export interface MarketQuote { instrument: string; price: number; observedAt: number; timestamp: number | null }
export function createMarketQuoteService(options: {
  factory?: ExchangeFactory; relay?: VercelRelayOptions; fetchImplementation?: typeof fetch; now?: () => number; binanceEndpoints?: BinanceEndpoints;
} = {}) {
  const now = options.now ?? Date.now;
  const read = options.relay ? createVercelRelayReader(options.relay, options.fetchImplementation) : null;
  const relayTransport: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (!read || url.origin !== 'https://fapi.binance.com' || (init?.method ?? 'GET') !== 'GET') throw new Error('unsupported_relay_request');
    if (url.pathname === '/fapi/v1/exchangeInfo' && !url.search) return Response.json(await read('GET'));
    const symbol = url.searchParams.get('symbol') ?? '';
    if (url.pathname !== '/fapi/v1/aggTrades' || url.searchParams.get('limit') !== '100' ||
        !/^[A-Z0-9]{1,48}$/.test(symbol) || [...url.searchParams.keys()].some(k => k !== 'symbol' && k !== 'limit')) throw new Error('unsupported_relay_request');
    const batch = await read('POST', { symbols: [symbol] });
    if (!record(batch) || !record(batch.trades) || !Array.isArray(batch.trades[symbol]) ||
        !Number.isSafeInteger(batch.capturedAt) || (batch.capturedAt as number) > now() + 5000 || now() - (batch.capturedAt as number) > 10000) throw new Error('invalid_relay_snapshot');
    return Response.json(batch.trades[symbol]);
  };
  const factory = options.factory ?? createPublicCcxtFactory({
    ...(options.fetchImplementation ? { fetchImplementation: options.fetchImplementation } : {}),
    ...(read ? { binanceSwapFetchImplementation: relayTransport } : {}),
    ...(options.binanceEndpoints ? { binanceEndpoints: options.binanceEndpoints } : {}),
  });
  type Client = { exchange: CcxtExchange; markets: ReturnType<typeof normalizeCatalog>; at: number; loading: Promise<void> | null };
  const clients = new Map<string, Promise<Client>>(), cache = new Map<string, MarketQuote>();
  const pending = new Map<string, Promise<MarketQuote>>();
  const histories = new Map<string, MarketQuote[]>();
  let stopped = false;
  async function client(venue: Venue, type: MarketType) {
    const key = `${venue}:${type}`;
    let work = clients.get(key);
    if (!work) {
      work = Promise.resolve(factory(venue, { mode: 'polling', product: type, timeoutMs: 8000, tradesLimit: 100 }))
        .then(exchange => ({ exchange, markets: new Map(), at: -Infinity, loading: null }));
      clients.set(key, work);
      work.catch(() => { clients.delete(key); });
    }
    const state = await work;
    if (!state.exchange.seedMarket && now() - state.at >= 300000) {
      state.loading ??= (async () => {
        state.markets = normalizeCatalog(venue, await state.exchange.loadMarkets(true), state.exchange.precisionMode);
        state.at = now();
      })().finally(() => { state.loading = null; });
      await state.loading;
    }
    return state;
  }
  function get(market: Market): Promise<MarketQuote> {
    if (stopped) return Promise.reject(new Error('quote_stopped'));
    const identity = parseInstrumentIdentity(market.instrument);
    if (!identity) return Promise.reject(new Error('invalid_market_identity'));
    const cached = cache.get(market.instrument);
    if (cached && now() - cached.observedAt < 5000) return Promise.resolve(cached);
    const work = pending.get(market.instrument);
    if (work) return work;
    if (pending.size >= 8) return Promise.reject(new Error('quote_capacity'));
    const next = (async () => {
      const state = await client(identity.venue, identity.type);
      state.exchange.seedMarket?.(market);
      const live = state.exchange.seedMarket ? market : state.markets.get(market.instrument);
      if (!live || live.base !== market.base || live.quote !== market.quote) throw new Error('quote_market_unavailable');
      let value: unknown;
      let trades: unknown[] | null = null;
      // OKX's ticker endpoint can rate-limit Cloudflare's shared egress while
      // its public recent-trades endpoint remains available. Sample the same
      // official trade endpoint used by monitoring, without evaluating rules.
      if (identity.venue === 'okx' || identity.venue === 'binance' && identity.type === 'swap' && read) {
        const batch = await state.exchange.fetchTrades(live.symbol!, undefined, 100);
        if (!Array.isArray(batch)) throw new Error('invalid_quote');
        trades = batch;
        value = trades.filter(record).filter(t => t.symbol === live.symbol && typeof t.timestamp === 'number')
          .sort((a, b) => (b.timestamp as number) - (a.timestamp as number))[0];
      } else {
        if (!state.exchange.fetchTicker) throw new Error('quote_unavailable');
        const ticker = await state.exchange.fetchTicker(live.symbol!);
        value = record(ticker) ? { ...ticker, price: ticker.last } : null;
      }
      if (!record(value) || value.symbol !== live.symbol || typeof value.price !== 'number' ||
          !Number.isFinite(value.price) || value.price <= 0 || value.price > 1e12 ||
          value.timestamp != null && (!Number.isSafeInteger(value.timestamp) || (value.timestamp as number) < 0 || (value.timestamp as number) > now() + 5000)) throw new Error('invalid_quote');
      const quote: MarketQuote = { instrument: market.instrument, price: value.price, observedAt: now(), timestamp: value.timestamp as number | null ?? null };
      if (stopped) throw new Error('quote_stopped');
      cache.delete(market.instrument); cache.set(market.instrument, quote);
      const samples = trades?.filter(record).filter(t=>t.symbol===live.symbol&&typeof t.price==='number'&&Number.isFinite(t.price)&&t.price>0&&t.price<=1e12&&typeof t.timestamp==='number'&&Number.isSafeInteger(t.timestamp)&&t.timestamp>=0&&t.timestamp<=now()+5000)
        .map(t=>({instrument:market.instrument,price:t.price as number,timestamp:t.timestamp as number,observedAt:quote.observedAt})) ?? [quote];
      const distinct=new Map<number,MarketQuote>();
      for(const sample of [...(histories.get(market.instrument)??[]),...samples])distinct.set(sample.timestamp??sample.observedAt,sample);
      histories.set(market.instrument,[...distinct.values()].sort((a,b)=>(a.timestamp??a.observedAt)-(b.timestamp??b.observedAt)).slice(-90));
      if (cache.size > 64) { const oldest=cache.keys().next().value!;cache.delete(oldest);histories.delete(oldest); }
      return quote;
    })().finally(() => { pending.delete(market.instrument); });
    pending.set(market.instrument, next);
    return next;
  }
  return { get, async recent(market: Market) { await get(market);return (histories.get(market.instrument)??[]).map(quote=>({...quote})); }, async stop() {
    stopped = true; cache.clear();histories.clear();
    await Promise.allSettled([...clients.values()].map(async work => (await work).exchange.close()));
  } };
}
