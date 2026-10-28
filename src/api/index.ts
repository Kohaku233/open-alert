import { Hono } from 'hono';
import { overallHealth } from '../scheduler/index.js';
import type { Context } from 'hono';
import { z } from 'zod';
import { consumeAuthLimit,privateLimitKey } from '../auth/limits.js';
import { DisabledAccountError } from '../auth/index.js';
import { RepositoryConflict } from '../contracts/db.js';
import type { AlertRecord, ChannelRecord, OutboxRecord, UserSettingsRecord } from '../contracts/db.js';
import type { ApiErrorCode, InvitationResult, InvitationSummary, SessionPrincipal } from '../contracts/api.js';
import { EmailDeliveryError } from '../auth/email.js';
import { wakeWithRetry } from '../runtime/wake.js';
import { instrumentSchema, parseInstrumentIdentity, createAlertSchema, patchAlertSchema, rearmAlertSchema, notificationOptionsSchema, testNotificationSchema, putChannelSchema } from '../contracts/domain.js';
import { parseTimeframe, timeframeSupported } from '../contracts/timeframes.js';
import type { Alert, ChannelProfile, Market, UserIdentity, UserSettings } from '../contracts/domain.js';
import type { ApiDependencies } from './ports.js';
import { catalogDirectory, marketAvailable, marketQuerySchema, marketSourceStale, searchMarkets, type MarketQuery } from './markets.js';
import { AnomalyConflict } from '../anomaly/store.js';
export type { ApiDependencies, NotificationPort, RuntimeSnapshot, CatalogSnapshot } from './ports.js';
type Env = { Variables: { requestId: string; principal: SessionPrincipal; settings: UserSettingsRecord; schedulerWake: 'confirmed' | 'pending' } };
class HttpError extends Error { constructor(readonly status: 400|401|403|404|409|429|500|502|503|504, readonly code: ApiErrorCode, readonly fields?: Record<string,string>) { super(code); } }
const generation = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const settingsSchema = z.strictObject({ expectedGeneration: generation, enabled: z.boolean().optional(), dailyLimit: z.number().int().min(1).max(20).optional(), notification: notificationOptionsSchema.optional() }).refine(v=>Object.keys(v).length>1);
// Floors may only be raised above the system minimum (10% crypto net of BTC, 2% TradFi).
const anomalySettingsSchema = z.strictObject({ expectedGeneration: generation, enabled: z.boolean().optional(), crypto: z.boolean().optional(), tradfi: z.boolean().optional(),
  minMoveCrypto: z.number().min(0.10).max(1).optional(), minMoveTradfi: z.number().min(0.02).max(0.5).optional(),
  priority: z.union([z.literal(-1),z.literal(0),z.literal(1),z.literal(2)]).optional(), dailyLimit: z.number().int().min(1).max(50).optional(), notification: notificationOptionsSchema.nullable().optional() }).refine(v=>Object.keys(v).length>1);
const favoritesSchema = z.strictObject({ favorites: z.array(z.strictObject({ base: z.string().regex(/^[A-Z0-9]{1,24}$/), preferred: instrumentSchema.nullable() })).max(50)
  .refine(list=>new Set(list.map(f=>f.base)).size===list.length) });
