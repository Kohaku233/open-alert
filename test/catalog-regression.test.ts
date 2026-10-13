import test, { after, before, mock } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import ccxt from 'ccxt';
import { createPublicCcxtMarketSource } from '../src/markets/ccxt.js';
import { instrumentId, normalizeCatalog } from '../src/markets/normalize.js';
import type { MarketMode } from '../src/markets/source.js';
import { currencyCodeSchema, instrumentSchema, nativeMarketIdSchema, parseInstrumentIdentity, type MarketType, type Venue } from '../src/contracts/domain.js';
import { publicExchangeFixture } from './runtime-cloudflare-fixtures.js';

// Injected Response fixtures are the only allowed I/O. Deny native fetch and
// socket/HTTP/DNS paths as well, including unexpected CCXT fallback transports.
const denied: string[] = [];
before(() => {
  // Only skip wall-clock rate-limit waits in this offline test process. Request
  // routing, HTTP/JSON error handling, loadMarkets and market parsers stay real.
  for (const classes of [ccxt, ccxt.pro]) for (const venue of ['binance', 'okx', 'mexc'] as const) {
    mock.method(classes[venue].prototype, 'throttle', async () => {});
  }
  const deny = (path: string) => (..._args: unknown[]): never => { denied.push(path); throw new Error(`external_network_denied:${path}`); };
  mock.method(globalThis, 'fetch', deny('fetch'));
  mock.method(net.Socket.prototype, 'connect', deny('net.connect'));
  mock.method(tls, 'connect', deny('tls.connect'));
  mock.method(http, 'request', deny('http.request')); mock.method(http, 'get', deny('http.get'));
  mock.method(https, 'request', deny('https.request')); mock.method(https, 'get', deny('https.get'));
  mock.method(dns, 'lookup', deny('dns.lookup')); mock.method(dns, 'resolve', deny('dns.resolve'));
});
after(() => { mock.restoreAll(); assert.deepEqual(denied, [], 'Every request must use injected offline responses'); });

const initial = 1_700_000_000_000;
const routes = [
  { venue: 'binance', type: 'spot', host: 'api-gcp.binance.com', path: '/api/v3/exchangeInfo', field: 'symbols' },
  { venue: 'binance', type: 'swap', host: 'fapi.binance.com', path: '/fapi/v1/exchangeInfo', field: 'symbols' },
  { venue: 'okx', type: 'spot', host: 'www.okx.com', path: '/api/v5/public/instruments', field: 'data' },
  { venue: 'okx', type: 'swap', host: 'www.okx.com', path: '/api/v5/public/instruments', field: 'data' },
  { venue: 'mexc', type: 'spot', host: 'api.mexc.com', path: '/api/v3/exchangeInfo', field: 'symbols' },
  { venue: 'mexc', type: 'swap', host: 'api.mexc.com', path: '/api/v1/contract/detail', field: 'data' },
] as const;
type Route = typeof routes[number];
function matches(url: URL, route: Route): boolean {
  return url.hostname === route.host && url.pathname === route.path &&
    (route.venue !== 'okx' || url.searchParams.get('instType') === (route.type === 'spot' ? 'SPOT' : 'SWAP'));
}
function fixture(venue: Venue, mode: MarketMode = 'polling') {
  let time = initial;
  let change: (url: URL, body: Record<string, unknown>) => void = () => {};
  const requests: URL[] = [];
  const fetchImplementation: typeof fetch = async (input, init) => {
    const url = new URL(String(input)); requests.push(url);
    assert.equal(init?.method, 'GET');
    const response = publicExchangeFixture(url, time);
    assert.ok(response && response.kind === 'catalog', `Unknown or non-catalog offline request: ${url}`);
    const body = structuredClone(response.body) as Record<string, unknown>;
    change(url, body);
    return Response.json(body);
  };
  const source = createPublicCcxtMarketSource({ mode, venues: [venue], splitProducts: [], fetchImplementation,
    now: () => time, catalogTtlMs: 100, requestTimeoutMs: 5000, closeTimeoutMs: 100,
    retryBaseMs: 10, retryMaxMs: 100 });
  return { source, requests, alter: (fn: typeof change) => { change = fn; }, advance: (ms = 100) => { time += ms; }, time: () => time };
}
function row(venue: Venue, type: MarketType): Record<string, unknown> {
  const swap = type === 'swap';
  return { id: venue === 'okx' ? `BTC-USDT${swap ? '-SWAP' : ''}` : venue === 'mexc' && swap ? 'BTC_USDT' : 'BTCUSDT',
    symbol: `BTC/USDT${swap ? ':USDT' : ''}`, base: 'BTC', quote: 'USDT', type,
    active: true, spot: !swap, swap, contract: swap, future: false, option: false,
    linear: swap ? true : undefined, inverse: swap ? false : undefined,
    settle: swap ? 'USDT' : undefined, contractSize: swap ? 0.01 : undefined, precision: { price: 0.1 } };
}
function catalog(raw: Record<string, unknown>) { return { [raw.symbol as string]: raw }; }

