import { z } from 'zod';
import type { AppConfig } from '../config.js';
import type { ChannelRecord, Repositories, SqlDatabase } from '../contracts/db.js';
import type { EncryptedSecret, NotificationOptions } from '../contracts/domain.js';
import { notificationOptionsSchema } from '../contracts/domain.js';
import { decryptSecret, encryptSecret } from './crypto.js';
import { boundedJson } from './http.js';
import type { Fetch } from './http.js';
import { NotificationError, sendPushover, validatePushoverChannel } from './pushover.js';

export const ROUTABLE_SOURCES = ['price_alert', 'anomaly_crypto', 'anomaly_tradfi'] as const;
export const ALL_SOURCES = ROUTABLE_SOURCES;
export type RoutableSource = typeof ROUTABLE_SOURCES[number];
export type NotifySource = typeof ALL_SOURCES[number];
export const MAX_CHANNELS = 10;
export const TEST_INTERVAL_MS = 30_000;

export interface HubMessage { title: string; body: string; url?: string; severity: 'info' | 'warning' | 'critical' }
export type SendOutcome = { outcome: 'sent' | 'failed' | 'uncertain' | 'skipped'; code: string | null };
export interface AdapterContext { fetch?: Fetch; timeoutMs: number; sharedPushoverAppToken: string | undefined }
/** One provider (Pushover now; Telegram, Discord, DingTalk, QQ, WeCom later). Config is the decrypted credential object. */
export interface ChannelAdapter<C = unknown> {
  type: string;
  configSchema: z.ZodType<C>;
  validate(config: C, ctx: AdapterContext): Promise<void>;
  send(config: C, message: HubMessage, options: NotificationOptions, ctx: AdapterContext): Promise<SendOutcome>;
  /** Safe, non-secret description for the UI. */
  summary(config: C, ctx: AdapterContext): Record<string, string | boolean>;
}

const pushoverConfigSchema = z.strictObject({ userKey: z.string().regex(/^[A-Za-z0-9]{30}$/), appToken: z.string().regex(/^[A-Za-z0-9]{30}$/).nullable() });
type PushoverConfig = z.infer<typeof pushoverConfigSchema>;
function pushoverToken(config: PushoverConfig, ctx: AdapterContext) {
  const token = config.appToken ?? ctx.sharedPushoverAppToken;
  if (!token) throw new NotificationError('channel_unconfigured');
  return token;
}
export const pushoverAdapter: ChannelAdapter<PushoverConfig> = {
  type: 'pushover',
  configSchema: pushoverConfigSchema,
  async validate(config, ctx) {
    const result = await validatePushoverChannel({ userKey: config.userKey, appToken: pushoverToken(config, ctx) }, { ...(ctx.fetch ? { fetch: ctx.fetch } : {}), timeoutMs: ctx.timeoutMs });
    if (!result.valid) throw new NotificationError('provider_rejected');
  },
  async send(config, message, options, ctx) {
    let token: string;
    try { token = pushoverToken(config, ctx); } catch { return { outcome: 'skipped', code: 'channel_unconfigured' }; }
    const body = message.url && [...message.body].length + message.url.length + 1 <= 1024 ? `${message.body}\n${message.url}` : message.body;
    try {
      const result = await sendPushover({ userKey: config.userKey, appToken: token }, [...body].slice(0, 1024).join(''), [...message.title].slice(0, 250).join(''), options, { ...(ctx.fetch ? { fetch: ctx.fetch } : {}), timeoutMs: ctx.timeoutMs });
      return { outcome: result.outcome, code: result.code };
    } catch { return { outcome: 'failed', code: 'notification_input_invalid' }; }
  },
  summary(config, ctx) { return { tokenSource: config.appToken ? 'private' : ctx.sharedPushoverAppToken ? 'shared' : 'missing', userKey: `…${config.userKey.slice(-4)}` }; },
};
const discordConfig = z.strictObject({ webhookUrl: z.string().regex(/^https:\/\/(?:discord\.com|discordapp\.com)\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+$/) });
export const discordAdapter: ChannelAdapter<z.infer<typeof discordConfig>> = {
  type: 'discord', configSchema: discordConfig,
  async validate(c, ctx) {
    const r = await boundedJson(c.webhookUrl, { method: 'GET' }, { ...ctx, maxBytes: 32768 });
    if (r.status !== 200 || !r.data || typeof r.data !== 'object' || !('id' in r.data)) throw new NotificationError('provider_rejected');
  },
  async send(c, m, options, ctx) {
    try {
      const r = await boundedJson(c.webhookUrl + '?wait=true', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'Open Alert', ...(options.priority === -2 ? {flags:4096} : {}), allowed_mentions: { parse: [] }, embeds: [{ title: m.title.slice(0, 256), description: m.body.slice(0, 4096), ...(m.url ? { url: m.url } : {}), color: m.severity === 'critical' ? 0xe55b65 : m.severity === 'warning' ? 0xe9ac63 : 0xb6d657 }] }) }, { ...ctx, maxBytes: 65536 });
      if (r.status === 200 && r.data && typeof r.data === 'object' && 'id' in r.data) return { outcome: 'sent', code: null };
      return r.status >= 400 && r.status < 500 ? { outcome: 'failed', code: 'provider_rejected' } : { outcome: 'uncertain', code: 'provider_response_uncertain' };
    } catch { return { outcome: 'uncertain', code: 'provider_transport_uncertain' }; }
  },
  summary(c) { return { webhook: '…' + c.webhookUrl.split('/')[5]?.slice(-6) }; },
};
export const ADAPTERS: Readonly<Record<string, ChannelAdapter<any>>> = Object.freeze({ pushover: pushoverAdapter, discord: discordAdapter });
export const CHANNEL_TYPES = Object.keys(ADAPTERS);

