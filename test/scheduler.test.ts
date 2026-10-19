import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSQLite } from '../src/db/sqlite.js';
import { migrateApp } from '../src/db/migrations.js';
import { createRepositories } from '../src/db/repositories.js';
import { loadConfig } from '../src/config.js';
import { createScheduler } from '../src/scheduler/index.js';
import { encryptSecret, createNotificationService } from '../src/notifications/index.js';
import type { Fetch } from '../src/notifications/http.js';
import { createRequire } from 'node:module';
import { D1SqlDatabase } from '../src/db/d1.js';
import type { D1Database } from '@cloudflare/workers-types';
import type { SqlDatabase } from '../src/contracts/db.js';
import type { SchedulerOptions } from '../src/scheduler/index.js';
const initial=1700000000000,key='ab'.repeat(32),token='T'.repeat(30);
async function fixture(extra:Record<string,unknown>={}, suppliedDb?:SqlDatabase) {
 const db=suppliedDb??await createSQLite(':memory:',true);let time=initial;
 await db.execute('CREATE TABLE "user"(id TEXT PRIMARY KEY,email TEXT NOT NULL,name TEXT NOT NULL,role TEXT NOT NULL DEFAULT \'user\')');
 await db.execute('CREATE TABLE "session"(id TEXT PRIMARY KEY,user_id TEXT)');await migrateApp(db,time);
 const config=loadConfig({NODE_ENV:'test',APP_URL:'http://localhost:3000',AUTH_SECRET:'a'.repeat(32),ENCRYPTION_KEY:key,EMAIL_PROVIDER:'console',SQLITE_PATH:':memory:',PUSHOVER_APP_TOKEN:token,...extra});
 const r=createRepositories(db,config);
 for(const id of ['u1','u2']) {await db.execute('INSERT INTO "user"(id,email,name) VALUES(?,?,?)',[id,`${id}@example.com`,id]);await r.settings.initialize(id,time);await r.channels.put(id,null,await encryptSecret(key,id,'userKey',id==='u1'?'U'.repeat(30):'V'.repeat(30)),null,time);await r.settings.patch(id,0,{enabled:true},time);}
 const calls:{url:string;body:URLSearchParams}[]=[];
 let ticks:{instId:string;last:string;ts:string}[]|null=null;
 let catalog=[{instId:'BTC-USDT-SWAP',instType:'SWAP',state:'live',settleCcy:'USDT',tickSz:'0.1'},{instId:'ETH-USDT-SWAP',instType:'SWAP',state:'live',settleCcy:'USDT',tickSz:'0.01'},{instId:'NEW-USDT-SWAP',instType:'SWAP',state:'live',settleCcy:'USDT',tickSz:'0.01'}];
 let providerBody:unknown={status:1,request:'id',receipt:'R'.repeat(30)};
 const fetch:Fetch=async(input,init)=>{const url=String(input);calls.push({url,body:new URLSearchParams(String(init?.body??''))});assert.equal(init?.redirect,'manual');
  if(url.includes('/public/instruments'))return Response.json({code:'0',data:catalog});
  if(url.includes('/market/tickers'))return Response.json({code:'0',data:ticks??[{instId:'BTC-USDT-SWAP',last:'100',ts:String(time)},{instId:'ETH-USDT-SWAP',last:'50',ts:String(time)}]});
  assert.equal(url,'https://api.pushover.net/1/messages.json');return Response.json(providerBody);
 };
 const now=()=>time;
 const engine=(options:Partial<SchedulerOptions>={})=>createScheduler({config,repositories:r,db,fetch,now,...options});
 const rule=(userId='u1',side:'upper'|'lower'='upper',threshold=100,instrument='BTC-USDT-SWAP')=>r.alerts.create(userId,{name:'Alert',instrument,side,threshold,enabled:true},time);
 return {db,r,config,calls,fetch,now,engine,rule,advance:(ms:number)=>{time+=ms;},setTicks:(value:typeof ticks)=>{ticks=value;},setCatalog:(value:typeof catalog)=>{catalog=value;},setProvider:(value:unknown)=>{providerBody=value;}};
}
test('shared bulk feed, inclusive upper/lower rules, encrypted receipt, latch and cross-user isolation',async()=>{
 const s=await fixture();const a=await s.rule(),b=await s.rule('u2','lower');const e=s.engine();
 try {await Promise.all([e.tick(),e.tick()]);assert.equal(s.calls.filter(c=>c.url.includes('tickers')).length,1);
  assert.equal((await s.r.scheduler.listDue(s.now(),20)).length,2);assert.equal(await s.r.alerts.getForUser('u2',a.id),null);
  await e.drain();const events=await s.r.outbox.listForUser('u1',20);assert.equal(events.items[0]!.phase,'sent');assert.ok(events.items[0]!.receipt);assert.equal(JSON.stringify(events.items[0]!.receipt).includes('R'.repeat(30)),false);
  assert.equal((await s.r.alerts.getForUser('u1',a.id))!.triggered,true);assert.equal((await s.r.alerts.getForUser('u2',b.id))!.triggered,true);
  s.advance(5000);await e.cycle();assert.equal(s.calls.filter(c=>c.url.includes('messages')).length,2);assert.equal((await s.r.settings.dailyUsage('u1',s.now())).attempts,1);
 }finally{await e.stop();await s.db.close();}
});
test('freshness rejects stale/future/unknown/invalid last and readonly status never fetches',async()=>{
 for(const tick of [{instId:'BTC-USDT-SWAP',last:'100',ts:String(initial-30001)},{instId:'BTC-USDT-SWAP',last:'100',ts:String(initial+5001)},{instId:'MISSING-USDT-SWAP',last:'100',ts:String(initial)},{instId:'BTC-USDT-SWAP',last:'NaN',ts:String(initial)}]){
  const s=await fixture();await s.rule();s.setTicks([tick]);const e=s.engine();try{await e.cycle();assert.equal((await s.r.scheduler.listDue(s.now(),20)).length,0);assert.equal(e.getStatus().health.prices.state,'unhealthy');const count=s.calls.length;e.getPrices();e.getStatus();e.getMarkets();assert.equal(s.calls.length,count);}finally{await e.stop();await s.db.close();}
 }
});
test('catalog exposes real availability, recognized chart mapping only and hourly refresh',async()=>{
 const s=await fixture();const e=s.engine();try{assert.equal(e.getStatus().health.prices.state,'unhealthy');await e.tick();const c=e.getMarkets();assert.equal(c.stale,false);assert.equal(c.markets.find(m=>m.base==='BTC')!.tradingViewSymbol,'OKX:BTCUSDT.P');assert.equal(c.markets.find(m=>m.base==='NEW')!.tradingViewSymbol,'');assert.equal(e.isInstrumentSupported('NEW-USDT-SWAP'),true);
  s.advance(5000);await e.tick();assert.equal(s.calls.filter(c=>c.url.includes('instruments')).length,1);
  s.advance(60*60*1000);s.setCatalog([]);await e.tick();assert.equal(e.getMarkets().stale,true);assert.equal(e.isInstrumentSupported('BTC-USDT-SWAP'),false);
 }finally{await e.stop();await s.db.close();}
});
test('cached rule/settings/channel generations block stale reservations; wake refreshes',async()=>{
 const s=await fixture();const a=await s.rule('u1','upper',200);const e=s.engine();try{await e.tick();await s.r.alerts.patch('u1',a.id,0,{threshold:100},s.now());s.advance(5000);await e.tick();assert.equal((await s.r.scheduler.listDue(s.now(),20)).length,0);e.invalidate();await e.tick();assert.equal((await s.r.scheduler.listDue(s.now(),20)).length,1);
 }finally{await e.stop();await s.db.close();}
 const t=await fixture();await t.rule('u1','upper',200);const other=t.engine();try{await other.tick();await t.r.settings.patch('u1',1,{enabled:false},t.now());t.setTicks([{instId:'BTC-USDT-SWAP',last:'300',ts:String(initial+5000)}]);t.advance(5000);await other.tick();assert.equal((await t.r.scheduler.listDue(t.now(),20)).length,0);}finally{await other.stop();await t.db.close();}
});
test('failed lease blocks contender; takeover recovers uncertain without resending',async()=>{
 const s=await fixture();await s.rule();const first=s.engine({ownerId:'owner1'}),second=s.engine({ownerId:'owner2'});
 try{await first.tick();const event=(await s.r.scheduler.listDue(s.now(),20))[0]!;const lease=(await s.db.query<{owner_id:string;fence:number;expires_at:number}>('SELECT * FROM scheduler_lease'))[0]!;
  const claimed=await s.r.scheduler.claimDelivery(event.triggerId,'interrupted',{id:'coordinator-v1',ownerId:lease.owner_id,fence:lease.fence,expiresAt:lease.expires_at},s.now());assert.ok(claimed);
  await second.cycle();assert.equal(second.getStatus().leaseFence,null);s.advance(40001);await second.cycle();assert.equal((await s.r.outbox.getForUser('u1',event.triggerId))!.phase,'uncertain');assert.equal(s.calls.filter(c=>c.url.includes('messages')).length,0);
  await first.tick();assert.equal(first.getStatus().leaseFence,null);
 }finally{await first.stop();await second.stop();await s.db.close();}
});
test('round-robin delivery is serialized and normal + test claims share real quotas',async()=>{
 const s=await fixture({DAILY_NOTIFICATION_LIMIT:2,GLOBAL_DAILY_NOTIFICATION_LIMIT:3});for(let i=0;i<3;i++)await s.rule();await s.rule('u2');const e=s.engine();try{await e.tick();await e.drain();const messages=s.calls.filter(c=>c.url.includes('messages'));assert.deepEqual(messages.slice(0,2).map(c=>c.body.get('user')),['U'.repeat(30),'V'.repeat(30)]);
  assert.equal((await s.r.settings.dailyUsage('u1',s.now())).attempts,2);const notifications=createNotificationService({config:s.config,repositories:s.r,fetch:s.fetch,now:s.now});assert.equal((await notifications.test('u2')).outcome,'daily_limit');assert.equal(s.calls.filter(c=>c.url.includes('messages')).length,3);
 }finally{await e.stop();await s.db.close();}
});
test('confirmed rejection retries 60/120 seconds while ambiguous responses stay latched',async()=>{
 const s=await fixture();const a=await s.rule();s.setProvider({status:0,errors:['redacted']});const e=s.engine();try{await e.cycle();const event=(await s.r.outbox.listForUser('u1',20)).items[0]!;assert.equal(event.phase,'queued');assert.equal(event.nextAt,s.now()+60000);
  s.advance(59999);await e.cycle();assert.equal(s.calls.filter(c=>c.url.includes('messages')).length,1);s.advance(1);await e.cycle();assert.equal((await s.r.outbox.getForUser('u1',event.triggerId))!.nextAt,s.now()+120000);
  s.advance(120000);s.setProvider({status:1,request:'missing-receipt'});await e.cycle();assert.equal((await s.r.outbox.getForUser('u1',event.triggerId))!.phase,'uncertain');s.advance(120000);await e.cycle();assert.equal(s.calls.filter(c=>c.url.includes('messages')).length,3);
 }finally{await e.stop();await s.db.close();}
});
test('ignored provider abort has bounded drain and locks further dispatch, prices keep polling',async()=>{
 const s=await fixture();await s.rule();await s.rule('u2');let sends=0;
 const e=s.engine({deliveryTimeoutMs:20,drainBudgetMs:1000,notifications:{deliver:()=>{sends++;return new Promise(()=>{});},health:()=>({state:'healthy',lastSuccessAt:initial,code:null})}});
 try{await e.tick();const started=performance.now();await e.drain();assert.ok(performance.now()-started<1000);assert.equal(sends,1);
  const all=[...(await s.r.outbox.listForUser('u1',20)).items,...(await s.r.outbox.listForUser('u2',20)).items];assert.equal(all.filter(x=>x.phase==='uncertain').length,1);
  s.advance(5000);await e.tick();await e.drain();assert.equal(sends,1);assert.equal(s.calls.filter(c=>c.url.includes('tickers')).length,2);
 }finally{await e.stop();await s.db.close();}
});
test('slow delivery never blocks tick; coalesced drain does not overlap and generation change cancels queued',async()=>{
 const s=await fixture();const a=await s.rule();let finish:(value:{outcome:'sent';code:null;receipt:null})=>void=()=>{};let sends=0;
 const e=s.engine({notifications:{deliver:()=>{sends++;return new Promise(resolve=>{finish=resolve;});},health:()=>({state:'healthy',lastSuccessAt:initial,code:null})}});
 try{await e.tick();const drain=e.drain();while(!sends)await new Promise(resolve=>setTimeout(resolve,0));assert.equal(e.drain(),drain);s.advance(5000);await e.tick();assert.equal(s.calls.filter(c=>c.url.includes('tickers')).length,2);finish({outcome:'sent',code:null,receipt:null});await drain;assert.equal(sends,1);
  await s.r.alerts.rearm('u1',a.id,0,s.now());e.invalidate();await e.tick();await s.r.settings.patch('u1',1,{enabled:false},s.now());await e.drain();assert.equal(sends,1);assert.equal((await s.r.outbox.lastForAlert('u1',a.id))!.phase,'cancelled');
 }finally{await e.stop();await s.db.close();}
});
test('30-second-old and 5-second-future exchange timestamps are inclusive boundary hits',async()=>{
 for(const timestamp of [initial-30000,initial+5000]){const s=await fixture();await s.rule();s.setTicks([{instId:'BTC-USDT-SWAP',last:'100',ts:String(timestamp)}]);const e=s.engine();try{await e.tick();assert.equal((await s.r.scheduler.listDue(s.now(),20)).length,1);}finally{await e.stop();await s.db.close();}}
});
test('joined profiles use one catalog query, no per-user reads, and stale channel generations stay fenced',async()=>{
 const s=await fixture();for(let i=0;i<5;i++)await s.rule('u1','upper',200);let settingsReads=0,channelReads=0,catalogReads=0;
 const query=s.db.query.bind(s.db);s.db.query=async(sql,params)=>{if(sql.includes("AS settings_generation")&&sql.includes("FROM alerts a"))catalogReads++;return query(sql,params);};
 const getSettings=s.r.settings.get,getChannel=s.r.channels.get;s.r.settings.get=async id=>{settingsReads++;return getSettings(id);};s.r.channels.get=async id=>{channelReads++;return getChannel(id);};
 const e=s.engine();try{await e.tick();assert.equal(settingsReads,0);assert.equal(channelReads,0);assert.equal(catalogReads,1);
  await s.r.channels.put('u1',0,await encryptSecret(key,'u1','userKey','N'.repeat(30)),null,s.now());s.setTicks([{instId:'BTC-USDT-SWAP',last:'300',ts:String(initial+5000)}]);s.advance(5000);await e.tick();assert.equal((await s.r.scheduler.listDue(s.now(),20)).length,0);assert.equal(settingsReads,0);assert.equal(catalogReads,1);
  e.invalidate();await e.tick();assert.equal((await s.r.scheduler.listDue(s.now(),20)).length,5);assert.equal(settingsReads,0);assert.equal(channelReads,0);assert.equal(catalogReads,2);
  s.advance(30000);await e.tick();assert.equal(catalogReads,3);assert.equal(settingsReads,0);assert.equal(channelReads,0);
 }finally{await e.stop();await s.db.close();}
});
test('normal test sends consume durable quota, remain priority zero and never auto-save',async()=>{
 const s=await fixture({DAILY_NOTIFICATION_LIMIT:1});const n=createNotificationService({config:s.config,repositories:s.r,fetch:s.fetch,now:s.now});
 try{assert.equal((await n.test('u1')).outcome,'sent');assert.equal((await s.r.settings.dailyUsage('u1',s.now())).attempts,1);const send=s.calls[0]!;assert.equal(send.body.get('priority'),'0');assert.equal(send.body.has('retry'),false);assert.equal((await n.test('u1')).outcome,'daily_limit');assert.equal(s.calls.length,1);}finally{await s.db.close();}
});
test('corrupt encrypted secrets fail without provider traffic and expired events never send',async()=>{
 const s=await fixture();const a=await s.rule();const e=s.engine();try{await e.tick();await s.db.execute("UPDATE channels SET user_key_json=? WHERE user_id='u1'",[JSON.stringify({version:1,algorithm:'A256GCM',iv:'bad',ciphertext:'bad'})]);await e.drain();assert.equal(s.calls.filter(c=>c.url.includes('messages')).length,0);assert.equal((await s.r.outbox.lastForAlert('u1',a.id))!.phase,'failed');assert.equal((await s.r.alerts.getForUser('u1',a.id))!.triggered,true);
  await s.r.channels.put('u2',0,await encryptSecret(key,'u2','userKey','V'.repeat(30)),null,s.now());const b=await s.rule('u2');e.invalidate();await e.tick();s.advance(600001);await e.drain();assert.equal((await s.r.outbox.lastForAlert('u2',b.id))!.phase,'expired');assert.equal((await s.r.settings.dailyUsage('u2',s.now())).attempts,0);
 }finally{await e.stop();await s.db.close();}
});
test('stale cached prices keep original timestamps and health degrades on missing active market',async()=>{
 const s=await fixture();await s.rule('u1','upper',100,'NEW-USDT-SWAP');const e=s.engine();try{await e.tick();assert.equal(e.getStatus().health.prices.state,'degraded');const original=e.getPrices()[0]!;s.advance(30001);const count=s.calls.length;assert.equal(e.getStatus().health.prices.state,'unhealthy');assert.deepEqual(e.getPrices()[0],original);assert.equal(s.calls.length,count);}finally{await e.stop();await s.db.close();}
});
test('one drain sends at most twenty and subsequent drains preserve user rotation',async()=>{
 const s=await fixture();for(const user of ['u1','u2'])for(let i=0;i<15;i++)await s.rule(user);const e=s.engine();try{await e.tick();await e.drain();const first=s.calls.filter(c=>c.url.includes('messages'));assert.equal(first.length,20);assert.equal(first.filter(c=>c.body.get('user')==='U'.repeat(30)).length,10);await e.drain();assert.equal(s.calls.filter(c=>c.url.includes('messages')).length,30);}finally{await e.stop();await s.db.close();}
});
test('takeover during HTTP cannot commit former owner success or resend live event',async()=>{
 const s=await fixture();const a=await s.rule();let sent=0,finish:(value:{outcome:'sent';code:null;receipt:null})=>void=()=>{};
 const first=s.engine({ownerId:'old',notifications:{deliver:()=>{sent++;return new Promise(resolve=>{finish=resolve;});},health:()=>({state:'healthy',lastSuccessAt:initial,code:null})}}),next=s.engine({ownerId:'new'});
 try{await first.tick();const work=first.drain();while(!sent)await new Promise(resolve=>setTimeout(resolve,0));s.advance(40001);await next.cycle();assert.equal((await s.r.outbox.lastForAlert('u1',a.id))!.phase,'uncertain');finish({outcome:'sent',code:null,receipt:null});await work;assert.equal((await s.r.outbox.lastForAlert('u1',a.id))!.phase,'uncertain');assert.equal(s.calls.filter(c=>c.url.includes('messages')).length,0);}finally{await first.stop();await next.stop();await s.db.close();}
});
const require=createRequire(import.meta.url);
let miniflare:{Miniflare:new(options:unknown)=>{getD1Database(name:string):Promise<unknown>;dispose():Promise<void>}}|null=null;
try{miniflare=require(require.resolve('miniflare',{paths:[require.resolve('wrangler')]}));}catch{}
test('actual local Wrangler D1 runs scheduler, encrypted secrets, quota, retry and takeover',{skip:!miniflare},async()=>{
 const mf=new miniflare!.Miniflare({workers:[{config:{name:'scheduler-test',compatibilityDate:'2026-10-11',manifest:{mainModule:'index.js',modulesRoot:'/',modules:{'index.js':{type:'esm',contents:'export default {fetch(){return new Response("fixture")}}'}}},env:{DB:{type:'d1',id:'scheduler-local-test'}}}}]});
 const s=await fixture({DEPLOYMENT:'cloudflare',DB_DRIVER:'d1'},new D1SqlDatabase(await mf.getD1Database('DB') as D1Database));const e=s.engine({ownerId:'d1-first'}),next=s.engine({ownerId:'d1-next'});
 try{const a=await s.rule();assert.equal(await e.hasWork(),true);await e.refreshCatalog();assert.equal(s.calls.filter(c=>c.url.includes('tickers')).length,0);s.setProvider({status:0});await e.cycle();let event=(await s.r.outbox.listForUser('u1',20)).items[0]!;assert.equal(event.phase,'queued');assert.equal(event.nextAt,s.now()+60000);s.advance(60000);s.setProvider({status:1,request:'id',receipt:'R'.repeat(30)});await e.cycle();event=(await s.r.outbox.lastForAlert('u1',a.id))!;assert.equal(event.phase,'sent');assert.ok(event.receipt);assert.equal((await s.r.settings.dailyUsage('u1',s.now())).attempts,2);assert.equal(await e.hasWork(),false);
  await s.rule('u2');e.invalidate();await e.tick();const due=(await s.r.scheduler.listDue(s.now(),20))[0]!;const l=(await s.db.query<{owner_id:string;fence:number;expires_at:number}>('SELECT * FROM scheduler_lease'))[0]!;assert.ok(await s.r.scheduler.claimDelivery(due.triggerId,'interrupted',{id:'coordinator-v1',ownerId:l.owner_id,fence:l.fence,expiresAt:l.expires_at},s.now()));s.advance(40001);await next.cycle();assert.equal((await s.r.outbox.getForUser('u2',due.triggerId))!.phase,'uncertain');
  const expired=await s.r.admin.createInvitation('d1-expired@example.com',s.now()+1,s.now());s.advance(2);const renewed=await s.r.admin.createInvitation('d1-expired@example.com',s.now()+1000,s.now());assert.equal(renewed.id,expired.id);assert.equal(renewed.expiresAt,s.now()+1000);
 }finally{await e.stop();await next.stop();await mf.dispose();}
});

