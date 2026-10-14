import test, { after, before, mock } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import { syncBuiltinESMExports } from 'node:module';
import ccxt from 'ccxt';
import { loadConfig } from '../src/config.js';
import { createBinanceFuturesRelay, createBinanceRelayFetch } from '../src/markets/binance-relay.js';
import type { BinanceRelayBoundaries } from '../src/markets/binance-relay.js';
import { SymbolTradesUnavailableError } from '../src/markets/source.js';
import { createPublicCcxtFactory, createPublicCcxtMarketSource } from '../src/markets/ccxt.js';
import { normalizeCatalog } from '../src/markets/normalize.js';
import type { Venue } from '../src/contracts/domain.js';
import { publicExchangeFixture } from './runtime-cloudflare-fixtures.js';

// Keep real CCXT constructors, catalog/trade parsers and source state transitions.
// Only transport and rate-limit waiting are mocked; every native egress path fails.
const denied: string[] = [];
before(() => {
  const deny = (name: string) => (..._args: unknown[]): never => {
    denied.push(name); throw new Error(`external_network_denied:${name}`);
  };
  mock.method(globalThis, 'fetch', deny('fetch'));
  mock.method(net.Socket.prototype, 'connect', deny('net.connect'));
  mock.method(tls, 'connect', deny('tls.connect'));
  mock.method(http, 'request', deny('http.request')); mock.method(http, 'get', deny('http.get'));
  mock.method(https, 'request', deny('https.request')); mock.method(https, 'get', deny('https.get'));
  mock.method(dns, 'lookup', deny('dns.lookup')); mock.method(dns, 'resolve', deny('dns.resolve'));
  syncBuiltinESMExports();
  for (const classes of [ccxt, ccxt.pro]) {
    for (const venue of ['binance', 'okx', 'mexc'] as const) mock.method(classes[venue].prototype, 'throttle', async () => {});
  }
});
after(() => {
  mock.restoreAll(); syncBuiltinESMExports();
  assert.deepEqual(denied, [], 'No native network path may execute, even if the source catches its error');
});

const INITIAL = 1_700_000_000_000;
const TOKEN = 'offline_integration_token_01234567890123456789';
const RELAY = 'https://relay.example.test/binance';
const SPOT = 'binance:spot:BTCUSDT';
const SWAP = 'binance:swap:BTCUSDT';
const identities = [
  { venue: 'binance', product: 'spot', instrument: SPOT, nativeId: 'BTCUSDT', symbol: 'BTC/USDT', price: 101, amount: 0.125 },
  { venue: 'binance', product: 'swap', instrument: SWAP, nativeId: 'BTCUSDT', symbol: 'BTC/USDT:USDT', price: 202, amount: 0.25 },
  { venue: 'okx', product: 'spot', instrument: 'okx:spot:BTC-USDT', nativeId: 'BTC-USDT', symbol: 'BTC/USDT', price: 303, amount: 0.5 },
  { venue: 'okx', product: 'swap', instrument: 'BTC-USDT-SWAP', nativeId: 'BTC-USDT-SWAP', symbol: 'BTC/USDT:USDT', price: 303, amount: 0.5 },
  { venue: 'mexc', product: 'spot', instrument: 'mexc:spot:BTCUSDT', nativeId: 'BTCUSDT', symbol: 'BTC/USDT', price: 404, amount: 0.125 },
  { venue: 'mexc', product: 'swap', instrument: 'mexc:swap:BTC_USDT', nativeId: 'BTC_USDT', symbol: 'BTC/USDT:USDT', price: 404, amount: 2 },
] as const;
type Failure = 'healthy' | 'http' | 'transport' | 'malformed';

