import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/api/index.js';
import type { ApiDependencies, CatalogSnapshot, QuoteLookup } from '../src/api/ports.js';
import type { ObservabilitySnapshot } from '../src/contracts/observability.js';
import { initializeServices } from '../src/runtime/common.js';
import { createNodeSqliteAuthDrizzle } from '../src/auth/drizzle.node-sqlite.js';
import { SQLiteDatabase } from '../src/db/sqlite.js';
import type { SQLiteConnection } from '../src/db/sqlite.js';
import { createApiNotifications } from '../src/runtime/notifications.js';
import type { Alert, ComponentHealth } from '../src/contracts/domain.js';
import type { EmailMessage } from '../src/auth/email.js';
import { decryptSecret } from '../src/notifications/index.js';
import { EmailDeliveryError } from '../src/auth/email.js';
const good:ComponentHealth={state:'healthy',lastSuccessAt:1700000000000,code:null};
async function fixture(overrides:Record<string,string>={},ports:Partial<ApiDependencies>={}) {
 const config=loadConfig({NODE_ENV:'test',APP_URL:'http://localhost:3000',AUTH_SECRET:'api-fixture-secret-at-least-thirty-two-characters',ENCRYPTION_KEY:'12'.repeat(32),EMAIL_PROVIDER:'console',BOOTSTRAP_TOKEN:'bootstrap-fixture-at-least-thirty-two-characters',PUSHOVER_APP_TOKEN:'S'.repeat(30),...overrides});
 const raw=new DatabaseSync(':memory:'),db=new SQLiteDatabase(raw as unknown as SQLiteConnection,'node:sqlite'),messages:EmailMessage[]=[],providerCalls:{url:string;body:URLSearchParams}[]=[];
 const services=await initializeServices(config,db,createNodeSqliteAuthDrizzle(raw),config.environment==='test'?{testEmailTransport:{async verify(){},async send(m){messages.push(m);}}}:{emailTransportFactory:async()=>({async verify(){},async send(m){messages.push(m);}})});
 let provider:'sent'|'failed'|'uncertain'='sent',stale=false,wakes=0,invitationSends=0,wakeFailures=0;
 let invitationError:'email_rejected'|'email_uncertain'|'email_unavailable'|null=null;
 let catalogOverride:CatalogSnapshot|undefined;
 const notifications=createApiNotifications(config,{fetch:async(url,init)=>{const body=new URLSearchParams(String(init?.body));providerCalls.push({url:String(url),body});if(String(url).endsWith('validate.json'))return Response.json({status:1,request:'fixture-validation'});if(provider==='uncertain')throw new Error('mock disconnect');return Response.json({status:provider==='sent'?1:0,request:'fixture-message'},{status:provider==='sent'?200:400});}});
 const app=createApp({...services,auth:{...services.auth,sendInvitation:async(email,options)=>{invitationSends++;if(invitationError)throw new EmailDeliveryError(invitationError);await services.auth.sendInvitation(email,options);}},notifications,quotes:{get:async market=>({instrument:market.instrument,price:123,observedAt:Date.now(),timestamp:null})},catalog:{get:async()=>catalogOverride??({markets:[{instrument:'BTC-USDT-SWAP',base:'BTC',quote:'USDT',tickSize:'0.1',state:'live',tradingViewSymbol:'OKX:BTCUSDT.P'},{instrument:'ETH-USDT-SWAP',base:'ETH',quote:'USDT',tickSize:'0.01',state:'live',tradingViewSymbol:'OKX:ETHUSDT.P'}],updatedAt:Date.now(),stale})},runtime:{snapshot:async()=>({health:{overall:'healthy',database:good,scheduler:good,prices:good,notifications:good,email:good},lastPollAt:Date.now(),prices:[]})},wake:async()=>{wakes++;if(wakeFailures-->0)throw new Error("injected wake failure");},...ports});
 const call=(path:string,method='GET',body?:unknown,cookie='',headers:Record<string,string>={})=>app.request(config.appUrl+path,{method,headers:{Origin:config.appUrl,'Content-Type':'application/json',Cookie:cookie,...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
 async function login(email:string){await services.repositories.admin.createInvitation(email,Date.now()+60000,Date.now());const send=await call('/api/auth/email-otp/send-verification-otp','POST',{email,type:'sign-in'});assert.equal(send.status,200,await send.text());const otp=messages.at(-1)!.text.match(/code is (\d{6})/)![1];const response=await call('/api/auth/sign-in/email-otp','POST',{email,otp,role:'admin'});assert.equal(response.status,200,await response.clone().text());const cookie=response.headers.getSetCookie().map(v=>v.split(';')[0]).join('; '),user=(await response.json() as any).user;assert.equal(user.role,'user');return {cookie,id:user.id};}
 const body=async(response:Response,status=200)=>{assert.equal(response.status,status,await response.clone().text());return await response.json() as any;};
 return {...services,messages,app,call,login,body,providerCalls,notifications,setProvider:(v:typeof provider)=>{provider=v;},setStale:(v:boolean)=>{stale=v;},setCatalog:(v:CatalogSnapshot)=>{catalogOverride=v;},wakes:()=>wakes,setWakeFailures:(count:number)=>{wakeFailures=count;},invitationSends:()=>invitationSends,setInvitationError:(v:typeof invitationError)=>{invitationError=v;},close:async()=>{services.auth.close();await db.close();}};
}
const input={name:'BTC ceiling',instrument:'BTC-USDT-SWAP',side:'upper',threshold:100,enabled:true} as const;

test('committed writes report pending wake honestly and retry only the wake effect',async t=>{
 const f=await fixture();try{
  const alice=await f.login('wake@example.com');
  const logs=t.mock.method(console,'warn',()=>{});
  f.setWakeFailures(3);
  const created=await f.body(await f.call('/api/alerts','POST',input,alice.cookie),201);
  assert.equal(created.effects.schedulerWake,'pending');assert.equal(f.wakes(),3);
  assert.equal((await f.repositories.alerts.listForUser(alice.id)).length,1);
  assert.equal(created.data.alert.generation,0);assert.equal(logs.mock.callCount(),1);
  assert.equal(logs.mock.calls[0]!.arguments[0],'open_alert_scheduler_wake_pending');
  f.setWakeFailures(2);
  const updated=await f.body(await f.call(`/api/alerts/${created.data.alert.id}`,'PATCH',{expectedGeneration:0,name:'one update'},alice.cookie));
  assert.equal(updated.effects.schedulerWake,'confirmed');assert.equal(f.wakes(),6);
  assert.equal(updated.data.alert.generation,1);assert.equal((await f.repositories.alerts.listForUser(alice.id)).length,1);
 }finally{await f.close();}
});

test('operational details require admin; public readiness exposes only a minimal state and fails closed',async()=>{
 let reads=0,report={state:'idle',observedAt:Date.now(),runId:'private-operator-details'} as ObservabilitySnapshot;
 const f=await fixture({}, {runtime:{snapshot:async()=>{assert.fail('No status probe needed');},observe:async()=>{reads++;return report;}}});
 try{
  assert.equal((await f.call('/api/admin/observability')).status,401);assert.equal(reads,0);
  const member=await f.login('observer@example.com');assert.equal((await f.call('/api/admin/observability','GET',undefined,member.cookie)).status,403);assert.equal(reads,0);
  const publicReport=await f.body(await f.call('/api/readiness'));assert.deepEqual(publicReport.data,{state:'ready'});assert.ok(!JSON.stringify(publicReport).includes('private-operator'));
  await f.body(await f.call('/api/admin/bootstrap','POST',{},member.cookie,{Authorization:`Bearer ${f.config.bootstrapToken}`}));
  assert.equal((await f.body(await f.call('/api/admin/observability','GET',undefined,member.cookie))).data.runId,report.runId);
  for(const state of ['critical','unknown','warning'] as const){report={...report,state,observedAt:Date.now()};assert.deepEqual((await f.body(await f.call('/api/readiness'),503)).data,{state:'not_ready'});}
  report={...report,state:'idle',observedAt:Date.now()-31_000};assert.equal((await f.call('/api/readiness')).status,503);
 }finally{await f.close();}
});

test('combined status reuses one tenant alert read and one batched summary query',async t=>{
 const f=await fixture();try{
  const alice=await f.login('snapshot@example.com'),bob=await f.login('other-snapshot@example.com');
  await f.repositories.settings.initialize(alice.id,Date.now());await f.repositories.settings.initialize(bob.id,Date.now());
  for(let i=0;i<20;i++)await f.repositories.alerts.create(alice.id,{...input,name:`rule ${i}`},Date.now());
  await f.repositories.alerts.create(bob.id,{...input,name:'foreign'},Date.now());
  const records=await f.repositories.alerts.listForUser(alice.id),queries=t.mock.method(f.db,'query');
  await Promise.all(records.map(record=>f.repositories.outbox.lastForAlert(alice.id,record.id)));
  assert.equal(queries.mock.callCount(),20,'Previous per-alert history path needs 20 SQL calls');
  await f.repositories.outbox.summariesForUser(alice.id);
  assert.equal(queries.mock.callCount(),21,'The batched path adds exactly one SQL call');
  const list=f.repositories.alerts.listForUser.bind(f.repositories.alerts),summaries=f.repositories.outbox.summariesForUser.bind(f.repositories.outbox);
  const listSpy=t.mock.method(f.repositories.alerts,'listForUser',list);
  const summarySpy=t.mock.method(f.repositories.outbox,'summariesForUser',summaries);
  t.mock.method(f.repositories.outbox,'lastForAlert',async()=>{assert.fail('N+1 history reads');});
  t.mock.method(f.repositories.outbox,'getForUser',async()=>{assert.fail('N+1 pending reads');});
  const combined=(await f.body(await f.call('/api/status?include=alerts','GET',undefined,alice.cookie))).data;
  assert.equal(combined.alerts.length,20);assert.ok(combined.alerts.every((a:Alert)=>a.name!=='foreign'));
  assert.equal(listSpy.mock.callCount(),1);assert.equal(summarySpy.mock.callCount(),1);
  const standalone=(await f.body(await f.call('/api/alerts','GET',undefined,alice.cookie))).data;
  assert.deepEqual(combined.alerts,standalone.alerts);
  assert.equal((await f.body(await f.call('/api/status','GET',undefined,alice.cookie))).data.alerts,undefined);
  for(const query of ['include=unknown','include=alerts&include=alerts'])assert.equal((await f.call('/api/status?'+query,'GET',undefined,alice.cookie)).status,400);
  assert.equal((await f.call('/api/status?include=alerts')).status,401);
 }finally{await f.close();}
});
test('business reads reuse request-local settings without initialization writes or a cross-request cache',async t=>{
 const f=await fixture();try{
  const alice=await f.login('settings-read@example.com'),bob=await f.login('settings-other@example.com');
  await f.repositories.settings.initialize(alice.id,Date.now());await f.repositories.settings.initialize(bob.id,Date.now());
  const reads=t.mock.method(f.repositories.settings,'get'),initializations=t.mock.method(f.repositories.settings,'initialize'),writes=t.mock.method(f.db,'execute'),queries=t.mock.method(f.db,'query');
  for(const path of ['/api/status?include=alerts','/api/alerts','/api/quote?instrument=BTC-USDT-SWAP'])await f.body(await f.call(path,'GET',undefined,alice.cookie));
  assert.equal(reads.mock.callCount(),3,'One repository settings read per business request');assert.equal(initializations.mock.callCount(),0);
  assert.equal(queries.mock.calls.filter(call=>call.arguments[0]==='SELECT * FROM user_settings WHERE user_id=?').length,3);
  assert.equal(writes.mock.calls.filter(call=>String(call.arguments[0]).startsWith('INSERT INTO user_settings')).length,0);
  await f.repositories.settings.patch(alice.id,0,{enabled:true,dailyLimit:7},Date.now());
  const status=(await f.body(await f.call('/api/status?include=alerts','GET',undefined,alice.cookie))).data;
  assert.equal(reads.mock.callCount(),4);assert.equal(status.settingsGeneration,1);assert.equal(status.settings.enabled,true);assert.equal(status.settings.dailyLimit,7);
  const other=(await f.body(await f.call('/api/status','GET',undefined,bob.cookie))).data;
  assert.equal(other.user.id,bob.id);assert.equal(other.settingsGeneration,0);assert.equal(other.settings.enabled,false);assert.equal(other.settings.dailyLimit,20);
  await f.db.execute('UPDATE user_settings SET disabled=1 WHERE user_id=?',[alice.id]);assert.equal((await f.call('/api/status','GET',undefined,alice.cookie)).status,403);
  assert.equal(initializations.mock.callCount(),0);assert.equal(f.wakes(),0);
 }finally{await f.close();}
});

test('missing settings initialize safely under concurrent first reads and are not recreated later',async t=>{
 const f=await fixture();try{
  const alice=await f.login('settings-first-read@example.com');await f.db.execute('DELETE FROM user_settings WHERE user_id=?',[alice.id]);
  const initializations=t.mock.method(f.repositories.settings,'initialize');
  const responses=await Promise.all(Array.from({length:8},()=>f.call('/api/status?include=alerts','GET',undefined,alice.cookie)));
  for(const response of responses){const status=(await f.body(response)).data;assert.equal(status.settingsGeneration,0);assert.equal(status.settings.enabled,false);}
  assert.ok(initializations.mock.callCount()>=1);assert.equal((await f.db.query('SELECT user_id FROM user_settings WHERE user_id=?',[alice.id])).length,1);
  const count=initializations.mock.callCount();await f.body(await f.call('/api/status','GET',undefined,alice.cookie));assert.equal(initializations.mock.callCount(),count);
 }finally{await f.close();}
});

test('first-read initialization cannot overwrite a concurrent account disable',async t=>{
 const f=await fixture();try{
  const alice=await f.login('settings-disable-race@example.com');await f.repositories.settings.initialize(alice.id,Date.now());
  t.mock.method(f.repositories.settings,'get',async()=>{await f.db.execute('UPDATE user_settings SET disabled=1,generation=generation+1 WHERE user_id=?',[alice.id]);return null;});
  const init=t.mock.method(f.repositories.settings,'initialize');assert.equal((await f.call('/api/status','GET',undefined,alice.cookie)).status,403);assert.equal(init.mock.callCount(),1);
  const row=(await f.db.query<{disabled:number;generation:number}>('SELECT disabled,generation FROM user_settings WHERE user_id=?',[alice.id]))[0]!;assert.equal(row.disabled,1);assert.equal(row.generation,1);
 }finally{await f.close();}
});

test('settings read failure remains unavailable rather than restoring defaults',async t=>{
 const f=await fixture();try{
  const alice=await f.login('settings-unavailable@example.com');await f.repositories.settings.initialize(alice.id,Date.now());
  t.mock.method(f.repositories.settings,'get',async()=>{throw new Error('private database failure');});
  const init=t.mock.method(f.repositories.settings,'initialize',async()=>{assert.fail('A failed read must not initialize defaults');});
  const failure=await f.body(await f.call('/api/status?include=alerts','GET',undefined,alice.cookie),503);assert.equal(failure.error.code,'service_unavailable');assert.equal(init.mock.callCount(),0);
 }finally{await f.close();}
});

test('health idle degrades honestly; actual DB/email/provider failures and snapshot throws survive aggregation',async()=>{
 const f=await fixture();try{
  const idle:ComponentHealth={state:'degraded',lastSuccessAt:null,code:'idle_no_active_alerts'};
  const unseen:ComponentHealth={state:'starting',lastSuccessAt:null,code:null};
  let database=good,prices=idle,engineNotification=unseen,apiNotification=unseen,snapshotThrows=false,dbThrows=false;
  let email:ReturnType<typeof f.auth.emailHealth>={state:'healthy',lastSuccessAt:good.lastSuccessAt,code:null};
  const realQuery=f.db.query.bind(f.db);
  const app=createApp({...f,db:{...f.db,query:async(sql:string,params?:any[])=>{if(dbThrows&&sql==='SELECT 1 AS ready')throw new Error('private DB message');return realQuery(sql,params);}} as typeof f.db,
   auth:{...f.auth,emailHealth:()=>email},notifications:{...f.notifications,health:()=>apiNotification},catalog:{get:async()=>({markets:[],updatedAt:null,stale:true})},
   runtime:{snapshot:async()=>{if(snapshotThrows)throw new Error('private snapshot message');return {health:{overall:'unhealthy',database,scheduler:idle,prices,notifications:engineNotification,email:good},lastPollAt:null,prices:[]};}},wake:async()=>{assert.fail('Health cannot wake');}});
  const check=async(status:number,state:string)=>{const response=await app.request(f.config.appUrl+'/api/health');assert.equal(response.status,status);assert.equal((await response.json() as any).data.state,state);};
  await check(200,'degraded');assert.equal(f.providerCalls.length,0);assert.equal(f.messages.length,0);
  prices={state:'unhealthy',lastSuccessAt:null,code:'prices_unavailable'};await check(503,'unhealthy');prices=idle;
  database={state:'unhealthy',lastSuccessAt:null,code:'database_unavailable'};await check(503,'unhealthy');database=good;
  email={state:'unhealthy',lastSuccessAt:null,code:'email_unavailable'};await check(503,'unhealthy');email={state:'healthy',lastSuccessAt:good.lastSuccessAt,code:null};
  engineNotification={state:'unhealthy',lastSuccessAt:null,code:'provider_unavailable'};apiNotification={...good,lastSuccessAt:Date.now()};await check(503,'unhealthy');
  engineNotification={state:'degraded',lastSuccessAt:null,code:'provider_rejected'};await check(200,'degraded');
  const logs:unknown[][]=[];const original=console.error;console.error=(...args:unknown[])=>{logs.push(args);};
  try{snapshotThrows=true;await check(503,'unhealthy');snapshotThrows=false;dbThrows=true;await check(503,'unhealthy');}
  finally{console.error=original;}
  assert.deepEqual(logs,[['open_alert_health_failed','runtime_snapshot'],['open_alert_health_failed','database_probe']]);
 }finally{await f.close();}
});
test('real cookie sessions protect app routes; strict input, trusted origin, catalog, ownership and generation CAS',async()=>{
 const f=await fixture({MAX_ALERTS_PER_USER:'2'});try{
  assert.equal((await f.call('/api/status')).status,401);
  assert.equal((await f.call('/api/alerts','POST',{...input,userId:'forged'},'fake-session=admin')).status,401);
  const alice=await f.login('alice@example.com'),bob=await f.login('bob@example.com');
  const status=(await f.body(await f.call('/api/status','GET',undefined,alice.cookie))).data;assert.equal(status.user.id,alice.id);assert.equal(status.settings.enabled,false);assert.equal(status.capabilities.google,false);
  assert.equal((await f.call('/api/alerts','POST',input,alice.cookie,{Origin:'https://evil.example'})).status,403);
  assert.equal((await f.call('/api/alerts','POST',input,alice.cookie,{Origin:''})).status,403);
  assert.equal((await f.call('/api/alerts','POST',input,alice.cookie,{'Sec-Fetch-Site':'cross-site'})).status,403);
  assert.equal((await f.call('/api/alerts','POST',{...input,userId:bob.id},alice.cookie)).status,400);
  assert.equal((await f.call('/api/alerts','POST',{...input,threshold:'100'},alice.cookie)).status,400);
  assert.equal((await f.call('/api/alerts','POST',{...input,instrument:'FAKE-USDT-SWAP'},alice.cookie)).status,400);
  f.setStale(true);assert.equal((await f.call('/api/alerts','POST',input,alice.cookie)).status,503);f.setStale(false);
  const created=(await f.body(await f.call('/api/alerts','POST',input,alice.cookie),201)).data.alert;
  assert.equal(created.generation,0);assert.equal(created.status,'armed');
  assert.equal((await f.call(`/api/alerts/${created.id}`,'PATCH',{expectedGeneration:0,name:'stolen'},bob.cookie)).status,404);
  assert.equal((await f.call(`/api/alerts/${created.id}`,'DELETE',{expectedGeneration:0},bob.cookie)).status,404);
  assert.equal((await f.call(`/api/alerts/${created.id}/rearm`,'POST',{expectedGeneration:0},bob.cookie)).status,404);
  const changes=await Promise.all([f.call(`/api/alerts/${created.id}`,'PATCH',{expectedGeneration:0,name:'new'},alice.cookie),f.call(`/api/alerts/${created.id}`,'PATCH',{expectedGeneration:0,name:'other'},alice.cookie)]);assert.deepEqual(changes.map(r=>r.status).sort(),[200,409]);
  const updated=(await f.body(await f.call('/api/alerts','GET',undefined,alice.cookie))).data.alerts[0];assert.equal(updated.threshold,100);assert.equal(updated.generation,1);
  await f.body(await f.call(`/api/alerts/${created.id}/rearm`,'POST',{expectedGeneration:1},alice.cookie));
  assert.equal((await f.call(`/api/alerts/${created.id}`,'DELETE',{expectedGeneration:1},alice.cookie)).status,409);
  await f.body(await f.call(`/api/alerts/${created.id}`,'DELETE',{expectedGeneration:2},alice.cookie));assert.equal((await f.repositories.alerts.listForUser(alice.id)).length,0);
  assert.equal((await f.db.query<{deleted_at:number}>('SELECT deleted_at FROM alerts WHERE id=?',[created.id]))[0]!.deleted_at>0,true);
  assert.deepEqual((await f.body(await f.call('/api/alerts','GET',undefined,bob.cookie))).data.alerts,[]);
  await f.body(await f.call('/api/alerts','POST',input,alice.cookie),201);await f.body(await f.call('/api/alerts','POST',input,alice.cookie),201);assert.equal((await f.call('/api/alerts','POST',input,alice.cookie)).status,409);
  assert.equal((await f.call('/api/alerts','POST',input,alice.cookie,{'Content-Type':'text/plain'})).status,400);
  const oversized=await f.app.request(f.config.appUrl+'/api/alerts',{method:'POST',headers:{Origin:f.config.appUrl,Cookie:alice.cookie,'Content-Type':'application/json'},body:' '.repeat(17000)});assert.equal(oversized.status,400);
 }finally{await f.close();}
});
test('enabling unchanged instruments and rearm require eligible catalog; conflicts, disable, rename and delete keep their semantics',async()=>{
 const f=await fixture();try{
  const alice=await f.login('eligibility@example.com'),bob=await f.login('eligibility-other@example.com');
  const a=(await f.body(await f.call('/api/alerts','POST',{...input,enabled:false},alice.cookie),201)).data.alert;
  const before=f.wakes();f.setStale(true);
  for(const [path,method,body] of [[`/api/alerts/${a.id}`,'PATCH',{expectedGeneration:0,enabled:true}],[`/api/alerts/${a.id}/rearm`,'POST',{expectedGeneration:0}]] as const){
   assert.equal((await f.call(path,method,body,alice.cookie)).status,503);
   assert.equal((await f.call(path,method,body,bob.cookie)).status,404);
  }
  assert.equal(f.wakes(),before);assert.equal((await f.repositories.alerts.getForUser(alice.id,a.id))!.generation,0);
  f.setCatalog({markets:[{instrument:a.instrument,base:'BTC',quote:'USDT',tickSize:'0.1',state:'live',tradingViewSymbol:'',available:false}],updatedAt:Date.now(),stale:false});
  assert.equal((await f.call(`/api/alerts/${a.id}`,'PATCH',{expectedGeneration:0,enabled:true},alice.cookie)).status,400);
  assert.equal((await f.call(`/api/alerts/${a.id}/rearm`,'POST',{expectedGeneration:0},alice.cookie)).status,400);
  await f.body(await f.call(`/api/alerts/${a.id}`,'PATCH',{expectedGeneration:0,name:'still editable'},alice.cookie));
  assert.equal((await f.call(`/api/alerts/${a.id}/rearm`,'POST',{expectedGeneration:0},alice.cookie)).status,409);
  await f.body(await f.call(`/api/alerts/${a.id}`,'PATCH',{expectedGeneration:1,enabled:false},alice.cookie));
  await f.body(await f.call(`/api/alerts/${a.id}`,'DELETE',{expectedGeneration:2},alice.cookie));
  assert.equal(f.providerCalls.length,0);
 }finally{await f.close();}
});

test('channel retention uses encrypted own credentials; PUT validates only; explicit normal test claims quota once',async()=>{
 const f=await fixture();try{
  const alice=await f.login('channel@example.com'),bob=await f.login('other@example.com');
  await f.body(await f.call('/api/status','GET',undefined,alice.cookie));await f.body(await f.call('/api/status','GET',undefined,bob.cookie));
  assert.equal((await f.call('/api/channels','PUT',{provider:'pushover',appToken:'P'.repeat(30)},alice.cookie)).status,400);
  const saved=(await f.body(await f.call('/api/channels','PUT',{provider:'pushover',userKey:'A'.repeat(30),appToken:'P'.repeat(30)},alice.cookie))).data;assert.equal(saved.tokenSource,'private');assert.equal(f.providerCalls.length,1);assert.match(f.providerCalls[0]!.url,/validate/);
  assert.equal(JSON.stringify(saved).includes('AAAA'),false);const first=(await f.repositories.channels.get(alice.id))!;assert.equal(await decryptSecret(f.config.encryptionKey,alice.id,'userKey',first.userKey),'A'.repeat(30));
  await f.body(await f.call('/api/channels','PUT',{provider:'pushover',appToken:null},alice.cookie));const cleared=(await f.repositories.channels.get(alice.id))!;assert.deepEqual(cleared.userKey,first.userKey);assert.equal(cleared.privateAppToken,null);assert.equal(f.providerCalls.at(-1)!.body.get('token'),'S'.repeat(30));
  await f.body(await f.call('/api/channels','PUT',{provider:'pushover',userKey:'B'.repeat(30),appToken:'P'.repeat(30)},alice.cookie));await f.body(await f.call('/api/channels','PUT',{provider:'pushover',userKey:'C'.repeat(30)},alice.cookie));assert.equal(f.providerCalls.at(-1)!.body.get('token'),'P'.repeat(30));
  assert.equal((await f.body(await f.call('/api/channels','GET',undefined,bob.cookie))).data.userKeyPresent,false);
  assert.equal((await f.call('/api/test-notification','POST',{confirm:false},alice.cookie)).status,400);assert.equal(f.providerCalls.some(c=>c.url.endsWith('messages.json')),false);
  const result=(await f.body(await f.call('/api/test-notification','POST',{confirm:true},alice.cookie))).data;assert.equal(result.outcome,'sent');const sent=f.providerCalls.at(-1)!;assert.equal(sent.body.get('priority'),'0');assert.equal(sent.body.has('retry'),false);assert.equal(sent.body.get('user'),'C'.repeat(30));
  assert.equal((await f.repositories.settings.dailyUsage(alice.id,Date.now())).attempts,1);assert.equal((await f.call('/api/test-notification','POST',{confirm:true},alice.cookie)).status,429);
  await f.body(await f.call('/api/channels','DELETE',undefined,alice.cookie));assert.equal(await f.repositories.channels.get(alice.id),null);
 }finally{await f.close();}
});
test('pending delivery guards changes; deliberate disable cancels queued work; bootstrap grants one verified user only',async()=>{
 const f=await fixture();try{
  const alice=await f.login('admin@example.com'),bob=await f.login('target@example.com');await f.body(await f.call('/api/status','GET',undefined,alice.cookie));
  assert.equal((await f.call('/api/admin/users','GET',undefined,alice.cookie)).status,403);
  assert.equal((await f.call('/api/admin/bootstrap','POST',undefined,'',{Authorization:`Bearer ${f.config.bootstrapToken}`})).status,401);
  assert.equal((await f.call('/api/admin/bootstrap','POST',undefined,alice.cookie,{Authorization:'Bearer wrong'})).status,403);
  await f.body(await f.call('/api/admin/bootstrap','POST',undefined,alice.cookie,{Authorization:`Bearer ${f.config.bootstrapToken}`}));assert.equal((await f.call('/api/admin/bootstrap','POST',undefined,bob.cookie,{Authorization:`Bearer ${f.config.bootstrapToken}`})).status,409);
  const users=(await f.body(await f.call('/api/admin/users','GET',undefined,alice.cookie))).data;assert.equal(users.items.length,2);
  const invited=(await f.body(await f.call('/api/admin/invites','POST',{email:'NEXT@example.com'},alice.cookie),201)).data;assert.equal(invited.email,'next@example.com');assert.equal(f.messages.at(-1)!.subject,'价格哨站 · 邀请你加入 Open Alert');
  await f.body(await f.call('/api/channels','PUT',{provider:'pushover',userKey:'A'.repeat(30)},alice.cookie));await f.body(await f.call('/api/settings','PATCH',{expectedGeneration:0,enabled:true},alice.cookie));
  const a=(await f.body(await f.call('/api/alerts','POST',input,alice.cookie),201)).data.alert;const now=Date.now(),lease=(await f.repositories.scheduler.acquireLease('test-owner',now,15000))!,triggerId=crypto.randomUUID();
  assert.equal(await f.repositories.alerts.reserveTrigger({triggerId,alertId:a.id,userId:alice.id,generation:0,settingsGeneration:1,channelGeneration:0,tick:{instrument:a.instrument,price:100,timestamp:now,receivedAt:now},now,lease}),true);
  assert.equal((await f.call(`/api/alerts/${a.id}`,'PATCH',{expectedGeneration:0,name:'blocked'},alice.cookie)).status,409);assert.equal((await f.call('/api/channels','DELETE',undefined,alice.cookie)).status,409);assert.equal((await f.call('/api/settings','PATCH',{expectedGeneration:1,dailyLimit:5},alice.cookie)).status,409);
  await f.body(await f.call('/api/settings','PATCH',{expectedGeneration:1,enabled:false},alice.cookie));assert.equal((await f.repositories.outbox.getForUser(alice.id,triggerId))!.phase,'cancelled');assert.equal((await f.repositories.alerts.getForUser(alice.id,a.id))!.triggered,true);
  await f.body(await f.call(`/api/admin/users/${bob.id}`,'PATCH',{disabled:true},alice.cookie));assert.equal((await f.db.query('SELECT id FROM session WHERE user_id=?',[bob.id])).length,0);assert.equal((await f.call('/api/status','GET',undefined,bob.cookie)).status,401);assert.equal((await f.repositories.settings.get(bob.id))!.disabled,true);
  // Existing session that has not been revoked yet must still return the distinct disabled error.
  await f.db.execute('UPDATE user_settings SET disabled=1 WHERE user_id=?',[alice.id]);assert.equal((await f.call('/api/status','GET',undefined,alice.cookie)).status,403);
 }finally{await f.close();}
});
test('provider confirmed rejection and uncertainty return errors and durable audited outcomes without retry',async()=>{
 for(const outcome of ['failed','uncertain'] as const){const f=await fixture();try{
  const user=await f.login(`${outcome}@example.com`);await f.body(await f.call('/api/channels','PUT',{provider:'pushover',userKey:'A'.repeat(30)},user.cookie));f.setProvider(outcome);
  assert.equal((await f.call('/api/test-notification','POST',{confirm:true},user.cookie)).status,outcome==='failed'?502:504);assert.equal((await f.db.query<{phase:string}>('SELECT phase FROM test_notifications'))[0]!.phase,outcome);assert.equal((await f.repositories.settings.dailyUsage(user.id,Date.now())).attempts,1);assert.equal(f.providerCalls.filter(c=>c.url.endsWith('messages.json')).length,1);
 }finally{await f.close();}}
});
test('development origin is explicit for both real OTP and app mutations and is refused in production',async()=>{
 const f=await fixture({NODE_ENV:'test'});try{const user=await f.login('origin@example.com');assert.equal((await f.call('/api/alerts','POST',input,user.cookie,{Origin:'http://localhost:5173'})).status,403);assert.equal((await f.call('/api/auth/email-otp/send-verification-otp','POST',{email:'new@example.com',type:'sign-in'},'',{Origin:'http://localhost:5173'})).status,403);}finally{await f.close();}
 const dev=await fixture({NODE_ENV:'development',DEV_ORIGIN:'http://localhost:5173'});try{await dev.repositories.admin.createInvitation('dev@example.com',Date.now()+60000,Date.now());const origin={Origin:'http://localhost:5173'};assert.equal((await dev.call('/api/auth/email-otp/send-verification-otp','POST',{email:'dev@example.com',type:'sign-in'},'',origin)).status,200);const otp=dev.messages.at(-1)!.text.match(/code is (\d{6})/)![1];const signed=await dev.call('/api/auth/sign-in/email-otp','POST',{email:'dev@example.com',otp},'',origin);assert.equal(signed.status,200);const cookie=signed.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');assert.equal((await dev.call('/api/alerts','POST',input,cookie,origin)).status,201);}finally{await dev.close();}
 assert.throws(()=>loadConfig({NODE_ENV:'production',APP_URL:'https://alert.example.com',AUTH_SECRET:'a'.repeat(32),ENCRYPTION_KEY:'12'.repeat(32),EMAIL_PROVIDER:'resend',EMAIL_FROM:'alerts@example.com',RESEND_API_KEY:'fixture',DEV_ORIGIN:'http://localhost:5173'}));
});

test('persisted app request budget returns 429 and Retry-After across instances',async()=>{
 const f=await fixture();try{const user=await f.login('rate@example.com');await f.body(await f.call('/api/status','GET',undefined,user.cookie));await f.db.execute('UPDATE rate_limit SET count=120,last_request=? WHERE "key" LIKE ?',[Date.now(),'app-auth:api-user:%']);const response=await f.call('/api/alerts','GET',undefined,user.cookie);assert.equal(response.status,429);assert.ok(Number(response.headers.get('Retry-After'))>0);}finally{await f.close();}
});


test('bootstrap is atomic under concurrent verified sessions and missing admin targets return 404',async()=>{
 const f=await fixture();try{
  const alice=await f.login('race-admin-a@example.com'),bob=await f.login('race-admin-b@example.com');
  const authorization={Authorization:`Bearer ${f.config.bootstrapToken}`};
  assert.equal((await f.call('/api/admin/bootstrap','POST',undefined,'',authorization)).status,401);
  const results=await Promise.all([f.call('/api/admin/bootstrap','POST',undefined,alice.cookie,authorization),f.call('/api/admin/bootstrap','POST',undefined,bob.cookie,authorization)]);
  assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
  const winner=results[0]!.status===200?alice:bob,loser=winner===alice?bob:alice;
  assert.equal((await f.db.query('SELECT id FROM "user" WHERE role=?',['admin'])).length,1);
  assert.equal((await f.call('/api/admin/users','GET',undefined,loser.cookie)).status,403);
  const missing=await f.call('/api/admin/users/no-such-user','PATCH',{disabled:true},winner.cookie);
  assert.equal(missing.status,404,await missing.clone().text());
  assert.equal((await f.db.query('SELECT user_id FROM user_settings WHERE user_id=?',['no-such-user'])).length,0);
 }finally{await f.close();}
});

test('view quote requires session, validates canonical market and never saves or wakes alert monitoring',async()=>{
 const f=await fixture();try{
  assert.equal((await f.call('/api/quote?instrument=BTC-USDT-SWAP')).status,401);
  const alice=await f.login('quote@example.com');
  for(const query of ['', '?instrument=forged', '?instrument=BTC-USDT-SWAP&extra=1', '?instrument=BTC-USDT-SWAP&instrument=ETH-USDT-SWAP', '?instrument=FAKE-USDT-SWAP'])assert.equal((await f.call('/api/quote'+query,'GET',undefined,alice.cookie)).status,400);
  const response=await f.body(await f.call('/api/quote?instrument=BTC-USDT-SWAP','GET',undefined,alice.cookie));
  assert.equal(response.data.instrument,'BTC-USDT-SWAP');assert.equal(response.data.price,123);assert.equal(response.data.timestamp,null);
  assert.equal((await f.repositories.alerts.listForUser(alice.id)).length,0);assert.equal((await f.repositories.settings.get(alice.id))!.enabled,false);assert.equal(f.wakes(),0);
  f.setStale(true);assert.equal((await f.call('/api/quote?instrument=BTC-USDT-SWAP','GET',undefined,alice.cookie)).status,503);
 }finally{await f.close();}
});

test('candles require session, validate market/timeframe/cursor and never touch alert state',async()=>{
 const seen:{instrument:string;timeframe:string;before?:number}[]=[];let fail=false;
 const f=await fixture({}, {candles:{get:async(market,timeframe,before)=>{seen.push({instrument:market.instrument,timeframe,...(before===undefined?{}:{before})});if(fail)throw new Error('exchange down');return {instrument:market.instrument,timeframe,candles:[[1,1,2,0.5,1.5,3]],done:false};}}});
 try{
  assert.equal((await f.call('/api/candles?instrument=BTC-USDT-SWAP&timeframe=1h')).status,401);
  const alice=await f.login('candles@example.com');
  for(const query of ['', '?instrument=BTC-USDT-SWAP', '?instrument=BTC-USDT-SWAP&timeframe=2M', '?instrument=BTC-USDT-SWAP&timeframe=60m', '?instrument=BTC-USDT-SWAP&timeframe=1441m', '?instrument=FAKE-USDT-SWAP&timeframe=1h', '?instrument=BTC-USDT-SWAP&timeframe=1h&before=-1', '?instrument=BTC-USDT-SWAP&timeframe=1h&before=abc', '?instrument=BTC-USDT-SWAP&timeframe=1h&timeframe=1d', '?instrument=BTC-USDT-SWAP&timeframe=1h&extra=1'])
   assert.equal((await f.call('/api/candles'+query,'GET',undefined,alice.cookie)).status,400,query);
  assert.equal(seen.length,0);
  const page=await f.body(await f.call('/api/candles?instrument=BTC-USDT-SWAP&timeframe=1h&before=1700000000000','GET',undefined,alice.cookie));
  assert.deepEqual(page.data.candles,[[1,1,2,0.5,1.5,3]]);assert.deepEqual(seen,[{instrument:'BTC-USDT-SWAP',timeframe:'1h',before:1700000000000}]);
  await f.body(await f.call('/api/candles?instrument=ETH-USDT-SWAP&timeframe=1w','GET',undefined,alice.cookie));assert.equal(seen[1]!.before,undefined);
  fail=true;assert.equal((await f.body(await f.call('/api/candles?instrument=BTC-USDT-SWAP&timeframe=1d','GET',undefined,alice.cookie),503)).error.code,'service_unavailable');
  f.setStale(true);fail=false;assert.equal((await f.call('/api/candles?instrument=BTC-USDT-SWAP&timeframe=1d','GET',undefined,alice.cookie)).status,503);
  assert.equal((await f.repositories.alerts.listForUser(alice.id)).length,0);assert.equal(f.wakes(),0);
 }finally{await f.close();}
});

test('candles report service_unavailable on runtimes without a candle source',async()=>{
 const f=await fixture();try{const alice=await f.login('nocandles@example.com');
  assert.equal((await f.call('/api/candles?instrument=BTC-USDT-SWAP&timeframe=1h','GET',undefined,alice.cookie)).status,503);
 }finally{await f.close();}
});

test('quote lookup uses one trusted hop only after authentication/input validation and preserves API errors',async()=>{
 let lookups=0,result:QuoteLookup={quote:{instrument:'BTC-USDT-SWAP',price:123,observedAt:1700000000000,timestamp:null}};
 const f=await fixture({}, {catalog:{get:async()=>{throw new Error('unexpected catalog read');}},quotes:{
  get:async()=>{throw new Error('unexpected second quote hop');},lookup:async instrument=>{lookups++;assert.equal(instrument,'BTC-USDT-SWAP');return result;},
 }});
 try{
  assert.equal((await f.call('/api/quote?instrument=BTC-USDT-SWAP')).status,401);assert.equal(lookups,0);
  const alice=await f.login('quote-lookup@example.com');
  for(const query of ['', '?instrument=forged', '?instrument=BTC-USDT-SWAP&extra=1', '?instrument=BTC-USDT-SWAP&instrument=ETH-USDT-SWAP'])assert.equal((await f.call('/api/quote'+query,'GET',undefined,alice.cookie)).status,400);
  assert.equal(lookups,0);
  const response=await f.call('/api/quote?instrument=BTC-USDT-SWAP','GET',undefined,alice.cookie),body=await f.body(response);
  assert.equal(lookups,1);assert.deepEqual(body.data,result.quote);assert.equal(body.requestId,response.headers.get('X-Request-ID'));
  assert.equal(response.headers.get('Cache-Control'),'no-store');assert.equal(response.headers.get('X-Content-Type-Options'),'nosniff');
  for(const code of ['invalid_request','service_unavailable'] as const){result={quote:null,code};const failure=await f.body(await f.call('/api/quote?instrument=BTC-USDT-SWAP','GET',undefined,alice.cookie),code==='invalid_request'?400:503);assert.equal(failure.error.code,code);}
  assert.equal(lookups,3);assert.equal(f.wakes(),0);assert.deepEqual(await f.repositories.alerts.listForUser(alice.id),[]);
 }finally{await f.close();}
});

test('invitation commit survives rejected/uncertain email, retries return original invite without duplicate sends',async()=>{
 const f=await fixture();try{
  const admin=await f.login('invite-admin@example.com');await f.body(await f.call('/api/admin/bootstrap','POST',{},admin.cookie,{Authorization:`Bearer ${f.config.bootstrapToken}`}));
  let sends=0;
  for(const failure of ['email_rejected','email_uncertain','email_unavailable'] as const){
   f.setInvitationError(failure);const email=`${failure}@example.com`;
   const first=(await f.body(await f.call('/api/admin/invites','POST',{email},admin.cookie),201)).data;
   assert.equal(first.reused,false);assert.equal(first.emailDelivery.status,failure==='email_uncertain'?'uncertain':'failed');assert.equal(first.emailDelivery.reason,failure);
   assert.equal(f.invitationSends(),++sends);assert.equal((await f.repositories.admin.getInvitation(email,Date.now()))!.id,first.id);
   const again=(await f.body(await f.call('/api/admin/invites','POST',{email},admin.cookie))).data;
   assert.equal(again.reused,true);assert.equal(again.id,first.id);assert.equal(again.expiresAt,first.expiresAt);assert.deepEqual(again.emailDelivery,{status:'not_attempted',reason:'existing_invitation'});assert.equal(f.invitationSends(),sends);
  }
 }finally{await f.close();}
});
test('sandbox invitation allows Google admission without attempting restricted mail, exposes no private recipient',async()=>{
 const f=await fixture({EMAIL_PROVIDER:'resend',EMAIL_FROM:'onboarding@resend.dev',RESEND_API_KEY:'fixture-private-key',EMAIL_TEST_RECIPIENT:'owner@example.com'});try{
  const admin=await f.login('owner@example.com');await f.body(await f.call('/api/admin/bootstrap','POST',{},admin.cookie,{Authorization:`Bearer ${f.config.bootstrapToken}`}));
  const result=(await f.body(await f.call('/api/admin/invites','POST',{email:'  NEXT@Example.com  '},admin.cookie),201)).data;
  assert.equal(result.email,'next@example.com');assert.deepEqual(result.emailDelivery,{status:'not_attempted',reason:'resend_sandbox'});assert.equal(f.invitationSends(),0);
  assert.ok(await f.repositories.admin.getInvitation('next@example.com',Date.now()));assert.equal(f.auth.capabilities().emailOtp,true);assert.equal(f.auth.emailHealth().state,'healthy');
  const repeated=(await f.body(await f.call('/api/admin/invites','POST',{email:'next@example.com'},admin.cookie))).data;assert.equal(repeated.id,result.id);assert.equal(repeated.reused,true);assert.equal(f.invitationSends(),0);
  assert.equal((await f.call('/api/admin/invites','POST',{email:'not-authorized@example.com'})).status,401);
 }finally{await f.close();}
});

test('invitation lifecycle is admin-only, paginated, rate-limited and revocation blocks OTP until renewed',async()=>{
 const f=await fixture();try{
  const admin=await f.login('lifecycle-admin@example.com'),member=await f.login('lifecycle-member@example.com');
  await f.body(await f.call('/api/admin/bootstrap','POST',{},admin.cookie,{Authorization:`Bearer ${f.config.bootstrapToken}`}));
  const created=(await f.body(await f.call('/api/admin/invites','POST',{email:'lifecycle-next@example.com'},admin.cookie),201)).data;
  const routes:[string,string,unknown][]=[['GET','/api/admin/invites',undefined],['POST',`/api/admin/invites/${created.id}/resend`,{confirm:true,expectedExpiresAt:created.expiresAt}],['DELETE',`/api/admin/invites/${created.id}`,{expectedExpiresAt:created.expiresAt}]];
  for(const [method,path,body] of routes){assert.equal((await f.call(path,method,body)).status,401);assert.equal((await f.call(path,method,body,member.cookie)).status,403);}
  const page=(await f.body(await f.call('/api/admin/invites?limit=1','GET',undefined,admin.cookie))).data;
  assert.equal(page.items.length,1);assert.ok(page.cursor);
  assert.equal((await f.call(`/api/admin/invites/${created.id}/resend`,'POST',{confirm:true,expectedExpiresAt:created.expiresAt},admin.cookie,{Origin:'https://evil.example'})).status,403);
  const limited=await f.call(`/api/admin/invites/${created.id}/resend`,'POST',{confirm:true,expectedExpiresAt:created.expiresAt},admin.cookie);
  assert.equal(limited.status,429);assert.ok(Number(limited.headers.get('Retry-After'))>0);assert.equal(f.invitationSends(),1);
  await f.body(await f.call(`/api/admin/invites/${created.id}`,'DELETE',{expectedExpiresAt:created.expiresAt},admin.cookie));
  const all=(await f.body(await f.call('/api/admin/invites','GET',undefined,admin.cookie))).data.items;
  assert.equal(all.find((item:any)=>item.id===created.id).status,'revoked');
  assert.equal((await f.call('/api/auth/email-otp/send-verification-otp','POST',{email:created.email,type:'sign-in'})).status,403);
  assert.equal((await f.call(`/api/admin/invites/${created.id}/resend`,'POST',{confirm:true,expectedExpiresAt:created.expiresAt},admin.cookie)).status,409);
  const renewed=(await f.body(await f.call('/api/admin/invites','POST',{email:created.email},admin.cookie),201)).data;
  assert.equal(renewed.id,created.id);assert.equal(renewed.emailDelivery.reason,'delivery_cooldown');assert.equal(f.invitationSends(),1);
  assert.equal((await f.call(`/api/admin/invites/${created.id}`,'DELETE',{expectedExpiresAt:created.expiresAt},admin.cookie)).status,409);
  const existing=await f.body(await f.call('/api/admin/invites','POST',{email:'lifecycle-admin@example.com'},admin.cookie),409);assert.equal(existing.error.code,'account_exists');
 }finally{await f.close();}
});

test('resend uses a shared durable budget, no expiry extension and no automatic retry after uncertain mail',async()=>{
 const f=await fixture();try{
  const admin=await f.login('resend-admin@example.com');await f.body(await f.call('/api/admin/bootstrap','POST',{},admin.cookie,{Authorization:`Bearer ${f.config.bootstrapToken}`}));
  const invite=await f.repositories.admin.createInvitation('resend-next@example.com',Date.now()+60000,Date.now());
  f.setInvitationError('email_uncertain');
  const path=`/api/admin/invites/${invite.id}/resend`,body={confirm:true,expectedExpiresAt:invite.expiresAt};
  const responses=await Promise.all([f.call(path,'POST',body,admin.cookie),f.call(path,'POST',body,admin.cookie)]);
  assert.deepEqual(responses.map(r=>r.status).sort(),[200,429]);assert.equal(f.invitationSends(),1);
  const result=(await responses.find(r=>r.status===200)!.json() as any).data;
  assert.equal(result.emailDelivery.status,'uncertain');assert.equal(result.expiresAt,invite.expiresAt);
  assert.equal((await f.repositories.admin.getInvitation(invite.email,Date.now()))!.expiresAt,invite.expiresAt);
 }finally{await f.close();}
});

test('account overview exposes tenant-scoped invite-beta Pro access and preserves existing limits',async()=>{
 const channelCounts=new Map<string,number>(),favoriteCounts=new Map<string,number>();
 const f=await fixture({MAX_ALERTS_PER_USER:'3',MAX_INSTRUMENTS_PER_USER:'2',DAILY_NOTIFICATION_LIMIT:'9'},{
  hub:{channels:async (userId:string)=>Array.from({length:channelCounts.get(userId)??0},(_,index)=>({id:`channel-${index}`}))} as unknown as NonNullable<ApiDependencies['hub']>,
  anomaly:{store:{favorites:async (userId:string)=>Array.from({length:favoriteCounts.get(userId)??0},(_,index)=>({base:`ASSET${index}`,preferred:null}))}} as unknown as NonNullable<ApiDependencies['anomaly']>,
 });
 try{
  assert.equal((await f.call('/api/account')).status,401);
  const member=await f.login('account-member@example.com'),admin=await f.login('account-admin@example.com');
  await f.body(await f.call('/api/admin/bootstrap','POST',{},admin.cookie,{Authorization:`Bearer ${f.config.bootstrapToken}`}));
  assert.equal((await f.call('/api/channels','PUT',{provider:'pushover',userKey:'A'.repeat(30)},member.cookie)).status,200);
  assert.equal((await f.call('/api/test-notification','POST',{confirm:true},member.cookie)).status,200);
  await f.repositories.alerts.create(member.id,{...input,name:'BTC active'},Date.now());
  await f.repositories.alerts.create(member.id,{...input,name:'ETH active',instrument:'ETH-USDT-SWAP'},Date.now());
  await f.repositories.alerts.create(member.id,{...input,name:'BTC paused',enabled:false},Date.now());
  const overLimit=await f.call('/api/alerts','POST',{...input,name:'over limit'},member.cookie);
  assert.equal(overLimit.status,409);assert.equal((await overLimit.json() as any).error.code,'limit_exceeded');
  channelCounts.set(member.id,1);favoriteCounts.set(member.id,1);

  const before=Date.now(),response=await f.call('/api/account','GET',undefined,member.cookie),account=(await f.body(response)).data;
  assert.equal(Object.keys(account).sort().join(','),'access,usage,user');
  assert.equal(Object.keys(account.user).sort().join(','),'disabled,email,id,name,role');
  assert.equal(account.user.id,member.id);assert.equal(account.user.email,'account-member@example.com');assert.equal(account.user.role,'user');assert.equal(account.user.disabled,false);
  assert.deepEqual(account.access,{
   plan:'pro',phase:'invite_beta',source:'beta_policy',policyVersion:1,billing:'not_enabled',expiresAt:null,
   features:{price_alerts:true,anomaly_crypto:true,anomaly_tradfi:true,native_charts:true,drawing_tools:true,market_favorites:true,notification_channels:true,trading:true},
   limits:{alerts:3,instruments:2,channels:10,favorites:50,priceAttemptsPerDay:9},
  });
  assert.deepEqual(Object.keys(account.usage).sort(),['activeAlerts','alerts','channels','favorites','instruments','observedAt','priceAttempts','utcDate']);
  assert.ok(account.usage.observedAt>=before&&account.usage.observedAt<=Date.now());
  assert.equal(account.usage.utcDate,new Date(account.usage.observedAt).toISOString().slice(0,10));
  assert.equal(account.usage.alerts,3);assert.equal(account.usage.activeAlerts,2);assert.equal(account.usage.instruments,2);
  assert.equal(account.usage.channels,1);assert.equal(account.usage.favorites,1);assert.equal(account.usage.priceAttempts,1);
  const serialized=JSON.stringify(account);
  assert.doesNotMatch(serialized,/bootstrap|secret|private.key|authorization|coordinator|runtime|operator|database|smtp|resend/i);

  for(const query of ['?tenant=other','?x=1','?plan=pro','?user='])assert.equal((await f.call('/api/account'+query,'GET',undefined,member.cookie)).status,400,query);
  const adminAccount=(await f.body(await f.call('/api/account','GET',undefined,admin.cookie))).data;
  assert.equal(adminAccount.user.id,admin.id);assert.equal(adminAccount.user.role,'admin');
  assert.deepEqual(adminAccount.access.limits,{alerts:null,instruments:null,channels:null,favorites:null,priceAttemptsPerDay:null});
  assert.deepEqual(adminAccount.access.features,account.access.features);
  assert.equal(adminAccount.usage.alerts,0);assert.equal(adminAccount.usage.activeAlerts,0);assert.equal(adminAccount.usage.instruments,0);
  assert.equal(adminAccount.usage.channels,0);assert.equal(adminAccount.usage.favorites,0);assert.equal(adminAccount.usage.priceAttempts,0);

  const generation=(await f.repositories.settings.get(member.id))!.generation,patches:[string,unknown][]=[
   ['plan','enterprise'],['phase','paid'],['source','client'],['policyVersion',2],['billing','enabled'],
   ['expiresAt',Date.now()+86400000],['features',{price_alerts:false}],['limits',{alerts:999,instruments:999,channels:999,favorites:999,priceAttemptsPerDay:999}],
  ];
  for(const [key,value] of patches){
   const rejected=await f.call('/api/settings','PATCH',{expectedGeneration:generation,[key]:value},member.cookie);
   assert.equal(rejected.status,400,key);
  }
  assert.equal((await f.repositories.settings.get(member.id))!.generation,generation);
  assert.deepEqual((await f.body(await f.call('/api/account','GET',undefined,member.cookie))).data.access,account.access);

  await f.db.execute('UPDATE user_settings SET disabled=1 WHERE user_id=?',[member.id]);
  assert.equal((await f.call('/api/account','GET',undefined,member.cookie)).status,403);
 }finally{await f.close();}
});

test('account overview reports optional channel and favorite stores as unavailable',async()=>{
 const f=await fixture({}, {hub:undefined,anomaly:undefined} as unknown as Partial<ApiDependencies>);
 try{
  const user=await f.login('account-optional@example.com');
  const account=(await f.body(await f.call('/api/account','GET',undefined,user.cookie))).data;
  assert.equal(account.user.id,user.id);
  assert.equal(account.usage.channels,null);assert.equal(account.usage.favorites,null);
  assert.equal(account.access.plan,'pro');
 }finally{await f.close();}
});

test('OKX trade relay forwards only allowlisted signed requests and reports uncertain orders',async()=>{
 const {createOkxRelay,RelayUncertainError}=await import('../src/trade/okx-relay.js');
 const sent:{method:string;path:string;headers:Record<string,string>;body:string}[]=[];let fail:Error|null=null;
 const relay=createOkxRelay({egress:'16.148.25.106',send:async req=>{sent.push(req);if(fail)throw fail;return {status:200,body:'{"code":"0","data":[]}'};}});
 const absent=await fixture();
 const f=await fixture({}, {trade:relay});
 try{
  const headers={key:'k-1',sign:'c2lnbg==',timestamp:'2026-10-31T00:00:00.000Z',passphrase:'pass phrase'};
  const order={method:'POST',path:'/api/v5/trade/order',body:'{"instId":"BTC-USDT-SWAP"}',headers};
  assert.equal((await f.call('/api/trade/okx','POST',order)).status,401);
  const alice=await f.login('trader@example.com');
  assert.equal((await f.call('/api/trade/okx','POST',order,alice.cookie,{Origin:'https://evil.example'})).status,403);
  assert.deepEqual((await f.body(await f.call('/api/trade/okx','GET',undefined,alice.cookie))).data,{available:true,egress:'16.148.25.106'});
  const forwarded=await f.body(await f.call('/api/trade/okx','POST',{...order,simulated:true},alice.cookie));
  assert.deepEqual(forwarded.data,{status:200,body:'{"code":"0","data":[]}'});
  assert.equal(sent[0]!.path,'/api/v5/trade/order');assert.equal(sent[0]!.headers['OK-ACCESS-KEY'],'k-1');assert.equal(sent[0]!.headers['x-simulated-trading'],'1');
  assert.equal(sent[0]!.headers['OK-ACCESS-PASSPHRASE'],'pass phrase');
  await f.body(await f.call('/api/trade/okx','POST',{method:'GET',path:'/api/v5/account/positions',query:'instType=SWAP',headers},alice.cookie));
  assert.equal(sent[1]!.path,'/api/v5/account/positions?instType=SWAP');assert.equal(sent[1]!.headers['x-simulated-trading'],undefined);
  // Withdrawal, transfer and unknown paths never leave the server.
  for(const path of ['/api/v5/asset/withdrawal','/api/v5/asset/transfer','/api/v5/trade/order/../../asset/withdrawal','/api/v5/account/positions?x=1','https://evil.example/api/v5/trade/order'])
   assert.equal((await f.call('/api/trade/okx','POST',{...order,path},alice.cookie)).status,400,path);
  assert.equal((await f.call('/api/trade/okx','POST',{...order,method:'GET'},alice.cookie)).status,400);
  assert.equal((await f.call('/api/trade/okx','POST',{...order,body:'not json'},alice.cookie)).status,400);
  assert.equal((await f.call('/api/trade/okx','POST',{...order,headers:{...headers,key:'a\r\nb'}},alice.cookie)).status,400);
  assert.equal((await f.call('/api/trade/okx','POST',{...order,extra:1},alice.cookie)).status,400);
  assert.equal((await f.call('/api/trade/okx','POST',{...order,body:JSON.stringify({x:'x'.repeat(9000)})},alice.cookie)).status,400);
  assert.equal(sent.length,2);
  fail=new RelayUncertainError();
  assert.equal((await f.body(await f.call('/api/trade/okx','POST',order,alice.cookie),504)).error.code,'trade_uncertain');
  assert.equal((await f.call('/api/trade/okx','POST',{method:'GET',path:'/api/v5/account/balance',headers},alice.cookie)).status,503);
  const bob=await absent.login('no-relay@example.com');
  assert.equal((await absent.call('/api/trade/okx','POST',order,bob.cookie)).status,503);
 }finally{await f.close();await absent.close();}
});
