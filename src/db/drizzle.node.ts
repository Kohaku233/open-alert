import { drizzle as postgresDrizzle } from 'drizzle-orm/node-postgres';
import { drizzle as proxyDrizzle } from 'drizzle-orm/sqlite-proxy';
import type Native from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { SqliteRemoteDatabase } from 'drizzle-orm/sqlite-proxy';
import { SQLiteDatabase } from './sqlite.js';
import { PostgresDatabase } from './postgres.js';
import { executeSqliteProxyQuery, type SqliteProxyStatement } from './sqlite-proxy.js';
import { bindings } from './sql.js';
import type { SqlValue } from '../contracts/db.js';
/** Auth uses the adapter's physical connection, never a separately opened database. */
export function createAuthDrizzle(db: SQLiteDatabase, schema: Record<string, unknown>): Promise<BetterSQLite3Database<Record<string, unknown>> | SqliteRemoteDatabase<Record<string, unknown>>>;
export function createAuthDrizzle(db: PostgresDatabase, schema: Record<string, unknown>): Promise<NodePgDatabase<Record<string, unknown>>>;
export async function createAuthDrizzle(db: SQLiteDatabase | PostgresDatabase, schema: Record<string, unknown>): Promise<BetterSQLite3Database<Record<string, unknown>> | SqliteRemoteDatabase<Record<string, unknown>> | NodePgDatabase<Record<string, unknown>>> {
  if (db instanceof PostgresDatabase) return postgresDrizzle(db.rawConnection, { schema });
  if (db.nativeDriver === 'better-sqlite3') { const { drizzle } = await import('drizzle-orm/better-sqlite3'); return drizzle(db.rawConnection as unknown as Native.Database, { schema }); }
  const proxy = proxyDrizzle(async (sql, params: SqlValue[], method) => {
    // SQLite async interactive transactions would interleave unrelated repository writes.
    if (/^\s*(?:begin|commit|rollback|savepoint|release)\b/i.test(sql)) throw new Error('Interactive SQLite auth transactions are unsupported');
    const statement = db.rawConnection.prepare(sql) as unknown as SqliteProxyStatement;
    return executeSqliteProxyQuery(explain => db.rawConnection.prepare(explain) as unknown as { all(): unknown }, statement, bindings(params), method) as { rows: any[] };
  }, { schema });
  return proxy;
}
