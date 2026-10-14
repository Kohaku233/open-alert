import test, { before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import ccxt from 'ccxt';
import { HttpProxyAgent } from 'http-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { createBinanceFuturesRelay, createBinanceRelayFetch, validateBinanceRelayUrl, BinanceRelayCooldown,
  createBinanceRelayCcxtBoundaries } from '../src/markets/binance-relay.js';
import type { BinanceRelayBoundaries, BinanceRelayStream } from '../src/markets/binance-relay.js';
import { publicExchangeFixture } from './runtime-cloudflare-fixtures.js';
import { createPublicCcxtFactory } from '../src/markets/ccxt.js';

const denied: string[] = [];
before(() => {
  const deny = (name: string) => (..._args: unknown[]): never => { denied.push(name); throw new Error('network_denied'); };
  mock.method(globalThis, 'fetch', deny('fetch'));
  mock.method(net.Socket.prototype, 'connect', deny('net'));
  mock.method(tls, 'connect', deny('tls'));
  mock.method(http, 'request', deny('http')); mock.method(http, 'get', deny('http.get'));
  mock.method(https, 'request', deny('https')); mock.method(https, 'get', deny('https.get'));
  mock.method(dns, 'lookup', deny('dns')); mock.method(dns, 'resolve', deny('dns.resolve'));
  syncBuiltinESMExports();
});
after(() => { mock.restoreAll(); assert.deepEqual(denied, [], 'No native network path may execute'); });
const TOKEN = 'offline_test_token_01234567890123456789';
const INITIAL = 1_700_000_000_000;
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
function info(at = INITIAL) {
  const fixture = publicExchangeFixture(new URL('https://fapi.binance.com/fapi/v1/exchangeInfo'), at);
  assert.ok(fixture?.kind === 'catalog');
  const value = structuredClone(fixture.body) as Record<string, unknown> & { symbols: Record<string, unknown>[] };
  value.assets = [{ asset: 'USDT', marginAvailable: true, autoAssetExchange: '-10000' }];
  return value;
}
function event(symbol = 'BTCUSDT', at = INITIAL, id = 1, raw: Record<string, unknown> = {}) {
  return { symbol: `${symbol.slice(0, -4)}/USDT:USDT`, info: { e: 'aggTrade', s: symbol,
    a: id, p: '100.00000001', q: '0.01000000', f: id, l: id, T: at, m: false, ...raw } };
}
function fixture(options: { ttl?: number; timeout?: number; symbols?: number } = {}) {
  let time = INITIAL, loads = 0, starts = 0, closes = 0, boundaryClosed = 0, nexts = 0;
  let alter: (value: ReturnType<typeof info>) => void = () => {};
  let load: BinanceRelayBoundaries['catalog'] | undefined;
  let start: BinanceRelayBoundaries['stream'] | undefined;
  const pending = new Map<string, { resolve: (value: unknown) => void; reject: (reason: Error) => void }>();
  const boundaries: BinanceRelayBoundaries = {
    catalog: async signal => {
      loads++;
      if (load) return load(signal);
      const value = info(time);
      if (options.symbols) {
        const template = value.symbols[0]!;
        value.symbols = Array.from({ length: options.symbols }, (_, i) => ({ ...structuredClone(template), baseAsset: `COIN${i}`, symbol: `COIN${i}USDT` }));
      }
      alter(value); return { capturedAt: time, exchangeInfo: value };
    },
    stream: async (market, parsed, signal) => {
      starts++;
      if (start) return start(market, parsed, signal);
      let closed = false;
      return {
        next: () => new Promise((resolve, reject) => { nexts++; pending.set(market.nativeId, { resolve, reject }); }),
        close: async () => { if (closed) return; closed = true; closes++; pending.get(market.nativeId)?.reject(new Error('closed')); pending.delete(market.nativeId); },
      };
    },
    close: async () => { boundaryClosed++; },
  };
  return {
    create: () => createBinanceFuturesRelay({ token: TOKEN, boundaries, now: () => time,
      ...(options.ttl ? { catalogTtlMs: options.ttl } : {}), ...(options.timeout ? { timeoutMs: options.timeout } : {}) }),
    advance: (ms: number) => { time += ms; }, time: () => time,
    counts: () => ({ loads, starts, closes, boundaryClosed }), nexts: () => nexts,
    alter: (fn: typeof alter) => { alter = fn; }, load: (fn: NonNullable<typeof load>) => { load = fn; },
    start: (fn: NonNullable<typeof start>) => { start = fn; },
    emit: async (symbol: string, batch: unknown) => { await flush(); assert.ok(pending.has(symbol), `active waiter for ${symbol}`); pending.get(symbol)!.resolve(batch); await flush(); },
  };
}
const request = (path: string, auth: string | null = TOKEN, init: RequestInit = {}) => new Request(`http://127.0.0.1${path}`, {
  ...init, headers: auth === null ? {} : { authorization: `Bearer ${auth}` },
});
const catalogPath = '/fapi/v1/exchangeInfo';
const tradesPath = (symbol = 'BTCUSDT') => `/fapi/v1/aggTrades?symbol=${encodeURIComponent(symbol)}&limit=100`;

