import ccxt from 'ccxt';
import { nativeMarketIdSchema } from '../contracts/domain.js';
import { createPublicCcxtFactory, publicExchangeConfig } from './ccxt.js';
import type { BinanceSwapCatalogSnapshot } from './ccxt.js';
import { normalizeCatalog, record } from './normalize.js';
import type { NormalizedMarket } from './normalize.js';

const CATALOG_PATH = '/fapi/v1/exchangeInfo';
const TRADES_PATH = '/fapi/v1/aggTrades';
const MAX_CATALOG_BYTES = 8 * 1024 * 1024;
const MAX_CATALOG_MARKETS = 20_000;
const MAX_TRADE_BYTES = 64 * 1024;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,256}$/;
const safeClock = (n: number) => Number.isSafeInteger(n) && n >= 0;
const bounded = (n: number, min: number, max: number) => {
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error('invalid_relay_limit');
  return n;
};
function tokenCheck(token: string) {
  if (!TOKEN_PATTERN.test(token)) throw new Error('invalid_relay_token');
}
function route(url: URL): string | null {
  if (url.pathname === CATALOG_PATH && !url.search) return null;
  if (url.pathname !== TRADES_PATH || [...url.searchParams.keys()].length !== 2 ||
      url.searchParams.getAll('symbol').length !== 1 || url.searchParams.getAll('limit').length !== 1 ||
      url.searchParams.get('limit') !== '100') throw new Error('unsupported_relay_route');
  const id = url.searchParams.get('symbol')!;
  if (!nativeMarketIdSchema.safeParse(id).success) throw new Error('invalid_relay_symbol');
  return id;
}

/** HTTPS, or explicit loopback HTTP for local tests. Paths support TLS reverse proxies. */
export function validateBinanceRelayUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('invalid_relay_url'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (value.trim() !== value || /[?#]/.test(value) || value.includes('\\') || !/^https?:\/\//.test(value) || url.username || url.password || url.search || url.hash ||
      url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback) ||
      /[%\\]/.test(url.pathname) || url.pathname.split('/').some(segment => segment === '..' || segment === '.')) {
    throw new Error('invalid_relay_url');
  }
  return url;
}

async function limitedJson(response: Response, maxBytes: number, signal?: AbortSignal): Promise<unknown> {
  const type = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  if (type !== 'application/json') throw new Error('invalid_relay_content');
  const declared = response.headers.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) throw new Error('relay_response_capacity');
  if (!response.body) throw new Error('invalid_relay_content');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    for (;;) {
      if (signal?.aborted) throw new Error('relay_timeout');
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error('relay_response_capacity');
      chunks.push(value);
    }
    if (signal?.aborted) throw new Error('relay_timeout');
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } finally {
    signal?.removeEventListener('abort', abort);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
function envelope(value: unknown): asserts value is Record<string, unknown> & { symbols: unknown[] } {
  if (!record(value) || !Array.isArray(value.symbols) || value.symbols.length > MAX_CATALOG_MARKETS ||
      !Array.isArray(value.assets) || !Array.isArray(value.rateLimits) || !Array.isArray(value.exchangeFilters) ||
      typeof value.timezone !== 'string' || !value.timezone || !safeClock(value.serverTime as number)) throw new Error('invalid_catalog');
}

export interface BinanceRelayFetchOptions { url: string; token: string; fetchImplementation?: typeof fetch; timeoutMs?: number }
/** Only official Binance USD-M requests are rewritten. Native fetch remains untouched elsewhere. */
export function createBinanceRelayFetch(options: BinanceRelayFetchOptions): typeof fetch {
  const base = validateBinanceRelayUrl(options.url); tokenCheck(options.token);
  const nativeFetch = options.fetchImplementation ?? globalThis.fetch;
  const timeout = bounded(options.timeoutMs ?? 10_000, 1, 30_000);
  return async (input, init) => {
    let source: URL;
    try { source = new URL(input instanceof Request ? input.url : String(input)); }
    catch { throw new Error('invalid_relay_request'); }
    // Include subdomains so unsupported Binance/private/spot targets cannot fall
    // through accidentally. Other exchanges keep their exact native arguments.
    const binance = source.hostname === 'binance.com' || source.hostname.endsWith('.binance.com');
    if (!binance) return nativeFetch(input, init);
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    if (source.origin !== 'https://fapi.binance.com' || source.username || source.password || source.hash ||
        method !== 'GET' || init?.body != null || input instanceof Request && input.body !== null) throw new Error('unsupported_relay_request');
    const id = route(source);
    const target = new URL(base);
    target.pathname = base.pathname.replace(/\/$/, '') + source.pathname;
    target.search = id === null ? '' : new URLSearchParams({ symbol: id, limit: '100' }).toString();
    const controller = new AbortController();
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const abort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error('relay_timeout')); }, timeout);
    });
    try {
      return await Promise.race([timedOut, (async () => {
        if (controller.signal.aborted) throw new Error('relay_cancelled');
        const response = await nativeFetch(target.href, { method: 'GET', headers: { authorization: `Bearer ${options.token}`, accept: 'application/json' },
          signal: controller.signal, redirect: 'manual', credentials: 'omit', cache: 'no-store' });
        if (response.redirected || response.url && response.url !== target.href ||
            response.status !== 200 && !(response.status === 503 && id !== null)) {
          void response.body?.cancel().catch(() => {}); throw new Error('relay_http_failure');
        }
        const body = await limitedJson(response, id === null ? MAX_CATALOG_BYTES : MAX_TRADE_BYTES, controller.signal);
        if (response.status === 503) {
          // This is the only non-200 protocol outcome. Generic upstream errors,
          // wrong symbols and malformed envelopes remain transport failures.
          if (!record(body) || Object.keys(body).length !== 3 || body.code !== -1 ||
              body.msg !== 'no_fresh_trade' || body.symbol !== id) throw new Error('relay_http_failure');
          return Response.json({ code: -1, msg: 'no_fresh_trade', symbol: id }, { status: 503, headers: { 'cache-control': 'no-store' } });
        }
        if (id === null) envelope(body);
        else if (!Array.isArray(body) || !body.length || body.length > 100 || body.some(row => !restTrade(row))) throw new Error('invalid_relay_trades');
        return Response.json(body, { headers: { 'cache-control': 'no-store' } });
      })()]);
    } catch { throw new Error(controller.signal.aborted ? 'relay_cancelled_or_timeout' : 'relay_unavailable'); }
    finally { if (timer) clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  };
}

