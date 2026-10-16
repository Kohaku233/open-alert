import { Hono } from 'hono';
import { overallHealth } from '../scheduler/index.js';
import type { Context } from 'hono';
import { z } from 'zod';
import { consumeAuthLimit,privateLimitKey } from '../auth/limits.js';
import { DisabledAccountError } from '../auth/index.js';
import { RepositoryConflict } from '../contracts/db.js';
import type { AlertRecord, ChannelRecord } from '../contracts/db.js';
import type { ApiErrorCode, InvitationResult, SessionPrincipal } from '../contracts/api.js';
import { EmailDeliveryError } from '../auth/email.js';
import { instrumentSchema, createAlertSchema, patchAlertSchema, rearmAlertSchema, notificationOptionsSchema, testNotificationSchema, putChannelSchema } from '../contracts/domain.js';
import type { Alert, ChannelProfile, Market, UserIdentity, UserSettings } from '../contracts/domain.js';
import type { ApiDependencies } from './ports.js';
import { catalogDirectory, marketAvailable, marketQuerySchema, marketSourceStale, searchMarkets } from './markets.js';
export type { ApiDependencies, NotificationPort, RuntimeSnapshot, CatalogSnapshot } from './ports.js';
type Env = { Variables: { requestId: string; principal: SessionPrincipal } };
class HttpError extends Error { constructor(readonly status: 400|401|403|404|409|429|500|502|503|504, readonly code: ApiErrorCode, readonly fields?: Record<string,string>) { super(code); } }
const generation = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const settingsSchema = z.strictObject({ expectedGeneration: generation, enabled: z.boolean().optional(), dailyLimit: z.number().int().min(1).max(20).optional(), notification: notificationOptionsSchema.optional() }).refine(v=>Object.keys(v).length>1);
const channelSchema = putChannelSchema;
const pageSchema = z.strictObject({limit:z.coerce.number().int().min(1).max(100).default(50),cursor:z.string().min(1).max(200).optional()});
const messages: Record<ApiErrorCode,string> = {
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
  const ok=(c:Context<Env>,data:unknown,status:200|201=200)=>c.json({ok:true as const,data,requestId:c.get('requestId')},status);
  const uid=(c:Context<Env>)=>c.get('principal').userId;
  const wake=async()=>{await d.wake().catch(()=>{});};
  async function identity(userId:string):Promise<UserIdentity> {const rows=await d.db.query<{id:string;email:string;name:string;role:'user'|'admin';disabled:number}>('SELECT u.id,u.email,u.name,u.role,COALESCE(s.disabled,0) AS disabled FROM "user" u LEFT JOIN user_settings s ON s.user_id=u.id WHERE u.id=?',[userId]);const r=rows[0];if(!r)throw new HttpError(401,'unauthenticated');return {...r,disabled:r.disabled===1};}
  async function hydrate(userId:string,a:AlertRecord):Promise<Alert> {
    const [event,last]=await Promise.all([a.pendingTriggerId?d.repositories.outbox.getForUser(userId,a.pendingTriggerId):null,d.repositories.outbox.lastForAlert(userId,a.id)]);
    const pending=event&&(event.phase==='queued'||event.phase==='sending')?{triggerId:event.triggerId,generation:event.generation,phase:event.phase,attempts:event.attempts,nextAt:event.nextAt,createdAt:event.createdAt,price:event.price,timestamp:event.timestamp}:null;
    return {id:a.id,name:a.name,instrument:a.instrument,side:a.side,threshold:a.threshold,enabled:a.enabled,generation:a.generation,triggered:a.triggered,triggerId:a.triggerId,pending,last:last&&last.phase!=='queued'&&last.phase!=='sending'?{triggerId:last.triggerId,outcome:last.phase,at:last.updatedAt,attempts:last.attempts,code:last.code,receiptAvailable:!!last.receipt}:null,status:pending?pending.phase:!a.enabled?'disabled':a.triggered?'latched':'armed',createdAt:a.createdAt,updatedAt:a.updatedAt};
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
  app.use('/api/*',async(c,next)=>{
    const principal=await d.auth.getPrincipal(c.req.raw);if(!principal)throw new HttpError(401,'unauthenticated');c.set('principal',principal);
    if(!['GET','HEAD','OPTIONS'].includes(c.req.method)){
      const origin=c.req.header('origin');const trusted=d.config.trustedOrigins;
      if(!origin||!trusted.includes(origin))throw new HttpError(403,'forbidden');
      if(c.req.header('sec-fetch-site')==='cross-site')throw new HttpError(403,'forbidden');
    }
    const budget=await consumeAuthLimit(d.db,await privateLimitKey('api-user',principal.userId,d.config.authSecret),120,60000);
    if(!budget.allowed){c.header('Retry-After',String(budget.retryAfter));throw new HttpError(429,'rate_limited');}
    const settings=await d.repositories.settings.initialize(principal.userId,Date.now());if(settings.disabled)throw new HttpError(403,'forbidden');
    await next();
  });
  app.get('/api/status',async c=>{
    const userId=uid(c);const [user,settings,daily,channel,runtime]=await Promise.all([identity(userId),d.repositories.settings.get(userId),d.repositories.settings.dailyUsage(userId,Date.now()),d.repositories.channels.get(userId),d.runtime.snapshot()]);if(!settings)throw new HttpError(503,'service_unavailable');
    const health=await aggregateHealth(runtime);
    const own=new Set((await d.repositories.alerts.listForUser(userId)).map(v=>v.instrument));
    return ok(c,{user,settings:{enabled:settings.enabled,dailyLimit:settings.dailyLimit,notification:settings.notification},settingsGeneration:settings.generation,daily:{...daily,limit:settings.dailyLimit},health,scheduler:{pollIntervalMs:5000,lastPollAt:runtime.lastPollAt,coordinatorId:'coordinator-v1',...(runtime.marketMode?{marketMode:runtime.marketMode}:{})},prices:runtime.prices.filter(p=>own.has(p.instrument)),channel:channelProfile(channel,d.config.sharedPushoverAppToken),capabilities:{...d.auth.capabilities(),canAdmin:c.get('principal').role==='admin'}});
  });
  app.get('/api/markets',async c=>{
    const raw=c.req.queries();
    if(Object.keys(raw).length===0)return ok(c,catalogDirectory(await d.catalog.get()));
    if(Object.values(raw).some(values=>values.length!==1))throw new HttpError(400,'invalid_request');
    const query=marketQuerySchema.safeParse(c.req.query());
    if(!query.success)throw new HttpError(400,'invalid_request',fields(query.error));
    return ok(c,searchMarkets(await d.catalog.get(),query.data));
  });
  app.get('/api/quote',async c=>{
    if(Object.values(c.req.queries()).some(values=>values.length!==1))throw new HttpError(400,'invalid_request');
    const query=z.strictObject({instrument:instrumentSchema}).safeParse(c.req.query());
    if(!query.success)throw new HttpError(400,'invalid_request');
    if(!d.quotes)throw new HttpError(503,'service_unavailable');
    return ok(c,await d.quotes.get(await market(query.data.instrument)));
  });
  app.get('/api/alerts',async c=>ok(c,{alerts:await Promise.all((await d.repositories.alerts.listForUser(uid(c))).map(a=>hydrate(uid(c),a)))}));
  app.post('/api/alerts',async c=>{const body=await json(c,createAlertSchema);await market(body.instrument);const alert=await d.repositories.alerts.create(uid(c),body,Date.now());await wake();return ok(c,{alert:await hydrate(uid(c),alert)},201);});
  app.patch('/api/alerts/:id',async c=>{const {expectedGeneration,...patch}=await json(c,patchAlertSchema);const current=await mutableAlert(uid(c),c.req.param('id'),expectedGeneration);if(patch.instrument!==undefined||patch.enabled===true)await market(patch.instrument??current.instrument);const a=await d.repositories.alerts.patch(uid(c),c.req.param('id'),expectedGeneration,Object.fromEntries(Object.entries(patch).filter(([,v])=>v!==undefined)),Date.now());await wake();return ok(c,{alert:await hydrate(uid(c),a)});});
  app.delete('/api/alerts/:id',async c=>{const body=await json(c,rearmAlertSchema);await d.repositories.alerts.remove(uid(c),c.req.param('id'),body.expectedGeneration,Date.now());await wake();return ok(c,{deleted:true});});
  app.post('/api/alerts/:id/rearm',async c=>{const body=await json(c,rearmAlertSchema);const current=await mutableAlert(uid(c),c.req.param('id'),body.expectedGeneration);await market(current.instrument);const a=await d.repositories.alerts.rearm(uid(c),c.req.param('id'),body.expectedGeneration,Date.now());await wake();return ok(c,{alert:await hydrate(uid(c),a)});});
  app.get('/api/channels',async c=>ok(c,channelProfile(await d.repositories.channels.get(uid(c)),d.config.sharedPushoverAppToken)));
  app.put('/api/channels',async c=>{
    const body=await json(c,channelSchema),userId=uid(c),old=await d.repositories.channels.get(userId);if(!body.userKey&&!old)throw new HttpError(400,'invalid_request',{userKey:'Required for a new channel'});
    const userKey=body.userKey?await d.notifications.encrypt(d.config.encryptionKey,userId,'userKey',body.userKey):old!.userKey;
    const token=body.appToken===undefined?undefined:body.appToken===null?null:await d.notifications.encrypt(d.config.encryptionKey,userId,'appToken',body.appToken);
    const proposed:ChannelRecord={userId,generation:old?.generation??0,userKey,privateAppToken:token===undefined?old?.privateAppToken??null:token,updatedAt:Date.now()};
    if(!channelProfile(proposed,d.config.sharedPushoverAppToken).configured)throw new HttpError(400,'channel_unconfigured');
    try {await d.notifications.validate(userId,proposed);}catch {throw new HttpError(502,'notification_failed');}
    const channel=await d.repositories.channels.put(userId,old?.generation??null,userKey,token,Date.now());await wake();return ok(c,channelProfile(channel,d.config.sharedPushoverAppToken));
  });
  app.delete('/api/channels',async c=>{const old=await d.repositories.channels.get(uid(c));if(old)await d.repositories.channels.remove(uid(c),old.generation,Date.now());await wake();return ok(c,channelProfile(null,d.config.sharedPushoverAppToken));});
  app.patch('/api/settings',async c=>{const {expectedGeneration,...patch}=await json(c,settingsSchema);if(patch.dailyLimit&&patch.dailyLimit>d.config.limits.dailyNotificationAttempts)throw new HttpError(400,'invalid_request');const settings=await d.repositories.settings.patch(uid(c),expectedGeneration,patch as Partial<UserSettings>,Date.now());await wake();return ok(c,{settings:{enabled:settings.enabled,dailyLimit:settings.dailyLimit,notification:settings.notification},generation:settings.generation});});
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
  app.patch('/api/admin/users/:id',async c=>{const body=await json(c,z.strictObject({disabled:z.boolean()}));const target=c.req.param('id');const exists=await d.db.query('SELECT id FROM "user" WHERE id=?',[target]);if(!exists[0])throw new HttpError(404,'not_found');const user=await d.repositories.admin.setDisabled(target,body.disabled,Date.now());await wake();return ok(c,user);});
  app.post('/api/admin/invites',async c=>{
    const body=await json(c,z.strictObject({email:z.string().trim().toLowerCase().pipe(z.email().max(254))}));
    const now=Date.now(),invite=await d.repositories.admin.createInvitation(body.email,now+7*86400000,now);
    let emailDelivery:InvitationResult['emailDelivery'];
    if(invite.reused)emailDelivery={status:'not_attempted',reason:'existing_invitation'};
    else if(d.config.email.senderMode==='resend_sandbox'&&invite.email!==d.config.email.testRecipient)emailDelivery={status:'not_attempted',reason:'resend_sandbox'};
    else {
      try {await d.auth.sendInvitation(invite.email);emailDelivery={status:'accepted',reason:null};}
      catch(error){
        const code=error instanceof EmailDeliveryError?error.code:'email_uncertain';
        emailDelivery={status:code==='email_uncertain'?'uncertain':'failed',reason:code==='email_rejected'?'email_rejected':code==='email_uncertain'?'email_uncertain':'email_unavailable'};
      }
    }
    // Admission is already committed. Delivery failure must never turn this
    // successful write into a misleading 503 or prompt duplicate mail sends.
    return ok(c,{id:invite.id,email:invite.email,expiresAt:invite.expiresAt,reused:invite.reused,emailDelivery} satisfies InvitationResult,invite.reused?200:201);
  });
  app.get('/api/admin/status',async c=>ok(c,{...await d.repositories.admin.counts(),health:await aggregateHealth(await d.runtime.snapshot())}));
  app.all('/api/*',()=>{throw new HttpError(404,'not_found');});
  return app;
}

/** Runtime-neutral injectable application factory. */
export const createApp = createApi;
