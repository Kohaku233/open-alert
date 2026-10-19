import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serveAssets } from '../src/runtime/node.js';
import { trustedRequest,unavailableApi,setupHtml } from '../src/runtime/common.js';
import { loadConfig } from '../src/config.js';
import { createScheduler } from '../src/scheduler/index.js';
import type { Repositories } from '../src/contracts/db.js';
import type { ComponentHealth } from '../src/contracts/domain.js';

test('shared idle snapshot proves DB readiness without polling, and retains actual errors and active health',async()=>{
 const config=loadConfig({NODE_ENV:'test',APP_URL:'http://localhost:3000',AUTH_SECRET:'runtime-fixture-secret-at-least-thirty-two-characters',ENCRYPTION_KEY:'12'.repeat(32),EMAIL_PROVIDER:'console'});
 let work=false,dbFailed=false,requests=0;
 let provider:ComponentHealth={state:'starting',lastSuccessAt:null,code:null};
 const repositories={scheduler:{hasWork:async()=>{if(dbFailed)throw new Error('private DB failure');return work;}}} as unknown as Repositories;
 const engine=createScheduler({config,repositories,fetch:async()=>{requests++;throw new Error('No idle request expected');},notifications:{deliver:async()=>{assert.fail('No idle notification expected');},health:()=>provider}});
 assert.equal(engine.getStatus().health.database.state,'starting');
 assert.equal(engine.getStatus().health.overall,'unhealthy');
 const idle=await engine.snapshot();assert.equal(idle.health.overall,'degraded');assert.equal(idle.health.database.state,'healthy');
 assert.deepEqual(idle.health.prices,{state:'degraded',lastSuccessAt:null,code:'idle_no_active_alerts'});
 assert.equal(idle.health.scheduler.code,'idle_no_active_alerts');assert.equal(idle.health.notifications.code,'provider_not_checked');
 assert.equal(idle.lastPollAt,null);assert.deepEqual(idle.prices,[]);assert.equal(requests,0);
 provider={state:'degraded',lastSuccessAt:null,code:'provider_rejected'};
 assert.equal((await engine.snapshot()).health.notifications.code,'provider_rejected');
 provider={state:'unhealthy',lastSuccessAt:null,code:'provider_unavailable'};
 assert.equal((await engine.snapshot()).health.overall,'unhealthy');
 provider={state:'healthy',lastSuccessAt:Date.now(),code:null};work=true;
 const active=await engine.snapshot();assert.equal(active.health.overall,'unhealthy');assert.equal(active.health.prices.state,'unhealthy');assert.equal(active.health.scheduler.state,'unhealthy');
 work=false;dbFailed=true;await assert.rejects(engine.snapshot(),/database_unavailable/);assert.equal(engine.getStatus().health.database.state,'unhealthy');
 dbFailed=false;assert.equal((await engine.snapshot()).health.database.state,'unhealthy','Cheap idle read cannot clear an actual DB error');
 await engine.stop();assert.equal((await engine.snapshot()).health.scheduler.state,'unhealthy');assert.equal(requests,0);
});

