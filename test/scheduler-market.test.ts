import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createSQLite } from '../src/db/sqlite.js';
import { migrateApp } from '../src/db/migrations.js';
import { createRepositories } from '../src/db/repositories.js';
import { loadConfig } from '../src/config.js';
import { encryptSecret } from '../src/notifications/index.js';
import { createScheduler } from '../src/scheduler/index.js';
import type { SchedulerOptions } from '../src/scheduler/index.js';
import { createCcxtMarketSource } from '../src/markets/source.js';
import type { CcxtExchange, MarketSource } from '../src/markets/source.js';
import type { PriceTick, Venue } from '../src/contracts/domain.js';
import type { CatalogSnapshot } from '../src/api/ports.js';

const initial = 1_700_000_000_000, key = 'cd'.repeat(32);
const btc = 'BTC-USDT-SWAP', eth = 'binance:spot:ETHUSDT', missing = 'mexc:spot:MISSINGUSDT';
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
function mockSource(now: () => number) {
  const queues = new Map<string, PriceTick[]>(), latest = new Map<string, PriceTick>();
  const unavailable = new Set<string>();
  const calls: string[] = [], demands: string[][] = [], acknowledgements: { instrument: string; samples: readonly PriceTick[] }[] = [];
  let stopped = false;
  const catalog: CatalogSnapshot = {
    markets: [
      { instrument: btc, venue: 'okx', type: 'swap', base: 'BTC', quote: 'USDT', tickSize: '0.1', state: 'live', tradingViewSymbol: '' },
      { instrument: eth, venue: 'binance', type: 'spot', base: 'ETH', quote: 'USDT', tickSize: '0.01', state: 'live', tradingViewSymbol: '' },
    ], updatedAt: initial, stale: false,
  };
  const available = (id: string) => !stopped && !unavailable.has(id) && catalog.markets.some(m => m.instrument === id);
  const source: MarketSource = {
    mode: 'stream',
    async refreshCatalog() { calls.push('catalog'); },
    async setDemand(ids) { calls.push('demand'); demands.push([...ids]); },
    async refresh() { calls.push('refresh'); },
    getMarkets: () => catalog,
    getPrices: () => [...source.ticks().values()],
    ticks: () => new Map([...latest].filter(([id]) => available(id))),
    priceHealth: () => ({ state: unavailable.size ? 'degraded' : 'healthy', lastSuccessAt: now(), code: null }),
    lastPollAt: () => now(),
    eligible: available,
    samples: id => available(id) ? [...queues.get(id) ?? []] : [],
    drainSamples() { assert.fail('scheduler must use captured acknowledgement, never drain arrivals'); },
    acknowledgeSamples(instrument, samples) {
      acknowledgements.push({ instrument, samples });
      const captured = new Set(samples);
      queues.set(instrument, (queues.get(instrument) ?? []).filter(t => !captured.has(t)));
    },
    async stop() { calls.push('stop'); stopped = true; queues.clear(); latest.clear(); },
    diagnostics: () => ({ stopped, queued: [...queues.values()].reduce((n, q) => n + q.length, 0), queueCapacity: 4096, demandCapacity: 200, replayCapacity: 10000, venues: [], instruments: [] }),
  };
  function append(instrument: string, price: number, timestamp = now(), receivedAt = now()) {
    const tick = { instrument, price, timestamp, receivedAt };
    queues.set(instrument, [...queues.get(instrument) ?? [], tick]); latest.set(instrument, tick); return tick;
  }
  return { source, append, queues, latest, unavailable, catalog, calls, demands, acknowledgements };
}
async function fixture() {
  const db = await createSQLite(':memory:', true); let at = initial;
  await db.execute('CREATE TABLE "user"(id TEXT PRIMARY KEY,email TEXT NOT NULL,name TEXT NOT NULL,role TEXT NOT NULL DEFAULT \'user\')');
  await db.execute('CREATE TABLE "session"(id TEXT PRIMARY KEY,user_id TEXT)');
  await migrateApp(db, at);
  const config = loadConfig({ NODE_ENV: 'test', APP_URL: 'http://localhost:3000', AUTH_SECRET: 's'.repeat(32), ENCRYPTION_KEY: key, EMAIL_PROVIDER: 'console', SQLITE_PATH: ':memory:', PUSHOVER_APP_TOKEN: 'T'.repeat(30) });
  const repositories = createRepositories(db, config), now = () => at;
  for (const id of ['u1', 'u2']) {
    await db.execute('INSERT INTO "user"(id,email,name) VALUES(?,?,?)', [id, `${id}@example.com`, id]);
    await repositories.settings.initialize(id, at);
    await repositories.channels.put(id, null, await encryptSecret(key, id, 'userKey', 'U'.repeat(30)), null, at);
    await repositories.settings.patch(id, 0, { enabled: true }, at);
  }
  const feed = mockSource(now);
  const engine = (options: Partial<SchedulerOptions> = {}) => createScheduler({ config, repositories, db, now, marketSource: feed.source,
    fetch: async () => { assert.fail('unexpected network request'); },
    notifications: { deliver: async () => { assert.fail('scheduler market tests never notify'); }, health: () => ({ state: 'healthy', lastSuccessAt: at, code: null }) }, ...options });
  const rule = async (id: string, instrument = btc, threshold = 100, userId = 'u1', side: 'upper' | 'lower' = 'upper') => {
    const created = await repositories.alerts.create(userId, { name: id, instrument, threshold, enabled: true, side }, at);
    await db.execute('UPDATE alerts SET id=? WHERE id=?', [id, created.id]); return { ...created, id };
  };
  const event = async (userId: string, alertId: string) => (await repositories.outbox.listForUser(userId, 100)).items.find(v => v.alertId === alertId) ?? null;
  return { db, repositories, config, now, feed, engine, rule, event, advance(ms: number) { at += ms; } };
}

