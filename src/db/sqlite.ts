import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SqlDatabase, SqlStatement, SqlValue } from '../contracts/db.js';
import { bindings, safeNumber } from './sql.js';
type Statement = { all(...params: SqlValue[]): object[]; run(...params: SqlValue[]): { changes: number | bigint } };
export interface SQLiteConnection { prepare(sql: string): Statement; exec(sql: string): unknown; close(): void }
export class SQLiteDatabase implements SqlDatabase {
  readonly driver = 'sqlite' as const;
  constructor(readonly rawConnection: SQLiteConnection, readonly nativeDriver: 'better-sqlite3' | 'node:sqlite') {
    rawConnection.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;');
  }
  async query<T extends object>(sql: string, params: readonly SqlValue[] = []): Promise<T[]> { return this.rawConnection.prepare(sql).all(...bindings(params)) as T[]; }
  async execute(sql: string, params: readonly SqlValue[] = []): Promise<{ changes: number }> { return { changes: safeNumber(this.rawConnection.prepare(sql).run(...bindings(params)).changes) }; }
  private transaction(statements: readonly SqlStatement[], expected?: readonly (number | undefined)[]): number[] | null {
    this.rawConnection.exec('BEGIN IMMEDIATE');
    try {
      const counts: number[] = [];
      for (const [i, statement] of statements.entries()) {
        const n = safeNumber(this.rawConnection.prepare(statement.sql).run(...bindings(statement.params)).changes); counts.push(n);
        if (expected && expected[i] !== undefined && n !== expected[i]) { this.rawConnection.exec('ROLLBACK'); return null; }
      }
      this.rawConnection.exec('COMMIT'); return counts;
    } catch (error) { this.rawConnection.exec('ROLLBACK'); throw error; }
  }
  async atomic(statements: readonly SqlStatement[]): Promise<number[]> { return this.transaction(statements)!; }
  async atomicCAS(statements: readonly (SqlStatement & { expectedChanges?: number })[]): Promise<boolean> { return this.transaction(statements, statements.map(s => s.expectedChanges)) !== null; }
  async close(): Promise<void> { this.rawConnection.close(); }
}
export async function createSQLite(path: string, preferBuiltin = false): Promise<SQLiteDatabase> {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  if (!preferBuiltin) {
    try {
      const { default: Native } = await import('better-sqlite3');
      return new SQLiteDatabase(new Native(path) as unknown as SQLiteConnection, 'better-sqlite3');
    } catch (error) {
      // Missing binary/dependency can fall back; actual DB errors must surface.
      const e = error as { code?: string; message?: string };
      if (!['ERR_MODULE_NOT_FOUND','MODULE_NOT_FOUND','ERR_DLOPEN_FAILED'].includes(e.code ?? '') && !e.message?.includes('bindings file')) throw error;
    }
  }
  const { DatabaseSync } = await import('node:sqlite');
  return new SQLiteDatabase(new DatabaseSync(path) as unknown as SQLiteConnection, 'node:sqlite');
}