function fixture() {
  let time = INITIAL, id = 700, failure: Failure = 'healthy';
  const calls: { channel: 'native' | 'relay'; url: URL }[] = [];
  const swapInputs: string[] = [], violations: string[] = [];
  const guard = (condition: boolean, message: string) => {
    if (!condition) { violations.push(message); assert.fail(message); }
  };
  const transport = (channel: 'native' | 'relay'): typeof fetch => async (input, init) => {
    const request = new Request(input, init), url = new URL(request.url);
    calls.push({ channel, url });
    guard(request.method === 'GET' && request.body === null, 'Only public GET requests are permitted');
    guard(!url.href.includes(TOKEN) && !url.username && !url.password, 'Token must never appear in a URL');
    for (const header of ['cookie', 'x-mbx-apikey', 'ok-access-key', 'ok-access-sign', 'ok-access-passphrase']) {
      guard(!request.headers.has(header), `Private header must not be dispatched: ${header}`);
    }
    let upstream = url;
    if (channel === 'relay') {
      guard(url.origin === 'https://relay.example.test', 'Swap transport must only dispatch to the configured relay');
      guard(url.pathname === '/binance/fapi/v1/exchangeInfo' || url.pathname === '/binance/fapi/v1/aggTrades', 'Relay must retain its configured base path');
      assert.deepEqual([...request.headers.entries()].sort(), [['accept', 'application/json'], ['authorization', `Bearer ${TOKEN}`]]);
      assert.equal(init?.redirect, 'manual'); assert.equal(init?.credentials, 'omit'); assert.equal(init?.cache, 'no-store');
      upstream = new URL(`https://fapi.binance.com${url.pathname.slice('/binance'.length)}${url.search}`);
      if (failure === 'http') return Response.json({ error: 'offline failure' }, { status: 503 });
      if (failure === 'transport') throw new Error(`offline upstream error ${TOKEN}`);
      if (failure === 'malformed') return Response.json({ symbols: [] });
    } else {
      guard(['api-gcp.binance.com', 'www.okx.com', 'api.mexc.com'].includes(url.hostname), 'Native transport must never reach Binance futures or the relay');
      guard(!request.headers.has('authorization'), 'Native venue requests must not receive relay authorization');
      guard(!JSON.stringify([...request.headers.entries()]).includes(TOKEN), 'Relay token must not leak through any native header');
    }
    // Fixed execution time lets source tests distinguish ID replay from a new
    // trade at the same timestamp while the local receive clock advances.
    const response = publicExchangeFixture(upstream, upstream.pathname.endsWith('/exchangeInfo') || upstream.pathname.endsWith('/instruments') || upstream.pathname.endsWith('/detail') ? time : INITIAL, id);
    guard(response !== null, `Unexpected mocked public route: ${upstream.href}`);
    assert.ok(response);
    const body = structuredClone(response.body);
    if (response.kind === 'catalog' && upstream.hostname === 'fapi.binance.com') {
      Object.assign(body as object, { assets: [{ asset: 'USDT', marginAvailable: true, autoAssetExchange: '-10000' }] });
    }
    if (response.kind === 'trades') {
      const price = channel === 'relay' ? '202' : upstream.hostname === 'api-gcp.binance.com' ? '101' : upstream.hostname === 'www.okx.com' ? '303' : '404';
      if (upstream.hostname === 'www.okx.com') {
        Object.assign((body as { data: object[] }).data[0]!, { px: price, sz: '0.5' });
      } else if (upstream.pathname.startsWith('/api/v1/contract/deals/')) {
        Object.assign((body as { data: object[] }).data[0]!, { p: Number(price), v: 2 });
      } else {
        Object.assign((body as object[])[0]!, { p: price, q: channel === 'relay' ? '0.25' : '0.125' });
      }
    }
    return Response.json(body);
  };
  const fetchImplementation = transport('native');
  // Use the same config-to-adapter shape as the Cloudflare coordinator, with only synthetic settings.
  const config = loadConfig({ NODE_ENV: 'development', APP_URL: 'http://localhost:3000',
    AUTH_SECRET: 'offline_auth_secret_01234567890123456789', ENCRYPTION_KEY: 'ab'.repeat(32),
    EMAIL_PROVIDER: 'console', DEPLOYMENT: 'cloudflare', DB_DRIVER: 'd1', MAX_GLOBAL_INSTRUMENTS: '8',
    BINANCE_RELAY_URL: RELAY, BINANCE_RELAY_TOKEN: TOKEN });
  assert.ok(config.binanceRelay);
  const relayFetch = createBinanceRelayFetch({ ...config.binanceRelay, fetchImplementation: transport('relay'), timeoutMs: 1000 });
  const binanceSwapFetchImplementation: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    swapInputs.push(url.href);
    guard(url.origin === 'https://fapi.binance.com', 'Spot and other venues must never enter the swap override');
    return relayFetch(input, init);
  };
  return { fetchImplementation, binanceSwapFetchImplementation, calls, swapInputs,
    now: () => time, advance: (ms = 1) => { time += ms; }, nextId: () => { id++; },
    fail: (next: Failure) => { failure = next; },
    assertSafe: () => assert.deepEqual(violations, [], 'Guarded transport errors must not be swallowed into a passing source test') };
}
function sourceFor(f: ReturnType<typeof fixture>, venues: readonly Venue[] = ['binance', 'okx', 'mexc']) {
  return createPublicCcxtMarketSource({ mode: 'polling', venues, now: f.now,
    fetchImplementation: f.fetchImplementation, binanceSwapFetchImplementation: f.binanceSwapFetchImplementation,
    catalogTtlMs: 100, pollIntervalMs: 1, retryBaseMs: 10, retryMaxMs: 100,
    requestTimeoutMs: 1000, closeTimeoutMs: 100 });
}
function assertRoutes(f: ReturnType<typeof fixture>) {
  const paths = f.calls.map(call => `${call.channel}:${call.url.hostname}${call.url.pathname}`);
  for (const route of ['native:api-gcp.binance.com/api/v3/exchangeInfo', 'native:api-gcp.binance.com/api/v3/aggTrades',
    'relay:relay.example.test/binance/fapi/v1/exchangeInfo', 'relay:relay.example.test/binance/fapi/v1/aggTrades',
    'native:www.okx.com/api/v5/public/instruments', 'native:www.okx.com/api/v5/market/trades',
    'native:api.mexc.com/api/v3/exchangeInfo', 'native:api.mexc.com/api/v3/aggTrades',
    'native:api.mexc.com/api/v1/contract/detail', 'native:api.mexc.com/api/v1/contract/deals/BTC_USDT']) assert.ok(paths.includes(route), route);
  assert.equal(f.swapInputs.length, f.calls.filter(call => call.channel === 'relay').length);
  f.assertSafe();
}