test('authentication and unsupported routes perform zero catalog loads or stream starts', async () => {
  const f = fixture(); const relay = await f.create();
  try {
    for (const auth of [null, '', 'wrong', 'x'.repeat(1000)]) assert.equal((await relay.handle(request(catalogPath, auth))).status, 401);
    for (const path of ['/fapi/v1/account', '/api/v3/exchangeInfo', '/fapi/v1/ticker/price', '/fapi/v1/premiumIndex',
      '/fapi/v1/exchangeInfo?symbol=BTCUSDT', tradesPath() + '&fromId=1', tradesPath() + '&symbol=ETHUSDT',
      tradesPath('X'.repeat(129)), tradesPath('BTC USDT'), tradesPath('BTC\u0000USDT'),
      '/fapi/v1/aggTrades?symbol=BTCUSDT&limit=1', '/fapi/v1/aggTrades?symbol=BTCUSDT&limit=100&token=secret']) {
      assert.equal((await relay.handle(request(path))).status, 400, path);
    }
    assert.equal((await relay.handle(request(catalogPath, TOKEN, { method: 'POST', body: 'body' }))).status, 400);
    assert.equal((await relay.handle(new Request(`http://127.0.0.1${catalogPath}`, { headers: { authorization: `Bearer ${TOKEN}`, 'x-mbx-apikey': 'private' } }))).status, 400);
    assert.deepEqual(f.counts(), { loads: 0, starts: 0, closes: 0, boundaryClosed: 0 });
  } finally { await relay.close(); }
});

test('full catalog coalesces and expires without changing the original capture time', async () => {
  const f = fixture({ ttl: 100 }); const relay = await f.create();
  let resolve!: (capture: { capturedAt: number; exchangeInfo: unknown }) => void;
  f.load(async () => new Promise(done => { resolve = done; }));
  try {
    const a = relay.handle(request(catalogPath)), b = relay.handle(request(catalogPath));
    await flush(); assert.equal(f.counts().loads, 1);
    resolve({ capturedAt: f.time(), exchangeInfo: info() });
    assert.equal((await a).status, 200); assert.equal((await b).status, 200);
    f.advance(99); assert.equal((await relay.handle(request(catalogPath))).status, 200); assert.equal(f.counts().loads, 1);
    f.advance(1);
    f.load(async () => ({ capturedAt: INITIAL, exchangeInfo: info() }));
    assert.equal((await relay.handle(request(catalogPath))).status, 503, 'Cached snapshot cannot be relabeled fresh');
    assert.equal((await relay.handle(request(catalogPath))).status, 503); assert.equal(f.counts().loads, 2, 'Cooldown blocks retry loops');
  } finally { await relay.close(); }
});

test('malformed envelopes and contradictory supported perpetual metadata fail closed', async t => {
  for (const alter of [
    (v: ReturnType<typeof info>) => { delete v.assets; },
    (v: ReturnType<typeof info>) => { delete v.timezone; },
    (v: ReturnType<typeof info>) => { v.symbols[0]!.filters = [{ filterType: 'PRICE_FILTER', tickSize: '0' }]; },
    (v: ReturnType<typeof info>) => { delete v.symbols[0]!.contractType; },
    (v: ReturnType<typeof info>) => { v.symbols.push(structuredClone(v.symbols[0]!)); },
    (v: ReturnType<typeof info>) => { v.symbols[0]!.unknownPadding = 'x'.repeat(8 * 1024 * 1024); },
  ]) await t.test(alter.toString().slice(0, 90), async () => {
    const f = fixture(); f.alter(alter); const relay = await f.create();
    try { assert.equal((await relay.handle(request(catalogPath))).status, 503); assert.equal(f.counts().starts, 0); }
    finally { await relay.close(); }
  });
});

