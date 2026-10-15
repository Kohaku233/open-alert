import type { SqlDatabase } from '../contracts/db.js';
import type { ComponentHealth, SystemStatus } from '../contracts/domain.js';
import type { OperationalEvent, OperationalIssue, OperationalProbe, ObservabilitySnapshot, QueueTelemetry } from '../contracts/observability.js';
import type { RuntimeSchedulerService } from '../scheduler/index.js';

const MINUTE = 60_000, STALE = 3 * MINUTE;
const safeCodes = new Set(['idle_no_active_alerts','provider_not_checked','no_demand','prices_empty_or_stale','database_unavailable','lease_unavailable','lease_lost','lease_failed','watchdog_overdue','cycle_failed','delivery_cycle_failed','cycle_budget_exceeded','active_price_missing','reservation_invariant_failed','finish_not_committed','provider_deadline_uncertain','provider_uncertain','provider_rejected','provider_transport_uncertain','provider_response_uncertain','channel_unavailable','channel_changed','notification_failed','catalog_not_loaded','catalog_unavailable','stream_unavailable','exchange_unavailable','poll_unavailable','trade_queue_overflow','trade_replay_capacity','no_fresh_trade','email_unavailable','email_starting','email_rejected','email_uncertain','service_startup_unavailable','stopped','market_source_stopped','source_unavailable']);
const safeCode = (code: string | null) => code === null ? null : safeCodes.has(code) ? code : 'source_unavailable';
const issueCodes=new Set([...safeCodes,'queue_probe_failed','scheduler_unavailable','prices_unavailable','notifications_unavailable','api_unverified','email_unverified','cron_overdue','queue_delayed','delivery_stuck','monitor_storage_unavailable']);
const components=new Set(['database','scheduler','prices','notifications','email','api','cron','queue','monitor']);
const timestamp=(value:unknown)=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;
const validHealth=(value:ComponentHealth)=>value&&['healthy','degraded','unhealthy','starting'].includes(value.state)&&(value.code===null||safeCodes.has(value.code))&&(value.lastSuccessAt===null||timestamp(value.lastSuccessAt));
interface StoredMonitor {
  version: 1; lastCronAt: number | null; probe: OperationalProbe | null;
  events: OperationalEvent[]; history: ObservabilitySnapshot['history'];
}
export interface MonitorStorage { get(): Promise<StoredMonitor | undefined>; put(value: StoredMonitor): Promise<void> }
export interface ObservabilityOptions {
  engine: Pick<RuntimeSchedulerService, 'getStatus' | 'observability'>;
  db: SqlDatabase; cronRequired: boolean; storage?: MonitorStorage;
  probe?: () => OperationalProbe; now?: () => number;
  log?: (value: object) => void;
}

export async function readQueueTelemetry(db: SqlDatabase, now: number): Promise<QueueTelemetry> {
  const rows = await db.query<{ phase: string; count: number; due: number; oldest_due: number | null; oldest_sending: number | null }>(`SELECT phase,COUNT(*) AS count,
    SUM(CASE WHEN phase='queued' AND next_at<=? THEN 1 ELSE 0 END) AS due,
    MIN(CASE WHEN phase='queued' AND next_at<=? THEN created_at END) AS oldest_due,
    MIN(CASE WHEN phase='sending' THEN updated_at END) AS oldest_sending
    FROM outbox WHERE phase IN('queued','sending') GROUP BY phase`, [now,now]);
  const queued = rows.find(row => row.phase === 'queued'), sending = rows.find(row => row.phase === 'sending');
  return { queued: queued?.count ?? 0, due: queued?.due ?? 0, sending: sending?.count ?? 0, oldestDueAt: queued?.oldest_due ?? null, oldestSendingAt: sending?.oldest_sending ?? null };
}