test('actual factory isolates Binance spot/relay swap and other venues, preserving CCXT catalog and trade identities', async () => {
  const f = fixture();
  const factory = createPublicCcxtFactory(f);
  for (const expected of identities) {
    const client = factory(expected.venue, { mode: 'polling', product: expected.product, timeoutMs: 1000, tradesLimit: 100 });
    try {
      const raw = await client.loadMarkets(true) as Record<string, { id: string; symbol: string }>;
      assert.equal(raw[expected.symbol]!.id, expected.nativeId);
      assert.equal(raw[expected.symbol]!.symbol, expected.symbol);
      const market = normalizeCatalog(expected.venue, raw, client.precisionMode).get(expected.instrument)!;
      assert.ok(market); assert.equal(market.type, expected.product); assert.equal(market.tickSize, '0.1');
      if (expected.product === 'swap') assert.equal(market.contractSize, expected.venue === 'binance' ? 1 : 0.01);
      const trades = await client.fetchTrades(expected.symbol, undefined, 100) as { id?: string; symbol: string; timestamp: number; price: number; amount: number; side: string; info: Record<string, unknown> }[];
      assert.equal(trades.length, 1);
      const trade = trades[0]!;
      assert.equal(trade.symbol, expected.symbol); assert.equal(trade.timestamp, INITIAL);
      assert.equal(trade.price, expected.price); assert.equal(trade.amount, expected.amount); assert.equal(trade.side, 'buy');
      if (expected.venue === 'mexc' && expected.product === 'swap') {
        assert.equal(trade.info.t, INITIAL); assert.equal(trade.info.v, 2);
      } else {
        assert.equal(trade.id, '700', 'CCXT must retain the raw executed-trade identity');
        if (expected.venue === 'okx') assert.equal(trade.info.instId, expected.nativeId);
        else { assert.equal(trade.info.a, 700); assert.equal(trade.info.p, String(expected.price)); }
      }
    } finally { await client.close(); }
  }
  assertRoutes(f);
});

