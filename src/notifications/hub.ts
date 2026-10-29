import { z } from 'zod';
import type { AppConfig } from '../config.js';
import type { ChannelRecord, Repositories, SqlDatabase } from '../contracts/db.js';
import type { EncryptedSecret, NotificationOptions } from '../contracts/domain.js';
import { notificationOptionsSchema } from '../contracts/domain.js';
import { decryptSecret, encryptSecret } from './crypto.js';
import type { Fetch } from './http.js';
import { NotificationError, sendPushover, validatePushoverChannel } from './pushover.js';

/** Event sources a user can route. Price alerts still travel the durable outbox on the linked
 * Pushover channel (claim/fence guarantees); their route is listed read-only until that moves too. */
export const ROUTABLE_SOURCES = ['anomaly_crypto', 'anomaly_tradfi'] as const;
export const ALL_SOURCES = ['price_alert', ...ROUTABLE_SOURCES] as const;
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
export const ADAPTERS: Readonly<Record<string, ChannelAdapter<any>>> = Object.freeze({ pushover: pushoverAdapter });
export const CHANNEL_TYPES = Object.keys(ADAPTERS);

/** Per-route delivery options. `notification: null` follows the source's existing profile. */
const hhmm = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
export const quietHoursSchema = z.strictObject({ from: hhmm, to: hhmm, offsetMinutes: z.number().int().min(-720).max(840) }).refine(q => q.from !== q.to);
export const routeOptionsSchema = z.strictObject({ notification: notificationOptionsSchema.nullable(), quiet: quietHoursSchema.nullable() });
export type RouteOptions = z.infer<typeof routeOptionsSchema>;
export const DEFAULT_ROUTE_OPTIONS: RouteOptions = Object.freeze({ notification: null, quiet: null }) as RouteOptions;
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

  /** First touch per user: link the existing Pushover channel and route both anomaly sources to it, so
   * behaviour is unchanged. Runs once; afterwards the legacy row is the marker, even if routes are removed. */
  async function ensureUser(userId: string) {
    if ((await db.query('SELECT id FROM notify_channels WHERE user_id=? LIMIT 1', [userId])).length) return;
    const at = now(), id = legacyId(userId);
    await db.atomic([
      { sql: 'INSERT INTO notify_channels(id,user_id,type,name,enabled,legacy,config_json,generation,created_at,updated_at) VALUES(?,?,?,?,1,1,NULL,0,?,?) ON CONFLICT(id) DO NOTHING', params: [id, userId, 'pushover', 'Pushover', at, at] },
      ...ROUTABLE_SOURCES.map(source => ({ sql: 'INSERT INTO notify_routes(user_id,source,channel_id,enabled,options_json) VALUES(?,?,?,1,?) ON CONFLICT(user_id,source,channel_id) DO NOTHING', params: [userId, source, id, JSON.stringify(DEFAULT_ROUTE_OPTIONS)] })),
    ]);
  }
  /** Startup migration for every user who already has Pushover set up. Idempotent. */
  async function migrateLegacy(): Promise<number> {
    const users = await db.query<{ user_id: string }>('SELECT c.user_id FROM channels c WHERE NOT EXISTS(SELECT 1 FROM notify_channels n WHERE n.user_id=c.user_id)');
    for (const { user_id } of users) await ensureUser(user_id);
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
    // The linked channel's credentials stay on the Pushover page (legacy outbox depends on them).
    if (patch.config !== undefined && current.legacy === 1) throw new HubError('invalid_request');
    const nextConfig = patch.config === undefined ? current.config_json : await sealed(userId, current.type, patch.config);
    const result = await db.execute('UPDATE notify_channels SET name=?,enabled=?,config_json=?,generation=generation+1,updated_at=? WHERE user_id=? AND id=? AND generation=?',
      [patch.name ?? current.name, (patch.enabled ?? current.enabled === 1) ? 1 : 0, nextConfig, now(), userId, id, expectedGeneration]);
    if (result.changes !== 1) throw new HubError('generation_conflict');
    return describe(userId, await row(userId, id));
  }
  async function removeChannel(userId: string, id: string) {
    const current = await row(userId, id);
    if (current.legacy === 1) throw new HubError('invalid_request');
    await db.atomic([{ sql: 'DELETE FROM notify_routes WHERE user_id=? AND channel_id=?', params: [userId, id] }, { sql: 'DELETE FROM notify_channels WHERE user_id=? AND id=?', params: [userId, id] }]);
  }

  async function routes(userId: string): Promise<HubRoute[]> {
    await ensureUser(userId);
    const stored = (await db.query<{ source: RoutableSource; channel_id: string; enabled: number; options_json: string }>('SELECT source,channel_id,enabled,options_json FROM notify_routes WHERE user_id=? ORDER BY source,channel_id', [userId]))
      .map(r => { const o = routeOptionsSchema.safeParse(JSON.parse(r.options_json)); return { source: r.source, channelId: r.channel_id, enabled: r.enabled === 1, options: o.success ? o.data : DEFAULT_ROUTE_OPTIONS }; });
    // Price alerts: always the linked Pushover channel through the outbox, shown so the matrix is complete.
    return [{ source: 'price_alert', channelId: legacyId(userId), enabled: true, options: DEFAULT_ROUTE_OPTIONS }, ...stored];
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
  /** Fan one message out to every enabled channel routed from any of `sources`. A channel routed from
   * several sources receives it once, with the first source's options. `fallback` fills `notification: null`. */
  async function dispatch(userId: string, sources: readonly RoutableSource[], message: HubMessage, fallback: NotificationOptions): Promise<SendOutcome & { channels: number }> {
    await ensureUser(userId);
    const all = await routes(userId), byId = new Map((await rows(userId)).map(r => [r.id, r]));
    const picked = new Map<string, RouteOptions>();
    for (const source of sources) for (const route of all) if (route.source === source && route.enabled && !picked.has(route.channelId)) picked.set(route.channelId, route.options);
    const results: SendOutcome[] = [];
    for (const [id, opts] of picked) {
      const r = byId.get(id);
      if (!r || r.enabled !== 1) continue;
      if (inQuietHours(opts.quiet, now())) { results.push({ outcome: 'skipped', code: 'quiet_hours' }); continue; }
      const result = await sendVia(userId, r, message, opts.notification ?? fallback);
      results.push(result);
      await record(userId, id, result).catch(() => {});
    }
    const sent = results.filter(x => x.outcome === 'sent').length;
    const pick = (o: SendOutcome['outcome']) => results.find(x => x.outcome === o);
    const summary = sent ? { outcome: 'sent' as const, code: null } : pick('uncertain') ?? pick('failed') ?? pick('skipped') ?? { outcome: 'skipped' as const, code: 'no_route' };
    return { ...summary, channels: sent };
  }
  async function test(userId: string, id: string): Promise<SendOutcome> {
    const r = await row(userId, id);
    if (r.test_at !== null && now() - r.test_at < TEST_INTERVAL_MS) throw new HubError('rate_limited');
    // Claim the test slot before dispatch so concurrent clicks cannot double-send.
    const claimed = await db.execute('UPDATE notify_channels SET test_at=? WHERE user_id=? AND id=? AND (test_at IS NULL OR test_at<=?)', [now(), userId, id, now() - TEST_INTERVAL_MS]);
    if (claimed.changes !== 1) throw new HubError('rate_limited');
    const result = await sendVia(userId, r, { title: 'Open Alert', body: 'Open Alert notification test', severity: 'info' }, { priority: 0, retry: 30, expire: 30, sound: 'pushover' });
    await record(userId, id, result, true).catch(() => {});
    return result;
  }
  /** Whether any enabled, configured channel receives anomaly pushes. */
  async function anomalyReachable(userId: string): Promise<boolean> {
    const list = await channels(userId), ready = new Set(list.filter(c => c.enabled && c.configured).map(c => c.id));
    return (await routes(userId)).some(r => r.source !== 'price_alert' && r.enabled && ready.has(r.channelId));
  }
  return { ensureUser, migrateLegacy, channels, createChannel, patchChannel, removeChannel, routes, setRoutes, dispatch, test, anomalyReachable };
}
export type NotifyHub = ReturnType<typeof createNotifyHub>;
