import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSQLite } from '../src/db/sqlite.js';
import { migrateApp } from '../src/db/migrations.js';
import { createRepositories } from '../src/db/repositories.js';
import { postgresSql } from '../src/db/sql.js';
import { loadConfig } from '../src/config.js';
import { RepositoryConflict } from '../src/contracts/db.js';
import type { SchedulerLease } from '../src/contracts/db.js';
const now=1700000000000;
const env={NODE_ENV:'test',APP_URL:'http://localhost:3000',AUTH_SECRET:'a'.repeat(32),ENCRYPTION_KEY:'ab'.repeat(32),EMAIL_PROVIDER:'console',SQLITE_PATH:':memory:'};
const secret={version:1,algorithm:'A256GCM',iv:'aXY=',ciphertext:'Y2lwaGVydGV4dA=='} as const;
async function setup(extra:Record<string,unknown>={}) {
  const db=await createSQLite(':memory:',true);
  await db.execute('CREATE TABLE "user" (id TEXT PRIMARY KEY,email TEXT NOT NULL,name TEXT NOT NULL,role TEXT NOT NULL DEFAULT \'user\')');
  await db.execute('CREATE TABLE "session" (id TEXT PRIMARY KEY,user_id TEXT REFERENCES "user"(id))');
  await migrateApp(db,now); const config=loadConfig({...env,...extra}),r=createRepositories(db,config);
  for(const id of ['u1','u2']) { await db.execute('INSERT INTO "user"(id,email,name) VALUES(?,?,?)',[id,`${id}@example.com`,id]); await r.settings.initialize(id,now); await r.channels.put(id,null,secret,null,now); await r.settings.patch(id,0,{enabled:true},now); }
  const l=(await r.scheduler.acquireLease('owner',now,15000))!;
  return {db,r,l};
}
async function reserve(s:Awaited<ReturnType<typeof setup>>,userId='u1',name='A',triggerId=crypto.randomUUID()) {
 const a=await s.r.alerts.create(userId,{name,instrument:'BTC-USDT-SWAP',side:'upper',threshold:100,enabled:true},now);
 assert.equal(await s.r.alerts.reserveTrigger({triggerId,alertId:a.id,userId,generation:0,settingsGeneration:1,channelGeneration:0,tick:{instrument:a.instrument,price:100,timestamp:now,receivedAt:now},now,lease:s.l}),true);
 return {a,triggerId};
}
test('SQLite ordered bound transaction, zero counts, rollback and CAS rollback',async()=>{
 const {db}=await setup();
 const c=await db.atomic([{sql:"INSERT INTO app_meta(key,value) VALUES(?,?)",params:['bound',"a'; DROP TABLE alerts;--"]},{sql:'UPDATE app_meta SET value=? WHERE key=?',params:['changed','absent']}]); assert.deepEqual(c,[1,0]);
 await assert.rejects(db.atomic([{sql:"UPDATE app_meta SET value='rollback' WHERE key='bound'"},{sql:'INSERT INTO missing_table VALUES(1)'}]));
 assert.equal((await db.query<{value:string}>("SELECT value FROM app_meta WHERE key='bound'"))[0]!.value,"a'; DROP TABLE alerts;--");
 assert.equal(await db.atomicCAS([{sql:"UPDATE app_meta SET value='bad' WHERE key='bound'",expectedChanges:1},{sql:"UPDATE app_meta SET value='bad' WHERE key='absent'",expectedChanges:1}]),false);
 assert.notEqual((await db.query<{value:string}>("SELECT value FROM app_meta WHERE key='bound'"))[0]!.value,'bad');
 assert.equal((await db.query<{foreign_keys:number}>('PRAGMA foreign_keys'))[0]!.foreign_keys,1); await db.close();
});
test('PG lexer protects quoted literals identifiers comments escape strings and dollar bodies',()=>{
 assert.equal(postgresSql("SELECT ?, '?', \"?\", E'a\\\'?b', $$?$$, $tag$?$tag$ /* ? /* ? */ ? */ -- ?\n, ?"),"SELECT $1, '?', \"?\", E'a\\\'?b', $$?$$, $tag$?$tag$ /* ? /* ? */ ? */ -- ?\n, $2");
 assert.throws(()=>postgresSql("SELECT 'unterminated"));
});
test('migrations are idempotent and reject changed checksums without applying',async()=>{ const {db}=await setup(); await migrateApp(db,now+1); await assert.rejects(migrateApp(db,now,[{version:'0001_app',sql:'SELECT 1;'}]),/checksum/); assert.equal((await db.query('SELECT * FROM schema_migrations')).length,2); await db.close(); });
test('trigger CAS inclusive threshold, stale guards, tenant isolation and immutable snapshot',async()=>{
 const s=await setup(); const {a,triggerId}=await reserve(s); const record=(await s.r.outbox.getForUser('u1',triggerId))!; assert.equal(record.price,100); assert.equal(record.name,'A');
 assert.equal(await s.r.alerts.getForUser('u2',a.id),null); assert.equal(await s.r.outbox.getForUser('u2',triggerId),null);
 await assert.rejects(s.r.alerts.patch('u1',a.id,0,{name:'Changed'},now), (e)=>e instanceof RepositoryConflict&&e.code==='pending_delivery');
 assert.equal(await s.r.alerts.reserveTrigger({triggerId:crypto.randomUUID(),alertId:a.id,userId:'u1',generation:0,settingsGeneration:1,channelGeneration:0,tick:{instrument:a.instrument,price:100,timestamp:now,receivedAt:now},now,lease:s.l}),false);
 const b=await s.r.alerts.create('u1',{name:'lower',instrument:a.instrument,side:'lower',threshold:100,enabled:true},now);
 assert.equal(await s.r.alerts.reserveTrigger({triggerId:crypto.randomUUID(),alertId:b.id,userId:'u1',generation:0,settingsGeneration:1,channelGeneration:0,tick:{instrument:a.instrument,price:100,timestamp:now-30001,receivedAt:now},now,lease:s.l}),false); await s.db.close();
});
test('concurrent claims consume quota once, finish is fenced, result remains latched until rearm',async()=>{
 const s=await setup(); const {a,triggerId}=await reserve(s); const claims=await Promise.all([s.r.scheduler.claimDelivery(triggerId,'c1',s.l,now),s.r.scheduler.claimDelivery(triggerId,'c2',s.l,now)]); assert.equal(claims.filter(Boolean).length,1); const c=claims.find(Boolean)!;
 assert.equal((await s.r.settings.dailyUsage('u1',now)).attempts,1); assert.equal(await s.r.scheduler.finishDelivery(triggerId,c.claimId!,{...s.l,fence:999},'sent',null,null,now+1),false);
 assert.equal(await s.r.scheduler.finishDelivery(triggerId,c.claimId!,s.l,'sent',null,null,now+1),true); const latched=(await s.r.alerts.getForUser('u1',a.id))!; assert.equal(latched.triggered,true); assert.equal(latched.pendingTriggerId,null);
 const edited=await s.r.alerts.patch('u1',a.id,0,{name:'edited'},now+2); assert.equal(edited.triggered,true); assert.equal(edited.generation,1);
 const armed=await s.r.alerts.rearm('u1',a.id,1,now+3); assert.equal(armed.triggered,false); assert.equal(armed.triggerId,null); assert.equal(armed.generation,2); await s.db.close();
});
test('user quota and global budget stop sends with no overclaim',async()=>{
 const s=await setup({DAILY_NOTIFICATION_LIMIT:1,GLOBAL_DAILY_NOTIFICATION_LIMIT:1}); const x=await reserve(s,'u1'); const y=await reserve(s,'u2');
 assert.ok(await s.r.scheduler.claimDelivery(x.triggerId,'c1',s.l,now)); assert.equal(await s.r.scheduler.claimDelivery(y.triggerId,'c2',s.l,now),null);
 assert.equal((await s.r.settings.dailyUsage('u2',now)).attempts,0); assert.equal((await s.r.outbox.getForUser('u2',y.triggerId))!.phase,'daily_limit'); assert.equal((await s.db.query<{attempts:number}>('SELECT attempts FROM global_daily_usage'))[0]!.attempts,1); await s.db.close();
});
test('takeover recovery marks interrupted sending uncertain without retry',async()=>{
 const s=await setup(); const {a,triggerId}=await reserve(s); assert.ok(await s.r.scheduler.claimDelivery(triggerId,'c1',s.l,now)); const next=(await s.r.scheduler.acquireLease('new',now+15001,15000))!;
 assert.equal(next.fence,2); assert.equal(await s.r.scheduler.recoverInterrupted(next,now+15002),1); assert.equal((await s.r.outbox.getForUser('u1',triggerId))!.phase,'uncertain'); assert.equal((await s.r.alerts.getForUser('u1',a.id))!.triggered,true); assert.equal(await s.r.scheduler.claimDelivery(triggerId,'c2',next,now+15003),null); await s.db.close();
});
test('disable cancels queued atomically, conflicts on credentials, generations survive deletion',async()=>{
 const s=await setup(); const {a,triggerId}=await reserve(s); await assert.rejects(s.r.channels.remove('u1',0,now),/pending_delivery/); await assert.rejects(s.r.settings.patch('u1',1,{dailyLimit:2},now),/pending_delivery/);
 await s.r.settings.patch('u1',1,{enabled:false},now+1); assert.equal((await s.r.outbox.getForUser('u1',triggerId))!.phase,'cancelled'); assert.equal((await s.r.alerts.getForUser('u1',a.id))!.pendingTriggerId,null);
 await s.r.channels.remove('u1',0,now+2); const recreated=await s.r.channels.put('u1',null,secret,null,now+3); assert.ok(recreated.generation>0); await s.db.close();
});
test('test sends allocate IDs, quota includes tests, pending blocks replacement, owner guards',async()=>{
 const s=await setup(); const t=await s.r.tests.claim('u1',0,1,now); assert.ok(t); assert.equal((await s.r.settings.dailyUsage('u1',now)).attempts,1); assert.equal(await s.r.tests.claim('u1',0,1,now),null);
 await assert.rejects(s.r.channels.put('u1',0,secret,null,now),/pending_delivery/); assert.equal(await s.r.tests.finish('u2',t.id,t.claimId,'sent',null,now+1),false); assert.equal(await s.r.tests.finish('u1',t.id,t.claimId,'sent',null,now+1),true); await s.db.close();
});
test('CRUD capacity CAS, bootstrap one-use, invitation ownership and missing auth users',async()=>{
 const s=await setup({MAX_ALERTS_PER_USER:1}); await s.r.alerts.create('u1',{name:'one',instrument:'BTC-USDT-SWAP',side:'upper',threshold:1,enabled:true},now); await assert.rejects(s.r.alerts.create('u1',{name:'two',instrument:'BTC-USDT-SWAP',side:'upper',threshold:1,enabled:true},now),/limit_exceeded/);
 await assert.rejects(s.r.settings.initialize('missing',now),/not_found/); assert.equal(await s.r.admin.bootstrap('missing',now),false); assert.equal(await s.r.admin.bootstrap('u1',now),true); assert.equal(await s.r.admin.bootstrap('u2',now),false);
 const inv=await s.r.admin.createInvitation(' New@Example.com ',now+10000,now); await s.db.execute('INSERT INTO "user"(id,email,name) VALUES(?,?,?)',['new','new@example.com','new']); assert.equal(await s.r.admin.consumeInvitation(inv.id,'u2',now),false); assert.equal(await s.r.admin.consumeInvitation(inv.id,'new',now),true); assert.equal(await s.r.admin.consumeInvitation(inv.id,'new',now),false); await s.db.close();
});
test('confirmed rejection retries at 60/120 seconds and terminates after three attempts',async()=>{
 const s=await setup(); const {triggerId}=await reserve(s);
 assert.equal((await s.r.scheduler.claimDelivery(triggerId,'first',s.l,now))!.attempts,1);
 assert.equal(await s.r.scheduler.finishDelivery(triggerId,'first',s.l,'queued','provider_rejected',null,now+1),true);
 assert.equal((await s.r.outbox.getForUser('u1',triggerId))!.nextAt,now+60001);
 const secondLease=(await s.r.scheduler.acquireLease('retry-owner',now+59000,15000))!;
 assert.equal(await s.r.scheduler.claimDelivery(triggerId,'too-early',secondLease,now+60000),null);
 assert.equal((await s.r.scheduler.claimDelivery(triggerId,'second',secondLease,now+60001))!.attempts,2);
 assert.equal(await s.r.scheduler.finishDelivery(triggerId,'second',secondLease,'queued','provider_rejected',null,now+60002),true);
 assert.equal((await s.r.outbox.getForUser('u1',triggerId))!.nextAt,now+180002);
 const thirdLease=(await s.r.scheduler.acquireLease('third-owner',now+179000,15000))!;
 assert.equal(await s.r.scheduler.claimDelivery(triggerId,'too-early-third',thirdLease,now+180001),null);
 assert.equal((await s.r.scheduler.claimDelivery(triggerId,'third',thirdLease,now+180002))!.attempts,3);
 assert.equal(await s.r.scheduler.finishDelivery(triggerId,'third',thirdLease,'queued','provider_rejected',null,now+180003),true);
 assert.equal((await s.r.outbox.getForUser('u1',triggerId))!.phase,'failed');
 assert.equal((await s.r.settings.dailyUsage('u1',now)).attempts,3); await s.db.close();
});
test('global active and distinct instrument limits are guarded during edits as well as creates',async()=>{
 const s=await setup({MAX_ACTIVE_ALERTS:1,MAX_INSTRUMENTS_PER_USER:1,MAX_GLOBAL_INSTRUMENTS:1});
 const a=await s.r.alerts.create('u1',{name:'active',instrument:'BTC-USDT-SWAP',side:'upper',threshold:1,enabled:true},now);
 const b=await s.r.alerts.create('u2',{name:'off',instrument:'BTC-USDT-SWAP',side:'lower',threshold:1,enabled:false},now);
 await assert.rejects(s.r.alerts.patch('u2',b.id,0,{enabled:true},now),/limit_exceeded/); await assert.rejects(s.r.alerts.patch('u2',b.id,0,{instrument:'ETH-USDT-SWAP'},now),/limit_exceeded/);
 await s.r.alerts.patch('u1',a.id,0,{enabled:false},now); assert.equal((await s.r.alerts.patch('u2',b.id,0,{enabled:true},now)).generation,1);
 await s.r.alerts.remove('u2',b.id,1,now); assert.equal(await s.r.alerts.getForUser('u2',b.id),null); await s.db.close();
});
test('disabled users lose sessions and queued events, in-flight events recover uncertain',async()=>{
 const s=await setup(); const x=await reserve(s); await s.db.execute('INSERT INTO "session"(id,user_id) VALUES(?,?)',['session','u1']); await s.r.admin.setDisabled('u1',true,now+1); assert.equal((await s.db.query('SELECT * FROM "session"')).length,0); assert.equal((await s.r.outbox.getForUser('u1',x.triggerId))!.phase,'cancelled');
 const y=await reserve(s,'u2'); assert.ok(await s.r.scheduler.claimDelivery(y.triggerId,'inflight',s.l,now+2)); await s.r.admin.setDisabled('u2',true,now+3); assert.equal(await s.r.scheduler.recoverInterrupted(s.l,now+4),1); assert.equal((await s.r.outbox.getForUser('u2',y.triggerId))!.phase,'uncertain'); await s.db.close();
});
test('active keyset pagination and owner result lookup preserve last result after rearm',async()=>{
 const s=await setup(); const x=await reserve(s); await s.r.scheduler.claimDelivery(x.triggerId,'claim',s.l,now); await s.r.scheduler.finishDelivery(x.triggerId,'claim',s.l,'sent',null,null,now+1); await s.r.alerts.rearm('u1',x.a.id,0,now+2);
 assert.equal((await s.r.outbox.lastForAlert('u1',x.a.id))!.phase,'sent'); assert.equal(await s.r.outbox.lastForAlert('u2',x.a.id),null);
 await s.r.alerts.create('u1',{name:'second',instrument:'ETH-USDT-SWAP',side:'upper',threshold:1,enabled:true},now);
 const p1=await s.r.alerts.listActive(1),p2=await s.r.alerts.listActive(1,p1.cursor!); assert.equal(p1.items.length,1); assert.equal(p2.items.length,1); assert.notEqual(p1.items[0]!.id,p2.items[0]!.id); assert.equal(p2.cursor,null); await s.db.close();
});
test('builtin SQLite Drizzle shares physical DB and maps selected values correctly',async()=>{
 const {createAuthDrizzle}=await import('../src/db/drizzle.node.js'); const {sqliteTable,text}=await import('drizzle-orm/sqlite-core'); const {eq}=await import('drizzle-orm'); const s=await setup();
 const users=sqliteTable('user',{id:text('id').primaryKey(),email:text('email'),name:text('name'),role:text('role')}); const drizzle=await createAuthDrizzle(s.db,{users});
 const records=await drizzle.select().from(users).where(eq(users.id,'u1')); assert.equal(records[0]!.id,'u1'); assert.equal(records[0]!.email,'u1@example.com');
 await drizzle.update(users).set({name:'via-auth'}).where(eq(users.id,'u1')); assert.equal((await s.db.query<{name:string}>('SELECT name FROM "user" WHERE id=?',['u1']))[0]!.name,'via-auth'); await s.db.close();
});
test('file SQLite enables WAL and busy timeout; two connections share quota and reject stale mutations',async()=>{
 const {mkdtemp,rm}=await import('node:fs/promises'); const {tmpdir}=await import('node:os'); const {join}=await import('node:path'); const directory=await mkdtemp(join(tmpdir(),'open-alert-db-'));
 const db1=await createSQLite(join(directory,'nested','test.sqlite'),true),db2=await createSQLite(join(directory,'nested','test.sqlite'),true);
 try {
  await db1.execute('CREATE TABLE "user"(id TEXT PRIMARY KEY,email TEXT NOT NULL,name TEXT NOT NULL,role TEXT NOT NULL DEFAULT \'user\')'); await migrateApp(db1,now); await db1.execute('INSERT INTO "user"(id,email,name) VALUES(?,?,?)',['u','u@example.com','user']);
  assert.equal((await db1.query<{journal_mode:string}>('PRAGMA journal_mode'))[0]!.journal_mode,'wal'); assert.equal((await db2.query<{timeout:number}>('PRAGMA busy_timeout'))[0]!.timeout,5000);
  const config=loadConfig({...env,DAILY_NOTIFICATION_LIMIT:1}),r1=createRepositories(db1,config),r2=createRepositories(db2,config); await r1.settings.initialize('u',now); await r1.channels.put('u',null,secret,null,now);
  const claims=await Promise.all([r1.tests.claim('u',0,0,now),r2.tests.claim('u',0,0,now)]); assert.equal(claims.filter(Boolean).length,1); assert.equal((await r2.settings.dailyUsage('u',now)).attempts,1);
 } finally { await db1.close(); await db2.close(); await rm(directory,{recursive:true,force:true}); }
});
test('preferred native SQLite implements bound ordered atomic rollback',async()=>{
 const db=await createSQLite(':memory:');
 try { await db.execute('CREATE TABLE native_test(id TEXT PRIMARY KEY,value TEXT)'); assert.deepEqual(await db.atomic([{sql:'INSERT INTO native_test VALUES(?,?)',params:['native','bound']},{sql:'UPDATE native_test SET value=? WHERE id=?',params:['zero','absent']}]),[1,0]); await assert.rejects(db.atomic([{sql:'UPDATE native_test SET value=? WHERE id=?',params:['bad','native']},{sql:'INSERT INTO native_test VALUES(?,?)',params:['native','duplicate']}])); assert.equal((await db.query<{value:string}>('SELECT value FROM native_test WHERE id=?',['native']))[0]!.value,'bound'); }
 finally { await db.close(); }
});
test('queued finish without confirmed rejection becomes uncertain instead of retrying',async()=>{
 const s=await setup();const {triggerId}=await reserve(s);assert.ok(await s.r.scheduler.claimDelivery(triggerId,'unclear',s.l,now));
 assert.equal(await s.r.scheduler.finishDelivery(triggerId,'unclear',s.l,'queued','provider_transport_uncertain',null,now+1),true);
 assert.equal((await s.r.outbox.getForUser('u1',triggerId))!.phase,'uncertain');assert.equal(await s.r.scheduler.claimDelivery(triggerId,'retry',s.l,now+2),null);await s.db.close();
});