const cloudflareEnv={DEPLOYMENT:'cloudflare',DB_DRIVER:'d1'};
test('catalog-only refresh coalesces without tickers, SQL hydration or acquiring a lease',async()=>{
 const s=await fixture(cloudflareEnv);const e=s.engine();
 try{await Promise.all([e.refreshCatalog(),e.refreshCatalog()]);assert.equal(e.getMarkets().stale,false);assert.equal(s.calls.length,1);assert.ok(s.calls[0]!.url.includes('/public/instruments'));assert.equal(e.getStatus().lastPollAt,null);assert.equal((await s.db.query('SELECT * FROM scheduler_lease')).length,0);await e.tick();assert.equal(s.calls.filter(c=>c.url.includes('tickers')).length,1);}
 finally{await e.stop();await s.db.close();}
});
test('hasWork uses one EXISTS query and notices SQL changes without hydrating profiles or fetching markets',async()=>{
 const s=await fixture({PUSHOVER_APP_TOKEN:undefined});const e=s.engine();let probes=0;
 const query=s.db.query.bind(s.db);s.db.query=async(sql,params)=>{if(sql.includes(' AS has_work')){assert.ok(sql.includes('EXISTS('));probes++;}return query(sql,params);};
 s.r.settings.get=async()=>{throw new Error('unexpected_settings_hydration');};s.r.channels.get=async()=>{throw new Error('unexpected_channel_hydration');};
 try{assert.equal(await e.hasWork(),false);const a=await s.rule();assert.equal(await e.hasWork(),false);await s.r.channels.put('u1',0,await encryptSecret(key,'u1','userKey','U'.repeat(30)),await encryptSecret(key,'u1','appToken',token),s.now());assert.equal(await e.hasWork(),true);await s.r.settings.patch('u1',1,{enabled:false},s.now());assert.equal(await e.hasWork(),false);assert.equal(probes,4);assert.equal(s.calls.length,0);void a;}
 finally{s.db.query=query;await e.stop();await s.db.close();}
});
test('Cloudflare explicit single-item budgets and page cursor reach later users',async()=>{
 const s=await fixture({...cloudflareEnv,MAX_ALERTS_PER_USER:100});
 for(let i=0;i<80;i++)await s.rule();await s.rule('u2');
 const seed=s.engine({maxReservationsPerTick:100,maxEvaluationsPerTick:100});
 try{await seed.tick();assert.equal((await s.r.scheduler.listDue(s.now(),100)).length,81);}finally{await seed.stop();}
 // Deterministic keyset: a late user sits beyond two full early-user pages.
 await s.db.execute("UPDATE outbox SET next_at=? WHERE user_id='u2'",[s.now()-1]);
 // Use trigger order via next_at so u1 occupies the first 80 positions.
 await s.db.execute("UPDATE outbox SET next_at=? WHERE user_id='u1'",[s.now()-2]);
 const pages:number[]=[],listDue=s.r.scheduler.listDue;s.r.scheduler.listDue=async(...args)=>{pages.push(args[1]);return listDue(...args);};
 const e=s.engine({maxClaimsPerDrain:1,maxDeliveriesPerDrain:1});
 try{for(let i=0;i<3;i++){const before=s.calls.filter(c=>c.url.includes('messages')).length;await e.drain();assert.equal(s.calls.filter(c=>c.url.includes('messages')).length,before+1);}
  assert.deepEqual(pages,[32,32,32]);assert.equal(s.calls.filter(c=>c.url.includes('messages')).at(-1)!.body.get('user'),'V'.repeat(30));
 }finally{await e.stop();await s.db.close();}
 const t=await fixture(cloudflareEnv);for(let i=0;i<3;i++)await t.rule();const bounded=t.engine({maxReservationsPerTick:1});let reservations=0;const reserve=t.r.alerts.reserveTrigger;t.r.alerts.reserveTrigger=async input=>{reservations++;return reserve(input);};
 try{await bounded.tick();assert.equal(reservations,1);await bounded.tick();assert.equal(reservations,2);assert.equal((await t.r.scheduler.listDue(t.now(),20)).length,2);}finally{await bounded.stop();await t.db.close();}
});
test('Cloudflare default batch reserves four, sends serially, continues later and never replays latched rules',async()=>{
 const s=await fixture(cloudflareEnv);for(let i=0;i<9;i++)await s.rule(i%2?'u1':'u2');
 let inflight=0,peak=0,sent=0;
 const real=createNotificationService({config:s.config,repositories:s.r,fetch:s.fetch,now:s.now});
 const e=s.engine({notifications:{health:real.health,deliver:async claim=>{inflight++;peak=Math.max(peak,inflight);try{await new Promise(resolve=>setTimeout(resolve,2));sent++;return await real.deliver(claim);}finally{inflight--;}}}});
 try{
  for(const total of [4,8,9]){await e.tick();const rows=await s.db.query('SELECT trigger_id FROM outbox');assert.equal(rows.length,total);await e.drain();assert.equal(sent,total);}
  assert.equal(peak,1);await e.cycle();assert.equal(sent,9);assert.equal(s.calls.filter(c=>c.url.includes('tickers')).length,1);
  const events=await s.db.query<{phase:string}>('SELECT phase FROM outbox');assert.ok(events.every(row=>row.phase==='sent'));
  const usages=await Promise.all(['u1','u2'].map(user=>s.r.settings.dailyUsage(user,s.now())));assert.equal(usages[0]!.attempts,4);assert.equal(usages[1]!.attempts,5);
 }finally{await e.stop();await s.db.close();}
});

