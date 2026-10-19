import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { Coordinator } from '../src/runtime/cloudflare.js';
import type { CloudflareBindings } from '../src/contracts/db.js';

test('single-hop quote lookup keeps stale, unsupported and provider errors distinct without touching alarms',async()=>{
 let refreshes=0,reads=0,stale=false,available=true,fail=false;
 const instrument='BTC-USDT-SWAP',quote={instrument,price:123,observedAt:1700000000000,timestamp:null};
 const engine={async refreshCatalog(){refreshes++;},getMarkets(){return {markets:[{instrument,base:'BTC',quote:'USDT',state:'live',available}],updatedAt:1700000000000,stale};}};
 const coordinator=Object.assign(Object.create(Coordinator.prototype),{initialized:Promise.resolve(engine),quotes:{async get(){reads++;if(fail)throw new Error('upstream secret');return quote;}}}) as Coordinator;
 const lookup=async(value=instrument)=>{const response=await coordinator.fetch(new Request('https://coordinator.internal/quote-lookup?instrument='+value));assert.equal(response.status,200);return response.json();};
 assert.deepEqual(await lookup(),{quote});assert.equal(reads,1);assert.equal(refreshes,1);
 assert.deepEqual(await lookup('FAKE-USDT-SWAP'),{quote:null,code:'invalid_request'});
 available=false;assert.deepEqual(await lookup(),{quote:null,code:'invalid_request'});
 stale=true;assert.deepEqual(await lookup(),{quote:null,code:'service_unavailable'});
 assert.deepEqual(await lookup('FAKE-USDT-SWAP'),{quote:null,code:'service_unavailable'});
 available=true;stale=false;fail=true;assert.deepEqual(await lookup(),{quote:null,code:'service_unavailable'});assert.equal(reads,2);
});

test('scheduled recovery retries the internal reconcile without depending on HTTP auth startup', async () => {
  let calls=0;
  const jobs:Promise<unknown>[]=[];
  const env={NODE_ENV:'test',APP_URL:'https://alert.example.com',AUTH_SECRET:'a'.repeat(32),ENCRYPTION_KEY:'ab'.repeat(32),EMAIL_PROVIDER:'console',DB:{},COORDINATOR:{
    idFromName(name:string){assert.equal(name,'coordinator-v1');return name;},
    get(){return {async fetch(url:string,init:RequestInit){calls++;assert.equal(url,'https://coordinator.internal/reconcile');assert.equal(init.method,'POST');if(calls<3)throw new Error('transient');return new Response(null,{status:202});}};},
  }} as unknown as CloudflareBindings;
  await worker.scheduled({} as never,env,{waitUntil(job:Promise<unknown>){jobs.push(job);}} as never);
  await Promise.all(jobs);assert.equal(calls,3);
});

test('coordinator coalesces status probes, invalidates on reconcile and never caches idle work',async()=>{
  let work=true,fail=false,checks=0,alarms=0,alarm:number|null=null;
  let release:()=>void=()=>{};
  const held=new Promise<void>(resolve=>{release=resolve;});
  const engine={async hasWork(){checks++;await held;if(fail)throw new Error('database unavailable');return work;},invalidate(){},getStatus(){return {health:{},lastPollAt:null};},getPrices(){return [];}};
  // Isolate the coordinator state machine; production construction is covered by workerd tests.
  const coordinator=Object.assign(Object.create(Coordinator.prototype),{
    initialized:Promise.resolve(engine),revision:0,active:false,running:null,workCheck:null,checkedWork:null,alarmWrites:Promise.resolve(),
    state:{storage:{async getAlarm(){return alarm;},async setAlarm(at:number){alarm=at;alarms++;},async deleteAlarm(){alarm=null;}}},
  }) as Coordinator;
  const snapshot=()=>coordinator.fetch(new Request('https://coordinator.internal/snapshot'));
  const reads=Array.from({length:20},snapshot);await Promise.resolve();release();
  assert.ok((await Promise.all(reads)).every(response=>response.status===200));
  assert.equal(checks,1);assert.equal(alarms,1);assert.ok(alarm);
  await snapshot();assert.equal(checks,1,'Positive checks are reused for at most one second');
  work=false;
  assert.equal((await coordinator.fetch(new Request('https://coordinator.internal/reconcile',{method:'POST'}))).status,202);
  assert.equal(checks,2);assert.equal(alarm,null);
  work=true;
  await snapshot();assert.equal(checks,3,'Cached idle result cannot hide newly committed work');assert.ok(alarm);
  fail=true;
  await assert.rejects(coordinator.fetch(new Request('https://coordinator.internal/reconcile',{method:'POST'})),/database unavailable/);
  fail=false;
  await snapshot();assert.equal(checks,5,'Rejected work probes are never cached');
});
