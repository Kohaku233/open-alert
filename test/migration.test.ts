import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, chmod, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createSQLite } from '../src/db/sqlite.js';
import { migrateApp } from '../src/db/migrations.js';
import { migrateAuth } from '../src/auth/migrations.js';
import { createRepositories } from '../src/db/repositories.js';
import { loadConfig } from '../src/config.js';
import { decryptSecret } from '../src/notifications/crypto.js';
import { buildLegacyImportStatements, HELD_UNTIL, importLegacyState, LEGACY_IDS, parseLegacySnapshot, planLegacyImport, releaseLegacyHold } from '../src/migration/legacy.js';
import { buildD1Artifact } from '../src/migration/d1-artifact.js';
import { readPrivateJson } from '../src/migration/private-file.node.js';
import type { SqlDatabase } from '../src/contracts/db.js';
const now=Date.UTC(2026,9,11,12), notification={priority:2,retry:30,expire:1500,sound:'siren'};
const owner={userId:'admin-one',email:'owner@example.test'}, options={sourceId:'legacy-worker-one',owner,now};
const key='ab'.repeat(32), userKey='U'.repeat(30), appToken='T'.repeat(30);
const config=loadConfig({NODE_ENV:'test',DEPLOYMENT:'node',DB_DRIVER:'sqlite',SQLITE_PATH:':memory:',APP_URL:'http://localhost:3000',AUTH_SECRET:'test-auth-secret-long-enough-12345678',ENCRYPTION_KEY:key,EMAIL_PROVIDER:'console',INVITE_ONLY:'false'});
function snapshot(version:1|2|3=3) { return {version,config:{enabled:true,upper:110,lower:null,dailyLimit:20,notification},running:true,
  alerts:[{id:'11111111-1111-4111-8111-111111111111',name:'ETH upper',instrument:'ETH-USDT-SWAP',side:'upper' as 'upper' | 'lower',threshold:110,enabled:true,generation:4,triggered:false,pending:null as Record<string,unknown>|null,last:null as Record<string,unknown>|null}],
  legacyLocks:{} as Record<string,unknown>,daily:{date:'2026-10-11',attempts:11},previousPrice:100,reconnect:{failures:2,nextAt:now},errors:[]}; }