async function rejectedRefresh(route: Route, modify: (body: Record<string, unknown>) => void, mode: MarketMode = 'polling') {
  const f = fixture(route.venue, mode);
  try {
    const spot = row(route.venue, 'spot'), swap = row(route.venue, 'swap');
    const ids = [instrumentId(route.venue, 'spot', spot.id as string), instrumentId(route.venue, 'swap', swap.id as string)];
    await f.source.setDemand(ids);
    await f.source.refreshCatalog();
    const prior = f.source.getMarkets();
    assert.equal(prior.stale, false, JSON.stringify(f.source.diagnostics()));
    assert.equal(prior.markets.length, 4); assert.ok(ids.every(id => f.source.eligible(id)));
    f.advance();
    let altered = 0;
    f.alter((url, body) => { if (matches(url, route)) { altered++; modify(body); } });
    await f.source.refreshCatalog();
    assert.equal(altered, 1, 'Actual CCXT factory must request the mutated product envelope');
    const next = f.source.getMarkets();
    assert.equal(next.stale, true); assert.equal(next.updatedAt, prior.updatedAt);
    assert.deepEqual(next.sources, [{ venue: route.venue, updatedAt: initial, stale: true, code: 'catalog_unavailable' }]);
    assert.deepEqual(next.markets, prior.markets.map(market => ({ ...market, available: false })), 'Failure preserves all prior display metadata');
    assert.ok(ids.every(id => !f.source.eligible(id)));
    assert.ok(f.source.diagnostics().instruments.every(d => d.code !== 'market_delisted'), 'Malformed response must not confirm a delisting');
    assert.equal(f.source.diagnostics().venues[0]!.clientOpen, false);
    f.alter(() => {}); f.advance(10);
    await f.source.refreshCatalog();
    assert.equal(f.source.getMarkets().stale, false, 'Valid retry recovers the venue');
    assert.equal(f.source.getMarkets().updatedAt, f.time());
    assert.deepEqual(f.source.getMarkets().markets, prior.markets);
    assert.equal(f.requests.length, 6, 'Two public products requested on initial load, failure, and retry');
  } finally { await f.source.stop(); }
}

test('actual public CCXT factory rejects missing collections for every required product', { timeout: 30000 }, async t => {
  for (const route of routes) await t.test(`${route.venue} ${route.type}`, () => rejectedRefresh(route, body => { delete body[route.field]; }));
});
test('actual public CCXT factory rejects every wrong OKX SPOT collection type and preserves prior state', { timeout: 30000 }, async t => {
  const route = routes[2];
  for (const value of [null, {}, { 0: {} }, '[]', 0, false]) await t.test(JSON.stringify(value), () => rejectedRefresh(route, body => { body.data = value; }));
});
test('actual public CCXT factory rejects wrong collection types on other product routes', { timeout: 30000 }, async t => {
  for (const route of routes.filter(route => route !== routes[2])) await t.test(`${route.venue} ${route.type}`, () => rejectedRefresh(route, body => { body[route.field] = {}; }));
});
test('Pro public factory also rejects missing OKX SPOT data before parsing', { timeout: 10000 }, () => rejectedRefresh(routes[2], body => { delete body.data; }, 'stream'));