/** Per-route delivery options. `notification: null` follows the source's existing profile. */
const hhmm = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
export const quietHoursSchema = z.strictObject({ from: hhmm, to: hhmm, offsetMinutes: z.number().int().min(-720).max(840) }).refine(q => q.from !== q.to);
export const routeOptionsSchema = z.strictObject({ notification: notificationOptionsSchema.nullable(), quiet: quietHoursSchema.nullable(), dailyLimit: z.number().int().min(1).max(50).default(10) });
export type RouteOptions = z.infer<typeof routeOptionsSchema>;
export const DEFAULT_ROUTE_OPTIONS: RouteOptions = Object.freeze({ notification: null, quiet: null, dailyLimit: 10 }) as RouteOptions;
const minutesOf = (v: string) => Number(v.slice(0, 2)) * 60 + Number(v.slice(3));
/** Quiet window in the user's clock; wraps midnight when `from` > `to`. */
export function inQuietHours(quiet: RouteOptions['quiet'], at: number): boolean {
  if (!quiet) return false;
  const local = ((Math.floor(at / 60_000) + quiet.offsetMinutes) % 1440 + 1440) % 1440, from = minutesOf(quiet.from), to = minutesOf(quiet.to);
  return from < to ? local >= from && local < to : local >= from || local < to;
}

export interface HubChannel {
  id: string; type: string; name: string; enabled: boolean; legacy: boolean; generation: number;
  lastOutcome: string | null; lastCode: string | null; lastAt: number | null; updatedAt: number;
}
export interface HubDelivery { id: string; at: number; source: string; channelName: string; title: string; outcome: string; code: string | null }
export interface HubRoute { source: NotifySource; channelId: string; enabled: boolean; options: RouteOptions }
export class HubError extends Error { constructor(readonly code: 'not_found' | 'generation_conflict' | 'limit_exceeded' | 'invalid_request' | 'rate_limited' | 'channel_unconfigured' | 'notification_failed') { super(code); this.name = 'HubError'; } }
interface ChannelRow { id: string; user_id: string; type: string; name: string; enabled: number; legacy: number; config_json: string | null; generation: number; last_outcome: string | null; last_code: string | null; last_at: number | null; test_at: number | null; updated_at: number }
const channelOf = (r: ChannelRow): HubChannel => ({ id: r.id, type: r.type, name: r.name, enabled: r.enabled === 1, legacy: r.legacy === 1, generation: r.generation, lastOutcome: r.last_outcome, lastCode: r.last_code, lastAt: r.last_at, updatedAt: r.updated_at });
const legacyId = (userId: string) => `legacy-pushover:${userId}`;

