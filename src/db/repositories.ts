import type { AppConfig } from '../config.js';
import { RUNTIME_POLICY } from '../config.js';
import type { AlertRecord, ChannelRecord, OutboxRecord, Repositories, SchedulerLease, SqlDatabase, SqlStatement, SqlValue, TestDeliveryRecord, TriggerReservation, UserSettingsRecord } from '../contracts/db.js';
import { RepositoryConflict } from '../contracts/db.js';
import { alertInputSchema, DEFAULT_NOTIFICATION, notificationOptionsSchema } from '../contracts/domain.js';
import type { AlertInput, EncryptedSecret, UserIdentity, UserSettings } from '../contracts/domain.js';
type Row = Record<string, any>;
type CAS = SqlStatement & { expectedChanges?: number };
const statement = (sql: string, params: readonly SqlValue[] = [], expectedChanges = 1): CAS => ({sql,params,expectedChanges});
const lock = () => statement("UPDATE app_meta SET value=value WHERE key='write-lock'");
const pending = `NOT EXISTS(SELECT 1 FROM outbox o WHERE o.user_id=user_settings.user_id AND o.phase IN('queued','sending')) AND NOT EXISTS(SELECT 1 FROM test_notifications t WHERE t.user_id=user_settings.user_id AND t.phase='sending')`;
const utc = (now: number) => new Date(now).toISOString().slice(0,10);
const pageLimit = (n: number) => { if (!Number.isSafeInteger(n) || n < 1 || n > 1000) throw new RangeError('Invalid page limit'); return n; };
const validId = (id: string) => { if (!id || id.length > 200) throw new TypeError('Invalid ID'); return id; };
const enc = (v: EncryptedSecret) => { if (v.version !== 1 || v.algorithm !== 'A256GCM' || !v.iv || !v.ciphertext) throw new TypeError('Invalid encrypted envelope'); return JSON.stringify(v); };
function alert(r: Row): AlertRecord { return {id:r.id,userId:r.user_id,name:r.name,instrument:r.instrument,side:r.side,threshold:r.threshold,enabled:!!r.enabled,generation:r.generation,triggered:!!r.triggered,triggerId:r.trigger_id,pendingTriggerId:r.pending_trigger_id,createdAt:r.created_at,updatedAt:r.updated_at,deletedAt:r.deleted_at}; }
function settings(r: Row): UserSettingsRecord { return {userId:r.user_id,enabled:!!r.enabled,disabled:!!r.disabled,generation:r.generation,dailyLimit:r.daily_limit,notification:notificationOptionsSchema.parse(JSON.parse(r.notification_json))}; }
function channel(r: Row): ChannelRecord { return {userId:r.user_id,generation:r.generation,userKey:JSON.parse(r.user_key_json),privateAppToken:r.private_token_json ? JSON.parse(r.private_token_json) : null,updatedAt:r.updated_at}; }
function outbox(r: Row): OutboxRecord { return {triggerId:r.trigger_id,alertId:r.alert_id,userId:r.user_id,generation:r.generation,channelGeneration:r.channel_generation,settingsGeneration:r.settings_generation,instrument:r.instrument,name:r.name,side:r.side,threshold:r.threshold,price:r.price,timestamp:r.timestamp,notification:notificationOptionsSchema.parse(JSON.parse(r.notification_json)),phase:r.phase,attempts:r.attempts,nextAt:r.next_at,createdAt:r.created_at,updatedAt:r.updated_at,claimId:r.claim_id,claimFence:r.claim_fence,receipt:r.receipt_json ? JSON.parse(r.receipt_json) : null,code:r.code}; }
function lease(r: Row): SchedulerLease { return {id:'coordinator-v1',ownerId:r.owner_id,fence:r.fence,expiresAt:r.expires_at}; }
function test(r: Row): TestDeliveryRecord { return {id:r.id,userId:r.user_id,channelGeneration:r.channel_generation,settingsGeneration:r.settings_generation,claimId:r.claim_id,phase:r.phase,createdAt:r.created_at,updatedAt:r.updated_at,code:r.code}; }
const leaseGuard = `EXISTS(SELECT 1 FROM scheduler_lease l WHERE l.id='coordinator-v1' AND l.owner_id=? AND l.fence=? AND l.expires_at>?)`;
const leaseParams = (l: SchedulerLease, now: number): SqlValue[] => [l.ownerId,l.fence,now];
export function createRepositories(db: SqlDatabase, config: Pick<AppConfig,'limits'>): Repositories {
  const limits = config.limits;
  const globalLimit = limits.globalNotificationAttempts ?? 20_000;
  async function rows(sql: string, p: readonly SqlValue[] = []) { return db.query<Row>(sql,p); }
  async function getAlert(userId: string, id: string) { const r = await rows('SELECT * FROM alerts WHERE user_id=? AND id=? AND deleted_at IS NULL',[userId,id]); return r[0] ? alert(r[0]) : null; }
  async function getSettings(userId: string) { const r = await rows('SELECT * FROM user_settings WHERE user_id=?',[userId]); return r[0] ? settings(r[0]) : null; }
  async function getChannel(userId: string) { const r = await rows('SELECT * FROM channels WHERE user_id=?',[userId]); return r[0] ? channel(r[0]) : null; }
  async function userPending(userId: string) { return !!(await rows("SELECT trigger_id FROM outbox WHERE user_id=? AND phase IN('queued','sending') UNION ALL SELECT id FROM test_notifications WHERE user_id=? AND phase='sending' LIMIT 1",[userId,userId])).length; }
  async function alertConflict(userId: string, id: string, generation: number): Promise<never> { const a = await getAlert(userId,id); if (!a) throw new RepositoryConflict('not_found'); if(a.pendingTriggerId) throw new RepositoryConflict('pending_delivery'); if(a.generation !== generation) throw new RepositoryConflict('generation_conflict'); throw new RepositoryConflict('limit_exceeded'); }
  async function settingsConflict(userId: string, generation: number): Promise<never> { if(await userPending(userId)) throw new RepositoryConflict('pending_delivery'); const s = await getSettings(userId); if(!s) throw new RepositoryConflict('not_found'); if(s.generation !== generation) throw new RepositoryConflict('generation_conflict'); throw new RepositoryConflict('limit_exceeded'); }
  function capacity(userId: string, id: string, input: AlertInput): {sql:string;params:SqlValue[]} {
    // Exclude the proposed row, then account for its new instrument/enabled value.
    return {sql:`(SELECT COUNT(*) FROM alerts WHERE user_id=? AND deleted_at IS NULL AND id<>?)<?
      AND ((SELECT COUNT(DISTINCT instrument) FROM alerts WHERE user_id=? AND deleted_at IS NULL AND id<>?)<? OR EXISTS(SELECT 1 FROM alerts WHERE user_id=? AND deleted_at IS NULL AND id<>? AND instrument=?))
      AND (?=0 OR (SELECT COUNT(*) FROM alerts WHERE enabled=1 AND deleted_at IS NULL AND id<>?)<?)
      AND ((SELECT COUNT(DISTINCT instrument) FROM alerts WHERE deleted_at IS NULL AND id<>?)<? OR EXISTS(SELECT 1 FROM alerts WHERE deleted_at IS NULL AND id<>? AND instrument=?))`,params:[userId,id,limits.alertsPerUser,userId,id,limits.instrumentsPerUser,userId,id,input.instrument,+input.enabled,id,limits.activeAlerts,id,limits.globalInstruments,id,input.instrument]};
  }
  async function updateAlert(userId: string,id: string,generation: number,input: AlertInput,now: number,rearm=false,remove=false) {
    const cap = capacity(userId,id,input);
    const sql = `UPDATE alerts SET name=?,instrument=?,side=?,threshold=?,enabled=?,generation=generation+1,updated_at=?,deleted_at=?${rearm?',triggered=0,trigger_id=NULL':''} WHERE user_id=? AND id=? AND generation=? AND pending_trigger_id IS NULL AND deleted_at IS NULL AND ${remove ? '1=1' : cap.sql}`;
    const params: SqlValue[] = [input.name,input.instrument,input.side,input.threshold,+input.enabled,now,remove?now:null,userId,id,generation,...(remove?[]:cap.params)];
    if (!await db.atomicCAS([lock(),statement(sql,params)])) await alertConflict(userId,id,generation);
    return remove ? null : (await getAlert(userId,id))!;
  }
  async function activeRows(limit: number, cursor?: string) {
    pageLimit(limit); let instrument = '', id = '';
    if (cursor) { const parsed = JSON.parse(cursor); if (!Array.isArray(parsed) || parsed.length !== 2 || parsed.some(v => typeof v !== 'string')) throw new TypeError('Invalid cursor'); [instrument,id] = parsed; }
    return rows(`SELECT a.*,s.generation AS settings_generation,c.generation AS channel_generation,CASE WHEN c.private_token_json IS NOT NULL THEN 1 ELSE 0 END AS has_private_token FROM alerts a JOIN user_settings s ON s.user_id=a.user_id JOIN channels c ON c.user_id=a.user_id WHERE a.enabled=1 AND a.triggered=0 AND a.deleted_at IS NULL AND s.enabled=1 AND s.disabled=0 AND (a.instrument>? OR (a.instrument=? AND a.id>?)) ORDER BY a.instrument,a.id LIMIT ?`,[instrument,instrument,id,limit+1]);
  }
  const alerts: Repositories['alerts'] = {
    async listForUser(userId) { return (await rows('SELECT * FROM alerts WHERE user_id=? AND deleted_at IS NULL ORDER BY created_at,id LIMIT ?',[userId,limits.alertsPerUser])).map(alert); },
    getForUser:getAlert,
    async listActive(limit,cursor) {
      const r = await activeRows(limit,cursor), items = r.slice(0,limit).map(alert), last=items.at(-1);
      return {items,cursor:r.length>limit&&last ? JSON.stringify([last.instrument,last.id]) : null};
    },
    async listActiveWithProfiles(limit,cursor) {
      const r = await activeRows(limit,cursor), items = r.slice(0,limit).map(v => ({...alert(v),settingsGeneration:v.settings_generation as number,channelGeneration:v.channel_generation as number,hasPrivateAppToken:!!v.has_private_token})), last=items.at(-1);
      return {items,cursor:r.length>limit&&last ? JSON.stringify([last.instrument,last.id]) : null};
    },
    async create(userId,input,now) {
      input=alertInputSchema.parse(input); const id=crypto.randomUUID(), cap=capacity(userId,id,input);
      const ok=await db.atomicCAS([lock(),statement(`INSERT INTO alerts(id,user_id,name,instrument,side,threshold,enabled,generation,triggered,created_at,updated_at) SELECT ?,?,?,?,?,?,?,0,0,?,? WHERE EXISTS(SELECT 1 FROM user_settings WHERE user_id=? AND disabled=0) AND ${cap.sql}`,[id,userId,input.name,input.instrument,input.side,input.threshold,+input.enabled,now,now,userId,...cap.params])]);
      if(!ok) throw new RepositoryConflict(await getSettings(userId)?'limit_exceeded':'not_found'); return (await getAlert(userId,id))!;
    },
    async patch(userId,id,generation,patch,now) { const a=await getAlert(userId,id); if(!a) throw new RepositoryConflict('not_found'); const input=alertInputSchema.parse({name:a.name,instrument:a.instrument,side:a.side,threshold:a.threshold,enabled:a.enabled,...patch}); return (await updateAlert(userId,id,generation,input,now))!; },
    async remove(userId,id,generation,now) { const a=await getAlert(userId,id); if(!a) throw new RepositoryConflict('not_found'); await updateAlert(userId,id,generation,a,now,false,true); },
    async rearm(userId,id,generation,now) { const a=await getAlert(userId,id); if(!a) throw new RepositoryConflict('not_found'); return (await updateAlert(userId,id,generation,a,now,true))!; },
    async reserveTrigger(i: TriggerReservation) {
      const t=i.tick, now=i.now; validId(i.triggerId);
      if(!Number.isFinite(t.price)||t.price<=0||t.price>1e12||!Number.isSafeInteger(t.timestamp)||!Number.isSafeInteger(t.receivedAt)||t.timestamp>now+5000||now-t.timestamp>30000||t.receivedAt>now||now-t.receivedAt>30000) return false;
      const a=await getAlert(i.userId,i.alertId); if(!a||a.instrument!==t.instrument||(a.side==='upper'?t.price<a.threshold:t.price>a.threshold)) return false;
      const counts=await db.atomic([lock(),leaseLock(i.lease,now),
        {sql:`UPDATE alerts SET triggered=1,trigger_id=?,pending_trigger_id=?,updated_at=? WHERE id=? AND user_id=? AND generation=? AND enabled=1 AND triggered=0 AND pending_trigger_id IS NULL AND deleted_at IS NULL AND instrument=? AND ((side='upper' AND threshold<=?) OR (side='lower' AND threshold>=?)) AND EXISTS(SELECT 1 FROM user_settings s WHERE s.user_id=alerts.user_id AND s.enabled=1 AND s.disabled=0 AND s.generation=?) AND EXISTS(SELECT 1 FROM channels c WHERE c.user_id=alerts.user_id AND c.generation=?) AND ${leaseGuard}`,params:[i.triggerId,i.triggerId,now,i.alertId,i.userId,i.generation,t.instrument,t.price,t.price,i.settingsGeneration,i.channelGeneration,...leaseParams(i.lease,now)]},
        {sql:`INSERT INTO outbox(trigger_id,alert_id,user_id,generation,settings_generation,channel_generation,instrument,name,side,threshold,price,timestamp,notification_json,phase,attempts,next_at,created_at,updated_at) SELECT ?,a.id,a.user_id,a.generation,?,?,a.instrument,a.name,a.side,a.threshold,?,?,s.notification_json,'queued',0,?,?,? FROM alerts a JOIN user_settings s ON s.user_id=a.user_id WHERE a.id=? AND a.user_id=? AND a.generation=? AND a.triggered=1 AND a.trigger_id=? AND a.pending_trigger_id=?`,params:[i.triggerId,i.settingsGeneration,i.channelGeneration,t.price,t.timestamp,now,now,now,i.alertId,i.userId,i.generation,i.triggerId,i.triggerId]}
      ]);
      if(counts[2]===1&&counts[3]===1) return true; if(counts[2]===0&&counts[3]===0) return false; throw new Error('Trigger reservation invariant failed');
    }
  };
  const current = `EXISTS(SELECT 1 FROM alerts a JOIN user_settings s ON s.user_id=a.user_id JOIN channels c ON c.user_id=a.user_id WHERE a.id=outbox.alert_id AND a.user_id=outbox.user_id AND a.generation=outbox.generation AND a.trigger_id=outbox.trigger_id AND a.pending_trigger_id=outbox.trigger_id AND a.enabled=1 AND a.deleted_at IS NULL AND s.enabled=1 AND s.disabled=0 AND s.generation=outbox.settings_generation AND c.generation=outbox.channel_generation)`;
  function leaseLock(l:SchedulerLease,now:number) { return statement("UPDATE scheduler_lease SET expires_at=expires_at WHERE id='coordinator-v1' AND owner_id=? AND fence=? AND expires_at>?",leaseParams(l,now)); }
  function usageInit(userId:string,now:number):SqlStatement[] { return [{sql:'INSERT INTO daily_usage(user_id,utc_date,attempts,updated_at) SELECT ?,?,0,? WHERE EXISTS(SELECT 1 FROM "user" WHERE id=?) ON CONFLICT(user_id,utc_date) DO NOTHING',params:[userId,utc(now),now,userId]},{sql:'INSERT INTO global_daily_usage(utc_date,attempts,updated_at) VALUES(?,0,?) ON CONFLICT(utc_date) DO NOTHING',params:[utc(now),now]}]; }
  const scheduler: Repositories['scheduler'] = {
    async hasWork(sharedAppTokenAvailable) {
      const r = await rows(`SELECT CASE WHEN EXISTS(SELECT 1 FROM alerts a JOIN user_settings s ON s.user_id=a.user_id JOIN channels c ON c.user_id=a.user_id WHERE a.enabled=1 AND a.triggered=0 AND a.pending_trigger_id IS NULL AND a.deleted_at IS NULL AND s.enabled=1 AND s.disabled=0 AND (?=1 OR c.private_token_json IS NOT NULL)) OR EXISTS(SELECT 1 FROM outbox WHERE phase IN('queued','sending')) THEN 1 ELSE 0 END AS has_work`,[+sharedAppTokenAvailable]);
      return !!r[0]?.has_work;
    },
    async acquireLease(ownerId,now,durationMs) {
      validId(ownerId); if(!Number.isSafeInteger(durationMs)||durationMs<1||durationMs>60000) throw new RangeError('Invalid lease duration');
      const counts=await db.atomic([{sql:"INSERT INTO scheduler_lease(id,owner_id,fence,expires_at) VALUES('coordinator-v1',?,1,?) ON CONFLICT(id) DO UPDATE SET owner_id=excluded.owner_id,fence=scheduler_lease.fence+1,expires_at=excluded.expires_at WHERE scheduler_lease.expires_at<=?",params:[ownerId,now+durationMs,now]}]);
      if(!counts[0]) return null; const r=await rows("SELECT * FROM scheduler_lease WHERE id='coordinator-v1' AND owner_id=? AND expires_at>?",[ownerId,now]); return r[0]?lease(r[0]):null;
    },
    async renewLease(l,now,durationMs) { if(!Number.isSafeInteger(durationMs)||durationMs<1||durationMs>60000) throw new RangeError('Invalid lease duration'); const r=await db.execute("UPDATE scheduler_lease SET expires_at=? WHERE id='coordinator-v1' AND owner_id=? AND fence=? AND expires_at>?",[now+durationMs,...leaseParams(l,now)]); return r.changes?{...l,expiresAt:now+durationMs}:null; },
    async releaseLease(l,now) { await db.execute("UPDATE scheduler_lease SET expires_at=? WHERE id='coordinator-v1' AND owner_id=? AND fence=?",[now,l.ownerId,l.fence]); },
    async listDue(now,limit,cursor) { return (await rows("SELECT * FROM outbox WHERE phase='queued' AND next_at<=? AND (next_at>? OR (next_at=? AND trigger_id>?)) ORDER BY next_at,trigger_id LIMIT ?",[now,cursor?.nextAt??-1,cursor?.nextAt??-1,cursor?.triggerId??'',pageLimit(limit)])).map(outbox); },
    async claimDelivery(triggerId,claimId,l,now) {
      validId(claimId);
      const r=await rows("SELECT * FROM outbox WHERE trigger_id=? AND phase='queued'",[triggerId]); if(!r[0]) return null; const userId=r[0].user_id as string;
      const quota = `(SELECT d.attempts FROM daily_usage d WHERE d.user_id=outbox.user_id AND d.utc_date=?) < (SELECT s.daily_limit FROM user_settings s WHERE s.user_id=outbox.user_id) AND (SELECT d.attempts FROM daily_usage d WHERE d.user_id=outbox.user_id AND d.utc_date=?)<? AND (SELECT g.attempts FROM global_daily_usage g WHERE g.utc_date=?)<?`;
      const ok=await db.atomicCAS([lock(),leaseLock(l,now),...usageInit(userId,now),statement(`UPDATE outbox SET phase='sending',claim_id=?,claim_fence=?,attempts=attempts+1,updated_at=? WHERE trigger_id=? AND user_id=? AND phase='queued' AND claim_id IS NULL AND next_at<=? AND attempts<3 AND created_at>=? AND ${current} AND ${quota}`,[claimId,l.fence,now,triggerId,userId,now,now-RUNTIME_POLICY.maxPendingAgeMs,utc(now),utc(now),limits.dailyNotificationAttempts,utc(now),globalLimit]),statement("UPDATE daily_usage SET attempts=attempts+1,updated_at=? WHERE user_id=? AND utc_date=? AND EXISTS(SELECT 1 FROM outbox WHERE trigger_id=? AND user_id=? AND phase='sending' AND claim_id=? AND claim_fence=?)",[now,userId,utc(now),triggerId,userId,claimId,l.fence]),statement("UPDATE global_daily_usage SET attempts=attempts+1,updated_at=? WHERE utc_date=? AND EXISTS(SELECT 1 FROM outbox WHERE trigger_id=? AND user_id=? AND phase='sending' AND claim_id=? AND claim_fence=?)",[now,utc(now),triggerId,userId,claimId,l.fence])]);
      if(ok) { const v=await rows('SELECT * FROM outbox WHERE trigger_id=? AND user_id=? AND claim_id=?',[triggerId,userId,claimId]); return v[0]?outbox(v[0]):null; }
      // A blocked queued event is finalized while latched. No quota is consumed.
      await db.atomicCAS([lock(),leaseLock(l,now),{sql:`UPDATE outbox SET phase=CASE WHEN created_at<? THEN 'expired' WHEN NOT (${current}) THEN 'cancelled' WHEN attempts>=3 THEN 'failed' ELSE 'daily_limit' END,code='delivery_blocked',updated_at=? WHERE trigger_id=? AND user_id=? AND phase='queued' AND next_at<=? AND ${leaseGuard} AND (created_at<? OR NOT (${current}) OR attempts>=3 OR NOT (${quota}))`,params:[now-RUNTIME_POLICY.maxPendingAgeMs,now,triggerId,userId,now,...leaseParams(l,now),now-RUNTIME_POLICY.maxPendingAgeMs,utc(now),utc(now),limits.dailyNotificationAttempts,utc(now),globalLimit]},{sql:"UPDATE alerts SET pending_trigger_id=NULL,updated_at=? WHERE user_id=? AND pending_trigger_id=? AND EXISTS(SELECT 1 FROM outbox WHERE trigger_id=? AND user_id=? AND phase NOT IN('queued','sending'))",params:[now,userId,triggerId,triggerId,userId]}]);
      return null;
    },
    async finishDelivery(triggerId,claimId,l,outcome,code,receipt,now) {
      if(!['queued','sent','failed','uncertain','expired','cancelled','daily_limit'].includes(outcome)) throw new TypeError('Invalid delivery outcome');
      const r=await rows('SELECT * FROM outbox WHERE trigger_id=? AND claim_id=?',[triggerId,claimId]); if(!r[0]) return false; const userId=r[0].user_id as string;
      const retry=outcome==='queued'&&code==='provider_rejected'; const canRetry=retry&&r[0].attempts<3&&now-r[0].created_at<RUNTIME_POLICY.maxPendingAgeMs;
      const phase=outcome==='queued'&&!retry?'uncertain':retry&&!canRetry?'failed':outcome;
      const success=await db.atomicCAS([lock(),leaseLock(l,now),
        {expectedChanges:1,sql:`UPDATE outbox SET phase=?,code=?,receipt_json=?,updated_at=?,next_at=?,claim_id=${canRetry?'NULL':'claim_id'} WHERE trigger_id=? AND user_id=? AND phase='sending' AND claim_id=? AND claim_fence=? AND ${leaseGuard} AND EXISTS(SELECT 1 FROM alerts a WHERE a.id=outbox.alert_id AND a.user_id=outbox.user_id AND a.generation=outbox.generation AND a.trigger_id=outbox.trigger_id AND a.pending_trigger_id=outbox.trigger_id)`,params:[phase,code,receipt?enc(receipt):null,now,canRetry?now+60_000*2**(r[0].attempts-1):now,triggerId,userId,claimId,l.fence,...leaseParams(l,now)]},
        {sql:`UPDATE alerts SET pending_trigger_id=NULL,updated_at=? WHERE user_id=? AND pending_trigger_id=? AND EXISTS(SELECT 1 FROM outbox WHERE trigger_id=? AND user_id=? AND phase NOT IN('queued','sending') AND claim_id=? AND claim_fence=? AND updated_at=?) AND ${leaseGuard}`,params:[now,userId,triggerId,triggerId,userId,claimId,l.fence,now,...leaseParams(l,now)]}
      ]); return success;
    },
    async recoverInterrupted(l,now) {
      const c=await db.atomic([lock(),leaseLock(l,now),{sql:`UPDATE outbox SET phase='uncertain',code='interrupted',updated_at=? WHERE phase='sending' AND (claim_fence<>? OR NOT (${current})) AND ${leaseGuard}`,params:[now,l.fence,...leaseParams(l,now)]},{sql:`UPDATE alerts SET pending_trigger_id=NULL,updated_at=? WHERE pending_trigger_id IS NOT NULL AND EXISTS(SELECT 1 FROM outbox o WHERE o.trigger_id=alerts.pending_trigger_id AND o.user_id=alerts.user_id AND o.phase='uncertain') AND ${leaseGuard}`,params:[now,...leaseParams(l,now)]}]); return c[2]??0;
    }
  };
  const settingsRepo: Repositories['settings'] = {
    get:getSettings,
    async initialize(userId,now) {
      await db.execute('INSERT INTO user_settings(user_id,enabled,disabled,generation,daily_limit,notification_json,created_at,updated_at) SELECT id,0,0,0,?,?,?,? FROM "user" WHERE id=? ON CONFLICT(user_id) DO NOTHING',[limits.dailyNotificationAttempts,JSON.stringify(DEFAULT_NOTIFICATION),now,now,userId]);
      const r=await getSettings(userId); if(!r) throw new RepositoryConflict('not_found'); return r;
    },
    async patch(userId,generation,patch,now) {
      const old=await getSettings(userId); if(!old) throw new RepositoryConflict('not_found'); const merged={enabled:old.enabled,dailyLimit:old.dailyLimit,notification:old.notification,...patch};
      if(typeof merged.enabled!=='boolean'||!Number.isSafeInteger(merged.dailyLimit)||merged.dailyLimit<1||merged.dailyLimit>limits.dailyNotificationAttempts) throw new TypeError('Invalid settings'); merged.notification=notificationOptionsSchema.parse(merged.notification);
      const disable=patch.enabled===false;
      const s:CAS[]= [lock(),statement(`UPDATE user_settings SET enabled=?,daily_limit=?,notification_json=?,generation=generation+1,updated_at=? WHERE user_id=? AND generation=? AND ${disable?'1=1':pending}`,[+merged.enabled,merged.dailyLimit,JSON.stringify(merged.notification),now,userId,generation])];
      if(disable) s.push(...cancelStatements(userId,now));
      if(!await db.atomicCAS(s)) await settingsConflict(userId,generation);
      return (await getSettings(userId))!;
    },
    async dailyUsage(userId,now) { const r=await rows('SELECT attempts FROM daily_usage WHERE user_id=? AND utc_date=?',[userId,utc(now)]); return {date:utc(now),attempts:r[0]?.attempts??0}; }
  };
  function cancelStatements(userId:string,now:number):CAS[] {
    return [{sql:"UPDATE outbox SET phase='cancelled',code='monitoring_disabled',updated_at=? WHERE user_id=? AND phase='queued' AND EXISTS(SELECT 1 FROM user_settings WHERE user_id=? AND (enabled=0 OR disabled=1))",params:[now,userId,userId]},{sql:"UPDATE alerts SET pending_trigger_id=NULL,updated_at=? WHERE user_id=? AND pending_trigger_id IS NOT NULL AND EXISTS(SELECT 1 FROM outbox o WHERE o.user_id=alerts.user_id AND o.trigger_id=alerts.pending_trigger_id AND o.phase='cancelled')",params:[now,userId]}];
  }
  const channels:Repositories['channels']={
    get:getChannel,
    async put(userId,generation,userKey,privateToken,now) {
      const old=await getChannel(userId); const key=enc(userKey), token=privateToken===undefined?(old?.privateAppToken?enc(old.privateAppToken):null):privateToken===null?null:enc(privateToken);
      const s:CAS[]=[lock(),statement(`UPDATE user_settings SET updated_at=updated_at WHERE user_id=? AND disabled=0 AND ${pending}`,[userId])];
      if(generation===null) {
        // Versions survive credential deletion; a recreated channel cannot match an obsolete snapshot.
        s.push(statement('INSERT INTO channel_versions(user_id,generation) VALUES(?,0) ON CONFLICT(user_id) DO UPDATE SET generation=channel_versions.generation+1',[userId]));
        s.push(statement('INSERT INTO channels(user_id,generation,user_key_json,private_token_json,updated_at) SELECT user_id,generation,?,?,? FROM channel_versions WHERE user_id=?',[key,token,now,userId]));
      } else {
        s.push(statement('UPDATE channels SET generation=generation+1,user_key_json=?,private_token_json=?,updated_at=? WHERE user_id=? AND generation=?',[key,token,now,userId,generation]));
        s.push(statement('UPDATE channel_versions SET generation=generation+1 WHERE user_id=? AND generation=?',[userId,generation]));
      }
      try { if(!await db.atomicCAS(s)) { if(await userPending(userId)) throw new RepositoryConflict('pending_delivery'); if(!await getSettings(userId)) throw new RepositoryConflict('not_found'); throw new RepositoryConflict('generation_conflict'); } }
      catch(e) { if(generation===null && /UNIQUE|duplicate key/i.test(String(e))) throw new RepositoryConflict('generation_conflict'); throw e; }
      return (await getChannel(userId))!;
    },
    async remove(userId,generation,now) {
      if(!await db.atomicCAS([lock(),statement(`UPDATE user_settings SET updated_at=updated_at WHERE user_id=? AND ${pending}`,[userId]),statement('DELETE FROM channels WHERE user_id=? AND generation=?',[userId,generation]),statement('UPDATE channel_versions SET generation=generation+1 WHERE user_id=? AND generation=?',[userId,generation])])) { if(await userPending(userId)) throw new RepositoryConflict('pending_delivery'); if(!await getChannel(userId)) throw new RepositoryConflict('not_found'); throw new RepositoryConflict('generation_conflict'); }
    }
  };
  async function identity(userId:string):Promise<UserIdentity|null> { const r=await rows('SELECT u.id,u.email,u.name,u.role,COALESCE(s.disabled,0) AS disabled FROM "user" u LEFT JOIN user_settings s ON s.user_id=u.id WHERE u.id=?',[userId]); return r[0]?{id:r[0].id,email:r[0].email,name:r[0].name,role:r[0].role==='admin'?'admin':'user',disabled:!!r[0].disabled}:null; }
  const admin:Repositories['admin']={
    async bootstrap(userId,now) {
      return db.atomicCAS([lock(),statement(`UPDATE app_meta SET value='1' WHERE key='bootstrap-consumed' AND value='0' AND NOT EXISTS(SELECT 1 FROM "user" WHERE role='admin') AND EXISTS(SELECT 1 FROM "user" u JOIN user_settings s ON s.user_id=u.id WHERE u.id=? AND s.disabled=0)`,[userId]),statement('UPDATE "user" SET role=\'admin\' WHERE id=?',[userId])]);
    },
    async listUsers(limit,cursor) { pageLimit(limit); const r=await rows('SELECT u.id,u.email,u.name,u.role,COALESCE(s.disabled,0) AS disabled FROM "user" u LEFT JOIN user_settings s ON s.user_id=u.id WHERE u.id>? ORDER BY u.id LIMIT ?',[cursor??'',limit+1]); const items:UserIdentity[]=r.slice(0,limit).map(v=>({id:v.id,email:v.email,name:v.name,role:v.role==='admin'?'admin':'user',disabled:!!v.disabled})); return {items,cursor:r.length>limit?items.at(-1)!.id:null}; },
    async setDisabled(userId,disabled,now) {
      await settingsRepo.initialize(userId,now);
      const changes=await db.atomic([lock(),{sql:'UPDATE user_settings SET disabled=?,enabled=CASE WHEN ?=1 THEN 0 ELSE enabled END,generation=generation+1,updated_at=? WHERE user_id=?',params:[+disabled,+disabled,now,userId]},...(disabled?[{sql:'DELETE FROM "session" WHERE user_id=?',params:[userId]}]:[]),{sql:"UPDATE outbox SET phase='cancelled',code='user_disabled',updated_at=? WHERE user_id=? AND phase='queued' AND EXISTS(SELECT 1 FROM user_settings WHERE user_id=? AND disabled=1)",params:[now,userId,userId]},{sql:"UPDATE alerts SET pending_trigger_id=NULL,updated_at=? WHERE user_id=? AND pending_trigger_id IS NOT NULL AND EXISTS(SELECT 1 FROM outbox o WHERE o.trigger_id=alerts.pending_trigger_id AND o.user_id=alerts.user_id AND o.phase='cancelled')",params:[now,userId]}]);
      if(!changes[1]) throw new RepositoryConflict('not_found'); return (await identity(userId))!;
    },
    async createInvitation(email,expiresAt,now) {
      email=email.trim().toLowerCase(); if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>254||!Number.isSafeInteger(expiresAt)||expiresAt<=now) throw new TypeError('Invalid invitation'); const id=crypto.randomUUID();
      try { const ok=await db.atomicCAS([lock(),statement('INSERT INTO invitations(id,email,expires_at) SELECT ?,?,? WHERE (SELECT COUNT(*) FROM "user")<? AND NOT EXISTS(SELECT 1 FROM "user" WHERE LOWER(email)=?)',[id,email,expiresAt,limits.users,email])]); if(!ok) throw new RepositoryConflict('limit_exceeded'); }
      catch(e) { if(/UNIQUE|duplicate key/i.test(String(e))) { const old=await rows('SELECT id,expires_at FROM invitations WHERE email=? AND consumed_by IS NULL',[email]); if(old[0]&&old[0].expires_at>now) {
        const valid=await db.atomicCAS([lock(),statement('UPDATE invitations SET expires_at=expires_at WHERE id=? AND consumed_by IS NULL AND expires_at=? AND expires_at>? AND (SELECT COUNT(*) FROM "user")<? AND NOT EXISTS(SELECT 1 FROM "user" WHERE LOWER(email)=?)',[old[0].id,old[0].expires_at,now,limits.users,email])]);
        if(!valid)throw new RepositoryConflict('generation_conflict');
        return {id:old[0].id,email,expiresAt:old[0].expires_at,consumedBy:null,consumedAt:null,reused:true};
      } if(old[0]&&old[0].expires_at<=now) { const renewed=await db.atomicCAS([lock(),statement('UPDATE invitations SET expires_at=? WHERE id=? AND consumed_by IS NULL AND expires_at=? AND expires_at<=? AND (SELECT COUNT(*) FROM "user")<? AND NOT EXISTS(SELECT 1 FROM "user" WHERE LOWER(email)=?)',[expiresAt,old[0].id,old[0].expires_at,now,limits.users,email])]); if(!renewed) throw new RepositoryConflict('generation_conflict'); return {id:old[0].id,email,expiresAt,consumedBy:null,consumedAt:null,reused:false}; } throw new RepositoryConflict('generation_conflict'); } throw e; }
      return {id,email,expiresAt,consumedBy:null,consumedAt:null,reused:false};
    },
    async getInvitation(email,now) { const r=await rows('SELECT * FROM invitations WHERE email=? AND consumed_by IS NULL AND expires_at>?',[email.trim().toLowerCase(),now]); return r[0]?{id:r[0].id,email:r[0].email,expiresAt:r[0].expires_at,consumedBy:null,consumedAt:null}:null; },
    async listInvitations(limit,cursor) {
      pageLimit(limit);
      const records=await rows('SELECT * FROM invitations WHERE id>? ORDER BY id LIMIT ?',[cursor??'',limit+1]);
      const items=records.slice(0,limit).map(r=>({id:r.id,email:r.email,expiresAt:r.expires_at,consumedBy:r.consumed_by??null,consumedAt:r.consumed_at??null}));
      return {items,cursor:records.length>limit?items.at(-1)!.id:null};
    },
    async getInvitationById(id) {
      const r=(await rows('SELECT * FROM invitations WHERE id=?',[id]))[0];
      return r?{id:r.id,email:r.email,expiresAt:r.expires_at,consumedBy:r.consumed_by??null,consumedAt:r.consumed_at??null}:null;
    },
    async revokeInvitation(id,expectedExpiresAt,now) {
      // Zero expiry records a revoked invitation without deleting its admission history.
      if(!await db.atomicCAS([lock(),statement('UPDATE invitations SET expires_at=0 WHERE id=? AND expires_at=? AND expires_at>? AND consumed_by IS NULL',[id,expectedExpiresAt,now])])) throw new RepositoryConflict('generation_conflict');
    },
    async consumeInvitation(id,userId,now) { return db.atomicCAS([lock(),statement('UPDATE invitations SET consumed_by=?,consumed_at=? WHERE id=? AND consumed_by IS NULL AND expires_at>? AND EXISTS(SELECT 1 FROM "user" WHERE id=? AND LOWER(email)=invitations.email) AND (SELECT COUNT(*) FROM "user")<=?',[userId,now,id,now,userId,limits.users])]); },
    async counts() { const r=await rows('SELECT (SELECT COUNT(*) FROM "user" u LEFT JOIN user_settings s ON s.user_id=u.id WHERE COALESCE(s.disabled,0)=0) AS users,(SELECT COUNT(*) FROM alerts WHERE enabled=1 AND deleted_at IS NULL) AS alerts'); return {activeUsers:r[0]!.users,activeAlerts:r[0]!.alerts}; }
  };
  const tests:Repositories['tests']={
    async claim(userId,channelGeneration,settingsGeneration,now) {
      const id=crypto.randomUUID(),claimId=crypto.randomUUID();
      // An idle Worker may have no scheduler lease to repair a crashed test request.
      // Retain its consumed quota and uncertainty; only this owner's stale claim is retired.
      await db.execute("UPDATE test_notifications SET phase='uncertain',code='interrupted',updated_at=? WHERE user_id=? AND phase='sending' AND created_at<?",[now,userId,now-RUNTIME_POLICY.requestTimeoutMs-5000]);
      const ok=await db.atomicCAS([lock(),...usageInit(userId,now),statement(`INSERT INTO test_notifications(id,user_id,channel_generation,settings_generation,claim_id,phase,created_at,updated_at) SELECT ?,?,?,?,?,'sending',?,? WHERE EXISTS(SELECT 1 FROM user_settings s JOIN channels c ON c.user_id=s.user_id WHERE s.user_id=? AND s.disabled=0 AND s.generation=? AND c.generation=? AND (SELECT d.attempts FROM daily_usage d WHERE d.user_id=s.user_id AND d.utc_date=?)<s.daily_limit AND (SELECT d.attempts FROM daily_usage d WHERE d.user_id=s.user_id AND d.utc_date=?)<?) AND (SELECT attempts FROM global_daily_usage WHERE utc_date=?)<? AND NOT EXISTS(SELECT 1 FROM test_notifications WHERE user_id=? AND (phase='sending' OR created_at>?))`,[id,userId,channelGeneration,settingsGeneration,claimId,now,now,userId,settingsGeneration,channelGeneration,utc(now),utc(now),limits.dailyNotificationAttempts,utc(now),globalLimit,userId,now-10000]),statement('UPDATE daily_usage SET attempts=attempts+1,updated_at=? WHERE user_id=? AND utc_date=? AND EXISTS(SELECT 1 FROM test_notifications WHERE id=? AND user_id=? AND claim_id=?)',[now,userId,utc(now),id,userId,claimId]),statement('UPDATE global_daily_usage SET attempts=attempts+1,updated_at=? WHERE utc_date=? AND EXISTS(SELECT 1 FROM test_notifications WHERE id=? AND user_id=? AND claim_id=?)',[now,utc(now),id,userId,claimId])]);
      if(!ok) return null; const r=await rows('SELECT * FROM test_notifications WHERE id=? AND user_id=?',[id,userId]); return test(r[0]!);
    },
    async finish(userId,id,claimId,outcome,code,now) { if(!['sent','failed','uncertain'].includes(outcome)) throw new TypeError('Invalid test outcome'); return (await db.execute("UPDATE test_notifications SET phase=?,code=?,updated_at=? WHERE id=? AND user_id=? AND claim_id=? AND phase='sending'",[outcome,code,now,id,userId,claimId])).changes===1; },
    async recoverInterrupted(now) { return (await db.execute("UPDATE test_notifications SET phase='uncertain',code='interrupted',updated_at=? WHERE phase='sending' AND created_at<?",[now,now-RUNTIME_POLICY.requestTimeoutMs-5000])).changes; }
  };
  return {alerts,scheduler,settings:settingsRepo,channels,admin,tests,outbox:{
    async lastForAlert(userId,alertId) { const r=await rows("SELECT * FROM outbox WHERE user_id=? AND alert_id=? AND phase NOT IN('queued','sending') ORDER BY generation DESC LIMIT 1",[userId,alertId]); return r[0]?outbox(r[0]):null; },
    async getForUser(userId,id) { const r=await rows('SELECT * FROM outbox WHERE user_id=? AND trigger_id=?',[userId,id]); return r[0]?outbox(r[0]):null; },
    async listForUser(userId,limit,cursor) { const r=await rows('SELECT * FROM outbox WHERE user_id=? AND trigger_id>? ORDER BY trigger_id LIMIT ?',[userId,cursor??'',pageLimit(limit)+1]); const items=r.slice(0,limit).map(outbox); return {items,cursor:r.length>limit?items.at(-1)!.triggerId:null}; }
  }};
}
