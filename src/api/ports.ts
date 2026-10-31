import type { AppConfig } from '../config.js';
import type { OpenAlertAuth } from '../auth/index.js';
import type { ChannelRecord, Repositories, SqlDatabase } from '../contracts/db.js';
import type { ComponentHealth, EncryptedSecret, Market, PriceTick, SystemStatus } from '../contracts/domain.js';
import type { MarketQuery } from './markets.js';
import type { ObservabilitySnapshot } from '../contracts/observability.js';
export interface CatalogSource { type?: 'spot' | 'swap'; venue?: 'binance' | 'okx' | 'mexc'; updatedAt: number | null; stale: boolean; code?: string | null }
export type CatalogMarket = Market & { available?: boolean };
export interface CatalogSelection { market: CatalogMarket | null; stale: boolean; available: boolean }
export interface CatalogSnapshot {
  markets: CatalogMarket[]; updatedAt: number | null; stale: boolean;
  /** Freshness is scoped to the selected venue; aggregate stale can mean a partial outage. */
  sources?: Partial<Record<'binance' | 'okx' | 'mexc', CatalogSource>> | (CatalogSource & { venue: 'binance' | 'okx' | 'mexc' })[];
}
export interface RuntimeSnapshot { health: SystemStatus['health']; lastPollAt: number | null; prices: PriceTick[]; marketMode?: 'stream' | 'polling' }
export type QuoteLookup = { quote: import('../markets/quotes.js').MarketQuote; code?: never }
  | { quote: null; code: 'invalid_request' | 'service_unavailable' };
export interface NotificationPort {
  encrypt(key: string, userId: string, field: import('../notifications/crypto.js').SecretField, plaintext: string): Promise<EncryptedSecret>;
  validate(userId: string, channel: ChannelRecord): Promise<void>;
  test(userId: string, channel: ChannelRecord): Promise<{ outcome: 'sent' | 'failed' | 'uncertain'; code: string | null }>;
  health(): ComponentHealth;
}
export interface ApiDependencies {
  publicPreview?: { get(): Promise<import('../markets/public-preview.js').PublicMarketPreview> };
  config: AppConfig; db: SqlDatabase; repositories: Repositories; auth: OpenAlertAuth;
  catalog: {
    get(): Promise<CatalogSnapshot>;
    /** A trusted coordinator can prepare the envelope without reparsing a full directory at the edge. */
    response?(query: MarketQuery | null, requestId: string): Promise<Response>;
    resolve?(instrument: string): Promise<CatalogSelection>;
  };
  quotes?: {
    get(market: Market): Promise<import('../markets/quotes.js').MarketQuote>;
    /** Resolve freshness, availability and the display quote in one coordinator call. */
    lookup?(instrument: string): Promise<QuoteLookup>;
  };
  /** Built-in chart history; absent on runtimes that only offer the TradingView embed. */
  candles?: {
    get(market: Market, timeframe: import('../markets/candles.js').CandleTimeframe, before?: number): Promise<import('../markets/candles.js').CandlePage>;
  };
  /** Contract anomaly monitor; Node runtime only. */
  anomaly?: {
    store: import('../anomaly/store.js').AnomalyStore;
    status(): import('../anomaly/engine.js').AnomalyStatus;
  };
  /** Stateless signed-request relay to OKX; Node runtime only (fixed IPv4 egress for key whitelists). */
  trade?: import('../trade/okx-contract.js').OkxRelay;
  /** Multi-channel notification centre (channels + source routing); Node runtime only. */
  hub?: import('../notifications/hub.js').NotifyHub;
  runtime: { snapshot(): Promise<RuntimeSnapshot>; observe?(): Promise<ObservabilitySnapshot> };
  notifications: NotificationPort;
  wake(signal?: AbortSignal): Promise<void>;
}