export interface RawAggTrade { a: number; p: string; q: string; f: number; l: number; T: number; m: boolean }
const positiveDecimal = (v: unknown): v is string => typeof v === 'string' && v.length <= 64 && /^\d+(\.\d+)?$/.test(v) && Number.isFinite(Number(v)) && Number(v) > 0;
function restTrade(v: unknown): v is RawAggTrade {
  return record(v) && safeClock(v.a as number) && safeClock(v.f as number) && safeClock(v.l as number) &&
    (v.f as number) <= (v.l as number) && safeClock(v.T as number) && positiveDecimal(v.p) && positiveDecimal(v.q) && typeof v.m === 'boolean';
}
function rawTrades(batch: unknown, market: NormalizedMarket): RawAggTrade[] {
  if (!Array.isArray(batch) || !batch.length || batch.length > 100) throw new Error('invalid_stream_batch');
  return batch.map(trade => {
    if (!record(trade) || trade.symbol !== market.symbol || !record(trade.info)) throw new Error('invalid_stream_trade');
    const raw = trade.info;
    if (raw.e !== 'aggTrade' || raw.s !== market.nativeId || !restTrade(raw)) throw new Error('invalid_stream_trade');
    // Keep original decimal strings, aggregate IDs, executed-trade times and maker
    // flags. Do not convert the CCXT floating-point price back into raw metadata.
    return { a: raw.a, p: raw.p, q: raw.q, f: raw.f, l: raw.l, T: raw.T, m: raw.m };
  });
}

export class BinanceRelayCooldown extends Error {
  constructor(readonly retryAt: number) { super('upstream_cooldown'); }
}
export interface BinanceRelayStream {
  next(): Promise<unknown>;
  close(): Promise<unknown>;
}
export interface BinanceRelayBoundaries {
  catalog(signal: AbortSignal): Promise<BinanceSwapCatalogSnapshot>;
  /** Each start owns its own closeable client. It must obey cancellation. */
  stream(market: NormalizedMarket, validatedMarkets: unknown, signal: AbortSignal): Promise<BinanceRelayStream>;
  close?(): Promise<unknown>;
}
export interface BinanceRelayServiceOptions {
  token: string; boundaries: BinanceRelayBoundaries; now?: () => number;
  catalogTtlMs?: number; freshnessMs?: number; idleMs?: number; timeoutMs?: number;
  cooldownMs?: number; requestsPerMinute?: number; maxConcurrentRequests?: number;
}
interface Catalog { snapshot: BinanceSwapCatalogSnapshot; markets: Map<string, NormalizedMarket>; parsed: unknown; json: string }
interface Watcher {
  market: NormalizedMarket; accessed: number; controller: AbortController;
  client: BinanceRelayStream | null; pending: Promise<BinanceRelayStream> | null;
  running: Promise<void> | null; closing: Promise<void> | null; sample: { trade: RawAggTrade; at: number } | null;
  cursor: number; id: number; failed: boolean;
}
const settings = { mode: 'polling' as const, timeoutMs: 10_000, tradesLimit: 100, product: 'swap' as const };