test('Cloudflare small batch keeps the drain deadline and daily quota boundaries',async t=>{
 const s=await fixture(cloudflareEnv);for(let i=0;i<4;i++)await s.rule();let elapsed=0,sent=0;
 const real=createNotificationService({config:s.config,repositories:s.r,fetch:s.fetch,now:s.now});
 const e=s.engine({notifications:{health:real.health,deliver:async claim=>{sent++;const result=await real.deliver(claim);elapsed+=10000;return result;}}});
 try{
  await e.tick();const clock=t.mock.method(performance,'now',()=>elapsed);
  await e.drain();assert.equal(sent,2,'A 25-second budget leaves room for the next nine-second send');
  await e.drain();assert.equal(sent,4);clock.mock.restore();
 }finally{t.mock.restoreAll();await e.stop();await s.db.close();}
 const q=await fixture({...cloudflareEnv,DAILY_NOTIFICATION_LIMIT:1,GLOBAL_DAILY_NOTIFICATION_LIMIT:2});for(let i=0;i<4;i++)await q.rule(i%2?'u1':'u2');const limited=q.engine();
 try{await limited.cycle();assert.equal(q.calls.filter(c=>c.url.includes('messages')).length,2);for(const user of ['u1','u2'])assert.equal((await q.r.settings.dailyUsage(user,q.now())).attempts,1);}
 finally{await limited.stop();await q.db.close();}
});

