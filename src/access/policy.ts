import type { AppConfig } from '../config.js';
import { PRO_FEATURES, type ProductAccess, type ProductFeature } from '../contracts/access.js';
import { MAX_CHANNELS } from '../notifications/hub.js';

/** All invited beta participants receive Pro. Billing must supply a new policy explicitly later. */
export function betaAccess(config: Pick<AppConfig, 'limits'>, priceAttemptsPerDay: number): ProductAccess {
  return {
    plan: 'pro', phase: 'invite_beta', source: 'beta_policy', policyVersion: 1,
    billing: 'not_enabled', expiresAt: null,
    features: Object.fromEntries(PRO_FEATURES.map(feature => [feature, true])) as Record<ProductFeature, boolean>,
    limits: { alerts: config.limits.alertsPerUser, instruments: config.limits.instrumentsPerUser,
      channels: MAX_CHANNELS, favorites: 50, priceAttemptsPerDay: Math.min(priceAttemptsPerDay, config.limits.dailyNotificationAttempts) },
  };
}