const channelSchema = putChannelSchema;
const pageSchema = z.strictObject({limit:z.coerce.number().int().min(1).max(100).default(50),cursor:z.string().min(1).max(200).optional()});
const messages: Record<ApiErrorCode,string> = {
  account_exists:'This email already has an account',
  invalid_request:'Invalid request',unauthenticated:'Sign in required',forbidden:'Access denied',not_found:'Not found',generation_conflict:'The record has changed; reload before retrying',pending_delivery:'A notification is pending',limit_exceeded:'Configured limit reached',rate_limited:'Please wait before trying again',channel_unconfigured:'Configure a notification channel first',service_unavailable:'Service is unavailable',notification_failed:'Notification provider rejected the request',notification_uncertain:'Delivery could not be confirmed; check your device before retrying',internal_error:'Request failed',
};
function equalToken(a:string,b:string):Promise<boolean> {
  return Promise.all([crypto.subtle.digest('SHA-256',new TextEncoder().encode(a)),crypto.subtle.digest('SHA-256',new TextEncoder().encode(b))]).then(([x,y])=>{const p=new Uint8Array(x),q=new Uint8Array(y);let n=0;for(let i=0;i<p.length;i++)n|=p[i]!^q[i]!;return n===0;});
}
function fields(error:z.ZodError) { return Object.fromEntries(error.issues.map(i=>[i.path.join('.')||'body','Invalid value'])); }
async function boundedBody(request:Request,limit=16384):Promise<string> {
  const length=request.headers.get('content-length');
  if(length!==null&&(!/^\d+$/.test(length)||Number(length)>limit))throw new HttpError(400,'invalid_request');
  const reader=request.body?.getReader();if(!reader)return '';
  const chunks:Uint8Array[]=[];let size=0;
  try { while(true){const v=await reader.read();if(v.done)break;size+=v.value.byteLength;if(size>limit)throw new HttpError(400,'invalid_request');chunks.push(v.value);} }
  finally {await reader.cancel().catch(()=>{});}
  const all=new Uint8Array(size);let at=0;for(const chunk of chunks){all.set(chunk,at);at+=chunk.length;}return new TextDecoder('utf-8',{fatal:true}).decode(all);
}
async function json<T extends z.ZodType>(c:Context<Env>,schema:T):Promise<z.infer<T>> {
  if(!/^application\/json(?:\s*;|$)/i.test(c.req.header('content-type')??''))throw new HttpError(400,'invalid_request');
  let value:unknown;try {value=JSON.parse(await boundedBody(c.req.raw));}catch(error){if(error instanceof HttpError)throw error;throw new HttpError(400,'invalid_request');}
  const result=schema.safeParse(value);if(!result.success)throw new HttpError(400,'invalid_request',fields(result.error));return result.data;
}
export function channelProfile(channel:ChannelRecord|null,shared:string|undefined):ChannelProfile {
  const source=channel?.privateAppToken?'private':shared?'shared':'missing';return {provider:'pushover',configured:!!channel&&source!=='missing',tokenSource:source,userKeyPresent:!!channel,privateTokenPresent:!!channel?.privateAppToken,updatedAt:channel?.updatedAt??null};
}
export function createApi(d:ApiDependencies) {
  const app=new Hono<Env>();
  const ok=(c:Context<Env>,data:unknown,status:200|201=200)=>c.json({ok:true as const,data,requestId:c.get('requestId'),...(c.get('schedulerWake')?{effects:{schedulerWake:c.get('schedulerWake')}}:{})},status);
  const uid=(c:Context<Env>)=>c.get('principal').userId;
  const wake=async(c:Context<Env>)=>{
    const confirmed=await wakeWithRetry(signal=>d.wake(signal));
    c.set('schedulerWake',confirmed?'confirmed':'pending');
    if(!confirmed)console.warn('open_alert_scheduler_wake_pending',c.get('requestId'));
  };
  async function identity(userId:string):Promise<UserIdentity> {const rows=await d.db.query<{id:string;email:string;name:string;role:'user'|'admin';disabled:number}>('SELECT u.id,u.email,u.name,u.role,COALESCE(s.disabled,0) AS disabled FROM "user" u LEFT JOIN user_settings s ON s.user_id=u.id WHERE u.id=?',[userId]);const r=rows[0];if(!r)throw new HttpError(401,'unauthenticated');return {...r,disabled:r.disabled===1};}
  function present(a:AlertRecord,event:OutboxRecord|null,last:OutboxRecord|null):Alert {
    const pending=event&&(event.phase==='queued'||event.phase==='sending')?{triggerId:event.triggerId,generation:event.generation,phase:event.phase,attempts:event.attempts,nextAt:event.nextAt,createdAt:event.createdAt,price:event.price,timestamp:event.timestamp}:null;
    return {id:a.id,name:a.name,instrument:a.instrument,side:a.side,threshold:a.threshold,enabled:a.enabled,generation:a.generation,triggered:a.triggered,triggerId:a.triggerId,pending,last:last&&last.phase!=='queued'&&last.phase!=='sending'?{triggerId:last.triggerId,outcome:last.phase,at:last.updatedAt,attempts:last.attempts,code:last.code,receiptAvailable:!!last.receipt}:null,status:pending?pending.phase:!a.enabled?'disabled':a.triggered?'latched':'armed',createdAt:a.createdAt,updatedAt:a.updatedAt};
  }
  async function hydrate(userId:string,a:AlertRecord):Promise<Alert> {
    const [event,last]=await Promise.all([a.pendingTriggerId?d.repositories.outbox.getForUser(userId,a.pendingTriggerId):null,d.repositories.outbox.lastForAlert(userId,a.id)]);
    return present(a,event,last);
  }
  async function hydrateAll(userId:string,records:AlertRecord[]):Promise<Alert[]> {
    if(!records.length)return [];
    const summaries=await d.repositories.outbox.summariesForUser(userId);
    const pending=new Map(summaries.map(event=>[event.triggerId,event]));
    const last=new Map(summaries.filter(event=>event.phase!=='queued'&&event.phase!=='sending').map(event=>[event.alertId,event]));
    return records.map(record=>present(record,record.pendingTriggerId?pending.get(record.pendingTriggerId)??null:null,last.get(record.id)??null));
  }
  async function market(instrument:string) {
    if(d.catalog.resolve){
      const selected=await d.catalog.resolve(instrument);
      if(selected.stale)throw new HttpError(503,'service_unavailable');
      if(!selected.market || !selected.available)throw new HttpError(400,'invalid_request',{instrument:'Unsupported live market'});
      return selected.market;
    }
    const catalog=await d.catalog.get(),selected=catalog.markets.find(m=>m.instrument===instrument);
    if(!selected) {
      if(marketSourceStale(catalog,{instrument} as Market))throw new HttpError(503,'service_unavailable');
      throw new HttpError(400,'invalid_request',{instrument:'Unsupported live market'});
    }
    if(marketSourceStale(catalog,selected))throw new HttpError(503,'service_unavailable');
    if(!marketAvailable(catalog,selected))throw new HttpError(400,'invalid_request',{instrument:'Unsupported live market'});
    return selected;
  }
  async function mutableAlert(userId:string,id:string,expectedGeneration:number) {
    const current=await d.repositories.alerts.getForUser(userId,id);
    if(!current)throw new HttpError(404,'not_found');
    // Preserve the repository's pending/generation conflict precedence before catalog I/O.
    if(current.pendingTriggerId)throw new HttpError(409,'pending_delivery');
    if(current.generation!==expectedGeneration)throw new HttpError(409,'generation_conflict');
    return current;
  }
  app.use('/api/*',async(c,next)=>{const requestId=crypto.randomUUID();c.set('requestId',requestId);c.header('X-Request-ID',requestId);c.header('Cache-Control','no-store');c.header('X-Content-Type-Options','nosniff');await next();});
  app.onError((error,c)=>{
    let problem:HttpError;
    if(error instanceof HttpError)problem=error;
    else if(error instanceof DisabledAccountError)problem=new HttpError(403,'forbidden');
    else if(error instanceof RepositoryConflict)problem=new HttpError(error.code==='not_found'?404:409,error.code);
    else if(error instanceof AnomalyConflict)problem=new HttpError(409,'generation_conflict');
    else problem=new HttpError(503,'service_unavailable');
    if(problem.status===429&&!c.res.headers.has('Retry-After'))c.header('Retry-After','10');
    return c.json({ok:false as const,error:{code:problem.code,message:messages[problem.code],...(problem.fields?{fields:problem.fields}:{})},requestId:c.get('requestId')??crypto.randomUUID()},problem.status);
  });
  app.all('/api/auth/*',async c=>{
    if(!['GET','POST'].includes(c.req.method))return Response.json({message:'Method not allowed'},{status:405});
    let request=c.req.raw;
    if(c.req.method==='POST'){
      if(!/^application\/json(?:\s*;|$)/i.test(c.req.header('content-type')??''))return Response.json({code:'INVALID_REQUEST',message:'JSON required'},{status:400});
      let body:string;try{body=await boundedBody(request);}catch{return Response.json({code:'INVALID_REQUEST',message:'Request too large'},{status:400});}
      request=new Request(request.url,{method:request.method,headers:request.headers,body});
    }
    return d.auth.handler(request);
  });
  app.get('/api/auth-capabilities',c=>ok(c,d.auth.capabilities()));
  app.get('/api/public-quotes',async c=>{
    if(Object.keys(c.req.query()).length)throw new HttpError(400,'invalid_request');
    if(!d.publicPreview)throw new HttpError(503,'service_unavailable');
    let preview;
    try {preview=await d.publicPreview.get();}
    catch(error){console.error('open_alert_public_preview_unavailable',error instanceof Error?error.name:'unknown');throw error;}
    c.header('Cache-Control','public, max-age=5, s-maxage=5');
    return ok(c,preview);
  });
  async function aggregateHealth(runtime:Awaited<ReturnType<ApiDependencies['runtime']['snapshot']>>) {
    const health={...runtime.health,email:d.auth.emailHealth()};
    const own=d.notifications.health(), engine=runtime.health.notifications;
    const failed=[own,engine].find(component=>component.state==='unhealthy')??[own,engine].find(component=>component.state==='degraded'&&component.code!==null&&component.code!=='provider_not_checked');
    health.notifications=failed??(own.state==='starting'?engine:engine.state==='starting'?own:(engine.lastSuccessAt??0)>(own.lastSuccessAt??0)?engine:own);
    if(health.notifications.state==='starting'&&health.notifications.code===null)health.notifications={...health.notifications,state:'degraded',code:'provider_not_checked'};
    health.overall=overallHealth([health.database,health.scheduler,health.prices,health.notifications,health.email]);
    return health;
  }
  app.get('/api/health',async c=>{
    let stage:'database_probe'|'runtime_snapshot'|'aggregate'='database_probe';
    try {await d.db.query('SELECT 1 AS ready');stage='runtime_snapshot';const snapshot=await d.runtime.snapshot();stage='aggregate';const state=(await aggregateHealth(snapshot)).overall;return c.json({ok:true as const,data:{state},requestId:c.get('requestId')},state==='healthy'||state==='degraded'?200:503);}
    catch {console.error('open_alert_health_failed',stage);return c.json({ok:true as const,data:{state:'unhealthy'},requestId:c.get('requestId')},503);}
  });
  app.get('/api/readiness',async c=>{
    if(!d.runtime.observe)return c.json({ok:true,data:{state:'unknown'},requestId:c.get('requestId')},503);
    try {
      await d.db.query('SELECT 1 AS ready');
      const report=await d.runtime.observe(),email=d.auth.emailHealth();
      const ready=(report.state==='ok'||report.state==='idle')&&email.state==='healthy'&&report.observedAt<=Date.now()+5000&&Date.now()-report.observedAt<30_000;
      return c.json({ok:true,data:{state:ready?'ready':'not_ready'},requestId:c.get('requestId')},ready?200:503);
    }catch{return c.json({ok:true,data:{state:'unknown'},requestId:c.get('requestId')},503);}
  });
  app.use('/api/*',async(c,next)=>{
    const principal=await d.auth.getPrincipal(c.req.raw);if(!principal)throw new HttpError(401,'unauthenticated');c.set('principal',principal);
    if(!['GET','HEAD','OPTIONS'].includes(c.req.method)){
      const origin=c.req.header('origin');const trusted=d.config.trustedOrigins;
      if(!origin||!trusted.includes(origin))throw new HttpError(403,'forbidden');
      if(c.req.header('sec-fetch-site')==='cross-site')throw new HttpError(403,'forbidden');
    }
    const budget=await consumeAuthLimit(d.db,await privateLimitKey('api-user',principal.userId,d.config.authSecret),120,60000);
    if(!budget.allowed){c.header('Retry-After',String(budget.retryAfter));throw new HttpError(429,'rate_limited');}
    const settings=await d.repositories.settings.get(principal.userId)??await d.repositories.settings.initialize(principal.userId,Date.now());if(settings.disabled)throw new HttpError(403,'forbidden');
    c.set('settings',settings);
    await next();
  });
  app.get('/api/status',async c=>{
    const include=c.req.query('include');if(include!==undefined&&(include!=='alerts'||c.req.queries('include')?.length!==1))throw new HttpError(400,'invalid_request');
    const userId=uid(c),settings=c.get('settings');const [user,daily,channel,runtime,records]=await Promise.all([identity(userId),d.repositories.settings.dailyUsage(userId,Date.now()),d.repositories.channels.get(userId),d.runtime.snapshot(),d.repositories.alerts.listForUser(userId)]);
    const health=await aggregateHealth(runtime);
    const own=new Set(records.map(v=>v.instrument));
    return ok(c,{user,settings:{enabled:settings.enabled,dailyLimit:settings.dailyLimit,notification:settings.notification},settingsGeneration:settings.generation,daily:{...daily,limit:settings.dailyLimit},health,scheduler:{pollIntervalMs:5000,lastPollAt:runtime.lastPollAt,coordinatorId:'coordinator-v1',...(runtime.marketMode?{marketMode:runtime.marketMode}:{})},prices:runtime.prices.filter(p=>own.has(p.instrument)),channel:channelProfile(channel,d.config.sharedPushoverAppToken),capabilities:{...d.auth.capabilities(),canAdmin:c.get('principal').role==='admin'},...(include==='alerts'?{alerts:await hydrateAll(userId,records)}:{})});
  });
  app.get('/api/markets',async c=>{
    const raw=c.req.queries();
    let query:MarketQuery|null=null;
    if(Object.keys(raw).length){
      if(Object.values(raw).some(values=>values.length!==1))throw new HttpError(400,'invalid_request');
      const parsed=marketQuerySchema.safeParse(c.req.query());
      if(!parsed.success)throw new HttpError(400,'invalid_request',fields(parsed.error));
      query=parsed.data;
    }
    if(d.catalog.response){
      const response=await d.catalog.response(query,c.get('requestId'));
      if(response.status!==200)throw new HttpError(503,'service_unavailable');
      // Preserve prepared API security/trace headers while forwarding the body
      // stream, without decoding the full directory in this process.
      return c.newResponse(response.body,{status:200,headers:response.headers});
    }
    const snapshot=await d.catalog.get();
    return ok(c,query?searchMarkets(snapshot,query):catalogDirectory(snapshot));
  });
  app.get('/api/quote',async c=>{
    if(Object.values(c.req.queries()).some(values=>values.length!==1))throw new HttpError(400,'invalid_request');
    const query=z.strictObject({instrument:instrumentSchema}).safeParse(c.req.query());
    if(!query.success)throw new HttpError(400,'invalid_request');
    if(!d.quotes)throw new HttpError(503,'service_unavailable');
    if(d.quotes.lookup){
      const result=await d.quotes.lookup(query.data.instrument);
      if(result.quote===null)throw new HttpError(result.code==='invalid_request'?400:503,result.code,result.code==='invalid_request'?{instrument:'Unsupported live market'}:undefined);
      return ok(c,result.quote);
    }
    return ok(c,await d.quotes.get(await market(query.data.instrument)));
  });
  app.get('/api/candles',async c=>{
    if(Object.values(c.req.queries()).some(values=>values.length!==1))throw new HttpError(400,'invalid_request');
    const query=z.strictObject({instrument:instrumentSchema,timeframe:z.string().max(8).refine(v=>parseTimeframe(v)===v),
      before:z.string().regex(/^\d{1,15}$/).transform(Number).optional()}).safeParse(c.req.query());
    if(!query.success)throw new HttpError(400,'invalid_request');
    if(!d.candles)throw new HttpError(503,'service_unavailable');
    const selected=await market(query.data.instrument),identity=parseInstrumentIdentity(selected.instrument);
    if(!identity||!timeframeSupported(identity.venue,identity.type,query.data.timeframe))throw new HttpError(400,'invalid_request');
    try{return ok(c,await d.candles.get(selected,query.data.timeframe,query.data.before));}
    catch{throw new HttpError(503,'service_unavailable');}
  });
  app.get('/api/alerts',async c=>ok(c,{alerts:await hydrateAll(uid(c),await d.repositories.alerts.listForUser(uid(c)))}));
  const anomaly=()=>{if(!d.anomaly)throw new HttpError(503,'service_unavailable');return d.anomaly;};
  async function anomalyView(userId:string){
    const a=anomaly(),[{settings,generation},events,deliveries,channel]=await Promise.all([a.store.getSettings(userId),a.store.recentEvents(40),a.store.deliveriesSince(Math.floor(Date.now()/86400000)*86400000,userId),d.repositories.channels.get(userId)]);
    return {settings,generation,events,today:deliveries.length,channelConfigured:channelProfile(channel,d.config.sharedPushoverAppToken).configured,monitor:a.status()};
  }
  app.get('/api/anomaly',async c=>{if(Object.keys(c.req.queries()).length)throw new HttpError(400,'invalid_request');return ok(c,await anomalyView(uid(c)));});
  app.patch('/api/anomaly/settings',async c=>{
    const a=anomaly(),{expectedGeneration,...patch}=await json(c,anomalySettingsSchema);
    if(patch.enabled){const channel=await d.repositories.channels.get(uid(c));if(!channelProfile(channel,d.config.sharedPushoverAppToken).configured)throw new HttpError(409,'channel_unconfigured');}
    await a.store.patchSettings(uid(c),expectedGeneration,Object.fromEntries(Object.entries(patch).filter(([,v])=>v!==undefined)),Date.now());
    return ok(c,await anomalyView(uid(c)));
  });
  // Starred underlyings (BTC, NVDA...) across every venue; the client opens `preferred` or any listed market.
  app.get('/api/favorites',async c=>{if(Object.keys(c.req.queries()).length)throw new HttpError(400,'invalid_request');return ok(c,{favorites:await anomaly().store.favorites(uid(c))});});
  app.put('/api/favorites',async c=>{
    const a=anomaly(),body=await json(c,favoritesSchema);
    return ok(c,{favorites:await a.store.setFavorites(uid(c),body.favorites)});
  });
  app.post('/api/alerts',async c=>{const body=await json(c,createAlertSchema);await market(body.instrument);const alert=await d.repositories.alerts.create(uid(c),body,Date.now());await wake(c);return ok(c,{alert:await hydrate(uid(c),alert)},201);});
  app.patch('/api/alerts/:id',async c=>{const {expectedGeneration,...patch}=await json(c,patchAlertSchema);const current=await mutableAlert(uid(c),c.req.param('id'),expectedGeneration);if(patch.instrument!==undefined||patch.enabled===true)await market(patch.instrument??current.instrument);const a=await d.repositories.alerts.patch(uid(c),c.req.param('id'),expectedGeneration,Object.fromEntries(Object.entries(patch).filter(([,v])=>v!==undefined)),Date.now());await wake(c);return ok(c,{alert:await hydrate(uid(c),a)});});
  app.delete('/api/alerts/:id',async c=>{const body=await json(c,rearmAlertSchema);await d.repositories.alerts.remove(uid(c),c.req.param('id'),body.expectedGeneration,Date.now());await wake(c);return ok(c,{deleted:true});});
  app.post('/api/alerts/:id/rearm',async c=>{const body=await json(c,rearmAlertSchema);const current=await mutableAlert(uid(c),c.req.param('id'),body.expectedGeneration);await market(current.instrument);const a=await d.repositories.alerts.rearm(uid(c),c.req.param('id'),body.expectedGeneration,Date.now());await wake(c);return ok(c,{alert:await hydrate(uid(c),a)});});
  app.get('/api/channels',async c=>ok(c,channelProfile(await d.repositories.channels.get(uid(c)),d.config.sharedPushoverAppToken)));
  app.put('/api/channels',async c=>{
    const body=await json(c,channelSchema),userId=uid(c),old=await d.repositories.channels.get(userId);if(!body.userKey&&!old)throw new HttpError(400,'invalid_request',{userKey:'Required for a new channel'});
    const userKey=body.userKey?await d.notifications.encrypt(d.config.encryptionKey,userId,'userKey',body.userKey):old!.userKey;
    const token=body.appToken===undefined?undefined:body.appToken===null?null:await d.notifications.encrypt(d.config.encryptionKey,userId,'appToken',body.appToken);
    const proposed:ChannelRecord={userId,generation:old?.generation??0,userKey,privateAppToken:token===undefined?old?.privateAppToken??null:token,updatedAt:Date.now()};
    if(!channelProfile(proposed,d.config.sharedPushoverAppToken).configured)throw new HttpError(400,'channel_unconfigured');
    try {await d.notifications.validate(userId,proposed);}catch {throw new HttpError(502,'notification_failed');}
    const channel=await d.repositories.channels.put(userId,old?.generation??null,userKey,token,Date.now());await wake(c);return ok(c,channelProfile(channel,d.config.sharedPushoverAppToken));
  });
  app.delete('/api/channels',async c=>{const old=await d.repositories.channels.get(uid(c));if(old)await d.repositories.channels.remove(uid(c),old.generation,Date.now());await wake(c);return ok(c,channelProfile(null,d.config.sharedPushoverAppToken));});
  app.patch('/api/settings',async c=>{const {expectedGeneration,...patch}=await json(c,settingsSchema);if(patch.dailyLimit&&patch.dailyLimit>d.config.limits.dailyNotificationAttempts)throw new HttpError(400,'invalid_request');const settings=await d.repositories.settings.patch(uid(c),expectedGeneration,patch as Partial<UserSettings>,Date.now());await wake(c);return ok(c,{settings:{enabled:settings.enabled,dailyLimit:settings.dailyLimit,notification:settings.notification},generation:settings.generation});});
  app.post('/api/test-notification',async c=>{
    await json(c,testNotificationSchema);const userId=uid(c);const [channel,settings]=await Promise.all([d.repositories.channels.get(userId),d.repositories.settings.get(userId)]);
    if(!channel||!settings||!channelProfile(channel,d.config.sharedPushoverAppToken).configured)throw new HttpError(409,'channel_unconfigured');
    const claim=await d.repositories.tests.claim(userId,channel.generation,settings.generation,Date.now());if(!claim)throw new HttpError(429,'rate_limited');
    let result:{outcome:'sent'|'failed'|'uncertain';code:string|null};try {result=await d.notifications.test(userId,channel);}catch {result={outcome:'uncertain',code:'provider_uncertain'};}
    const at=Date.now();const finished=await d.repositories.tests.finish(userId,claim.id,claim.claimId,result.outcome,result.code,at);if(!finished||result.outcome==='uncertain')throw new HttpError(504,'notification_uncertain');if(result.outcome==='failed')throw new HttpError(502,'notification_failed');return ok(c,{outcome:'sent',at});
  });
  app.post('/api/admin/bootstrap',async c=>{const configured=d.config.bootstrapToken;const bearer=c.req.header('authorization')?.match(/^Bearer ([^\s]+)$/)?.[1]??'';if(!configured||!await equalToken(bearer,configured))throw new HttpError(403,'forbidden');if(!await d.repositories.admin.bootstrap(uid(c),Date.now()))throw new HttpError(409,'generation_conflict');return ok(c,{bootstrapped:true});});
  app.use('/api/admin/*',async(c,next)=>{if(c.get('principal').role!=='admin')throw new HttpError(403,'forbidden');await next();});
  app.get('/api/admin/users',async c=>{const query=pageSchema.safeParse(c.req.query());if(!query.success)throw new HttpError(400,'invalid_request');return ok(c,await d.repositories.admin.listUsers(query.data.limit,query.data.cursor));});
  app.patch('/api/admin/users/:id',async c=>{const body=await json(c,z.strictObject({disabled:z.boolean()}));const target=c.req.param('id');const exists=await d.db.query('SELECT id FROM "user" WHERE id=?',[target]);if(!exists[0])throw new HttpError(404,'not_found');const user=await d.repositories.admin.setDisabled(target,body.disabled,Date.now());await wake(c);return ok(c,user);});
  app.post('/api/admin/invites',async c=>{
    const body=await json(c,z.strictObject({email:z.string().trim().toLowerCase().pipe(z.email().max(254))}));
    if((await d.db.query('SELECT id FROM "user" WHERE LOWER(email)=?',[body.email])).length)throw new HttpError(409,'account_exists');
    const now=Date.now(),invite=await d.repositories.admin.createInvitation(body.email,now+7*86400000,now);
    let emailDelivery:InvitationResult['emailDelivery'];
    if(invite.reused)emailDelivery={status:'not_attempted',reason:'existing_invitation'};
    else if(d.config.email.senderMode==='resend_sandbox'&&invite.email!==d.config.email.testRecipient)emailDelivery={status:'not_attempted',reason:'resend_sandbox'};
    else {
      try {
        const budget=await consumeAuthLimit(d.db,await privateLimitKey('invite-mail',invite.email,d.config.authSecret),1,60_000);
        if(!budget.allowed)emailDelivery={status:'not_attempted',reason:'delivery_cooldown'};
        else {await d.auth.sendInvitation(invite.email,{expiresAt:invite.expiresAt,idempotencyKey:`invite/${invite.id}/${invite.expiresAt}`});emailDelivery={status:'accepted',reason:null};}
      }
      catch(error){
        const code=error instanceof EmailDeliveryError?error.code:'email_uncertain';
        emailDelivery={status:code==='email_uncertain'?'uncertain':'failed',reason:code==='email_rejected'?'email_rejected':code==='email_uncertain'?'email_uncertain':'email_unavailable'};
      }
    }
    // Admission is already committed. Delivery failure must never turn this
    // successful write into a misleading 503 or prompt duplicate mail sends.
    return ok(c,{id:invite.id,email:invite.email,expiresAt:invite.expiresAt,reused:invite.reused,emailDelivery} satisfies InvitationResult,invite.reused?200:201);
  });
  app.get('/api/admin/invites',async c=>{
    const query=pageSchema.safeParse(c.req.query());if(!query.success)throw new HttpError(400,'invalid_request');
    const page=await d.repositories.admin.listInvitations(query.data.limit,query.data.cursor),now=Date.now();
    return ok(c,{items:page.items.map(invite=>({id:invite.id,email:invite.email,expiresAt:invite.expiresAt,status:invite.consumedBy?'accepted':invite.expiresAt===0?'revoked':invite.expiresAt<=now?'expired':'pending'} satisfies InvitationSummary)),cursor:page.cursor});
  });
  app.post('/api/admin/invites/:id/resend',async c=>{
    const body=await json(c,z.strictObject({expectedExpiresAt:generation,confirm:z.literal(true)}));
    const invite=await d.repositories.admin.getInvitationById(c.req.param('id'));
    if(!invite)throw new HttpError(404,'not_found');
    if(invite.consumedBy||invite.expiresAt<=Date.now()||invite.expiresAt!==body.expectedExpiresAt)throw new HttpError(409,'generation_conflict');
    const budget=await consumeAuthLimit(d.db,await privateLimitKey('invite-mail',invite.email,d.config.authSecret),1,60_000);
    if(!budget.allowed){c.header('Retry-After',String(budget.retryAfter));throw new HttpError(429,'rate_limited');}
    // Recheck after acquiring the cross-isolate delivery budget. Revocation can
    // prevent admission even if a mail request was already dispatched.
    const current=await d.repositories.admin.getInvitation(invite.email,Date.now());
    if(!current||current.expiresAt!==body.expectedExpiresAt)throw new HttpError(409,'generation_conflict');
    let emailDelivery:InvitationResult['emailDelivery'];
    if(d.config.email.senderMode==='resend_sandbox'&&invite.email!==d.config.email.testRecipient)emailDelivery={status:'not_attempted',reason:'resend_sandbox'};
    else try{await d.auth.sendInvitation(invite.email,{expiresAt:invite.expiresAt,idempotencyKey:`invite/${invite.id}/resend/${crypto.randomUUID()}`});emailDelivery={status:'accepted',reason:null};}
    catch(error){const code=error instanceof EmailDeliveryError?error.code:'email_uncertain';emailDelivery={status:code==='email_uncertain'?'uncertain':'failed',reason:code==='email_rejected'?'email_rejected':code==='email_uncertain'?'email_uncertain':'email_unavailable'};}
    return ok(c,{id:invite.id,email:invite.email,expiresAt:invite.expiresAt,reused:true,emailDelivery} satisfies InvitationResult);
  });
  app.delete('/api/admin/invites/:id',async c=>{
    const body=await json(c,z.strictObject({expectedExpiresAt:generation}));
    await d.repositories.admin.revokeInvitation(c.req.param('id'),body.expectedExpiresAt,Date.now());
    return ok(c,{revoked:true});
  });
  app.get('/api/admin/status',async c=>ok(c,{...await d.repositories.admin.counts(),health:await aggregateHealth(await d.runtime.snapshot())}));
  app.get('/api/admin/observability',async c=>{if(!d.runtime.observe)throw new HttpError(503,'service_unavailable');return ok(c,await d.runtime.observe());});
  app.all('/api/*',()=>{throw new HttpError(404,'not_found');});
  return app;
}

/** Runtime-neutral injectable application factory. */
export const createApp = createApi;
