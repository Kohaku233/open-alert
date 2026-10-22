import test from 'node:test';
import assert from 'node:assert/strict';
import { createObservability, diagnose, readQueueTelemetry } from '../src/runtime/observability.js';
import type { ObservabilityOptions, MonitorStorage } from '../src/runtime/observability.js';
import { schedulerMetrics, observeLatency } from '../src/runtime/metrics.js';
import type { SqlDatabase } from '../src/contracts/db.js';
import type { ComponentHealth, SystemStatus } from '../src/contracts/domain.js';
const initial=1_700_000_000_000;
const good:ComponentHealth={state:'healthy',lastSuccessAt:initial,code:null};
function fixture(storage?:MonitorStorage){
 let time=initial,reads=0,fail=false,hasWork:boolean|null=false;
 const health:SystemStatus['health']={overall:'degraded',database:{...good},scheduler:{...good,state:'degraded',code:'idle_no_active_alerts'},prices:{...good,state:'degraded',code:'idle_no_active_alerts'},notifications:{state:'degraded',code:'provider_not_checked',lastSuccessAt:null},email:{state:'starting',code:null,lastSuccessAt:null}};
 const logs:object[]=[],metrics=schedulerMetrics();
 const db={query:async()=>{reads++;if(fail)throw Error('private query params secret');return [];}} as unknown as SqlDatabase;
 const engine={getStatus:()=>({health,lastPollAt:null}),observability:()=>({runId:'test-run',startedAt:initial-60_000,hasWork,metrics,sources:[]})} as unknown as ObservabilityOptions['engine'];
 const monitor=createObservability({db,engine,cronRequired:true,...(storage?{storage}:{}),now:()=>time,log:value=>logs.push(value)});
 const pulse=(ok=true)=>monitor.pulse({at:time,api:{...good},email:ok?{...good}:{state:'unhealthy',code:'email_unavailable',lastSuccessAt:null}},true);
 return {monitor,health,db,logs,pulse,metrics,reads:()=>reads,advance:(ms:number)=>{time+=ms;},setFail:(value:boolean)=>{fail=value;},setWork:(value:boolean|null)=>{hasWork=value;}};
}
test('expected idle and an untested provider are explained without fake failures or fake health',async()=>{
 const f=fixture();await f.pulse();const report=await f.monitor.capture();assert.equal(report.state,'idle');assert.equal(report.expectedIdle,true);assert.equal(report.events.length,0);assert.ok(!report.issues.some(i=>i.code==='provider_not_checked'));assert.equal(f.health.overall,'degraded');assert.equal(report.notifications,'disabled');
 f.setWork(true);f.health.scheduler={...good};f.health.prices={...good};await f.monitor.pulse();assert.equal((await f.monitor.capture()).state,'ok');
});
test('incident opening is deduplicated and healthy recovery is persisted across monitor instances',async()=>{
 let saved:Parameters<MonitorStorage['put']>[0]|undefined,writes=0;
 const store:MonitorStorage={get:async()=>saved,put:async value=>{saved=structuredClone(value);writes++;}};
 const f=fixture(store);await f.pulse(false);const failed=await f.monitor.capture();assert.equal(failed.state,'critical');assert.equal(failed.events.length,1);assert.equal(writes,1);
 f.advance(60_000);await f.pulse(false);await f.monitor.capture();assert.equal(f.logs.filter((v:any)=>v.event==='open_alert_incident').length,1);
 const next=fixture(store);next.advance(60_000);await next.pulse();const recovered=await next.monitor.capture();assert.equal(recovered.state,'idle');assert.equal(recovered.events.length,1);assert.ok(recovered.events[0]!.resolvedAt);assert.equal(saved!.events[0]!.resolvedAt,recovered.events[0]!.resolvedAt);
});
test('an expired probe never converts a known email failure into a recovery',async()=>{
 const f=fixture();await f.pulse(false);await f.monitor.capture();f.advance(181_000);const unknown=await f.monitor.capture();assert.equal(unknown.state,'critical');assert.equal(unknown.events.find(e=>e.component==='email')!.resolvedAt,null);assert.ok(unknown.issues.some(i=>i.code==='cron_overdue'));
 await f.pulse();const recovered=await f.monitor.capture();assert.equal(recovered.state,'idle');assert.ok(recovered.events.every(e=>e.resolvedAt!==null));
});
test('concurrent monitor reads share one bounded queue query and do not alter business state',async()=>{
 const f=fixture();await f.pulse();const reports=await Promise.all(Array.from({length:20},()=>f.monitor.capture()));assert.equal(f.reads(),1);reports[0]!.metrics.sent=999;assert.equal((await f.monitor.capture()).metrics.sent,0);assert.equal(f.logs.length,1);
 f.advance(15_000);await f.monitor.capture();assert.equal(f.reads(),2);
});
test('queue read failure remains unknown and does not expose private SQL errors',async()=>{
 const f=fixture();await f.pulse();f.setFail(true);const report=await f.monitor.capture();assert.equal(report.queue,null);assert.equal(report.state,'critical');assert.ok(report.issues.some(i=>i.code==='queue_probe_failed'));assert.ok(!JSON.stringify(f.logs).includes('secret'));
 f.setFail(false);f.advance(60_000);await f.pulse();const recovered=await f.monitor.capture();assert.equal(recovered.state,'idle');assert.ok(recovered.events.find(e=>e.code==='queue_probe_failed')!.resolvedAt);
});
test('missing Cron, slow due queues and overdue sending claims are actionable',()=>{
 const f=fixture();const input={now:initial,startedAt:initial-300_000,health:f.health,hasWork:true,queue:{queued:2,due:1,sending:1,oldestDueAt:initial-61_000,oldestSendingAt:initial-61_000},cronRequired:true,lastCronAt:initial-181_000,probe:{at:initial,api:good,email:good}};
 const diagnosis=diagnose(input);assert.equal(diagnosis.state,'critical');for(const code of ['queue_delayed','delivery_stuck','cron_overdue'])assert.ok(diagnosis.issues.some(i=>i.code===code));
});
test('monitor storage failure is visible and cannot stop business work or leak exception details',async()=>{
 const f=fixture({get:async()=>{throw Error('secret storage');},put:async()=>{throw Error('secret storage');}});await f.pulse();const report=await f.monitor.capture();assert.equal(report.state,'critical');assert.ok(report.issues.some(i=>i.code==='monitor_storage_unavailable'));assert.ok(!JSON.stringify(f.logs).includes('secret'));
});
test('history and incident storage stay bounded while clock advances',async()=>{
 let saved:Parameters<MonitorStorage['put']>[0]|undefined;
 const f=fixture({get:async()=>saved,put:async value=>{saved=value;}});
 for(let i=0;i<130;i++){await f.pulse(i%2===0);await f.monitor.capture();f.advance(60_000);}
 assert.ok(saved!.events.length<=50);assert.ok(saved!.history.length<=60);assert.ok(JSON.stringify(saved).length<64_000);
});
test('latency buckets account for every sample without retaining individual messages',()=>{
 const metric=schedulerMetrics().deliveryMs;for(const value of [0,10,11,100,10001,40000,-1])observeLatency(metric,value);observeLatency(metric,NaN);assert.equal(metric.count,7);assert.equal(metric.buckets.reduce((a,b)=>a+b),7);assert.equal(metric.buckets.at(-1),1);assert.equal(metric.boundsMs.length+1,metric.buckets.length);
});
test('queue telemetry distinguishes due retries from future retries and sending claims',async()=>{
 const db={query:async(sql:string,params:unknown[])=>{assert.ok(sql.includes("WHERE phase IN('queued','sending')"));assert.deepEqual(params,[initial,initial]);return [{phase:'queued',count:3,due:1,oldest_due:initial-5000,oldest_sending:null},{phase:'sending',count:1,due:0,oldest_due:null,oldest_sending:initial-2000}];}} as unknown as SqlDatabase;
 assert.deepEqual(await readQueueTelemetry(db,initial),{queued:3,due:1,sending:1,oldestDueAt:initial-5000,oldestSendingAt:initial-2000});
});
