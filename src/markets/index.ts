// The core entry has no CCXT import. Import ./ccxt.js explicitly for public
// library clients, keeping tests and injected Cloudflare factories independent.
export { createCcxtMarketSource } from './source.js';
export type { MarketSource, MarketSourceOptions, MarketMode, CcxtExchange, ExchangeFactory, ExchangeSettings, SourceDiagnostics } from './source.js';
export { instrumentId, normalizeMarket, normalizeCatalog, VENUES } from './normalize.js';
export type { NormalizedMarket } from './normalize.js';