function queued(g=4) { return {id:'queued-event',generation:g,instrument:'ETH-USDT-SWAP',name:'ETH upper',side:'upper',threshold:110,price:120,timestamp:now,createdAt:now-20000,notification,phase:'queued',attempts:2,nextAt:now+60000}; }
async function setup(path=':memory:') {
  const db=await createSQLite(path,true); await migrateAuth(db,'tables',now); await migrateApp(db,now);
  await db.execute('INSERT INTO "user"(id,email,name,email_verified,role,updated_at) VALUES(?,?,?,?,?,?)',[owner.userId,owner.email,'Owner',1,'admin',now]);
  await migrateAuth(db,'guards',now); return db;
}
async function tableState(db:SqlDatabase) { const result:Record<string,unknown>={}; for(const table of ['app_meta','user_settings','alerts','outbox','channels','channel_versions','daily_usage','global_daily_usage']) result[table]=await db.query(`SELECT * FROM ${table}`); return result; }
test('dry-run validates schema/admin and makes no mutations or secret callback calls',async()=>{
 const db=await setup(); try { const before=await tableState(db); let calls=0; const result=await importLegacyState(db,snapshot(),{...options,dryRun:true,channelSecrets:async()=>{calls++;throw new Error('must not read secrets');}}); assert.equal(result.status,'dry_run');assert.equal(calls,0);assert.deepEqual(await tableState(db),before); } finally {await db.close();}
});
test('v3 actual SQLite import retains IDs/latches/retries, encrypted separate channels, held queue and source metadata',async()=>{
 const db=await setup(); try {
  const state=snapshot();state.alerts[0]!.pending=queued();state.alerts[0]!.last={id:'previous-event',outcome:'sent',at:now-30000,attempts:1,code:null,receipt:null};
  state.legacyLocks.lower={generation:9,latched:true,pending:null,last:{id:'thresholdless-event',outcome:'sent',attempts:1}};
  const result=await importLegacyState(db,{monitor_state:JSON.stringify(state)},{...options,encryptionKey:key,channelSecrets:async()=>({userKey,appToken})});
  assert.equal(result.status,'imported');const r=createRepositories(db,config),alert=(await r.alerts.listForUser(owner.userId))[0]!;
  assert.equal(alert.id,state.alerts[0]!.id);assert.equal(alert.generation,4);assert.equal(alert.triggered,true);assert.equal(alert.pendingTriggerId,'queued-event');
  const event=(await r.outbox.getForUser(owner.userId,'queued-event'))!;assert.equal(event.price,120);assert.equal(event.attempts,2);assert.equal(event.nextAt,HELD_UNTIL);assert.equal(event.phase,'queued');assert.deepEqual(await r.scheduler.listDue(now+86400000,20),[]);
  assert.equal((await r.settings.get(owner.userId))!.enabled,false);assert.equal((await r.settings.dailyUsage(owner.userId,now)).attempts,11);
  const channel=(await r.channels.get(owner.userId))!;assert.equal(await decryptSecret(key,owner.userId,'userKey',channel.userKey),userKey);assert.equal(await decryptSecret(key,owner.userId,'appToken',channel.privateAppToken!),appToken);
  const meta=JSON.parse(result.plan.metadata);assert.equal(meta.sourceRunning,true);assert.equal(meta.sourceConfig.enabled,true);assert.equal(meta.previousPrice,100);assert.equal(meta.legacyLocks.lower.triggered,true);assert.deepEqual(meta.alertMapping[0].last,state.alerts[0]!.last);assert.equal(result.plan.summary.historyMetadata,1);
  const dump=JSON.stringify(await tableState(db));assert.ok(!dump.includes(userKey));assert.ok(!dump.includes(appToken));
 }finally{await db.close();}
});
test('sending imports as terminal uncertain, remains latched, and cannot auto-resend',async()=>{
 const db=await setup();try{const state=snapshot();state.alerts[0]!.pending={...queued(),phase:'sending',attempts:1};await importLegacyState(db,state,options);const r=createRepositories(db,config);assert.equal((await r.outbox.getForUser(owner.userId,'queued-event'))!.phase,'uncertain');const alert=(await r.alerts.listForUser(owner.userId))[0]!;assert.equal(alert.triggered,true);assert.equal(alert.pendingTriggerId,null);const lease=(await r.scheduler.acquireLease('test',now,15000))!;assert.equal(await r.scheduler.claimDelivery('queued-event','claim',lease,now),null);}finally{await db.close();}
});
test('incomplete sending is retained as metadata-only uncertain without fabricated price, and raw source names stay exact',async()=>{
 const db=await setup();try{const state=snapshot();state.alerts[0]!.name=' ETH upper ';state.alerts[0]!.pending={id:'sending-incomplete',generation:4,phase:'sending',attempts:1};const result=await importLegacyState(db,state,options);assert.equal(result.plan.summary.uncertain,1);assert.equal(result.plan.uncertainMetadata[0]!.outcome,'uncertain');assert.equal((await db.query('SELECT * FROM outbox')).length,0);const alert=(await createRepositories(db,config).alerts.listForUser(owner.userId))[0]!;assert.equal(alert.name,' ETH upper ');assert.equal(alert.triggered,true);assert.equal(alert.pendingTriggerId,null);}finally{await db.close();}
});
test('v2 adds BTC only, preserves generation/history and original retry time',async()=>{
 const state=snapshot(2);delete (state.alerts[0] as {instrument?:string}).instrument;state.alerts[0]!.name='Legacy upper';state.alerts[0]!.pending={...queued(),name:'Legacy upper'};delete state.alerts[0]!.pending.instrument;
 const plan=await planLegacyImport(state,options);assert.equal(plan.alerts[0]!.instrument,'BTC-USDT-SWAP');assert.equal(plan.events[0]!.instrument,'BTC-USDT-SWAP');assert.equal(plan.events[0]!.originalNextAt,now+60000);assert.equal(plan.alerts[0]!.generation,4);
});
test('v1 thresholdless locks retain latch/generation and recover pending in metadata without invented alerts',async()=>{
 const state={version:1,config:{enabled:true,upper:110,lower:null,dailyLimit:20,notification},running:false,daily:{date:'2026-10-11',attempts:3},rules:{upper:{generation:7,latched:true,pending:null,last:{outcome:'sent'}},lower:{generation:9,triggered:true,pending:{id:'old-sending',phase:'sending',attempts:1},last:null}}};
 const db=await setup();try{const result=await importLegacyState(db,state,options);assert.equal(result.plan.alerts.length,1);assert.equal(result.plan.alerts[0]!.id,LEGACY_IDS.upper);const locks=JSON.parse(result.plan.metadata).legacyLocks;assert.equal(locks.lower.generation,9);assert.equal(locks.lower.triggered,true);assert.equal(locks.lower.last.outcome,'uncertain');assert.equal((await db.query('SELECT * FROM alerts')).length,1);}finally{await db.close();}
});
test('idempotent same fingerprint never resets post-import edits or quota; different snapshot/source is rejected',async()=>{
 const db=await setup();try{const state=snapshot();await importLegacyState(db,state,options);await db.execute('UPDATE alerts SET generation=9,triggered=1 WHERE user_id=?',[owner.userId]);await db.execute('UPDATE daily_usage SET attempts=19 WHERE user_id=?',[owner.userId]);const before=await tableState(db);assert.equal((await importLegacyState(db,state,{...options,now:now+1})).status,'already_imported');assert.deepEqual(await tableState(db),before);state.running=false;await assert.rejects(importLegacyState(db,state,options),/source_already_imported_differently/);await assert.rejects(importLegacyState(db,snapshot(),{...options,sourceId:'another-source'}),/target_not_empty/);}finally{await db.close();}
});
test('verified admin identity must already exist, be exact and not disabled',async()=>{
 const db=await setup();try{for(const identity of [{...owner,userId:'missing'},{...owner,email:'other@example.test'}])await assert.rejects(importLegacyState(db,snapshot(),{...options,owner:identity,dryRun:true}),/owner_not_verified_admin/);await db.execute('UPDATE "user" SET role=? WHERE id=?',['user',owner.userId]);await assert.rejects(importLegacyState(db,snapshot(),options),/owner_not_verified_admin/);await db.execute('UPDATE "user" SET role=?,email_verified=0 WHERE id=?',['admin',owner.userId]);await assert.rejects(importLegacyState(db,snapshot(),options),/owner_not_verified_admin/);await db.execute('UPDATE "user" SET email_verified=1 WHERE id=?',[owner.userId]);await createRepositories(db,config).settings.initialize(owner.userId,now);await db.execute('UPDATE user_settings SET disabled=1 WHERE user_id=?',[owner.userId]);await assert.rejects(importLegacyState(db,snapshot(),options),/owner_not_verified_admin/);}finally{await db.close();}
});
test('migration checksum mismatch and preexisting alerts reject dry-run without writes',async()=>{
 const db=await setup();try{await db.execute("UPDATE schema_migrations SET checksum='wrong' WHERE version=(SELECT version FROM schema_migrations LIMIT 1)");const before=await tableState(db);await assert.rejects(importLegacyState(db,snapshot(),{...options,dryRun:true}),/schema_not_ready/);assert.deepEqual(await tableState(db),before);}finally{await db.close();}
 const populated=await setup();try{const r=createRepositories(populated,config);await r.settings.initialize(owner.userId,now);await r.alerts.create(owner.userId,{name:'existing',instrument:'BTC-USDT-SWAP',side:'upper',threshold:1,enabled:true},now);const before=await tableState(populated);await assert.rejects(importLegacyState(populated,snapshot(),options),/target_not_empty/);assert.deepEqual(await tableState(populated),before);}finally{await populated.close();}
});
test('Node CLI applies to disposable real SQLite via runtime factory, never prints channel secrets',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'legacy-cli-'));const path=join(dir,'target.sqlite');const db=await setup(path);await db.close();
 try{const input=join(dir,'snapshot.json'),channel=join(dir,'channel.json');await writeFile(input,JSON.stringify(snapshot()),{mode:0o600});await writeFile(channel,JSON.stringify({userKey,appToken}),{mode:0o600});const result=spawnSync(process.execPath,['--import','tsx',fileURLToPath(new URL('../scripts/migrate-legacy.ts', import.meta.url)),'--target','node','--apply','--snapshot',input,'--channel-file',channel,'--source-id',options.sourceId,'--owner-id',owner.userId,'--owner-email',owner.email],{cwd:fileURLToPath(new URL('..', import.meta.url)),encoding:'utf8',env:{...process.env,NODE_ENV:'test',DEPLOYMENT:'node',DB_DRIVER:'sqlite',SQLITE_PATH:path,APP_URL:'http://localhost:3000',AUTH_SECRET:'test-auth-secret-long-enough-12345678',ENCRYPTION_KEY:key,EMAIL_PROVIDER:'console',INVITE_ONLY:'false'}});assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).status,'imported');assert.ok(!`${result.stdout}${result.stderr}`.includes(userKey));const target=await createSQLite(path,true);try{assert.equal((await target.query('SELECT * FROM alerts')).length,1);assert.equal((await target.query('SELECT * FROM channels')).length,1);}finally{await target.close();}}finally{await rm(dir,{recursive:true,force:true});}
});
test('existing channel and version slots reject import without overwriting ciphertext',async()=>{
 for(const withChannel of [false,true]){const db=await setup();try{await db.execute('INSERT INTO channel_versions VALUES(?,8)',[owner.userId]);if(withChannel)await db.execute('INSERT INTO channels VALUES(?,8,?,NULL,?)',[owner.userId,'existing-ciphertext',now]);const before=await tableState(db);await assert.rejects(importLegacyState(db,snapshot(),options),/target_not_empty/);assert.deepEqual(await tableState(db),before);}finally{await db.close();}}
});
test('quota carries the maximum existing source/user/global usage rather than resetting it',async()=>{
 const db=await setup();try{await db.execute('INSERT INTO daily_usage VALUES(?,?,18,?)',[owner.userId,'2026-10-11',now]);await db.execute('INSERT INTO global_daily_usage VALUES(?,27,?)',['2026-10-11',now]);await importLegacyState(db,snapshot(),options);assert.equal((await createRepositories(db,config).settings.dailyUsage(owner.userId,now)).attempts,18);assert.equal((await db.query<{attempts:number}>('SELECT attempts FROM global_daily_usage'))[0]!.attempts,27);}finally{await db.close();}
});
test('transaction rolls back ledger, rows and encrypted channels on late outbox error',async()=>{
 const db=await setup();try{await db.execute("CREATE TRIGGER reject_outbox BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT,'test'); END");const state=snapshot();state.alerts[0]!.pending=queued();const before=await tableState(db);await assert.rejects(importLegacyState(db,state,{...options,encryptionKey:key,channelSecrets:async()=>({userKey})}),/import_transaction_failed/);assert.deepEqual(await tableState(db),before);}finally{await db.close();}
});
test('atomic owner/data guards catch target changes after planning and roll back all writes',async()=>{
 const db=await setup();try{const plan=await planLegacyImport(snapshot(),options),statements=await buildLegacyImportStatements(plan,{});await db.execute('UPDATE "user" SET role=? WHERE id=?',['user',owner.userId]);const before=await tableState(db);assert.equal(await db.atomicCAS(statements),false);assert.deepEqual(await tableState(db),before);}finally{await db.close();}
});
test('two actual SQLite connections importing concurrently create one ledger and one rule',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'legacy-concurrent-'));const db1=await setup(join(dir,'target.sqlite')),db2=await createSQLite(join(dir,'target.sqlite'),true);
 try{const results=await Promise.all([importLegacyState(db1,snapshot(),options),importLegacyState(db2,snapshot(),options)]);assert.deepEqual(results.map(r=>r.status).sort(),['already_imported','imported']);assert.equal((await db1.query('SELECT * FROM alerts')).length,1);assert.equal((await db1.query("SELECT * FROM app_meta WHERE key LIKE 'legacy-import:source:%'")).length,1);}finally{await db1.close();await db2.close();await rm(dir,{recursive:true,force:true});}
});
test('full last snapshots use earlier generation and event ID, conflict fails before mutation',async()=>{
 const state=snapshot();state.alerts[0]!.pending=queued();state.alerts[0]!.last={...queued(3),id:'old-event',phase:undefined,outcome:'sent',at:now-1000,code:null};delete state.alerts[0]!.last.phase;delete state.alerts[0]!.last.nextAt;
 const db=await setup();try{await importLegacyState(db,state,options);const r=createRepositories(db,config);assert.equal((await r.outbox.getForUser(owner.userId,'old-event'))!.generation,3);assert.equal((await r.outbox.getForUser(owner.userId,'queued-event'))!.generation,4);}finally{await db.close();}
 state.alerts[0]!.last.generation=4;await assert.rejects(planLegacyImport(state,options),/event_generation_conflict/);
});
test('snapshot secrets, invalid/incomplete events, duplicate IDs and unknown versions fail closed',async()=>{
 for(const extra of [{PUSHOVER_APP_TOKEN:appToken},{env:{}},{config:{...snapshot().config,userKey}},{alerts:[{...snapshot().alerts[0],last:{id:'receipt',outcome:'sent',receipt:'capability'}}]}])assert.throws(()=>parseLegacySnapshot({...snapshot(),...extra}),/credentials_in_snapshot/);
 assert.throws(()=>parseLegacySnapshot({...snapshot(),version:7}),/invalid_snapshot/);
 const incomplete=snapshot();incomplete.alerts[0]!.pending={id:'x',phase:'queued',attempts:0};await assert.rejects(planLegacyImport(incomplete,options),/incomplete_pending_snapshot/);
 const duplicate=snapshot();duplicate.alerts.push({...duplicate.alerts[0]!});await assert.rejects(planLegacyImport(duplicate,options),/duplicate_alert_id/);
 const mismatched=snapshot();mismatched.alerts[0]!.pending={...queued(),generation:3};await assert.rejects(planLegacyImport(mismatched,options),/event_generation_conflict/);
});
test('explicit cutover releases queued snapshots without rearming uncertain or changing source state',async()=>{
 const db=await setup();try{const state=snapshot();state.alerts[0]!.pending=queued();await importLegacyState(db,state,{...options,encryptionKey:key,channelSecrets:async()=>({userKey})});assert.equal(await releaseLegacyHold(db,{sourceId:options.sourceId,owner,confirmSourceStopped:true,now:now+1000}),'released');const r=createRepositories(db,config);assert.equal((await r.settings.get(owner.userId))!.enabled,true);assert.equal((await r.outbox.getForUser(owner.userId,'queued-event'))!.nextAt,now+60000);assert.equal((await r.outbox.getForUser(owner.userId,'queued-event'))!.settingsGeneration,1);assert.equal(await releaseLegacyHold(db,{sourceId:options.sourceId,owner,confirmSourceStopped:true,now:now+2000}),'already_released');assert.equal(state.running,true);}finally{await db.close();}
});
test('upper/lower inclusive equality uses a fresh price after explicit switch; import cannot trigger',async()=>{
 const db=await setup();try{const state=snapshot();state.alerts.push({...state.alerts[0]!,id:'lower-alert',name:'lower',side:'lower'});await importLegacyState(db,state,{...options,encryptionKey:key,channelSecrets:async()=>({userKey})});const r=createRepositories(db,config);assert.deepEqual((await r.alerts.listActive(20)).items,[]);await releaseLegacyHold(db,{sourceId:options.sourceId,owner,confirmSourceStopped:true,now});const lease=(await r.scheduler.acquireLease('equal-test',now,15000))!;for(const a of await r.alerts.listForUser(owner.userId))assert.equal(await r.alerts.reserveTrigger({alertId:a.id,userId:owner.userId,generation:a.generation,settingsGeneration:1,channelGeneration:0,triggerId:`event-${a.id}`,tick:{instrument:a.instrument,price:a.threshold,timestamp:now,receivedAt:now},lease,now}),true);}finally{await db.close();}
});
test('D1 artifact executes exact rows on SQLite rehearsal and CHECK guards reject wrong owner',async()=>{
 const state=snapshot();state.alerts[0]!.pending=queued();const plan=await planLegacyImport(state,options),artifact=await buildD1Artifact(plan,{});
 const db=await setup();try{db.rawConnection.exec(artifact.sqliteRehearsalSql);assert.equal((await db.query<{next_at:number}>('SELECT next_at FROM outbox'))[0]!.next_at,HELD_UNTIL);assert.equal((await db.query('SELECT * FROM cas_assertions')).length,0);}finally{await db.close();}
 const wrong=await setup();try{await wrong.execute('UPDATE "user" SET role=? WHERE id=?',['user',owner.userId]);assert.throws(()=>wrong.rawConnection.exec(artifact.sqliteRehearsalSql),/CHECK/);wrong.rawConnection.exec('ROLLBACK');assert.equal((await wrong.query('SELECT * FROM alerts')).length,0);assert.equal((await wrong.query("SELECT * FROM app_meta WHERE key LIKE 'legacy-import:%'")).length,0);}finally{await wrong.close();}
});
test('private files enforce no symlinks, byte limit, mode and JSON validity; offline Cloudflare CLI prints only summary',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'legacy-migration-'));try{const path=join(dir,'snapshot.json');await writeFile(path,JSON.stringify(snapshot()),{mode:0o600});assert.equal((await readPrivateJson(path) as {version:number}).version,3);await assert.rejects(readPrivateJson(path,8),/private_file_required|snapshot_too_large/);if(process.platform!=='win32'){await symlink(path,join(dir,'link'));await assert.rejects(readPrivateJson(join(dir,'link')),/private_file_required/);await chmod(path,0o644);await assert.rejects(readPrivateJson(path),/private_file_required/);await chmod(path,0o600);}
 const script=fileURLToPath(new URL('../scripts/migrate-legacy.ts', import.meta.url));const result=spawnSync(process.execPath,['--import','tsx',script,'--target','cloudflare','--dry-run','--snapshot',path,'--source-id',options.sourceId,'--owner-id',owner.userId,'--owner-email',owner.email],{cwd:fileURLToPath(new URL('..', import.meta.url)),encoding:'utf8',env:{...process.env,ENCRYPTION_KEY:undefined,DATABASE_URL:undefined}});assert.equal(result.status,0,result.stderr);const summary=JSON.parse(result.stdout);assert.equal(summary.status,'dry_run_offline');assert.equal(summary.alerts,1);assert.ok(!result.stdout.includes(owner.email));assert.ok(!result.stdout.includes('ETH upper'));}finally{await rm(dir,{recursive:true,force:true});}
});

