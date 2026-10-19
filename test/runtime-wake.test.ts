import test from 'node:test';
import assert from 'node:assert/strict';
import { wakeWithRetry } from '../src/runtime/wake.js';

test('wake retries only failed effects, confirms recovery, and bounds an abort-ignoring transport', async () => {
  let calls = 0;
  assert.equal(await wakeWithRetry(async () => { if (++calls < 3) throw new Error('transient'); }, { retryMs: 0 }), true);
  assert.equal(calls, 3);
  calls = 0;
  const signals: AbortSignal[] = [];
  const started = performance.now();
  assert.equal(await wakeWithRetry(async signal => { calls++; signals.push(signal); await new Promise(() => {}); }, { timeoutMs: 10, retryMs: 0 }), false);
  assert.equal(calls, 3); assert.ok(signals.every(signal => signal.aborted));
  assert.ok(performance.now() - started < 1000);
  calls = 0;
  assert.equal(await wakeWithRetry(async () => { calls++; throw new Error('unavailable'); }, { retryMs: 0 }), false);
  assert.equal(calls, 3);
});