test('Cloudflare small batch stops after ambiguous delivery and never resends it',async()=>{
 const s=await fixture(cloudflareEnv);await s.rule();await s.rule('u2');s.setProvider({status:1,request:'missing-receipt'});const e=s.engine();
 try{
  await e.cycle();assert.equal(s.calls.filter(c=>c.url.includes('messages')).length,1);
  const phases=await s.db.query<{phase:string}>('SELECT phase FROM outbox');assert.deepEqual(phases.map(row=>row.phase).sort(),['queued','uncertain']);
  s.setProvider({status:1,request:'id',receipt:'R'.repeat(30)});await e.drain();await e.drain();assert.equal(s.calls.filter(c=>c.url.includes('messages')).length,2);
  assert.deepEqual((await s.db.query<{phase:string}>('SELECT phase FROM outbox')).map(row=>row.phase).sort(),['sent','uncertain']);
 }finally{await e.stop();await s.db.close();}
});

test('100-rule Cloudflare evaluation cursor survives periodic refresh, invalidation and deletion of last scanned rule',async()=>{
 const s=await fixture({...cloudflareEnv,MAX_ALERTS_PER_USER:100});
 for(let i=0;i<200;i++){const a=await s.rule(i<100?'u1':'u2','upper',i===199?100:200);await s.db.execute('UPDATE alerts SET id=? WHERE id=?',[`rule-${String(i).padStart(3,'0')}`,a.id]);}
 const e=s.engine();let reservations=0;const reserve=s.r.alerts.reserveTrigger;s.r.alerts.reserveTrigger=async input=>{reservations++;return reserve(input);};
 try{await e.tick();assert.equal(reservations,0);await s.r.alerts.remove('u1','rule-099',0,s.now());e.invalidate();s.advance(30000);await e.tick();assert.equal(reservations,1);assert.equal((await s.r.alerts.getForUser('u2','rule-199'))!.triggered,true);}
 finally{await e.stop();await s.db.close();}
});
test('cached lease avoids repeated renewals but reservation and claim still reject a stolen SQL fence',async()=>{
 const s=await fixture();await s.rule();const e=s.engine();let renewals=0;const renew=s.r.scheduler.renewLease;s.r.scheduler.renewLease=async(...args)=>{renewals++;return renew(...args);};
 try{await e.cycle();assert.equal(renewals,0);s.advance(5000);await e.cycle();assert.equal(renewals,0);s.advance(15000);await e.tick();assert.equal(renewals,1);
  await s.rule('u2');e.invalidate();await s.db.execute("UPDATE scheduler_lease SET owner_id='stolen',fence=fence+1");await e.cycle();assert.equal((await s.r.scheduler.listDue(s.now(),20)).length,0);assert.equal(s.calls.filter(c=>c.url.includes('messages')).length,1);
 }finally{await e.stop();await s.db.close();}
});

