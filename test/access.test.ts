import { test } from 'node:test';
import assert from 'node:assert/strict';
import { betaAccess } from '../src/access/policy.js';
import { PRO_FEATURES } from '../src/contracts/access.js';
import { MAX_CHANNELS } from '../src/notifications/hub.js';

test('invite beta policy grants every Pro feature while preserving configured limits', () => {
  const config = {
    limits: {
      users: 1_000,
      alertsPerUser: 17,
      instrumentsPerUser: 6,
      activeAlerts: 2_000,
      globalInstruments: 200,
      dailyNotificationAttempts: 13,
      globalNotificationAttempts: 20_000,
    },
  };

  const access = betaAccess(config, 9);

  assert.deepEqual(access, {
    plan: 'pro',
    phase: 'invite_beta',
    source: 'beta_policy',
    policyVersion: 1,
    billing: 'not_enabled',
    expiresAt: null,
    features: Object.fromEntries(PRO_FEATURES.map(feature => [feature, true])),
    limits: {
      alerts: 17,
      instruments: 6,
      channels: MAX_CHANNELS,
      favorites: 50,
      priceAttemptsPerDay: 9,
    },
  });
  assert.deepEqual(Object.keys(access.features).sort(), [...PRO_FEATURES].sort());
  assert.ok(Object.values(access.features).every(enabled => enabled === true));
});

test('invite beta price attempts cannot exceed the existing deployment ceiling', () => {
  const access = betaAccess({
    limits: {
      users: 1_000,
      alertsPerUser: 20,
      instrumentsPerUser: 8,
      activeAlerts: 2_000,
      globalInstruments: 200,
      dailyNotificationAttempts: 20,
      globalNotificationAttempts: 20_000,
    },
  }, 999);

  assert.equal(access.limits.priceAttemptsPerDay, 20);
  assert.equal(access.billing, 'not_enabled');
  assert.equal(access.expiresAt, null);
});

test('admin access uses explicit null limits for every business quota', () => {
  const access = betaAccess({
    limits: {
      users: 1_000,
      alertsPerUser: 17,
      instrumentsPerUser: 6,
      activeAlerts: 2_000,
      globalInstruments: 200,
      dailyNotificationAttempts: 13,
      globalNotificationAttempts: 20_000,
    },
  }, 9, 'admin');

  assert.deepEqual(access.limits, {
    alerts: null,
    instruments: null,
    channels: null,
    favorites: null,
    priceAttemptsPerDay: null,
  });
  assert.ok(Object.values(access.features).every(enabled => enabled === true));
});
