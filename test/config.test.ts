import assert from 'node:assert/strict';
import test from 'node:test';
import { ConfigurationError, decodeEncryptionKey, loadConfig } from '../src/config.js';
import { createAlertSchema, patchAlertSchema, putChannelSchema, testNotificationSchema } from '../src/contracts/domain.js';

const base = {
  NODE_ENV: 'development',
  APP_URL: 'http://localhost:3000',
  AUTH_SECRET: 'test-auth-secret-must-be-at-least-32-characters',
  ENCRYPTION_KEY: 'ab'.repeat(32),
  EMAIL_PROVIDER: 'console',
};

test('local defaults are invite-only, disabled credentials, Node SQLite and 5s polling', () => {
  const config = loadConfig(base);
  assert.equal(config.dbDriver, 'sqlite');
  assert.equal(config.inviteOnly, true);
  assert.equal(config.google, null);
  assert.equal(config.secureCookies, false);
  assert.equal(config.runtime.pollIntervalMs, 5000);
  assert.equal(config.limits.dailyNotificationAttempts, 20);
});

test('production requires HTTPS and a real email transport', () => {
  assert.throws(() => loadConfig({ ...base, NODE_ENV: 'production' }), ConfigurationError);
  const config = loadConfig({ ...base, NODE_ENV: 'production', APP_URL: 'https://alerts.example.com', EMAIL_PROVIDER: 'resend', EMAIL_FROM: 'alerts@example.com', RESEND_API_KEY: 'test-only-resend-key' });
  assert.equal(config.secureCookies, true);
  assert.equal(config.appUrl, 'https://alerts.example.com');
  assert.throws(() => loadConfig({ ...base, APP_URL: 'http://alerts.example.com' }), ConfigurationError);
  assert.throws(() => loadConfig({ ...base, APP_URL: 'https://alerts.example.com/app' }), ConfigurationError);
});

test('Resend modes require an explicit sandbox recipient and preserve domain checking by default', () => {
  const resend = { ...base, EMAIL_PROVIDER: 'resend', EMAIL_FROM: 'alerts@example.com', RESEND_API_KEY: 'fixture-key' };
  const defaults = loadConfig(resend);
  assert.equal(defaults.email.resendVerifyDomain, true);
  assert.equal(defaults.email.senderMode, 'resend_domain_check');
  assert.equal(defaults.email.testRecipient, undefined);
  assert.equal(loadConfig({ ...resend, RESEND_VERIFY_DOMAIN: 'false' }).email.senderMode, 'resend_sending_only');
  assert.throws(() => loadConfig({ ...resend, RESEND_VERIFY_DOMAIN: '0' }), ConfigurationError);
  for (const sender of ['onboarding@resend.dev', 'Open Alert <ONBOARDING@RESEND.DEV>']) {
    assert.throws(() => loadConfig({ ...resend, EMAIL_FROM: sender }), (error: unknown) => {
      assert.ok(error instanceof ConfigurationError);
      assert.deepEqual(error.fields, ['EMAIL_TEST_RECIPIENT']);
      return true;
    });
    const sandbox = loadConfig({ ...resend, EMAIL_FROM: sender, EMAIL_TEST_RECIPIENT: '  Owner@Example.COM  ', GOOGLE_CLIENT_ID: 'fixture-client', GOOGLE_CLIENT_SECRET: 'fixture-secret' });
    assert.equal(sandbox.email.senderMode, 'resend_sandbox');
    assert.equal(sandbox.email.testRecipient, 'owner@example.com');
    assert.equal(sandbox.inviteOnly, true);
    assert.ok(sandbox.google);
  }
  const invalidRecipient = 'private-recipient-without-domain';
  assert.throws(() => loadConfig({ ...resend, EMAIL_TEST_RECIPIENT: invalidRecipient }), (error: unknown) => {
    assert.ok(error instanceof ConfigurationError);
    assert.deepEqual(error.fields, ['EMAIL_TEST_RECIPIENT']);
    assert.equal(JSON.stringify(error).includes(invalidRecipient), false);
    assert.equal(error.message.includes(invalidRecipient), false);
    return true;
  });
});