test('actual public source publishes six distinct product identities and rejects same-id trade replay through relay', async () => {
  const f = fixture(), source = sourceFor(f);
  try {
    await source.refreshCatalog();
    assert.equal(source.getMarkets().stale, false); assert.equal(source.getMarkets().markets.length, 12);
    await source.setDemand(identities.map(row => row.instrument)); await source.refresh();
    for (const row of identities) {
      assert.equal(source.eligible(row.instrument), true);
      assert.deepEqual(source.samples(row.instrument), [{ instrument: row.instrument, price: row.price, timestamp: INITIAL, receivedAt: INITIAL }]);
    }
    f.advance(); await source.refresh();
    for (const row of identities) assert.equal(source.samples(row.instrument).length, 1, 'Same raw trade is not a second observation');
    f.nextId(); f.advance(); await source.refresh();
    for (const row of identities.filter(row => row.venue !== 'mexc' || row.product !== 'swap')) {
      assert.equal(source.samples(row.instrument).length, 2, 'A distinct parsed trade ID at the same timestamp remains distinct');
    }
    assert.equal(source.samples('mexc:swap:BTC_USDT').length, 1, 'MEXC swap has no native trade ID; identical fallback identity stays a replay');
    assertRoutes(f);
    assert.equal(JSON.stringify([source.getMarkets(), source.diagnostics(), source.getPrices()]).includes(TOKEN), false);
  } finally { await source.stop(); f.assertSafe(); }
});

test('relay catalog failure disables only swap, clears its observations and never falls back to native futures', async t => {
  for (const failure of ['http', 'transport', 'malformed'] as const) await t.test(failure, async () => {
    const f = fixture(), source = sourceFor(f, ['binance']);
    try {
      await source.refreshCatalog(); await source.setDemand([SPOT, SWAP]); await source.refresh();
      assert.equal(source.samples(SPOT).length, 1); assert.equal(source.samples(SWAP).length, 1);
      const prior = source.getMarkets().sources; assert.ok(Array.isArray(prior));
      const swapAt = prior.find(row => row.type === 'swap')!.updatedAt;
      f.fail(failure); f.advance(100); f.nextId(); await source.refresh();
      assert.equal(source.eligible(SPOT), true); assert.equal(source.eligible(SWAP), false);
      assert.equal(source.ticks().get(SPOT)?.price, 101); assert.equal(source.samples(SPOT).length, 2);
      assert.equal(source.ticks().has(SWAP), false); assert.deepEqual(source.samples(SWAP), []);
      const snapshot = source.getMarkets(); assert.equal(snapshot.stale, true); assert.ok(Array.isArray(snapshot.sources));
      const failed = snapshot.sources.find(row => row.type === 'swap')!;
      assert.equal(failed.stale, true); assert.equal(failed.code, 'catalog_unavailable'); assert.equal(failed.updatedAt, swapAt);
      assert.equal(snapshot.sources.find(row => row.type === 'spot')!.stale, false);
      assert.equal(snapshot.markets.filter(row => row.type === 'swap').length, 2, 'Retain metadata for display during a relay outage');
      assert.ok(snapshot.markets.filter(row => row.type === 'swap').every(row => row.available === false && row.state === 'live'));
      assert.equal(source.diagnostics().venues.find(row => row.type === 'swap')!.clientOpen, false);
      const relayCalls = f.calls.filter(row => row.channel === 'relay').length;
      f.advance(); f.nextId(); await source.refresh();
      assert.equal(f.calls.filter(row => row.channel === 'relay').length, relayCalls, 'Cooldown prevents immediate relay retries');
      assert.equal(source.samples(SPOT).length, 3);
      f.fail('healthy'); f.advance(10); f.nextId(); await source.refresh();
      assert.equal(source.eligible(SWAP), true); assert.equal(source.ticks().get(SWAP)?.price, 202);
      assert.equal(source.samples(SWAP).length, 1); assert.equal(source.samples(SPOT).length, 4);
      assert.equal(f.calls.filter(row => row.channel === 'native' && row.url.pathname === '/api/v3/exchangeInfo').length, 2,
        'Swap retirement/recovery must not reload the unaffected spot client');
      assert.equal(f.calls.filter(row => row.channel === 'relay' && row.url.pathname.endsWith('/aggTrades')).length, 2,
        'No swap trades may be sampled while its catalog is unavailable');
      assert.equal(JSON.stringify([snapshot, source.diagnostics(), source.priceHealth()]).includes(TOKEN), false);
    } finally { await source.stop(); f.assertSafe(); }
  });
});

