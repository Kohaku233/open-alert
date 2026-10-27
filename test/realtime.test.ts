import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { createSQLite } from '../src/db/sqlite.js';
import { migrateApp } from '../src/db/migrations.js';
import { createRepositories } from '../src/db/repositories.js';
import { loadConfig } from '../src/config.js';
import { encryptSecret } from '../src/notifications/index.js';
import { createScheduler } from '../src/scheduler/index.js';
import { createCcxtMarketSource } from '../src/markets/source.js';
import type { CcxtExchange, MarketSource } from '../src/markets/source.js';
import { createLiveQuoteHub } from '../src/markets/live-quotes.js';
import { createRealtimeGateway, REALTIME_PATH } from '../src/runtime/realtime.js';
import type { Market, PriceTick } from '../src/contracts/domain.js';
import type { MarketQuote } from '../src/markets/quotes.js';

const key = 'cd'.repeat(32), btc = 'BTC-USDT-SWAP';
const pause = (ms = 5) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean, ms = 1000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (check()) return; await pause(); }
  assert.ok(check(), 'condition must become true');
}
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
const btcMarket: Market = { instrument: btc, venue: 'okx', type: 'swap', nativeId: 'BTC-USDT-SWAP', symbol: 'BTC/USDT:USDT', base: 'BTC', quote: 'USDT',
  settle: 'USDT', contractSize: 0.01, tickSize: '0.1', state: 'live', tradingViewSymbol: 'OKX:BTCUSDT.P' } as Market;

test('stream source notifies listeners synchronously after accepting fresh trades', async () => {
  const watches: ReturnType<typeof deferred<unknown>>[] = [];
  const raw = { 'BTC/USDT:USDT': { id: 'BTC-USDT-SWAP', symbol: 'BTC/USDT:USDT', type: 'swap', base: 'BTC', quote: 'USDT', active: true, spot: false, swap: true,
    contract: true, future: false, option: false, linear: true, inverse: false, settle: 'USDT', contractSize: 0.01, precision: { price: 0.1 } } };
  const exchange: CcxtExchange = { precisionMode: 4, has: { watchTrades: true, fetchTrades: true }, loadMarkets: async () => raw,
    fetchTrades: async () => [], watchTrades: () => { const d = deferred<unknown>(); watches.push(d); return d.promise; }, close: async () => {} };
  const source = createCcxtMarketSource({ mode: 'stream', venues: ['okx'], factory: () => exchange, closeTimeoutMs: 10 });
  const seen: string[] = [];
  const off = source.onSamples!(id => { seen.push(id); assert.equal(source.samples(id).length, 1, 'samples must be queued before the listener runs'); });
  try {
    await source.setDemand([btc]); await source.refresh();
    await until(() => watches.length === 1);
    watches[0]!.resolve([{ id: '1', symbol: 'BTC/USDT:USDT', price: 101, amount: 1, side: 'buy', timestamp: Date.now() }]);
    await until(() => seen.length === 1);
    assert.deepEqual(seen, [btc]);
    off();
    await until(() => watches.length === 2);
    watches[1]!.resolve([{ id: '2', symbol: 'BTC/USDT:USDT', price: 102, amount: 1, side: 'buy', timestamp: Date.now() }]);
    await until(() => source.samples(btc).length === 2);
    assert.equal(seen.length, 1, 'unsubscribed listener is not called');
  } finally { await source.stop(); }
});