export function diagnose(input: {
  now: number; startedAt: number; health: SystemStatus['health']; hasWork: boolean | null;
  queue: QueueTelemetry | null; cronRequired: boolean; lastCronAt: number | null; probe: OperationalProbe | null;
}): { state: ObservabilitySnapshot['state']; expectedIdle: boolean; issues: OperationalIssue[] } {
  const { now,health,queue,probe } = input, issues: OperationalIssue[] = [];
  const add = (component: OperationalIssue['component'], code: string, severity: OperationalIssue['severity']) => issues.push({component,code,severity});
  const idle = input.hasWork === false && queue !== null && queue.queued + queue.sending === 0;
  let unknown = false;
  if (queue === null) add('database','queue_probe_failed','critical');
  if (health.database.state !== 'healthy') add('database','database_unavailable','critical');
  if (idle) add('scheduler','idle_no_active_alerts','info');
  for (const key of ['scheduler','prices','notifications'] as const) {
    const h = health[key], code = safeCode(h.code);
    if (h.state === 'healthy') continue;
    const expected = idle && (key === 'scheduler' && code === 'idle_no_active_alerts' || key === 'prices' && ['idle_no_active_alerts','prices_empty_or_stale','no_demand'].includes(code ?? ''));
    if (expected) continue;
    if (key === 'notifications' && code === 'provider_not_checked') { add(key,code,'info'); continue; }
    if (key === 'scheduler' && code === 'cycle_budget_exceeded') { add(key,code,'info'); continue; }
    if (!idle && now - input.startedAt < 15_000 && (code === 'lease_unavailable' || code === 'no_demand' || h.state === 'starting')) { unknown = true; continue; }
    add(key, code ?? `${key}_unavailable`, h.state === 'unhealthy' ? 'critical' : 'warning');
  }
  if (input.cronRequired && (input.lastCronAt === null || now - input.lastCronAt > STALE || input.lastCronAt > now + 5000)) {
    if (input.lastCronAt === null && now - input.startedAt < STALE) { unknown = true; add('cron','awaiting_first_probe','info'); }
    else add('cron','cron_overdue','critical');
  }
  if (!probe || now - probe.at > STALE || probe.at > now + 5000) { unknown = true; add('api','probe_missing','info'); }
  else for (const key of ['api','email'] as const) {
    if (probe[key].state === 'unhealthy') add(key, key === 'api' ? 'service_startup_unavailable' : 'email_unavailable','critical');
    else if (probe[key].state !== 'healthy') { unknown = true; add(key,`${key}_unverified`,'warning'); }
  }
  if (queue?.oldestDueAt !== null && queue?.oldestDueAt !== undefined && now - queue.oldestDueAt > MINUTE) add('queue','queue_delayed','warning');
  if (queue?.oldestSendingAt !== null && queue?.oldestSendingAt !== undefined && now - queue.oldestSendingAt > MINUTE) add('queue','delivery_stuck','critical');
  const state = issues.some(i => i.severity === 'critical') ? 'critical' : issues.some(i => i.severity === 'warning') ? 'warning' : unknown ? 'unknown' : idle ? 'idle' : 'ok';
  return { state, expectedIdle: idle, issues };
}