test('injected market source refreshes authoritative demand before prices, exposes mode and independent support', async () => {
  const f = await fixture(), e = f.engine();
  await f.rule('btc-1'); await f.rule('btc-2', btc, 100, 'u2'); await f.rule('eth', eth); await f.rule('missing', missing);
  const read = f.repositories.alerts.listActiveWithProfiles;
  f.repositories.alerts.listActiveWithProfiles = async (...args) => { f.feed.calls.push('rules'); return read(...args); };
  f.feed.unavailable.add(eth); f.feed.catalog.stale = true;
  f.feed.append(btc, 110);
  try {
    await e.tick();
    assert.deepEqual(f.feed.calls.slice(0, 4), ['rules', 'catalog', 'demand', 'refresh']);
    assert.deepEqual([...f.feed.demands[0]!].sort(), [btc, eth, missing].sort());
    const events = await f.repositories.scheduler.listDue(f.now(), 10);
    assert.equal(events.length, 2); assert.ok(events.every(event => event.instrument === btc));
    assert.equal(e.isInstrumentSupported(btc), true); assert.equal(e.isInstrumentSupported(eth), false);
    assert.equal(e.isInstrumentSupported(missing), false);
    assert.equal(e.status().marketMode, 'stream'); assert.equal((await e.snapshot()).marketMode, 'stream');
    assert.equal(e.getMarkets().stale, true); assert.equal(e.status().health.scheduler.code, 'active_price_missing');
    const count = f.feed.calls.length; e.status(); e.getPrices(); e.getMarkets(); assert.equal(f.feed.calls.length, count);
  } finally { await e.stop(); await f.db.close(); }
});