/** Lazy authenticated service. Construction performs no upstream work. Node
 * crypto is loaded here only; importing the client adapter in Workers is safe. */
export async function createBinanceFuturesRelay(options: BinanceRelayServiceOptions) {
  tokenCheck(options.token);
  const { timingSafeEqual, createHash } = await import('node:crypto');
  const hash = (value: string) => createHash('sha256').update(value).digest();
  const expected = hash(`Bearer ${options.token}`);
  const now = options.now ?? Date.now;
  const ttl = bounded(options.catalogTtlMs ?? 900_000, 1, 900_000);
  const freshness = bounded(options.freshnessMs ?? 30_000, 1, 30_000);
  const idle = bounded(options.idleMs ?? 60_000, 1, 60_000);
  const timeout = bounded(options.timeoutMs ?? 10_000, 1, 30_000);
  const cooldown = bounded(options.cooldownMs ?? 60_000, 1000, 900_000);
  const perMinute = bounded(options.requestsPerMinute ?? 120, 1, 600);
  const maxRequests = bounded(options.maxConcurrentRequests ?? 16, 1, 32);
  const lifetime = new AbortController();
  let stopped = false, catalog: Catalog | null = null, refresh: Promise<Catalog> | null = null;
  let retryAt = 0, active = 0, windowAt = now(), requests = 0, closeWork: Promise<void> | null = null;
  const watchers = new Map<string, Watcher>();
  // Only current catalog members can fail: at most MAX_CATALOG_MARKETS keys,
  // cleared on catalog invalidation/replacement and pruned when cooldown expires.
  const streamCooldowns = new Map<string, number>();
  const valid = (c: Catalog | null): c is Catalog => c !== null && safeClock(now()) && now() >= c.snapshot.capturedAt && now() - c.snapshot.capturedAt < ttl;
  async function deadline<T>(work: Promise<T>, signal: AbortSignal, ms: number | null = timeout): Promise<T> {
    // Observe cancellation races even when the signal was aborted before entry.
    void work.catch(() => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
      if (signal.aborted) throw new Error('relay_closed');
      return await Promise.race([work, new Promise<never>((_, reject) => {
        if (ms !== null) timer = setTimeout(() => reject(new Error('relay_timeout')), ms);
        abort = () => reject(new Error('relay_closed')); signal.addEventListener('abort', abort, { once: true });
      })]);
    } finally { if (timer) clearTimeout(timer); if (abort) signal.removeEventListener('abort', abort); }
  }
  function retire(w: Watcher): Promise<void> {
    if (w.closing) return w.closing;
    w.failed = true; w.sample = null; w.controller.abort();
    w.closing = (async () => {
      // Keep the slot until the underlying asynchronous start/close settles.
      // A stalled dependency cannot create unbounded overlapping starts.
      const closed = (async () => {
        try { const client = w.client ?? await w.pending; if (client) await client.close(); } catch { /* sanitized */ }
        if (watchers.get(w.market.nativeId) === w) watchers.delete(w.market.nativeId);
      })();
      await deadline(closed, new AbortController().signal, 1000).catch(() => {});
    })();
    return w.closing;
  }
  function sweep() {
    if (!valid(catalog)) { catalog = null; streamCooldowns.clear(); }
    for (const [id, until] of streamCooldowns) {
      if (now() >= until || !catalog?.markets.has(id)) streamCooldowns.delete(id);
    }
    for (const w of watchers.values()) {
      if (!catalog || !catalog.markets.has(w.market.nativeId) || now() < w.accessed || now() - w.accessed >= idle) void retire(w);
    }
  }
  const timer = setInterval(sweep, Math.min(idle, ttl, 1000)); timer.unref();
  async function getCatalog(): Promise<Catalog> {
    if (stopped || !safeClock(now())) throw new Error('relay_closed');
    sweep();
    if (valid(catalog)) return catalog;
    if (refresh) return deadline(refresh, lifetime.signal);
    if (now() < retryAt) throw new Error('relay_cooldown');
    const controller = new AbortController();
    const abort = () => controller.abort();
    lifetime.signal.addEventListener('abort', abort, { once: true });
    const expiry = setTimeout(abort, timeout);
    refresh = (async () => {
      let captured: BinanceSwapCatalogSnapshot | undefined;
      // Capture the actual provider result exactly once, with its original time.
      const original = options.boundaries.catalog;
      const localParser = createPublicCcxtFactory({ now, maxCatalogMarkets: MAX_CATALOG_MARKETS,
        fetchImplementation: async () => { throw new Error('unexpected_catalog_transport'); },
        binanceSwapCatalog: async () => {
          captured = await original(controller.signal);
          envelope(captured.exchangeInfo);
          if (new TextEncoder().encode(JSON.stringify(captured.exchangeInfo)).byteLength > MAX_CATALOG_BYTES) throw new Error('catalog_capacity');
          return captured;
        },
      })('binance', settings);
      try {
        // Retain refresh's single-flight slot until the real load settles, even
        // when a caller's deadline expires. Late results cannot revive the cache.
        const parsed = await localParser.loadMarkets(true);
        if (stopped || controller.signal.aborted || !captured) throw new Error('relay_closed');
        const normalized = normalizeCatalog('binance', parsed, localParser.precisionMode);
        const markets = new Map<string, NormalizedMarket>();
        for (const market of normalized.values()) {
          if (market.type !== 'swap' || !nativeMarketIdSchema.safeParse(market.nativeId).success) throw new Error('invalid_swap_catalog');
          markets.set(market.nativeId, market);
        }
        const next = { snapshot: captured, markets, parsed, json: JSON.stringify(captured.exchangeInfo) };
        if (!valid(next)) throw new Error('expired_catalog');
        catalog = next; retryAt = 0; streamCooldowns.clear(); sweep(); return next;
      } catch (error) {
        catalog = null;
        retryAt = error instanceof BinanceRelayCooldown && safeClock(error.retryAt) ? Math.max(now() + cooldown, error.retryAt) : now() + cooldown;
        sweep(); throw new Error('catalog_unavailable');
      } finally { clearTimeout(expiry); lifetime.signal.removeEventListener('abort', abort); void localParser.close().catch(() => {}); }
    })();
    const work = refresh;
    void work.finally(() => { if (refresh === work) refresh = null; }).catch(() => {});
    return deadline(work, lifetime.signal);
  }
  function start(market: NormalizedMarket, c: Catalog): Watcher {
    const w: Watcher = { market, accessed: now(), controller: new AbortController(), client: null, pending: null,
      running: null, closing: null, sample: null, cursor: -1, id: -1, failed: false };
    watchers.set(market.nativeId, w);
    w.pending = Promise.resolve().then(() => {
      if (stopped || w.controller.signal.aborted) throw new Error('relay_closed');
      return options.boundaries.stream(market, c.parsed, w.controller.signal);
    });
    w.running = (async () => {
      try {
        w.client = await deadline(w.pending!, w.controller.signal);
        if (stopped || w.failed) return;
        while (!stopped && !w.failed) {
          // One pending next() per watcher. A quiet market does not reconnect on
          // every poll; idle retirement aborts the wait and closes the client.
          const batch = await deadline(w.client.next(), w.controller.signal, null);
          if (stopped || w.failed || !valid(catalog) || !catalog.markets.has(market.nativeId)) throw new Error('relay_closed');
          const rows = rawTrades(batch, market);
          const at = now();
          for (const trade of rows) {
            if (trade.T > at + 5000 || at - trade.T > freshness || trade.T < w.cursor || trade.a <= w.id) continue;
            w.sample = { trade, at }; w.cursor = trade.T; w.id = trade.a;
          }
        }
      } catch {
        if (!w.failed && !stopped && valid(catalog) && catalog === c && catalog.markets.has(market.nativeId)) {
          streamCooldowns.set(market.nativeId, now() + cooldown);
        }
        w.failed = true; w.sample = null;
      }
      finally { void retire(w); }
    })();
    return w;
  }
  const response = (body: string, status = 200) => new Response(body, { status, headers: {
    'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
  } });
  async function handle(request: Request): Promise<Response> {
    const supplied = request.headers.get('authorization') ?? '';
    if (supplied.length > 300 || !timingSafeEqual(expected, hash(supplied))) return response('{"code":-1,"msg":"unauthorized"}', 401);
    if (stopped) return response('{"code":-1,"msg":"unavailable"}', 503);
    if (request.method !== 'GET' || request.body !== null || request.headers.has('content-length') && request.headers.get('content-length') !== '0' ||
        request.headers.has('transfer-encoding') || request.headers.has('x-mbx-apikey') || request.headers.has('cookie') ||
        request.headers.has('proxy-authorization')) return response('{"code":-1,"msg":"unsupported_request"}', 400);
    let id: string | null;
    try {
      const url = new URL(request.url);
      if (url.username || url.password || url.hash) throw new Error('invalid_request');
      id = route(url);
    } catch { return response('{"code":-1,"msg":"unsupported_route"}', 400); }
    const at = now();
    if (!safeClock(at) || at < windowAt) return response('{"code":-1,"msg":"unavailable"}', 503);
    if (at - windowAt >= 60_000) { windowAt = at; requests = 0; }
    if (++requests > perMinute || active >= maxRequests) return response('{"code":-1,"msg":"request_limit"}', 429);
    active++;
    try {
      const c = await getCatalog();
      if (stopped || !valid(c)) throw new Error('relay_closed');
      if (id === null) return response(c.json);
      const market = c.markets.get(id);
      if (!market) return response('{"code":-1,"msg":"unsupported_symbol"}', 400);
      let w = watchers.get(id);
      if (w?.failed) throw new Error('stream_unavailable');
      if (!w) {
        if (now() < (streamCooldowns.get(id) ?? 0)) throw new Error('stream_cooldown');
        if (watchers.size >= 8) return response('{"code":-1,"msg":"symbol_capacity"}', 429);
        w = start(market, c);
      }
      w.accessed = now();
      const sample = w.sample;
      if (!sample || now() < sample.at || now() - sample.at > freshness || sample.trade.T > now() + 5000 || now() - sample.trade.T > freshness) {
        return response(JSON.stringify({ code: -1, msg: 'no_fresh_trade', symbol: id }), 503);
      }
      // Latest sampling is the existing polling protocol. A one-row raw REST page
      // avoids claiming complete event history and keeps all buffers globally <=8.
      return response(JSON.stringify([sample.trade]));
    } catch { return response('{"code":-1,"msg":"unavailable"}', 503); }
    finally { active--; }
  }
  function close(): Promise<void> {
    if (closeWork) return closeWork;
    stopped = true; lifetime.abort(); clearInterval(timer); catalog = null; streamCooldowns.clear();
    closeWork = (async () => {
      await Promise.all([...watchers.values()].map(retire));
      if (options.boundaries.close) await deadline(Promise.resolve().then(() => options.boundaries.close!()), new AbortController().signal, 1000).catch(() => {});
    })();
    return closeWork;
  }
  return { handle, close, sweep, diagnostics: () => ({ stopped, symbols: watchers.size, samples: [...watchers.values()].filter(w => w.sample).length, retryAt, streamCooldowns: streamCooldowns.size }) };
}

