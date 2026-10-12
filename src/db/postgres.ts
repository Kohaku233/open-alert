import { Pool, types } from 'pg';
import type { SqlDatabase, SqlStatement, SqlValue } from '../contracts/db.js';
import { bindings, postgresSql, safeNumber } from './sql.js';
const parsers = { getTypeParser(oid: number, format?: string) { if (oid === 20 && format !== 'binary') return (s: string) => safeNumber(BigInt(s)); return types.getTypeParser(oid, format as 'text'); } };
export class PostgresDatabase implements SqlDatabase {
  readonly driver = 'postgres' as const;
  constructor(readonly rawConnection: Pool) {}
  async query<T extends object>(sql: string, params: readonly SqlValue[] = []): Promise<T[]> { return (await this.rawConnection.query({ text: postgresSql(sql), values: [...bindings(params)], types: parsers })).rows as T[]; }
  async execute(sql: string, params: readonly SqlValue[] = []): Promise<{ changes: number }> { return { changes: (await this.rawConnection.query({ text: postgresSql(sql), values: [...bindings(params)], types: parsers })).rowCount ?? 0 }; }
  private async transaction(statements: readonly SqlStatement[], expected?: readonly (number | undefined)[]): Promise<number[] | null> {
    const client = await this.rawConnection.connect();
    try { await client.query('BEGIN'); const counts: number[] = [];
      for (const [i, s] of statements.entries()) { const r = await client.query({ text: postgresSql(s.sql), values: [...bindings(s.params)], types: parsers }); const n = r.rowCount ?? 0; counts.push(n); if (expected && expected[i] !== undefined && n !== expected[i]) { await client.query('ROLLBACK'); return null; } }
      await client.query('COMMIT'); return counts;
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  }
  async atomic(statements: readonly SqlStatement[]): Promise<number[]> { return (await this.transaction(statements))!; }
  async atomicCAS(statements: readonly (SqlStatement & { expectedChanges?: number })[]): Promise<boolean> { return await this.transaction(statements, statements.map(s => s.expectedChanges)) !== null; }
  async close(): Promise<void> { await this.rawConnection.end(); }
}
export function createPostgres(url: string): PostgresDatabase { return new PostgresDatabase(new Pool({ connectionString: url })); }
