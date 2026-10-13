import test from 'node:test';
import assert from 'node:assert/strict';
import { createSQLite } from '../src/db/sqlite.js';
import { migrateApp } from '../src/db/migrations.js';
import { createRepositories } from '../src/db/repositories.js';
import { loadConfig } from '../src/config.js';
import { encryptSecret } from '../src/notifications/index.js';
import { createScheduler } from '../src/scheduler/index.js';
import { createCcxtMarketSource } from '../src/markets/source.js';
import type { CcxtExchange } from '../src/markets/source.js';

const initial = 1_700_000_000_000;
const btc = 'BTC-USDT-SWAP', eth = 'ETH-USDT-SWAP';
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function until(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i++) await new Promise<void>(done => setTimeout(done, 2));
  assert.ok(check(), 'Expected stream work to settle');
}
function metadata(base: string) {
  return { id: `${base}-USDT-SWAP`, symbol: `${base}/USDT:USDT`, type: 'swap', base, quote: 'USDT', settle: 'USDT',
    active: true, spot: false, swap: true, contract: true, future: false, option: false,
    linear: true, inverse: false, contractSize: 1, precision: { price: 0.1 } };
}
const crossing = () => [
  { id: 'high', symbol: 'BTC/USDT:USDT', price: 120, timestamp: initial, amount: 1 },
  { id: 'low', symbol: 'BTC/USDT:USDT', price: 90, timestamp: initial, amount: 1 },
];