test('driver/runtime pairing and transport compatibility are enforced', () => {
  assert.throws(() => loadConfig({ ...base, DEPLOYMENT: 'cloudflare' }), ConfigurationError);
  assert.throws(() => loadConfig({ ...base, DB_DRIVER: 'd1' }), ConfigurationError);
  assert.throws(() => loadConfig({ ...base, DEPLOYMENT: 'cloudflare', DB_DRIVER: 'd1', EMAIL_PROVIDER: 'smtp', EMAIL_FROM: 'alerts@example.com', SMTP_URL: 'smtp://localhost:25' }), ConfigurationError);
  assert.equal(loadConfig({ ...base, DEPLOYMENT: 'cloudflare', DB_DRIVER: 'd1' }).dbDriver, 'd1');
  assert.throws(() => loadConfig({ ...base, DB_DRIVER: 'postgres', DATABASE_URL: 'https://db.example.com' }), ConfigurationError);
  assert.equal(loadConfig({ ...base, DB_DRIVER: 'postgres', DATABASE_URL: 'postgresql://localhost/open_alert' }).dbDriver, 'postgres');
});

test('key encoding, Google pairing, booleans and limits reject unsafe input', () => {
  assert.equal(decodeEncryptionKey(base.ENCRYPTION_KEY).length, 32);
  assert.equal(decodeEncryptionKey(Buffer.alloc(32, 1).toString('base64')).length, 32);
  assert.throws(() => decodeEncryptionKey('a'.repeat(32)));
  for (const patch of [{ ENCRYPTION_KEY: 'a'.repeat(32) }, { GOOGLE_CLIENT_ID: 'orphan' }, { INVITE_ONLY: '0' }, { DAILY_NOTIFICATION_LIMIT: '21' }, { MAX_ALERTS_PER_USER: '-1' }, { BOOTSTRAP_TOKEN: 'short' }]) {
    assert.throws(() => loadConfig({ ...base, ...patch }), ConfigurationError);
  }
});

test('validation errors disclose field names only, even for secret input', () => {
  const secret = 'sensitive-value-that-must-not-appear';
  assert.throws(() => loadConfig({ ...base, ENCRYPTION_KEY: secret }), (error: unknown) => {
    assert.ok(error instanceof ConfigurationError);
    assert.ok(error.message.includes('ENCRYPTION_KEY'));
    assert.ok(!error.message.includes(secret));
    assert.ok(!JSON.stringify(error).includes(secret));
    return true;
  });
});

test('request schemas reject ownership injection, implicit rearm and coerced prices', () => {
  const input = { name: 'BTC upper', instrument: 'BTC-USDT-SWAP', side: 'upper', threshold: 100_000 };
  assert.equal(createAlertSchema.parse(input).enabled, true);
  for (const patch of [{ userId: 'another-user' }, { triggered: false }, { threshold: '100000' }, { threshold: 0 }, { instrument: 'BTC-USDT' }]) {
    assert.equal(createAlertSchema.safeParse({ ...input, ...patch }).success, false);
  }
  assert.equal(patchAlertSchema.safeParse({ threshold: 90_000 }).success, false);
  assert.equal(patchAlertSchema.safeParse({ expectedGeneration: 1 }).success, false);
  assert.equal(patchAlertSchema.safeParse({ threshold: 90_000, expectedGeneration: 1 }).success, true);
  assert.equal(testNotificationSchema.safeParse({}).success, false);
  assert.equal(testNotificationSchema.safeParse({ confirm: true }).success, true);
  assert.equal(putChannelSchema.safeParse({ provider: 'pushover', userKey: 'A'.repeat(30), userId: 'other' }).success, false);
});
