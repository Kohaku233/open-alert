import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {Miniflare,Response as MfResponse} from 'miniflare';
import type {D1Database} from '@cloudflare/workers-types';
import {D1SqlDatabase} from '../src/db/d1.js';
import {applyD1Schema} from '../src/db/migrations.js';
import type {RuntimeSnapshot} from '../src/api/ports.js';
import {publicExchangeFixture} from './runtime-cloudflare-fixtures.js';
import type {SystemStatus,Alert} from '../src/contracts/domain.js';

const bundle=resolve('dist/worker/cloudflare.js');
const origin='https://alert.example.com';
const bootstrapToken='runtime-test-bootstrap-token-at-least-32-characters';
const pause=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
async function eventually<T>(read:()=>Promise<T>,accept:(value:T)=>boolean,label:string):Promise<T> {
 const deadline=Date.now()+3000;
 do {const value=await read();if(accept(value))return value;await pause(25);}while(Date.now()<deadline);
 assert.fail(`Timed out waiting for ${label}`);
}

// The dedicated npm script builds this exact production bundle before running the test.
// The general suite may run before cf:check, in which case this integration is explicitly skipped.
test('bundled workerd Worker: explicit fresh D1 migration, real OTP sessions, tenant API and demand-only coordinator',{
 skip:!existsSync(bundle)?'Run npm run cf:check to build the production Worker bundle':false,timeout:45000,
},async t=>{
 const script=await readFile(bundle,'utf8');
 const persistence=await mkdtemp(join(tmpdir(),'open-alert-runtime-'));
 const emails:{to:string[];subject:string;text:string}[]=[];
 const validations:URLSearchParams[]=[];
 const deliveries:URLSearchParams[]=[];
 const unexpected:string[]=[];
 let catalogRequests=0,tickerRequests=0,domainRequests=0;
 const userKey='U'.repeat(30),appToken='T'.repeat(30);
 const secondKey='V'.repeat(30),secondToken='S'.repeat(30);
 const text=(value:string)=>({type:'text' as const,value});
 const mf=new Miniflare({resourcePersistencePath:persistence,workers:[{
  config:{name:'open-alert',compatibilityDate:'2026-10-11',compatibilityFlags:['nodejs_compat'],
   manifest:{mainModule:'cloudflare.js',modulesRoot:'/',modules:{'cloudflare.js':{type:'esm',contents:script}}},
   env:{DB:{type:'d1',id:'runtime-worker-fresh-test'},COORDINATOR:{type:'durable-object',worker:'open-alert',exportName:'Coordinator'},
    NODE_ENV:text('test'),APP_URL:text(origin),AUTH_SECRET:text('worker-test-at-least-thirty-two-characters'),ENCRYPTION_KEY:text('15'.repeat(32)),
    EMAIL_PROVIDER:text('resend'),EMAIL_FROM:text('Open Alert <login@alert.example.com>'),RESEND_API_KEY:text('re_fake_runtime_key'),BOOTSTRAP_TOKEN:text(bootstrapToken)},
   exports:{Coordinator:{type:'durable-object',storage:'sqlite'}}},
  dev:{outboundService:{type:'fetcher',handler:async request=>{
   const url=new URL(request.url);
   if(url.hostname==='api.resend.com'){
    assert.equal(request.headers.get('authorization'),'Bearer re_fake_runtime_key');
    if(url.pathname==='/domains'&&request.method==='GET'){domainRequests++;return MfResponse.json({data:[{name:'alert.example.com',status:'verified'}]});}
    if(url.pathname==='/emails'&&request.method==='POST'){const body=await request.json() as {to:string[];subject:string;text:string};emails.push(body);return MfResponse.json({id:`email-${emails.length}`});}
   }
   if(request.method==='GET'){
    const fixture=publicExchangeFixture(url,Date.now(),tickerRequests+1);
    if(fixture){if(fixture.kind==='catalog')catalogRequests++;else tickerRequests++;return MfResponse.json(fixture.body);}
   }
   if(url.hostname==='api.pushover.net'&&request.method==='POST'){
    const body=new URLSearchParams(await request.text());
    if(url.pathname==='/1/users/validate.json'){validations.push(body);return MfResponse.json({status:1,request:`validation-${validations.length}`});}
    if(url.pathname==='/1/messages.json'){deliveries.push(body);return MfResponse.json({status:1,request:`delivery-${deliveries.length}`,receipt:'R'.repeat(30)});}
   }
   unexpected.push(`${request.method} ${url.origin}${url.pathname}`);
   throw new Error('Unexpected external request in bundled runtime integration');
  }}},
 }]});
 const request=(path:string,method='GET',body?:object,cookie?:string,extra:Record<string,string>={})=>mf.dispatchFetch(origin+path,{
  method,headers:{origin,'content-type':'application/json','cf-connecting-ip':'192.0.2.1',...(cookie?{cookie}:{}),...extra},...(body?{body:JSON.stringify(body)}:{}),
 });
 async function api<T>(path:string,method='GET',body?:object,cookie?:string,status=200,extra:Record<string,string>={}):Promise<T>{
  const response=await request(path,method,body,cookie,extra);
  assert.equal(response.status,status,`${method} ${path}: ${await response.clone().text()}`);
  const envelope=await response.json() as {ok:boolean;data:T};assert.equal(envelope.ok,true);return envelope.data;
 }
 let aliceCookie='',bobCookie='',aliceId='',bobId='';
 let settingsGeneration=0;
 let firstAlert:Alert,secondAlert:Alert;
 try {
  const raw=await mf.getD1Database('DB');
  const db=new D1SqlDatabase(raw as unknown as D1Database);
  await t.test('requests fail closed without operator migrations and create no application tables',async()=>{
   const before=await db.query<{name:string}>("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB '_cf_*' ORDER BY name");
   const capabilities=await api<{google:boolean;emailOtp:boolean;registration:string;emailProvider:string}>('/api/auth-capabilities');
   assert.deepEqual({google:capabilities.google,emailOtp:capabilities.emailOtp,registration:capabilities.registration,emailProvider:capabilities.emailProvider},{google:false,emailOtp:false,registration:'closed',emailProvider:'unconfigured'});
   assert.equal((await request('/api/health')).status,503);
   assert.equal((await request('/api/auth/email-otp/send-verification-otp','POST',{email:'alice@example.com',type:'sign-in'})).status,503);
   assert.equal((await request('/api/status')).status,503);
   assert.deepEqual(await db.query("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB '_cf_*' ORDER BY name"),before);
   assert.ok(!before.some(row=>['schema_migrations','user','auth_registration_policy','alerts'].includes(row.name)));
   assert.equal(domainRequests,0);assert.equal(emails.length,0);assert.equal(tickerRequests,0);assert.equal(catalogRequests,0);
   assert.equal((await mf.listDurableObjectIds('COORDINATOR')).length,0);
   assert.deepEqual(await applyD1Schema(db,{maxUsers:1000,inviteOnly:true}),['auth_0001_auth','0001_app','auth_0002_registration_guards','0002_scheduler_indexes']);
   assert.equal((await db.query('SELECT * FROM schema_migrations')).length,4);
   assert.deepEqual(await db.query("SELECT max_users,invite_only FROM auth_registration_policy WHERE id='registration'"),[{max_users:1000,invite_only:1}]);
  });

  await t.test('Resend receives real generated OTP; invalid/replayed codes and forged cookies fail',async()=>{
   const capabilities=await api<{emailOtp:boolean;emailProvider:string;registration:string}>('/api/auth-capabilities');
   assert.equal(capabilities.emailOtp,true);assert.equal(capabilities.emailProvider,'resend');assert.equal(capabilities.registration,'invite');assert.ok(domainRequests>=1);
   assert.equal((await request('/api/status')).status,401);
   assert.equal((await request('/api/admin/bootstrap','POST',{},undefined,{authorization:`Bearer ${bootstrapToken}`})).status,401);
   assert.equal((await request('/api/auth/email-otp/send-verification-otp','POST',{email:'uninvited@example.com',type:'sign-in'})).status,403);
   assert.equal(emails.length,0);
   for(const [index,email] of ['alice@example.com','bob@example.com'].entries()){
    await db.execute('INSERT INTO invitations(id,email,expires_at) VALUES(?,?,?)',[`runtime-invite-${index}`,email,Date.now()+60000]);
    const sent=await request('/api/auth/email-otp/send-verification-otp','POST',{email,type:'sign-in'});assert.equal(sent.status,200,await sent.clone().text());
    const message=emails.at(-1)!;assert.deepEqual(message.to,[email]);
    const otp=message.text.match(/code is (\d{6})/)?.[1];assert.ok(otp,'Capture the real generated OTP from Resend text');
    const verification=await db.query<{value:string}>('SELECT value FROM verification');assert.ok(verification.length);assert.ok(verification.every(row=>!row.value.includes(otp)));
    const wrong=otp==='000000'?'111111':'000000';
    assert.equal((await request('/api/auth/sign-in/email-otp','POST',{email,otp:wrong})).status,400);
    const signed=await request('/api/auth/sign-in/email-otp','POST',{email,otp,role:'admin'});assert.equal(signed.status,200,await signed.clone().text());
    const account=await signed.json() as {user:{id:string;role:string;emailVerified:boolean}};assert.equal(account.user.role,'user');assert.equal(account.user.emailVerified,true);
    const setCookies=signed.headers.getSetCookie();assert.match(setCookies.join('\n'),/HttpOnly/i);assert.match(setCookies.join('\n'),/Secure/i);assert.match(setCookies.join('\n'),/SameSite=Lax/i);
    const cookie=setCookies.map(value=>value.split(';')[0]).join('; ');assert.ok(cookie.includes('__Secure-'));
    if(index===0){aliceCookie=cookie;aliceId=account.user.id;}else{bobCookie=cookie;bobId=account.user.id;}
    const sessionResponse=await request('/api/auth/get-session','GET',undefined,cookie);assert.equal(sessionResponse.status,200);
    const session=await sessionResponse.json() as {user:{id:string;email:string};session:{userId:string}};assert.equal(session.user.id,account.user.id);assert.equal(session.user.email,email);assert.equal(session.session.userId,account.user.id);
    assert.equal((await request('/api/auth/sign-in/email-otp','POST',{email,otp})).status,400);
    assert.equal((await db.query<{consumed_by:string}>('SELECT consumed_by FROM invitations WHERE email=?',[email]))[0]!.consumed_by,account.user.id);
   }
   assert.equal(emails.length,2);assert.equal((await db.query('SELECT id FROM "session"')).length,2);
   assert.equal((await request('/api/status','GET',undefined,'__Secure-better-auth.session_token=forged.signature')).status,401);
   const forged=aliceCookie.replace(/(session_token=)[^;]+/,'$1forged.signature');
   assert.notEqual(forged,aliceCookie);assert.equal((await request('/api/status','GET',undefined,forged)).status,401);
  });

  await t.test('bootstrap requires real session plus bearer and persists its one-time flag',async()=>{
   assert.equal((await request('/api/admin/bootstrap','POST',{},aliceCookie,{authorization:'Bearer incorrect-token'})).status,403);
   assert.equal((await db.query<{value:string}>("SELECT value FROM app_meta WHERE key='bootstrap-consumed'"))[0]!.value,'0');
   assert.deepEqual(await api('/api/admin/bootstrap','POST',{},aliceCookie,200,{authorization:`Bearer ${bootstrapToken}`}),{bootstrapped:true});
   assert.equal((await db.query<{value:string}>("SELECT value FROM app_meta WHERE key='bootstrap-consumed'"))[0]!.value,'1');
   assert.equal((await db.query<{role:string}>('SELECT role FROM "user" WHERE id=?',[aliceId]))[0]!.role,'admin');
   assert.equal((await request('/api/admin/bootstrap','POST',{},aliceCookie,{authorization:`Bearer ${bootstrapToken}`})).status,409);
   assert.equal((await request('/api/admin/bootstrap','POST',{},bobCookie,{authorization:`Bearer ${bootstrapToken}`})).status,409);
   assert.equal((await db.query<{role:string}>('SELECT role FROM "user" WHERE id=?',[bobId]))[0]!.role,'user');
  });

  const namespace=await mf.getDurableObjectNamespace('COORDINATOR');
  const id=namespace.idFromName('coordinator-v1');const coordinator=namespace.get(id);
  const snapshot=async()=>{const response=await coordinator.fetch('https://coordinator.internal/snapshot');assert.equal(response.status,200);return await response.json() as RuntimeSnapshot;};
  // Miniflare 4's SQL inspection wrapper needs RPC-enabled classes. Read workerd's
  // persisted alarm index instead: no modified bundle, injected hooks, or storage writes.
  const alarm=async():Promise<number|null>=>{
   const metadata=new DatabaseSync(join(persistence,'do','open-alert-Coordinator','metadata.sqlite'),{readOnly:true});
   try {const query=metadata.prepare('SELECT scheduled_time FROM _cf_ALARM WHERE actor_id=?');query.setReadBigInts(true);const row=query.get(id.toString()) as {scheduled_time:bigint|null}|undefined;return row?.scheduled_time==null?null:Number(row.scheduled_time/1_000_000n);}
   finally {metadata.close();}
  };
  const wake=async()=>{assert.equal((await coordinator.fetch('https://coordinator.internal/wake',{method:'POST'})).status,202);};
  await t.test('idle catalog discovery and wake never poll prices or keep an alarm',async()=>{
   const initial=await snapshot();assert.equal(initial.marketMode,'polling');assert.equal(initial.lastPollAt,null);assert.deepEqual(initial.prices,[]);assert.equal(initial.health.scheduler.code,'idle_no_active_alerts');assert.equal(await alarm(),null);
   assert.equal(initial.health.prices.state,'degraded');assert.equal(initial.health.prices.code,'idle_no_active_alerts');
   assert.equal(initial.health.database.state,'healthy');assert.equal(initial.health.notifications.state,'degraded');
   assert.equal(initial.health.overall,'degraded');assert.equal((await request('/api/health')).status,200);
   assert.equal((await api<SystemStatus>('/api/status','GET',undefined,aliceCookie)).health.overall,'degraded');
   assert.equal(tickerRequests,0);assert.equal(deliveries.length,0);assert.equal(emails.length,2);
   const catalog=await coordinator.fetch('https://coordinator.internal/catalog');assert.equal(catalog.status,200);
   const catalogBody=await catalog.json() as {stale:boolean;markets:unknown[]};assert.equal(catalogBody.stale,false);assert.equal(catalogBody.markets.length,12);
   assert.equal(catalogRequests,6);assert.equal(tickerRequests,0);assert.equal((await snapshot()).lastPollAt,null);
   await wake();await eventually(alarm,value=>value===null,'idle wake alarm removal');
   await pause(5200);assert.equal(tickerRequests,0);assert.equal(await alarm(),null);assert.equal((await snapshot()).lastPollAt,null);
   assert.equal((await db.query('SELECT id FROM scheduler_lease')).length,0);
   for(const path of ['/snapshot','/catalog','/wake'])assert.notEqual((await request(path,path==='/wake'?'POST':'GET')).status,200,'Private coordinator endpoints must not be exposed through the Worker');
  });

  await t.test('actual channel and alert API encrypts credentials and isolates two tenants',async()=>{
   for(const [cookie,key,token] of [[aliceCookie,userKey,appToken],[bobCookie,secondKey,secondToken]]){
    const channel=await api<{configured:boolean;tokenSource:string}>('/api/channels','PUT',{provider:'pushover',userKey:key,appToken:token},cookie);assert.equal(channel.configured,true);assert.equal(channel.tokenSource,'private');assert.ok(!JSON.stringify(channel).includes(key!));
   }
   assert.equal(validations.length,2);assert.equal(validations[0]!.get('user'),userKey);assert.equal(validations[0]!.get('token'),appToken);assert.equal(validations[1]!.get('user'),secondKey);assert.equal(validations[1]!.get('token'),secondToken);
   const stored=await db.query<{user_key_json:string;private_token_json:string}>('SELECT user_key_json,private_token_json FROM channels WHERE user_id=?',[aliceId]);
   assert.equal(JSON.parse(stored[0]!.user_key_json).algorithm,'A256GCM');assert.equal(JSON.parse(stored[0]!.private_token_json).algorithm,'A256GCM');assert.ok(!JSON.stringify(stored).includes(userKey));assert.ok(!JSON.stringify(stored).includes(appToken));
   const create=(name:string,threshold:number)=>api<{alert:Alert}>('/api/alerts','POST',{name,instrument:'BTC-USDT-SWAP',side:'upper',threshold,enabled:true},aliceCookie,201);
   firstAlert=(await create('runtime first',90)).alert;secondAlert=(await create('runtime second',90)).alert;
   await create('runtime armed sentinel',1000); // Keeps active work after both matching alerts latch.
   await api('/api/alerts','POST',{name:'bob disabled',instrument:'ETH-USDT-SWAP',side:'upper',threshold:90,enabled:false},bobCookie,201);
   assert.equal((await api<{alerts:Alert[]}>('/api/alerts','GET',undefined,aliceCookie)).alerts.length,3);
   const bobAlerts=(await api<{alerts:Alert[]}>('/api/alerts','GET',undefined,bobCookie)).alerts;assert.equal(bobAlerts.length,1);assert.equal(bobAlerts[0]!.name,'bob disabled');
   for(const [method,path,body] of [['PATCH',`/api/alerts/${firstAlert.id}`,{expectedGeneration:firstAlert.generation,name:'foreign'}],['POST',`/api/alerts/${firstAlert.id}/rearm`,{expectedGeneration:firstAlert.generation}],['DELETE',`/api/alerts/${firstAlert.id}`,{expectedGeneration:firstAlert.generation}]] as const){assert.equal((await request(path,method,body,bobCookie)).status,404);}
   const status=await api<SystemStatus>('/api/status','GET',undefined,aliceCookie);settingsGeneration=status.settingsGeneration;
   assert.equal(status.settings.enabled,false);assert.equal(tickerRequests,0);assert.equal(deliveries.length,0);await eventually(alarm,value=>value===null,'disabled settings leave coordinator idle');
  });

  await t.test('API activation reserves/delivers at most one alert per cycle and next wake processes the rest',async()=>{
   const enabled=await api<{generation:number}>('/api/settings','PATCH',{expectedGeneration:settingsGeneration,enabled:true},aliceCookie);settingsGeneration=enabled.generation;
   await eventually(()=>db.query<{phase:string}>('SELECT phase FROM outbox'),rows=>rows.length===1&&rows[0]!.phase==='sent','first real alarm delivery commit');
   await pause(150);assert.equal(deliveries.length,1);assert.equal((await db.query('SELECT trigger_id FROM outbox')).length,1);assert.equal(tickerRequests,1);
   const nextAlarm=await alarm();assert.ok(nextAlarm!==null&&nextAlarm>Date.now()&&nextAlarm<=Date.now()+5000,'Active coordinator persists its five-second recovery alarm');
   assert.equal(deliveries[0]!.get('user'),userKey);assert.equal(deliveries[0]!.get('token'),appToken);assert.equal(deliveries[0]!.get('priority'),'2');assert.equal(deliveries[0]!.get('sound'),'siren');
   await Promise.all([snapshot(),snapshot(),snapshot()]);await pause(100);
   assert.equal(deliveries.length,1,'Read-only status requests must not accelerate dispatch or refresh active rules');
   await wake();
   await eventually(()=>db.query<{phase:string}>('SELECT phase FROM outbox'),rows=>rows.length===2&&rows.every(row=>row.phase==='sent'),'second bounded wake delivery commit');
   assert.equal(deliveries.length,2);assert.equal(tickerRequests,1,'Cached tick is reused within the five-second price cadence');
   for(const delivery of deliveries){assert.equal(delivery.get('user'),userKey);assert.equal(delivery.get('token'),appToken);}
   const status=await api<SystemStatus>('/api/status','GET',undefined,aliceCookie);assert.ok(status.scheduler.lastPollAt);assert.equal(status.prices.length,1);assert.equal(status.prices[0]!.instrument,'BTC-USDT-SWAP');assert.equal(status.prices[0]!.price,100);
   const bobStatus=await api<SystemStatus>('/api/status','GET',undefined,bobCookie);assert.deepEqual(bobStatus.prices,[],'Disabled rules do not create market demand or obtain another tenant’s prices');assert.equal(bobStatus.daily.attempts,0);assert.equal(bobStatus.settings.enabled,false);
   const alerts=(await api<{alerts:Alert[]}>('/api/alerts','GET',undefined,aliceCookie)).alerts;
   for(const id of [firstAlert.id,secondAlert.id]){const alert=alerts.find(alert=>alert.id===id)!;assert.equal(alert.triggered,true);assert.equal(alert.last?.outcome,'sent');assert.equal(alert.last?.receiptAvailable,true);assert.equal(alert.pending,null);}
   const leases=await db.query<{id:string}>('SELECT id FROM scheduler_lease');assert.deepEqual(leases,[{id:'coordinator-v1'}]);assert.deepEqual(await mf.listDurableObjectIds('COORDINATOR'),[id.toString()]);
  });

  await t.test('disabling settings removes every alarm and retains original idle price timestamps',async()=>{
   await api('/api/settings','PATCH',{expectedGeneration:settingsGeneration,enabled:false},aliceCookie);
   await eventually(alarm,value=>value===null,'disabled monitoring removes durable alarm');
   const idle=await snapshot();assert.equal(idle.health.scheduler.code,'idle_no_active_alerts');assert.notEqual(idle.health.scheduler.state,'healthy');assert.ok(idle.lastPollAt);
   const polls=tickerRequests;await pause(5200);
   const later=await snapshot();assert.equal(await alarm(),null);assert.equal(tickerRequests,polls);assert.equal(deliveries.length,2);assert.equal(later.lastPollAt,idle.lastPollAt);assert.deepEqual(later.prices,idle.prices);
   const status=await api<SystemStatus>('/api/status','GET',undefined,aliceCookie);assert.equal(status.settings.enabled,false);assert.notEqual(status.health.overall,'healthy');assert.equal(status.health.scheduler.code,'idle_no_active_alerts');assert.equal(status.scheduler.lastPollAt,idle.lastPollAt);assert.equal(status.prices[0]!.timestamp,idle.prices.find(price=>price.instrument==='BTC-USDT-SWAP')!.timestamp);
   assert.equal((await mf.listDurableObjectIds('COORDINATOR')).length,1);assert.deepEqual(unexpected,[]);
  });
  await t.test('independent authenticated quote uses bounded resolver and never wakes or modifies idle rules',async()=>{
   assert.equal((await request('/api/quote?instrument=BTC-USDT-SWAP')).status,401);
   const original=(await api<{alerts:Alert[]}>('/api/alerts','GET',undefined,aliceCookie)).alerts;
   const engineBefore=await snapshot(),polls=tickerRequests,catalogs=catalogRequests;
   const quote=await api<{instrument:string;price:number;timestamp:number|null;observedAt:number}>('/api/quote?instrument=BTC-USDT-SWAP','GET',undefined,aliceCookie);
   assert.equal(quote.instrument,'BTC-USDT-SWAP');assert.equal(quote.price,100);assert.ok(quote.observedAt>=quote.timestamp!);
   assert.equal(tickerRequests,polls+1);assert.equal(catalogRequests,catalogs,'Quote reuses validated metadata instead of loading another full catalog');
   assert.deepEqual(await api('/api/quote?instrument=BTC-USDT-SWAP','GET',undefined,aliceCookie),quote);assert.equal(tickerRequests,polls+1);
   assert.deepEqual((await api<{alerts:Alert[]}>('/api/alerts','GET',undefined,aliceCookie)).alerts,original);
   assert.deepEqual((await snapshot()).prices,engineBefore.prices);assert.equal(await alarm(),null);
   assert.equal((await api<SystemStatus>('/api/status','GET',undefined,aliceCookie)).settings.enabled,false);
   for(const path of ['/quote?instrument=BTC-USDT-SWAP','/market?instrument=BTC-USDT-SWAP'])assert.notEqual((await request(path)).status,200);
  });
 } finally {
  await mf.dispose();
  await rm(persistence,{recursive:true,force:true});
 }
});