test('every user inspects shared high then low crossings and reserves the actual crossing price', async () => {
  const f = await fixture(), e = f.engine();
  await f.rule('upper-1'); await f.rule('upper-2', btc, 100, 'u2'); await f.rule('lower', btc, 95, 'u2', 'lower');
  f.feed.append(btc, 120); f.feed.append(btc, 90);
  try {
    await Promise.all([e.tick(), e.tick()]);
    const events = await f.repositories.scheduler.listDue(f.now(), 10);
    assert.equal(events.length, 3);
    assert.deepEqual(events.map(v => [v.alertId, v.price]).sort(), [['lower', 90], ['upper-1', 120], ['upper-2', 120]]);
    assert.equal(f.feed.acknowledgements.length, 1); assert.equal(f.feed.acknowledgements[0]!.samples.length, 2);
    assert.equal(f.feed.queues.get(btc)!.length, 0);
    await e.tick(); assert.equal((await f.repositories.scheduler.listDue(f.now(), 10)).length, 3);
  } finally { await e.stop(); await f.db.close(); }
});

test('evaluation and reservation budgets retain one instrument batch until every rule is inspected across refreshes', async () => {
  const f = await fixture(), e = f.engine({ maxEvaluationsPerTick: 2, maxReservationsPerTick: 1 });
  for (let i = 0; i < 5; i++) await f.rule(`rule-${i}`, btc, i === 0 ? 200 : 100, i % 2 ? 'u2' : 'u1');
  f.feed.append(btc, 120); f.feed.append(btc, 90);
  let attempts = 0;
  const reserve = f.repositories.alerts.reserveTrigger;
  f.repositories.alerts.reserveTrigger = async input => { attempts++; return reserve(input); };
  try {
    for (let i = 0; i < 4; i++) {
      const before = attempts; await e.tick(); assert.equal(attempts - before, 1);
      assert.equal((await f.repositories.scheduler.listDue(f.now(), 10)).length, i + 1);
      if (i < 3) { assert.equal(f.feed.acknowledgements.length, 0); assert.equal(f.feed.queues.get(btc)!.length, 2); }
      if (i === 0) { await f.repositories.alerts.remove('u1', 'rule-0', 0, f.now()); e.invalidate(); }
    }
    assert.equal(f.feed.acknowledgements.length, 1); assert.equal(f.feed.queues.get(btc)!.length, 0);
    assert.ok((await f.repositories.scheduler.listDue(f.now(), 10)).every(event => event.price === 120));
  } finally { await e.stop(); await f.db.close(); }
});

test('rule evaluation rotation reaches later instruments while an early instrument batch remains incomplete', async () => {
  const f = await fixture(), e = f.engine({ maxEvaluationsPerTick: 2 });
  for (let i = 0; i < 5; i++) await f.rule(`early-${i}`, btc, 200);
  await f.rule('late-eth', eth);
  f.feed.append(btc, 120); f.feed.append(btc, 90); f.feed.append(eth, 140); f.feed.append(eth, 80);
  try {
    await e.tick(); assert.equal(f.feed.acknowledgements.length, 0);
    e.invalidate(); await e.tick(); assert.equal(f.feed.acknowledgements.length, 0);
    e.invalidate(); await e.tick();
    assert.equal((await f.repositories.scheduler.listDue(f.now(), 10))[0]!.alertId, 'late-eth');
    assert.equal((await f.repositories.scheduler.listDue(f.now(), 10))[0]!.price, 140);
    assert.equal(f.feed.acknowledgements.length, 2);
  } finally { await e.stop(); await f.db.close(); }
});

test('arrival during reservation remains queued after captured samples are acknowledged', async () => {
  const f = await fixture(), e = f.engine(); await f.rule('first');
  f.feed.append(btc, 120); f.feed.append(btc, 90);
  const reserve = f.repositories.alerts.reserveTrigger;
  f.repositories.alerts.reserveTrigger = async input => { const reserved = await reserve(input); f.feed.append(btc, 150); f.feed.append(btc, 80); return reserved; };
  try {
    await e.tick(); assert.equal(f.feed.acknowledgements[0]!.samples.length, 2);
    assert.deepEqual(f.feed.queues.get(btc)!.map(t => t.price), [150, 80]);
    f.repositories.alerts.reserveTrigger = reserve;
    await f.rule('second', btc, 140, 'u2'); e.invalidate(); await e.tick();
    assert.equal((await f.event('u2', 'second'))!.price, 150);
    assert.equal(f.feed.queues.get(btc)!.length, 0);
  } finally { await e.stop(); await f.db.close(); }
});

