import ccxt from 'ccxt';
import type { ConstructorArgs } from 'ccxt';
import { currencyCodeSchema, parseInstrumentIdentity, type Venue } from '../contracts/domain.js';
import { createCcxtMarketSource } from './source.js';
import { normalizeCatalog, record } from './normalize.js';
import type { CcxtExchange, ExchangeSettings, MarketSourceOptions } from './source.js';

const rawString = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const otherCurrency = (value: unknown) => currencyCodeSchema.safeParse(value).success && value !== 'USDT';
const perpetualExpiry = 4133404800000;

/** Check only identity/category inputs that CCXT can drop or default into an
 * excluded product. Precision and other supported metadata remain the normalizer's
 * responsibility. Explicit excluded rows need no fabricated live metadata. */
function validateRawCatalog(venue: Venue, product: 'spot' | 'swap', rows: unknown[]) {
  const invalid = () => { throw new Error('invalid_catalog_row'); };
  for (const value of rows) {
    if (!record(value)) { invalid(); continue; }
    if (venue === 'okx') {
      // Pinned OKX parser explicitly skips empty-ID preopen placeholders. Swap
      // currencies normally come from uly, not the empty baseCcy/quoteCcy fields.
      const underlying = rawString(value.uly) ? value.uly.split('-') : undefined;
      const base = product === 'swap' && underlying ? underlying[0] : value.baseCcy;
      const quote = product === 'swap' && underlying ? underlying[1] : value.quoteCcy;
      if (otherCurrency(quote) || base === 'USDT' && quote === 'USDT' || otherCurrency(value.settleCcy) && product === 'swap' ||
          value.instType === 'FUTURES' || value.instType === 'OPTION' ||
          rawString(value.state) && value.state !== 'live') continue;
      if (!rawString(value.instId) || value.instType !== (product === 'spot' ? 'SPOT' : 'SWAP') ||
          value.state !== 'live' || !rawString(base) || !rawString(quote) ||
          product === 'swap' && !rawString(value.settleCcy)) invalid();
    } else if (venue === 'binance') {
      const status = value.status ?? value.contractStatus;
      const datedFuture = rawString(value.contractType) && value.contractType !== 'PERPETUAL' &&
        typeof value.deliveryDate === 'number' && value.deliveryDate > 0 && value.deliveryDate !== perpetualExpiry;
      if (otherCurrency(value.quoteAsset) || value.baseAsset === 'USDT' && value.quoteAsset === 'USDT' ||
          product === 'swap' && (otherCurrency(value.marginAsset) || datedFuture || rawString(value.underlying)) ||
          rawString(status) && status !== 'TRADING' ||
          product === 'spot' && Array.isArray(value.permissions) && value.permissions.includes('TRD_GRP_003')) continue;
      if (!rawString(value.symbol) || !rawString(value.baseAsset) || !rawString(value.quoteAsset) || status !== 'TRADING' ||
          product === 'swap' && (typeof value.contractType !== 'string' ||
            value.contractType !== 'PERPETUAL' && value.deliveryDate !== perpetualExpiry || !rawString(value.marginAsset))) invalid();
    } else {
      const base = product === 'spot' ? value.baseAsset : value.baseCoin;
      const quote = product === 'spot' ? value.quoteAsset : value.quoteCoin;
      const status = product === 'spot' ? value.status : value.state;
      // MEXC safeString accepts numeric status/state. Missing values must not
      // become inactive, and missing settleCoin must not become inverse=true.
      const state = typeof status === 'number' && Number.isFinite(status) ? String(status) : status;
      if (otherCurrency(quote) || base === 'USDT' && quote === 'USDT' || product === 'swap' && otherCurrency(value.settleCoin) ||
          rawString(state) && state !== (product === 'spot' ? '1' : '0') ||
          product === 'spot' && value.isSpotTradingAllowed === false) continue;
      if (!rawString(value.symbol) || !rawString(base) || !rawString(quote) ||
          state !== (product === 'spot' ? '1' : '0') ||
          (product === 'spot' ? value.isSpotTradingAllowed !== true : !rawString(value.settleCoin))) invalid();
    }
  }
}