test('scheduler evaluates and delivers on stream arrival without waiting for the poll timer', async () => {
  const db = await createSQLite(':memory:', true);
  await db.execute('CREATE TABLE "user"(id TEXT PRIMARY KEY,email TEXT NOT NULL,name TEXT NOT NULL,role TEXT NOT NULL DEFAULT \'user\')');
  await db.execute('CREATE TABLE "session"(id TEXT PRIMARY KEY,user_id TEXT)');
  await migrateApp(db, Date.now());
  const config = loadConfig({ NODE_ENV: 'test', APP_URL: 'http://localhost:3000', AUTH_SECRET: 's'.repeat(32), ENCRYPTION_KEY: key, EMAIL_PROVIDER: 'console', SQLITE_PATH: ':memory:', PUSHOVER_APP_TOKEN: 'T'.repeat(30) });
  const repositories = createRepositories(db, config);
  await db.execute('INSERT INTO "user"(id,email,name) VALUES(?,?,?)', ['u1', 'u1@example.com', 'u1']);
  await repositories.settings.initialize('u1', Date.now());
  await repositories.channels.put('u1', null, await encryptSecret(key, 'u1', 'userKey', 'U'.repeat(30)), null, Date.now());
  await repositories.settings.patch('u1', 0, { enabled: true }, Date.now());
  await repositories.alerts.create('u1', { name: 'up', instrument: btc, threshold: 100, enabled: true, side: 'upper' }, Date.now() - 1000);

  const queue: PriceTick[] = []; let latest: PriceTick | null = null;
  const hook: { listener: ((id: string) => void) | null } = { listener: null };
  const source: MarketSource = {
    mode: 'stream', async refreshCatalog() {}, async setDemand() {}, async refresh() {}, async stop() {},
    getMarkets: () => ({ markets: [btcMarket], updatedAt: Date.now(), stale: false }),
    getPrices: () => latest ? [latest] : [], ticks: () => new Map(latest ? [[btc, latest]] : []),
    priceHealth: () => ({ state: 'healthy', lastSuccessAt: Date.now(), code: null }), lastPollAt: () => Date.now(),
    eligible: id => id === btc, samples: id => id === btc ? [...queue] : [],
    drainSamples: () => [], acknowledgeSamples(_id, captured) { for (const t of captured) { const i = queue.indexOf(t); if (i >= 0) queue.splice(i, 1); } },
    diagnostics: () => ({ stopped: false, queued: queue.length, queueCapacity: 4096, demandCapacity: 200, replayCapacity: 10000, venues: [], instruments: [] }),
    onSamples(l) { hook.listener = l; return () => { hook.listener = null; }; },
  };
  const delivered: number[] = [], activity: string[] = [];
  const engine = createScheduler({ config, repositories, db, marketSource: source, onUserActivity: id => activity.push(id),
    notifications: { deliver: async () => { delivered.push(Date.now()); return { outcome: 'sent', code: null, receipt: null }; }, health: () => ({ state: 'healthy', lastSuccessAt: Date.now(), code: null }) } });
  try {
    engine.start();
    await pause(100); // initial background cycle: no crossing yet
    assert.equal(delivered.length, 0); assert.ok(hook.listener, 'scheduler subscribes to stream arrivals');
    const arrival = Date.now();
    const tick = { instrument: btc, price: 120, timestamp: arrival, receivedAt: arrival };
    queue.push(tick); latest = tick; hook.listener!(btc);
    await until(() => delivered.length === 1, 2000);
    // The poll timer is 5 s; an event-driven path finishes far sooner.
    assert.ok(delivered[0]! - arrival < 1000, `delivery took ${delivered[0]! - arrival} ms`);
    await until(() => activity.length >= 2);
    assert.deepEqual([...new Set(activity)], ['u1'], 'reservation and delivery result notify the owner');
  } finally { await engine.stop(); await db.close(); }
  assert.equal(hook.listener, null, 'stop unsubscribes from the source');
});

function hubFixture() {
  const watches: ReturnType<typeof deferred<unknown>>[] = []; const unwatched: string[] = []; let closed = 0, created = 0;
  const exchange: CcxtExchange = { precisionMode: 4, has: { watchTrades: true }, loadMarkets: async () => ({}), fetchTrades: async () => [],
    seedMarket: () => {}, watchTrades: () => { const d = deferred<unknown>(); watches.push(d); return d.promise; },
    unWatchTrades: async symbol => { unwatched.push(symbol); }, close: async () => { closed++; } };
  const hub = createLiveQuoteHub({ factory: () => { created++; return exchange; }, minIntervalMs: 0, quietRefreshMs: 60_000 });
  return { hub, watches, unwatched, closed: () => closed, created: () => created };
}

