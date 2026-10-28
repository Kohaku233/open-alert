import type { SqlDatabase } from '../contracts/db.js';
import type { Category, Direction, Session, WindowKey } from './rules.js';

/** Node-only feature tables. They are deliberately outside the shared migration
 * ledger: the Cloudflare Worker validates that ledger against D1 at startup and
 * never runs this feature, so idempotent DDL here cannot affect its readiness. */
export async function ensureAnomalySchema(db: SqlDatabase): Promise<void> {
  const pg = db.driver === 'postgres', int = pg ? 'BIGINT' : 'INTEGER', real = pg ? 'DOUBLE PRECISION' : 'REAL';
  await db.atomic([
    { sql: `CREATE TABLE IF NOT EXISTS anomaly_settings (user_id TEXT PRIMARY KEY REFERENCES "user"(id), enabled ${int} NOT NULL CHECK(enabled IN(0,1)), crypto ${int} NOT NULL CHECK(crypto IN(0,1)), tradfi ${int} NOT NULL CHECK(tradfi IN(0,1)), min_move_crypto ${real} NOT NULL, min_move_tradfi ${real} NOT NULL, priority ${int} NOT NULL CHECK(priority BETWEEN -1 AND 2), daily_limit ${int} NOT NULL CHECK(daily_limit BETWEEN 1 AND 50), generation ${int} NOT NULL CHECK(generation>=0), updated_at ${int} NOT NULL)` },
    { sql: `CREATE TABLE IF NOT EXISTS anomaly_events (id TEXT PRIMARY KEY, group_id TEXT NOT NULL, at ${int} NOT NULL, entity TEXT NOT NULL, label TEXT NOT NULL, category TEXT NOT NULL CHECK(category IN('crypto','tradfi')), direction TEXT NOT NULL CHECK(direction IN('up','down')), win TEXT NOT NULL, session TEXT NOT NULL, move ${real} NOT NULL, relative_move ${real} NOT NULL, z ${real} NOT NULL, volume_multiple ${real} NOT NULL, market_cap ${real}, venues_json TEXT NOT NULL)` },
    { sql: 'CREATE INDEX IF NOT EXISTS anomaly_events_at ON anomaly_events(at)' },
    { sql: `CREATE TABLE IF NOT EXISTS anomaly_deliveries (group_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES "user"(id), at ${int} NOT NULL, entities_json TEXT NOT NULL, outcome TEXT NOT NULL CHECK(outcome IN('sent','failed','uncertain')), code TEXT, PRIMARY KEY(group_id,user_id))` },
    { sql: 'CREATE INDEX IF NOT EXISTS anomaly_deliveries_user ON anomaly_deliveries(user_id,at)' },
  ]);
}

export interface AnomalySettings {
  enabled: boolean; crypto: boolean; tradfi: boolean;
  /** Simple-return floors; crypto is measured net of BTC. */
  minMoveCrypto: number; minMoveTradfi: number;
  priority: -1 | 0 | 1 | 2; dailyLimit: number;
}
export const DEFAULT_ANOMALY_SETTINGS: Readonly<AnomalySettings> = Object.freeze({ enabled: false, crypto: true, tradfi: true, minMoveCrypto: 0.25, minMoveTradfi: 0.03, priority: 1, dailyLimit: 10 });
export interface VenueHit { venue: 'binance' | 'okx' | 'mexc'; instrument: string; symbol: string; price: number; move: number; z: number; volumeMultiple: number; window: WindowKey }
/** The move pushed to one user for one entity; the basis of that user's cooldown. */
export interface DeliveryMark { entity: string; at: number; direction: Direction; move: number }
export interface AnomalyEvent {
  id: string; groupId: string; at: number; entity: string; label: string; category: Category; direction: Direction;
  window: WindowKey; session: Session; move: number; relativeMove: number; z: number; volumeMultiple: number;
  marketCap: number | null; venues: VenueHit[];
}
interface SettingsRow { enabled: number; crypto: number; tradfi: number; min_move_crypto: number; min_move_tradfi: number; priority: number; daily_limit: number; generation: number }
interface EventRow { id: string; group_id: string; at: number; entity: string; label: string; category: Category; direction: Direction; win: WindowKey; session: Session; move: number; relative_move: number; z: number; volume_multiple: number; market_cap: number | null; venues_json: string }
const settingsOf = (r: SettingsRow): AnomalySettings => ({ enabled: r.enabled === 1, crypto: r.crypto === 1, tradfi: r.tradfi === 1, minMoveCrypto: r.min_move_crypto, minMoveTradfi: r.min_move_tradfi, priority: r.priority as AnomalySettings['priority'], dailyLimit: r.daily_limit });
const eventOf = (r: EventRow): AnomalyEvent => ({ id: r.id, groupId: r.group_id, at: r.at, entity: r.entity, label: r.label, category: r.category, direction: r.direction, window: r.win, session: r.session, move: r.move, relativeMove: r.relative_move, z: r.z, volumeMultiple: r.volume_multiple, marketCap: r.market_cap, venues: JSON.parse(r.venues_json) as VenueHit[] });
export class AnomalyConflict extends Error { constructor() { super('generation_conflict'); this.name = 'AnomalyConflict'; } }