/** Public ccxt package exports only. No deep imports, keys, private endpoints or
 * direct exchange HTTP. The shared client resolves product routing from symbols.
 * Cloudflare uses polling and its platform fetch supplied to CCXT; Node uses Pro.
 */
export function publicExchangeConfig(venue: Venue, settings: ExchangeSettings, fetchImplementation?: typeof fetch): ConstructorArgs {
  return {
    ...(venue === 'binance' ? {urls:{api:{public:'https://api-gcp.binance.com/api/v3'}}} : {}),
    enableRateLimit: true, timeout: settings.timeoutMs, newUpdates: true,
    ...(fetchImplementation ? { fetchImplementation } : {}),
    options: {
      defaultType: 'spot', fetchCurrencies: false, fetchMargins: false,
      adjustForTimeDifference: false, tradesLimit: settings.tradesLimit,
      ...(venue === 'binance' ? { fetchMarkets: { types: settings.product ? [settings.product === 'spot' ? 'spot' : 'linear'] : ['spot', 'linear'] } }
        : venue === 'okx' ? { fetchMarkets: { types: ['spot', 'swap'] } } : {}),
    },
  };
}
/** A provider must obtain the complete, unfiltered official USD-M
 * /fapi/v1/exchangeInfo envelope during this invocation. capturedAt is the local
 * epoch-millisecond time when that response was captured, using the same clock
 * as now; it must never be a new timestamp attached to an old cached response.
 * serverTime is exchange metadata, not evidence of local snapshot freshness.
 * Completeness/provenance are provider obligations: a local parser cannot prove
 * that an otherwise valid upstream envelope has not been filtered.
 */
export interface BinanceSwapCatalogSnapshot {
  exchangeInfo: unknown;
  capturedAt: number;
}
export type BinanceSwapCatalogProvider = () => Promise<BinanceSwapCatalogSnapshot>;
export interface PublicCcxtFactoryOptions {
  fetchImplementation?: typeof fetch;
  /** Polling-only transport override; Spot and other venues keep the native transport. */
  binanceSwapFetchImplementation?: typeof fetch;
  /** Used only by a Binance client explicitly scoped to swap. */
  binanceSwapCatalog?: BinanceSwapCatalogProvider;
  /** Local capture clock; defaults to Date.now. Override together with the provider in tests. */
  now?: () => number;
  maxCatalogMarkets?: number;
}

