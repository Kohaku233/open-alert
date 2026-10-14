/** Drizzle's sqlite-proxy maps rows by column index. node:sqlite returns objects. */

export interface SqliteProxyStatement {
  all(...params: readonly unknown[]): unknown;
  get(...params: readonly unknown[]): unknown;
  run(...params: readonly unknown[]): unknown;
  columns?: () => readonly { name: string }[];
  setReturnArrays?: (enabled: boolean) => void;
  readonly sourceSQL?: string;
}

interface ExplainStatement {
  all(): unknown;
}

function readChanges(result: unknown): number | undefined {
  if (!result || typeof result !== 'object' || !('changes' in result)) return undefined;
  const changes = (result as { changes: unknown }).changes;
  if (typeof changes === 'number' && Number.isFinite(changes)) return changes;
  if (typeof changes === 'bigint' && changes >= BigInt(Number.MIN_SAFE_INTEGER) && changes <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(changes);
  return undefined;
}

function projectionWidth(prepare: (sql: string) => ExplainStatement, sourceSQL: string): number {
  const explained = prepare(`EXPLAIN ${sourceSQL}`).all();
  if (!Array.isArray(explained)) throw new Error('SQLite projection width is unavailable');
  const widths: number[] = [];
  for (const row of explained) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const record = row as { opcode?: unknown; p2?: unknown };
    const width = typeof record.p2 === 'bigint' ? Number(record.p2) : record.p2;
    if (record.opcode === 'ResultRow' && typeof width === 'number' && Number.isSafeInteger(width)) widths.push(width);
  }
  const width = widths[0];
  if (width === undefined || widths.some(value => value !== width)) throw new Error('SQLite projection width is unavailable');
  return width;
}

function objectRow(value: unknown): Record<string, unknown> | undefined {
  if (value == null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('SQLite row was not an object');
  return value as Record<string, unknown>;
}

function projectObject(row: Record<string, unknown>, columns: readonly { name: string }[] | undefined, width: number): unknown[] {
  if (columns) {
    if (new Set(columns.map(column => column.name)).size !== columns.length) throw new Error('SQLite projection has duplicate columns');
    return columns.map(column => row[column.name]);
  }
  const values = Object.values(row);
  // Object rows cannot represent a repeated result name, so a short key list is a collapsed projection.
  if (values.length !== width) throw new Error('SQLite projection has duplicate columns');
  return values;
}

/**
 * Array mode exists on Node 22.16+. Older node:sqlite builds only return named rows.
 * A missing get() stays undefined: sqlite-proxy treats an empty array as a row.
 * run() keeps changes so the auth adapter can count updates and deletes.
 */
export function executeSqliteProxyQuery(prepare: (sql: string) => ExplainStatement, statement: SqliteProxyStatement, params: readonly unknown[], method: string): { rows: unknown[] | undefined; changes?: number } {
  const bound = [...params];
  if (method === 'run') {
    const changes = readChanges(statement.run(...bound));
    return changes === undefined ? { rows: [] } : { rows: [], changes };
  }
  if (method !== 'all' && method !== 'get' && method !== 'values') throw new Error('Unsupported SQLite proxy method');
  if (typeof statement.setReturnArrays === 'function') {
    statement.setReturnArrays(true);
    if (method === 'get') {
      const row = statement.get(...bound);
      if (row == null) return { rows: undefined };
      if (!Array.isArray(row)) throw new Error('SQLite array mode did not return a row');
      return { rows: row };
    }
    const rows = statement.all(...bound);
    if (!Array.isArray(rows) || rows.some(row => !Array.isArray(row))) throw new Error('SQLite array mode did not return rows');
    return { rows };
  }
  const columns = typeof statement.columns === 'function' ? statement.columns() : undefined;
  if (columns && new Set(columns.map(column => column.name)).size !== columns.length) throw new Error('SQLite projection has duplicate columns');
  if (!columns && !statement.sourceSQL) throw new Error('SQLite projection width is unavailable');
  const width = columns ? columns.length : projectionWidth(prepare, statement.sourceSQL!);
  const project = (row: Record<string, unknown>) => projectObject(row, columns, width);
  if (method === 'get') {
    const row = objectRow(statement.get(...bound));
    return { rows: row ? project(row) : undefined };
  }
  const rows = statement.all(...bound);
  if (!Array.isArray(rows)) throw new Error('SQLite all() did not return rows');
  return { rows: rows.map(row => {
    const record = objectRow(row);
    if (!record) throw new Error('SQLite row was not an object');
    return project(record);
  }) };
}