export function createAnomalyStore(db: SqlDatabase) {
  const columns = 'enabled,crypto,tradfi,min_move_crypto,min_move_tradfi,priority,daily_limit,generation';
  async function getSettings(userId: string): Promise<{ settings: AnomalySettings; generation: number }> {
    const row = (await db.query<SettingsRow>(`SELECT ${columns} FROM anomaly_settings WHERE user_id=?`, [userId]))[0];
    return row ? { settings: settingsOf(row), generation: row.generation } : { settings: { ...DEFAULT_ANOMALY_SETTINGS }, generation: 0 };
  }
  async function patchSettings(userId: string, expectedGeneration: number, patch: Partial<AnomalySettings>, now: number) {
    const current = await getSettings(userId);
    if (current.generation !== expectedGeneration) throw new AnomalyConflict();
    const next = { ...current.settings, ...patch }, b = (v: boolean) => v ? 1 : 0;
    const values = [b(next.enabled), b(next.crypto), b(next.tradfi), next.minMoveCrypto, next.minMoveTradfi, next.priority, next.dailyLimit];
    // Generation CAS: the insert only succeeds for a never-saved row, the update only from the expected generation.
    const result = await db.execute(`INSERT INTO anomaly_settings(user_id,${columns},updated_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET enabled=excluded.enabled,crypto=excluded.crypto,tradfi=excluded.tradfi,min_move_crypto=excluded.min_move_crypto,min_move_tradfi=excluded.min_move_tradfi,priority=excluded.priority,daily_limit=excluded.daily_limit,generation=excluded.generation,updated_at=excluded.updated_at WHERE anomaly_settings.generation=?`,
      [userId, ...values, expectedGeneration + 1, now, expectedGeneration]);
    if (result.changes !== 1) throw new AnomalyConflict();
    return { settings: next, generation: expectedGeneration + 1 };
  }
  /** Users who want pushes, with their filters. */
  async function subscribers(): Promise<{ userId: string; settings: AnomalySettings }[]> {
    const rows = await db.query<SettingsRow & { user_id: string }>(`SELECT a.user_id,${columns.split(',').map(c => 'a.' + c).join(',')} FROM anomaly_settings a LEFT JOIN user_settings s ON s.user_id=a.user_id WHERE a.enabled=1 AND COALESCE(s.disabled,0)=0`);
    return rows.map(r => ({ userId: r.user_id, settings: settingsOf(r) }));
  }
  async function insertEvents(events: readonly AnomalyEvent[]) {
    if (!events.length) return;
    await db.atomic(events.map(e => ({ sql: 'INSERT INTO anomaly_events(id,group_id,at,entity,label,category,direction,win,session,move,relative_move,z,volume_multiple,market_cap,venues_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      params: [e.id, e.groupId, e.at, e.entity, e.label, e.category, e.direction, e.window, e.session, e.move, e.relativeMove, e.z, e.volumeMultiple, e.marketCap, JSON.stringify(e.venues)] })));
  }
  async function recentEvents(limit: number, since = 0): Promise<AnomalyEvent[]> {
    return (await db.query<EventRow>('SELECT * FROM anomaly_events WHERE at>=? ORDER BY at DESC,id LIMIT ?', [since, limit])).map(eventOf);
  }
  async function recordDelivery(groupId: string, userId: string, at: number, marks: readonly DeliveryMark[], outcome: 'sent' | 'failed' | 'uncertain', code: string | null) {
    await db.execute('INSERT INTO anomaly_deliveries(group_id,user_id,at,entities_json,outcome,code) VALUES(?,?,?,?,?,?) ON CONFLICT(group_id,user_id) DO NOTHING', [groupId, userId, at, JSON.stringify(marks), outcome, code]);
  }
  async function deliveriesSince(since: number, userId?: string) {
    const rows = await db.query<{ group_id: string; user_id: string; at: number; entities_json: string; outcome: string }>(
      `SELECT group_id,user_id,at,entities_json,outcome FROM anomaly_deliveries WHERE at>=?${userId ? ' AND user_id=?' : ''} ORDER BY at`, userId ? [since, userId] : [since]);
    return rows.map(r => {
      // Rows written before per-user cooldowns hold bare entity strings; they carry no move to compare against.
      const raw = JSON.parse(r.entities_json) as unknown[];
      const marks = raw.filter((m): m is DeliveryMark => typeof m === 'object' && m !== null && typeof (m as DeliveryMark).entity === 'string' && Number.isFinite((m as DeliveryMark).move));
      return { groupId: r.group_id, userId: r.user_id, at: r.at, entities: raw.map(m => typeof m === 'string' ? m : (m as DeliveryMark).entity), marks, outcome: r.outcome };
    });
  }
  async function prune(before: number) {
    await db.atomic([{ sql: 'DELETE FROM anomaly_events WHERE at<?', params: [before] }, { sql: 'DELETE FROM anomaly_deliveries WHERE at<?', params: [before] }]);
  }
  return { getSettings, patchSettings, subscribers, insertEvents, recentEvents, recordDelivery, deliveriesSince, prune };
}
export type AnomalyStore = ReturnType<typeof createAnomalyStore>;