export function createPublicCcxtFactory(options: PublicCcxtFactoryOptions = {}): (venue: Venue, settings: ExchangeSettings) => CcxtExchange {
  return (venue, settings): CcxtExchange => {
    if ((options.binanceSwapCatalog || options.binanceSwapFetchImplementation) && venue === 'binance' && !settings.product) throw new Error('invalid_product_scope');
    if (options.binanceSwapFetchImplementation && venue === 'binance' && settings.product === 'swap' && settings.mode !== 'polling') throw new Error('relay_requires_polling');
    const classes = settings.mode === 'stream' ? ccxt.pro : ccxt;
    const transport = venue === 'binance' && settings.product === 'swap' ? options.binanceSwapFetchImplementation ?? options.fetchImplementation : options.fetchImplementation;
    const exchange = new classes[venue](publicExchangeConfig(venue, settings, transport));
    // loadMarkets normally calls fetchCurrencies if has says true; suppress its
    // credential-dependent implementations explicitly, regardless of venue options.
    exchange.has.fetchCurrencies = false;
    // CCXT's public fetch handles transport, JSON and exchange errors first. Its
    // market parsers default missing/wrong-type product collections to [] and
    // silently discard some malformed rows. Validate before committing a partial map.
    // This covers both native Node transport and injected Cloudflare/test fetch.
    const fetchResponse = exchange.fetch.bind(exchange);
    exchange.fetch = async (url, ...args) => {
      const response: unknown = await fetchResponse(url, ...args);
      const parsedUrl = new URL(String(url));
      const path = parsedUrl.pathname;
      const collection = venue === 'binance' && /^\/(api\/v3|fapi\/v1)\/exchangeInfo$/.test(path) ? 'symbols'
        : venue === 'okx' && path === '/api/v5/public/instruments' ? 'data'
        : venue === 'mexc' && path === '/api/v3/exchangeInfo' ? 'symbols'
        : venue === 'mexc' && path === '/api/v1/contract/detail' ? 'data' : null;
      if (collection) {
        if (!record(response) || !Object.hasOwn(response, collection) || !Array.isArray(response[collection])) {
          throw new Error('invalid_catalog_collection');
        }
        const product = venue === 'okx' ? parsedUrl.searchParams.get('instType') === 'SPOT' ? 'spot' : 'swap'
          : path === '/api/v3/exchangeInfo' ? 'spot' : 'swap';
        validateRawCatalog(venue, product, response[collection]);
      }
      return response;
    };
    if (typeof exchange.precisionMode !== 'number') throw new Error('invalid_ccxt_precision_mode');
    const precisionMode = exchange.precisionMode;
    if (options.binanceSwapCatalog && venue === 'binance' && settings.product === 'swap') {
      const provider = options.binanceSwapCatalog;
      const now = options.now ?? Date.now;
      const maxMarkets = options.maxCatalogMarkets ?? 20_000;
      if (!Number.isSafeInteger(maxMarkets) || maxMarkets < 1 || maxMarkets > 50_000) throw new RangeError('invalid_market_source_limit');
      // Keep CCXT's native loadMarkets concurrency/reload semantics and setMarkets.
      // Pro's implicit load consequently uses the same validated seeded maps,
      // without falling back to exchangeInfo REST or credentialed currencies.
      exchange.fetchMarkets = async () => {
        const startedAt = now();
        if (!Number.isSafeInteger(startedAt) || startedAt < 0) throw new Error('invalid_catalog_capture');
        const snapshot: unknown = await provider();
        const completedAt = now();
        if (!record(snapshot) || !Number.isSafeInteger(snapshot.capturedAt) ||
            !Number.isSafeInteger(completedAt) || completedAt < startedAt ||
            (snapshot.capturedAt as number) < startedAt || (snapshot.capturedAt as number) > completedAt) {
          throw new Error('invalid_catalog_capture');
        }
        const info = snapshot.exchangeInfo;
        if (!record(info) || !Object.hasOwn(info, 'symbols') || !Array.isArray(info.symbols) ||
            !rawString(info.timezone) || !Number.isSafeInteger(info.serverTime) || (info.serverTime as number) < 0 ||
            !Array.isArray(info.assets) || !Array.isArray(info.rateLimits) || !Array.isArray(info.exchangeFilters)) {
          throw new Error('invalid_catalog_collection');
        }
        const rows = info.symbols;
        // Bound the complete response, including excluded USDC/inactive/future rows.
        if (rows.length > maxMarkets) throw new Error('catalog_capacity');
        validateRawCatalog('binance', 'swap', rows);
        const rawIds = new Set<string>();
        for (const row of rows) {
          if (!record(row) || !rawString(row.symbol) || !rawString(row.baseAsset) || !rawString(row.quoteAsset) ||
              !rawString(row.marginAsset) || !rawString(row.status ?? row.contractStatus) ||
              typeof row.contractType !== 'string' || !Array.isArray(row.filters)) throw new Error('invalid_catalog_row');
          if (rawIds.has(row.symbol)) throw new Error('duplicate_market');
          rawIds.add(row.symbol);
        }
        const markets = exchange.parseMarkets(rows);
        if (markets.length !== rows.length) throw new Error('invalid_catalog_row');
        const ids = new Set<string>(), symbols = new Set<string>();
        for (const market of markets) {
          if (!market || !rawString(market.id) || !rawString(market.symbol) || market.spot !== false ||
              market.contract !== true || market.type !== 'swap' && market.type !== 'future') throw new Error('invalid_catalog_row');
          if (ids.has(market.id) || symbols.has(market.symbol)) throw new Error('duplicate_market');
          ids.add(market.id); symbols.add(market.symbol);
        }
        // Check before setMarkets indexes by symbol and could collapse duplicate
        // rows or supply defaults that hide incomplete supported metadata.
        normalizeCatalog('binance', Object.fromEntries(markets.map(market => [market!.symbol, market])), precisionMode, maxMarkets);
        return markets;
      };
    }
    const displayMarkets = new Map<string, unknown>();
    return {
      precisionMode: exchange.precisionMode, has: exchange.has,
      loadMarkets: reload => exchange.loadMarkets(reload),
      fetchTicker: symbol => exchange.fetchTicker(symbol),
      seedMarket: market => {
        const identity = parseInstrumentIdentity(market.instrument);
        if (!identity || identity.venue !== venue || identity.type !== settings.product ||
            market.nativeId !== identity.nativeId || market.venue !== venue || market.type !== identity.type ||
            market.symbol !== `${market.base}/USDT${identity.type === 'swap' ? ':USDT' : ''}` || market.quote !== 'USDT' || market.state !== 'live') throw new Error('invalid_quote_market');
        const swap = identity.type === 'swap';
        displayMarkets.delete(market.instrument);
        displayMarkets.set(market.instrument, { id: market.nativeId, symbol: market.symbol, base: market.base, quote: 'USDT',
          active: true, type: identity.type, spot: !swap, swap, future: false, option: false, contract: swap,
          linear: swap, inverse: false, settle: swap ? 'USDT' : undefined, contractSize: swap ? market.contractSize : undefined,
          precision: { price: Number(market.tickSize) } });
        if (displayMarkets.size > 64) displayMarkets.delete(displayMarkets.keys().next().value!);
        exchange.setMarkets([...displayMarkets.values()] as Parameters<typeof exchange.setMarkets>[0]);
      },
      // Request the recent page without CCXT's since filter. The source selects
      // one latest valid sample and rejects cursor regression and exact replay.
      // This also avoids MEXC spot's since+until requirement.
      fetchTrades: (symbol, _since, limit) => exchange.fetchTrades(symbol, undefined, limit),
      ...(settings.mode === 'stream' ? { watchTrades: (symbol: string, since?: number, limit?: number) => exchange.watchTrades(symbol, since, limit) } : {}),
      close: () => exchange.close(),
    };
  };
}
export function createPublicCcxtMarketSource(options: Omit<MarketSourceOptions, 'factory'> & PublicCcxtFactoryOptions) {
  const { fetchImplementation, binanceSwapFetchImplementation, binanceSwapCatalog, ...sourceOptions } = options;
  const splitProducts = sourceOptions.splitProducts ?? (sourceOptions.venues ?? ['binance','okx','mexc']).filter(v => v === 'binance');
  if ((binanceSwapCatalog || binanceSwapFetchImplementation) && (sourceOptions.venues ?? ['binance','okx','mexc']).includes('binance') && !splitProducts.includes('binance')) {
    throw new Error('invalid_product_scope');
  }
  // REST latest sampling shares OKX's 100-row page cap. Pro retains all stream
  // updates in a separate, larger cache; saturation remains a completeness fault.
  const maxBatch = options.maxBatch ?? (options.mode === 'stream' ? 1000 : 100);
  if (options.mode === 'polling' && maxBatch > 100) throw new RangeError('public_trade_page_capacity');
  return createCcxtMarketSource({ ...sourceOptions, splitProducts, maxBatch,
    factory: createPublicCcxtFactory({ ...(fetchImplementation ? { fetchImplementation } : {}),
      ...(binanceSwapCatalog ? { binanceSwapCatalog } : {}),
      ...(binanceSwapFetchImplementation ? { binanceSwapFetchImplementation } : {}),
      ...(sourceOptions.now ? { now: sourceOptions.now } : {}),
      ...(sourceOptions.maxCatalogMarkets !== undefined ? { maxCatalogMarkets: sourceOptions.maxCatalogMarkets } : {}) }) });
}
