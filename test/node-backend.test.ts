import test from 'node:test';
import assert from 'node:assert/strict';
import { publicExchangeConfig } from '../src/markets/ccxt.js';
import { loadConfig } from '../src/config.js';

test('Binance vision endpoints swap only the US-blocked public hosts', () => {
  const settings = { mode: 'stream' as const, product: 'spot' as const, timeoutMs: 1000, tradesLimit: 100 };
  const api = (publicExchangeConfig('binance', settings, undefined, 'vision').urls as { api: Record<string, unknown> }).api;
  assert.equal(api.public, 'https://data-api.binance.vision/api/v3');
  assert.equal(api.fapiPublic, 'https://www.binance.com/fapi/v1');
  assert.deepEqual(api.ws, { spot: 'wss://data-stream.binance.vision/ws', margin: 'wss://data-stream.binance.vision/ws' });
  const fallback = (publicExchangeConfig('binance', settings).urls as { api: Record<string, unknown> }).api;
  assert.deepEqual(fallback, { public: 'https://api-gcp.binance.com/api/v3' });
  assert.equal(publicExchangeConfig('okx', settings, undefined, 'vision').urls, undefined);
  const base = { APP_URL: 'https://example.test', AUTH_SECRET: 'x'.repeat(32), ENCRYPTION_KEY: 'a'.repeat(64), EMAIL_PROVIDER: 'console', NODE_ENV: 'test' };
  assert.equal(loadConfig(base).binanceEndpoints, 'default');
  assert.equal(loadConfig({ ...base, BINANCE_ENDPOINTS: 'vision' }).binanceEndpoints, 'vision');
});

test('Worker forwards /api/* to NODE_BACKEND_URL and pings its health on cron', async () => {
  const worker = (await import('../src/runtime/cloudflare.js')).default;
  const seen: Request[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init); seen.push(request);
    return new Response('ok', { status: 200 });
  }) as typeof fetch;
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p.catch(() => {})); }, passThroughOnException() {} };
  const env = { NODE_BACKEND_URL: 'https://backend.example/', DB: {}, COORDINATOR: { idFromName: () => 'id', get: () => ({ fetch: async () => new Response(null, { status: 503 }) }) } };
  try {
    const response = await worker.fetch(new Request('https://cryptotool.bar/api/markets?q=btc', { headers: { Origin: 'https://cryptotool.bar', Cookie: 'a=b' } }) as never, env as never, ctx as never);
    assert.equal(response.status, 200);
    assert.equal(seen[0]!.url, 'https://backend.example/api/markets?q=btc');
    assert.equal(seen[0]!.headers.get('origin'), 'https://cryptotool.bar');
    assert.equal(seen[0]!.headers.get('cookie'), 'a=b');
    await worker.scheduled({} as never, env as never, ctx as never);
    await Promise.all(pending);
    assert.ok(seen.some(r => r.url === 'https://backend.example/api/health'));
    // Non-https or path-bearing values are ignored rather than proxied.
    seen.length = 0;
    await worker.fetch(new Request('https://cryptotool.bar/api/health') as never, { ...env, NODE_BACKEND_URL: 'http://backend.example/' } as never, ctx as never);
    assert.ok(!seen.some(r => r.url.startsWith('http://backend.example')));
  } finally { globalThis.fetch = original; }
});

test('Worker retries one transient backend failure for reads only, never for mutations', async () => {
  const worker = (await import('../src/runtime/cloudflare.js')).default;
  const original = globalThis.fetch;
  let calls = 0, fail = 1;
  globalThis.fetch = (async () => { calls++; if (fail-- > 0) return new Response('Sandbox is not reachable.', { status: 502 }); return new Response('ok', { status: 200 }); }) as typeof fetch;
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  const env = { NODE_BACKEND_URL: 'https://backend.example/', DB: {} };
  try {
    const read = await worker.fetch(new Request('https://cryptotool.bar/api/auth/get-session') as never, env as never, ctx as never);
    assert.equal(read.status, 200); assert.equal(calls, 2);
    calls = 0; fail = 5;
    const again = await worker.fetch(new Request('https://cryptotool.bar/api/status') as never, env as never, ctx as never);
    assert.equal(again.status, 502, 'only one retry'); assert.equal(calls, 2);
    calls = 0; fail = 1;
    const write = await worker.fetch(new Request('https://cryptotool.bar/api/alerts', { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } }) as never, env as never, ctx as never);
    assert.equal(write.status, 502); assert.equal(calls, 1, 'mutations are not replayed');
  } finally { globalThis.fetch = original; }
});