function requiredRawFields(route: Route): string[] {
  if (route.venue === 'okx') return route.type === 'spot'
    ? ['instId', 'instType', 'state', 'baseCcy', 'quoteCcy']
    : ['instId', 'instType', 'state', 'uly', 'settleCcy'];
  if (route.venue === 'binance') return ['symbol', 'baseAsset', 'quoteAsset', 'status',
    ...(route.type === 'swap' ? ['contractType', 'marginAsset'] : [])];
  return route.type === 'spot' ? ['symbol', 'baseAsset', 'quoteAsset', 'status', 'isSpotTradingAllowed']
    : ['symbol', 'baseCoin', 'quoteCoin', 'state', 'settleCoin'];
}
function firstRawRow(route: Route, body: Record<string, unknown>): Record<string, unknown> {
  const raw = (body[route.field] as Record<string, unknown>[])[0]!;
  // Real OKX swaps leave these spot-only fields empty and derive currencies from uly.
  if (route.venue === 'okx' && route.type === 'swap') { raw.baseCcy = ''; raw.quoteCcy = ''; }
  return raw;
}
test('actual public CCXT factory rejects missing raw identity/category fields on all six products', { timeout: 60000 }, async t => {
  for (const route of routes) for (const field of requiredRawFields(route)) {
    await t.test(`${route.venue} ${route.type} missing ${field}`, () => rejectedRefresh(route, body => {
      delete firstRawRow(route, body)[field];
    }));
  }
});
test('actual public CCXT factory rejects malformed raw rows before parser exclusion', { timeout: 60000 }, async t => {
  for (const route of routes) for (const value of [null, {}, [], 'broken', 0]) {
    await t.test(`${route.venue} ${route.type} ${JSON.stringify(value)}`, () => rejectedRefresh(route, body => {
      (body[route.field] as unknown[])[0] = value;
    }));
  }
});
test('actual public CCXT factory rejects empty and wrong-type identity fields on all products', { timeout: 30000 }, async t => {
  for (const route of routes) for (const value of ['', 123, {}]) {
    await t.test(`${route.venue} ${route.type} identity ${JSON.stringify(value)}`, () => rejectedRefresh(route, body => {
      firstRawRow(route, body)[route.venue === 'okx' ? 'instId' : 'symbol'] = value;
    }));
  }
});
test('Pro public factory rejects the two silently skipped raw row reproductions', { timeout: 15000 }, async t => {
  for (const [route, field] of [[routes[2], 'instId'], [routes[4], 'baseAsset']] as const) {
    await t.test(`${route.venue} ${field}`, () => rejectedRefresh(route, body => { delete firstRawRow(route, body)[field]; }, 'stream'));
  }
});

