import type { AppConfig } from '../config.js';
import type { OpenAlertAuth } from '../auth/index.js';
import type { ChannelRecord, Repositories, SqlDatabase } from '../contracts/db.js';
import type { ComponentHealth, EncryptedSecret, Market, PriceTick, SystemStatus } from '../contracts/domain.js';
export interface CatalogSnapshot { markets: Market[]; updatedAt: number | null; stale: boolean }
export interface RuntimeSnapshot { health: SystemStatus['health']; lastPollAt: number | null; prices: PriceTick[] }
export interface NotificationPort {
  encrypt(key: string, userId: string, field: 'userKey' | 'appToken' | 'receipt', plaintext: string): Promise<EncryptedSecret>;
  validate(userId: string, channel: ChannelRecord): Promise<void>;
  test(userId: string, channel: ChannelRecord): Promise<{ outcome: 'sent' | 'failed' | 'uncertain'; code: string | null }>;
  health(): ComponentHealth;
}
export interface ApiDependencies {
  config: AppConfig; db: SqlDatabase; repositories: Repositories; auth: OpenAlertAuth;
  catalog: { get(): Promise<CatalogSnapshot> };
  runtime: { snapshot(): Promise<RuntimeSnapshot> };
  notifications: NotificationPort;
  wake(): Promise<void>;
}
