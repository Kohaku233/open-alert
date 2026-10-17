import { drizzle } from 'drizzle-orm/sqlite-proxy';
import type { DatabaseSync } from 'node:sqlite';
import { executeSqliteProxyQuery } from '../db/sqlite-proxy.js';
import * as schema from './schema.sqlite.js';

/** Drizzle 0.45.4 has no node-sqlite driver. Its documented proxy maps raw array rows explicitly. */
export function createNodeSqliteAuthDrizzle(connection: DatabaseSync) {
  return drizzle(async (sql, params, method) => executeSqliteProxyQuery(
    explain => connection.prepare(explain),
    connection.prepare(sql),
    params,
    method,
  ) as { rows: any[] }, { schema });
}
