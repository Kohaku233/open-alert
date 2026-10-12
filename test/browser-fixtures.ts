// UI-only MOCK fixture for scripts/browser-mock-check.mjs.
// scripts/browser-check.mjs exercises compiled Node, real OTP/cookies and SQLite instead.
// No actual users, market ticks, credentials or delivery in this fixture.
import type { Alert, ChannelProfile, Market, SystemStatus, UserIdentity } from '../src/contracts/domain.js';
export { createAlertSchema, patchAlertSchema, rearmAlertSchema, notificationOptionsSchema, putChannelSchema, testNotificationSchema } from '../src/contracts/domain.js';

export function makeBrowserFixture() {
  const now = Date.now();
  const user: UserIdentity = { id: 'mock-user', email: 'mock@example.test', name: 'MOCK 用户', role: 'user', disabled: false };
  const channel: ChannelProfile = { provider: 'pushover', configured: true, tokenSource: 'private', userKeyPresent: true, privateTokenPresent: true, updatedAt: now };
  const component = { state: 'healthy' as const, lastSuccessAt: now, code: null };
  const status: SystemStatus = {
    user, channel,
    settings: { enabled: false, dailyLimit: 20, notification: { priority: 2, retry: 30, expire: 1500, sound: 'siren' } }, settingsGeneration: 0,
    daily: { date: new Date(now).toISOString().slice(0, 10), attempts: 0, limit: 20 },
    health: { overall: 'healthy', database: { ...component }, scheduler: { ...component }, prices: { ...component }, notifications: { ...component }, email: { ...component } },
    scheduler: { pollIntervalMs: 5000, lastPollAt: now, coordinatorId: 'coordinator-v1' },
    prices: [{ instrument: 'BTC-USDT-SWAP', price: 60000, timestamp: now, receivedAt: now }],
    capabilities: { google: false, emailOtp: true, inviteOnly: true, canAdmin: false },
  };
  const markets: Market[] = ['BTC', 'ETH'].map(base => ({ instrument: `${base}-USDT-SWAP`, base, quote: 'USDT', tickSize: '0.1', state: 'live', tradingViewSymbol: `OKX:${base}USDT.P` }));
  const base: Alert = { id: 'mock-armed', name: 'MOCK BTC 上沿', instrument: 'BTC-USDT-SWAP', side: 'upper', threshold: 61000, enabled: true, generation: 0, triggered: false, triggerId: null, pending: null, last: null, status: 'armed', createdAt: now, updatedAt: now };
  const alerts: Alert[] = [base,
    { ...base, id: 'mock-uncertain', name: 'MOCK 投递不确定', threshold: 59000, generation: 1, triggered: true, triggerId: 'mock-trigger-uncertain', status: 'latched', last: { triggerId: 'mock-trigger-uncertain', outcome: 'uncertain', at: now, attempts: 1, code: 'provider_uncertain', receiptAvailable: false } },
    { ...base, id: 'mock-pending', name: 'MOCK 排队通知', generation: 2, triggered: true, triggerId: 'mock-trigger-pending', status: 'queued', pending: { triggerId: 'mock-trigger-pending', generation: 2, phase: 'queued', attempts: 0, nextAt: now, createdAt: now, price: 62000, timestamp: now } },
  ];
  return { status, alerts, markets };
}
