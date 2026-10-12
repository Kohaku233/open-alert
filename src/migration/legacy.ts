import { z } from 'zod';
import { normalizeEmail } from '../auth/email.js';
import type { AppConfig } from '../config.js';
import type { SqlDatabase, SqlStatement, SqlValue } from '../contracts/db.js';
import { alertInputSchema, notificationOptionsSchema } from '../contracts/domain.js';
import { APP_MIGRATIONS } from '../db/migration-sources.js';
import { AUTH_MIGRATIONS } from '../auth/migration-sources.js';
import { migrationChecksum } from '../db/migrations.js';
import { encryptSecret } from '../notifications/crypto.js';

export const LEGACY_IDS = { upper: '00000000-0000-4000-8000-000000000001', lower: '00000000-0000-4000-8000-000000000002' } as const;
/** Scheduler listDue cannot select imported queued work until an explicit cutover. */
export const HELD_UNTIL = Number.MAX_SAFE_INTEGER;
export const MAX_LEGACY_BYTES = 2 * 1024 * 1024;
export const DEFAULT_MIGRATION_LIMITS: AppConfig['limits'] = Object.freeze({ users:1000, alertsPerUser:20, instrumentsPerUser:8, activeAlerts:2000, globalInstruments:200, dailyNotificationAttempts:20, globalNotificationAttempts:20000 });
export class LegacyMigrationError extends Error {
  constructor(public readonly code: string) { super(code); this.name = 'LegacyMigrationError'; }
}
function fail(code: string): never { throw new LegacyMigrationError(code); }
const id = z.string().min(1).max(200).regex(/^[A-Za-z0-9_.:-]+$/);
const epoch = z.number().int().min(0).max(8_640_000_000_000_000);
const generation = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1);
const price = z.number().positive().max(1e12);
const legacyName = z.string().min(1).refine(value => !!value.trim() && [...value].length <= 80);
const lastSchema = z.strictObject({
  id: id.optional(), outcome: z.enum(['sent','failed','expired','cancelled','uncertain','daily_limit']),
  at: epoch.optional(), attempts: z.number().int().min(0).max(3).optional(), code: z.string().max(200).nullable().optional(),
  receipt: z.null().optional(), generation: generation.optional(),
  instrument: alertInputSchema.shape.instrument.optional(), name: legacyName.optional(),
  side: alertInputSchema.shape.side.optional(), threshold: price.optional(), price: price.optional(),
  timestamp: epoch.optional(), createdAt: epoch.optional(), notification: notificationOptionsSchema.optional(),
});
const pendingSchema = z.strictObject({
  id, generation: generation.optional(), phase: z.enum(['queued','sending']), attempts: z.number().int().min(0).max(3),
  nextAt: epoch.optional(), createdAt: epoch.optional(), instrument: alertInputSchema.shape.instrument.optional(),
  name: legacyName.optional(), side: alertInputSchema.shape.side.optional(), threshold: price.optional(),
  price: price.optional(), timestamp: epoch.optional(), notification: notificationOptionsSchema.optional(),
});
const ruleSchema = z.strictObject({ generation, triggered: z.boolean().optional(), latched: z.boolean().optional(),
  pending: pendingSchema.nullable(), last: lastSchema.nullable() });
const alertSchema = ruleSchema.extend({ id, name: legacyName, instrument: alertInputSchema.shape.instrument.optional(),
  side: alertInputSchema.shape.side, threshold: price, enabled: z.boolean(), createdAt: epoch.optional(), updatedAt: epoch.optional() });
const configSchema = z.strictObject({ enabled: z.boolean(), upper: price.nullable().optional(), lower: price.nullable().optional(),
  dailyLimit: z.number().int().min(1).max(20), notification: notificationOptionsSchema });