test('buffered pre-edit crossings do not trigger a new generation, but latest fresh tick initializes it', async () => {
  for (const oldTimestampOnly of [false, true]) {
    const f = await fixture(), e = f.engine();
    await f.rule('edited', btc, 200); f.feed.append(btc, 80); await e.tick();
    f.advance(1000);
    const edited = await f.repositories.alerts.patch('u1', 'edited', 0, { threshold: 100 }, f.now());
    f.feed.append(btc, 150, edited.updatedAt - 1, oldTimestampOnly ? f.now() : edited.updatedAt - 1);
    f.feed.append(btc, 90); e.invalidate();
    try {
      await e.tick(); assert.equal(await f.event('u1', 'edited'), null);
      f.feed.append(btc, 110, edited.updatedAt - 1, edited.updatedAt - 1);
      await e.tick(); const event = await f.event('u1', 'edited');
      assert.equal(event!.generation, 1); assert.equal(event!.price, 110);
    } finally { await e.stop(); await f.db.close(); }
  }
});

test('settings and channel races during refresh retain post-change crossings until SQL reserves the current profile', async () => {
  for (const profile of ['settings', 'channel'] as const) for (const invalidates of [false, true]) {
    const f = await fixture(), e = f.engine(); await f.rule('profile-race');
    const oldSettings = profile === 'settings' ? (await f.repositories.settings.patch('u1', 1, { dailyLimit: 19 }, f.now())).generation : 1;
    const attempts: { settings: number; channel: number; reserved: boolean }[] = [];
    const reserve = f.repositories.alerts.reserveTrigger;
    f.repositories.alerts.reserveTrigger = async input => {
      const reserved = await reserve(input);
      attempts.push({ settings: input.settingsGeneration, channel: input.channelGeneration, reserved });
      return reserved;
    };
    let changed = false;
    f.feed.source.refresh = async () => {
      if (changed) return; changed = true;
      f.advance(1000);
      if (profile === 'settings') await f.repositories.settings.patch('u1', oldSettings, { dailyLimit: 18 }, f.now());
      else {
        const channel = (await f.repositories.channels.get('u1'))!;
        await f.repositories.channels.put('u1', channel.generation, channel.userKey, null, f.now());
      }
      if (invalidates) e.invalidate();
      f.advance(1); f.feed.append(btc, 120); f.feed.append(btc, 90);
    };
    try {
      await e.tick();
      assert.deepEqual(attempts, [{ settings: oldSettings, channel: 0, reserved: false }]);
      assert.equal(await f.event('u1', 'profile-race'), null);
      assert.equal(f.feed.acknowledgements.length, 0);
      assert.deepEqual(f.feed.queues.get(btc)!.map(t => t.price), [120, 90]);
      await e.tick();
      const settings = profile === 'settings' ? oldSettings + 1 : oldSettings, channel = profile === 'channel' ? 1 : 0;
      assert.deepEqual(attempts, [{ settings: oldSettings, channel: 0, reserved: false }, { settings, channel, reserved: true }]);
      const events = await f.repositories.scheduler.listDue(f.now(), 10);
      assert.equal(events.length, 1);
      assert.equal(events[0]!.generation, 0); assert.equal(events[0]!.settingsGeneration, settings);
      assert.equal(events[0]!.channelGeneration, channel); assert.equal(events[0]!.price, 120);
      assert.equal(f.feed.acknowledgements.length, 1); assert.equal(f.feed.queues.get(btc)!.length, 0);
      await e.tick(); assert.equal(attempts.length, 2);
      assert.equal((await f.repositories.scheduler.listDue(f.now(), 10)).length, 1);
    } finally { await e.stop(); await f.db.close(); }
  }
});

