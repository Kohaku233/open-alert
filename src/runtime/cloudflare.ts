import type { DurableObjectState, ExecutionContext } from '@cloudflare/workers-types';
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
import type { CatalogSnapshot,RuntimeSnapshot } from '../api/ports.js';
import { createNotificationService } from '../notifications/index.js';
import { createScheduler } from '../scheduler/index.js';
import { createPublicCcxtMarketSource } from '../markets/ccxt.js';
import { createVercelBinanceSource } from '../markets/vercel-relay.js';
import { createMarketQuoteService, type MarketQuote } from '../markets/quotes.js';
import { marketAvailable, marketSourceStale } from '../api/markets.js';
import type { Market } from '../contracts/domain.js';
import { D1SqlDatabase } from '../db/d1.js';
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
    return createApp({...services,auth,notifications,quotes:{get:market=>coordinatorJson<MarketQuote>('/quote?instrument='+encodeURIComponent(market.instrument))},catalog:{get:()=>coordinatorJson<CatalogSnapshot>('/catalog'),resolve:instrument=>coordinatorJson('/market?instrument='+encodeURIComponent(instrument))},runtime:{snapshot:()=>coordinatorJson<RuntimeSnapshot>('/snapshot')},wake:async()=>{const response=await coordinator().fetch('https://coordinator.internal/wake',{method:'POST'});if(!response.ok)throw new Error('coordinator_unavailable');}});
  })();workerCache.set(env,promise);promise.catch(()=>{workerCache.delete(env);});}
  return promise;
}
export default {
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
/** One namespace instance. Alarm cadence has no resident timer or second watchdog. */
export class Coordinator {
  private readonly initialized:Promise<ReturnType<typeof createScheduler>>;
  private running:Promise<void>|null=null;
  private revision=0;
  private active=false;
  private quotes: ReturnType<typeof createMarketQuoteService> | null=null;
  private alarmWrites:Promise<unknown>=Promise.resolve();
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
  private async reconcile():Promise<boolean> {
    const revision=this.revision,engine=await this.initialized;
    const work=await engine.hasWork();
    return this.writeAlarm(async()=>{
      // Serialize the revision check AND storage write with wake/cycle alarm writes.
      // A wake arriving during deleteAlarm must persist its alarm after that deletion.
      if(revision!==this.revision)return true;
      this.active=work;
      if(work){if(await this.state.storage.getAlarm()===null)await this.state.storage.setAlarm(Date.now()+5000);}
      else await this.state.storage.deleteAlarm();
      return work;
    });
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
    if(path==='/wake'&&request.method==='POST'){
      this.revision++;engine.invalidate();this.active=true;
      await this.writeAlarm(()=>this.state.storage.setAlarm(Date.now()+5000));
      this.state.waitUntil(this.cycle());return new Response(null,{status:202});
    }
    if(path==='/catalog'&&request.method==='GET'){
      await engine.refreshCatalog();return Response.json(engine.getMarkets());
    }
    if(path==='/market'&&request.method==='GET'){
      await engine.refreshCatalog();
      const instrument=new URL(request.url).searchParams.get('instrument')??'';
      const catalog=engine.getMarkets(),market=catalog.markets.find(m=>m.instrument===instrument)??null;
      return Response.json({market,stale:marketSourceStale(catalog,market??{instrument} as Market),available:!!market&&marketAvailable(catalog,market)});
    }
    if(path==='/snapshot'&&request.method==='GET'){
      // First read after eviction or a lost wake repairs active work, but never polls idle prices.
      await this.reconcile();
      const status=engine.getStatus();
      return Response.json({health:status.health,lastPollAt:status.lastPollAt,prices:engine.getPrices(),marketMode:'polling'});
    }
    if(path==='/quote'&&request.method==='GET'){
      try {
        await engine.refreshCatalog();
        const instrument=new URL(request.url).searchParams.get('instrument');
        const catalog=engine.getMarkets(),market=catalog.markets.find(m=>m.instrument===instrument);
        if(!market || !this.quotes)return new Response(null,{status:400});
        if(marketSourceStale(catalog,market)||!marketAvailable(catalog,market))return new Response(null,{status:503});
        return Response.json(await this.quotes.get(market));
      } catch {return new Response(null,{status:503});}
    }
    return new Response('Not found',{status:404});
  }
}