test('actual public CCXT factory accepts explicit excluded raw products without live metadata', { timeout: 30000 }, async t => {
  for (const route of routes) {
    const excluded: Record<string, unknown>[] = route.venue === 'okx' ? [
      { instType: route.type === 'spot' ? 'SPOT' : 'SWAP', state: 'preopen' }, // documented empty-ID placeholder
      { instId: route.type === 'spot' ? 'OFF-USDT' : 'OFF-USDT-SWAP', instType: route.type === 'spot' ? 'SPOT' : 'SWAP', state: 'preopen' },
      ...(route.type === 'spot' ? [{ instId: 'OFF-USDC', instType: 'SPOT', state: 'live', baseCcy: 'OFF', quoteCcy: 'USDC' }]
        : [{ instId: 'OFF-USD-SWAP', instType: 'SWAP', state: 'live', uly: 'OFF-USD', settleCcy: 'OFF', ctType: 'inverse' }]),
    ] : route.venue === 'binance' ? [
      { symbol: 'OFFUSDT', status: 'BREAK' },
      { symbol: 'OFFUSDC', status: 'TRADING', quoteAsset: 'USDC' },
      ...(route.type === 'swap' ? [{ symbol: 'OFFUSDT_270326', status: 'TRADING', baseAsset: 'OFF', quoteAsset: 'USDT',
        contractType: 'CURRENT_QUARTER', deliveryDate: 1_800_000_000_000 },
        { symbol: 'OFFUSD', status: 'TRADING', contractType: 'PERPETUAL', baseAsset: 'OFF', quoteAsset: 'USD', marginAsset: 'OFF' }]
        : [{ symbol: 'OFFUSDT', status: 'TRADING', quoteAsset: 'USDT', permissions: ['TRD_GRP_003'] }]),
    ] : route.type === 'spot' ? [
      { symbol: 'OFFUSDT', status: '2' },
      { symbol: 'OFFUSDT', status: '1', isSpotTradingAllowed: false },
      { symbol: 'OFFUSDC', status: '1', quoteAsset: 'USDC' },
    ] : [
      { symbol: 'OFF_USDT', state: 3 },
      { symbol: 'OFF_USDC', state: 0, quoteCoin: 'USDC' },
      { symbol: 'OFF_USDT', state: 0, quoteCoin: 'USDT', settleCoin: 'OFF' },
    ];
    await t.test(`${route.venue} ${route.type}`, async () => {
      const f = fixture(route.venue);
      try {
        await f.source.refreshCatalog(); const prior = f.source.getMarkets(); assert.equal(prior.markets.length, 4);
        f.advance(); let altered = 0;
        f.alter((url, body) => { if (matches(url, route)) { altered++; (body[route.field] as unknown[]).push(...excluded); } });
        await f.source.refreshCatalog(); const next = f.source.getMarkets();
        assert.equal(altered, 1); assert.equal(next.stale, false, JSON.stringify(f.source.diagnostics()));
        assert.equal(next.updatedAt, f.time()); assert.deepEqual(next.markets, prior.markets);
        assert.ok(Array.isArray(next.sources)); assert.equal(next.sources[0]!.code, null); assert.equal(f.requests.length, 4);
      } finally { await f.source.stop(); }
    });
  }
});

test('actual parser-supported perpetual identities do not require irrelevant raw fields', { timeout: 15000 }, async t => {
  for (const route of [routes[1], routes[3]]) await t.test(route.venue, async () => {
    const f = fixture(route.venue);
    try {
      await f.source.refreshCatalog(); const prior = f.source.getMarkets();
      assert.equal(prior.stale, false); assert.equal(prior.markets.length, 4);
      f.advance();
      f.alter((url, body) => { if (matches(url, route)) {
        const raw = firstRawRow(route, body);
        if (route.venue === 'binance') raw.contractType = ''; // sentinel deliveryDate still identifies a perpetual
        else { delete raw.baseCcy; delete raw.quoteCcy; } // uly supplies the currencies
      } });
      await f.source.refreshCatalog(); const next = f.source.getMarkets();
      assert.equal(next.stale, false, JSON.stringify(f.source.diagnostics()));
      assert.equal(next.updatedAt, f.time()); assert.deepEqual(next.markets, prior.markets);
    } finally { await f.source.stop(); }
  });
});

test('explicit empty OKX SPOT collection authoritatively removes only spot markets', { timeout: 10000 }, async () => {
  const f = fixture('okx');
  try {
    await f.source.setDemand(['okx:spot:BTC-USDT', 'BTC-USDT-SWAP']);
    await f.source.refreshCatalog(); const prior = f.source.getMarkets(); assert.equal(prior.markets.length, 4);
    f.advance(); f.alter((url, body) => { if (matches(url, routes[2])) body.data = []; });
    await f.source.refreshCatalog(); const next = f.source.getMarkets();
    assert.equal(next.stale, false); assert.equal(next.updatedAt, f.time()); assert.ok(Array.isArray(next.sources)); assert.equal(next.sources[0]!.code, null);
    assert.deepEqual(next.markets, prior.markets.filter(market => market.type === 'swap'));
    assert.equal(f.source.eligible('okx:spot:BTC-USDT'), false); assert.equal(f.source.eligible('BTC-USDT-SWAP'), true);
    assert.equal(f.source.diagnostics().instruments.find(d => d.instrument === 'okx:spot:BTC-USDT')!.code, 'market_delisted');
    assert.equal(f.requests.length, 4);
  } finally { await f.source.stop(); }
});
test('explicit valid empty collections succeed for all six public products', { timeout: 20000 }, async t => {
  for (const venue of ['binance', 'okx', 'mexc'] as const) await t.test(venue, async () => {
    const f = fixture(venue);
    try {
      await f.source.refreshCatalog(); assert.equal(f.source.getMarkets().markets.length, 4);
      f.advance(); f.alter((url, body) => { const route = routes.find(route => matches(url, route)); assert.ok(route); body[route.field] = []; });
      await f.source.refreshCatalog(); const next = f.source.getMarkets();
      assert.deepEqual(next.markets, []); assert.equal(next.stale, false); assert.equal(next.updatedAt, f.time());
      assert.ok(Array.isArray(next.sources)); assert.equal(next.sources[0]!.code, null); assert.equal(f.requests.length, 4);
    } finally { await f.source.stop(); }
  });
});
test('actual OKX parser missing required spot/swap price precision rejects the snapshot', { timeout: 15000 }, async t => {
  for (const route of [routes[2], routes[3]]) await t.test(route.type, () => rejectedRefresh(route, body => {
    const data = body.data as Record<string, unknown>[];
    delete data[0]!.tickSz;
  }));
});