async function mergeSetup(db: SqlDatabase, enabled=false) {
 const r=createRepositories(db,config);await r.settings.initialize(owner.userId,now);
 await db.execute('UPDATE user_settings SET generation=6,daily_limit=7,notification_json=?,enabled=? WHERE user_id=?',[JSON.stringify({...notification,sound:'alien'}),+enabled,owner.userId]);
 await db.execute('INSERT INTO channel_versions VALUES(?,9)',[owner.userId]);
 await db.execute('INSERT INTO channels VALUES(?,9,?,NULL,?)',[owner.userId,'existing-ciphertext',now]);
 const a=await r.alerts.create(owner.userId,{name:'new user alert',instrument:'BTC-USDT-SWAP',side:'lower',threshold:1,enabled:true},now);
 await db.execute('UPDATE alerts SET generation=12,triggered=1,trigger_id=? WHERE id=?',['new-user-history',a.id]);
 await db.execute('INSERT INTO daily_usage VALUES(?,?,5,?)',[owner.userId,'2026-10-11',now]);
 await db.execute('INSERT INTO global_daily_usage VALUES(?,17,?)',['2026-10-11',now]);
 return a.id;
}
const mergeOptions={...options,mergeExisting:{settingsGeneration:6,channelGeneration:9}};
test('explicit merge retains new alert/settings/channel and old generations/locks, adds independent quotas once and releases against recorded generations',async()=>{
 const db=await setup();try{
  const existingId=await mergeSetup(db),before=await tableState(db);const state=snapshot();state.alerts[0]!.pending=queued();state.legacyLocks.lower={generation:13,latched:true,pending:null,last:{id:'legacy-lock-event',outcome:'sent',attempts:1}};
  const result=await importLegacyState(db,state,mergeOptions);assert.equal(result.status,'imported');
  assert.deepEqual(await db.query('SELECT * FROM alerts WHERE id=?',[existingId]),(before.alerts as any[]).filter(a=>a.id===existingId));
  for(const table of ['user_settings','channels','channel_versions'])assert.deepEqual(await db.query(`SELECT * FROM ${table}`),before[table]);
  assert.equal((await db.query<{attempts:number}>('SELECT attempts FROM daily_usage'))[0]!.attempts,16);assert.equal((await db.query<{attempts:number}>('SELECT attempts FROM global_daily_usage'))[0]!.attempts,28);
  assert.equal(JSON.parse(result.plan.metadata).legacyLocks.lower.generation,13);assert.equal(result.plan.alerts[0]!.generation,4);
  const event=(await db.query<{settings_generation:number;channel_generation:number;next_at:number}>('SELECT * FROM outbox'))[0]!;assert.equal(event.settings_generation,6);assert.equal(event.channel_generation,9);assert.equal(event.next_at,HELD_UNTIL);
  const imported=await tableState(db);assert.equal((await importLegacyState(db,state,mergeOptions)).status,'already_imported');assert.deepEqual(await tableState(db),imported);
  assert.equal(await releaseLegacyHold(db,{sourceId:options.sourceId,owner,confirmSourceStopped:true,now:now+1}),'released');
  const settings=(await db.query<any>('SELECT * FROM user_settings'))[0]!;assert.equal(settings.generation,7);assert.equal(settings.daily_limit,7);assert.equal(settings.notification_json,(before.user_settings as any[])[0].notification_json);assert.deepEqual(await db.query('SELECT * FROM channels'),before.channels);assert.equal((await db.query<any>('SELECT * FROM outbox'))[0]!.settings_generation,7);
 }finally{await db.close();}
});
test('merge requires disabled settings and quiescent tasks, forbids channel input, mismatched generation, other owners and prior ledger',async()=>{
 const {checkLegacyMergeTarget}=await import('../src/migration/legacy.js');
 const db=await setup();try{const a=await mergeSetup(db,true);const before=await tableState(db);await assert.rejects(checkLegacyMergeTarget(db,owner),/merge_target_enabled/);await assert.rejects(importLegacyState(db,snapshot(),mergeOptions),/merge_target_enabled/);assert.deepEqual(await tableState(db),before);await db.execute('UPDATE user_settings SET enabled=0');
  assert.deepEqual(await checkLegacyMergeTarget(db,owner),mergeOptions.mergeExisting);await assert.rejects(importLegacyState(db,snapshot(),{...mergeOptions,mergeExisting:{settingsGeneration:5,channelGeneration:9}}),/merge_target_changed/);
  await assert.rejects(importLegacyState(db,snapshot(),{...mergeOptions,channelSecrets:async()=>{throw Error('never');}}),/merge_preserves_channels/);
  await db.execute("INSERT INTO test_notifications VALUES('test-pending',?,9,6,'claim','sending',?,?,NULL)",[owner.userId,now,now]);await assert.rejects(checkLegacyMergeTarget(db,owner),/merge_target_not_ready/);await db.execute("UPDATE test_notifications SET phase='sent'");
  await db.execute("INSERT INTO auth_registration_policy(id,max_users,invite_only) VALUES('registration',5,0)");await db.execute('INSERT INTO "user"(id,email,name,email_verified,role,updated_at) VALUES(?,?,?,?,?,?)',['other-owner','other@example.test','Other',1,'user',now]);await db.execute('UPDATE alerts SET user_id=? WHERE id=?',['other-owner',a]);await assert.rejects(checkLegacyMergeTarget(db,owner),/merge_target_not_ready/);await db.execute('UPDATE alerts SET user_id=? WHERE id=?',[owner.userId,a]);
  await db.execute('INSERT INTO app_meta VALUES(?,?)',[`legacy-import:owner:${owner.userId}`,'old-ledger']);await assert.rejects(checkLegacyMergeTarget(db,owner),/merge_target_not_ready/);
 }finally{await db.close();}
});
test('merge collision guards include metadata-only history, legacy lock IDs, and target changes after planning',async()=>{
 for(const kind of ['alert','history','lock','enabled','pending','channel','source-ledger'] as const){const db=await setup();try{const existingId=await mergeSetup(db);const state=snapshot();state.alerts[0]!.last={id:'metadata-only',outcome:'sent',attempts:1};state.legacyLocks.lower={generation:2,pending:null,last:null};const plan=await planLegacyImport(state,mergeOptions),statements=await buildLegacyImportStatements(plan,{});
  if(kind==='alert')await db.execute('UPDATE alerts SET id=? WHERE id=?',[state.alerts[0]!.id,existingId]);
  if(kind==='history')await db.execute('UPDATE alerts SET trigger_id=? WHERE id=?',['metadata-only',existingId]);
  if(kind==='lock')await db.execute('UPDATE alerts SET id=? WHERE id=?',[LEGACY_IDS.lower,existingId]);
  if(kind==='enabled')await db.execute('UPDATE user_settings SET enabled=1');
  if(kind==='pending')await db.execute("INSERT INTO test_notifications VALUES('pending',?,9,6,'claim','sending',?,?,NULL)",[owner.userId,now,now]);
  if(kind==='channel')await db.execute('UPDATE channels SET generation=10');
  if(kind==='source-ledger')await db.execute('INSERT INTO app_meta VALUES(?,?)',[plan.ledgerKey,'{"fingerprint":"other"}']);
  const before=await tableState(db);assert.equal(await db.atomicCAS(statements),false,kind);assert.deepEqual(await tableState(db),before,kind);
 }finally{await db.close();}}
});
test('merge exact D1 rehearsal SQL rolls back late capacity failure including ledger and additive quota',async()=>{
 const db=await setup();try{await mergeSetup(db);const state=snapshot();state.alerts[0]!.pending=queued();const plan=await planLegacyImport(state,mergeOptions),before=await tableState(db);
  const bad=await buildD1Artifact(plan,{limits:{...config.limits,alertsPerUser:1}});assert.throws(()=>db.rawConnection.exec(bad.sqliteRehearsalSql),/CHECK/);db.rawConnection.exec('ROLLBACK');assert.deepEqual(await tableState(db),before);
  const artifact=await buildD1Artifact(plan,{});db.rawConnection.exec(artifact.sqliteRehearsalSql);assert.equal((await db.query<any>('SELECT attempts FROM daily_usage'))[0].attempts,16);assert.equal((await db.query('SELECT * FROM alerts')).length,2);assert.equal((await db.query('SELECT * FROM cas_assertions')).length,0);
 }finally{await db.close();}
});
test('merge rejects existing queued/sending outbox, metadata ID collision and consumed quota overflow without partial writes',async()=>{
 for(const phase of ['queued','sending','sent'] as const){const db=await setup();try{const existingId=await mergeSetup(db);await db.execute('INSERT INTO outbox(trigger_id,alert_id,user_id,generation,settings_generation,channel_generation,instrument,name,side,threshold,price,timestamp,notification_json,phase,attempts,next_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',['existing-event',existingId,owner.userId,12,6,9,'BTC-USDT-SWAP','existing','lower',1,1,now,JSON.stringify(notification),phase,1,now,now,now]);const state=snapshot();state.alerts[0]!.last={id:'existing-event',outcome:'sent',attempts:1};const before=await tableState(db);await assert.rejects(importLegacyState(db,state,mergeOptions),phase==='sent'?/target_id_conflict/:/merge_target_not_ready/);assert.deepEqual(await tableState(db),before);}finally{await db.close();}}
 const db=await setup();try{await mergeSetup(db);await db.execute('UPDATE daily_usage SET attempts=?',[Number.MAX_SAFE_INTEGER]);const before=await tableState(db);const plan=await planLegacyImport(snapshot(),mergeOptions);assert.equal(await db.atomicCAS(await buildLegacyImportStatements(plan,{})),false);assert.deepEqual(await tableState(db),before);}finally{await db.close();}
});
test('two connections merge once with additive quotas; different fresh source remains forbidden',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'legacy-merge-concurrent-')),db1=await setup(join(dir,'target.sqlite')),db2=await createSQLite(join(dir,'target.sqlite'),true);
 try{await mergeSetup(db1);const results=await Promise.all([importLegacyState(db1,snapshot(),mergeOptions),importLegacyState(db2,snapshot(),mergeOptions)]);assert.deepEqual(results.map(r=>r.status).sort(),['already_imported','imported']);assert.equal((await db1.query<any>('SELECT attempts FROM daily_usage'))[0].attempts,16);const before=await tableState(db1);await assert.rejects(importLegacyState(db1,snapshot(),{...mergeOptions,sourceId:'different-source'}),/merge_target_not_ready/);assert.deepEqual(await tableState(db1),before);}finally{await db1.close();await db2.close();await rm(dir,{recursive:true,force:true});}
});
test('Node merge CLI derives existing generations and recovers committed ledger on repeat without quota reset',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'legacy-merge-cli-')),path=join(dir,'target.sqlite'),db=await setup(path);await mergeSetup(db);await db.close();
 try{const input=join(dir,'snapshot.json');await writeFile(input,JSON.stringify(snapshot()),{mode:0o600});
  const args=['--import','tsx',fileURLToPath(new URL('../scripts/migrate-legacy.ts', import.meta.url)),'--target','node','--apply','--merge-existing','--snapshot',input,'--source-id',options.sourceId,'--owner-id',owner.userId,'--owner-email',owner.email];
  for(const expected of ['imported','already_imported']){const result=spawnSync(process.execPath,args,{cwd:fileURLToPath(new URL('..', import.meta.url)),encoding:'utf8',env:{...process.env,NODE_ENV:'test',DEPLOYMENT:'node',DB_DRIVER:'sqlite',SQLITE_PATH:path,APP_URL:'http://localhost:3000',AUTH_SECRET:'test-auth-secret-long-enough-12345678',ENCRYPTION_KEY:key,EMAIL_PROVIDER:'console',INVITE_ONLY:'false'}});assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).status,expected);assert.ok(!result.stdout.includes(owner.email));}
  const target=await createSQLite(path,true);try{assert.equal((await target.query<any>('SELECT attempts FROM daily_usage'))[0].attempts,16);assert.equal((await target.query<any>('SELECT generation FROM user_settings'))[0].generation,6);assert.equal((await target.query('SELECT * FROM alerts')).length,2);}finally{await target.close();}
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('empty source plus legacy locks merges into enabled or disabled existing alert without changing terminal history',async()=>{
 for(const alertEnabled of [false,true]){const db=await setup();try{const existingId=await mergeSetup(db);await db.execute('UPDATE alerts SET enabled=? WHERE id=?',[+alertEnabled,existingId]);await db.execute('INSERT INTO outbox(trigger_id,alert_id,user_id,generation,settings_generation,channel_generation,instrument,name,side,threshold,price,timestamp,notification_json,phase,attempts,next_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',['existing-event',existingId,owner.userId,12,6,9,'BTC-USDT-SWAP','existing','lower',1,1,now,JSON.stringify(notification),'sent',1,now,now,now]);const state=snapshot();state.alerts=[];state.legacyLocks.upper={generation:1,triggered:false,pending:null,last:{id:'old-rule-history',outcome:'sent',attempts:1}};state.legacyLocks.lower={generation:1,triggered:false,pending:null,last:null};const before=await tableState(db),result=await importLegacyState(db,state,mergeOptions);assert.equal(result.plan.summary.alerts,0);assert.equal(result.plan.summary.legacyLocks,2);for(const table of ['alerts','outbox','user_settings','channels','channel_versions'])assert.deepEqual(await db.query(`SELECT * FROM ${table}`),before[table]);assert.equal(JSON.parse(result.plan.metadata).originalLegacyLocks.upper.last.id,'old-rule-history');}finally{await db.close();}}
});