test('Cloudflare claim budget bounds stale queued cleanup and SQL fence blocks cached queued delivery',async()=>{
 const s=await fixture(cloudflareEnv);await s.rule();await s.rule('u2');const e=s.engine({maxClaimsPerDrain:1,maxDeliveriesPerDrain:1});let claims=0;const claim=s.r.scheduler.claimDelivery;s.r.scheduler.claimDelivery=async(...args)=>{claims++;return claim(...args);};
 try{await e.tick();await e.tick();await s.db.execute("UPDATE user_settings SET generation=generation+1");await e.drain();assert.equal(claims,1);assert.equal(s.calls.filter(c=>c.url.includes('messages')).length,0);await e.drain();assert.equal(claims,2);}
 finally{await e.stop();await s.db.close();}
 const t=await fixture(cloudflareEnv);await t.rule();const engine=t.engine();
 try{await engine.tick();await t.db.execute("UPDATE scheduler_lease SET owner_id='stolen',fence=fence+1");await engine.drain();assert.equal(t.calls.filter(c=>c.url.includes('messages')).length,0);assert.equal((await t.r.scheduler.listDue(t.now(),20)).length,1);assert.equal((await t.r.settings.dailyUsage('u1',t.now())).attempts,0);}
 finally{await engine.stop();await t.db.close();}
});