const ETH_SWAP = 'binance:swap:ETHUSDT';
const flushRelay = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
async function realRelayFixture() {
  let time = INITIAL, catalogLoads = 0, catalogFailure = false;
  const starts: string[] = [], closes: string[] = [], calls: URL[] = [];
  const replies: { symbol: string | null; status: number; body: unknown }[] = [];
  const pending = new Map<string, { resolve: (batch: unknown) => void; reject: (error: Error) => void }>();
  let alter: ((url: URL, response: Response) => Response | Promise<Response>) | undefined;
  const boundaries: BinanceRelayBoundaries = {
    catalog: async () => {
      catalogLoads++;
      if (catalogFailure) throw new Error('offline_catalog_failure');
      const raw = publicExchangeFixture(new URL('https://fapi.binance.com/fapi/v1/exchangeInfo'), time);
      assert.ok(raw?.kind === 'catalog');
      return { capturedAt: time, exchangeInfo: { ...raw.body as object, assets: [] } };
    },
    stream: async market => {
      starts.push(market.nativeId);
      return {
        next: () => new Promise((resolve, reject) => { pending.set(market.nativeId, { resolve, reject }); }),
        close: async () => { closes.push(market.nativeId); pending.get(market.nativeId)?.reject(new Error('offline_closed')); pending.delete(market.nativeId); },
      };
    },
  };
  const relay = await createBinanceFuturesRelay({ token: TOKEN, boundaries, now: () => time,
    freshnessMs: 10, timeoutMs: 1000, catalogTtlMs: 1000 });
  const binanceSwapFetchImplementation = createBinanceRelayFetch({ url: RELAY, token: TOKEN, timeoutMs: 1000,
    fetchImplementation: async (input, init) => {
      const request = new Request(input, init), url = new URL(request.url);
      calls.push(url);
      assert.equal(url.origin, 'https://relay.example.test');
      assert.ok(['/binance/fapi/v1/exchangeInfo', '/binance/fapi/v1/aggTrades'].includes(url.pathname));
      assert.equal(request.headers.get('authorization'), `Bearer ${TOKEN}`);
      assert.equal(init?.redirect, 'manual');
      const local = new URL(url); local.pathname = local.pathname.slice('/binance'.length);
      const response = await relay.handle(new Request(local, request));
      replies.push({ symbol: url.searchParams.get('symbol'), status: response.status, body: await response.clone().json() });
      return alter ? alter(url, response) : response;
    },
  });
  const fetchImplementation: typeof fetch = async (input, init) => {
    const request = new Request(input, init), url = new URL(request.url);
    assert.equal(url.origin, 'https://api-gcp.binance.com');
    assert.equal(url.pathname, '/api/v3/exchangeInfo');
    assert.equal(request.headers.has('authorization'), false);
    const raw = publicExchangeFixture(url, time); assert.ok(raw); return Response.json(raw.body);
  };
  const factoryOptions = { binanceSwapFetchImplementation, fetchImplementation, now: () => time };
  const source = createPublicCcxtMarketSource({ ...factoryOptions, mode: 'polling', venues: ['binance'],
    catalogTtlMs: 1000, pollIntervalMs: 1, retryBaseMs: 10, retryMaxMs: 100,
    requestTimeoutMs: 1000, closeTimeoutMs: 100 });
  return { relay, source, factoryOptions, calls, replies, starts, closes,
    advance: (ms = 1) => { time += ms; }, catalogLoads: () => catalogLoads,
    failCatalog: () => { catalogFailure = true; }, alter: (fn: typeof alter) => { alter = fn; },
    emit: async (symbol: string, id: number, price: string) => {
      await flushRelay(); const waiter = pending.get(symbol); assert.ok(waiter, `active relay stream for ${symbol}`);
      waiter.resolve([{ symbol: `${symbol.slice(0, -4)}/USDT:USDT`, info: { e: 'aggTrade', s: symbol,
        a: id, f: id, l: id, T: time, p: price, q: '0.25', m: false } }]);
      await flushRelay();
    },
    failStream: async (symbol: string) => { await flushRelay(); assert.ok(pending.has(symbol)); pending.get(symbol)!.reject(new Error('offline_stream_failure')); await flushRelay(); },
    close: async () => { await source.stop(); await relay.close(); },
  };
}

