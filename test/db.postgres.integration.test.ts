import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import type { Pool } from 'pg';
import { PostgresDatabase } from '../src/db/postgres.js';
import { migrateApp } from '../src/db/migrations.js';
import { createRepositories } from '../src/db/repositories.js';
import { loadConfig } from '../src/config.js';
const require=createRequire(import.meta.url);
let Engine:(new()=>{query(sql:string,params?:unknown[]):Promise<{rows:object[];affectedRows?:number}>;close():Promise<void>})|null=null;
try { Engine=require('@electric-sql/pglite').PGlite; } catch {}
test('PostgreSQL migrations and repository claim SQL against embedded PostgreSQL',{skip:!Engine},async()=>{
 const engine=new Engine!();
 const client={async query(input:string|{text:string;values?:unknown[]}) { const text=typeof input==='string'?input:input.text; const values=typeof input==='string'?[]:input.values; const r=await engine.query(text,values); return {rows:r.rows,rowCount:r.affectedRows??0}; },release(){}};
 const db=new PostgresDatabase({query:client.query.bind(client),async connect(){return client},async end(){await engine.close()}} as unknown as Pool);
 try {
  await db.execute('CREATE TABLE "user"(id TEXT PRIMARY KEY,email TEXT NOT NULL,name TEXT NOT NULL,role TEXT NOT NULL DEFAULT \'user\')');
  await db.execute('CREATE TABLE "session"(id TEXT PRIMARY KEY,user_id TEXT REFERENCES "user"(id))'); await migrateApp(db);
  const now=1700000000000,config=loadConfig({NODE_ENV:'test',DB_DRIVER:'postgres',DATABASE_URL:'postgres://localhost/test',APP_URL:'http://localhost:3000',AUTH_SECRET:'a'.repeat(32),ENCRYPTION_KEY:'ab'.repeat(32),EMAIL_PROVIDER:'console'}),r=createRepositories(db,config);
  await db.execute('INSERT INTO "user"(id,email,name) VALUES(?,?,?)',['u','u@example.com','user']); await r.settings.initialize('u',now); await r.settings.patch('u',0,{enabled:true},now);
  await r.channels.put('u',null,{version:1,algorithm:'A256GCM',iv:'aXY=',ciphertext:'Y2lwaGVydGV4dA=='},null,now);
  const a=await r.alerts.create('u',{name:'PG',instrument:'BTC-USDT-SWAP',side:'upper',threshold:100,enabled:true},now),l=(await r.scheduler.acquireLease('owner',now,15000))!,triggerId=crypto.randomUUID();
  assert.equal(await r.alerts.reserveTrigger({triggerId,alertId:a.id,userId:'u',generation:0,settingsGeneration:1,channelGeneration:0,tick:{instrument:a.instrument,price:100,timestamp:now,receivedAt:now},now,lease:l}),true);
  const claim=await r.scheduler.claimDelivery(triggerId,'pg-claim',l,now); assert.ok(claim); assert.equal(await r.scheduler.claimDelivery(triggerId,'pg-miss',l,now),null); assert.equal((await r.settings.dailyUsage('u',now)).attempts,1);
  assert.equal(await r.scheduler.finishDelivery(triggerId,'pg-claim',l,'sent',null,null,now+1),true); assert.equal((await r.alerts.rearm('u',a.id,0,now+2)).triggered,false);
  assert.equal(await r.admin.bootstrap('u',now),true); await r.admin.setDisabled('u',true,now); assert.equal((await r.settings.get('u'))!.disabled,true);
 } finally { await db.close(); }
});
