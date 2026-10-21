import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMarketCache, freshTick } from '../src/scheduler/market.js';

const ORIGIN = 'https://www.okx.com';
const CATALOG_URL = `${ORIGIN}/api/v5/public/instruments?instType=SWAP`;
const TICKERS_URL = `${ORIGIN}/api/v5/market/tickers?instType=SWAP`;
const INSTRUMENT = 'BTC-USDT-SWAP';

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

const catalogPayload = {
  code: '0',
  data: [{ instType: 'SWAP', state: 'live', settleCcy: 'USDT', instId: INSTRUMENT, tickSz: '0.1' }],
};
const livePayload = (ts: number) => ({ code: '0', data: [{ instId: INSTRUMENT, last: '50000', ts: String(ts) }] });
const emptyPayload = { code: '0', data: [] as unknown[] };

// Controllable clock plus an injected fetch that branches on the OKX endpoint URL.
// The tickers response is swapped per-poll so we can drive the empty-snapshot scenario.
function harness() {
  let at = 1_700_000_000_000;
  let tickers: unknown = livePayload(at);
  const fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url === CATALOG_URL) return json(catalogPayload);
    if (url === TICKERS_URL) return json(tickers);
    throw new Error(`unexpected url ${url}`);
  }) as typeof globalThis.fetch;
  const cache = createMarketCache({ fetch, now: () => at });
  return {
    cache,
    now: () => at,
    advance(ms: number) { at += ms; },
    setTickers(value: unknown) { tickers = value; },
  };
}

test('transient empty ticker snapshot does not wipe cached prices', async () => {
  const h = harness();

  // (a) first successful poll: catalog + non-empty tickers -> healthy cached tick
  await h.cache.refresh();
  const first = h.cache.ticks();
  assert.equal(first.size, 1, 'first poll stores the live tick');
  assert.ok(first.has(INSTRUMENT));
  assert.equal(h.cache.getPrices().length, 1);
  assert.equal(h.cache.priceHealth().state, 'healthy');

  // (b) second poll returns an empty-but-HTTP-200 snapshot after the poll gate opens.
  // Advance past nextPollAt (5000ms) but stay within the 30s freshness window.
  h.advance(6000);
  h.setTickers(emptyPayload);
  await h.cache.refresh();

  const retained = h.cache.ticks();
  assert.equal(retained.size, 1, 'empty snapshot must NOT wipe the cached tick');
  assert.ok(retained.has(INSTRUMENT), 'previously cached price survives the empty poll');
  assert.equal(h.cache.getPrices().length, 1);
  // The empty poll throws prices_empty in the catch, reporting degradation.
  const degraded = h.cache.priceHealth();
  assert.equal(degraded.code, 'prices_unavailable');
  assert.equal(degraded.state, 'degraded');

  // (c) advance beyond the 30s freshness window: the retained price ages out via freshTick.
  h.advance(30_001);
  const stale = [...h.cache.ticks().values()];
  assert.ok(stale.every(t => !freshTick(t, h.now())), 'retained tick is now stale');
  const unhealthy = h.cache.priceHealth();
  assert.equal(unhealthy.state, 'unhealthy', 'stale prices are filtered out and health is unhealthy');
});