test('real relay → adapter → actual public source isolates quiet ETH across cycles, clears only its observations and recovers', async () => {
  const f = await realRelayFixture(), { source } = f;
  try {
    await source.refreshCatalog(); const catalog = source.getMarkets();
    await source.setDemand([ETH_SWAP, SWAP]); await source.refresh();
    assert.deepEqual(f.replies.filter(r => r.symbol).map(r => [r.status, r.body]), [
      [503, { code: -1, msg: 'no_fresh_trade', symbol: 'ETHUSDT' }],
      [503, { code: -1, msg: 'no_fresh_trade', symbol: 'BTCUSDT' }],
    ]);
    const initialRequests = f.calls.length;
    await source.refresh(); assert.equal(f.calls.length, initialRequests, 'Quiet symbols obey their poll interval');
    assert.equal(source.diagnostics().venues.find(v => v.type === 'swap')!.clientOpen, true);
    assert.equal(source.lastPollAt(), null, 'No fresh outcome is not a successful price observation');
    for (let id = 1; id <= 3; id++) {
      f.advance(); await f.emit('BTCUSDT', id, String(200 + id)); await source.refresh();
      assert.equal(source.ticks().get(SWAP)?.price, 200 + id);
      assert.equal(source.samples(SWAP).length, id);
      assert.equal(source.ticks().has(ETH_SWAP), false); assert.deepEqual(source.samples(ETH_SWAP), []);
      assert.equal(source.diagnostics().instruments.find(d => d.instrument === ETH_SWAP)!.code, 'no_fresh_trade');
      assert.equal(source.priceHealth().state, 'degraded');
      assert.deepEqual(source.getMarkets(), catalog);
      assert.deepEqual(source.diagnostics().venues.find(v => v.type === 'swap'), {
        venue: 'binance', type: 'swap', catalogAt: INITIAL, catalogCode: null, priceCode: null, retryAt: 0, clientOpen: true,
      });
    }
    f.advance(); await f.emit('BTCUSDT', 4, '204'); await f.emit('ETHUSDT', 1, '300'); await source.refresh();
    assert.equal(source.samples(ETH_SWAP).length, 1); assert.equal(source.ticks().get(ETH_SWAP)?.price, 300);
    assert.equal(source.priceHealth().state, 'healthy');
    f.advance(11); await f.emit('BTCUSDT', 5, '205'); await source.refresh();
    assert.equal(source.ticks().has(ETH_SWAP), false, 'Clear ETH current before the source freshness window expires');
    assert.deepEqual(source.samples(ETH_SWAP), []);
    assert.equal(source.diagnostics().instruments.find(d => d.instrument === ETH_SWAP)!.queued, 0);
    assert.equal(source.diagnostics().instruments.find(d => d.instrument === ETH_SWAP)!.replayEntries, 1);
    assert.equal(source.samples(SWAP).length, 5, 'Quiet ETH cannot discard fresh BTC crossings');
    assert.equal(source.diagnostics().queued, 5);
    for (let id = 6; id <= 7; id++) {
      f.advance(); await f.emit('BTCUSDT', id, String(200 + id)); await source.refresh();
      assert.equal(source.samples(SWAP).length, id); assert.deepEqual(source.samples(ETH_SWAP), []);
    }
    const priorEthTrade = f.replies.find(r => r.symbol === 'ETHUSDT' && r.status === 200)!.body;
    f.alter((url, response) => url.searchParams.get('symbol') === 'ETHUSDT' ? Response.json(priorEthTrade) : response);
    f.advance(); await source.refresh();
    assert.equal(source.ticks().has(ETH_SWAP), false, 'A cached replay cannot restore ETH after no-fresh invalidation');
    assert.deepEqual(source.samples(ETH_SWAP), []); assert.equal(source.samples(SWAP).length, 7);
    f.alter(undefined);
    f.advance(); await f.emit('BTCUSDT', 8, '208'); await f.emit('ETHUSDT', 2, '301'); await source.refresh();
    assert.equal(source.ticks().get(ETH_SWAP)?.price, 301); assert.equal(source.samples(ETH_SWAP).length, 1);
    assert.equal(source.diagnostics().instruments.find(d => d.instrument === ETH_SWAP)!.code, null);
    assert.equal(source.priceHealth().state, 'healthy');
    assert.deepEqual(source.getMarkets(), catalog); assert.equal(f.catalogLoads(), 1);
    assert.deepEqual(f.starts, ['ETHUSDT', 'BTCUSDT']); assert.deepEqual(f.closes, []);
    assert.equal(f.calls.filter(url => url.pathname.endsWith('/exchangeInfo')).length, 1, 'Quiet/recovery cycles reuse the CCXT client');
  } finally { await f.close(); }
});