export function createObservability(options: ObservabilityOptions) {
  const now = options.now ?? Date.now, log = options.log ?? (value => console.info(JSON.stringify(value)));
  let state: StoredMonitor = { version: 1,lastCronAt:null,probe:null,events:[],history:[] };
  let storageFailed = false, lastPersist = 0, lastLog = 0, revision = 0, cached: ObservabilitySnapshot | null = null;
  let flight: Promise<ObservabilitySnapshot> | null = null;
  const ready = options.storage?.get().then(value => {
    if (!value) return;
    if (value.version !== 1 || !Array.isArray(value.events) || !Array.isArray(value.history) || value.events.length > 50 || value.history.length > 60 ||
      value.events.some(e=>!e||!components.has(e.component)||!issueCodes.has(e.code)||!['warning','critical'].includes(e.severity)||!timestamp(e.openedAt)||!timestamp(e.lastSeenAt)||(e.resolvedAt!==null&&!timestamp(e.resolvedAt)))||
      value.history.some(e=>!e||!timestamp(e.at)||!['ok','idle','warning','critical','unknown'].includes(e.state))||
      (value.lastCronAt!==null&&!timestamp(value.lastCronAt))||
      (value.probe!==null&&(!timestamp(value.probe.at)||!validHealth(value.probe.api)||!validHealth(value.probe.email)))) throw new Error('invalid_monitor_state');
    state = structuredClone(value);
  }).catch(() => { storageFailed = true; }) ?? Promise.resolve();
  async function pulse(probe?: OperationalProbe, cron = false): Promise<void> {
    await ready;
    revision++;
    if (cron) state.lastCronAt = now();
    if (probe && probe.at <= now() + 5000 && (!state.probe || probe.at >= state.probe.at)) state.probe = {at:probe.at,api:{...probe.api,code:safeCode(probe.api.code)},email:{...probe.email,code:safeCode(probe.email.code)}};
    cached = null;
  }
  async function capture(): Promise<ObservabilitySnapshot> {
    await ready;
    if (cached && now() >= cached.observedAt && now() - cached.observedAt < 15_000) return structuredClone(cached);
    if (flight) { await flight; return cached ? structuredClone(cached) : capture(); }
    flight = (async () => {
      const version=revision,at = now(), runtime = options.engine.observability(), health = options.engine.getStatus();
      let queue: QueueTelemetry | null = null;
      try { queue = await readQueueTelemetry(options.db,at); } catch { /* Unknown is not an empty queue. */ }
      const diagnosis = diagnose({ now:at,startedAt:runtime.startedAt,health:health.health,hasWork:runtime.hasWork,queue,cronRequired:options.cronRequired,lastCronAt:state.lastCronAt,probe:options.probe?.() ?? state.probe });
      if (storageFailed) { diagnosis.issues.push({component:'monitor',code:'monitor_storage_unavailable',severity:'critical'}); diagnosis.state = 'critical'; }
      const active = diagnosis.issues.filter(issue => issue.severity !== 'info'), key = (issue: OperationalIssue) => issue.component + ':' + issue.code;
      const probe=options.probe?.() ?? state.probe, freshProbe=probe && at-probe.at<=STALE && probe.at<=at+5000;
      const recovered=(component:OperationalIssue['component'])=>{
        if(component==='api'||component==='email')return !!freshProbe&&probe[component].state==='healthy';
        if(component==='cron')return state.lastCronAt!==null&&state.lastCronAt<=at+5000&&at-state.lastCronAt<=STALE;
        if(component==='monitor')return !storageFailed;
        if(component==='queue')return queue!==null&&!active.some(issue=>issue.component==='queue');
        if(component==='database')return queue!==null&&health.health.database.state==='healthy';
        if(component==='scheduler'||component==='prices')return diagnosis.expectedIdle||health.health[component].state==='healthy';
        return health.health.notifications.state==='healthy';
      };
      let changed = false;
      for (const event of state.events) if (event.resolvedAt === null && !active.some(issue => key(issue) === key(event)) && recovered(event.component)) {
        event.resolvedAt = at; event.lastSeenAt = at; changed = true;
        log({event:'open_alert_incident',transition:'resolved',at,component:event.component,code:event.code});
      }
      // An expired probe or restarted provider is unknown, not proof of recovery.
      for(const event of state.events)if(event.resolvedAt===null&&!active.some(issue=>key(issue)===key(event))){const issue={component:event.component,code:event.code,severity:event.severity};active.push(issue);diagnosis.issues.push(issue);}
      if(active.some(issue=>issue.severity==='critical'))diagnosis.state='critical';
      else if(active.length)diagnosis.state='warning';
      for (const issue of active) {
        const event = state.events.find(event => event.resolvedAt === null && key(event) === key(issue));
        if (event) { event.lastSeenAt = at; event.severity = issue.severity; }
        else { state.events.push({...issue,openedAt:at,lastSeenAt:at,resolvedAt:null}); changed = true; log({event:'open_alert_incident',transition:'opened',at,...issue}); }
      }
      state.events = state.events.filter(event => event.resolvedAt === null || at - event.resolvedAt < 86_400_000).slice(-50);
      if (!state.history.length || at - state.history.at(-1)!.at >= MINUTE) state.history.push({at,state:diagnosis.state,queued:queue?.queued ?? null,sending:queue?.sending ?? null});
      state.history = state.history.filter(sample => at - sample.at < 60 * MINUTE).slice(-60);
      const report: ObservabilitySnapshot = {
        observedAt:at,...diagnosis,runId:runtime.runId,startedAt:runtime.startedAt,lastPollAt:health.lastPollAt,lastCronAt:state.lastCronAt,cronRequired:options.cronRequired,
        metrics:runtime.metrics,database:options.db.telemetry?.() ?? null,databaseScope:'coordinator',queue,
        sources:runtime.sources.map(source => ({venue:source.venue,...(source.type ? {type:source.type} : {}),catalogAt:source.catalogAt,catalogCode:safeCode(source.catalogCode),priceCode:safeCode(source.priceCode),retryAt:source.retryAt,pollRequests:source.pollRequests??0,pollFailures:source.pollFailures??0})),
        events:structuredClone(state.events),history:structuredClone(state.history),persistence:options.storage?'durable':'memory',notifications:'disabled',
      };
      if (options.storage && (at - lastPersist >= MINUTE || changed)) {
        try { await options.storage.put(structuredClone(state)); lastPersist = at; storageFailed = false; }
        catch { storageFailed = true; report.state = 'critical'; report.issues.push({component:'monitor',code:'monitor_storage_unavailable',severity:'critical'}); }
      }
      if (changed || at - lastLog >= MINUTE) { lastLog = at; log({event:'open_alert_observation',at,state:report.state,expectedIdle:report.expectedIdle,issues:report.issues,queue:report.queue,runId:report.runId,metrics:report.metrics,database:report.database,databaseScope:report.databaseScope,sources:report.sources,lastCronAt:report.lastCronAt}); }
      cached = revision===version ? report : null; return report;
    })().finally(() => { flight = null; });
    return structuredClone(await flight);
  }
  return { pulse,capture };
}