test('joined active profile pages carry only revisions and token availability',async()=>{
 const s=await setup();try{
  const a=await s.r.alerts.create('u1',{name:'private',instrument:'BTC-USDT-SWAP',side:'upper',threshold:100,enabled:true},now);
  await s.r.channels.put('u1',0,secret,secret,now);
  await s.r.alerts.create('u2',{name:'shared',instrument:'ETH-USDT-SWAP',side:'upper',threshold:100,enabled:true},now);
  const p1=await s.r.alerts.listActiveWithProfiles(1),p2=await s.r.alerts.listActiveWithProfiles(1,p1.cursor!);
  assert.equal(p1.items[0]!.id,a.id);assert.equal(p1.items[0]!.settingsGeneration,1);assert.equal(p1.items[0]!.channelGeneration,1);assert.equal(p1.items[0]!.hasPrivateAppToken,true);assert.equal('userKey' in p1.items[0]!,false);assert.equal(p2.items[0]!.hasPrivateAppToken,false);assert.equal(p2.cursor,null);
 }finally{await s.db.close();}
});
test('SQL work detection filters schedulable rules and includes queued or sending outbox regardless of token',async()=>{
 const s=await setup();try{
  assert.equal(await s.r.scheduler.hasWork(true),false);
  const a=await s.r.alerts.create('u1',{name:'work',instrument:'BTC-USDT-SWAP',side:'upper',threshold:100,enabled:true},now);
  assert.equal(await s.r.scheduler.hasWork(false),false);assert.equal(await s.r.scheduler.hasWork(true),true);
  await s.r.channels.put('u1',0,secret,secret,now);assert.equal(await s.r.scheduler.hasWork(false),true);
  await s.r.admin.setDisabled('u1',true,now);assert.equal(await s.r.scheduler.hasWork(true),false);
  const x=await reserve(s,'u2');assert.equal(await s.r.scheduler.hasWork(false),true);await s.r.scheduler.claimDelivery(x.triggerId,'work-claim',s.l,now);assert.equal(await s.r.scheduler.hasWork(false),true);await s.r.scheduler.finishDelivery(x.triggerId,'work-claim',s.l,'sent',null,null,now);assert.equal(await s.r.scheduler.hasWork(true),false);
  void a;
 }finally{await s.db.close();}
});
test('expired invitation renewals CAS against concurrent renewal/consume and recheck admission guards',async()=>{
 for(const race of ['renew','consume','existing-user','capacity'] as const){
  const s=await setup({MAX_USERS:race==='capacity'?3:4});const invitation=await s.r.admin.createInvitation('race@example.com',now+1,now);
  const atomicCAS=s.db.atomicCAS.bind(s.db);let raced=false;
  s.db.atomicCAS=async statements=>{
   if(!raced&&statements.some(v=>v.sql.startsWith('UPDATE invitations SET expires_at='))){
    raced=true;
    if(race==='renew')await s.db.execute('UPDATE invitations SET expires_at=? WHERE id=?',[now+50000,invitation.id]);
    if(race==='consume')await s.db.execute('UPDATE invitations SET consumed_by=?,consumed_at=? WHERE id=?',['u1',now+2,invitation.id]);
    if(race==='existing-user'||race==='capacity')await s.db.execute('INSERT INTO "user"(id,email,name) VALUES(?,?,?)',['racer',race==='existing-user'?'RACE@example.com':'other@example.com','racer']);
   }
   return atomicCAS(statements);
  };
  try{await assert.rejects(s.r.admin.createInvitation('race@example.com',now+100000,now+2),e=>e instanceof RepositoryConflict&&e.code==='generation_conflict');assert.equal(raced,true);const row=(await s.db.query<{expires_at:number;consumed_by:string|null}>('SELECT * FROM invitations WHERE id=?',[invitation.id]))[0]!;assert.equal(row.expires_at,race==='renew'?now+50000:now+1);assert.equal(row.consumed_by,race==='consume'?'u1':null);}
  finally{await s.db.close();}
 }
 const s=await setup();try{const inv=await s.r.admin.createInvitation('expired@example.com',now+1,now);const renewed=await s.r.admin.createInvitation('expired@example.com',now+1000,now+2);assert.equal(renewed.id,inv.id);assert.equal(renewed.expiresAt,now+1000);}finally{await s.db.close();}
});