test('invalidation during refresh retains samples even when only the edited rule crosses', async () => {
  const f = await fixture(), e = f.engine(); await f.rule('new-crossing', btc, 200);
  let changed = false;
  f.feed.source.refresh = async () => {
    if (changed) return; changed = true;
    f.advance(1000); await f.repositories.alerts.patch('u1', 'new-crossing', 0, { threshold: 100 }, f.now());
    e.invalidate(); f.advance(1); f.feed.append(btc, 120); f.feed.append(btc, 90);
  };
  try {
    await e.tick(); assert.equal(await f.event('u1', 'new-crossing'), null);
    assert.equal(f.feed.acknowledgements.length, 0);
    await e.tick();
    const events = await f.repositories.scheduler.listDue(f.now(), 10);
    assert.equal(events.length, 1); assert.equal(events[0]!.generation, 1); assert.equal(events[0]!.price, 120);
    assert.equal(f.feed.acknowledgements.length, 1);
    await e.tick(); assert.equal((await f.repositories.scheduler.listDue(f.now(), 10)).length, 1);
  } finally { await e.stop(); await f.db.close(); }
});

test('SQL rejection after a rule edit revalidates next tick without replaying a pre-edit high', async () => {
  const f = await fixture(), e = f.engine(); await f.rule('rule-race');
  f.feed.append(btc, 120); f.feed.append(btc, 90);
  const reserve = f.repositories.alerts.reserveTrigger;
  const attempts: { generation: number; reserved: boolean }[] = [];
  let edited = false;
  f.repositories.alerts.reserveTrigger = async input => {
    if (!edited) {
      edited = true; f.advance(1000);
      await f.repositories.alerts.patch('u1', 'rule-race', 0, { name: 'edited' }, f.now());
    }
    const reserved = await reserve(input); attempts.push({ generation: input.generation, reserved }); return reserved;
  };
  try {
    await e.tick(); assert.deepEqual(attempts, [{ generation: 0, reserved: false }]);
    assert.equal(f.feed.acknowledgements.length, 0);
    assert.deepEqual(f.feed.queues.get(btc)!.map(t => t.price), [120, 90]);
    await e.tick(); assert.equal(await f.event('u1', 'rule-race'), null);
    assert.equal(attempts.length, 1); assert.equal(f.feed.acknowledgements.length, 1);
    f.advance(1); f.feed.append(btc, 120); f.feed.append(btc, 90); await e.tick();
    const events = await f.repositories.scheduler.listDue(f.now(), 10);
    assert.equal(events.length, 1); assert.equal(events[0]!.generation, 1); assert.equal(events[0]!.price, 120);
    assert.deepEqual(attempts, [{ generation: 0, reserved: false }, { generation: 1, reserved: true }]);
    await e.tick(); assert.equal(attempts.length, 2);
  } finally { await e.stop(); await f.db.close(); }
});

test('a committed trigger is not retried when another rule changes during its reservation', async () => {
  const f = await fixture(), e = f.engine();
  await f.rule('a-committed'); await f.rule('b-edited', btc, 200, 'u2');
  f.feed.append(btc, 120); f.feed.append(btc, 90);
  const reserve = f.repositories.alerts.reserveTrigger, attempts: string[] = [];
  f.repositories.alerts.reserveTrigger = async input => {
    attempts.push(input.alertId); const reserved = await reserve(input);
    if (input.alertId === 'a-committed' && reserved) {
      f.advance(1000); await f.repositories.alerts.patch('u2', 'b-edited', 0, { threshold: 100 }, f.now());
      e.invalidate(); f.advance(1); f.feed.append(btc, 130); f.feed.append(btc, 90);
    }
    return reserved;
  };
  try {
    await e.tick(); assert.equal(f.feed.acknowledgements.length, 0);
    await e.tick(); assert.equal(f.feed.acknowledgements.length, 1);
    assert.equal(await f.event('u2', 'b-edited'), null);
    await e.tick();
    const events = await f.repositories.scheduler.listDue(f.now(), 10);
    assert.deepEqual(events.map(v => [v.alertId, v.generation, v.price]).sort(), [['a-committed', 0, 120], ['b-edited', 1, 130]]);
    await e.tick(); assert.deepEqual(attempts, ['a-committed', 'b-edited']);
  } finally { await e.stop(); await f.db.close(); }
});

