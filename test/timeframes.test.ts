import test from 'node:test';
import assert from 'node:assert/strict';
import { bucketEnd, bucketStart, parseTimeframe, timeframeLabel, timeframeMs, timeframePlan, timeframeSupported } from '../src/contracts/timeframes.js';
import { aggregateCandles, createCandleService, type Candle } from '../src/markets/candles.js';
import type { CcxtExchange } from '../src/markets/source.js';
import type { Market } from '../src/contracts/domain.js';
import { anomalyNotification, createAnomalyStore, DEFAULT_ANOMALY_SETTINGS, ensureAnomalySchema } from '../src/anomaly/store.js';
import { createSQLite } from '../src/db/sqlite.js';

const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;

test('parseTimeframe accepts TradingView-style input and normalises it', () => {
  const cases: [string, string | null][] = [
    ['7', '7m'], ['7m', '7m'], ['90', '90m'], ['60', '1h'], ['2H', '2h'], ['h', '1h'], ['D', '1d'], ['24h', '1d'], ['7d', '1w'],
    ['3d', '3d'], ['w', '1w'], [' 45 ', '45m'], ['1440', '1d'],
    ['', null], ['0', null], ['1M', null], ['1441m', null], ['9w', null], ['abc', null], ['1.5h', null], ['-5', null], ['61d', null],
  ];
  for (const [input, expected] of cases) assert.equal(parseTimeframe(input), expected, input);
  assert.equal(timeframeMs('90m'), 90 * MIN);
  assert.equal(timeframeLabel('4h'), '4H');
  assert.equal(timeframeLabel('15m'), '15m');
});

test('buckets restart at UTC midnight intraday, weeks open on Monday', () => {
  const day = Date.UTC(2026, 9, 28);
  // 7m: the last bucket of the day is cut short at midnight.
  const late = day + DAY - 1;
  assert.equal(bucketStart(late, '7m'), day + Math.floor((DAY - 1) / (7 * MIN)) * 7 * MIN);
  assert.equal(bucketEnd(bucketStart(late, '7m'), '7m'), day + DAY);
  assert.equal(bucketStart(day + 5 * HOUR + 30 * MIN, '4h'), day + 4 * HOUR);
  const monday = Date.UTC(2026, 9, 26);
  assert.equal(new Date(bucketStart(day, '1w')).getUTCDay(), 1);
  assert.equal(bucketStart(day, '1w'), monday);
  assert.equal(bucketEnd(monday, '1w'), monday + 7 * DAY);
});

test('timeframePlan picks the largest native divisor and rejects oversized derivations', () => {
  assert.deepEqual(timeframePlan('binance', 'swap', '4h'), { base: '4h', factor: 1 });
  assert.deepEqual(timeframePlan('binance', 'swap', '7m'), { base: '1m', factor: 7 });
  assert.deepEqual(timeframePlan('binance', 'swap', '3d'), { base: '1d', factor: 3 });
  assert.deepEqual(timeframePlan('mexc', 'spot', '2h'), { base: '1h', factor: 2 });
  assert.deepEqual(timeframePlan('okx', 'swap', '8h'), { base: '4h', factor: 2 });
  assert.deepEqual(timeframePlan('okx', 'swap', '2w'), { base: '1w', factor: 2 });
  assert.equal(timeframeSupported('binance', 'swap', '1d'), true);
  // 23h is built from 1h bars.
  assert.deepEqual(timeframePlan('binance', 'swap', '23h'), { base: '1h', factor: 23 });
  // 1439m can only come from 1m bars: 1439 bars per candle exceeds the read budget.
  assert.equal(timeframeSupported('binance', 'swap', '1439m'), false);
});

test('aggregateCandles folds base bars into requested buckets', () => {
  const day = Date.UTC(2026, 9, 28);
  const rows: Candle[] = [[day, 1, 2, 0.5, 1.5, 1], [day + MIN, 1.5, 3, 1, 2, 2], [day + 2 * MIN, 2, 2.5, 0.2, 1, 3], [day + 3 * MIN, 1, 1, 1, 1, 4]];
  assert.deepEqual(aggregateCandles(rows, '3m'), [[day, 1, 3, 0.2, 1, 6], [day + 3 * MIN, 1, 1, 1, 1, 4]]);
});