test('repeated active invitations are idempotent, preserve expiry and recheck consume/capacity guards',async()=>{
 const s=await setup();try{
  const first=await s.r.admin.createInvitation(' repeat@example.com ',now+10000,now);assert.equal(first.reused,false);
  const repeated=await Promise.all([s.r.admin.createInvitation('REPEAT@example.com',now+999999,now+1),s.r.admin.createInvitation('repeat@example.com',now+999999,now+1)]);
  for(const result of repeated){assert.equal(result.id,first.id);assert.equal(result.expiresAt,first.expiresAt);assert.equal(result.reused,true);}
  assert.equal((await s.db.query('SELECT id FROM invitations WHERE email=?',['repeat@example.com'])).length,1);
  const cas=s.db.atomicCAS.bind(s.db);s.db.atomicCAS=async statements=>{
   if(statements.some(v=>v.sql.startsWith('UPDATE invitations SET expires_at=expires_at')))await s.db.execute('UPDATE invitations SET consumed_by=?,consumed_at=? WHERE id=?',['u1',now+2,first.id]);
   return cas(statements);
  };
  await assert.rejects(s.r.admin.createInvitation('repeat@example.com',now+10000,now+2),e=>e instanceof RepositoryConflict&&e.code==='generation_conflict');
 }finally{await s.db.close();}
});