test('rule edits during an unfinished batch require inspection of the new generation', async () => {
  const f = await fixture(), e = f.engine({ maxEvaluationsPerTick: 1 });
  await f.rule('a', btc, 200); await f.rule('b', btc, 200);
  f.feed.append(btc, 150); f.feed.append(btc, 90);
  try {
    await e.tick(); assert.equal(f.feed.acknowledgements.length, 0);
    f.advance(1000); await f.repositories.alerts.patch('u1', 'a', 0, { threshold: 100 }, f.now()); e.invalidate();
    await e.tick(); assert.equal(f.feed.acknowledgements.length, 0);
    await e.tick(); assert.equal(f.feed.acknowledgements.length, 1);
    assert.equal(await f.event('u1', 'a'), null);
  } finally { await e.stop(); await f.db.close(); }
});

test('deadline interruption keeps the rule cursor and unacknowledged samples for the next cycle', async () => {
  const f = await fixture(), e = f.engine(); await f.rule('deadline');
  for (let i = 0; i < 6; i++) f.feed.append(btc, 90);
  f.feed.append(btc, 120); f.feed.append(btc, 80);
  let clock = 0;
  const performanceMock = mock.method(performance, 'now', () => { clock += 1000; return clock; });
  try {
    await e.tick();
    assert.equal(await f.event('u1', 'deadline'), null);
    assert.equal(f.feed.acknowledgements.length, 0); assert.equal(e.status().health.scheduler.code, 'cycle_budget_exceeded');
    for (let i = 0; i < 8 && !await f.event('u1', 'deadline'); i++) await e.tick();
    assert.equal((await f.event('u1', 'deadline'))!.price, 120);
    assert.equal(f.feed.acknowledgements.length, 1);
  } finally { performanceMock.mock.restore(); await e.stop(); await f.db.close(); }
});

test('source retirement discards old captured crossings and lets replacement samples reach already inspected rules', async () => {
  const f = await fixture(), e = f.engine({ maxEvaluationsPerTick: 1 });
  await f.rule('a', btc, 200); await f.rule('b', btc, 100, 'u2');
  f.feed.append(btc, 150); f.feed.append(btc, 90);
  try {
    await e.tick(); assert.equal(f.feed.acknowledgements.length, 0);
    f.feed.queues.set(btc, []); f.feed.latest.delete(btc);
    f.feed.append(btc, 250); f.feed.append(btc, 80);
    await e.tick(); assert.equal((await f.event('u2', 'b'))!.price, 250);
    assert.equal(f.feed.acknowledgements.length, 0);
    await e.tick(); assert.equal((await f.event('u1', 'a'))!.price, 250);
    assert.equal(f.feed.acknowledgements.length, 1);
  } finally { await e.stop(); await f.db.close(); }
});

test('lost lease after source refresh produces no reservation or acknowledgement', async () => {
  const f = await fixture(), e = f.engine(); await f.rule('leased');
  let attempts = 0;
  const reserve = f.repositories.alerts.reserveTrigger;
  f.repositories.alerts.reserveTrigger = async input => { attempts++; return reserve(input); };
  f.feed.source.refresh = async () => { f.feed.append(btc, 120); f.advance(21000); await f.db.execute("UPDATE scheduler_lease SET owner_id='other',fence=fence+1"); };
  try {
    await e.tick(); assert.equal(attempts, 0); assert.equal(f.feed.acknowledgements.length, 0);
    assert.equal(e.status().leaseFence, null); assert.equal(e.status().health.scheduler.code, 'lease_lost');
  } finally { await e.stop(); await f.db.close(); }
});