test('idle snapshot cannot hide a real price provider failure or race a rule invalidation',async()=>{
 const config=loadConfig({NODE_ENV:'test',APP_URL:'http://localhost:3000',AUTH_SECRET:'runtime-fixture-secret-at-least-thirty-two-characters',ENCRYPTION_KEY:'12'.repeat(32),EMAIL_PROVIDER:'console'});
 let release:(work:boolean)=>void=()=>{};let held=false;
 const repositories={scheduler:{hasWork:async()=>held?new Promise<boolean>(r=>{release=r;}):false,acquireLease:async()=>({ownerId:'test',fence:1,expiresAt:Date.now()+40000}),recoverInterrupted:async()=>{},releaseLease:async()=>{}},tests:{recoverInterrupted:async()=>{}},alerts:{listActiveWithProfiles:async()=>({items:[],cursor:null})}} as unknown as Repositories;
 const engine=createScheduler({config,repositories,fetch:async()=>{throw new Error('price provider unavailable');},notifications:{deliver:async()=>{assert.fail('No notification expected');},health:()=>({state:'starting',lastSuccessAt:null,code:null})}});
 await engine.tick();const failed=await engine.snapshot();assert.equal(failed.health.prices.code,'prices_unavailable');assert.equal(failed.health.prices.state,'unhealthy');assert.equal(failed.health.overall,'unhealthy');
 await engine.stop();
 const fresh=createScheduler({config,repositories});held=true;
 const pending=fresh.snapshot();await Promise.resolve();fresh.invalidate();release(false);
 assert.equal((await pending).health.prices.state,'unhealthy','Stale no-work read cannot mark a newly invalidated snapshot idle');await fresh.stop();
});
test('runtime overwrites internal IP and never trusts forwarded browser metadata',()=>{
 const request=new Request('http://localhost:3000/api/status',{headers:{'x-open-alert-client-ip':'forged','x-forwarded-for':'fake'}});
 assert.equal(trustedRequest(request,'192.0.2.1').headers.get('x-open-alert-client-ip'),'192.0.2.1');assert.equal(trustedRequest(request,null).headers.has('x-open-alert-client-ip'),false);
});
test('unconfigured deployment returns retryable capability errors instead of fabricated disabled methods',async()=>{
 assert.throws(()=>loadConfig({}));const response=unavailableApi('/api/auth-capabilities');assert.equal(response.status,503);assert.equal(response.headers.get('Retry-After'),'5');const body=await response.json() as any;assert.equal(body.ok,false);assert.equal(body.error.code,'service_unavailable');assert.equal(body.data,undefined);assert.equal((await unavailableApi('/api/health').json() as any).data.state,'unhealthy');assert.equal(unavailableApi('/api/status').status,503);assert.match(setupHtml,/Sign-in unavailable/);
});
test('same-origin static HTTP serves built SPA fallback, strict missing assets and HEAD',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'open-alert-static-'));try{
  await writeFile(join(dir,'index.html'),'<html>App</html>');await writeFile(join(dir,'app.js'),'console.log("fixture")');
  const request=(path:string,method='GET')=>new Request('http://localhost:3000'+path,{method});
  assert.equal(await (await serveAssets(request('/dashboard'),dir)).text(),'<html>App</html>');assert.match((await serveAssets(request('/app.js'),dir)).headers.get('content-type')!,/javascript/);assert.equal((await serveAssets(request('/missing.js'),dir)).status,404);assert.equal(await (await serveAssets(request('/app.js','HEAD'),dir)).text(),'');assert.equal((await serveAssets(request('/app.js','POST'),dir)).status,405);assert.equal((await serveAssets(request('/%00'),dir)).status,404);
 }finally{await rm(dir,{recursive:true,force:true});}
});


test('DO alarm deletion racing with a wake cannot erase the newly persisted recovery alarm',async()=>{
 const {Coordinator}=await import('../src/runtime/cloudflare.js');
 const object=Object.create(Coordinator.prototype) as any;
 let alarm:number|null=Date.now()+5000,releaseDelete:()=>void=()=>{},enteredDelete:()=>void=()=>{};
 const deleting=new Promise<void>(r=>{enteredDelete=r;}),holdDelete=new Promise<void>(r=>{releaseDelete=r;});
 const tasks:Promise<void>[]=[];
 object.revision=0;object.active=false;object.running=Promise.resolve();object.alarmWrites=Promise.resolve();
 object.initialized=Promise.resolve({hasWork:async()=>false,invalidate:()=>{}});
 object.state={storage:{getAlarm:async()=>alarm,setAlarm:async(v:number)=>{alarm=v;},deleteAlarm:async()=>{enteredDelete();await holdDelete;alarm=null;}},waitUntil:(p:Promise<void>)=>tasks.push(p)};
 const idle=object.reconcile();await deleting;
 const wake=object.fetch(new Request('https://coordinator.internal/wake',{method:'POST'}));
 await Promise.resolve();releaseDelete();await idle;
 assert.equal((await wake).status,202);await Promise.all(tasks);
 assert.ok(alarm!==null&&alarm>Date.now());assert.equal(object.active,true);
});