test('only exact normalized active USDT linear swaps can start streams', async () => {
  const f = fixture();
  f.alter(value => {
    const template = value.symbols[0]!;
    value.symbols.push(
      { ...structuredClone(template), symbol: 'BTCUSDC', quoteAsset: 'USDC', marginAsset: 'USDC' },
      { ...structuredClone(template), symbol: 'OFFUSDT', baseAsset: 'OFF', status: 'BREAK' },
      { ...structuredClone(template), symbol: 'BTCUSDT_270326', contractType: 'CURRENT_QUARTER', deliveryDate: 1_806_019_200_000 },
    );
  });
  const relay = await f.create();
  try {
    const body = await (await relay.handle(request(catalogPath))).json() as ReturnType<typeof info>;
    assert.equal(body.symbols.length, 5, 'Full official shape remains unfiltered');
    assert.equal((await relay.handle(request(tradesPath('OFFUSDT')))).status, 400);
    assert.equal((await relay.handle(request(tradesPath('BTCUSDC')))).status, 400);
    for (const alias of ['BTC/USDT:USDT', 'binance:swap:BTCUSDT', 'btcusdt', '不存在USDT']) {
      assert.equal((await relay.handle(request(tradesPath(alias)))).status, 400);
    }
    assert.equal(f.counts().starts, 0);
    assert.equal((await relay.handle(request(tradesPath()))).status, 503, 'Starting stream has no manufactured first sample');
    await f.emit('BTCUSDT', [event()]);
    const response = await relay.handle(request(tradesPath())); assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), [{ a: 1, p: '100.00000001', q: '0.01000000', f: 1, l: 1, T: INITIAL, m: false }]);
    assert.equal(f.counts().starts, 1);
  } finally { await relay.close(); }
});


test('complete Unicode envelope survives relay, real CCXT parsing and exact native trade routing', async () => {
  const bases = ['币安人生', 'नमस्ते', 'Cafe\u0301', '𐐀'.repeat(16)];
  const f = fixture(); let expected!: ReturnType<typeof info>;
  f.alter(value => {
    const template = value.symbols[0]!;
    for (const baseAsset of bases) value.symbols.push({ ...structuredClone(template), baseAsset, symbol: `${baseAsset}USDT` });
    value.symbols.push({ ...structuredClone(template), baseAsset: '退市币', symbol: '退市币USDT', status: 'BREAK' });
    expected = structuredClone(value);
  });
  const relay = await f.create();
  const throttle = mock.method(ccxt.binance.prototype, 'throttle', async () => {});
  const routed: string[] = [];
  const fetchImplementation = createBinanceRelayFetch({ url: 'https://relay.example', token: TOKEN,
    fetchImplementation: async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/aggTrades')) routed.push(url.searchParams.get('symbol')!);
      return relay.handle(new Request(url, init));
    } });
  const client = createPublicCcxtFactory({ fetchImplementation })('binance', {
    mode: 'polling', product: 'swap', timeoutMs: 1000, tradesLimit: 100,
  });
  try {
    const response = await fetchImplementation(`https://fapi.binance.com${catalogPath}`);
    assert.deepEqual(await response.json(), expected, 'Complete original envelope preserves all Unicode rows, including excluded products');
    const markets = await client.loadMarkets(true) as Record<string, unknown>;
    for (const base of bases) {
      const native = `${base}USDT`, unified = `${base.toUpperCase()}/USDT:USDT`;
      assert.ok(markets[unified], `CCXT unified symbol for native ${native}`);
      await assert.rejects(() => client.fetchTrades(unified, undefined, 100));
      await f.emit(native, [{ ...event(native), symbol: unified }]);
      const trades = await client.fetchTrades(unified, undefined, 100) as { symbol: string; info: { p: string; a: number } }[];
      assert.equal(trades.length, 1); assert.equal(trades[0]!.symbol, unified);
      assert.equal(trades[0]!.info.p, '100.00000001'); assert.equal(trades[0]!.info.a, 1);
      assert.equal(routed.at(-1), native, 'Query encoding preserves the exact native ID');
    }
    assert.equal((await relay.handle(request(tradesPath('退市币USDT')))).status, 400);
    assert.equal(f.counts().loads, 1); assert.equal(f.counts().starts, bases.length);
  } finally { await client.close(); await relay.close(); throttle.mock.restore(); }
});

test('quiet demanded stream keeps one pending next beyond idle duration; untouched stream cancels and closes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const f = fixture(); const relay = await f.create();
  try {
    assert.equal((await relay.handle(request(tradesPath()))).status, 503); await flush();
    for (let i = 0; i < 5; i++) {
      f.advance(20_000); t.mock.timers.tick(20_000); await flush();
      assert.equal((await relay.handle(request(tradesPath()))).status, 503, 'Quiet market has no fabricated sample');
      assert.equal(f.counts().starts, 1); assert.equal(f.counts().closes, 0);
      assert.equal(f.nexts(), 1, 'Active demand retains the same pending next across 100 seconds of quiet');
    }
    assert.equal(relay.diagnostics().streamCooldowns, 0);
    await f.emit('BTCUSDT', [event('BTCUSDT', f.time())]);
    assert.equal((await relay.handle(request(tradesPath()))).status, 200);
    assert.equal(f.nexts(), 2);
    f.advance(60_000); t.mock.timers.tick(60_000); await flush();
    assert.equal(f.counts().closes, 1); assert.equal(relay.diagnostics().symbols, 0);
    assert.equal(relay.diagnostics().streamCooldowns, 0, 'Idle cancellation is not a stream failure');
    await relay.handle(request(tradesPath())); await flush(); assert.equal(f.counts().starts, 2);
  } finally { await relay.close(); t.mock.timers.reset(); }
});

