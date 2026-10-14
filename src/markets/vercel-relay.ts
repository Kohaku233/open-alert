import { parseInstrumentIdentity } from '../contracts/domain.js';
import { createPublicCcxtMarketSource } from './ccxt.js';
import { record } from './normalize.js';
import type { MarketSource, MarketSourceOptions } from './source.js';

export interface VercelRelayOptions { url: string; token: string; bypass?: string }
/** Shared, bounded relay transport. Credentials never follow redirects. */
export function createVercelRelayReader(relay: VercelRelayOptions, nativeFetch: typeof fetch = globalThis.fetch, timeoutMs = 8000) {
  const base = new URL(relay.url);
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash ||
      !/^[A-Za-z0-9_-]{32,256}$/.test(relay.token)) throw new Error('invalid_relay_configuration');
  const url = `${base.href.replace(/\/$/, '')}/api/market`;
  return async (method: 'GET' | 'POST', body?: unknown): Promise<unknown> => {
    const response = await nativeFetch(url, {
      method, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
      headers: { authorization: `Bearer ${relay.token}`, accept: 'application/json',
        ...(relay.bypass ? { 'x-vercel-protection-bypass': relay.bypass } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) {
      void response.body?.cancel(); throw new Error('relay_unavailable');
    }
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > 8 * 1024 * 1024) throw new Error('relay_response_capacity');
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  };
}
export function createVercelBinanceSource(options: Omit<MarketSourceOptions, 'factory'> & {
  relay?: VercelRelayOptions; fetchImplementation?: typeof fetch;
}): MarketSource {
  if (!options.relay || options.mode !== 'polling') throw new Error('invalid_relay_configuration');
  const now = options.now ?? Date.now;
  let symbols: string[] = [], snapshot: Record<string, unknown> = {}, stopped = false;
  let refreshWork: Promise<void> | null = null;
  const read = createVercelRelayReader(options.relay, options.fetchImplementation, options.requestTimeoutMs);
  const transport: typeof fetch = async (input, init) => {
    const request = new URL(input instanceof Request ? input.url : String(input));
    if (request.origin !== 'https://fapi.binance.com' || (init?.method ?? 'GET') !== 'GET') {
      throw new Error('unsupported_relay_request');
    }
    if (request.pathname === '/fapi/v1/exchangeInfo' && !request.search) return Response.json(await read('GET'));
    if (request.pathname !== '/fapi/v1/aggTrades' || request.searchParams.get('limit') !== '100' ||
        [...request.searchParams.keys()].some(key => key !== 'symbol' && key !== 'limit')) throw new Error('unsupported_relay_request');
    const symbol = request.searchParams.get('symbol') ?? '';
    if (!Object.hasOwn(snapshot, symbol)) throw new Error('relay_trades_unavailable');
    return Response.json(snapshot[symbol]);
  };
  const { relay: _relay, ...sourceOptions } = options;
  const source = createPublicCcxtMarketSource({ ...sourceOptions, binanceSwapFetchImplementation: transport });
  return {
    ...source,
    async setDemand(instruments) {
      const next = [...new Set(instruments.flatMap(id => {
        const market = parseInstrumentIdentity(id);
        return market?.venue === 'binance' && market.type === 'swap' ? [market.nativeId] : [];
      }))];
      if (next.length > 8) throw new Error('relay_demand_capacity');
      await source.setDemand(instruments); symbols = next;
    },
    refresh() {
      if (refreshWork) return refreshWork;
      refreshWork = (async () => {
        snapshot = {};
        if (symbols.length && !stopped) {
          try {
            const batch = await read('POST', { symbols: [...symbols] });
            if (!record(batch) || !record(batch.trades) || !Number.isSafeInteger(batch.capturedAt) ||
                (batch.capturedAt as number) > now() + 5000 || now() - (batch.capturedAt as number) > 10000 ||
                symbols.some(symbol => !Object.hasOwn(batch.trades as object, symbol) || !Array.isArray((batch.trades as Record<string, unknown>)[symbol]))) {
              throw new Error('invalid_relay_snapshot');
            }
            snapshot = batch.trades;
          } catch {
            // Empty snapshot makes the affected scope fail closed while other
            // venues and Binance spot continue their normal polling cycle.
          }
        }
        if (!stopped) await source.refresh();
      })().finally(() => { refreshWork = null; });
      return refreshWork;
    },
    async stop() { stopped = true; snapshot = {}; await source.stop(); },
  };
}