function metadata(venue: Venue, base = 'BTC') {
  return { id: venue === 'okx' ? `${base}-USDT-SWAP` : `${base}USDT`, symbol: `${base}/USDT:USDT`, type: 'swap', base, quote: 'USDT', settle: 'USDT',
    active: true, spot: false, swap: true, contract: true, future: false, option: false, linear: true, inverse: false, contractSize: 1, precision: { price: 0.1 } };
}
function exchange(options: { trades?: unknown; failCatalog?: boolean; hangClose?: boolean } = {}): CcxtExchange & { closed: number } {
  return { precisionMode: 4, has: { fetchTrades: true, watchTrades: true }, closed: 0,
    async loadMarkets() { if (options.failCatalog) throw new Error('mock_outage'); const m = metadata('okx'); return { [m.symbol]: m }; },
    async fetchTrades() { return options.trades ?? []; },
    watchTrades: () => new Promise(() => {}),
    async close() { this.closed++; if (options.hangClose) return new Promise(() => {}); },
  };
}

test('real polling source samples the latest trade with SQL reservation bounds and healthy venue isolation', async () => {
  const f = await fixture();
  const page = { trades: [{ id: 'high', symbol: 'BTC/USDT:USDT', price: 120, timestamp: initial, amount: 1 }, { id: 'low', symbol: 'BTC/USDT:USDT', price: 90, timestamp: initial + 1, amount: 1 }] };
  const healthy = exchange(page), unhealthy = exchange({ failCatalog: true });
  const source = createCcxtMarketSource({ mode: 'polling', now: f.now, venues: ['okx', 'mexc'], requestTimeoutMs: 100, closeTimeoutMs: 10,
    factory: venue => venue === 'okx' ? healthy : unhealthy });
  const e = f.engine({ marketSource: source, maxReservationsPerTick: 1 });
  await f.rule('one'); await f.rule('two', btc, 100, 'u2'); await f.rule('unavailable', missing);
  try {
    await e.tick(); assert.equal((await f.repositories.scheduler.listDue(f.now(), 10)).length, 0);
    assert.equal(e.getPrices().find(t => t.instrument === btc)!.price, 90);
    assert.equal(source.samples(btc).length, 0); assert.equal(e.getMarkets().stale, true);
    assert.equal(e.isInstrumentSupported(btc), true); assert.equal(e.isInstrumentSupported(missing), false);
    assert.equal(e.status().marketMode, 'polling'); assert.equal(e.status().health.scheduler.code, 'active_price_missing');
    f.advance(5000);
    // Response order need not be chronological: the newest timestamp wins.
    page.trades = [{ id: 'next-high', symbol: 'BTC/USDT:USDT', price: 130, timestamp: f.now(), amount: 1 }, { id: 'older-low', symbol: 'BTC/USDT:USDT', price: 80, timestamp: f.now() - 1, amount: 1 }];
    await e.tick(); assert.equal((await f.repositories.scheduler.listDue(f.now(), 10)).length, 1);
    assert.deepEqual(source.samples(btc).map(t => t.price), [130]);
    await e.tick(); assert.equal(source.samples(btc).length, 0);
    const events = await f.repositories.scheduler.listDue(f.now(), 10);
    assert.deepEqual(events.map(event => [event.alertId, event.price]).sort(), [['one', 130], ['two', 130]]);
    assert.equal(await f.event('u1', 'unavailable'), null);
  } finally { await e.stop(); assert.equal(source.diagnostics().stopped, true); await f.db.close(); }
});

