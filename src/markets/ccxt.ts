import ccxt from 'ccxt';
import type { ConstructorArgs } from 'ccxt';
import { currencyCodeSchema, type Venue } from '../contracts/domain.js';
import { createCcxtMarketSource } from './source.js';
import { record } from './normalize.js';
import type { CcxtExchange, ExchangeFactory, ExchangeSettings, MarketSourceOptions } from './source.js';

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
    enableRateLimit: true, timeout: settings.timeoutMs, newUpdates: true,
    ...(fetchImplementation ? { fetchImplementation } : {}),
    options: {
      defaultType: 'spot', fetchCurrencies: false, fetchMargins: false,
      adjustForTimeDifference: false, tradesLimit: settings.tradesLimit,
      ...(venue === 'binance' ? { fetchMarkets: { types: ['spot', 'linear'] } }
        : venue === 'okx' ? { fetchMarkets: { types: ['spot', 'swap'] } } : {}),
    },
  };
}
export function createPublicCcxtFactory(options: { fetchImplementation?: typeof fetch } = {}): ExchangeFactory {
  return (venue, settings): CcxtExchange => {
    const classes = settings.mode === 'stream' ? ccxt.pro : ccxt;
    const exchange = new classes[venue](publicExchangeConfig(venue, settings, options.fetchImplementation));
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
    return {
      precisionMode: exchange.precisionMode, has: exchange.has,
      loadMarkets: reload => exchange.loadMarkets(reload),
      // Request the recent page without CCXT's since filter. The source selects
      // one latest valid sample and rejects cursor regression and exact replay.
      // This also avoids MEXC spot's since+until requirement.
      fetchTrades: (symbol, _since, limit) => exchange.fetchTrades(symbol, undefined, limit),
      ...(settings.mode === 'stream' ? { watchTrades: (symbol: string, since?: number, limit?: number) => exchange.watchTrades(symbol, since, limit) } : {}),
      close: () => exchange.close(),
    };
  };
}
export function createPublicCcxtMarketSource(options: Omit<MarketSourceOptions, 'factory'> & { fetchImplementation?: typeof fetch }) {
  const { fetchImplementation, ...sourceOptions } = options;
  // REST latest sampling shares OKX's 100-row page cap. Pro retains all stream
  // updates in a separate, larger cache; saturation remains a completeness fault.
  const maxBatch = options.maxBatch ?? (options.mode === 'stream' ? 1000 : 100);
  if (options.mode === 'polling' && maxBatch > 100) throw new RangeError('public_trade_page_capacity');
  return createCcxtMarketSource({ ...sourceOptions, maxBatch,
    factory: createPublicCcxtFactory(fetchImplementation ? { fetchImplementation } : {}) });
}