/** Node-only tables, outside the shared ledger for the same reason as the anomaly tables (D1 readiness checksums). */
export async function ensureHubSchema(db: SqlDatabase): Promise<void> {
  const int = db.driver === 'postgres' ? 'BIGINT' : 'INTEGER';
  await db.atomic([
    { sql: `CREATE TABLE IF NOT EXISTS notify_channels (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES "user"(id), type TEXT NOT NULL, name TEXT NOT NULL, enabled ${int} NOT NULL CHECK(enabled IN(0,1)), legacy ${int} NOT NULL CHECK(legacy IN(0,1)), config_json TEXT, generation ${int} NOT NULL CHECK(generation>=0), last_outcome TEXT, last_code TEXT, last_at ${int}, test_at ${int}, created_at ${int} NOT NULL, updated_at ${int} NOT NULL)` },
    { sql: `CREATE TABLE IF NOT EXISTS notify_deliveries (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, at ${int} NOT NULL, source TEXT NOT NULL, channel_id TEXT NOT NULL, channel_name TEXT NOT NULL, title TEXT NOT NULL, outcome TEXT NOT NULL, code TEXT, event_key TEXT)` },
    { sql: 'CREATE INDEX IF NOT EXISTS notify_deliveries_user ON notify_deliveries(user_id,at)' },
    { sql: 'CREATE UNIQUE INDEX IF NOT EXISTS notify_delivery_event ON notify_deliveries(user_id,channel_id,event_key)' },
    { sql: 'CREATE INDEX IF NOT EXISTS notify_channels_user ON notify_channels(user_id)' },
    { sql: `CREATE TABLE IF NOT EXISTS notify_routes (user_id TEXT NOT NULL REFERENCES "user"(id), source TEXT NOT NULL, channel_id TEXT NOT NULL REFERENCES notify_channels(id) ON DELETE CASCADE, enabled ${int} NOT NULL CHECK(enabled IN(0,1)), options_json TEXT NOT NULL, PRIMARY KEY(user_id,source,channel_id))` },
  ]);
}