test('stream freshness rejects stale/replay/future data, idle closes and fresh reconnect can start', async () => {
  const f = fixture(); const relay = await f.create();
  try {
    await relay.handle(request(tradesPath())); await f.emit('BTCUSDT', [event()]);
    f.advance(10_000); await f.emit('BTCUSDT', [event()]);
    assert.equal((await relay.handle(request(tradesPath()))).status, 200, 'Same sample can be polled, but its time stays original');
    f.advance(20_001); assert.equal((await relay.handle(request(tradesPath()))).status, 503);
    await f.emit('BTCUSDT', [event('BTCUSDT', f.time() + 5001, 2)]);
    assert.equal((await relay.handle(request(tradesPath()))).status, 503);
    await f.emit('BTCUSDT', [event('BTCUSDT', f.time(), 3)]);
    assert.equal((await relay.handle(request(tradesPath()))).status, 200);
    f.advance(60_000); relay.sweep(); await flush();
    assert.equal(f.counts().closes, 1); assert.equal(relay.diagnostics().symbols, 0);
    await relay.handle(request(tradesPath())); await flush(); assert.equal(f.counts().starts, 2);
  } finally { await relay.close(); }
});

test('invalid ticker/mark/spot events invalidate existing cached trade immediately', async () => {
  const f = fixture(); const relay = await f.create();
  try {
    await relay.handle(request(tradesPath())); await f.emit('BTCUSDT', [event()]);
    await f.emit('BTCUSDT', [event('BTCUSDT', INITIAL, 2, { e: 'markPriceUpdate' })]);
    assert.equal((await relay.handle(request(tradesPath()))).status, 503);
    assert.equal(f.counts().closes, 1);
    await relay.handle(request(tradesPath('ETHUSDT'))); await f.emit('ETHUSDT', [event('ETHUSDT')]);
    assert.equal((await relay.handle(request(tradesPath('ETHUSDT')))).status, 200, 'BTC stream failure cannot cool down ETH');
    assert.equal(f.counts().starts, 2);
  } finally { await relay.close(); }
});

test('catalog expiry/removal clears watchers and does not serve old trade', async () => {
  const f = fixture({ ttl: 100 }); const relay = await f.create();
  try {
    await relay.handle(request(tradesPath())); await f.emit('BTCUSDT', [event()]);
    f.advance(100); f.alter(v => { v.symbols = []; });
    assert.equal((await relay.handle(request(tradesPath()))).status, 400);
    await flush(); assert.equal(relay.diagnostics().samples, 0); assert.equal(f.counts().closes, 1);
  } finally { await relay.close(); }
});

test('capacity bounds eight stream starts and at most eight cached trade samples globally', async () => {
  const f = fixture({ symbols: 9 }); const relay = await f.create();
  try {
    for (let i = 0; i < 8; i++) {
      await relay.handle(request(tradesPath(`COIN${i}USDT`)));
      await f.emit(`COIN${i}USDT`, [event(`COIN${i}USDT`)]);
    }
    assert.equal((await relay.handle(request(tradesPath('COIN8USDT')))).status, 429);
    assert.equal(f.counts().starts, 8); assert.equal(relay.diagnostics().samples, 8);
    f.advance(60_000); relay.sweep(); await flush(); assert.equal(relay.diagnostics().symbols, 0);
  } finally { await relay.close(); }
});

test('418/429 cooldown honors supplied expiry and coalesces retries', async () => {
  const f = fixture(); f.load(async () => { throw new BinanceRelayCooldown(INITIAL + 120_000); });
  const relay = await f.create();
  try {
    assert.equal((await relay.handle(request(catalogPath))).status, 503);
    f.advance(119_999); assert.equal((await relay.handle(request(catalogPath))).status, 503); assert.equal(f.counts().loads, 1);
    f.advance(1); assert.equal((await relay.handle(request(catalogPath))).status, 503); assert.equal(f.counts().loads, 2);
  } finally { await relay.close(); }
});

test('stalled catalog is bounded and cannot overlap another fetch; close blocks late success', async () => {
  const f = fixture({ timeout: 5 }); let finish!: (value: { capturedAt: number; exchangeInfo: unknown }) => void;
  f.load(async () => new Promise(resolve => { finish = resolve; }));
  const relay = await f.create();
  assert.equal((await relay.handle(request(catalogPath))).status, 503);
  assert.equal((await relay.handle(request(catalogPath))).status, 503); assert.equal(f.counts().loads, 1);
  await relay.close(); finish({ capturedAt: f.time(), exchangeInfo: info() }); await flush();
  assert.equal((await relay.handle(request(catalogPath))).status, 503); assert.equal(relay.diagnostics().samples, 0);
});