test('derived timeframes fetch native bars forward and aggregate them', async () => {
  const market: Market = { instrument: 'BTC-USDT-SWAP', venue: 'okx', type: 'swap', nativeId: 'BTC-USDT-SWAP', symbol: 'BTC/USDT:USDT', base: 'BTC', quote: 'USDT', settle: 'USDT', contractSize: 0.01, tickSize: '0.1', state: 'live', tradingViewSymbol: 'OKX:BTCUSDT.P' };
  const calls: { timeframe: string; since: number | undefined; limit: number | undefined }[] = [];
  const exchange = {
    precisionMode: 4, has: {}, loadMarkets: async () => ({}), fetchTrades: async () => [], close: async () => {},
    fetchOHLCV: async (_symbol: string, timeframe: string, since?: number, limit?: number) => {
      calls.push({ timeframe, since, limit });
      return Array.from({ length: limit! }, (_, i) => [since! + i * MIN, 1, 2, 0.5, 1.5, 1]);
    },
  } satisfies CcxtExchange;
  const before = Date.UTC(2026, 0, 1);
  const page = await createCandleService({ factory: () => exchange, now: () => Date.UTC(2026, 9, 28) }).get(market, '7m', before);
  assert.ok(calls.every(c => c.timeframe === '1m' && c.limit! <= 300));
  assert.ok(calls.length > 1);
  assert.ok(page.candles.length > 200 && page.candles.length <= 257);
  assert.ok(page.candles.every(c => c[0] < before && c[0] === bucketStart(c[0], '7m')));
  assert.equal(page.candles.at(-2)![5], 7);
});

test('favourites round-trip per user and anomaly pushes follow or override the price-alert profile', async () => {
  const db = await createSQLite(':memory:', true);
  try {
    await db.execute('CREATE TABLE "user" (id TEXT PRIMARY KEY)'); await db.execute('CREATE TABLE user_settings (user_id TEXT PRIMARY KEY, disabled INTEGER NOT NULL DEFAULT 0)');
    for (const id of ['u1', 'u2']) await db.execute('INSERT INTO "user"(id) VALUES(?)', [id]);
    // A database created before the profile column still upgrades in place.
    await db.execute('CREATE TABLE anomaly_settings (user_id TEXT PRIMARY KEY REFERENCES "user"(id), enabled INTEGER NOT NULL, crypto INTEGER NOT NULL, tradfi INTEGER NOT NULL, min_move_crypto REAL NOT NULL, min_move_tradfi REAL NOT NULL, priority INTEGER NOT NULL, daily_limit INTEGER NOT NULL, generation INTEGER NOT NULL, updated_at INTEGER NOT NULL)');
    await ensureAnomalySchema(db); await ensureAnomalySchema(db);
    const store = createAnomalyStore(db);
    assert.deepEqual(await store.favorites('u1'), []);
    await store.setFavorites('u1', [{ base: 'BTC', preferred: 'BTC-USDT-SWAP' }, { base: 'NVDA', preferred: null }]);
    await store.setFavorites('u2', [{ base: 'ETH', preferred: null }]);
    assert.deepEqual(await store.favorites('u1'), [{ base: 'BTC', preferred: 'BTC-USDT-SWAP' }, { base: 'NVDA', preferred: null }]);
    assert.deepEqual(await store.setFavorites('u1', [{ base: 'NVDA', preferred: null }, { base: 'BTC', preferred: null }]), [{ base: 'NVDA', preferred: null }, { base: 'BTC', preferred: null }]);
    assert.deepEqual(await store.favorites('u2'), [{ base: 'ETH', preferred: null }]);

    const price = { priority: 2, retry: 30, expire: 1500, sound: 'siren' };
    assert.deepEqual(anomalyNotification({ ...DEFAULT_ANOMALY_SETTINGS }, price), { ...price, priority: 1 });
    const own = { priority: 0, retry: 60, expire: 600, sound: 'pushover' };
    const saved = await store.patchSettings('u1', 0, { notification: own }, 1);
    assert.deepEqual(saved.settings.notification, own);
    assert.equal(saved.settings.priority, 0);
    const read = await store.getSettings('u1');
    assert.deepEqual(anomalyNotification(read.settings, price), own);
    // Silent profiles keep the legacy column inside its range.
    assert.equal((await store.patchSettings('u1', 1, { notification: { ...own, priority: -2 } }, 2)).settings.priority, -1);
    const back = await store.patchSettings('u1', 2, { notification: null }, 3);
    assert.equal(back.settings.notification, null);
    assert.deepEqual(anomalyNotification((await store.getSettings('u1')).settings, price).sound, 'siren');
  } finally { await db.close(); }
});
