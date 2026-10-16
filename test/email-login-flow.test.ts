import test from 'node:test';
import assert from 'node:assert/strict';
import { emailAddress, parseEmailLoginFlow, OTP_LIFETIME_MS } from '../web/email-login-flow.js';
const now = 1_800_000_000_000;
const attempt = { email: 'invited@example.test', requestedAt: now, expiresAt: now + OTP_LIFETIME_MS, retryAt: now + 60_000, delivery: 'accepted' };
const raw = (overrides = {}) => JSON.stringify({ version: 1, email: attempt.email, step: 'code', attempts: [attempt], ...overrides });
test('restoring an email challenge preserves its original cooldown and validity', () => {
  const result = parseEmailLoginFlow(raw(), now + 20_000);
  assert.equal(result.step, 'code');
  assert.equal(result.attempts[0]!.retryAt - (now + 20_000), 40_000);
  assert.equal(result.attempts[0]!.expiresAt, attempt.expiresAt);
  assert.equal(parseEmailLoginFlow(raw(), now + OTP_LIFETIME_MS + 1).step, 'code', 'Expired code stays visible with a resend path');
});
test('interrupted sending can resume without dispatching another email', () => {
  const result = parseEmailLoginFlow(raw({ attempts: [{ ...attempt, delivery: 'pending' }] }), now + 1000);
  assert.equal(result.step, 'code');
  assert.equal(result.attempts[0]!.delivery, 'pending');
});
test('malformed, stale, future and unrelated challenges cannot select a code step', () => {
  for (const value of [null, '', 'null', '{', raw({ version: 2 }), raw({ attempts: null }), raw({ attempts: [null] }), raw({ email: 'other@example.test' }), raw({ attempts: [{ ...attempt, retryAt: '60000' }] }), raw({ attempts: [{ ...attempt, delivery: 'failed' }] })]) {
    assert.equal(parseEmailLoginFlow(value, now).step, 'email');
  }
  assert.equal(parseEmailLoginFlow(raw(), now - 1).step, 'email');
  assert.equal(parseEmailLoginFlow(raw(), now + 30 * 60_000 + 1).attempts.length, 0);
});
test('restored metadata strips arbitrary properties, OTPs and tokens', () => {
  const result = parseEmailLoginFlow(raw({ otp: '123456', token: 'private', attempts: [{ ...attempt, otp: '123456', token: 'private' }] }), now);
  assert.deepEqual(result, { email: attempt.email, step: 'code', attempts: [attempt] });
  assert.equal(emailAddress('  INVITED@example.test '), attempt.email);
  assert.equal(emailAddress('not-an-email'), '');
});