test('MEXC live Unicode and parenthesized codes survive actual CCXT parsing and canonical identities', { timeout: 15000 }, async t => {
  for (const mode of ['polling', 'stream'] as const) await t.test(mode, async () => {
    const f = fixture('mexc', mode);
    const bases = ['龙虾', '牛来', '哈基米', 'SPACEX(PRE)', 'OIL(USOON)', 'GOLD(XAUT)'];
    f.alter((url, body) => {
      if (!matches(url, routes[4])) return;
      const rows = body.symbols as Record<string, unknown>[];
      const template = rows[0]!;
      for (const base of bases) rows.push({ ...structuredClone(template), symbol: `${base}USDT`, baseAsset: base });
    });
    try {
      await f.source.refreshCatalog();
      const result = f.source.getMarkets();
      assert.equal(result.stale, false, JSON.stringify(f.source.diagnostics()));
      assert.equal(result.markets.length, 4 + bases.length);
      for (const base of bases) {
        const nativeId = `${base}USDT`, instrument = instrumentId('mexc', 'spot', nativeId);
        assert.equal(instrumentSchema.safeParse(instrument).success, true);
        assert.deepEqual(parseInstrumentIdentity(instrument), { venue: 'mexc', type: 'spot', nativeId });
        assert.equal(f.source.eligible(instrument), true);
        assert.equal(result.markets.find(m => m.instrument === instrument)?.symbol, `${base}/USDT`);
      }
      assert.equal(parseInstrumentIdentity('龙虾-USDT-SWAP'), null, 'Legacy OKX syntax remains unchanged');
    } finally { await f.source.stop(); }
  });
});

test('Unicode code acceptance keeps malformed and ambiguous catalog identities fail closed', () => {
  for (const code of ['BTC/ETH', 'BTC:USDT', ' BTC', 'BTC ', 'BTC\u0000', 'BTC\n', 'BTC\u202e', 'BTC\u200b', '<BTC>', 'BTC%2F', 'BTC\\ETH', '\ud800']) {
    assert.equal(currencyCodeSchema.safeParse(code).success, false, JSON.stringify(code));
    const raw = { ...row('mexc', 'spot'), base: code, id: `${code}USDT`, symbol: `${code}/USDT` };
    assert.throws(() => normalizeCatalog('mexc', catalog(raw), 4), /invalid_catalog_metadata/);
  }
  for (const id of ['BTC\u0000', 'BTC\u202e', 'BTC\u200b', 'BTC%2F', ' BTC', '<BTC>', '\ud800']) {
    assert.equal(nativeMarketIdSchema.safeParse(id).success, false, JSON.stringify(id));
  }
  const valid = { ...row('mexc', 'spot'), base: '龙虾', id: '龙虾USDT', symbol: '龙虾/USDT' };
  const canonical = instrumentId('mexc', 'spot', '龙虾USDT');
  assert.equal(parseInstrumentIdentity(canonical.toLowerCase()), null, 'Noncanonical percent encoding is rejected');
  assert.throws(() => normalizeCatalog('mexc', { ...catalog(valid), ...catalog({ ...row('mexc', 'swap'), contractSize: undefined }) }, 4), /invalid_catalog_metadata/);
});

