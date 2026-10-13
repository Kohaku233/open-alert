import type { AppConfig } from '../config.js';
import type { OutboxRecord, Repositories, SchedulableAlertRecord, SchedulerLease, SqlDatabase } from '../contracts/db.js';
import type { ComponentHealth, PriceTick, SystemStatus } from '../contracts/domain.js';
import type { MarketSource } from '../markets/source.js';
import { createNotificationService } from '../notifications/service.js';
import type { DeliveryResult } from '../notifications/service.js';
import type { Fetch } from '../notifications/http.js';
import { createMarketCache, freshTick } from './market.js';

export interface SchedulerNotifications {
  deliver(event: OutboxRecord): Promise<DeliveryResult>;
  health(): ComponentHealth;
}
export interface SchedulerOptions {
  config: AppConfig; repositories: Repositories; db?: SqlDatabase;
  fetch?: Fetch; now?: () => number; ownerId?: string; notifications?: SchedulerNotifications;
  /** Runtime-owned CCXT source; omitted only for legacy cache compatibility. */
  marketSource?: MarketSource;
  /** Defaults permit one network request plus finish inside a live lease. */
  leaseMs?: number; drainBudgetMs?: number; deliveryTimeoutMs?: number;
  /** Cloudflare defaults: 100 evaluations, 1 reservation, 32 due rows, 1 dispatch. */
  maxEvaluationsPerTick?: number; maxReservationsPerTick?: number;
  duePageSize?: number; maxDueRowsPerDrain?: number; maxDeliveriesPerDrain?: number; maxClaimsPerDrain?: number;
}
export type RuntimeSchedulerService = ReturnType<typeof createScheduler>;
export function overallHealth(components: ComponentHealth[]): SystemStatus['health']['overall'] {
  const states = components.map(component => component.state);
  return states.includes('unhealthy') ? 'unhealthy' : states.includes('starting') ? 'starting' : states.includes('degraded') ? 'degraded' : 'healthy';
}
const bounded = (value: number, min: number, max: number, code: string) => {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new RangeError(code);
  return value;
};
/** Single instance shared by runtime HTTP, timers and DO alarms. DB is authoritative. */
export function createScheduler(options: SchedulerOptions) {
  const { config, repositories: r } = options, now = options.now ?? Date.now;
  const ownerId = options.ownerId ?? crypto.randomUUID();
  const leaseMs = bounded(options.leaseMs ?? 40_000, 15_000, 60_000, 'invalid_lease_duration');
  const deliveryTimeoutMs = bounded(options.deliveryTimeoutMs ?? config.runtime.requestTimeoutMs + 1000, 1, 10_000, 'invalid_delivery_timeout');
  const drainBudgetMs = bounded(options.drainBudgetMs ?? 25_000, 1, 30_000, 'invalid_drain_budget');
  if (deliveryTimeoutMs + 5000 >= leaseMs) throw new RangeError('invalid_delivery_lease_budget');
  const cloudflare = config.deployment === 'cloudflare';
  const maxEvaluations = bounded(options.maxEvaluationsPerTick ?? (cloudflare ? 100 : 1000), 1, 1000, 'invalid_evaluation_limit');
  const maxReservations = bounded(options.maxReservationsPerTick ?? (cloudflare ? 1 : 1000), 1, 1000, 'invalid_reservation_limit');
  const duePageSize = bounded(options.duePageSize ?? (cloudflare ? 32 : 500), 1, 500, 'invalid_due_page_size');
  const maxDueRows = bounded(options.maxDueRowsPerDrain ?? (cloudflare ? 32 : 2000), 1, 2000, 'invalid_due_scan_limit');
  const maxClaims = bounded(options.maxClaimsPerDrain ?? (cloudflare ? 1 : 2000), 1, 2000, 'invalid_claim_limit');
  const maxDeliveries = bounded(options.maxDeliveriesPerDrain ?? (cloudflare ? 1 : 20), 1, 20, 'invalid_delivery_limit');
  const notifications = options.notifications ?? createNotificationService({ config, repositories: r, ...(options.fetch ? { fetch: options.fetch } : {}), now });
  const source = options.marketSource;
  const market = source ?? createMarketCache({ ...(options.fetch ? { fetch: options.fetch } : {}), now });
  // A captured batch belongs to every rule for an instrument, even across bounded
  // cycles. Acknowledgement removes only that capture; concurrent arrivals remain.
  const sampleBatches = new Map<string, { samples: readonly PriceTick[]; inspected: Set<string>; offsets: Map<string, number> }>();
  const sampleKey = (sample: PriceTick) => JSON.stringify([sample.instrument, sample.price, sample.timestamp, sample.receivedAt]);
  const ruleKey = (rule: SchedulableAlertRecord) => JSON.stringify([rule.id, rule.generation, rule.settingsGeneration, rule.channelGeneration, rule.updatedAt]);
  let lease: SchedulerLease | null = null, leaseWork: Promise<SchedulerLease | null> | null = null;
  let tickWork: Promise<void> | null = null, drainWork: Promise<void> | null = null, stopWork: Promise<void> | null = null;
  let stopped = false, fatal = false, timer: ReturnType<typeof setInterval> | undefined;
  let dirty = 1, refreshed = 0, rulesAt: number | null = null;
  let evaluationRules: SchedulableAlertRecord[] = [], evaluationCursor = 0;
  let evaluationAfter: { instrument: string; id: string } | null = null;
  let schedulerSuccess: number | null = null, schedulerCode: string | null = null;
  let databaseSuccess: number | null = null, databaseCode: string | null = null;
  let lastUser: string | null = null;
  let providerBlocked = false;
  let confirmedWork: boolean | null = null;
  async function hasWork(): Promise<boolean> {
    try {
      const version = dirty;
      const work = await r.scheduler.hasWork(!!config.sharedPushoverAppToken);
      confirmedWork = version === dirty ? work : null;
      // A successful authoritative read proves initial DB readiness, but cannot clear
      // a failed reservation/delivery merely because this cheaper query succeeded.
      if (databaseCode === null) databaseSuccess = now();
      return work;
    } catch { confirmedWork = null; databaseCode = 'database_unavailable'; throw new Error('database_unavailable'); }
  }
  let dueCursor: { nextAt: number; triggerId: string } | undefined;
  // Persist selected users between bounded drains so a large early user's backlog cannot starve later users.
  const pending = new Map<string, OutboxRecord[]>();
  let pendingCount = 0;

  function getLease(minRemainingMs = 0): Promise<SchedulerLease | null> {
    if (stopped || fatal) return Promise.resolve(null);
    if (leaseWork) return leaseWork;
    // Writes still validate the live SQL owner/fence; this only avoids redundant renewals.
    if (lease && lease.expiresAt - now() > Math.max(leaseMs / 2, minRemainingMs)) return Promise.resolve(lease);
    leaseWork = (async () => {
      try {
        const at = now();
        if (lease && lease.expiresAt > at) {
          const renewed = await r.scheduler.renewLease(lease, at, leaseMs);
          if (!renewed) { lease = null; schedulerCode = 'lease_lost'; return null; }
          lease = renewed; databaseSuccess = now(); databaseCode = null; return lease;
        }
        lease = null;
        const acquired = await r.scheduler.acquireLease(ownerId, at, leaseMs);
        if (!acquired) { schedulerCode = 'lease_unavailable'; return null; }
        // Recovery runs before ANY claim/reservation using the new fence.
        await r.scheduler.recoverInterrupted(acquired, now());
        await r.tests.recoverInterrupted(now());
        lease = acquired; dirty++; databaseSuccess = now(); databaseCode = null;
        return lease;
      } catch { lease = null; databaseCode = 'database_unavailable'; schedulerCode = 'lease_failed'; return null; }
    })().finally(() => { leaseWork = null; });
    return leaseWork;
  }
  async function refreshRules(): Promise<void> {
    if (refreshed === dirty && rulesAt !== null && now() - rulesAt < config.runtime.activeRulesRefreshMs) return;
    const version = dirty, next: SchedulableAlertRecord[] = [], users = new Set<string>(), instruments = new Set<string>();
    let cursor: string | undefined, count = 0;
    do {
      const limit = Math.min(500, config.limits.activeAlerts - count);
      if (limit <= 0) throw new Error('rules_limit_exceeded');
      const page = await r.alerts.listActiveWithProfiles(limit, cursor);
      count += page.items.length;
      for (const rule of page.items) { next.push(rule); users.add(rule.userId); instruments.add(rule.instrument); }
      cursor = page.cursor ?? undefined;
    } while (cursor);
    if (instruments.size > config.limits.globalInstruments || users.size > config.limits.users) throw new Error('rules_limit_exceeded');
    // Resume after the last evaluated key even when refresh/invalidation removes that row.
    const after = evaluationAfter;
    const resume = after ? next.findIndex(rule => rule.instrument > after.instrument || (rule.instrument === after.instrument && rule.id > after.id)) : 0;
    evaluationRules = next; evaluationCursor = resume < 0 ? 0 : resume; rulesAt = now(); refreshed = version;
    databaseSuccess = now(); databaseCode = null;
  }
  async function runTick(): Promise<void> {
    if (stopped || fatal) return;
    const ownership = await getLease(); if (!ownership) return;
    try {
      if (source) {
        // SQL rules define demand. Catalog discovery must precede demand validation;
        // unhealthy venues remain in demand so recovery cannot silently drop rules.
        await refreshRules();
        if (stopped) return;
        await source.refreshCatalog();
        if (stopped) return;
        const instruments = [...new Set(evaluationRules.map(rule => rule.instrument))];
        await source.setDemand(instruments);
        for (const instrument of sampleBatches.keys()) if (!instruments.includes(instrument)) sampleBatches.delete(instrument);
        if (stopped) return;
        await source.refresh();
      } else await Promise.all([market.refresh(), refreshRules()]);
      if (stopped) return;
      const catalog = market.getMarkets();
      if (!source && catalog.stale) { schedulerCode = 'catalog_unavailable'; return; }
      const known = new Set(catalog.markets.map(m => m.instrument));
      // Recheck/renew after network and cache work before reservation begins.
      if (!await getLease()) return;
      const ticks = market.ticks();
      const workDeadline = performance.now() + 2500;
      let scanned = 0, reservations = 0, missing = false, interrupted = false;
      const total = evaluationRules.length;
      const groups = new Map<string, SchedulableAlertRecord[]>();
      const snapshots = new Map<string, readonly PriceTick[]>();
      if (source) for (const rule of evaluationRules) {
        const group = groups.get(rule.instrument) ?? []; group.push(rule); groups.set(rule.instrument, group);
      }
      if (source) for (const instrument of groups.keys()) {
        const samples = source.samples(instrument); snapshots.set(instrument, samples);
        const batch = sampleBatches.get(instrument);
        if (batch) {
          const currentKeys = new Set(groups.get(instrument)!.map(ruleKey));
          for (const key of batch.inspected) if (!currentKeys.has(key)) batch.inspected.delete(key);
          for (const key of batch.offsets.keys()) if (!currentKeys.has(key)) batch.offsets.delete(key);
          // Source retirement/overflow invalidates captured observations too.
          // Match values because the source returns defensive tick copies.
          const accepted = new Set(samples.map(sampleKey));
          const retained = batch.samples.filter(sample => accepted.has(sampleKey(sample)));
          if (retained.length) {
            if (retained.length !== batch.samples.length) batch.offsets.clear();
            batch.samples = retained;
          } else sampleBatches.delete(instrument);
        }
      }
      while (scanned < total && scanned < maxEvaluations && reservations < maxReservations && performance.now() < workDeadline) {
        const rule = evaluationRules[evaluationCursor]!; scanned++;
        if (stopped || !lease || lease.expiresAt <= now()) return;
        let batch = source ? sampleBatches.get(rule.instrument) : undefined;
        const key = ruleKey(rule);
        if (!rule.triggered && !batch?.inspected.has(key)) {
          const eligible = source ? source.eligible(rule.instrument) : known.has(rule.instrument);
          const latest = ticks.get(rule.instrument);
          if (!eligible) missing = true;
          else {
            if (source && !batch) {
              batch = { samples: snapshots.get(rule.instrument) ?? [], inspected: new Set(), offsets: new Map() };
              sampleBatches.set(rule.instrument, batch);
            }
            let crossing: PriceTick | undefined, observed = false;
            // A buffered crossing predating an edit/rearm belongs to the old rule.
            // The current latest tick may still initialize a fresh generation.
            const samples = batch?.samples ?? [];
            let offset = batch?.offsets.get(key) ?? 0;
            for (; offset < samples.length; offset++) {
              if (performance.now() >= workDeadline) { interrupted = true; break; }
              const sample = samples[offset]!;
              if (sample.instrument !== rule.instrument || sample.receivedAt < rule.updatedAt || sample.timestamp < rule.updatedAt || !freshTick(sample, now())) continue;
              observed = true;
              if (rule.side === 'upper' ? sample.price >= rule.threshold : sample.price <= rule.threshold) { crossing = sample; break; }
            }
            if (interrupted) { batch?.offsets.set(key, offset); break; }
            batch?.offsets.delete(key);
            if (!crossing && latest && freshTick(latest, now())) {
              observed = true;
              if (rule.side === 'upper' ? latest.price >= rule.threshold : latest.price <= rule.threshold) crossing = latest;
            }
            if (!observed) missing = true;
            if (crossing && (rule.hasPrivateAppToken || config.sharedPushoverAppToken)) {
              if (lease.expiresAt - now() < 10_000 && !await getLease()) return;
              // stop may have arrived while a renewal was pending.
              if (stopped || !lease || lease.expiresAt <= now() || source && !source.eligible(rule.instrument)) return;
              reservations++;
              const reserved = await r.alerts.reserveTrigger({ triggerId: crypto.randomUUID(), alertId: rule.id, userId: rule.userId, generation: rule.generation, settingsGeneration: rule.settingsGeneration, channelGeneration: rule.channelGeneration, tick: crossing, now: now(), lease });
              if (!reserved) {
                // SQL may have fenced a stale rule/profile snapshot. Revalidate next
                // cycle before inspecting or acknowledging its captured crossing.
                invalidate(); interrupted = true; break;
              }
              rule.triggered = true;
            }
            batch?.inspected.add(key);
          }
        }
        evaluationCursor = (evaluationCursor + 1) % total;
        evaluationAfter = { instrument: rule.instrument, id: rule.id };
      }
      // An invalidation after hydration can change even a non-crossing rule.
      // Preserve captures until the next authoritative snapshot inspects them.
      if (source && !stopped && refreshed === dirty) for (const [instrument, batch] of sampleBatches) {
        if (groups.get(instrument)?.every(rule => rule.triggered || batch.inspected.has(ruleKey(rule)))) {
          source.acknowledgeSamples(instrument, batch.samples); sampleBatches.delete(instrument);
        }
      }
      schedulerSuccess = now(); schedulerCode = interrupted || scanned < total ? 'cycle_budget_exceeded' : missing ? 'active_price_missing' : null;
      databaseSuccess = now(); databaseCode = null;
    } catch (error) {
      databaseCode = 'database_unavailable'; schedulerCode = 'cycle_failed';
      // A broken atomic reservation must halt the coordinator, not continue evaluating.
      if (error instanceof Error && error.message === 'Trigger reservation invariant failed') { fatal = true; schedulerCode = 'reservation_invariant_failed'; }
    }
  }
  function tick(): Promise<void> {
    if (tickWork) return tickWork;
    tickWork = runTick().finally(() => { tickWork = null; }); return tickWork;
  }
  async function collectDue(): Promise<void> {
    // Bounded keyset scan, including multiple users before round-robin. Carry leftovers across drains.
    const capacity = Math.min(config.limits.activeAlerts, cloudflare ? 64 : 2000);
    const ids = new Set([...pending.values()].flatMap(events => events.map(e => e.triggerId)));
    let scanned = 0;
    while (pendingCount < capacity && scanned < maxDueRows) {
      const limit = Math.min(duePageSize, capacity - pendingCount, maxDueRows - scanned);
      const rows = await r.scheduler.listDue(now(), limit, dueCursor);
      scanned += rows.length;
      for (const event of rows) {
        if (ids.has(event.triggerId)) continue;
        const list = pending.get(event.userId) ?? [];
        // Keep a small share per user while advancing the SQL cursor through large backlogs.
        // Skipped queued rows stay in SQL and are revisited after the cursor wraps.
        if (list.length >= maxDeliveries) continue;
        ids.add(event.triggerId); list.push(event); pending.set(event.userId, list); pendingCount++;
      }
      const last = rows.at(-1);
      dueCursor = last ? { nextAt: last.nextAt, triggerId: last.triggerId } : undefined;
      if (rows.length < limit) { dueCursor = undefined; break; }
    }
  }
  function takeNext(): OutboxRecord | null {
    const users = [...pending.keys()].sort(); if (!users.length) return null;
    const user = users.find(id => lastUser === null || id > lastUser) ?? users[0]!;
    const list = pending.get(user)!; const next = list.shift()!;
    if (!list.length) pending.delete(user); pendingCount--; lastUser = user; return next;
  }
  async function boundedDelivery(event: OutboxRecord): Promise<DeliveryResult> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const operation = Promise.resolve().then(() => notifications.deliver(event));
      void operation.then(() => { providerBlocked = false; }, () => { providerBlocked = false; });
      return await Promise.race([
        operation,
        new Promise<DeliveryResult>(resolve => { timer = setTimeout(() => { providerBlocked = true; resolve({ outcome: 'uncertain', code: 'provider_deadline_uncertain', receipt: null }); }, deliveryTimeoutMs); }),
      ]);
    } catch { return { outcome: 'uncertain', code: 'provider_uncertain', receipt: null }; }
    finally { if (timer !== undefined) clearTimeout(timer); }
  }
  async function runDrain(): Promise<void> {
    if (stopped || fatal || providerBlocked || !await getLease()) return;
    const deadline = performance.now() + drainBudgetMs;
    let outstandingClaim = false;
    try {
      await collectDue();
      let dispatched = 0, claims = 0;
      while (dispatched < maxDeliveries && claims < maxClaims && performance.now() + deliveryTimeoutMs < deadline && !stopped && !fatal) {
        const ownership = await getLease(deliveryTimeoutMs + 5000); if (!ownership || ownership.expiresAt <= now() + deliveryTimeoutMs + 5000) break;
        const event = takeNext(); if (!event) break;
        const claimId = crypto.randomUUID(); claims++;
        const claimed = await r.scheduler.claimDelivery(event.triggerId, claimId, ownership, now());
        if (!claimed) continue;
        outstandingClaim = true;
        // The HTTP request follows a committed claim and current lease. No automatic resend on ambiguity.
        if (stopped || lease?.fence !== ownership.fence || ownership.expiresAt <= now() + deliveryTimeoutMs) break;
        dispatched++;
        const result = await boundedDelivery(claimed);
        const phase = result.outcome === 'failed' && result.code === 'provider_rejected' ? 'queued' : result.outcome;
        const safeCodes = new Set(['provider_rejected','provider_transport_uncertain','provider_response_uncertain','provider_deadline_uncertain','provider_uncertain','channel_unavailable','channel_changed','notification_failed','notification_input_invalid','delivery_not_claimed']);
        const code = result.code === null ? null : safeCodes.has(result.code) ? result.code : 'notification_failed';
        // Never reacquire to finish an old claim. SQL finish still checks its owner/fence.
        const currentLease = lease?.fence === ownership.fence ? lease : ownership;
        const finishLease = currentLease.expiresAt - now() > leaseMs / 2 ? currentLease : await r.scheduler.renewLease(ownership, now(), leaseMs);
        if (!finishLease) { lease = null; schedulerCode = 'lease_lost'; return; }
        if (lease?.fence === finishLease.fence) lease = finishLease;
        const saved = await r.scheduler.finishDelivery(claimed.triggerId, claimId, finishLease, phase, code, result.receipt, now());
        if (!saved) { schedulerCode = 'finish_not_committed'; return; }
        outstandingClaim = false;
        databaseSuccess = now(); databaseCode = null;
        if (providerBlocked) { schedulerCode = 'provider_deadline_uncertain'; return; }
      }
    } catch { databaseCode = 'database_unavailable'; schedulerCode = 'delivery_cycle_failed'; }
    finally {
      if (outstandingClaim) {
        // A committed sending claim must not remain on a perpetually renewed fence.
        // Reacquisition runs recovery and marks it uncertain, without another dispatch.
        const abandoned = lease; lease = null;
        if (abandoned) await r.scheduler.releaseLease(abandoned, now()).catch(() => {});
      }
    }
  }
  function drain(): Promise<void> { if (drainWork) return drainWork; drainWork = runDrain().finally(() => { drainWork = null; }); return drainWork; }
  function invalidate(): void { dirty++; confirmedWork = null; }
  async function cycle(): Promise<void> { await tick(); await drain(); }
  function start(): void {
    if (timer || stopWork || fatal || source && stopped) return;
    stopped = false;
    const background = () => { void tick().then(() => drain()).catch(() => { schedulerCode = 'cycle_failed'; }); };
    background(); timer = setInterval(background, config.runtime.pollIntervalMs);
  }
  function stop(): Promise<void> {
    if (stopWork) return stopWork;
    stopped = true; if (timer !== undefined) clearInterval(timer); timer = undefined;
    stopWork = (async () => {
      // Stop first so bounded source cancellation can unblock a running refresh.
      // Keep the fence until all in-flight DB/provider work has settled.
      await Promise.allSettled([Promise.resolve().then(() => source?.stop()), tickWork, drainWork, leaseWork]);
      sampleBatches.clear();
      if (lease) { await r.scheduler.releaseLease(lease, now()); lease = null; }
    })().finally(() => { stopWork = null; }); return stopWork;
  }
  function status() {
    const scheduler: ComponentHealth = { state: fatal || stopped || !lease || lease.expiresAt <= now() ? 'unhealthy' : schedulerCode || schedulerSuccess === null || now() - schedulerSuccess > config.runtime.watchdogMs ? 'degraded' : 'healthy', lastSuccessAt: schedulerSuccess, code: schedulerCode ?? (stopped ? 'stopped' : !lease || lease.expiresAt <= now() ? 'lease_unavailable' : schedulerSuccess !== null && now() - schedulerSuccess > config.runtime.watchdogMs ? 'watchdog_overdue' : null) };
    const database: ComponentHealth = { state: databaseCode ? 'unhealthy' : databaseSuccess === null ? 'starting' : 'healthy', lastSuccessAt: databaseSuccess, code: databaseCode };
    const prices = market.priceHealth(), notificationHealth = { ...notifications.health() };
    if (schedulerCode === 'active_price_missing' && prices.state === 'healthy') { prices.state = 'degraded'; prices.code = 'active_price_missing'; }
    if (providerBlocked) { notificationHealth.state = 'degraded'; notificationHealth.code = 'provider_deadline_uncertain'; }
    const email: ComponentHealth = { state: 'starting', lastSuccessAt: null, code: null };
    // Runtime/API fills actual email health. It must not falsely make the shared scheduler unhealthy.
    if (confirmedWork === false) {
      if (!fatal && !stopped && (schedulerCode === null || schedulerCode === 'cycle_budget_exceeded' || schedulerCode === 'active_price_missing')) { scheduler.state = 'degraded'; scheduler.code = 'idle_no_active_alerts'; }
      // Expected absent/stale idle prices differ from a failed provider request.
      if (prices.code === null || prices.code === 'prices_empty_or_stale' || prices.code === 'no_demand') { prices.state = 'degraded'; prices.code = 'idle_no_active_alerts'; }
    }
    if (notificationHealth.state === 'starting' && notificationHealth.code === null) {
      notificationHealth.state = 'degraded'; notificationHealth.code = 'provider_not_checked';
    }
    const overall = overallHealth([database, scheduler, prices, notificationHealth]);
    const health: SystemStatus['health'] = { overall, database, scheduler, prices, notifications: notificationHealth, email };
    return { health, prices: market.getPrices(), notifications: notificationHealth, lastPollAt: market.lastPollAt(), ...(source?.mode ? { marketMode: source.mode } : {}), coordinatorId: 'coordinator-v1' as const, pollIntervalMs: 5000 as const, running: !stopped && !fatal, leaseFence: lease?.fence ?? null };
  }
  return { start, stop, tick, cycle, once: cycle, drain, invalidate, invalidateRules: invalidate,
    async wake() { invalidate(); await tick(); },
    /** Cheap DB probe for DO idle alarms; no lease, prices, or profile hydration. */
    hasWork,
    /** Catalog only, safe for HTTP market discovery without starting a polling cycle. */
    refreshCatalog: market.refreshCatalog,
    getMarkets: market.getMarkets, getPrices: market.getPrices, status, getStatus: status,
    async snapshot() { await hasWork(); const s = status(); return { health: s.health, lastPollAt: s.lastPollAt, prices: s.prices, ...(s.marketMode ? { marketMode: s.marketMode } : {}) }; },
    catalog: { async get() { return market.getMarkets(); } },
    isInstrumentSupported(instrument: string) { if (source) return source.eligible(instrument); const c = market.getMarkets(); return !c.stale && c.markets.some(m => m.instrument === instrument); },
  };
}
export const createCoordinator = createScheduler;