test('real stream source high then low in one accepted batch reaches every user without latest-price loss', async () => {
  const f = await fixture(), watches: ReturnType<typeof deferred<unknown>>[] = [];
  const source = createCcxtMarketSource({ mode: 'stream', now: f.now, venues: ['okx'], requestTimeoutMs: 1000, closeTimeoutMs: 10,
    factory: () => ({ ...exchange(), watchTrades() { const next = deferred<unknown>(); watches.push(next); return next.promise; } }) });
  const e = f.engine({ marketSource: source, maxReservationsPerTick: 1 });
  await f.rule('stream-one'); await f.rule('stream-two', btc, 100, 'u2');
  try {
    await e.tick(); assert.equal(watches.length, 1);
    watches[0]!.resolve([{ id: 'high', symbol: 'BTC/USDT:USDT', price: 130, timestamp: initial, amount: 1 }, { id: 'low', symbol: 'BTC/USDT:USDT', price: 90, timestamp: initial, amount: 1 }]);
    for (let i = 0; i < 30 && source.samples(btc).length < 2; i++) await new Promise(r => setTimeout(r, 1));
    assert.equal(source.samples(btc).length, 2); assert.equal(source.ticks().get(btc)!.price, 90);
    await e.tick(); assert.equal(source.samples(btc).length, 2);
    await e.tick(); assert.equal(source.samples(btc).length, 0);
    const events = await f.repositories.scheduler.listDue(f.now(), 10);
    assert.equal(events.length, 2); assert.ok(events.every(event => event.price === 130));
    assert.equal(e.status().marketMode, 'stream');
  } finally { await e.stop(); await f.db.close(); }
});

test('stop cancels source refresh before releasing the lease, coalesces and never restarts the stopped source', async () => {
  const f = await fixture(), e = f.engine(); await f.rule('shutdown');
  const entered = deferred<void>(), cancelled = deferred<void>(), closed = deferred<void>();
  f.feed.source.refresh = async () => { entered.resolve(); await cancelled.promise; };
  const stop = f.feed.source.stop;
  f.feed.source.stop = async () => { cancelled.resolve(); await closed.promise; await stop(); };
  const release = f.repositories.scheduler.releaseLease; let releases = 0;
  f.repositories.scheduler.releaseLease = async (...args) => { assert.ok(f.feed.calls.includes('stop')); releases++; await release(...args); };
  const running = e.tick(); await entered.promise;
  try {
    const stopping = e.stop(); assert.equal(e.stop(), stopping);
    await running; assert.equal(releases, 0); closed.resolve(); await stopping;
    assert.equal(releases, 1); assert.equal(e.status().running, false);
    assert.equal(await f.event('u1', 'shutdown'), null);
    const count = f.feed.calls.length; e.start(); await e.tick(); assert.equal(f.feed.calls.length, count);
  } finally { closed.resolve(); await e.stop(); await f.db.close(); }
});

test('real stream teardown bounds an uncooperative close and releases SQL lease after closing exchanges', async () => {
  const f = await fixture(), clients: ReturnType<typeof exchange>[] = [];
  const source = createCcxtMarketSource({ mode: 'stream', now: f.now, venues: ['okx'], requestTimeoutMs: 1000, closeTimeoutMs: 15,
    factory: () => { const client = exchange({ hangClose: true }); clients.push(client); return client; } });
  const e = f.engine({ marketSource: source }); await f.rule('stream');
  try {
    await e.tick(); const started = performance.now(); await e.stop();
    assert.ok(performance.now() - started < 1000); assert.ok(clients.every(client => client.closed === 1));
    assert.equal(source.diagnostics().stopped, true); assert.equal(e.status().leaseFence, null);
    const leases = await f.db.query<{ expires_at: number }>('SELECT expires_at FROM scheduler_lease');
    assert.ok(leases[0]!.expires_at <= f.now());
  } finally { await e.stop(); await f.db.close(); }
});