const locksSchema = z.strictObject({ upper: ruleSchema.optional(), lower: ruleSchema.optional() });
const stateSchema = z.object({ version: z.union([z.literal(1),z.literal(2),z.literal(3)]), config: configSchema,
  running: z.boolean(), alerts: z.array(alertSchema).max(100).optional(), rules: locksSchema.optional(), legacyLocks: locksSchema.optional(),
  daily: z.strictObject({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), attempts: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) }),
}).passthrough();
type LegacyState = z.infer<typeof stateSchema>;
type LegacyAlert = z.infer<typeof alertSchema>;
type LegacyLast = z.infer<typeof lastSchema>;
type LegacyPending = z.infer<typeof pendingSchema>;
export type MigrationStatement = SqlStatement & { expectedChanges?: number };
export interface MigrationOwner { userId: string; email: string }
export interface LegacyMergeTarget { settingsGeneration: number; channelGeneration: number }
export interface LegacyImportOptions {
  /** Explicit fresh merge into a quiescent owner; obtain generations with checkLegacyMergeTarget. */
  mergeExisting?: LegacyMergeTarget;
  sourceId: string;
  owner: MigrationOwner;
  now?: number;
  /** Local, trusted secret input; never comes from a legacy export or HTTP request. */
  channelSecrets?: () => Promise<{ userKey: string; appToken?: string | null }>;
  encryptionKey?: string;
  limits?: AppConfig['limits'];
}
export interface LegacyImportPlan {
  readonly mergeExisting?: LegacyMergeTarget;
  readonly sourceId: string;
  readonly owner: MigrationOwner;
  readonly fingerprint: string;
  readonly stateChecksum: string;
  readonly ledgerKey: string;
  readonly now: number;
  readonly state: LegacyState;
  readonly alerts: readonly LegacyAlert[];
  readonly events: readonly PlannedEvent[];
  readonly uncertainMetadata: readonly { alertId: string; triggerId: string; generation: number; outcome: 'uncertain'; attempts: number; code: string }[];
  readonly metadata: string;
  readonly summary: Readonly<{ alerts: number; outbox: number; queuedHeld: number; uncertain: number; historyMetadata: number; legacyLocks: number; dailyAttempts: number }>;
}
interface PlannedEvent {
  alertId: string; triggerId: string; generation: number; instrument: string; name: string; side: 'upper' | 'lower';
  threshold: number; price: number; timestamp: number; createdAt: number; updatedAt: number;
  notification: z.infer<typeof notificationOptionsSchema>; phase: 'queued' | 'uncertain' | LegacyLast['outcome'];
  attempts: number; nextAt: number; originalNextAt: number; code: string | null;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
/** Bound size/depth and reject secret-bearing backup variants, including unknown fields. */
function inspect(value: unknown, depth = 0): void {
  if (depth > 32) fail('snapshot_too_deep');
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (['__proto__','constructor','prototype'].includes(key)) fail('invalid_snapshot');
    const k = key.replace(/[^a-z]/gi,'').toLowerCase();
    if (/token|secret|password|credential|authorization|cookie|userkey|encryptionkey|apikey/.test(k) || ['env','environment','bindings'].includes(k) || k === 'receipt' && child !== null) fail('credentials_in_snapshot');
    inspect(child, depth + 1);
  }
}
export function parseLegacySnapshot(input: unknown): LegacyState {
  let value: unknown = input;
  try {
    if (typeof value === 'string') {
      if (new TextEncoder().encode(value).length > MAX_LEGACY_BYTES) fail('snapshot_too_large');
      value = JSON.parse(value);
    }
    // A backup row wrapper is accepted, never a Worker public status response.
    if (value && typeof value === 'object' && Object.keys(value).length === 1 && 'monitor_state' in value) {
      value = (value as { monitor_state: unknown }).monitor_state;
      if (typeof value === 'string') value = JSON.parse(value);
    }
    inspect(value);
    const encoded = canonical(value);
    if (new TextEncoder().encode(encoded).length > MAX_LEGACY_BYTES) fail('snapshot_too_large');
    const parsed = stateSchema.safeParse(value);
    if (!parsed.success) fail('invalid_snapshot');
    const state = parsed.data;
    if (new Date(`${state.daily.date}T00:00:00Z`).toISOString().slice(0,10) !== state.daily.date) fail('invalid_snapshot');
    if (state.version === 1 ? !state.rules || state.alerts?.length : !state.alerts || state.rules) fail('invalid_snapshot');
    return state;
  } catch (error) { if (error instanceof LegacyMigrationError) throw error; return fail('invalid_snapshot'); }
}
function validateOwner(owner: MigrationOwner): MigrationOwner {
  if (!id.safeParse(owner.userId).success) fail('invalid_owner');
  try { return { userId: owner.userId, email: normalizeEmail(owner.email) }; } catch { return fail('invalid_owner'); }
}
function currentEvent(alert: LegacyAlert, pending: LegacyPending, state: LegacyState, now: number): PlannedEvent | null {
  const eventGeneration = pending.generation ?? alert.generation;
  if (eventGeneration !== alert.generation) fail('event_generation_conflict');
  const instrument = pending.instrument ?? (state.version < 3 ? 'BTC-USDT-SWAP' : undefined);
  // Never reconstruct a queued price/snapshot from the current rule, which may have changed.
  if (pending.instrument !== undefined && pending.instrument !== alert.instrument || pending.side !== undefined && pending.side !== alert.side || pending.threshold !== undefined && pending.threshold !== alert.threshold || pending.name !== undefined && pending.name !== alert.name) fail('pending_snapshot_conflict');
  if (!instrument || !pending.side || pending.threshold === undefined || pending.price === undefined || pending.timestamp === undefined || pending.createdAt === undefined || !pending.notification || pending.nextAt === undefined && pending.phase === 'queued') {
    if (pending.phase === 'sending') return null;
    fail('incomplete_pending_snapshot');
  }
  if (instrument !== alert.instrument) fail('pending_snapshot_conflict');
  return { alertId: alert.id, triggerId: pending.id, generation: eventGeneration, instrument, name: pending.name ?? alert.name,
    side: pending.side, threshold: pending.threshold, price: pending.price, timestamp: pending.timestamp,
    createdAt: pending.createdAt, updatedAt: now, notification: pending.notification,
    phase: pending.phase === 'sending' ? 'uncertain' : 'queued', attempts: pending.attempts,
    nextAt: pending.phase === 'queued' ? HELD_UNTIL : pending.nextAt ?? 0, originalNextAt: pending.nextAt ?? 0,
    code: pending.phase === 'sending' ? 'legacy_send_uncertain' : 'legacy_import_held' };
}
function historicalEvent(alert: LegacyAlert, last: LegacyLast, state: LegacyState, now: number): PlannedEvent | null {
  if (!last.id || last.at === undefined || last.attempts === undefined || !last.instrument || !last.name || !last.side || last.threshold === undefined || last.price === undefined || last.timestamp === undefined || !last.notification || last.createdAt === undefined) return null;
  let g = last.generation;
  if (g === undefined) {
    // Legacy last has no generation. Infer only when there is room for an earlier generation.
    if (!alert.pending && alert.triggered) g = alert.generation;
    else if (alert.generation > 0) g = alert.generation - 1;
    else fail('event_generation_conflict');
  }
  if (g > alert.generation || (alert.pending || !alert.triggered) && g >= alert.generation) fail('event_generation_conflict');
  if (last.at > now) fail('invalid_history_time');
  return { alertId: alert.id, triggerId: last.id, generation: g, instrument: last.instrument, name: last.name,
    side: last.side, threshold: last.threshold, price: last.price, timestamp: last.timestamp, createdAt: last.createdAt,
    updatedAt: last.at, notification: last.notification, phase: last.outcome, attempts: last.attempts,
    nextAt: 0, originalNextAt: 0, code: last.code ?? null };
}
export async function planLegacyImport(input: unknown, options: Omit<LegacyImportOptions,'channelSecrets' | 'encryptionKey'>): Promise<LegacyImportPlan> {
  if (!id.safeParse(options.sourceId).success) fail('invalid_source_id');
  const owner = validateOwner(options.owner), now = options.now ?? Date.now();
  if (!epoch.safeParse(now).success) fail('invalid_time');
  const state = parseLegacySnapshot(input), stateChecksum = await migrationChecksum(canonical(state));
  const mergeExisting = options.mergeExisting;
  if (mergeExisting && (!generation.safeParse(mergeExisting.settingsGeneration).success || !generation.safeParse(mergeExisting.channelGeneration).success)) fail('invalid_merge_target');
  const fingerprint = await migrationChecksum(canonical({ adapter: 1, sourceId: options.sourceId, owner, stateChecksum, ...(mergeExisting ? { mergeExisting } : {}) }));
  const ledgerKey = `legacy-import:source:${await migrationChecksum(options.sourceId)}`;
  const alerts: LegacyAlert[] = [], locks = structuredClone(state.legacyLocks ?? {});
  const originalLocks = structuredClone(state.version === 1 ? state.rules ?? {} : state.legacyLocks ?? {});
  if (state.version === 1) {
    for (const side of ['upper','lower'] as const) {
      const rule = state.rules?.[side] ?? { generation: 0, triggered: false, pending: null, last: null };
      const threshold = state.config[side];
      if (threshold != null) alerts.push({ ...rule, id: LEGACY_IDS[side], instrument: 'BTC-USDT-SWAP', name: `Legacy ${side}`, side, threshold, enabled: true });
      else locks[side] = structuredClone(rule);
    }
  } else for (const a of state.alerts!) {
    if (state.version === 3 && !a.instrument) fail('missing_instrument');
    alerts.push({ ...a, instrument: a.instrument ?? 'BTC-USDT-SWAP' });
  }
  const eventIds = new Set<string>(), alertIds = new Set<string>(), events: PlannedEvent[] = [];
  let historyMetadata = 0;
  const uncertainMetadata: LegacyImportPlan['uncertainMetadata'][number][] = [];
  for (const a of alerts) {
    if (alertIds.has(a.id)) fail('duplicate_alert_id'); alertIds.add(a.id);
    a.triggered = !!(a.triggered || a.latched || a.pending);
    if (a.last?.generation !== undefined && (a.last.generation > a.generation || (a.pending || !a.triggered) && a.last.generation >= a.generation)) fail('event_generation_conflict');
    const pendingEvent = a.pending ? currentEvent(a,a.pending,state,now) : null;
    const lastEvent = a.last ? historicalEvent(a,a.last,state,now) : null;
    if (a.last && !lastEvent) historyMetadata++;
    if (a.pending && !pendingEvent) {
      if (eventIds.has(a.pending.id)) fail('duplicate_event_id'); eventIds.add(a.pending.id);
      uncertainMetadata.push({alertId:a.id,triggerId:a.pending.id,generation:a.generation,outcome:'uncertain',attempts:a.pending.attempts,code:'legacy_send_uncertain'});
    }
    if (a.pending && a.last?.id === a.pending.id) fail('duplicate_event_id');
    for (const event of [lastEvent,pendingEvent]) {
      if (!event) continue;
      if (eventIds.has(event.triggerId)) fail('duplicate_event_id'); eventIds.add(event.triggerId);
      if (events.some(e => e.alertId === a.id && e.generation === event.generation)) fail('event_generation_conflict');
      events.push(event);
    }
    // Metadata-only histories must also have unique event IDs.
    if (a.last?.id && !lastEvent) { if (eventIds.has(a.last.id)) fail('duplicate_event_id'); eventIds.add(a.last.id); }
  }
  for (const [side, lock] of Object.entries(locks)) {
    if (!lock) continue;
    if (alertIds.has(LEGACY_IDS[side as 'upper' | 'lower'])) fail('legacy_lock_conflict');
    lock.triggered = !!(lock.triggered || lock.latched || lock.pending);
    // No threshold => retain the lock and recovery result in metadata, never create an alert.
    if (lock.last?.id) { if (eventIds.has(lock.last.id)) fail('duplicate_event_id'); eventIds.add(lock.last.id); }
    if (lock.pending?.generation !== undefined && lock.pending.generation !== lock.generation) fail('event_generation_conflict');
    if (lock.pending) {
      if (eventIds.has(lock.pending.id)) fail('duplicate_event_id'); eventIds.add(lock.pending.id);
      lock.last = { id: lock.pending.id, outcome: lock.pending.phase === 'sending' ? 'uncertain' : 'cancelled',
        at: now, attempts: lock.pending.attempts, code: 'legacy_lock_without_threshold' };
      lock.pending = null;
    }
  }
  const limits = options.limits ?? DEFAULT_MIGRATION_LIMITS;
  if (alerts.length > limits.alertsPerUser || new Set(alerts.map(a => a.instrument)).size > limits.instrumentsPerUser) fail('target_limits_exceeded');
  const metadata = canonical({ ...(mergeExisting ? { mergeExisting } : {}), adapter: 1, sourceId: options.sourceId, owner, fingerprint, stateChecksum, importedAt: now,
    sourceVersion: state.version, sourceRunning: state.running, sourceConfig: state.config, sourceDaily: state.daily,
    legacyLocks: locks, originalLegacyLocks: originalLocks, alertMapping: alerts.map(a => ({ sourceId: a.id, targetId: a.id, generation: a.generation,
      triggered: a.triggered, last: a.last, pending: a.pending })),
    uncertainMetadata,
    eventMapping: events.map(e => ({ triggerId: e.triggerId, alertId: e.alertId, generation: e.generation, phase: e.phase, originalNextAt: e.originalNextAt })),
    previousPrice: state.previousPrice ?? null,
    hold: { settingsEnabled: false, settingsGeneration: mergeExisting?.settingsGeneration ?? 0, channelGeneration: mergeExisting?.channelGeneration ?? 0, queuedUntil: HELD_UNTIL, releaseRequiresFinalSourceStop: true } });
  return { ...(mergeExisting ? { mergeExisting } : {}), sourceId: options.sourceId, owner, fingerprint, stateChecksum, ledgerKey, now, state, alerts, events, uncertainMetadata, metadata,
    summary: { alerts: alerts.length, outbox: events.length, queuedHeld: events.filter(e => e.phase === 'queued').length,
      uncertain: events.filter(e => e.phase === 'uncertain').length + uncertainMetadata.length, historyMetadata, legacyLocks: Object.keys(locks).length, dailyAttempts: state.daily.attempts } };
}
export async function verifyMigrationSchema(db: SqlDatabase): Promise<void> {
  const dialect = db.driver === 'postgres' ? 'postgres' : 'sqlite';
  for (const migration of [...AUTH_MIGRATIONS[dialect], ...APP_MIGRATIONS[dialect]]) {
    const rows = await db.query<{ checksum: string }>('SELECT checksum FROM schema_migrations WHERE dialect=? AND version=?',[dialect,migration.version]);
    if (rows.length !== 1 || rows[0]!.checksum !== await migrationChecksum(migration.sql)) fail('schema_not_ready');
  }
}
const emptyData = (alias: string) => ['alerts','outbox','channels','channel_versions','test_notifications'].map(table => `NOT EXISTS(SELECT 1 FROM ${table} WHERE user_id=${alias}.id)`).join(' AND ');
function ownerPredicate(db: Pick<SqlDatabase,'driver'>): string { return `u.id=? AND u.email=? AND u.email_verified=${db.driver === 'postgres' ? 'TRUE' : '1'} AND u.role='admin' AND COALESCE(s.disabled,0)=0`; }
const mergeData = (alias: string) => `s.user_id IS NOT NULL AND s.enabled=0 AND s.disabled=0 AND s.generation=?
  AND EXISTS(SELECT 1 FROM channels c JOIN channel_versions v ON v.user_id=c.user_id AND v.generation=c.generation WHERE c.user_id=${alias}.id AND c.generation=?)
  AND NOT EXISTS(SELECT 1 FROM alerts WHERE user_id<>${alias}.id)
  AND NOT EXISTS(SELECT 1 FROM alerts WHERE user_id=${alias}.id AND pending_trigger_id IS NOT NULL)
  AND NOT EXISTS(SELECT 1 FROM outbox WHERE user_id=${alias}.id AND phase IN('queued','sending'))
  AND NOT EXISTS(SELECT 1 FROM test_notifications WHERE user_id=${alias}.id AND phase='sending')`;
