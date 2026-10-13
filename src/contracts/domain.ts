import { z } from 'zod';

export type Id = string;
export type EpochMs = number;
export type RuleSide = 'upper' | 'lower';
export type RuleStatus = 'disabled' | 'armed' | 'queued' | 'sending' | 'latched';
export type DeliveryOutcome = 'sent' | 'failed' | 'expired' | 'cancelled' | 'uncertain' | 'daily_limit';
export type HealthState = 'healthy' | 'degraded' | 'unhealthy' | 'starting';

export type Venue = 'binance' | 'okx' | 'mexc';
export type MarketType = 'spot' | 'swap';
/** This representation belongs exclusively to legacy OKX linear USDT swaps. */
export const legacyInstrumentSchema = z.string().regex(/^[A-Z0-9]{1,24}-USDT-SWAP$/);
export const nativeMarketIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:/+\-]+$/);
export interface InstrumentIdentity { venue: Venue; type: MarketType; nativeId: string }
/** Percent encoding must round-trip exactly: one identity has one representation. */
export function parseInstrumentIdentity(value: string): InstrumentIdentity | null {
  if (legacyInstrumentSchema.safeParse(value).success) return { venue: 'okx', type: 'swap', nativeId: value };
  if (value.length > 400) return null;
  const match = /^(binance|okx|mexc):(spot|swap):([^:]+)$/.exec(value);
  if (!match) return null;
  try {
    const nativeId = decodeURIComponent(match[3]!);
    if (!nativeMarketIdSchema.safeParse(nativeId).success || encodeURIComponent(nativeId) !== match[3]) return null;
    if (match[1] === 'okx' && match[2] === 'swap' && legacyInstrumentSchema.safeParse(nativeId).success) return null;
    return { venue: match[1] as Venue, type: match[2] as MarketType, nativeId };
  } catch { return null; }
}
export const instrumentSchema = z.string().min(1).max(400).refine(value => parseInstrumentIdentity(value) !== null, 'invalid instrument identity');
export const notificationOptionsSchema = z.strictObject({
  priority: z.number().int().min(-2).max(2),
  retry: z.number().int().min(30).max(3600),
  expire: z.number().int().min(30).max(10800),
  sound: z.string().regex(/^[A-Za-z0-9_-]{0,64}$/),
}).refine((value) => value.expire >= value.retry, { message: 'expire must be >= retry', path: ['expire'] });
export type NotificationOptions = z.infer<typeof notificationOptionsSchema>;
export const DEFAULT_NOTIFICATION: Readonly<NotificationOptions> = Object.freeze({ priority: 2, retry: 30, expire: 1500, sound: 'siren' });

export const alertInputSchema = z.strictObject({
  name: z.string().trim().min(1).refine((value) => [...value].length <= 80, 'name must contain <= 80 characters'),
  instrument: instrumentSchema,
  side: z.enum(['upper', 'lower']),
  threshold: z.number().finite().positive().max(1e12),
  enabled: z.boolean(),
});
export type AlertInput = z.infer<typeof alertInputSchema>;
export const createAlertSchema = alertInputSchema.extend({ enabled: z.boolean().default(true) });
export type CreateAlert = z.input<typeof createAlertSchema>;
export const patchAlertSchema = alertInputSchema.partial().extend({ expectedGeneration: z.number().int().nonnegative() })
  .refine((value) => Object.keys(value).some((key) => key !== 'expectedGeneration'), 'patch requires a change');
export type PatchAlert = z.infer<typeof patchAlertSchema>;
export const rearmAlertSchema = z.strictObject({ expectedGeneration: z.number().int().nonnegative() });

export interface PriceTick {
  instrument: string;
  price: number;
  timestamp: EpochMs;
  receivedAt: EpochMs;
}
export interface Market {
  instrument: string;
  base: string;
  quote: 'USDT';
  tickSize: string;
  state: 'live';
  tradingViewSymbol: string;
  /** Optional only for compatibility with existing legacy fixtures. Production sources populate all fields. */
  venue?: Venue;
  type?: MarketType;
  nativeId?: string;
  symbol?: string;
  settle?: 'USDT' | null;
  contractSize?: number | null;
}
export interface PendingDelivery {
  triggerId: Id;
  generation: number;
  phase: 'queued' | 'sending';
  attempts: number;
  nextAt: EpochMs;
  createdAt: EpochMs;
  price: number;
  timestamp: EpochMs;
}
export interface DeliveryResult {
  triggerId: Id;
  outcome: DeliveryOutcome;
  at: EpochMs;
  attempts: number;
  code: string | null;
  /** Provider receipt is a capability secret: never expose it to browser responses. */
  receiptAvailable: boolean;
}
export interface Alert extends AlertInput {
  id: Id;
  generation: number;
  triggered: boolean;
  triggerId: Id | null;
  pending: PendingDelivery | null;
  last: DeliveryResult | null;
  status: RuleStatus;
  createdAt: EpochMs;
  updatedAt: EpochMs;
}
export interface UserSettings {
  enabled: boolean;
  dailyLimit: number;
  notification: NotificationOptions;
}
export interface UserIdentity {
  id: Id;
  email: string;
  name: string;
  role: 'user' | 'admin';
  disabled: boolean;
}

/** Ciphertext only: encrypt with AES-256-GCM, random 96-bit IV and user/field AAD. */
export interface EncryptedSecret {
  version: 1;
  algorithm: 'A256GCM';
  iv: string;
  ciphertext: string;
}
export interface ChannelProfile {
  provider: 'pushover';
  configured: boolean;
  tokenSource: 'shared' | 'private' | 'missing';
  userKeyPresent: boolean;
  privateTokenPresent: boolean;
  updatedAt: EpochMs | null;
}
export const putChannelSchema = z.strictObject({
  provider: z.literal('pushover'),
  userKey: z.string().regex(/^[A-Za-z0-9]{30}$/).optional(),
  /** null clears private override; omitted retains it. Shared env token is default. */
  appToken: z.string().regex(/^[A-Za-z0-9]{30}$/).nullable().optional(),
});
export type PutChannel = z.infer<typeof putChannelSchema>;
export const testNotificationSchema = z.strictObject({ confirm: z.literal(true) });

export interface ComponentHealth {
  state: HealthState;
  lastSuccessAt: EpochMs | null;
  code: string | null;
}
export interface SystemStatus {
  user: UserIdentity;
  settings: UserSettings;
  settingsGeneration: number;
  daily: { date: string; attempts: number; limit: number };
  health: {
    overall: HealthState;
    database: ComponentHealth;
    scheduler: ComponentHealth;
    prices: ComponentHealth;
    notifications: ComponentHealth;
    email: ComponentHealth;
  };
  scheduler: { pollIntervalMs: 5000; lastPollAt: EpochMs | null; coordinatorId: 'coordinator-v1'; marketMode?: 'stream' | 'polling' };
  prices: PriceTick[];
  channel: ChannelProfile;
  capabilities: { google: boolean; emailOtp: boolean; inviteOnly: boolean; canAdmin: boolean };
}
