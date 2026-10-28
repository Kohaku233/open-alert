import type { DurableObjectState, ExecutionContext, ScheduledController } from '@cloudflare/workers-types';
import type { CloudflareBindings } from '../contracts/db.js';
import { COORDINATOR_ID, ConfigurationError,loadConfig } from '../config.js';
import { createDb } from '../db/cloudflare.js';
import { createAuthDrizzle } from '../db/drizzle.cloudflare.js';
import * as authSchema from '../auth/schema.sqlite.js';
import { trustedRequest,unavailableApi,setupHtml } from './common.js';
import { requireDatabaseSchema } from '../db/schema-ready.js';
import { createRepositories } from '../db/repositories.js';
import { createAuth } from '../auth/index.js';
import { createApiNotifications } from './notifications.js';
import { createApp } from '../api/index.js';
import type { CatalogSnapshot,QuoteLookup,RuntimeSnapshot } from '../api/ports.js';
import { createNotificationService } from '../notifications/index.js';
import { createScheduler } from '../scheduler/index.js';
import { createPublicCcxtMarketSource } from '../markets/ccxt.js';
import { createVercelBinanceSource } from '../markets/vercel-relay.js';
import { createMarketQuoteService, type MarketQuote } from '../markets/quotes.js';
import { createPublicMarketPreview, type PublicMarketPreview } from '../markets/public-preview.js';
import { catalogDirectory, marketQuerySchema, searchMarkets } from '../api/markets.js';
import { D1SqlDatabase } from '../db/d1.js';
import { wakeWithRetry } from './wake.js';
import { createObservability } from './observability.js';
import type { ObservabilitySnapshot, OperationalProbe } from '../contracts/observability.js';
import type { ComponentHealth } from '../contracts/domain.js';
import { z } from 'zod';
const probeComponent=z.strictObject({state:z.enum(['healthy','degraded','unhealthy','starting']),code:z.string().max(64).nullable(),lastSuccessAt:z.number().int().nonnegative().nullable()});
const probeInput=z.strictObject({at:z.number().int().nonnegative(),api:probeComponent,email:probeComponent});
const configFor=(env:CloudflareBindings)=>{const config=loadConfig({...env,DEPLOYMENT:'cloudflare',DB_DRIVER:'d1'});if(!env.DB||!env.COORDINATOR)throw new ConfigurationError(['DB','COORDINATOR']);return config;};
async function databaseServices(env: CloudflareBindings) {
  const config=configFor(env),db=await createDb(config,{deployment:'cloudflare',bindings:env});
  await requireDatabaseSchema(db);
  return {config,db,repositories:createRepositories(db,config)};
}
type WorkerServices={app:ReturnType<typeof createApp>;emailHealth:()=>ComponentHealth;check:()=>Promise<void>};
const workerCache=new WeakMap<object,Promise<WorkerServices>>();
async function workerApp(env:CloudflareBindings) {
  let promise=workerCache.get(env);
  if(!promise){promise=(async()=>{
    const services=await databaseServices(env);
    const auth=await createAuth(services.config,services.db,createAuthDrizzle(services.db as D1SqlDatabase,authSchema),{registrationPolicy:'require'});
    const notifications=createApiNotifications(services.config);
    const coordinator=()=>env.COORDINATOR.get(env.COORDINATOR.idFromName(COORDINATOR_ID));
    let observationFailureAt:number|null=null;
    async function coordinatorJson<T>(path:string):Promise<T>{
      const response=await coordinator().fetch('https://coordinator.internal'+path);
      if(path==='/public-preview'&&!response.ok)console.error('open_alert_public_preview_failed',response.status);
      if(!response.ok){if(path==='/observability'&&(observationFailureAt===null||Date.now()-observationFailureAt>=60000||Date.now()<observationFailureAt)){observationFailureAt=Date.now();console.error('open_alert_observation_failed',response.status);}throw new Error('coordinator_unavailable');}return await response.json() as T;
    }
    const app=createApp({...services,auth,notifications,publicPreview:{get:()=>coordinatorJson<PublicMarketPreview>('/public-preview')},quotes:{
      get:market=>coordinatorJson<MarketQuote>('/quote?instrument='+encodeURIComponent(market.instrument)),
      lookup:instrument=>coordinatorJson<QuoteLookup>('/quote-lookup?instrument='+encodeURIComponent(instrument)),
    },catalog:{
      get:()=>coordinatorJson<CatalogSnapshot>('/catalog'),
      response:async(query,requestId)=>{
        const params=new URLSearchParams();
        if(query)for(const [key,value] of Object.entries(query))if(value!==undefined)params.set(key,String(value));
        const response=await coordinator().fetch('https://coordinator.internal/catalog-response'+(query?'?'+params:''),{headers:{'X-Request-ID':requestId}});
        if(!response.ok)throw new Error('coordinator_unavailable');
        // Stream the trusted envelope. Parsing/validating/stringifying thousands
        // of rows here spends the edge Worker's small per-request CPU budget.
        return response as unknown as Response;
      },
      resolve:instrument=>coordinatorJson('/market?instrument='+encodeURIComponent(instrument)),
    },runtime:{snapshot:()=>coordinatorJson<RuntimeSnapshot>('/snapshot'),observe:()=>coordinatorJson<ObservabilitySnapshot>('/observability')},wake:async(signal)=>{const response=await coordinator().fetch('https://coordinator.internal/wake',{method:'POST',signal:signal as never});if(!response.ok)throw new Error('coordinator_unavailable');}});
    return {app,emailHealth:auth.emailHealth,check:async()=>{await services.db.query('SELECT 1 AS ready');}};
  })();workerCache.set(env,promise);promise.catch(()=>{workerCache.delete(env);});}
  return promise;
}
export default {
  async scheduled(_controller:ScheduledController,env:CloudflareBindings,ctx:ExecutionContext):Promise<void> {
    // Keeps an auto-pausing Node backend awake; independent of coordinator recovery.
    const backend=nodeBackend(env);
    if(backend)ctx.waitUntil(fetch(new URL('/api/health',backend),{headers:{'Cache-Control':'no-store'},signal:AbortSignal.timeout(8000)}).then(r=>r.body?.cancel()).catch(()=>{console.error('node_backend_ping_failed');}));
    // Independent recovery of lost initial wakes, even with no open browser.
    // Reconcile schedules active work without polling prices or sending while idle.
    ctx.waitUntil((async()=>{
      configFor(env);
      const confirmed=await wakeWithRetry(async signal=>{
        const coordinator=env.COORDINATOR.get(env.COORDINATOR.idFromName(COORDINATOR_ID));
        const response=await coordinator.fetch('https://coordinator.internal/reconcile',{method:'POST',headers:{'X-Open-Alert-Cron':'1'},signal:signal as never});
        if(!response.ok)throw new Error('coordinator_unavailable');
      });
      if(!confirmed)throw new Error('coordinator_recovery_failed');
      // Readiness failure is observed separately; it must never prevent recovery.
      let timer:ReturnType<typeof setTimeout>|undefined,probe:OperationalProbe;
      try {
        const service=await Promise.race([(async()=>{const value=await workerApp(env);await value.check();return value;})(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('probe_timeout')),8000);})]);
        probe={at:Date.now(),api:{state:'healthy',code:null,lastSuccessAt:Date.now()},email:service.emailHealth()};
      } catch {probe={at:Date.now(),api:{state:'unhealthy',code:'service_startup_unavailable',lastSuccessAt:null},email:{state:'starting',code:'email_starting',lastSuccessAt:null}};}
      finally {clearTimeout(timer);}
      const stub=env.COORDINATOR.get(env.COORDINATOR.idFromName(COORDINATOR_ID));
      const observation=await stub.fetch('https://coordinator.internal/monitor-pulse',{method:'POST',body:JSON.stringify(probe)});
      if(!observation.ok)throw new Error('monitor_pulse_failed_'+observation.status);
    })());
  },
  async fetch(request:Request,env:CloudflareBindings,_ctx:ExecutionContext):Promise<Response> {
    const path=new URL(request.url).pathname;
    const backend=path.startsWith('/api/')?nodeBackend(env):null;
    if(backend)return proxyToNode(request,backend);
    try {
      configFor(env);
      if(!path.startsWith('/api/'))return env.ASSETS ? env.ASSETS.fetch(request as never) as unknown as Promise<Response> : new Response('Web assets are not configured',{status:503});
      const app=await workerApp(env);
      return await app.app.fetch(trustedRequest(request,request.headers.get('cf-connecting-ip')));
    } catch {return path.startsWith('/api/')?unavailableApi(path):new Response(setupHtml,{status:503,headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'}});}
  },
};
/** Optional NODE_BACKEND_URL moves every /api/* request, including the /api/live
 * WebSocket upgrade, to a Node deployment while assets stay on Workers. The
 * browser remains same-origin, so cookies and Origin checks are unchanged. */
function nodeBackend(env:CloudflareBindings):URL|null {
  const value=env.NODE_BACKEND_URL;
  if(typeof value!=='string'||!value)return null;
  try {const url=new URL(value);return url.protocol==='https:'&&url.pathname==='/'&&!url.search&&!url.username?url:null;}catch {return null;}
}
async function proxyToNode(request:Request,backend:URL):Promise<Response> {
  const incoming=new URL(request.url);
  const target=new URL(incoming.pathname+incoming.search,backend);
  // The VPS host network occasionally drops for seconds; retry idempotent reads once, never mutations or upgrades.
  const retryable=(request.method==='GET'||request.method==='HEAD')&&request.headers.get('Upgrade')?.toLowerCase()!=='websocket';
  for(let attempt=0;;attempt++){
    try {
      const response=await fetch(new Request(target,request));
      if(!retryable||attempt>0||![502,503,504].includes(response.status))return response;
      await response.body?.cancel();
    } catch {if(!retryable||attempt>0)return unavailableApi(incoming.pathname);}
    await new Promise(resolve=>setTimeout(resolve,1500));
  }
}
/** One namespace instance; alarms drive work and an independent Cron repairs lost wakes. */
export class Coordinator {
  private readonly initialized:Promise<ReturnType<typeof createScheduler>>;
  private running:Promise<void>|null=null;
  private revision=0;
  private active=false;
  private quotes: ReturnType<typeof createMarketQuoteService> | null=null;
  private publicPreview: ReturnType<typeof createPublicMarketPreview> | null=null;
  private monitor: ReturnType<typeof createObservability> | null=null;
  private alarmWrites:Promise<unknown>=Promise.resolve();
  private workCheck:{revision:number;promise:Promise<boolean>}|null=null;
  private checkedWork:{revision:number;at:number;active:boolean}|null=null;
  private writeAlarm<T>(operation:()=>Promise<T>):Promise<T> {
    const result=this.alarmWrites.then(operation);
    this.alarmWrites=result.catch(()=>{});return result;
  }
  constructor(private readonly state:DurableObjectState,env:CloudflareBindings) {
    this.initialized=state.blockConcurrencyWhile(async()=>{
      const services=await databaseServices(env);
      this.quotes=createMarketQuoteService({fetchImplementation:globalThis.fetch,...(services.config.binanceRelay?{relay:services.config.binanceRelay}:{})});
      this.publicPreview=createPublicMarketPreview({read:market=>this.quotes!.recent(market)});
      const engine=createScheduler({...services,notifications:createNotificationService(services),
        marketSource:(services.config.binanceRelay ? createVercelBinanceSource : createPublicCcxtMarketSource)({mode:'polling',fetchImplementation:globalThis.fetch,
          ...(services.config.binanceRelay ? { relay: services.config.binanceRelay } : {}),
          maxDemand:services.config.limits.globalInstruments,requestTimeoutMs:8000,pollBudgetMs:10000})});
      this.monitor=createObservability({engine,db:services.db,cronRequired:true,storage:{get:()=>this.state.storage.get('monitor:v1'),put:value=>this.state.storage.put('monitor:v1',value)}});
      return engine;
    });
  }
  private async reconcile(allowCached=false):Promise<boolean> {
    const revision=this.revision;
    // Reuse only positive checks: an idle result must never hide a lost new wake.
    if(allowCached&&this.checkedWork?.active&&this.checkedWork.revision===revision&&Date.now()-this.checkedWork.at<1000)return true;
    if(this.workCheck?.revision===revision)return this.workCheck.promise;
    const promise=(async()=>{
      const engine=await this.initialized,work=await engine.hasWork();
      return this.writeAlarm(async()=>{
        // Serialize the revision check AND storage write with wake/cycle alarm writes.
        // A wake arriving during deleteAlarm must persist its alarm after that deletion.
        if(revision!==this.revision)return true;
        this.active=work;
        if(work){if(await this.state.storage.getAlarm()===null)await this.state.storage.setAlarm(Date.now()+5000);}
        else await this.state.storage.deleteAlarm();
        this.checkedWork={revision,at:Date.now(),active:work};
        return work;
      });
    })();
    this.workCheck={revision,promise};
    try{return await promise;}
    finally{if(this.workCheck?.promise===promise)this.workCheck=null;}
  }
  private cycle():Promise<void> {
    if(this.running)return this.running;
    this.running=(async()=>{
      // Recovery is persisted before DB/provider work, including failures.
      await this.writeAlarm(()=>this.state.storage.setAlarm(Date.now()+5000));
      try {
        if(!await this.reconcile())return;
        const engine=await this.initialized;
        await engine.tick();
        // Polling remains independent of slow serialized notification delivery.
        this.state.waitUntil(engine.drain().then(()=>this.reconcile()).then(()=>{}));
      } catch {this.active=true;throw new Error('coordinator_cycle_failed');}
    })().finally(()=>{this.running=null;});return this.running;
  }
  async alarm(){await this.cycle();}
  async fetch(request:Request):Promise<Response> {
    const engine=await this.initialized,path=new URL(request.url).pathname;
    if(path==='/public-preview'&&request.method==='GET'&&this.publicPreview)return Response.json(await this.publicPreview.get());
    if(path==='/reconcile'&&request.method==='POST'){
      await this.monitor?.pulse(undefined,request.headers.get('X-Open-Alert-Cron')==='1');
      this.revision++;engine.invalidate();
      try {await this.reconcile();}catch{await this.monitor?.capture().catch(()=>{});throw new Error('coordinator_reconcile_failed');}return new Response(null,{status:202});
    }
    if(path==='/wake'&&request.method==='POST'){
      await this.monitor?.pulse();
      this.revision++;engine.invalidate();this.active=true;
      await this.writeAlarm(()=>this.state.storage.setAlarm(Date.now()+5000));
      this.state.waitUntil(this.cycle());return new Response(null,{status:202});
    }
    if(path==='/monitor-pulse'&&request.method==='POST'){
      if(!this.monitor)return new Response(null,{status:503});
      const probe=probeInput.safeParse(await request.json().catch(()=>null));
      if(!probe.success)return new Response(null,{status:400});
      await this.monitor.pulse(probe.data);await this.monitor.capture();return new Response(null,{status:202});
    }
    if(path==='/observability'&&request.method==='GET'){
      if(!this.monitor)return new Response(null,{status:503});
      await this.reconcile(true).catch(()=>this.monitor?.pulse());return Response.json(await this.monitor.capture());
    }
    if(path==='/catalog'&&request.method==='GET'){
      await engine.refreshCatalog();return Response.json(engine.getMarkets());
    }
    if(path==='/catalog-response'&&request.method==='GET'){
      const params=new URL(request.url).searchParams;
      const query=params.size ? marketQuerySchema.safeParse(Object.fromEntries(params)) : null;
      if(query&&!query.success)return new Response(null,{status:400});
      await engine.refreshCatalog();
      const snapshot=engine.getMarkets();
      const data=query ? searchMarkets(snapshot,query.data) : catalogDirectory(snapshot);
      return Response.json({ok:true,data,requestId:request.headers.get('X-Request-ID')},{headers:{'Cache-Control':'no-store'}});
    }
    if(path==='/market'&&request.method==='GET'){
      await engine.refreshCatalog();
      const instrument=new URL(request.url).searchParams.get('instrument')??'';
      return Response.json(engine.resolveMarket(instrument));
    }
    if(path==='/snapshot'&&request.method==='GET'){
      // First read after eviction or a lost wake repairs active work, but never polls idle prices.
      await this.reconcile(true);
      const status=engine.getStatus();
      return Response.json({health:status.health,lastPollAt:status.lastPollAt,prices:engine.getPrices(),marketMode:'polling'});
    }
    if((path==='/quote'||path==='/quote-lookup')&&request.method==='GET'){
      const reply=(result:QuoteLookup)=>path==='/quote-lookup'?Response.json(result):result.quote===null?new Response(null,{status:result.code==='invalid_request'?400:503}):Response.json(result.quote);
      try {
        await engine.refreshCatalog();
        const instrument=new URL(request.url).searchParams.get('instrument')??'';
        const {market,stale,available}=engine.resolveMarket(instrument);
        if(stale||!this.quotes)return reply({quote:null,code:'service_unavailable'});
        if(!market||!available)return reply({quote:null,code:'invalid_request'});
        return reply({quote:await this.quotes.get(market)});
      } catch {return reply({quote:null,code:'service_unavailable'});}
    }
    return new Response('Not found',{status:404});
  }
}