/** Production boundary: public CCXT endpoints and Pro only. No discovery,
 * credentials, arbitrary upstream targets, REST trade fallback or static catalog. */
export async function createBinanceRelayCcxtBoundaries(options: { now?: () => number; httpsProxy?: string } = {}): Promise<BinanceRelayBoundaries> {
  const now = options.now ?? Date.now;
  const { request } = await import('node:https');
  let catalogSignal: AbortSignal | undefined;
  // CCXT's supported injected transport receives its supported httpsProxy agent.
  // Bound bytes before JSON parsing; never follow redirects or include error text.
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.href !== 'https://fapi.binance.com/fapi/v1/exchangeInfo' || init?.method !== 'GET') throw new Error('unsupported_upstream');
    const agent = (init as RequestInit & { agent?: import('node:https').Agent } | undefined)?.agent;
    return new Promise<Response>((resolve, reject) => {
      const signals = [init?.signal, catalogSignal].filter((signal): signal is AbortSignal => signal != null);
      const signal = signals.length ? AbortSignal.any(signals) : undefined;
      const req = request(url, { method: 'GET', agent, headers: { accept: 'application/json' }, ...(signal ? { signal } : {}) }, res => {
        const chunks: Buffer[] = []; let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_CATALOG_BYTES) { res.destroy(); req.destroy(); reject(new Error('catalog_capacity')); }
          else chunks.push(chunk);
        });
        res.on('error', () => reject(new Error('upstream_unavailable')));
        res.on('end', () => {
          const status = res.statusCode ?? 500;
          const headers = new Headers();
          for (const name of ['content-type', 'retry-after']) {
            const value = res.headers[name]; if (typeof value === 'string') headers.set(name, value);
          }
          if (status === 418 || status === 429) {
            const at = now();
            const expiries: number[] = [];
            const retry = headers.get('retry-after');
            if (retry) {
              const value = /^\d+$/.test(retry) ? at + Number(retry) * 1000 : Date.parse(retry);
              if (safeClock(value) && value > at) expiries.push(value);
            }
            // Binance's ban expiry is only used as a numeric cooldown. Never log
            // or propagate the message, which can contain the public IP address.
            const match = Buffer.concat(chunks).toString('utf8').match(/banned until (\d{10,16})/);
            if (match && safeClock(Number(match[1])) && Number(match[1]) > at) expiries.push(Number(match[1]));
            const retryAt = expiries.length ? Math.max(...expiries) : at + (status === 418 ? 24 * 60 * 60_000 : 60_000);
            reject(new BinanceRelayCooldown(retryAt)); return;
          }
          if (status !== 200) { reject(new Error('upstream_unavailable')); return; }
          resolve(new Response(Buffer.concat(chunks), { status, headers }));
        });
      });
      req.on('error', () => reject(new Error('upstream_unavailable')));
      req.setTimeout(10_000, () => { req.destroy(); reject(new Error('upstream_timeout')); });
      req.end();
    });
  };
  const proxy = options.httpsProxy;
  if (proxy) {
    let url: URL; try { url = new URL(proxy); } catch { throw new Error('invalid_proxy'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.hash || url.search) throw new Error('invalid_proxy');
  }
  const rest = new ccxt.binance({ ...publicExchangeConfig('binance', settings, transport), ...(proxy ? { httpsProxy: proxy } : {}), verbose: false });
  rest.has.fetchCurrencies = false;
  rest.log = () => {};
  const streams = new Set<InstanceType<typeof ccxt.pro.binance>>();
  let closed = false;
  return {
    catalog: async signal => {
      if (closed || signal.aborted) throw new Error('relay_closed');
      if (catalogSignal) throw new Error('catalog_overlap');
      catalogSignal = signal;
      try {
        // The injected Node transport uses CCXT's optional legacy proxy agents.
        if (proxy) await rest.loadProxyModules();
        // Implicit public endpoint bypasses CCXT's ancillary spot/currency discovery.
        const exchangeInfo: unknown = await rest.fapiPublicGetExchangeInfo();
        if (closed || signal.aborted) throw new Error('relay_closed');
        return { exchangeInfo, capturedAt: now() };
      } finally { catalogSignal = undefined; }
    },
    stream: async (market, parsed, signal) => {
      if (closed || signal.aborted) throw new Error('relay_closed');
      const client = new ccxt.pro.binance({ ...publicExchangeConfig('binance', { ...settings, mode: 'stream' }),
        ...(proxy ? { httpsProxy: proxy, wssProxy: proxy } : {}), verbose: false,
        options: { ...publicExchangeConfig('binance', settings).options, watchTrades: { name: 'aggTrade' }, watchTradesForSymbols: { name: 'aggTrade' }, tradesLimit: 1,
          ws: { options: { maxPayload: MAX_TRADE_BYTES, perMessageDeflate: false, followRedirects: false } } },
      });
      client.has.fetchCurrencies = false;
      client.log = () => {};
      // parsed came exclusively from createPublicCcxtFactory's fresh provider,
      // full-envelope validation and normalizer, never a synthetic setMarkets map.
      client.setMarkets(parsed);
      streams.add(client);
      const abort = () => { void client.close().catch(() => {}); };
      signal.addEventListener('abort', abort, { once: true });
      try {
        if (proxy) await client.loadProxyModules();
        if (closed || signal.aborted) throw new Error('relay_closed');
        return { next: () => client.watchTrades(market.symbol, undefined, 1, { name: 'aggTrade' }),
          close: async () => { signal.removeEventListener('abort', abort); try { await client.close(); } finally { streams.delete(client); } } };
      } catch { signal.removeEventListener('abort', abort); await client.close().catch(() => {}); streams.delete(client); throw new Error('stream_unavailable'); }
    },
    close: async () => { closed = true; await Promise.allSettled([rest.close(), ...[...streams].map(client => client.close())]); streams.clear(); },
  };
}
