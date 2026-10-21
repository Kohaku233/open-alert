import type { Market, PriceTick } from '../contracts/domain.js';
import { instrumentSchema } from '../contracts/domain.js';
import { boundedJson } from '../notifications/http.js';
import type { Fetch } from '../notifications/http.js';
const ORIGIN = 'https://www.okx.com';
const CATALOG_REFRESH = 60 * 60 * 1000;
const CHART_BASES = new Set(['BTC','ETH','SOL','XRP','DOGE','ADA','AVAX','LINK','DOT','LTC','BCH','TON']);
const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
function rows(value: unknown): Record<string, unknown>[] {
  if (!object(value) || value.code !== '0' || !Array.isArray(value.data) || value.data.length > 10_000 || value.data.some(v => !object(v))) throw new Error('invalid_market_response');
  return value.data as Record<string, unknown>[];
}
const numeric = (value: unknown): number | null => {
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value) || value.length > 64) return null;
  const n = Number(value); return Number.isFinite(n) && n > 0 && n <= 1e12 ? n : null;
};
export function freshTick(tick: PriceTick, now: number): boolean {
  return Number.isFinite(tick.price) && tick.price > 0 && tick.price <= 1e12 && Number.isSafeInteger(tick.timestamp) && Number.isSafeInteger(tick.receivedAt) && tick.timestamp <= now + 5000 && now - tick.timestamp <= 30_000 && tick.receivedAt <= now && now - tick.receivedAt <= 30_000;
}
export function createMarketCache(options: { fetch?: Fetch; now?: () => number }) {
  const now = options.now ?? Date.now;
  let markets = new Map<string, Market>(), prices = new Map<string, PriceTick>();
  let updatedAt: number | null = null, lastPollAt: number | null = null;
  let catalogCode: string | null = null, priceCode: string | null = null;
  let nextCatalogAt = 0, nextPollAt = 0, failures = 0;
  const transport = { ...(options.fetch ? { fetch: options.fetch } : {}), timeoutMs: 10_000, maxBytes: 2 * 1024 * 1024 };
  let catalogWork: Promise<void> | null = null;
  async function loadCatalog(): Promise<void> {
    if (now() < nextCatalogAt) return;
    try {
      const response = await boundedJson(`${ORIGIN}/api/v5/public/instruments?instType=SWAP`, { method: 'GET' }, transport);
      if (response.status !== 200) throw new Error('catalog_unavailable');
      const next = new Map<string, Market>();
      for (const row of rows(response.data)) {
        if (row.instType !== 'SWAP' || row.state !== 'live' || row.settleCcy !== 'USDT' || !instrumentSchema.safeParse(row.instId).success || typeof row.tickSz !== 'string' || !numeric(row.tickSz)) continue;
        const instrument = row.instId as string, base = instrument.slice(0, -10);
        if (next.has(instrument)) throw new Error('duplicate_market');
        next.set(instrument, { instrument, base, quote: 'USDT', tickSize: row.tickSz, state: 'live', tradingViewSymbol: CHART_BASES.has(base) ? `OKX:${base}USDT.P` : '' });
      }
      if (!next.size) throw new Error('catalog_empty');
      markets = next; updatedAt = now(); nextCatalogAt = updatedAt + CATALOG_REFRESH; catalogCode = null;
      for (const id of prices.keys()) if (!markets.has(id)) prices.delete(id);
    } catch { catalogCode = 'catalog_unavailable'; nextCatalogAt = now() + 60_000; }
  }
  function catalog(): Promise<void> {
    if (catalogWork) return catalogWork;
    catalogWork = loadCatalog().finally(() => { catalogWork = null; }); return catalogWork;
  }
  async function poll(): Promise<void> {
    if (now() < nextPollAt) return;
    try {
      const response = await boundedJson(`${ORIGIN}/api/v5/market/tickers?instType=SWAP`, { method: 'GET' }, transport);
      if (response.status !== 200) throw new Error('prices_unavailable');
      const receivedAt = now(), next = new Map<string, PriceTick>();
      for (const row of rows(response.data)) {
        if (typeof row.instId !== 'string' || !markets.has(row.instId)) continue;
        const price = numeric(row.last);
        if (price === null || typeof row.ts !== 'string' || !/^\d{1,16}$/.test(row.ts)) continue;
        const tick = { instrument: row.instId, price, timestamp: Number(row.ts), receivedAt };
        if (!freshTick(tick, receivedAt)) continue;
        if (next.has(tick.instrument)) throw new Error('duplicate_tick');
        next.set(tick.instrument, tick);
      }
      if (!next.size) throw new Error('prices_empty');
      prices = next;
      lastPollAt = receivedAt; failures = 0; nextPollAt = receivedAt + 5000;
      priceCode = null;
    } catch { priceCode = 'prices_unavailable'; failures++; nextPollAt = now() + Math.min(60_000, 5000 * 2 ** Math.min(failures - 1, 4)); }
  }
  return {
    refreshCatalog: catalog,
    async refresh() { await catalog(); await poll(); },
    getMarkets() { return { markets: [...markets.values()].map(m => ({ ...m })), updatedAt, stale: updatedAt === null || now() - updatedAt >= CATALOG_REFRESH || catalogCode !== null }; },
    resolve(instrument: string) {
      const selected = markets.get(instrument), stale = updatedAt === null || now() - updatedAt >= CATALOG_REFRESH || catalogCode !== null;
      return { market: selected ? { ...selected } : null, stale, available: !!selected && !stale && selected.state === 'live' };
    },
    getPrices() { return [...prices.values()].map(t => ({ ...t })); },
    ticks() { return new Map(prices); },
    priceHealth() {
      const current = [...prices.values()].filter(t => freshTick(t, now()));
      const state = !current.length ? 'unhealthy' as const : priceCode || current.length < prices.size ? 'degraded' as const : 'healthy' as const;
      return { state, lastSuccessAt: lastPollAt, code: !current.length ? priceCode ?? 'prices_empty_or_stale' : priceCode };
    },
    lastPollAt: () => lastPollAt,
  };
}
