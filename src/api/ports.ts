import type { AppConfig } from '../config.js';
import type { OpenAlertAuth } from '../auth/index.js';
import type { ChannelRecord, Repositories, SqlDatabase } from '../contracts/db.js';
import type { ComponentHealth, EncryptedSecret, Market, PriceTick, SystemStatus } from '../contracts/domain.js';
import type { MarketQuery } from './markets.js';
export interface CatalogSource { type?: 'spot' | 'swap'; venue?: 'binance' | 'okx' | 'mexc'; updatedAt: number | null; stale: boolean; code?: string | null }
export type CatalogMarket = Market & { available?: boolean };
export interface CatalogSnapshot {
  markets: CatalogMarket[]; updatedAt: number | null; stale: boolean;
  /** Freshness is scoped to the selected venue; aggregate stale can mean a partial outage. */
  sources?: Partial<Record<'binance' | 'okx' | 'mexc', CatalogSource>> | (CatalogSource & { venue: 'binance' | 'okx' | 'mexc' })[];
}
export interface RuntimeSnapshot { health: SystemStatus['health']; lastPollAt: number | null; prices: PriceTick[]; marketMode?: 'stream' | 'polling' }
export interface NotificationPort {
  encrypt(key: string, userId: string, field: 'userKey' | 'appToken' | 'receipt', plaintext: string): Promise<EncryptedSecret>;
  validate(userId: string, channel: ChannelRecord): Promise<void>;
  test(userId: string, channel: ChannelRecord): Promise<{ outcome: 'sent' | 'failed' | 'uncertain'; code: string | null }>;
  health(): ComponentHealth;
}
export interface ApiDependencies {
  config: AppConfig; db: SqlDatabase; repositories: Repositories; auth: OpenAlertAuth;
  catalog: {
    get(): Promise<CatalogSnapshot>;
    /** A trusted coordinator can prepare the envelope without reparsing a full directory at the edge. */
    response?(query: MarketQuery | null, requestId: string): Promise<Response>;
    resolve?(instrument: string): Promise<{ market: CatalogMarket | null; stale: boolean; available: boolean }>;
  };
  quotes?: { get(market: Market): Promise<import('../markets/quotes.js').MarketQuote> };
  runtime: { snapshot(): Promise<RuntimeSnapshot> };
  notifications: NotificationPort;
  wake(): Promise<void>;
}
