import test from 'node:test';
import assert from 'node:assert/strict';
import { createVercelBinanceSource } from '../src/markets/vercel-relay.js';
import { publicExchangeFixture } from './runtime-cloudflare-fixtures.js';

const token = 'a'.repeat(64);
test('one relay batch serves multiple futures and keeps native spot isolated; failures invalidate futures', async () => {
  let at = Date.now(), serial = 1, fail: false | number = false, requests = 0;
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === 'relay.example.test') {
      // Emulate the Workers runtime, which rejects redirect: 'error'.
      assert.equal(init?.redirect, 'manual');
      assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${token}`);
      assert.equal(new Headers(init?.headers).get('x-vercel-protection-bypass'), 'test-bypass');
      if (init?.method === 'POST') {
        requests++;
        if (fail) return Response.json({ error: 'blocked' }, { status: fail,
          ...(fail === 302 ? { headers: { location: 'https://untrusted.example.test' } } : {}) });
        const body = JSON.parse(String(init.body)) as { symbols: string[] };
        assert.deepEqual(body.symbols, ['BTCUSDT', 'ETHUSDT']);
        return Response.json({ capturedAt: at, trades: Object.fromEntries(body.symbols.map(symbol => [symbol,
          [{ a: serial, f: serial, l: serial, p: '100', q: '1', T: at, m: false }]])) });
      }
      return Response.json(publicExchangeFixture(new URL('https://fapi.binance.com/fapi/v1/exchangeInfo'), at)!.body);
    }
    assert.equal(url.hostname, 'api-gcp.binance.com');
    const response = publicExchangeFixture(url, at, serial);
    assert(response); return Response.json(response.body);
  };
  const source = createVercelBinanceSource({ relay: { url: 'https://relay.example.test', token, bypass: 'test-bypass' },
    mode: 'polling', venues: ['binance'], fetchImplementation: transport, now: () => at, pollIntervalMs: 1,
    maxDemand: 8, requestTimeoutMs: 3000, retryBaseMs: 1, retryMaxMs: 1 });
  try {
    await source.refreshCatalog();
    await source.setDemand(['binance:swap:BTCUSDT', 'binance:swap:ETHUSDT', 'binance:spot:BTCUSDT']);
    await source.refresh(); assert.equal(requests, 1);
    for (const id of ['binance:swap:BTCUSDT', 'binance:swap:ETHUSDT', 'binance:spot:BTCUSDT']) {
      assert.equal(source.ticks().get(id)?.price, 100, JSON.stringify(source.diagnostics()));
      assert.equal(source.ticks().get(id)?.timestamp, at);
    }
    at += 100; serial++; fail = 502; await source.refresh();
    assert.equal(source.ticks().has('binance:swap:BTCUSDT'), false);
    assert.equal(source.ticks().get('binance:spot:BTCUSDT')?.price, 100);
    at += 100; serial++; fail = false; await source.refresh();
    assert.equal(source.ticks().get('binance:swap:BTCUSDT')?.timestamp, at);
    at += 100; serial++; fail = 302; await source.refresh();
    assert.equal(source.ticks().has('binance:swap:BTCUSDT'), false);
    assert.equal(source.ticks().get('binance:spot:BTCUSDT')?.timestamp, at);
    await source.setDemand(['binance:spot:BTCUSDT']);
    const before = requests; at++; await source.refresh(); assert.equal(requests, before);
  } finally { await source.stop(); }
});

test('relay rejects invalid configuration and over-capacity demands', async () => {
  assert.throws(() => createVercelBinanceSource({ mode: 'stream', relay: { url: 'https://relay.test', token } }));
  assert.throws(() => createVercelBinanceSource({ mode: 'polling', relay: { url: 'http://relay.test', token } }));
  const source = createVercelBinanceSource({ mode: 'polling', venues: ['binance'], relay: { url: 'https://relay.test', token } });
  try { await assert.rejects(source.setDemand(Array.from({ length: 9 }, (_, i) => `binance:swap:ASSET${i}USDT`)), /relay_demand_capacity/); }
  finally { await source.stop(); }
});
