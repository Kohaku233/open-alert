import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { D1SqlDatabase } from '../src/db/d1.js';
import { createRepositories } from '../src/db/repositories.js';
import { loadConfig } from '../src/config.js';
import { migrateApp } from '../src/db/migrations.js';
import type { D1Database } from '@cloudflare/workers-types';
import { readQueueTelemetry } from '../src/runtime/observability.js';
const require=createRequire(import.meta.url);
let miniflare: {Miniflare:new (options:unknown)=>{getD1Database(name:string):Promise<unknown>;dispose():Promise<void>}}|null=null;
try { miniflare=require(require.resolve('miniflare',{paths:[require.resolve('wrangler')]})); } catch {}
test('actual local Wrangler D1 ordered batch and CHECK CAS rollback', {skip:!miniflare},async()=>{
 const mf=new miniflare!.Miniflare({workers:[{config:{name:'db-test',compatibilityDate:'2026-10-11',manifest:{mainModule:'index.js',modulesRoot:'/',modules:{'index.js':{type:'esm',contents:'export default { fetch() { return new Response("ok"); } }'}}},env:{DB:{type:'d1',id:'open-alert-local-test'}}}}]});
 try {
   const db=new D1SqlDatabase(await mf.getD1Database('DB') as D1Database);
   await db.execute("CREATE TABLE \"user\"(id TEXT PRIMARY KEY,email TEXT NOT NULL,name TEXT NOT NULL,role TEXT NOT NULL DEFAULT 'user')"); await migrateApp(db);
   assert.deepEqual(await db.atomic([{sql:"INSERT INTO app_meta(key,value) VALUES('test','original')"},{sql:"UPDATE app_meta SET value='x' WHERE key='missing'"}]),[1,0]);
   assert.equal(await db.atomicCAS([{sql:"UPDATE app_meta SET value='wrong' WHERE key='test'",expectedChanges:1},{sql:"UPDATE app_meta SET value='wrong' WHERE key='missing'",expectedChanges:1}]),false);
   assert.equal((await db.query<{value:string}>("SELECT value FROM app_meta WHERE key='test'"))[0]!.value,'original');
   assert.equal(await db.atomicCAS([{sql:"UPDATE app_meta SET value='committed' WHERE key='test'",expectedChanges:1},{sql:"UPDATE app_meta SET value='ignored' WHERE key='missing'"}]),true);
   assert.equal((await db.query<{value:string}>("SELECT value FROM app_meta WHERE key='test'"))[0]!.value,'committed');
   await assert.rejects(db.atomic([{sql:"UPDATE app_meta SET value='rolled-back' WHERE key='test'"},{sql:'INSERT INTO absent_table VALUES(1)'}]));
   assert.equal((await db.query<{value:string}>("SELECT value FROM app_meta WHERE key='test'"))[0]!.value,'committed');
   const now=Date.now(), config=loadConfig({NODE_ENV:'test',DEPLOYMENT:'cloudflare',DB_DRIVER:'d1',APP_URL:'http://localhost:3000',AUTH_SECRET:'a'.repeat(32),ENCRYPTION_KEY:'ab'.repeat(32),EMAIL_PROVIDER:'console'}),r=createRepositories(db,config);
   await db.execute('INSERT INTO "user"(id,email,name) VALUES(?,?,?)',['u','u@example.com','User']);
   await r.settings.initialize('u',now); await r.settings.patch('u',0,{enabled:true},now);
   await r.channels.put('u',null,{version:1,algorithm:'A256GCM',iv:'aXY=',ciphertext:'Y2lwaGVydGV4dA=='},null,now);
   const a=await r.alerts.create('u',{name:'D1',instrument:'BTC-USDT-SWAP',side:'upper',threshold:100,enabled:true},now),l=(await r.scheduler.acquireLease('d1-owner',now,15000))!,triggerId=crypto.randomUUID();
   assert.equal(await r.alerts.reserveTrigger({triggerId,alertId:a.id,userId:'u',generation:0,settingsGeneration:1,channelGeneration:0,tick:{instrument:a.instrument,price:100,timestamp:now,receivedAt:now},now,lease:l}),true);
   assert.ok(await r.scheduler.claimDelivery(triggerId,'claim',l,now));
   assert.equal(await r.scheduler.claimDelivery(triggerId,'miss',l,now),null);
   assert.equal((await r.settings.dailyUsage('u',now)).attempts,1);
   assert.equal(await r.scheduler.finishDelivery(triggerId,'claim',l,'sent',null,null,now+1),true);
   assert.equal((await r.alerts.getForUser('u',a.id))!.pendingTriggerId,null);
   // Completed history must not make every five-second idle probe scan the outbox.
   await db.execute(`WITH RECURSIVE x(n) AS(VALUES(1) UNION ALL SELECT n+1 FROM x WHERE n<20000)
     INSERT INTO outbox(trigger_id,alert_id,user_id,generation,settings_generation,channel_generation,instrument,name,side,threshold,price,timestamp,notification_json,phase,next_at,created_at,updated_at)
     SELECT 'history-'||n,?,'u',n,1,0,'BTC-USDT-SWAP','history','upper',100,100,?,'{}','sent',?,?,? FROM x`,[a.id,now,now,now,now]);
   let inspected=false;const query=db.query.bind(db);
   db.query=async<T extends object>(sql:string,params?:readonly import('../src/contracts/db.js').SqlValue[]):Promise<T[]>=>{
     if(sql.includes(' AS has_work')){const result=await db.rawConnection.prepare(sql).bind(...(params??[])).all<T>();assert.ok(result.meta.rows_read<20,`Idle probe read ${result.meta.rows_read} history rows`);inspected=true;return result.results;}
     if(sql.includes('GROUP BY phase')){const result=await db.rawConnection.prepare(sql).bind(...(params??[])).all<T>();assert.ok(result.meta.rows_read<20,`Monitor scanned ${result.meta.rows_read} completed history rows`);return result.results;}
     return query<T>(sql,params);
   };
   assert.equal(await r.scheduler.hasWork(true),false);assert.equal(inspected,true);
   assert.deepEqual(await readQueueTelemetry(db,now),{queued:0,due:0,sending:0,oldestDueAt:null,oldestSendingAt:null});
   const metrics=db.telemetry();assert.ok(metrics.operations>0);assert.ok(metrics.rowsRead>0);assert.ok(metrics.rowsWritten>0);assert.ok(metrics.conflicts>=1);assert.ok(metrics.errors>=1);assert.ok(metrics.durationMs>=0);metrics.errors=99999;assert.notEqual(db.telemetry().errors,99999);
 } finally { await mf.dispose(); }
});
