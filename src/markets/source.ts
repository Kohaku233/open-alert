import { parseInstrumentIdentity } from '../contracts/domain.js';
import type { ComponentHealth, Market, MarketType, PriceTick, Venue } from '../contracts/domain.js';
import type { CatalogSelection, CatalogSnapshot } from '../api/ports.js';
import { VENUES, normalizeCatalog, record } from './normalize.js';
import type { NormalizedMarket } from './normalize.js';

export type MarketMode = 'stream' | 'polling';
/** A validated adapter outcome for one requested symbol, never a transport fault. */
export class SymbolTradesUnavailableError extends Error {
  constructor(readonly symbol: string) { super('no_fresh_trade'); }
}
/** Structural port keeps mock factories and Cloudflare bundles independent of Node Pro. */
export interface CcxtExchange {
  precisionMode: number;
  has: Record<string, unknown>;
  loadMarkets(reload?: boolean): Promise<unknown>;
  fetchTicker?(symbol: string): Promise<unknown>;
  /** Display clients reuse already validated catalog metadata, avoiding a second full catalog fetch. */
  seedMarket?(market: Market): void;
  fetchTrades(symbol: string, since?: number, limit?: number): Promise<unknown>;
  watchTrades?(symbol: string, since?: number, limit?: number): Promise<unknown>;
  close(): Promise<unknown>;
}
export interface ExchangeSettings {
  mode: MarketMode; timeoutMs: number; tradesLimit: number; product?: MarketType;
}
export type ExchangeFactory = (venue: Venue, settings: ExchangeSettings) => CcxtExchange | Promise<CcxtExchange>;
export interface MarketSource {
  readonly mode?: MarketMode;
  /** Removes captured observations only; arrivals during SQL work remain queued. */
  acknowledgeSamples(instrument: string, captured: readonly PriceTick[]): void;
  refreshCatalog(): Promise<void>;
  refresh(): Promise<void>;
  getMarkets(): CatalogSnapshot;
  /** Point lookup with live scope freshness; never copies the full catalog. */
  resolve?(instrument: string): CatalogSelection;
  getPrices(): PriceTick[];
  ticks(): Map<string, PriceTick>;
  priceHealth(): ComponentHealth;
  lastPollAt(): number | null;
  setDemand(instruments: readonly string[]): Promise<void>;
  stop(): Promise<void>;
  /** Catalog freshness is independent for each venue; price freshness checked by samples/ticks. */
  eligible(instrument: string): boolean;
  /** Non-consuming so every rule/user can inspect every crossing in a scheduler cycle. */
  samples(instrument: string): PriceTick[];
  /** Call only after all rules for this instrument have evaluated the returned batch. */
  drainSamples(instrument: string): PriceTick[];
  diagnostics(): SourceDiagnostics;
}
export interface SourceDiagnostics {
  stopped: boolean; queued: number; queueCapacity: number; demandCapacity: number;
  venues: { venue: Venue; type?: MarketType; catalogAt: number | null; catalogCode: string | null; priceCode: string | null; retryAt: number; clientOpen: boolean }[];
  instruments: { instrument: string; code: string | null; queued: number; replayEntries: number }[];
  replayCapacity: number;
}
export interface MarketSourceOptions {
  factory: ExchangeFactory; mode: MarketMode; venues?: readonly Venue[]; now?: () => number;
  /** Independent authoritative snapshots; shared demand/queue budgets remain global. */
  splitProducts?: readonly Venue[];
  catalogTtlMs?: number; requestTimeoutMs?: number; closeTimeoutMs?: number;
  freshnessMs?: number; futureSkewMs?: number; pollIntervalMs?: number;
  retryBaseMs?: number; retryMaxMs?: number;
  maxDemand?: number; maxQueue?: number; maxBatch?: number; maxCatalogMarkets?: number;
  /** IDs at the monotonic trade timestamp; separate from pending observations. */
  maxReplayEntries?: number;
  pollBudgetMs?: number; maxPollRequestsPerVenue?: number;
}
interface Demand {
  since: number; first: boolean; cursor: number; queue: PriceTick[]; latest: PriceTick | null;
  code: string | null; seen: Map<string, number>; nextPollAt: number;
}
interface VenueState {
  venue: Venue; product?: MarketType; exchange: CcxtExchange | null; epoch: number;
  catalog: Map<string, NormalizedMarket>; catalogAt: number | null; catalogCode: string | null;
  priceCode: string | null; retryAt: number; failures: number; nextCatalogAt: number;
  watchers: Map<string, Promise<void>>; catalogWork: Promise<void> | null; opening: Promise<void> | null;
  pollCursor: number; controller: AbortController;
}
const bound = (n: number, min: number, max: number) => {
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new RangeError('invalid_market_source_limit');
  return n;
};
/** Deadlines also attach rejection handlers to timed-out promises. CCXT close aborts
 * its sockets; an uncooperative mock/transport can never block stop indefinitely. */
