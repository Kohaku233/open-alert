import test from 'node:test';
import assert from 'node:assert/strict';

test('Function authenticates, bounds symbol batches and permits only fixed Binance public routes', async context => {
  const { default: handler } = await import(new URL('../relay/api/market.js', import.meta.url).href);
  const previous = process.env.BINANCE_RELAY_TOKEN;
  process.env.BINANCE_RELAY_TOKEN = 'a'.repeat(64);
  context.after(() => { if (previous === undefined) delete process.env.BINANCE_RELAY_TOKEN; else process.env.BINANCE_RELAY_TOKEN = previous; });
  let calls = 0, blocked = false;
  context.mock.method(globalThis, 'fetch', async (input: unknown) => {
    calls++; const url = new URL(String(input));
    assert.equal(url.origin, 'https://fapi.binance.com');
    if (blocked) return Response.json({ error: 'blocked' }, { status: 403 });
    if (url.pathname.endsWith('exchangeInfo')) return Response.json({ symbols: [{ symbol: 'BTCUSDT' }] });
    assert.equal(url.pathname, '/fapi/v1/aggTrades');
    assert.equal(url.searchParams.get('limit'), '100');
    return Response.json([{ a: 1, f: 1, l: 1, T: 1700000000000, p: '100', q: '1', m: false }]);
  });
  async function request(method: string, body?: unknown, auth = `Bearer ${process.env.BINANCE_RELAY_TOKEN}`) {
    let status = 0, result: any;
    const res = { setHeader() {}, status(code: number) { status = code; return res; }, json(value: unknown) { result = value; } };
    await handler({ method, body, headers: { authorization: auth } }, res);
    return { status, result };
  }
  assert.equal((await request('POST', { symbols: ['BTCUSDT'] }, 'wrong')).status, 401);
  assert.equal(calls, 0);
  for (const body of [{ symbols: [] }, { symbols: ['BTCUSDT', 'BTCUSDT'] },
    { symbols: ['https://example.com'] }, { symbols: ['BTCUSDT'], url: 'https://example.com' },
    { symbols: Array.from({ length: 9 }, (_, n) => `ASSET${n}USDT`) }]) {
    assert.equal((await request('POST', body)).status, 400);
  }
  assert.equal(calls, 0);
  const batch = await request('POST', { symbols: ['BTCUSDT', 'ETHUSDT'] });
  assert.equal(batch.status, 200); assert.equal(calls, 2);
  assert.equal(batch.result.trades.BTCUSDT[0].T, 1700000000000);
  assert.deepEqual(Object.keys(batch.result.trades), ['BTCUSDT', 'ETHUSDT']);
  assert.equal((await request('GET')).status, 200);
  assert.equal((await request('PUT')).status, 405);
  blocked = true;
  assert.equal((await request('POST', { symbols: ['BTCUSDT'] })).status, 502);
});