test('pending asynchronous starts keep their slot until cancelled client closes; no overlap', async () => {
  const f = fixture({ timeout: 5 }); let finish!: (stream: BinanceRelayStream) => void;
  f.start(async () => new Promise(resolve => { finish = resolve; }));
  const relay = await f.create();
  try {
    await relay.handle(request(tradesPath())); await flush();
    f.advance(60_000); relay.sweep();
    assert.equal((await relay.handle(request(tradesPath()))).status, 503); assert.equal(f.counts().starts, 1);
    let closed = 0;
    finish({ next: async () => { assert.fail('Cancelled start must never watch'); }, close: async () => { closed++; } });
    await flush(); assert.equal(closed, 1); assert.equal(relay.diagnostics().symbols, 0);
  } finally { await relay.close(); }
});

test('request concurrency/rate limits reject before upstream starts', async () => {
  let loads = 0, finish!: (value: { capturedAt: number; exchangeInfo: unknown }) => void;
  const relay = await createBinanceFuturesRelay({ token: TOKEN, now: () => INITIAL, requestsPerMinute: 2, maxConcurrentRequests: 1,
    boundaries: { catalog: async () => { loads++; return new Promise(resolve => { finish = resolve; }); }, stream: async () => { assert.fail('No stream'); } } });
  try {
    const first = relay.handle(request(catalogPath)); await flush();
    assert.equal((await relay.handle(request(catalogPath))).status, 429);
    finish({ capturedAt: INITIAL, exchangeInfo: info() }); assert.equal((await first).status, 200);
    assert.equal((await relay.handle(request(catalogPath))).status, 429); assert.equal(loads, 1);
  } finally { await relay.close(); }
});

test('client rejects unsafe bases and unsupported Binance/private requests without dispatch', async () => {
  for (const url of ['http://example.com', 'https://user:secret@example.com', 'https://example.com?x=1', 'https://example.com#x', 'file:///tmp/x', 'http://127.0.0.2']) {
    assert.throws(() => validateBinanceRelayUrl(url), /invalid_relay_url/);
  }
  const calls: unknown[] = [];
  const fetch = createBinanceRelayFetch({ url: 'https://relay.example/base', token: TOKEN, fetchImplementation: async (...args) => { calls.push(args); return Response.json(info()); } });
  for (const url of ['https://fapi.binance.com/fapi/v1/account', 'https://fapi.binance.com/fapi/v1/ticker/price', 'https://api.binance.com/api/v3/exchangeInfo',
    'https://fapi.binance.com/fapi/v1/exchangeInfo?url=http://169.254.169.254', 'https://fapi.binance.com/fapi/v1/aggTrades?symbol=BTCUSDT&limit=100&signature=x',
    'https://user:secret@fapi.binance.com/fapi/v1/exchangeInfo', 'http://fapi.binance.com/fapi/v1/exchangeInfo']) await assert.rejects(() => fetch(url));
  await assert.rejects(() => fetch('https://fapi.binance.com/fapi/v1/exchangeInfo', { method: 'POST', body: '{}' }));
  assert.equal(calls.length, 0);
});

test('client strips all caller credentials and headers; other exchanges pass through exact arguments', async () => {
  const calls: [RequestInfo | URL, RequestInit | undefined][] = [];
  const fetch = createBinanceRelayFetch({ url: 'https://relay.example/base/', token: TOKEN, fetchImplementation: async (input, init) => {
    calls.push([input, init]); return Response.json(info());
  } });
  await fetch('https://fapi.binance.com/fapi/v1/exchangeInfo', { headers: { authorization: 'Bearer attacker', cookie: 'secret', 'X-MBX-APIKEY': 'private' } });
  assert.equal(calls[0]![0], 'https://relay.example/base/fapi/v1/exchangeInfo');
  assert.deepEqual(calls[0]![1]?.headers, { authorization: `Bearer ${TOKEN}`, accept: 'application/json' });
  assert.equal(calls[0]![1]?.redirect, 'manual'); assert.equal(calls[0]![1]?.credentials, 'omit');
  const init = { headers: { 'x-test': 'other-exchange' } };
  await fetch('https://www.okx.com/api/v5/public/instruments?instType=SWAP', init);
  assert.equal(calls[1]![1], init); assert.equal(new Headers(init.headers).has('authorization'), false);
});

