import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOkxRelay, RelayUncertainError, RelayUnavailableError } from '../src/trade/okx-relay.js';

const headers = { key: 'k', sign: 's', timestamp: '2026-10-31T00:00:00.000Z', passphrase: 'p' };

test('relay rejects non-allowlisted requests before sending', async () => {
  let sends = 0;
  const relay = createOkxRelay({ send: async () => { sends++; return { status: 200, body: '' }; } });
  await assert.rejects(relay.forward({ method: 'POST', path: '/api/v5/asset/withdrawal', query: '', body: '{}', headers, simulated: false }));
  await assert.rejects(relay.forward({ method: 'GET', path: '/api/v5/account/balance', query: 'a=b c', body: '', headers, simulated: false }));
  assert.equal(sends, 0);
});

test('relay keeps the unsent/uncertain distinction and maps unknown failures to uncertain', async () => {
  for (const [error, kind] of [[new RelayUnavailableError(), RelayUnavailableError], [new RelayUncertainError(), RelayUncertainError], [new Error('socket hang up'), RelayUncertainError]] as const) {
    const relay = createOkxRelay({ send: async () => { throw error; } });
    await assert.rejects(relay.forward({ method: 'POST', path: '/api/v5/trade/order', query: '', body: '{}', headers, simulated: false }), kind);
  }
});

test('relay passes the timeout and forwards OKX status untouched', async () => {
  let timeout = 0;
  const relay = createOkxRelay({ timeoutMs: 1234, send: async req => { timeout = req.timeoutMs; return { status: 401, body: '{"code":"50113"}' }; } });
  assert.deepEqual(await relay.forward({ method: 'GET', path: '/api/v5/account/config', query: '', body: '', headers, simulated: false }), { status: 401, body: '{"code":"50113"}' });
  assert.equal(timeout, 1234);
});