test('actual CCXT response boundary propagates typed no-fresh but does not interpret wrapped transport messages', async () => {
  const f = await realRelayFixture();
  const client = createPublicCcxtFactory(f.factoryOptions)('binance', { mode: 'polling', product: 'swap', timeoutMs: 1000, tradesLimit: 100 });
  try {
    await client.loadMarkets(true);
    await assert.rejects(client.fetchTrades('ETH/USDT:USDT', undefined, 100), error =>
      error instanceof SymbolTradesUnavailableError && error.symbol === 'ETH/USDT:USDT');
    f.alter(() => { throw new TypeError('no_fresh_trade'); });
    await assert.rejects(client.fetchTrades('ETH/USDT:USDT', undefined, 100), error =>
      error instanceof Error && error.message === 'relay_unavailable' && !(error instanceof SymbolTradesUnavailableError));
    // Bypass the adapter's sanitization to exercise CCXT's real TypeError →
    // NetworkError wrapping as well: text alone must never grant isolation.
    const wrappedClient = createPublicCcxtFactory({ ...f.factoryOptions, binanceSwapFetchImplementation: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname.endsWith('/aggTrades')) throw new TypeError('no_fresh_trade');
      return f.factoryOptions.binanceSwapFetchImplementation(input, init);
    } })('binance', { mode: 'polling', product: 'swap', timeoutMs: 1000, tradesLimit: 100 });
    try {
      f.alter(undefined); await wrappedClient.loadMarkets(true);
      await assert.rejects(wrappedClient.fetchTrades('ETH/USDT:USDT', undefined, 100), error =>
        error instanceof ccxt.NetworkError && !(error instanceof SymbolTradesUnavailableError));
    } finally { await wrappedClient.close(); }
    const nativeClient = createPublicCcxtFactory({ fetchImplementation: async () => Response.json({ code: -1, msg: 'no_fresh_trade', symbol: 'ETHUSDT' }, { status: 503 }) })('binance', {
      mode: 'polling', product: 'swap', timeoutMs: 1000, tradesLimit: 100,
    });
    try { await assert.rejects(nativeClient.loadMarkets(true), error => !(error instanceof SymbolTradesUnavailableError)); }
    finally { await nativeClient.close(); }
  } finally { await client.close(); await f.close(); }
});

test('real relay chain keeps unrelated failures fail-closed for the swap scope', async t => {
  const failures = {
    unavailable: () => Response.json({ code: -1, msg: 'unavailable' }, { status: 503 }),
    transport: () => { throw new TypeError('no_fresh_trade'); },
    wrongSymbol: () => Response.json({ code: -1, msg: 'no_fresh_trade', symbol: 'BTCUSDT' }, { status: 503 }),
    wrongCode: () => Response.json({ code: 0, msg: 'no_fresh_trade', symbol: 'ETHUSDT' }, { status: 503 }),
    extraField: () => Response.json({ code: -1, msg: 'no_fresh_trade', symbol: 'ETHUSDT', extra: true }, { status: 503 }),
    wrongStatus: () => Response.json({ code: -1, msg: 'no_fresh_trade', symbol: 'ETHUSDT' }, { status: 429 }),
    falseSuccess: () => Response.json({ code: -1, msg: 'no_fresh_trade', symbol: 'ETHUSDT' }),
    emptySuccess: () => Response.json([]),
    invalidJson: () => new Response('{', { status: 503, headers: { 'content-type': 'application/json' } }),
    wrongContent: () => new Response('{"code":-1,"msg":"no_fresh_trade","symbol":"ETHUSDT"}', { status: 503 }),
    oversized: () => new Response(' '.repeat(65537), { status: 503, headers: { 'content-type': 'application/json' } }),
    redirect: () => new Response(null, { status: 302, headers: { location: 'https://denied.invalid/' } }),
    stream: undefined,
  };
  for (const [name, failure] of Object.entries(failures)) await t.test(name, async () => {
    const f = await realRelayFixture(), { source } = f;
    try {
      await source.refreshCatalog(); await source.setDemand([SWAP, ETH_SWAP]); await source.refresh();
      await f.emit('BTCUSDT', 1, '200'); await f.emit('ETHUSDT', 1, '300'); f.advance(); await source.refresh();
      assert.equal(source.getPrices().length, 2); assert.equal(source.diagnostics().queued, 2);
      if (failure) f.alter((url, response) => url.searchParams.get('symbol') === 'ETHUSDT' ? failure() : response);
      else await f.failStream('ETHUSDT');
      f.advance(); await f.emit('BTCUSDT', 2, '201'); await source.refresh();
      assert.deepEqual(source.getPrices(), []); assert.deepEqual(source.samples(SWAP), []); assert.deepEqual(source.samples(ETH_SWAP), []);
      assert.equal(source.diagnostics().queued, 0);
      const swap = source.diagnostics().venues.find(v => v.type === 'swap')!;
      assert.equal(swap.clientOpen, false); assert.equal(swap.priceCode, 'poll_unavailable'); assert.ok(swap.retryAt > INITIAL);
      assert.equal(source.priceHealth().state, 'unhealthy'); assert.equal(source.priceHealth().code, 'poll_unavailable');
      assert.equal(source.getMarkets().stale, false, 'A price fault preserves the validated catalog');
      assert.equal(source.eligible(SWAP), true); assert.equal(source.eligible(ETH_SWAP), true);
      const count = f.calls.length; f.advance(); await source.refresh(); assert.equal(f.calls.length, count, 'Scope fault obeys retry backoff');
      if (name === 'stream') assert.deepEqual(f.replies.at(-1)?.body, { code: -1, msg: 'unavailable' });
    } finally { await f.close(); }
  });
});