test('uncommitted finish retires the fence and same-process recovery never resends accepted delivery',async()=>{
 for(const failure of ['false','throw'] as const){
  const s=await fixture();await s.rule();const e=s.engine();const finish=s.r.scheduler.finishDelivery;
  s.r.scheduler.finishDelivery=async()=>{if(failure==='throw')throw new Error('synthetic finish storage failure');return false;};
  try{
   await e.cycle();assert.equal(s.calls.filter(c=>c.url.includes('messages')).length,1);
   assert.equal((await s.r.outbox.listForUser('u1',20)).items[0]!.phase,'sending');
   assert.equal(e.getStatus().leaseFence,null);
   s.r.scheduler.finishDelivery=finish;await e.cycle();
   const event=(await s.r.outbox.listForUser('u1',20)).items[0]!;
   assert.equal(event.phase,'uncertain');assert.equal(event.code,'interrupted');
   assert.equal((await s.r.settings.dailyUsage('u1',s.now())).attempts,1);
   assert.equal(s.calls.filter(c=>c.url.includes('messages')).length,1);
   assert.equal(await e.hasWork(),false);
  }finally{await e.stop();await s.db.close();}
 }
});

test('standalone test claim repairs only its owner stale sending even without scheduler activity',async()=>{
 const s=await fixture();
 try{
  const first=await s.r.tests.claim('u1',0,1,s.now()),other=await s.r.tests.claim('u2',0,1,s.now());assert.ok(first);assert.ok(other);
  s.advance(13000);assert.equal(await s.r.tests.claim('u1',0,1,s.now()),null);
  s.advance(1);const next=await s.r.tests.claim('u1',0,1,s.now());assert.ok(next);
  const rows=await s.db.query<{id:string;phase:string;code:string}>('SELECT id,phase,code FROM test_notifications');
  assert.equal(rows.find(v=>v.id===first.id)!.phase,'uncertain');assert.equal(rows.find(v=>v.id===first.id)!.code,'interrupted');
  assert.equal(rows.find(v=>v.id===other.id)!.phase,'sending');
  assert.equal((await s.r.settings.dailyUsage('u1',s.now())).attempts,2);
  assert.equal((await s.r.settings.dailyUsage('u2',s.now())).attempts,1);
  assert.equal(await s.r.tests.finish('u1',first.id,first.claimId,'sent',null,s.now()),false);
 }finally{await s.db.close();}
});
