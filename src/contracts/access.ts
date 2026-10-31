import type { UserIdentity } from './domain.js';

export const PRO_FEATURES = ['price_alerts', 'anomaly_crypto', 'anomaly_tradfi', 'native_charts', 'drawing_tools', 'market_favorites', 'notification_channels', 'trading'] as const;
export type ProductFeature = typeof PRO_FEATURES[number];
export interface ProductAccess {
  plan: 'pro';
  phase: 'invite_beta';
  source: 'beta_policy';
  policyVersion: 1;
  billing: 'not_enabled';
  expiresAt: null;
  features: Record<ProductFeature, boolean>;
  /** null is an explicit unlimited business entitlement. */
  limits: { alerts: number | null; instruments: number | null; channels: number | null; favorites: number | null; priceAttemptsPerDay: number | null };
}
export interface AccountUsage {
  observedAt: number;
  utcDate: string;
  alerts: number;
  activeAlerts: number;
  instruments: number;
  channels: number | null;
  favorites: number | null;
  priceAttempts: number;
}
export interface AccountOverview { user: UserIdentity; access: ProductAccess; usage: AccountUsage }