test('real relay catalog failure cannot masquerade as a quiet symbol outcome', async () => {
  const f = await realRelayFixture(), { source } = f;
  try {
    await source.refreshCatalog(); await source.setDemand([SWAP, ETH_SWAP]); await source.refresh();
    await f.emit('BTCUSDT', 1, '200'); f.advance(); await source.refresh();
    assert.equal(source.ticks().get(SWAP)?.price, 200);
    f.failCatalog(); f.advance(1000); await source.refresh();
    assert.deepEqual(source.getPrices(), []); assert.equal(source.getMarkets().stale, true);
    assert.equal(source.eligible(SWAP), false); assert.equal(source.eligible(ETH_SWAP), false);
    const swap = source.diagnostics().venues.find(v => v.type === 'swap')!;
    assert.equal(swap.clientOpen, false); assert.equal(swap.catalogCode, 'catalog_unavailable');
    assert.equal(f.replies.at(-1)?.status, 503); assert.deepEqual(f.replies.at(-1)?.body, { code: -1, msg: 'unavailable' });
  } finally { await f.close(); }
});

test('swap relay override rejects stream clients and unsplit Binance factory/source scopes before transport', () => {
  const f = fixture(), factory = createPublicCcxtFactory(f);
  const settings = { timeoutMs: 1000, tradesLimit: 100 };
  assert.throws(() => factory('binance', { ...settings, mode: 'stream', product: 'swap' }), /relay_requires_polling/);
  for (const mode of ['polling', 'stream'] as const) {
    assert.throws(() => factory('binance', { ...settings, mode }), /invalid_product_scope/);
    assert.throws(() => createPublicCcxtMarketSource({ ...f, mode, venues: ['binance'], splitProducts: [] }), /invalid_product_scope/);
  }
  assert.equal(f.calls.length, 0); assert.equal(f.swapInputs.length, 0); f.assertSafe();
});

test('stream public source fails swap construction closed while actual Pro spot catalog remains available', async () => {
  const f = fixture();
  const source = createPublicCcxtMarketSource({ ...f, mode: 'stream', venues: ['binance'], requestTimeoutMs: 1000, closeTimeoutMs: 100 });
  try {
    await source.refreshCatalog();
    assert.equal(source.eligible(SPOT), true); assert.equal(source.eligible(SWAP), false);
    assert.equal(source.diagnostics().venues.find(row => row.type === 'swap')!.catalogCode, 'catalog_unavailable');
    assert.equal(f.swapInputs.length, 0); assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0]!.url.href, 'https://api-gcp.binance.com/api/v3/exchangeInfo');
    assert.equal(source.getMarkets().markets.length, 2);
  } finally { await source.stop(); f.assertSafe(); }
});
