import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMarketQuoteService } from '../src/markets/quotes.js';
import { normalizeMarket } from '../src/markets/normalize.js';
import type { Venue, MarketType } from '../src/contracts/domain.js';
import type { ExchangeFactory } from '../src/markets/source.js';

function raw(venue: Venue, type: MarketType, base = 'BTC') {
  return { id: venue === 'okx' ? `${base}-USDT${type === 'swap' ? '-SWAP' : ''}` : venue === 'mexc' && type === 'swap' ? `${base}_USDT` : `${base}USDT`,
    symbol: `${base}/USDT${type === 'swap' ? ':USDT' : ''}`, base, quote: 'USDT', type, active: true,
    spot: type === 'spot', swap: type === 'swap', future: false, option: false, contract: type === 'swap',
    linear: type === 'swap', inverse: false, settle: type === 'swap' ? 'USDT' : null,
    contractSize: type === 'swap' ? 1 : null, precision: { price: 0.1 } };
}
function fixture() {
  let now = 1700000000000, calls = 0, loads = 0, closes = 0, failure = false;
  let override: Record<string, unknown> = {};
  const factory: ExchangeFactory = (venue, settings) => {
    assert.equal(settings.mode, 'polling');
    const row = raw(venue, settings.product!);
    return { precisionMode: 4, has: {}, loadMarkets: async () => { loads++; return { [row.symbol]: row }; },
      fetchTrades: async symbol => { calls++; if (failure) throw new Error('offline'); return [{ symbol, price: 102, timestamp: now - 60000, ...override }]; },
      fetchTicker: async symbol => { calls++; if (failure) throw new Error('offline'); return { symbol, last: venue === 'binance' ? 101 : venue === 'okx' ? 102 : 103, timestamp: now - 60000, ...override }; },
      close: async () => { closes++; } };
  };
  const quotes = createMarketQuoteService({ factory, now: () => now });
  const market = (venue: Venue, type: MarketType) => normalizeMarket(venue, raw(venue, type), 4)!;
  return { quotes, market, advance: (n: number) => { now += n; }, override: (v: typeof override) => { override = v; }, fail: () => { failure = true; }, counts: () => ({ calls, loads, closes }) };
}
test('six venue/products quote independently without active rules and preserve old exchange timestamp', async () => {
  const f = fixture();
  for (const venue of ['binance', 'okx', 'mexc'] as const) for (const type of ['spot', 'swap'] as const) {
    const market = f.market(venue, type), quote = await f.quotes.get(market);
    assert.equal(quote.instrument, market.instrument);
    assert.equal(quote.price, venue === 'binance' ? 101 : venue === 'okx' ? 102 : 103);
    assert.equal(quote.observedAt - quote.timestamp!, 60000);
    assert.equal(market.tradingViewSymbol, `${venue.toUpperCase()}:BTCUSDT${type === 'swap' ? '.P' : ''}`);
  }
  assert.deepEqual(f.counts(), { calls: 6, loads: 6, closes: 0 });
  await f.quotes.stop(); assert.equal(f.counts().closes, 6);
});
test('same market coalesces, caches five seconds, failed refresh cannot fabricate new capture time', async () => {
  const f = fixture(), market = f.market('mexc', 'swap');
  const [a, b] = await Promise.all([f.quotes.get(market), f.quotes.get(market)]);
  assert.deepEqual(a, b); assert.equal(f.counts().calls, 1);
  f.advance(4999); assert.deepEqual(await f.quotes.get(market), a);
  f.advance(1); f.fail(); await assert.rejects(f.quotes.get(market), /offline/);
  assert.equal(a.observedAt, 1700000000000);
  await f.quotes.stop(); await assert.rejects(f.quotes.get(market), /stopped/);
});
test('malformed, wrong symbol, future timestamps fail closed; missing timestamp stays null', async () => {
  for (const override of [{ symbol: 'ETH/USDT' }, { last: 0 }, { last: Infinity }, { last: '100' }, { timestamp: 1700000010000 }, { timestamp: -1 }, { timestamp: '1700000000000' }]) {
    const f = fixture(); f.override(override); await assert.rejects(f.quotes.get(f.market('binance', 'spot')), /invalid_quote/); await f.quotes.stop();
  }
  const f = fixture(); f.override({ timestamp: null }); assert.equal((await f.quotes.get(f.market('binance', 'spot'))).timestamp, null); await f.quotes.stop();
});
test('capacity is bounded; unknown/delisted metadata cannot be quoted', async () => {
  const f = fixture(), market = f.market('okx', 'swap');
  await assert.rejects(f.quotes.get({ ...market, instrument: 'ETH-USDT-SWAP', base: 'ETH' }), /market_unavailable/);
  await assert.rejects(f.quotes.get({ ...market, instrument: 'forged' }), /identity/);
  await assert.rejects(f.quotes.get({ ...market, base: 'ETH' }), /market_unavailable/);
  await f.quotes.stop();
});