test('catalog normalization rejects malformed supported metadata atomically for all venue products', () => {
  for (const venue of ['binance', 'okx', 'mexc'] as const) for (const type of ['spot', 'swap'] as const) {
    const valid = row(venue, type);
    assert.equal(normalizeCatalog(venue, catalog(valid), 4).size, 1);
    const patches: Record<string, unknown>[] = [
      { active: undefined }, { active: 'true' }, { id: undefined }, { id: '' }, { base: undefined }, { base: 'BTC/ETH' },
      { quote: undefined }, { type: undefined }, { type: 'invalid' }, { spot: undefined }, { swap: undefined },
      { contract: undefined }, { future: undefined }, { option: undefined }, { future: true }, { option: true },
      { type: 'future' }, { type: 'option' }, { expiry: initial },
      { expiry: 'broken' }, { strike: 'broken' }, { optionType: 'broken' }, { precision: undefined },
      { precision: {} }, { precision: { price: undefined } }, { precision: { price: 0 } }, { precision: { price: NaN } },
      { precision: { price: '0.1' } },
      ...(type === 'swap' ? [{ linear: undefined }, { inverse: undefined }, { linear: false }, { inverse: true },
        { settle: undefined }, { contractSize: undefined }, { contractSize: 0 }, { contractSize: Infinity }, { contractSize: '0.01' }]
        : [{ linear: true }, { inverse: true }, { settle: 'USDT' }, { contractSize: 1 }]),
      ...(venue === 'okx' && type === 'swap' ? [{ id: 'ETH-USDT-SWAP' }] : []),
    ];
    for (const patch of patches) assert.throws(() => normalizeCatalog(venue, catalog({ ...valid, ...patch }), 4), /invalid_catalog_metadata/, `${venue} ${type} ${JSON.stringify(patch)}`);
    assert.throws(() => normalizeCatalog(venue, catalog(valid), 3), /invalid_catalog_metadata/);
    assert.throws(() => normalizeCatalog(venue, catalog({ ...valid, precision: { price: 1.5 } }), 2), /invalid_catalog_metadata/);
    assert.equal([...normalizeCatalog(venue, catalog({ ...valid, precision: { price: 2 } }), 2).values()][0]!.tickSize, '0.01');
  }
});
test('intentionally excluded inactive/non-USDT/inverse/future/option rows need no supported precision', () => {
  const valid = row('okx', 'spot');
  const excluded = [
    { ...row('okx', 'spot'), symbol: 'OFF/USDT', active: false, precision: undefined },
    { ...row('okx', 'spot'), symbol: 'BTC/USDC', quote: 'USDC', precision: undefined },
    { ...row('okx', 'swap'), symbol: 'BTC/USD:BTC', quote: 'USD', settle: 'BTC', linear: false, inverse: true, precision: undefined },
    { ...row('okx', 'swap'), symbol: 'BTC/USDT:BTC', settle: 'BTC', linear: false, inverse: true, precision: undefined },
    { ...row('okx', 'swap'), symbol: 'BTC/USDT:USDC', settle: 'USDC', precision: undefined },
    { ...row('okx', 'swap'), symbol: 'BTC/USDT:USDT-FUTURE', type: 'future', future: true, swap: false, expiry: initial, precision: undefined },
    { ...row('okx', 'swap'), symbol: 'BTC/USDT:USDT-OPTION', type: 'option', option: true, swap: false, precision: undefined },
  ];
  const result = normalizeCatalog('okx', Object.fromEntries([valid, ...excluded].map(raw => [raw.symbol, raw])), 4);
  assert.deepEqual([...result.keys()], ['okx:spot:BTC-USDT']);
  assert.equal(normalizeCatalog('okx', {}, 4).size, 0);
  const malformed = { ...row('okx', 'swap'), precision: undefined };
  assert.throws(() => normalizeCatalog('okx', { ...catalog(valid), ...catalog(malformed) }, 4), /invalid_catalog_metadata/, 'A valid first row cannot make a partially malformed catalog authoritative');
});