// Actual source retirement and SQL demand hydration are used together. The extra
// BTC rule keeps one captured batch unfinished while ETH is added and removed.
test('real SQLite scheduler retains BTC 120->90 across same-venue demand additions and removals', { timeout: 10000 }, async () => {
  const db = await createSQLite(':memory:', true);
  const encryptionKey = 'cd'.repeat(32);
  const config = loadConfig({ NODE_ENV: 'test', APP_URL: 'http://localhost:3000', AUTH_SECRET: 's'.repeat(32),
    ENCRYPTION_KEY: encryptionKey, EMAIL_PROVIDER: 'console', SQLITE_PATH: ':memory:', PUSHOVER_APP_TOKEN: 'T'.repeat(30) });
  const repositories = createRepositories(db, config);
  const clients: { closed: number; watches: { symbol: string; work: ReturnType<typeof deferred<unknown>> }[] }[] = [];
  const source = createCcxtMarketSource({ mode: 'stream', venues: ['okx'], now: () => initial,
    requestTimeoutMs: 1000, closeTimeoutMs: 10, factory: (): CcxtExchange => {
      const client = { closed: 0, watches: [] as typeof clients[number]['watches'] }; clients.push(client);
      return { precisionMode: 4, has: { watchTrades: true, fetchTrades: true },
        async loadMarkets() { return Object.fromEntries(['BTC', 'ETH'].map(base => { const row = metadata(base); return [row.symbol, row]; })); },
        async fetchTrades() { assert.fail('Stream regression must never poll'); },
        watchTrades(symbol) { const work = deferred<unknown>(); client.watches.push({ symbol, work }); return work.promise; },
        async close() { client.closed++; },
      };
    } });
  const engine = createScheduler({ config, db, repositories, now: () => initial, marketSource: source,
    maxEvaluationsPerTick: 1, maxReservationsPerTick: 1,
    fetch: async () => { assert.fail('Offline regression must never access network'); },
    notifications: { async deliver() { assert.fail('Regression reserves without delivering'); },
      health: () => ({ state: 'healthy', lastSuccessAt: initial, code: null }) } });
  const createRule = async (id: string, instrument: string, threshold: number) => {
    const rule = await repositories.alerts.create('u1', { name: id, instrument, threshold, side: 'upper', enabled: true }, initial);
    await db.execute('UPDATE alerts SET id=? WHERE id=?', [id, rule.id]);
  };
  const acknowledgements: { instrument: string; prices: number[] }[] = [];
  const acknowledge = source.acknowledgeSamples;
  source.acknowledgeSamples = (instrument, samples) => {
    acknowledgements.push({ instrument, prices: samples.map(tick => tick.price) }); acknowledge(instrument, samples);
  };
  try {
    await db.execute('CREATE TABLE "user"(id TEXT PRIMARY KEY,email TEXT NOT NULL,name TEXT NOT NULL,role TEXT NOT NULL DEFAULT \'user\')');
    await db.execute('CREATE TABLE "session"(id TEXT PRIMARY KEY,user_id TEXT)');
    await migrateApp(db, initial);
    await db.execute('INSERT INTO "user"(id,email,name) VALUES(?,?,?)', ['u1', 'u1@example.com', 'u1']);
    await repositories.settings.initialize('u1', initial);
    await repositories.channels.put('u1', null, await encryptSecret(encryptionKey, 'u1', 'userKey', 'U'.repeat(30)), null, initial);
    await repositories.settings.patch('u1', 0, { enabled: true }, initial);
    await createRule('a-no-cross', btc, 200);
    await createRule('b-upper', btc, 100);
    await createRule('c-upper', btc, 100);
    // Initialize demand independently so the scheduler's first capture is 120->90.
    await source.setDemand([btc]); await source.refresh();
    const old = clients.at(-1)!;
    await until(() => old.watches.length === 1);
    old.watches[0]!.work.resolve(crossing());
    await until(() => source.samples(btc).length === 2 && old.watches.length === 2);
    await engine.tick(); // a-no-cross inspected, b and c still need the capture.
    assert.equal((await repositories.scheduler.listDue(initial, 10)).length, 0);
    assert.equal(acknowledgements.length, 0);
    const capture = source.samples(btc);
    assert.deepEqual(capture.map(tick => tick.price), [120, 90]);

    await createRule('eth-no-cross', eth, 200); engine.invalidate();
    await engine.tick(); // demand addition retires old client, then b reserves 120.
    assert.equal(old.closed, 1);
    assert.deepEqual(source.samples(btc), capture);
    assert.equal(acknowledgements.filter(ack => ack.instrument === btc).length, 0);
    assert.deepEqual((await repositories.scheduler.listDue(initial, 10)).map(event => [event.alertId, event.price]), [['b-upper', 120]]);
    old.watches[1]!.work.resolve([{ id: 'obsolete', symbol: 'BTC/USDT:USDT', price: 999, timestamp: initial, amount: 1 }]);
    await new Promise<void>(done => setTimeout(done, 5));
    assert.deepEqual(source.samples(btc), capture);
    const added = clients.at(-1)!;
    await until(() => added.watches.length === 2);

    await repositories.alerts.remove('u1', 'eth-no-cross', 0, initial); engine.invalidate();
    await engine.tick(); // demand removal retires added client, then c reserves 120.
    assert.equal(added.closed, 1);
    const events = await repositories.scheduler.listDue(initial, 10);
    assert.deepEqual(events.map(event => [event.alertId, event.price]).sort(), [['b-upper', 120], ['c-upper', 120]]);
    assert.ok(events.every(event => event.generation === 0 && event.settingsGeneration === 1 && event.channelGeneration === 0));
    assert.deepEqual(acknowledgements.filter(ack => ack.instrument === btc), [{ instrument: btc, prices: [120, 90] }]);
    assert.equal(source.samples(btc).length, 0);
    const current = clients.at(-1)!;
    await until(() => current.watches.length === 1);
    current.watches[0]!.work.resolve(crossing()); // reconnect cache replay after ACK.
    await until(() => current.watches.length === 2);
    assert.equal(source.samples(btc).length, 0);
    await engine.tick();
    assert.equal((await repositories.scheduler.listDue(initial, 10)).length, 2);
  } finally { await engine.stop(); await db.close(); }
});