export interface HubOptions {
  db: SqlDatabase; config: AppConfig; repositories: Pick<Repositories, 'channels' | 'settings'>;
  fetch?: Fetch; now?: () => number; adapters?: Readonly<Record<string, ChannelAdapter<any>>>;
}
export function createNotifyHub(options: HubOptions) {
  const { db, config, repositories } = options, now = options.now ?? Date.now, adapters = options.adapters ?? ADAPTERS;
  const ctx: AdapterContext = { ...(options.fetch ? { fetch: options.fetch } : {}), timeoutMs: config.runtime.requestTimeoutMs, sharedPushoverAppToken: config.sharedPushoverAppToken };
  const rows = (userId: string) => db.query<ChannelRow>('SELECT * FROM notify_channels WHERE user_id=? ORDER BY legacy DESC,created_at,id', [userId]);
  async function row(userId: string, id: string) { const r = (await db.query<ChannelRow>('SELECT * FROM notify_channels WHERE user_id=? AND id=?', [userId, id]))[0]; if (!r) throw new HubError('not_found'); return r; }

  /** Convert existing credentials once. Durable markers prevent deleted channels from reappearing. */
  async function ensureUser(userId: string) {
    const marker = 'notify-migrated:' + userId;
    const existing=await rows(userId);
    if(existing.length && !existing.some(r=>r.legacy===1) && (await db.query('SELECT key FROM app_meta WHERE key=?',['notify-price:'+userId])).length) return;
    if (existing.length) {
      // Phase-one rows use linked credentials; convert them once before exposing normal editing.
      for (const r of await rows(userId)) if (r.legacy === 1) {
        const c = await config_(userId, r);
        if (c) await db.execute('UPDATE notify_channels SET legacy=0,config_json=? WHERE id=? AND legacy=1', [JSON.stringify(await encryptSecret(config.encryptionKey,userId,'channelConfig',JSON.stringify(c))),r.id]);
      }
      await db.execute("INSERT INTO app_meta(key,value) VALUES(?,'1') ON CONFLICT(key) DO NOTHING",[marker]);
      await db.execute("INSERT INTO notify_routes(user_id,source,channel_id,enabled,options_json) SELECT user_id,'price_alert',id,1,? FROM notify_channels WHERE user_id=? AND id=? AND NOT EXISTS(SELECT 1 FROM app_meta WHERE key=?) ON CONFLICT(user_id,source,channel_id) DO NOTHING",[JSON.stringify(DEFAULT_ROUTE_OPTIONS),userId,legacyId(userId),'notify-price:'+userId]);
      await db.execute("INSERT INTO app_meta(key,value) VALUES(?,'1') ON CONFLICT(key) DO NOTHING",['notify-price:'+userId]);
      return;
    }
    if ((await db.query('SELECT key FROM app_meta WHERE key=?',[marker])).length) return;
    const legacy = await repositories.channels.get(userId);
    if (legacy) {
      const c = { userKey: await decryptSecret(config.encryptionKey,userId,'userKey',legacy.userKey), appToken: legacy.privateAppToken ? await decryptSecret(config.encryptionKey,userId,'appToken',legacy.privateAppToken) : null };
      const id=legacyId(userId), at=now(), sealed=JSON.stringify(await encryptSecret(config.encryptionKey,userId,'channelConfig',JSON.stringify(c)));
      await db.atomic([{sql:'INSERT INTO notify_channels(id,user_id,type,name,enabled,legacy,config_json,generation,created_at,updated_at) VALUES(?,?,?,?,1,0,?,0,?,?) ON CONFLICT(id) DO NOTHING',params:[id,userId,'pushover','Pushover',sealed,at,at]},...ROUTABLE_SOURCES.map(source=>({sql:'INSERT INTO notify_routes(user_id,source,channel_id,enabled,options_json) VALUES(?,?,?,1,?) ON CONFLICT(user_id,source,channel_id) DO NOTHING',params:[userId,source,id,JSON.stringify(DEFAULT_ROUTE_OPTIONS)]}))]);
    }
    await db.execute("INSERT INTO app_meta(key,value) VALUES(?,'1') ON CONFLICT(key) DO NOTHING",[marker]);
    await db.execute("INSERT INTO app_meta(key,value) VALUES(?,'1') ON CONFLICT(key) DO NOTHING",['notify-price:'+userId]);
  }
  async function migrateLegacy(): Promise<number> {
    const users=await db.query<{user_id:string}>('SELECT user_id FROM channels');
    for(const r of users) await ensureUser(r.user_id);
    return users.length;
  }
  async function config_(userId: string, r: ChannelRow): Promise<unknown | null> {
    if (r.legacy === 1) {
      const legacy: ChannelRecord | null = await repositories.channels.get(userId);
      if (!legacy) return null;
      const userKey = await decryptSecret(config.encryptionKey, userId, 'userKey', legacy.userKey);
      const appToken = legacy.privateAppToken ? await decryptSecret(config.encryptionKey, userId, 'appToken', legacy.privateAppToken) : null;
      return { userKey, appToken };
    }
    if (!r.config_json) return null;
    const plain = await decryptSecret(config.encryptionKey, userId, 'channelConfig', JSON.parse(r.config_json) as EncryptedSecret);
    const parsed = adapters[r.type]?.configSchema.safeParse(JSON.parse(plain));
    return parsed?.success ? parsed.data : null;
  }
  async function describe(userId: string, r: ChannelRow) {
    let configured = false, summary: Record<string, string | boolean> = {};
    try { const c = await config_(userId, r), adapter = adapters[r.type]; if (c && adapter) { summary = adapter.summary(c, ctx); configured = summary.tokenSource !== 'missing'; } } catch { /* unreadable credentials read as unconfigured */ }
    return { ...channelOf(r), configured, summary };
  }
  async function channels(userId: string) { await ensureUser(userId); return Promise.all((await rows(userId)).map(r => describe(userId, r))); }

  async function sealed(userId: string, type: string, raw: unknown): Promise<string> {
    const adapter = adapters[type];
    if (!adapter) throw new HubError('invalid_request');
    const parsed = adapter.configSchema.safeParse(raw);
    if (!parsed.success) throw new HubError('invalid_request');
    try { await adapter.validate(parsed.data, ctx); } catch (error) { throw new HubError(error instanceof NotificationError && error.code === 'channel_unconfigured' ? 'channel_unconfigured' : 'notification_failed'); }
    return JSON.stringify(await encryptSecret(config.encryptionKey, userId, 'channelConfig', JSON.stringify(parsed.data)));
  }
  async function createChannel(userId: string, input: { type: string; name: string; config: unknown }) {
    await ensureUser(userId);
    if ((await rows(userId)).length >= MAX_CHANNELS) throw new HubError('limit_exceeded');
    const sealedConfig = await sealed(userId, input.type, input.config), at = now(), id = crypto.randomUUID();
    await db.execute('INSERT INTO notify_channels(id,user_id,type,name,enabled,legacy,config_json,generation,created_at,updated_at) VALUES(?,?,?,?,1,0,?,0,?,?)', [id, userId, input.type, input.name, sealedConfig, at, at]);
    return describe(userId, await row(userId, id));
  }
  async function patchChannel(userId: string, id: string, expectedGeneration: number, patch: { name?: string; enabled?: boolean; config?: unknown }) {
    const current = await row(userId, id);
    if (current.generation !== expectedGeneration) throw new HubError('generation_conflict');

    const nextConfig = patch.config === undefined ? current.config_json : await sealed(userId, current.type, patch.config);
    const result = await db.execute('UPDATE notify_channels SET name=?,enabled=?,config_json=?,generation=generation+1,updated_at=? WHERE user_id=? AND id=? AND generation=?',
      [patch.name ?? current.name, (patch.enabled ?? current.enabled === 1) ? 1 : 0, nextConfig, now(), userId, id, expectedGeneration]);
    if (result.changes !== 1) throw new HubError('generation_conflict');
    return describe(userId, await row(userId, id));
  }
  async function removeChannel(userId: string, id: string) {
    const current = await row(userId, id);

    await db.atomic([{ sql: 'DELETE FROM notify_routes WHERE user_id=? AND channel_id=?', params: [userId, id] }, { sql: 'DELETE FROM notify_channels WHERE user_id=? AND id=?', params: [userId, id] }]);
  }

  async function routes(userId: string): Promise<HubRoute[]> {
    await ensureUser(userId);
    const stored = (await db.query<{ source: RoutableSource; channel_id: string; enabled: number; options_json: string }>('SELECT source,channel_id,enabled,options_json FROM notify_routes WHERE user_id=? ORDER BY source,channel_id', [userId]))
      .map(r => { const o = routeOptionsSchema.safeParse(JSON.parse(r.options_json)); return { source: r.source, channelId: r.channel_id, enabled: r.enabled === 1, options: o.success ? o.data : DEFAULT_ROUTE_OPTIONS }; });
    return stored;
  }
  /** Replace every routable route in one transaction. Channels must belong to the user. */
  async function setRoutes(userId: string, list: readonly { source: RoutableSource; channelId: string; enabled: boolean; options: RouteOptions }[]) {
    await ensureUser(userId);
    const owned = new Set((await rows(userId)).map(r => r.id));
    if (list.some(r => !owned.has(r.channelId))) throw new HubError('not_found');
    await db.atomic([{ sql: 'DELETE FROM notify_routes WHERE user_id=?', params: [userId] },
      ...list.map(r => ({ sql: 'INSERT INTO notify_routes(user_id,source,channel_id,enabled,options_json) VALUES(?,?,?,?,?)', params: [userId, r.source, r.channelId, r.enabled ? 1 : 0, JSON.stringify(r.options)] }))]);
    return routes(userId);
  }

  async function record(userId: string, id: string, result: SendOutcome, test = false) {
    await db.execute(`UPDATE notify_channels SET last_outcome=?,last_code=?,last_at=?${test ? ',test_at=?' : ''} WHERE user_id=? AND id=?`, test ? [result.outcome, result.code, now(), now(), userId, id] : [result.outcome, result.code, now(), userId, id]);
  }
  async function sendVia(userId: string, r: ChannelRow, message: HubMessage, options: NotificationOptions): Promise<SendOutcome> {
    const adapter = adapters[r.type];
    if (!adapter) return { outcome: 'skipped', code: 'channel_type_unavailable' };
    let c: unknown;
    try { c = await config_(userId, r); } catch { return { outcome: 'failed', code: 'channel_unavailable' }; }
    if (!c) return { outcome: 'skipped', code: 'channel_unconfigured' };
    try { return await adapter.send(c, message, options, ctx); } catch { return { outcome: 'uncertain', code: 'provider_uncertain' }; }
  }
  async function deliveries(userId: string): Promise<HubDelivery[]> {
    return db.query<HubDelivery>('SELECT id,at,source,channel_name AS "channelName",title,outcome,code FROM notify_deliveries WHERE user_id=? ORDER BY at DESC,id LIMIT 100',[userId]);
  }
  async function log(userId:string,r:ChannelRow,source:string,message:HubMessage,result:SendOutcome,eventKey:string|null) {
    await db.execute('INSERT INTO notify_deliveries(id,user_id,at,source,channel_id,channel_name,title,outcome,code,event_key) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id,channel_id,event_key) DO UPDATE SET at=excluded.at,outcome=excluded.outcome,code=excluded.code',[crypto.randomUUID(),userId,now(),source,r.id,r.name,message.title.slice(0,250),result.outcome,result.code,eventKey]);
    await db.execute('DELETE FROM notify_deliveries WHERE user_id=? AND at<?',[userId,now()-30*86400000]);
  }
  async function dispatch(userId: string, sources: readonly RoutableSource[], message: HubMessage, fallback: NotificationOptions, eventKey?: string): Promise<SendOutcome & { channels: number }> {
    await ensureUser(userId);
    const all=await routes(userId), byId=new Map((await rows(userId)).map(r=>[r.id,r])), picked=new Map<string,HubRoute>();
    for(const source of sources) for(const route of all) if(route.source===source && route.enabled && !picked.has(route.channelId)) picked.set(route.channelId,route);
    const results:SendOutcome[]=[];
    await Promise.all([...picked].map(async ([id,route]) => {
      const r=byId.get(id); if(!r || r.enabled!==1) return;
      const previous=eventKey?(await db.query<{outcome:string;code:string|null}>('SELECT outcome,code FROM notify_deliveries WHERE user_id=? AND channel_id=? AND event_key=?',[userId,id,eventKey]))[0]:null;
      if(previous && previous.outcome!=='failed') { results.push({outcome:previous.outcome as SendOutcome['outcome'],code:previous.code}); return; }
      let result:SendOutcome;
      const count=(await db.query<{n:number}>("SELECT COUNT(*) AS n FROM notify_deliveries WHERE user_id=? AND channel_id=? AND source=? AND at>=? AND outcome<>'skipped'",[userId,id,route.source,Math.floor(now()/86400000)*86400000]))[0]?.n??0;
      if(inQuietHours(route.options.quiet,now())) result={outcome:'skipped',code:'quiet_hours'};
      else if(!previous && count>=route.options.dailyLimit) result={outcome:'skipped',code:'daily_limit'};
      else {
        // Persist ambiguous state before I/O: restart or a lost scheduler lease must never replay acceptance.
        if(eventKey) await log(userId,r,route.source,message,{outcome:'uncertain',code:'dispatch_interrupted'},eventKey);
        result=await sendVia(userId,r,message,route.options.notification??fallback);
      }
      await log(userId,r,route.source,message,result,eventKey??null);
      await record(userId,id,result); results.push(result);
    }));
    const failed=results.find(r=>r.outcome==='failed'), uncertain=results.find(r=>r.outcome==='uncertain'), sent=results.filter(r=>r.outcome==='sent').length;
    return {...(failed??uncertain??(sent?{outcome:'sent' as const,code:null}:results[0]??{outcome:'skipped' as const,code:'no_route'})),channels:sent};
  }
  async function test(userId: string, id: string): Promise<SendOutcome> {
    const r = await row(userId, id);
    if (r.test_at !== null && now() - r.test_at < TEST_INTERVAL_MS) throw new HubError('rate_limited');
    // Claim the test slot before dispatch so concurrent clicks cannot double-send.
    const claimed = await db.execute('UPDATE notify_channels SET test_at=? WHERE user_id=? AND id=? AND (test_at IS NULL OR test_at<=?)', [now(), userId, id, now() - TEST_INTERVAL_MS]);
    if (claimed.changes !== 1) throw new HubError('rate_limited');
    const result = await sendVia(userId, r, { title: 'Open Alert', body: 'Open Alert notification test', severity: 'info' }, { priority: 0, retry: 30, expire: 30, sound: 'pushover' });
    await log(userId,r,'test',{title:'Open Alert notification test',body:'',severity:'info'},result,null);
    await record(userId, id, result, true).catch(() => {});
    return result;
  }
  /** Whether any enabled, configured channel receives anomaly pushes. */
  async function anomalyReachable(userId: string, source?: NotifySource): Promise<boolean> {
    const list = await channels(userId), ready = new Set(list.filter(c => c.enabled && c.configured).map(c => c.id));
    return (await routes(userId)).some(r => (source ? r.source === source : r.source !== 'price_alert') && r.enabled && ready.has(r.channelId));
  }
  return { ensureUser, migrateLegacy, channels, createChannel, patchChannel, removeChannel, routes, setRoutes, dispatch, deliveries, test, anomalyReachable };
}
export type NotifyHub = ReturnType<typeof createNotifyHub>;