/** Reads generations only; never retrieves credentials or changes owner configuration. */
export async function checkLegacyMergeTarget(db: SqlDatabase, owner: MigrationOwner): Promise<LegacyMergeTarget> {
  owner = validateOwner(owner);
  await verifyMigrationSchema(db);
  const rows = await db.query<{ enabled: number; disabled: number; generation: number; channel_generation: number | null }>(`SELECT s.enabled,s.disabled,s.generation,c.generation AS channel_generation FROM "user" u JOIN user_settings s ON s.user_id=u.id LEFT JOIN channels c ON c.user_id=u.id WHERE ${ownerPredicate(db)}`,[owner.userId,owner.email]);
  if (rows.length !== 1) fail('merge_target_not_ready');
  const r = rows[0]!;
  if (r.enabled !== 0) fail('merge_target_enabled');
  const target = {settingsGeneration:r.generation,channelGeneration:r.channel_generation!};
  if (!generation.safeParse(target.settingsGeneration).success || !generation.safeParse(target.channelGeneration).success) fail('merge_target_not_ready');
  const ready = await db.query(`SELECT u.id FROM "user" u JOIN user_settings s ON s.user_id=u.id WHERE ${ownerPredicate(db)} AND ${mergeData('u')} AND NOT EXISTS(SELECT 1 FROM app_meta WHERE key=?)`,[owner.userId,owner.email,target.settingsGeneration,target.channelGeneration,`legacy-import:owner:${owner.userId}`]);
  if (ready.length !== 1) fail('merge_target_not_ready');
  return target;
}
function reservedIds(plan: LegacyImportPlan): { alerts: string[]; events: string[] } {
  const meta = JSON.parse(plan.metadata);
  const alertIds = new Set(plan.alerts.map(a=>a.id)), eventIds = new Set<string>();
  for (const a of plan.alerts) for (const e of [a.pending,a.last]) if (e?.id) eventIds.add(e.id);
  for (const locks of [meta.legacyLocks,meta.originalLegacyLocks]) for (const [side,lock] of Object.entries(locks ?? {}) as [keyof typeof LEGACY_IDS, any][]) {
    alertIds.add(LEGACY_IDS[side]);
    for (const e of [lock.pending,lock.last]) if(e?.id) eventIds.add(e.id);
  }
  return {alerts:[...alertIds],events:[...eventIds]};
}
const eventFree = `NOT EXISTS(SELECT 1 FROM outbox WHERE trigger_id=?) AND NOT EXISTS(SELECT 1 FROM alerts WHERE trigger_id=? OR pending_trigger_id=?) AND NOT EXISTS(SELECT 1 FROM test_notifications WHERE id=?)`;
export async function checkLegacyTarget(db: SqlDatabase, plan: LegacyImportPlan): Promise<'ready' | 'already_imported'> {
  await verifyMigrationSchema(db);
  const owners = await db.query<{ id: string }>(`SELECT u.id FROM "user" u LEFT JOIN user_settings s ON s.user_id=u.id WHERE ${ownerPredicate(db)}`,[plan.owner.userId,plan.owner.email]);
  if (owners.length !== 1) fail('owner_not_verified_admin');
  const ledger = await db.query<{ value: string }>('SELECT value FROM app_meta WHERE key=?',[plan.ledgerKey]);
  if (ledger[0]) {
    const saved = JSON.parse(ledger[0].value) as { fingerprint?: string };
    if (saved.fingerprint !== plan.fingerprint) fail('source_already_imported_differently');
    return 'already_imported';
  }
  if (plan.mergeExisting) {
    if ((await db.query('SELECT key FROM app_meta WHERE substr(key,1,?)=?',[plan.ledgerKey.length+1,`${plan.ledgerKey}:`])).length) fail('source_already_imported_differently');
    try {
      const target = await checkLegacyMergeTarget(db,plan.owner);
      if (target.settingsGeneration !== plan.mergeExisting.settingsGeneration || target.channelGeneration !== plan.mergeExisting.channelGeneration) fail('merge_target_changed');
    } catch (error) {
      // Another connection can commit between the initial ledger read and merge guards.
      const committed = await db.query<{value:string}>('SELECT value FROM app_meta WHERE key=?',[plan.ledgerKey]);
      if (committed[0]) {
        if (JSON.parse(committed[0].value).fingerprint !== plan.fingerprint) fail('source_already_imported_differently');
        return 'already_imported';
      }
      throw error;
    }
  } else {
    const ready = await db.query<{ id: string }>(`SELECT u.id FROM "user" u LEFT JOIN user_settings s ON s.user_id=u.id WHERE ${ownerPredicate(db)} AND ${emptyData('u')} AND (s.user_id IS NULL OR (s.enabled=0 AND s.generation=0)) AND NOT EXISTS(SELECT 1 FROM app_meta WHERE key=?)`,[plan.owner.userId,plan.owner.email,`legacy-import:owner:${plan.owner.userId}`]);
    if (ready.length !== 1) fail('target_not_empty');
  }
  const ids = reservedIds(plan);
  for (const alertId of ids.alerts) if ((await db.query('SELECT id FROM alerts WHERE id=?',[alertId])).length) fail('target_id_conflict');
  for (const eventId of ids.events) if (!(await db.query(`SELECT key FROM app_meta WHERE key='write-lock' AND ${eventFree}`,[eventId,eventId,eventId,eventId])).length) fail('target_id_conflict');
  return 'ready';
}
export async function buildLegacyImportStatements(plan: LegacyImportPlan, options: Pick<LegacyImportOptions,'channelSecrets' | 'encryptionKey' | 'limits'>, driver: SqlDatabase['driver'] = 'sqlite'): Promise<MigrationStatement[]> {
  const { owner, now, state } = plan, meta = plan.metadata;
  if (plan.mergeExisting && options.channelSecrets) fail('merge_preserves_channels');
  let channel: { userKey: string; appToken: string | null } | null = null;
  if (options.channelSecrets) {
    if (!options.encryptionKey) fail('encryption_key_required');
    let secrets: Awaited<ReturnType<NonNullable<LegacyImportOptions['channelSecrets']>>>;
    try { secrets = await options.channelSecrets(); } catch { return fail('channel_input_failed'); }
    if (!z.strictObject({ userKey: z.string().regex(/^[A-Za-z0-9]{30}$/), appToken: z.string().regex(/^[A-Za-z0-9]{30}$/).nullable().optional() }).safeParse(secrets).success) fail('invalid_channel_input');
    channel = { userKey: JSON.stringify(await encryptSecret(options.encryptionKey,owner.userId,'userKey',secrets.userKey)),
      appToken: secrets.appToken ? JSON.stringify(await encryptSecret(options.encryptionKey,owner.userId,'appToken',secrets.appToken)) : null };
  }
  const stat = (sql: string, params: SqlValue[] = [], expectedChanges = 1): MigrationStatement => ({sql,params,expectedChanges});
  const merge = plan.mergeExisting;
  const targetGuard = merge ? mergeData('u') : `${emptyData('u')} AND (s.user_id IS NULL OR (s.enabled=0 AND s.generation=0))`;
  const statements = [stat("UPDATE app_meta SET value=value WHERE key='write-lock'"),
    stat(`UPDATE "user" SET id=id WHERE id=? AND email=? AND email_verified=${driver === 'postgres' ? 'TRUE' : '1'} AND role='admin'`,[owner.userId,owner.email])];
  if (merge) statements.push(stat("UPDATE app_meta SET value=value WHERE key='write-lock' AND NOT EXISTS(SELECT 1 FROM app_meta WHERE substr(key,1,?)=?) AND COALESCE((SELECT attempts FROM daily_usage WHERE user_id=? AND utc_date=?),0)<=? AND COALESCE((SELECT attempts FROM global_daily_usage WHERE utc_date=?),0)<=?",[plan.ledgerKey.length+1,`${plan.ledgerKey}:`,owner.userId,state.daily.date,Number.MAX_SAFE_INTEGER-state.daily.attempts,state.daily.date,Number.MAX_SAFE_INTEGER-state.daily.attempts]));
  const ids = reservedIds(plan);
  for (const alertId of ids.alerts) statements.push(stat("UPDATE app_meta SET value=value WHERE key='write-lock' AND NOT EXISTS(SELECT 1 FROM alerts WHERE id=?)",[alertId]));
  for (const eventId of ids.events) statements.push(stat(`UPDATE app_meta SET value=value WHERE key='write-lock' AND ${eventFree}`,[eventId,eventId,eventId,eventId]));
  statements.push(stat(`INSERT INTO app_meta(key,value) SELECT ?,? FROM "user" u LEFT JOIN user_settings s ON s.user_id=u.id WHERE ${ownerPredicate({driver})} AND ${targetGuard} AND NOT EXISTS(SELECT 1 FROM app_meta WHERE key=? OR key=?)`,[plan.ledgerKey,meta,owner.userId,owner.email,...(merge ? [merge.settingsGeneration,merge.channelGeneration] : []),plan.ledgerKey,`legacy-import:owner:${owner.userId}`]),
    stat('INSERT INTO app_meta(key,value) VALUES(?,?)',[`legacy-import:owner:${owner.userId}`,plan.fingerprint]));
  if (!merge) statements.push(stat(`INSERT INTO user_settings(user_id,enabled,disabled,generation,daily_limit,notification_json,created_at,updated_at) VALUES(?,0,0,0,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET daily_limit=excluded.daily_limit,notification_json=excluded.notification_json,updated_at=excluded.updated_at WHERE user_settings.enabled=0 AND user_settings.disabled=0 AND user_settings.generation=0`,[owner.userId,state.config.dailyLimit,JSON.stringify(state.config.notification),now,now]));
  if (channel) statements.push(stat('INSERT INTO channel_versions(user_id,generation) VALUES(?,0)',[owner.userId]),stat('INSERT INTO channels(user_id,generation,user_key_json,private_token_json,updated_at) VALUES(?,0,?,?,?)',[owner.userId,channel.userKey,channel.appToken,now]));
  for (const a of plan.alerts) {
    const triggerId = a.pending?.id ?? (a.triggered ? a.last?.id ?? null : null);
    const pendingTriggerId = a.pending?.phase === 'queued' ? a.pending.id : null;
    statements.push(stat('INSERT INTO alerts(id,user_id,name,instrument,side,threshold,enabled,generation,triggered,trigger_id,pending_trigger_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [a.id,owner.userId,a.name,a.instrument!,a.side,a.threshold,+a.enabled,a.generation,+!!a.triggered,triggerId,pendingTriggerId,a.createdAt ?? now,a.updatedAt ?? now]));
  }
  for (const e of plan.events) statements.push(stat('INSERT INTO outbox(trigger_id,alert_id,user_id,generation,settings_generation,channel_generation,instrument,name,side,threshold,price,timestamp,notification_json,phase,attempts,next_at,created_at,updated_at,code) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    [e.triggerId,e.alertId,owner.userId,e.generation,merge?.settingsGeneration ?? 0,merge?.channelGeneration ?? 0,e.instrument,e.name,e.side,e.threshold,e.price,e.timestamp,JSON.stringify(e.notification),e.phase,e.attempts,e.nextAt,e.createdAt,e.updatedAt,e.code]));
  // Independent installations consume independent attempts. Fresh merge adds exactly once under the ledger.
  const userUsage = merge ? 'daily_usage.attempts+excluded.attempts' : 'CASE WHEN daily_usage.attempts>excluded.attempts THEN daily_usage.attempts ELSE excluded.attempts END';
  const globalUsage = merge ? 'global_daily_usage.attempts+excluded.attempts' : 'CASE WHEN global_daily_usage.attempts>excluded.attempts THEN global_daily_usage.attempts ELSE excluded.attempts END';
  statements.push(stat(`INSERT INTO daily_usage(user_id,utc_date,attempts,updated_at) VALUES(?,?,?,?) ON CONFLICT(user_id,utc_date) DO UPDATE SET attempts=${userUsage},updated_at=excluded.updated_at`,[owner.userId,state.daily.date,state.daily.attempts,now]),
    stat(`INSERT INTO global_daily_usage(utc_date,attempts,updated_at) VALUES(?,?,?) ON CONFLICT(utc_date) DO UPDATE SET attempts=${globalUsage},updated_at=excluded.updated_at`,[state.daily.date,state.daily.attempts,now]));
  {
    const limits = options.limits ?? DEFAULT_MIGRATION_LIMITS;
    statements.push(stat(`UPDATE app_meta SET value=value WHERE key=? AND (SELECT COUNT(*) FROM alerts WHERE user_id=? AND deleted_at IS NULL)<=? AND (SELECT COUNT(DISTINCT instrument) FROM alerts WHERE user_id=? AND deleted_at IS NULL)<=? AND (SELECT COUNT(*) FROM alerts WHERE enabled=1 AND deleted_at IS NULL)<=? AND (SELECT COUNT(DISTINCT instrument) FROM alerts WHERE deleted_at IS NULL)<=?`,[plan.ledgerKey,owner.userId,limits.alertsPerUser,owner.userId,limits.instrumentsPerUser,limits.activeAlerts,limits.globalInstruments]));
  }
  return statements;
}
export async function importLegacyState(db: SqlDatabase, input: unknown, options: LegacyImportOptions & { dryRun?: boolean }): Promise<{ status: 'dry_run' | 'imported' | 'already_imported'; plan: LegacyImportPlan }> {
  const plan = await planLegacyImport(input,options), status = await checkLegacyTarget(db,plan);
  if (status === 'already_imported') return {status,plan};
  if (options.dryRun) return {status:'dry_run',plan};
  const statements = await buildLegacyImportStatements(plan,options,db.driver);
  try {
    if (!await db.atomicCAS(statements)) {
      // Concurrent duplicate import is a no-op, never a latch/quota reset.
      if (await checkLegacyTarget(db,plan) === 'already_imported') return {status:'already_imported',plan};
      fail('target_changed');
    }
  } catch (error) { if (error instanceof LegacyMigrationError) throw error; fail('import_transaction_failed'); }
  return {status:'imported',plan};
}
/** Explicit post-switch action. No transport is constructed; only validated queued rows are released. */
export async function releaseLegacyHold(db: SqlDatabase, input: { sourceId: string; owner: MigrationOwner; confirmSourceStopped: true; now?: number }): Promise<'released' | 'already_released'> {
  if (input.confirmSourceStopped !== true || !id.safeParse(input.sourceId).success) fail('source_stop_confirmation_required');
  const owner = validateOwner(input.owner), now = input.now ?? Date.now();
  if (!epoch.safeParse(now).success) fail('invalid_time');
  await verifyMigrationSchema(db);
  const ledgerKey = `legacy-import:source:${await migrationChecksum(input.sourceId)}`;
  const rows = await db.query<{ value: string }>('SELECT value FROM app_meta WHERE key=?',[ledgerKey]);
  if (!rows[0]) fail('migration_not_found');
  const manifest = JSON.parse(rows[0].value) as { owner: MigrationOwner; fingerprint: string; alertMapping: {targetId:string; generation:number; pending: LegacyPending | null}[]; mergeExisting?: LegacyMergeTarget };
  if (manifest.owner.userId !== owner.userId || manifest.owner.email !== owner.email) fail('owner_mismatch');
  const valid = await db.query(`SELECT u.id FROM "user" u LEFT JOIN user_settings s ON s.user_id=u.id WHERE ${ownerPredicate(db)}`,[owner.userId,owner.email]);
  if (valid.length !== 1) fail('owner_not_verified_admin');
  const key = `${ledgerKey}:released`;
  if ((await db.query('SELECT key FROM app_meta WHERE key=?',[key])).length) return 'already_released';
  const settingsGeneration = manifest.mergeExisting?.settingsGeneration ?? 0, channelGeneration = manifest.mergeExisting?.channelGeneration ?? 0;
  const statements: MigrationStatement[] = [
    {sql:"UPDATE app_meta SET value=value WHERE key='write-lock'",expectedChanges:1},
    {sql:`UPDATE "user" SET id=id WHERE id=? AND email=? AND email_verified=${db.driver === 'postgres' ? 'TRUE' : '1'} AND role='admin'`,params:[owner.userId,owner.email],expectedChanges:1},
    {sql:'UPDATE user_settings SET enabled=1,generation=generation+1,updated_at=? WHERE user_id=? AND enabled=0 AND disabled=0 AND generation=? AND EXISTS(SELECT 1 FROM channels WHERE user_id=? AND generation=?) AND EXISTS(SELECT 1 FROM app_meta WHERE key=? AND value=?)',params:[now,owner.userId,settingsGeneration,owner.userId,channelGeneration,ledgerKey,rows[0].value],expectedChanges:1},
    {sql:'INSERT INTO app_meta(key,value) VALUES(?,?)',params:[key,JSON.stringify({fingerprint:manifest.fingerprint,releasedAt:now,sourceStopped:true})],expectedChanges:1},
  ];
  for (const a of manifest.alertMapping) if (a.pending?.phase === 'queued') {
    const p = a.pending;
    statements.push({sql:`UPDATE outbox SET settings_generation=?,next_at=?,updated_at=?,code=NULL WHERE trigger_id=? AND user_id=? AND alert_id=? AND generation=? AND phase='queued' AND next_at=? AND settings_generation=? AND channel_generation=? AND EXISTS(SELECT 1 FROM alerts WHERE id=? AND user_id=? AND generation=? AND triggered=1 AND pending_trigger_id=?) AND EXISTS(SELECT 1 FROM channels WHERE user_id=? AND generation=outbox.channel_generation)`,
      params:[settingsGeneration+1,p.nextAt ?? now,now,p.id,owner.userId,a.targetId,a.generation,HELD_UNTIL,settingsGeneration,channelGeneration,a.targetId,owner.userId,a.generation,p.id,owner.userId],expectedChanges:1});
  }
  if (!await db.atomicCAS(statements)) fail('cutover_target_changed');
  return 'released';
}