async function deadline<T>(work: () => Promise<T>, ms: number | null, signal?: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    if (signal?.aborted) throw new Error('market_cancelled');
    return await Promise.race([Promise.resolve().then(work), new Promise<never>((_, reject) => {
      if (ms !== null) timer = setTimeout(() => reject(new Error('market_timeout')), ms);
      abort = () => reject(new Error('market_cancelled'));
      signal?.addEventListener('abort', abort, { once: true });
    })]);
  } finally { if (timer) clearTimeout(timer); if (abort) signal?.removeEventListener('abort', abort); }
}

/** Catalogs and confirmed delistings are process-local. Every new source starts
 * ineligible and requires a fresh successful complete load before any evaluation;
 * durable catalog/delisting history is optional and outside this adapter. */
export function createCcxtMarketSource(options: MarketSourceOptions): MarketSource {
  const now = options.now ?? Date.now;
  const ttl = bound(options.catalogTtlMs ?? 3_600_000, 1, 3_600_000);
  const timeout = bound(options.requestTimeoutMs ?? 10_000, 1, 30_000);
  const closeTimeout = bound(options.closeTimeoutMs ?? 1000, 1, 5000);
  const freshness = bound(options.freshnessMs ?? 30_000, 1, 30_000);
  const skew = bound(options.futureSkewMs ?? 5000, 0, 5000);
  const pollInterval = bound(options.pollIntervalMs ?? 5000, 1, 60_000);
  const retryBase = bound(options.retryBaseMs ?? 1000, 1, 60_000);
  const retryMax = bound(options.retryMaxMs ?? 60_000, retryBase, 300_000);
  const maxDemand = bound(options.maxDemand ?? 200, 1, 1000);
  const maxQueue = bound(options.maxQueue ?? 4096, 1, 100_000);
  const maxBatch = bound(options.maxBatch ?? 1000, 2, 10_000);
  const maxReplay = bound(options.maxReplayEntries ?? 10_000, 2, 100_000);
  const maxCatalog = bound(options.maxCatalogMarkets ?? 20_000, 1, 50_000);
  const pollBudget = bound(options.pollBudgetMs ?? 15_000, 1, 30_000);
  const maxPollRequests = bound(options.maxPollRequestsPerVenue ?? 20, 1, 1000);
  if (options.mode !== 'stream' && options.mode !== 'polling') throw new Error('invalid_market_mode');
  const venues = options.venues ?? VENUES;
  if (!venues.length || new Set(venues).size !== venues.length || venues.some(v => !VENUES.includes(v))) throw new Error('invalid_venues');
  const split = options.splitProducts ?? [];
  if (new Set(split).size !== split.length || split.some(v => !venues.includes(v))) throw new Error('invalid_product_scope');
  const scopes = venues.flatMap<{ venue: Venue; product: MarketType | undefined }>(venue => split.includes(venue) ? [{venue, product:'spot' as MarketType}, {venue, product:'swap' as MarketType}] : [{venue, product:undefined}]);
  const states: VenueState[] = scopes.map(({venue,product}) => ({ venue, ...(product ? {product} : {}), exchange: null, epoch: 0, catalog: new Map(), catalogAt: null,
    catalogCode: 'catalog_not_loaded', priceCode: null, retryAt: 0, failures: 0, nextCatalogAt: 0, watchers: new Map(), catalogWork: null, opening: null, pollCursor: 0, controller: new AbortController() }));
  let stopped = false, lastPoll: number | null = null, queued = 0;
  let demand = new Map<string, Demand>(), refreshWork: Promise<void> | null = null;
  let demandWork: Promise<void> = Promise.resolve(), stopWork: Promise<void> | null = null;
  const locate = (id: string) => states.find(s => s.catalog.has(id));
  const catalogFresh = (s: VenueState) => !stopped && s.catalogCode === null && s.catalogAt !== null && now() >= s.catalogAt && now() - s.catalogAt < ttl;
  const fresh = (t: PriceTick, at = now()) => Number.isSafeInteger(t.timestamp) && t.timestamp >= 0 && t.timestamp <= at + skew && at - t.timestamp <= freshness && Number.isSafeInteger(t.receivedAt) && t.receivedAt <= at && at - t.receivedAt <= freshness;
  function clear(d: Demand) { queued -= d.queue.length; d.queue = []; d.latest = null; d.seen.clear(); }
  function invalidate(s: VenueState, code: string) {
    for (const [id, d] of demand) if (s.catalog.has(id)) {
      // Preserve deduplication across reconnects: cached replay must not re-trigger.
      queued -= d.queue.length; d.queue = []; d.latest = null;
      if (d.code !== 'trade_queue_overflow' && d.code !== 'trade_replay_capacity') d.code = code;
    }
  }
  async function close(exchange: CcxtExchange | null) {
    if (exchange) try { await deadline(() => exchange.close(), closeTimeout); } catch { /* bounded close; epoch rejects late arrivals */ }
  }
  async function retire(s: VenueState): Promise<void> {
    s.epoch++; s.controller.abort(); s.controller = new AbortController();
    const old = s.exchange; s.exchange = null; s.watchers.clear();
    await close(old);
  }
  async function fault(s: VenueState, epoch: number, code: string): Promise<void> {
    if (stopped || epoch !== s.epoch) return;
    s.priceCode = code; s.failures++; s.retryAt = now() + Math.min(retryMax, retryBase * 2 ** Math.min(s.failures - 1, 16));
    invalidate(s, code);
    await retire(s);
  }
  async function open(s: VenueState): Promise<void> {
    if (stopped || s.exchange || now() < s.retryAt) return;
    if (s.opening) return s.opening;
    const epoch = s.epoch;
    s.opening = (async () => {
      try {
        // A late factory result is closed, even when its outer deadline already expired.
        const exchange = await deadline(async () => {
          const result = await options.factory(s.venue, { mode: options.mode, timeoutMs: timeout, tradesLimit: maxBatch, ...(s.product ? {product:s.product} : {}) });
          if (stopped || epoch !== s.epoch) { await close(result); throw new Error('obsolete_factory'); }
          return result;
        }, timeout, s.controller.signal);
        if (stopped || epoch !== s.epoch) { await close(exchange); return; }
        s.exchange = exchange;
        if (exchange.has[options.mode === 'stream' ? 'watchTrades' : 'fetchTrades'] !== true || options.mode === 'stream' && !exchange.watchTrades) throw new Error('trades_unsupported');
        // Every newly constructed instance explicitly loads metadata before trades.
        const raw = await deadline(() => exchange.loadMarkets(true), timeout, s.controller.signal);
        if (stopped || epoch !== s.epoch || s.exchange !== exchange) return;
        applyCatalog(s, scopedCatalog(s, raw, exchange.precisionMode));
      } catch { if (epoch === s.epoch && !stopped) { s.catalogCode = 'catalog_unavailable'; s.nextCatalogAt = now() + retryBase; await fault(s, epoch, 'exchange_unavailable'); } }
    })().finally(() => { s.opening = null; });
    return s.opening;
  }
  function scopedCatalog(s: VenueState, raw: unknown, precisionMode: number) {
    const next = normalizeCatalog(s.venue, raw, precisionMode, maxCatalog);
    if (s.product && [...next.values()].some(m => m.type !== s.product)) throw new Error('catalog_scope');
    if (next.size + states.filter(other => other !== s && other.venue === s.venue).reduce((sum, other) => sum + other.catalog.size, 0) > maxCatalog) throw new Error('catalog_capacity');
    return next;
  }
  function applyCatalog(s: VenueState, next: Map<string, NormalizedMarket>): boolean {
    let subscriptionsChanged = false;
    for (const [id, d] of demand) {
      const old = s.catalog.get(id), replacement = next.get(id);
      if (old && (!replacement || JSON.stringify(old) !== JSON.stringify(replacement))) {
        subscriptionsChanged = true; const overflowed = d.code === 'trade_queue_overflow'; clear(d);
        d.code = overflowed ? 'trade_queue_overflow' : replacement ? 'metadata_changed' : 'market_delisted'; d.first = true; d.since = now(); d.cursor = d.since;
      }
      if (!old && replacement && d.code !== 'trade_queue_overflow') { d.code = 'price_not_observed'; d.first = true; d.since = now(); d.cursor = d.since; }
    }
    // Preserve watcher references for unchanged rows in a complete refresh.
    for (const [id, market] of next) { const old = s.catalog.get(id); if (old && JSON.stringify(old) === JSON.stringify(market)) next.set(id, old); }
    s.catalog = next; s.catalogAt = now(); s.catalogCode = null; s.nextCatalogAt = now() + ttl;
    return subscriptionsChanged;
  }
  async function catalog(s: VenueState): Promise<void> {
    if (stopped) return;
    if (s.catalogWork) return s.catalogWork;
    s.catalogWork = (async () => {
      if (!s.exchange) { await open(s); return; }
      if (now() < s.nextCatalogAt) return;
      const epoch = s.epoch, exchange = s.exchange;
      try {
        const raw = await deadline(() => exchange.loadMarkets(true), timeout, s.controller.signal);
        if (stopped || epoch !== s.epoch) return;
        const changed = applyCatalog(s, scopedCatalog(s, raw, exchange.precisionMode));
        if (changed && options.mode === 'stream') {
          // applyCatalog already invalidated changed/delisted instruments. Keep
          // accepted observations for every unchanged row while retiring sockets.
          await retire(s); await open(s);
        }
      } catch {
        if (epoch === s.epoch && !stopped) {
          s.catalogCode = 'catalog_unavailable'; s.nextCatalogAt = now() + retryBase;
          // Retire even a metadata timeout: CCXT may still finish loadMarkets on
          // the old instance. It must never overwrite a later complete snapshot.
          await fault(s, epoch, 'catalog_unavailable');
        }
      }
    })().finally(() => { s.catalogWork = null; });
    return s.catalogWork;
  }
  function overflow(d: Demand) { clear(d); d.code = 'trade_queue_overflow'; }
  function accept(s: VenueState, market: NormalizedMarket, d: Demand, raw: unknown) {
    if (!Array.isArray(raw)) throw new Error('invalid_trade_batch');
    // A saturated stream cache may have lost updates, so fail closed. REST polls
    // sample just the latest valid trade; a full page makes no completeness claim.
    if (options.mode === 'stream' && raw.length >= maxBatch) { overflow(d); return; }
    if (d.code === 'trade_queue_overflow') return;
    const receivedAt = now();
    // Remove expired observations before capacity accounting; fresh crossings stay.
    const retained = d.queue.filter(t => fresh(t, receivedAt));
    queued -= d.queue.length - retained.length; d.queue = retained;
    const candidates: { tick: PriceTick; key: string }[] = [];
    for (const row of raw) {
      if (!record(row) || row.symbol !== market.symbol || typeof row.price !== 'number' || !Number.isFinite(row.price) || row.price <= 0 || row.price > 1e12 || typeof row.timestamp !== 'number') continue;
      const tick: PriceTick = { instrument: market.instrument, price: row.price, timestamp: row.timestamp, receivedAt };
      if (!fresh(tick, receivedAt)) continue;
      // CCXT IDs may be absent. Include price/amount/side in the fallback identity.
      if (row.id != null && (typeof row.id !== 'string' || row.id.length > 128) || row.amount != null && (typeof row.amount !== 'number' || !Number.isFinite(row.amount) || row.amount <= 0)) continue;
      const key = row.id ? `${tick.timestamp}:${row.id}` : `${tick.timestamp}:${tick.price}:${typeof row.amount === 'number' ? row.amount : ''}:${row.side === 'buy' || row.side === 'sell' ? row.side : ''}`;
      candidates.push({ tick, key });
    }
    candidates.sort((a, b) => a.tick.timestamp - b.tick.timestamp);
    let selected = options.mode === 'polling'
      ? candidates.length ? [candidates[candidates.length - 1]!] : []
      : candidates.filter(t => t.tick.timestamp >= d.since);
    // A first fresh observation can initialize a rule before the demand boundary.
    // Subsequent polls may sample distinct IDs at the cursor timestamp, but never
    // move backwards or fall back to an earlier row when the latest is a replay.
    if (d.first && selected.length === 0 && candidates.length) selected = [candidates[candidates.length - 1]!];
    // Timestamp order is monotonic across updates/reconnects. Retain identities
    // only at the cursor, so ACKed high-volume traffic cannot fill the queue cap.
    // Older replay is rejected even after its IDs have left this bounded history.
    if (!d.first) selected = selected.filter(t => d.code === 'trade_replay_capacity'
      ? t.tick.timestamp > d.cursor : t.tick.timestamp >= d.cursor);
    const next: typeof candidates = [], batchKeys = new Set<string>();
    for (const t of selected) if (!d.seen.has(t.key) && !batchKeys.has(t.key)) { next.push(t); batchKeys.add(t.key); }
    if (queued + next.length > maxQueue) { overflow(d); return; }
    const newest = next.at(-1)?.tick.timestamp;
    if (newest !== undefined) {
      const replay = new Set(newest === d.cursor ? d.seen.keys() : []);
      for (const t of next) if (t.tick.timestamp === newest) replay.add(t.key);
      if (replay.size > maxReplay) {
        // Completeness at this timestamp is no longer provable. Fail closed but
        // recover on a strictly newer trade rather than a permanent queue fault.
        clear(d); d.cursor = newest; d.first = false; d.code = 'trade_replay_capacity'; return;
      }
    }
    for (const { tick, key } of next) {
      if (d.first || tick.timestamp > d.cursor) d.seen.clear();
      d.seen.set(key, tick.timestamp); d.queue.push(tick); queued++;
      if (!d.latest || tick.timestamp >= d.latest.timestamp) d.latest = tick;
      d.cursor = d.first ? tick.timestamp : Math.max(d.cursor, tick.timestamp);
      d.first = false;
    }
    if (next.length) { d.first = false; d.code = null; s.priceCode = null; s.failures = 0; s.retryAt = 0; lastPoll = receivedAt; }
  }
  function startWatchers(s: VenueState) {
    if (options.mode !== 'stream' || !s.exchange || !catalogFresh(s)) return;
    const exchange = s.exchange, epoch = s.epoch;
    for (const [id, d] of demand) {
      const market = s.catalog.get(id);
      if (!market || s.watchers.has(id) || d.code === 'trade_queue_overflow') continue;
      const task = (async () => {
        try {
          while (!stopped && epoch === s.epoch && demand.get(id) === d && s.catalog.get(id) === market && catalogFresh(s) && d.code !== 'trade_queue_overflow') {
            // Quiet markets do not imply a lost connection. CCXT's transport
            // heartbeat rejects actual socket faults; our abort still bounds stop.
            const raw = await deadline(() => exchange.watchTrades!(market.symbol), null, s.controller.signal);
            if (stopped || epoch !== s.epoch || demand.get(id) !== d || s.catalog.get(id) !== market || !catalogFresh(s)) return;
            accept(s, market, d, raw);
            // Prevent an immediately resolved empty adapter from starving the event loop.
            await new Promise<void>(resolve => setTimeout(resolve, 1));
          }
        } catch {
          if (demand.get(id) === d && s.catalog.get(id) === market && catalogFresh(s)) await fault(s, epoch, 'stream_unavailable');
        }
        finally { if (epoch === s.epoch) s.watchers.delete(id); }
      })();
      // The complete task catches every asynchronous failure, including fault/close.
      s.watchers.set(id, task.catch(() => { if (!stopped && epoch === s.epoch) s.priceCode = 'stream_unavailable'; }));
    }
  }
  async function poll(s: VenueState, budget: { end: number; requests: number; demand: Map<string, Demand>; visited: Set<Demand> }, allowance: number) {
    if (!s.exchange || !catalogFresh(s)) return;
    const exchange = s.exchange, epoch = s.epoch;
    // Bounded fair rotation; sequential per venue respects CCXT rate limiting.
    const entries = [...budget.demand].filter(([id]) => s.catalog.has(id));
    const end = budget.end, startRequests = budget.requests;
    for (let scanned = 0; scanned < entries.length && budget.requests - startRequests < allowance && budget.requests < maxPollRequests && performance.now() < end; scanned++) {
      s.pollCursor %= entries.length;
      const [id, d] = entries[s.pollCursor]!; s.pollCursor++;
      const market = s.catalog.get(id);
      if (!market || demand.get(id) !== d || budget.visited.has(d) || d.code === 'trade_queue_overflow' || now() < d.nextPollAt) continue;
      budget.visited.add(d); budget.requests++;
      try {
        const raw = await deadline(() => exchange.fetchTrades(market.symbol, undefined, maxBatch), Math.max(1, Math.min(timeout, Math.ceil(end - performance.now()))), s.controller.signal);
        if (stopped || epoch !== s.epoch) return;
        if (demand.get(id) === d && s.catalog.get(id) === market && catalogFresh(s)) { accept(s, market, d, raw); d.nextPollAt = now() + pollInterval; }
      } catch (error) {
        if (stopped || epoch !== s.epoch) return;
        if (demand.get(id) === d && s.catalog.get(id) === market && catalogFresh(s)) {
          if (error instanceof SymbolTradesUnavailableError && error.symbol === market.symbol) {
            // Discard unconsumed observations too, but keep the cursor/IDs so a
            // later cached replay cannot become a new crossing after recovery.
            queued -= d.queue.length; d.queue = []; d.latest = null;
            if (d.code !== 'trade_replay_capacity') d.code = 'no_fresh_trade';
            d.nextPollAt = now() + pollInterval;
            continue;
          }
          await fault(s, epoch, 'poll_unavailable');
        }
        return;
      }
    }
  }
  const eligible = (id: string) => { const s = locate(id); return !!s && catalogFresh(s) && !['trade_queue_overflow', 'trade_replay_capacity'].includes(demand.get(id)?.code ?? ''); };
  const available = (id: string, d: Demand) => eligible(id) && d.code === null;
  const samples = (id: string) => { const d = demand.get(id); return d && available(id, d) ? d.queue.filter(t => fresh(t)).map(t => ({ ...t })) : []; };
  const ticks = () => new Map([...demand].flatMap(([id, d]) => d.latest && available(id, d) && fresh(d.latest) ? [[id, { ...d.latest }] as const] : []));
  async function refreshCatalog() { await Promise.all(states.map(catalog)); }
  const productCursor = new Map<Venue, number>();
  function refresh(): Promise<void> {
    if (refreshWork) return refreshWork;
    refreshWork = (async () => { await refreshCatalog(); if (!stopped) await Promise.all(venues.map(async venue => {
      const group = states.filter(s => s.venue === venue);
      if (options.mode === 'stream') { group.forEach(startWatchers); return; }
      const budget = {end:performance.now()+pollBudget, requests:0, demand:new Map(demand), visited:new Set<Demand>()};
      const start = productCursor.get(venue) ?? 0;
      // Alternate the first product even when a timeout exhausts the whole budget.
      productCursor.set(venue, (start + 1) % group.length);
      const ordered = [...group.slice(start), ...group.slice(0, start)];
      while (!stopped && budget.requests < maxPollRequests && performance.now() < budget.end) {
        const before = budget.requests;
        for (const s of ordered) await poll(s, budget, 1);
        if (budget.requests === before) break;
      }
    })); })().finally(() => { refreshWork = null; });
    return refreshWork;
  }
  function setDemand(instruments: readonly string[]): Promise<void> {
    // Copy synchronously; caller mutation cannot alter queued changes.
    const ids = [...new Set(instruments)];
    const task = demandWork.then(async () => {
      if (stopped) throw new Error('market_source_stopped');
      if (ids.length > maxDemand) throw new Error('demand_capacity');
      // Active SQL rules survive outages and delisting. Keep their demand while
      // per-market eligibility prevents evaluation; one venue cannot block others.
      if (ids.some(id => { const identity = parseInstrumentIdentity(id); return !identity || !venues.includes(identity.venue); })) throw new Error('instrument_unavailable');
      const next = new Set(ids), affected = new Set<VenueState>();
      for (const [id, d] of demand) if (!next.has(id)) { const s = locate(id); if (s) affected.add(s); clear(d); demand.delete(id); }
      for (const id of ids) if (!demand.has(id)) {
        const identity = parseInstrumentIdentity(id)!;
        const venueState = states.find(s => s.venue === identity.venue && (!s.product || s.product === identity.type))!;
        affected.add(venueState); const at = now();
        demand.set(id, { since: at, cursor: at, first: true, queue: [], latest: null, code: 'price_not_observed', seen: new Map(), nextPollAt: 0 });
      }
      // Restart shared venue sockets on subscription changes, avoiding orphan subscriptions.
      // Epoch retirement rejects future obsolete arrivals; unchanged demand keeps
      // its accepted queue, latest observation and replay cursor for evaluation.
      if (options.mode === 'stream') await Promise.all([...affected].map(retire));
    });
    demandWork = task.catch(() => {}); return task;
  }
  function stop(): Promise<void> {
    if (stopWork) return stopWork;
    stopped = true;
    for (const d of demand.values()) clear(d);
    demand.clear();
    stopWork = Promise.all(states.map(retire)).then(() => {}); return stopWork;
  }
  return {
    mode: options.mode, refreshCatalog, refresh, setDemand, stop, eligible, samples,
    resolve(instrument) {
      const identity = parseInstrumentIdentity(instrument);
      const scopes = identity ? states.filter(s => s.venue === identity.venue && (!s.product || s.product === identity.type)) : [];
      const selected = scopes.find(s => s.catalog.has(instrument))?.catalog.get(instrument);
      const available = !!selected && eligible(instrument);
      return { market: selected ? { ...selected, available } : null, stale: !scopes.length || scopes.some(s => !catalogFresh(s)), available };
    },
    acknowledgeSamples(id, captured) {
      const d = demand.get(id); if (!d) return;
      const key = (t: PriceTick) => JSON.stringify([t.instrument, t.price, t.timestamp, t.receivedAt]);
      const counts = new Map<string, number>();
      for (const t of captured) counts.set(key(t), (counts.get(key(t)) ?? 0) + 1);
      const retained = d.queue.filter(t => {
        const k = key(t), count = counts.get(k) ?? 0;
        if (!count) return true;
        counts.set(k, count - 1); return false;
      });
      queued -= d.queue.length - retained.length; d.queue = retained;
    },
    drainSamples(id) { const result = samples(id), d = demand.get(id); if (d) { queued -= d.queue.length; d.queue = []; } return result; },
    ticks, getPrices: () => [...ticks().values()], lastPollAt: () => lastPoll,
    getMarkets() {
      const ats = states.map(s => s.catalogAt);
      return { markets: states.flatMap(s => [...s.catalog.values()].map(m => ({ ...m, available: eligible(m.instrument) }))), updatedAt: ats.some(t => t === null) ? null : Math.min(...ats as number[]), stale: states.some(s => !catalogFresh(s)),
        sources: states.map(s => ({ venue: s.venue, ...(s.product ? {type:s.product} : {}), updatedAt: s.catalogAt, stale: !catalogFresh(s), code: s.catalogCode })) };
    },
    priceHealth() {
      const current = ticks().size;
      const code = stopped ? 'market_source_stopped' : [...demand.values()].find(d => d.code === 'trade_queue_overflow' || d.code === 'trade_replay_capacity')?.code ?? states.find(s => s.priceCode)?.priceCode ?? (current < demand.size ? 'prices_empty_or_stale' : null);
      return { state: !current ? 'unhealthy' : code || current < demand.size ? 'degraded' : 'healthy', lastSuccessAt: lastPoll, code: code ?? (!current ? 'no_demand' : null) };
    },
    diagnostics() {
      return { stopped, queued, queueCapacity: maxQueue, demandCapacity: maxDemand, replayCapacity: maxReplay,
        // A constructed CCXT client does not establish socket connectivity.
        venues: states.map(s => ({ venue: s.venue, ...(s.product ? {type:s.product} : {}), catalogAt: s.catalogAt, catalogCode: s.catalogCode, priceCode: s.priceCode, retryAt: s.retryAt, clientOpen: !!s.exchange })),
        instruments: [...demand].map(([instrument, d]) => ({ instrument, code: d.code, queued: d.queue.length, replayEntries: d.seen.size })) };
    },
  };
}