test('client rejects redirects, invalid status/JSON, oversized bodies and stalled transport', async t => {
  for (const [label, response] of [
    ['redirect', new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } })],
    ['bad status', Response.json({ error: 'secret URL IP' }, { status: 403 })],
    ['html', new Response('<html/>', { headers: { 'content-type': 'text/html' } })],
    ['malformed', Response.json({ symbols: [] })],
    ['declared oversize', Response.json(info(), { headers: { 'content-length': String(9 * 1024 * 1024) } })],
    ['actual oversize', Response.json({ ...info(), padding: 'x'.repeat(9 * 1024 * 1024) })],
  ] as const) await t.test(label, async () => {
    let calls = 0;
    const fetch = createBinanceRelayFetch({ url: 'http://127.0.0.1:8788', token: TOKEN, fetchImplementation: async () => { calls++; return response; } });
    await assert.rejects(() => fetch('https://fapi.binance.com/fapi/v1/exchangeInfo'), error => error instanceof Error && !error.message.includes('secret'));
    assert.equal(calls, 1);
  });
  const fetch = createBinanceRelayFetch({ url: 'https://relay.example', token: TOKEN, timeoutMs: 5, fetchImplementation: async () => new Promise(() => {}) });
  await assert.rejects(() => fetch('https://fapi.binance.com/fapi/v1/exchangeInfo'), /timeout/);
});

test('client relays valid raw trades and rejects empty/malformed trade responses', async () => {
  const raw = event().info;
  for (const body of [[], [{ ...raw, q: 'NaN' }], [raw]]) {
    const fetch = createBinanceRelayFetch({ url: 'https://relay.example', token: TOKEN, fetchImplementation: async () => Response.json(body) });
    if (body.length && body[0]?.q !== 'NaN') assert.deepEqual(await (await fetch(`https://fapi.binance.com${tradesPath()}`)).json(), body);
    else await assert.rejects(() => fetch(`https://fapi.binance.com${tradesPath()}`));
  }
});

test('real polling factory loads relay raw envelope and parses its raw aggTrade page offline', async () => {
  const f = fixture(); const relay = await f.create();
  const throttle = mock.method(ccxt.binance.prototype, 'throttle', async () => {});
  const fetchImplementation = createBinanceRelayFetch({ url: 'https://relay.example', token: TOKEN,
    fetchImplementation: async (input, init) => relay.handle(new Request(String(input), init)) });
  const client = createPublicCcxtFactory({ fetchImplementation })('binance', {
    mode: 'polling', product: 'swap', timeoutMs: 1000, tradesLimit: 100,
  });
  try {
    const markets = await client.loadMarkets(true) as Record<string, unknown>;
    assert.ok(markets['BTC/USDT:USDT']);
    await assert.rejects(() => client.fetchTrades('BTC/USDT:USDT', undefined, 100));
    await f.emit('BTCUSDT', [event()]);
    const trades = await client.fetchTrades('BTC/USDT:USDT', undefined, 100) as { symbol: string; timestamp: number; info: { p: string; a: number } }[];
    assert.equal(trades.length, 1); assert.equal(trades[0]!.symbol, 'BTC/USDT:USDT');
    assert.equal(trades[0]!.timestamp, INITIAL); assert.equal(trades[0]!.info.p, '100.00000001'); assert.equal(trades[0]!.info.a, 1);
  } finally { await client.close(); await relay.close(); throttle.mock.restore(); }
});

test('production proxy catalog loads real optional agents before the endpoint and captures the full envelope offline', async () => {
  const expected = info();
  let calls = 0, endpointCalls = 0, time = INITIAL;
  const transport = mock.method(https, 'request', (url: unknown, options: unknown, callback: (response: unknown) => void) => {
    calls++;
    assert.equal(String(url), 'https://fapi.binance.com/fapi/v1/exchangeInfo');
    const init = options as https.RequestOptions;
    assert.equal(init.method, 'GET');
    // Assert booleans rather than printing the agent or proxy configuration on failure.
    assert.ok(init.agent instanceof HttpsProxyAgent, 'The injected HTTPS transport must receive the installed proxy agent');
    assert.deepEqual(init.headers, { accept: 'application/json' }, 'No proxy credentials may reach the upstream headers');
    const req = new EventEmitter() as EventEmitter & { setTimeout: () => void; end: () => void; destroy: () => void };
    req.setTimeout = () => {}; req.destroy = () => {};
    req.end = () => queueMicrotask(() => {
      const res = new EventEmitter() as EventEmitter & { statusCode: number; headers: object; destroy: () => void };
      res.statusCode = 200; res.headers = { 'content-type': 'application/json' }; res.destroy = () => {};
      callback(res);
      time += 123;
      res.emit('data', Buffer.from(JSON.stringify(expected))); res.emit('end');
    });
    return req as unknown as http.ClientRequest;
  });
  syncBuiltinESMExports();
  const throttle = mock.method(ccxt.binance.prototype, 'throttle', async () => {});
  const originalRequest = ccxt.binance.prototype.request;
  // CCXT can also load agents inside fetch. Check endpoint entry so that its
  // fallback cannot hide removal of the catalog boundary's explicit preload.
  // loadProxyModules, setProxyAgents and the actual endpoint/transport stay real.
  const endpoint = mock.method(ccxt.binance.prototype, 'request', function (this: InstanceType<typeof ccxt.binance>, ...args: Parameters<typeof originalRequest>) {
    endpointCalls++;
    assert.equal(args[0], 'exchangeInfo'); assert.equal(args[1], 'fapiPublic'); assert.equal(args[2], 'GET');
    assert.ok(this.httpProxyAgentModule?.HttpProxyAgent === HttpProxyAgent, 'Installed HTTP proxy module must be loaded before endpoint entry');
    assert.ok(this.httpsProxyAgentModule?.HttpsProxyAgent === HttpsProxyAgent, 'Installed HTTPS proxy module must be loaded before endpoint entry');
    return originalRequest.apply(this, args);
  });
  let boundary: BinanceRelayBoundaries | undefined;
  try {
    boundary = await createBinanceRelayCcxtBoundaries({ now: () => time, httpsProxy: 'http://proxy.example.test:3128' });
    assert.equal(calls, 0); assert.equal(endpointCalls, 0, 'Construction must not fetch a catalog');
    const capture = await boundary.catalog(new AbortController().signal);
    assert.equal(capture.capturedAt, INITIAL + 123, 'Capture time is recorded after the response, independently of serverTime');
    assert.deepEqual(capture.exchangeInfo, expected, 'The complete official envelope is retained');
    assert.equal(calls, 1); assert.equal(endpointCalls, 1, 'Only the explicit futures endpoint may execute');
    assert.deepEqual(denied, [], 'No native network path may execute through the proxy');
  } finally {
    try { await boundary?.close?.(); } finally {
      endpoint.mock.restore(); throttle.mock.restore(); transport.mock.restore(); syncBuiltinESMExports();
    }
  }
});

