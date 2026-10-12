import { drizzle } from 'drizzle-orm/sqlite-proxy';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { executeSqliteProxyQuery } from '../db/sqlite-proxy.js';
import type { SqliteProxyStatement } from '../db/sqlite-proxy.js';
import * as schema from './schema.sqlite.js';

/** Drizzle 0.45.4 has no node-sqlite driver. Its documented proxy maps raw array rows explicitly. */
export function createNodeSqliteAuthDrizzle(connection: DatabaseSync) {
  const prepare = (sql: string) => connection.prepare(sql);
  return drizzle(async (sql, params, method) => executeSqliteProxyQuery(prepare, prepare(sql) as unknown as SqliteProxyStatement, params as SQLInputValue[], method) as { rows: unknown[] }, { schema });
}
