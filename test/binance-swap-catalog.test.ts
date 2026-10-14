import test, { after, before, mock } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import ccxt from 'ccxt';
import { createPublicCcxtFactory, createPublicCcxtMarketSource } from '../src/markets/ccxt.js';
import type { BinanceSwapCatalogSnapshot } from '../src/markets/ccxt.js';
import { normalizeCatalog } from '../src/markets/normalize.js';
import { publicExchangeFixture } from './runtime-cloudflare-fixtures.js';

// Real package constructors, parsing, normalization and setMarkets. Only public
// transport boundaries are stubbed; no network or actual WS subscription runs.
const denied: string[] = [];
before(() => {
  const deny = (path: string) => (..._args: unknown[]): never => {
    denied.push(path); throw new Error(`external_network_denied:${path}`);
  };
  mock.method(globalThis, 'fetch', deny('fetch'));
  mock.method(net.Socket.prototype, 'connect', deny('net.connect'));
  mock.method(tls, 'connect', deny('tls.connect'));
  mock.method(http, 'request', deny('http.request')); mock.method(http, 'get', deny('http.get'));
  mock.method(https, 'request', deny('https.request')); mock.method(https, 'get', deny('https.get'));
  mock.method(dns, 'lookup', deny('dns.lookup')); mock.method(dns, 'resolve', deny('dns.resolve'));
  for (const classes of [ccxt, ccxt.pro]) mock.method(classes.binance.prototype, 'throttle', async () => {});
});
after(() => { mock.restoreAll(); assert.deepEqual(denied, [], 'No native network path should be attempted'); });

const initial = 1_700_000_000_000;
const settings = { mode: 'polling' as const, timeoutMs: 5000, tradesLimit: 100, product: 'swap' as const };
const forbiddenFetch: typeof fetch = async () => { assert.fail('Injected swap catalog must not request REST'); };
function exchangeInfo(at = initial): Record<string, unknown> & { symbols: Record<string, unknown>[] } {
  const fixture = publicExchangeFixture(new URL('https://fapi.binance.com/fapi/v1/exchangeInfo'), at);
  assert.ok(fixture && fixture.kind === 'catalog');
  const info = structuredClone(fixture.body) as ReturnType<typeof exchangeInfo>;
  // Complete USD-M envelope shape, including fields absent from the older shared
  // fixture. This is synthetic offline metadata, never a live captured catalog.
  info.assets = [{ asset: 'USDT', marginAvailable: true, autoAssetExchange: '-10000' }];
  const template = info.symbols[0]!;
  info.symbols.push(
    { ...structuredClone(template), symbol: 'SOLUSDC', baseAsset: 'SOL', quoteAsset: 'USDC', marginAsset: 'USDC' },
    { ...structuredClone(template), symbol: 'OFFUSDT', baseAsset: 'OFF', status: 'BREAK' },
    { ...structuredClone(template), symbol: 'BTCUSDT_270326', contractType: 'CURRENT_QUARTER', deliveryDate: 1_806_019_200_000 },
  );
  return info;
}
function fixture(mode: 'polling' | 'stream' = 'polling', maxCatalogMarkets = 20_000) {
  let time = initial, calls = 0;
  let change: (snapshot: BinanceSwapCatalogSnapshot) => BinanceSwapCatalogSnapshot = snapshot => snapshot;
  const client = createPublicCcxtFactory({ fetchImplementation: forbiddenFetch, now: () => time, maxCatalogMarkets,
    binanceSwapCatalog: async () => { calls++; return change({ capturedAt: time, exchangeInfo: exchangeInfo(time) }); },
  })('binance', { ...settings, mode });
  return { client, calls: () => calls, advance: (ms = 1) => { time += ms; }, alter: (fn: typeof change) => { change = fn; } };
}

test('fresh complete swap envelope uses real CCXT parsing and normalization without REST', async () => {
  const f = fixture();
  try {
    const catalog = await f.client.loadMarkets(true) as Record<string, unknown>;
    assert.equal(Object.keys(catalog).length, 5, 'Excluded products stay in the complete CCXT maps');
    const normalized = normalizeCatalog('binance', catalog, f.client.precisionMode);
    assert.deepEqual([...normalized.keys()], ['binance:swap:BTCUSDT', 'binance:swap:ETHUSDT']);
    assert.equal(normalized.get('binance:swap:BTCUSDT')!.tickSize, '0.1');
    assert.equal(normalized.get('binance:swap:BTCUSDT')!.contractSize, 1, 'Contract size comes from the actual official parser');
    await f.client.loadMarkets(); assert.equal(f.calls(), 1, 'Native loadMarkets caches the seeded catalog');
    f.advance();
    f.alter(snapshot => {
      const info = snapshot.exchangeInfo as ReturnType<typeof exchangeInfo>;
      info.symbols[0]!.filters = [{ filterType: 'PRICE_FILTER', tickSize: '0.05', minPrice: '0.05', maxPrice: '1000000' }];
      return snapshot;
    });
    const reloaded = normalizeCatalog('binance', await f.client.loadMarkets(true), f.client.precisionMode);
    assert.equal(f.calls(), 2); assert.equal(reloaded.get('binance:swap:BTCUSDT')!.tickSize, '0.05');
  } finally { await f.client.close(); }
});