test('production CCXT transport uses exact future explicit ban expiry or status default offline', async t => {
  let calls = 0, status = 200, retryAfter: string | undefined, banUntil: number | undefined;
  const transport = mock.method(https, 'request', (url: unknown, options: unknown, callback: (response: unknown) => void) => {
    calls++;
    assert.equal(String(url), 'https://fapi.binance.com/fapi/v1/exchangeInfo');
    assert.equal((options as { method: string }).method, 'GET');
    const req = new EventEmitter() as EventEmitter & { setTimeout: () => void; end: () => void; destroy: () => void };
    req.setTimeout = () => {}; req.destroy = () => {};
    req.end = () => queueMicrotask(() => {
      const res = new EventEmitter() as EventEmitter & { statusCode: number; headers: object; destroy: () => void };
      res.statusCode = status;
      res.headers = { 'content-type': 'application/json', ...(retryAfter === undefined ? {} : { 'retry-after': retryAfter }) };
      res.destroy = () => {}; callback(res);
      res.emit('data', Buffer.from(JSON.stringify(status === 200 ? info() : { code: -1003,
        msg: `IP address redacted${banUntil === undefined ? '' : ` banned until ${banUntil}`}` })));
      res.emit('end');
    });
    return req as unknown as http.ClientRequest;
  });
  syncBuiltinESMExports();
  const throttle = mock.method(ccxt.binance.prototype, 'throttle', async () => {});
  const boundary = await createBinanceRelayCcxtBoundaries({ now: () => INITIAL });
  const cases: [string, string | undefined, number | undefined, number | null][] = [
    ['numeric Retry-After is exactly two minutes', '120', undefined, 120_000],
    ['numeric ban expiry is exactly two minutes', undefined, INITIAL + 120_000, 120_000],
    ['HTTP date is exactly two minutes', new Date(INITIAL + 120_000).toUTCString(), undefined, 120_000],
    ['greatest future explicit expiry wins', '120', INITIAL + 172_800_000, 172_800_000],
    ['shorter ban does not truncate Retry-After', '120', INITIAL + 60_000, 120_000],
    ['invalid header does not mask valid short ban', 'invalid', INITIAL + 120_000, 120_000],
    ['missing explicit expiry uses default', undefined, undefined, null],
    ['invalid header and past ban use default', 'invalid', INITIAL - 1, null],
    ['past date and unsafe ban use default', new Date(INITIAL - 1).toUTCString(), Number.MAX_SAFE_INTEGER + 1, null],
    ['unsafe numeric delay and past ban use default', '99999999999999999999', INITIAL - 1, null],
    ['zero delay and current ban use default', '0', INITIAL, null],
  ];
  try {
    const capture = await boundary.catalog(new AbortController().signal);
    assert.equal(capture.capturedAt, INITIAL); assert.deepEqual(capture.exchangeInfo, info());
    for (const code of [418, 429]) for (const [label, retry, ban, duration] of cases) {
      await t.test(`${code}: ${label}`, async () => {
        status = code; retryAfter = retry; banUntil = ban;
        await assert.rejects(() => boundary.catalog(new AbortController().signal), error => {
          assert.ok(error instanceof BinanceRelayCooldown);
          assert.equal(error.retryAt, INITIAL + (duration ?? (code === 418 ? 86_400_000 : 60_000)));
          assert.equal(error.message, 'upstream_cooldown'); return true;
        });
      });
    }
    assert.equal(calls, 1 + cases.length * 2);
  } finally { await boundary.close!(); transport.mock.restore(); throttle.mock.restore(); syncBuiltinESMExports(); }
});

