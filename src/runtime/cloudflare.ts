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
import { catalogDirectory, marketQuerySchema, searchMarkets } from '../api/markets.js';
import { D1SqlDatabase } from '../db/d1.js';
import { wakeWithRetry } from './wake.js';
const configFor=(env:CloudflareBindings)=>{const config=loadConfig({...env,DEPLOYMENT:'cloudflare',DB_DRIVER:'d1'});if(!env.DB||!env.COORDINATOR)throw new ConfigurationError(['DB','COORDINATOR']);return config;};
async function databaseServices(env: CloudflareBindings) {
  const config=configFor(env),db=await createDb(config,{deployment:'cloudflare',bindings:env});
  await requireDatabaseSchema(db);
  return {config,db,repositories:createRepositories(db,config)};
}
const workerCache=new WeakMap<object,Promise<ReturnType<typeof createApp>>>();
async function workerApp(env:CloudflareBindings) {
  let promise=workerCache.get(env);
  if(!promise){promise=(async()=>{
    const services=await databaseServices(env);
    const auth=await createAuth(services.config,services.db,createAuthDrizzle(services.db as D1SqlDatabase,authSchema),{registrationPolicy:'require'});
    const notifications=createApiNotifications(services.config);
    const coordinator=()=>env.COORDINATOR.get(env.COORDINATOR.idFromName(COORDINATOR_ID));
    async function coordinatorJson<T>(path:string):Promise<T>{
      const response=await coordinator().fetch('https://coordinator.internal'+path);
      if(!response.ok)throw new Error('coordinator_unavailable');return await response.json() as T;
    }
    return createApp({...services,auth,notifications,quotes:{
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
    },runtime:{snapshot:()=>coordinatorJson<RuntimeSnapshot>('/snapshot')},wake:async(signal)=>{const response=await coordinator().fetch('https://coordinator.internal/wake',{method:'POST',signal:signal as never});if(!response.ok)throw new Error('coordinator_unavailable');}});
  })();workerCache.set(env,promise);promise.catch(()=>{workerCache.delete(env);});}
  return promise;
}
export default {
  async scheduled(_controller:ScheduledController,env:CloudflareBindings,ctx:ExecutionContext):Promise<void> {
    // Independent recovery of lost initial wakes, even with no open browser.
    // Reconcile schedules active work without polling prices or sending while idle.
    ctx.waitUntil((async()=>{
      configFor(env);
      const confirmed=await wakeWithRetry(async signal=>{
        const coordinator=env.COORDINATOR.get(env.COORDINATOR.idFromName(COORDINATOR_ID));
        const response=await coordinator.fetch('https://coordinator.internal/reconcile',{method:'POST',signal:signal as never});
        if(!response.ok)throw new Error('coordinator_unavailable');
      });
      if(!confirmed)throw new Error('coordinator_recovery_failed');
    })());
  },
  async fetch(request:Request,env:CloudflareBindings,_ctx:ExecutionContext):Promise<Response> {
    const path=new URL(request.url).pathname;
    try {
      configFor(env);
      if(!path.startsWith('/api/'))return env.ASSETS ? env.ASSETS.fetch(request as never) as unknown as Promise<Response> : new Response('Web assets are not configured',{status:503});
      const app=await workerApp(env);
      return await app.fetch(trustedRequest(request,request.headers.get('cf-connecting-ip')));
    } catch {return path.startsWith('/api/')?unavailableApi(path):new Response(setupHtml,{status:503,headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'}});}
  },
};
/** One namespace instance; alarms drive work and an independent Cron repairs lost wakes. */
export class Coordinator {
  private readonly initialized:Promise<ReturnType<typeof createScheduler>>;
  private running:Promise<void>|null=null;
  private revision=0;
  private active=false;
  private quotes: ReturnType<typeof createMarketQuoteService> | null=null;
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
      return createScheduler({...services,notifications:createNotificationService(services),
        marketSource:(services.config.binanceRelay ? createVercelBinanceSource : createPublicCcxtMarketSource)({mode:'polling',fetchImplementation:globalThis.fetch,
          ...(services.config.binanceRelay ? { relay: services.config.binanceRelay } : {}),
          maxDemand:services.config.limits.globalInstruments,requestTimeoutMs:8000,pollBudgetMs:10000})});
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
    if(path==='/reconcile'&&request.method==='POST'){
      this.revision++;engine.invalidate();
      await this.reconcile();return new Response(null,{status:202});
    }
    if(path==='/wake'&&request.method==='POST'){
      this.revision++;engine.invalidate();this.active=true;
      await this.writeAlarm(()=>this.state.storage.setAlarm(Date.now()+5000));
      this.state.waitUntil(this.cycle());return new Response(null,{status:202});
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
