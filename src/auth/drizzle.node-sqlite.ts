import { drizzle } from 'drizzle-orm/sqlite-proxy';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import * as schema from './schema.sqlite.js';

/** Drizzle 0.45.4 has no node-sqlite driver. Its documented proxy maps raw array rows explicitly. */
export function createNodeSqliteAuthDrizzle(connection: DatabaseSync) {
  return drizzle(async (sql, params, method) => {
    const statement = connection.prepare(sql);
    if (method === 'run') {
      statement.run(...params as SQLInputValue[]);
      return { rows: [] };
    }
    // SQL projection order is retained in Object.values; duplicate columns require array mode.
    const arrayStatement = statement as typeof statement & { setReturnArrays?: (enabled: boolean) => void };
    if (arrayStatement.setReturnArrays) {
      arrayStatement.setReturnArrays(true);
      const rows = statement.all(...params as SQLInputValue[]) as unknown as unknown[][];
      return { rows: method === 'get' ? rows[0] ?? [] : rows };
    }
    // Node 22 lacks setReturnArrays: column metadata reconstructs projection order.
    const columns = statement.columns();
    if (new Set(columns.map(column => column.name)).size !== columns.length) throw new Error('Auth SQLite projection has duplicate columns');
    const rows = statement.all(...params as SQLInputValue[]).map(row => columns.map(column => row[column.name]));
    return { rows: method === 'get' ? rows[0] ?? [] : rows };
  }, { schema });
}