test('failed stream start enters cooldown and does not reconnect on every poll', async () => {
  const f = fixture(); f.start(async market => {
    if (market.nativeId === 'BTCUSDT') throw new Error('secret upstream URL');
    return { next: async () => new Promise(() => {}), close: async () => {} };
  });
  const relay = await f.create();
  try {
    await relay.handle(request(tradesPath())); await flush();
    for (let i = 0; i < 5; i++) assert.equal((await relay.handle(request(tradesPath()))).status, 503);
    assert.equal(f.counts().starts, 1);
    await relay.handle(request(tradesPath('ETHUSDT'))); await flush();
    assert.equal(f.counts().starts, 2, 'Failed BTC start must not block an unrelated ETH start');
    f.advance(60_000); await relay.handle(request(tradesPath())); await flush(); assert.equal(f.counts().starts, 3);
  } finally { await relay.close(); }
});


test('stream cooldown entries are catalog-bounded and invalidated on catalog replacement', async () => {
  const f = fixture({ symbols: 13, ttl: 1000 });
  f.start(async market => {
    if (market.nativeId !== 'COIN12USDT') throw new Error('unavailable');
    return { next: async () => new Promise(() => {}), close: async () => {} };
  });
  const relay = await f.create();
  try {
    for (let i = 0; i < 12; i++) { await relay.handle(request(tradesPath(`COIN${i}USDT`))); await flush(); }
    assert.equal(relay.diagnostics().symbols, 0);
    assert.equal(relay.diagnostics().streamCooldowns, 12, 'Retired watcher failures remain bounded by catalog membership');
    for (let i = 0; i < 12; i++) assert.equal((await relay.handle(request(tradesPath(`COIN${i}USDT`)))).status, 503);
    assert.equal(f.counts().starts, 12, 'Polling failures does not evict another symbol cooldown');
    await relay.handle(request(tradesPath('COIN12USDT'))); await flush(); assert.equal(f.counts().starts, 13);
    f.advance(1000); relay.sweep(); await flush();
    assert.equal(relay.diagnostics().streamCooldowns, 0); assert.equal(relay.diagnostics().symbols, 0);
    f.alter(v => { v.symbols = v.symbols.slice(0, 1); });
    assert.equal((await relay.handle(request(catalogPath))).status, 200);
    assert.equal((await relay.handle(request(tradesPath('COIN1USDT')))).status, 400, 'Removed symbols cannot recreate failure entries');
    await relay.handle(request(tradesPath('COIN0USDT'))); await flush();
    assert.equal(f.counts().starts, 14); assert.equal(relay.diagnostics().streamCooldowns, 1);
    await relay.close(); assert.equal(relay.diagnostics().streamCooldowns, 0);
  } finally { await relay.close(); }
});

test('production CCXT boundary constructs/closes offline and seeded Pro uses exact aggTrade option', async () => {
  const watched: unknown[][] = [];
  const watcher = mock.method(ccxt.pro.binance.prototype, 'watchTrades', async (...args: unknown[]) => { watched.push(args); return [event()]; });
  const boundary = await createBinanceRelayCcxtBoundaries({ now: () => INITIAL });
  const parser = new ccxt.binance();
  try {
    const parsed = parser.parseMarkets(info().symbols);
    // Boundary accepts only service-validated markets; this unit supplies real
    // official-parser offline output, no hand-built CCXT metadata.
    const market = { instrument: 'binance:swap:BTCUSDT', venue: 'binance' as const, type: 'swap' as const,
      nativeId: 'BTCUSDT', symbol: 'BTC/USDT:USDT', base: 'BTC', quote: 'USDT' as const, settle: 'USDT' as const,
      contractSize: 1, tickSize: '0.1', state: 'live' as const, tradingViewSymbol: '' };
    const stream = await boundary.stream(market, parsed, new AbortController().signal);
    await stream.next(); assert.deepEqual(watched, [['BTC/USDT:USDT', undefined, 1, { name: 'aggTrade' }]]);
    await stream.close(); await boundary.close!();
    await assert.rejects(() => boundary.catalog(new AbortController().signal), /closed/);
    await assert.rejects(() => boundary.stream(market, parsed, new AbortController().signal), /closed/);
  } finally { watcher.mock.restore(); await parser.close(); await boundary.close!(); }
});