test('capture must fall inside this invocation and use a safe nonnegative local clock', async t => {
  for (const capturedAt of [initial - 1, initial + 1, -1, NaN, Infinity, initial + 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    await t.test(String(capturedAt), async () => {
      const f = fixture(); f.alter(snapshot => ({ ...snapshot, capturedAt }));
      try { await assert.rejects(() => f.client.loadMarkets(true), /invalid_catalog_capture/); }
      finally { await f.client.close(); }
    });
  }
  let time = initial;
  const client = createPublicCcxtFactory({ now: () => time, fetchImplementation: forbiddenFetch,
    binanceSwapCatalog: async () => { time += 10; return { capturedAt: time - 5, exchangeInfo: exchangeInfo() }; },
  })('binance', settings);
  try { await client.loadMarkets(true); } finally { await client.close(); }
  for (const clock of [-1, NaN, Infinity, initial + 0.5]) {
    const bad = createPublicCcxtFactory({ now: () => clock, fetchImplementation: forbiddenFetch,
      binanceSwapCatalog: async () => { assert.fail('Invalid clock must fail before invoking provider'); },
    })('binance', settings);
    try { await assert.rejects(() => bad.loadMarkets(true), /invalid_catalog_capture/); }
    finally { await bad.close(); }
  }
  const reversed = createPublicCcxtFactory({ now: () => time, fetchImplementation: forbiddenFetch,
    binanceSwapCatalog: async () => { const capturedAt = time; time--; return { capturedAt, exchangeInfo: exchangeInfo() }; },
  })('binance', settings);
  try { await assert.rejects(() => reversed.loadMarkets(true), /invalid_catalog_capture/); }
  finally { await reversed.close(); }
});

test('missing/wrong complete envelope fields and malformed raw rows reject', async t => {
  const patches: [string, (info: ReturnType<typeof exchangeInfo>) => void][] = [
    ...['symbols', 'assets', 'rateLimits', 'exchangeFilters', 'timezone', 'serverTime'].map(field =>
      [field, (info: ReturnType<typeof exchangeInfo>) => { delete info[field]; }] as [string, (info: ReturnType<typeof exchangeInfo>) => void]),
    ['wrong symbols', info => { Object.assign(info, { symbols: {} }); }],
    ['null row', info => { (info.symbols as unknown[])[0] = null; }],
    ['missing identity', info => { delete info.symbols[0]!.baseAsset; }],
    ['missing swap category', info => { delete info.symbols[0]!.contractType; }],
    ['excluded row parser would drop', info => { delete info.symbols[2]!.baseAsset; delete info.symbols[2]!.symbol; }],
    ['spot row in swap envelope', info => { delete info.symbols[2]!.contractType; delete info.symbols[2]!.deliveryDate; }],
    ['supported invalid precision', info => { info.symbols[0]!.filters = [{ filterType: 'PRICE_FILTER', tickSize: '0' }]; }],
    ['supported invalid contract size', info => { info.symbols[0]!.contractSize = '0'; }],
  ];
  for (const [label, patch] of patches) await t.test(label, async () => {
    const f = fixture(); f.alter(snapshot => { patch(snapshot.exchangeInfo as ReturnType<typeof exchangeInfo>); return snapshot; });
    try { await assert.rejects(() => f.client.loadMarkets(true), /invalid_catalog_(collection|row|metadata)/); }
    finally { await f.client.close(); }
  });
  const f = fixture(); f.alter(snapshot => ({ ...snapshot, exchangeInfo: { symbols: [] } }));
  try { await assert.rejects(() => f.client.loadMarkets(true), /invalid_catalog_collection/); }
  finally { await f.client.close(); }
});

test('duplicates reject before native setMarkets can collapse any rows, including excluded products', async t => {
  const cases = ['raw id', 'parsed symbol', 'excluded id', 'excluded symbol'];
  for (const kind of cases) await t.test(kind, async () => {
    const f = fixture(); f.alter(snapshot => {
      const rows = (snapshot.exchangeInfo as ReturnType<typeof exchangeInfo>).symbols;
      const original = rows[kind.startsWith('excluded') ? 2 : 0]!;
      rows.push({ ...structuredClone(original), ...(kind.endsWith('symbol') ? { symbol: 'ANOTHER_NATIVE_ID' } : {}) });
      return snapshot;
    });
    try { await assert.rejects(() => f.client.loadMarkets(true), /duplicate_market/); }
    finally { await f.client.close(); }
  });
});

test('capacity counts the full raw envelope, including out-of-scope rows', async () => {
  const f = fixture('polling', 4);
  try { await assert.rejects(() => f.client.loadMarkets(true), /catalog_capacity/); }
  finally { await f.client.close(); }
  const atLimit = fixture('polling', 5);
  try { assert.equal(Object.keys(await atLimit.client.loadMarkets(true) as object).length, 5); }
  finally { await atLimit.client.close(); }
});

test('invalid reload never commits and a later fresh reload recovers', async () => {
  const original = ccxt.binance.prototype.setMarkets;
  let commits = 0;
  const spy = mock.method(ccxt.binance.prototype, 'setMarkets', function (this: InstanceType<typeof ccxt.binance>, ...args: Parameters<typeof original>) {
    commits++; return original.apply(this, args);
  });
  const f = fixture();
  try {
    const prior = await f.client.loadMarkets(true);
    const baseline = commits;
    f.advance(); f.alter(snapshot => ({ ...snapshot, capturedAt: initial }));
    await assert.rejects(() => f.client.loadMarkets(true), /invalid_catalog_capture/);
    assert.equal(commits, baseline, 'A bad snapshot cannot mutate any CCXT map');
    f.alter(snapshot => {
      const rows = (snapshot.exchangeInfo as ReturnType<typeof exchangeInfo>).symbols;
      rows[0]!.filters = [{ filterType: 'PRICE_FILTER', tickSize: '0' }]; return snapshot;
    });
    await assert.rejects(() => f.client.loadMarkets(true), /invalid_catalog_metadata/);
    assert.equal(commits, baseline, 'Real normalization must finish before native setMarkets');
    f.alter(snapshot => {
      const rows = (snapshot.exchangeInfo as ReturnType<typeof exchangeInfo>).symbols;
      rows.push(structuredClone(rows[0]!)); return snapshot;
    });
    await assert.rejects(() => f.client.loadMarkets(true), /duplicate_market/);
    assert.equal(commits, baseline, 'Duplicate detection must finish before native setMarkets');
    f.alter(snapshot => snapshot); f.advance();
    const next = await f.client.loadMarkets(true);
    assert.equal(commits, baseline + 1); assert.notEqual(next, prior); assert.equal(f.calls(), 5);
  } finally { await f.client.close(); spy.mock.restore(); }
});

test('real Pro implicit watchTrades seeds native maps and routes swap WS without REST', async () => {
  const f = fixture('stream');
  let watches = 0;
  const watch = mock.method(ccxt.pro.binance.prototype, 'watchMultiple', async function (this: InstanceType<typeof ccxt.pro.binance>, ...args: unknown[]) {
    watches++;
    assert.equal(this.symbols!.length, 5); assert.equal(this.ids!.length, 5);
    assert.equal(this.market('BTC/USDT:USDT').id, 'BTCUSDT');
    assert.equal(this.markets_by_id!['BTCUSDT']![0]!.symbol, 'BTC/USDT:USDT');
    assert.ok(this.currencies.USDT);
    assert.match(String(args[0]), /^wss:\/\/.*fstream\.binance\.com\//);
    assert.deepEqual((args[2] as { params: string[] }).params, ['btcusdt@trade']);
    return Object.defineProperty([{ symbol: 'BTC/USDT:USDT', timestamp: initial, price: 100, amount: 1 }], 'getLimit', { value: () => 1 });
  });
  try {
    const trades = await f.client.watchTrades!('BTC/USDT:USDT');
    assert.equal((trades as { symbol: string }[])[0]!.symbol, 'BTC/USDT:USDT');
    assert.equal(f.calls(), 1); assert.equal(watches, 1);
    await f.client.watchTrades!('BTC/USDT:USDT'); assert.equal(f.calls(), 1);
    await f.client.loadMarkets(true); assert.equal(f.calls(), 2);
    await f.client.watchTrades!('BTC/USDT:USDT'); assert.equal(f.calls(), 2);
  } finally { await f.client.close(); watch.mock.restore(); }
});

test('Binance spot remains on real public REST parser and never invokes the swap provider', async () => {
  let requests = 0;
  const spot = createPublicCcxtFactory({ binanceSwapCatalog: async () => { assert.fail('Spot must ignore swap provider'); },
    fetchImplementation: async input => {
      const url = new URL(String(input)); requests++;
      assert.equal(url.pathname, '/api/v3/exchangeInfo');
      const response = publicExchangeFixture(url); assert.ok(response);
      return Response.json(response.body);
    },
  })('binance', { ...settings, product: 'spot' });
  try {
    const catalog = normalizeCatalog('binance', await spot.loadMarkets(true), spot.precisionMode);
    assert.deepEqual([...catalog.keys()], ['binance:spot:BTCUSDT', 'binance:spot:ETHUSDT']);
    assert.equal(requests, 1);
  } finally { await spot.close(); }
});

test('provider requires explicit Binance swap scope; unsplit source fails synchronously', () => {
  const binanceSwapCatalog = async () => ({ capturedAt: initial, exchangeInfo: exchangeInfo() });
  const factory = createPublicCcxtFactory({ binanceSwapCatalog, fetchImplementation: forbiddenFetch });
  assert.throws(() => factory('binance', { mode: 'stream', timeoutMs: 100, tradesLimit: 100 }), /invalid_product_scope/);
  assert.throws(() => createPublicCcxtMarketSource({ mode: 'stream', venues: ['binance'], splitProducts: [], binanceSwapCatalog }), /invalid_product_scope/);
});

test('public source forwards the full envelope capacity before publishing swap markets', async () => {
  const source = createPublicCcxtMarketSource({ mode: 'polling', venues: ['binance'], now: () => initial,
    maxCatalogMarkets: 4, closeTimeoutMs: 100,
    binanceSwapCatalog: async () => ({ capturedAt: initial, exchangeInfo: exchangeInfo() }),
    fetchImplementation: async input => {
      const url = new URL(String(input)); assert.equal(url.pathname, '/api/v3/exchangeInfo');
      const response = publicExchangeFixture(url, initial); assert.ok(response); return Response.json(response.body);
    },
  });
  try {
    await source.refreshCatalog();
    assert.equal(source.getMarkets().markets.length, 2, 'Only the unaffected spot catalog is published');
    assert.equal(source.eligible('binance:swap:BTCUSDT'), false);
    assert.equal(source.diagnostics().venues.find(scope => scope.type === 'swap')!.catalogCode, 'catalog_unavailable');
  } finally { await source.stop(); }
});

test('public source forwards provider, clock and full capacity; stale reload preserves display but disables eligibility', async () => {
  let time = initial, calls = 0, stale = false;
  const requests: string[] = [];
  const source = createPublicCcxtMarketSource({ mode: 'polling', venues: ['binance'], now: () => time,
    catalogTtlMs: 10, retryBaseMs: 1, retryMaxMs: 10, closeTimeoutMs: 100, maxCatalogMarkets: 5,
    binanceSwapCatalog: async () => { calls++; return { capturedAt: stale ? initial : time, exchangeInfo: exchangeInfo(time) }; },
    fetchImplementation: async input => {
      const url = new URL(String(input)); requests.push(url.pathname);
      assert.equal(url.pathname, '/api/v3/exchangeInfo', 'Swap load must use provider while spot still uses REST');
      const response = publicExchangeFixture(url, time); assert.ok(response);
      return Response.json(response.body);
    },
  });
  try {
    await source.refreshCatalog();
    const prior = source.getMarkets(); assert.equal(prior.stale, false);
    assert.equal(prior.markets.length, 4); assert.equal(source.eligible('binance:swap:BTCUSDT'), true);
    time += 10; stale = true; await source.refreshCatalog();
    const failed = source.getMarkets();
    assert.equal(source.eligible('binance:swap:BTCUSDT'), false);
    assert.equal(source.eligible('binance:spot:BTCUSDT'), true);
    assert.ok(Array.isArray(failed.sources)); assert.ok(Array.isArray(prior.sources));
    assert.equal(failed.sources.find(scope => scope.type === 'swap')!.updatedAt, prior.sources.find(scope => scope.type === 'swap')!.updatedAt);
    assert.equal(failed.sources.find(scope => scope.type === 'swap')!.stale, true);
    assert.equal(failed.markets.filter(market => market.type === 'swap').length, 2);
    assert.ok(failed.markets.filter(market => market.type === 'swap').every(market => market.available === false));
    stale = false; time++; await source.refreshCatalog();
    assert.equal(source.eligible('binance:swap:BTCUSDT'), true); assert.equal(calls, 3);
    assert.ok(requests.every(path => path === '/api/v3/exchangeInfo'));
  } finally { await source.stop(); }
});
