import test from 'node:test';
import assert from 'node:assert/strict';
import { createCandleService, parseCandles, TIMEFRAME_MS, CANDLE_PAGE } from '../src/markets/candles.js';
import type { CcxtExchange } from '../src/markets/source.js';
import type { Market } from '../src/contracts/domain.js';

const market: Market = { instrument: 'BTC-USDT-SWAP', venue: 'okx', type: 'swap', nativeId: 'BTC-USDT-SWAP', symbol: 'BTC/USDT:USDT', base: 'BTC', quote: 'USDT', settle: 'USDT', contractSize: 0.01, tickSize: '0.1', state: 'live', tradingViewSymbol: 'OKX:BTCUSDT.P' };

test('parseCandles drops malformed, future and boundary rows, dedupes and sorts', () => {
  const now = 10 * 60_000;
  const rows = parseCandles([
    [120_000, 2, 3, 1, 2.5, 10], [60_000, 1, 2, 0.5, 1.5, 'x'], [60_000, 1, 2, 0.5, 1.6, 4],
    [180_000, 0, 1, 1, 1, 1], [240_000, 1, 1, 1, Infinity, 1], ['300000', 1, 1, 1, 1, 1], [1.5, 1, 1, 1, 1, 1],
    [now + 120_000, 1, 1, 1, 1, 1], [540_000, 1, 1, 1, 1, 1], 'junk', [600_000, 1, 1, 1, 1, 1],
  ], 600_000, now);
  assert.deepEqual(rows, [[60_000, 1, 2, 0.5, 1.6, 4], [120_000, 2, 3, 1, 2.5, 10], [540_000, 1, 1, 1, 1, 1]]);
  assert.throws(() => parseCandles({}, 1, 1), /invalid_candles/);
});

test('candle pages request the window before the cursor, cache closed history and coalesce bursts', async () => {
  const calls: { symbol: string; timeframe: string; since: number | undefined; limit: number | undefined }[] = [];
  let clock = Date.UTC(2026, 9, 27, 12, 0, 30);
  let seeded = 0, empty = false, closed = 0;
  const exchange = {
    precisionMode: 4, has: {}, loadMarkets: async () => ({}), fetchTrades: async () => [], close: async () => { closed++; },
    seedMarket: () => { seeded++; },
    fetchOHLCV: async (symbol: string, timeframe: string, since?: number, limit?: number) => {
      calls.push({ symbol, timeframe, since, limit });
      if (empty) return [];
      const step = TIMEFRAME_MS[timeframe as '1h'];
      return Array.from({ length: limit! }, (_, i) => [since! + i * step, 1, 2, 0.5, 1.5, 1]);
    },
  } satisfies CcxtExchange;
  const service = createCandleService({ factory: () => exchange, now: () => clock });
  const hour = TIMEFRAME_MS['1h'];
  const before = Date.UTC(2023, 0, 1);
  const page = await service.get(market, '1h', before);
  assert.equal(calls[0]!.since, before - hour * CANDLE_PAGE);
  assert.equal(calls[0]!.limit, CANDLE_PAGE);
  assert.equal(calls[0]!.symbol, 'BTC/USDT:USDT');
  assert.equal(page.candles.length, CANDLE_PAGE);
  assert.ok(page.candles.every(c => c[0] < before));
  assert.equal(page.done, false);
  assert.equal(seeded, 1);
  // Closed history is immutable; much later reads stay cached.
  clock += 3_600_000;
  await service.get(market, '1h', before);
  assert.equal(calls.length, 1);
  // The latest page is shared by a burst and refreshed after a short window.
  const [a, b] = await Promise.all([service.get(market, '1m'), service.get(market, '1m')]);
  assert.equal(a, b);
  assert.equal(calls.length, 2);
  await service.get(market, '1m');
  assert.equal(calls.length, 2);
  clock += 2500;
  await service.get(market, '1m');
  assert.equal(calls.length, 3);
  // The exchange has nothing older: the client stops paging.
  empty = true;
  assert.equal((await service.get(market, '1d', Date.UTC(2015, 0, 1))).done, true);
  await service.stop();
  assert.equal(closed, 1);
  await assert.rejects(service.get(market, '1h'), /candles_stopped/);
});