test('live hub shares one exchange stream per instrument and unsubscribes after the last viewer', async () => {
  const f = hubFixture(); const a: MarketQuote[] = [], b: MarketQuote[] = [];
  const offA = f.hub.subscribe(btcMarket, q => a.push(q));
  const offB = f.hub.subscribe(btcMarket, q => b.push(q));
  await until(() => f.watches.length === 1);
  assert.equal(f.hub.instruments(), 1); assert.equal(f.created(), 1);
  const ts = Date.now();
  f.watches[0]!.resolve([{ symbol: 'BTC/USDT:USDT', price: 100, timestamp: ts - 5 }, { symbol: 'BTC/USDT:USDT', price: 101, timestamp: ts }, { symbol: 'ETH/USDT:USDT', price: 9, timestamp: ts }]);
  await until(() => a.length === 1 && b.length === 1);
  assert.equal(a[0]!.price, 101, 'newest matching trade wins'); assert.equal(a[0]!.timestamp, ts);
  await until(() => f.watches.length === 2);
  f.watches[1]!.resolve([{ symbol: 'BTC/USDT:USDT', price: 99, timestamp: ts - 100 }]);
  await pause(20);
  assert.equal(a.length, 1, 'an older exchange timestamp never moves the display backwards');
  // Late joiner gets the cached latest immediately.
  const c: MarketQuote[] = []; const offC = f.hub.subscribe(btcMarket, q => c.push(q)); assert.equal(c[0]?.price, 101);
  offA(); offC(); assert.equal(f.unwatched.length, 0);
  offB(); await until(() => f.unwatched.length === 1);
  assert.deepEqual(f.unwatched, ['BTC/USDT:USDT']); assert.equal(f.hub.instruments(), 0);
  await f.hub.stop(); assert.equal(f.closed(), 1);
});

test('realtime gateway enforces origin and session, pushes quotes and alert changes, and releases on close', async () => {
  let listener: ((q: MarketQuote) => void) | null = null, released = 0;
  const hub = { subscribe: (_m: Market, l: (q: MarketQuote) => void) => { listener = l; return () => { released++; listener = null; }; }, instruments: () => (listener ? 1 : 0), stop: async () => {} };
  const gateway = createRealtimeGateway({ trustedOrigins: ['http://app.test'], hub,
    authenticate: async request => request.headers.get('cookie') === 'session=ok' ? { userId: 'u1', role: 'user', sessionId: 's1' } : null,
    resolve: async instrument => instrument === btc ? { market: btcMarket, stale: false, available: true } : { market: null, stale: false, available: false } });
  const server = createServer((_req, res) => { res.statusCode = 404; res.end(); });
  server.on('upgrade', (req, socket, head) => gateway.handleUpgrade(req, socket, head));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}${REALTIME_PATH}`;
  const status = (headers: Record<string, string>) => new Promise<number>(resolve => {
    const ws = new WebSocket(url, { headers });
    ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0)); ws.on('open', () => { ws.close(); resolve(101); }); ws.on('error', () => {});
  });
  try {
    assert.equal(await status({ cookie: 'session=ok' }), 403, 'missing Origin');
    assert.equal(await status({ origin: 'http://evil.test', cookie: 'session=ok' }), 403, 'cross-site Origin');
    assert.equal(await status({ origin: 'http://app.test' }), 401, 'no session');
    const ws = new WebSocket(url, { headers: { origin: 'http://app.test', cookie: 'session=ok' } });
    const frames: Record<string, unknown>[] = [];
    ws.on('message', data => frames.push(JSON.parse(String(data))));
    await until(() => frames.some(f => f.type === 'ready'));
    ws.send(JSON.stringify({ type: 'subscribe', instrument: 'okx:spot:NOPE' }));
    await until(() => frames.some(f => f.type === 'quote_error'));
    ws.send(JSON.stringify({ type: 'subscribe', instrument: btc }));
    await until(() => listener !== null);
    listener!({ instrument: btc, price: 123, timestamp: Date.now(), observedAt: Date.now() });
    await until(() => frames.some(f => f.type === 'quote'));
    gateway.notifyUser('u2'); gateway.notifyUser('u1');
    await until(() => frames.some(f => f.type === 'changed'));
    assert.equal(frames.filter(f => f.type === 'changed').length, 1, 'only the owner is notified');
    ws.close(); await until(() => released === 1);
    assert.equal(gateway.connections(), 0);
  } finally { await gateway.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
