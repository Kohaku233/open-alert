import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';
import type { SqlDatabase, SqlStatement, SqlValue } from '../contracts/db.js';
import { bindings } from './sql.js';
import type { SqlTelemetry } from '../contracts/observability.js';
const casMiss = (error: unknown) => /CHECK constraint failed.*(?:cas_assertions|expected\s*=\s*actual)/i.test(String(error));
export class D1SqlDatabase implements SqlDatabase {
  readonly driver = 'd1' as const;
  constructor(readonly rawConnection: D1Database) {}
  private readonly stats: SqlTelemetry = { operations: 0, errors: 0, conflicts: 0, rowsRead: 0, rowsWritten: 0, durationMs: 0 };
  telemetry(): SqlTelemetry { return { ...this.stats }; }
  private record(results: readonly { meta: { rows_read: number; rows_written: number } }[]): void {
    for (const result of results) {
      this.stats.rowsRead += Number.isFinite(result.meta.rows_read) ? result.meta.rows_read : 0;
      this.stats.rowsWritten += Number.isFinite(result.meta.rows_written) ? result.meta.rows_written : 0;
    }
  }
  private async measure<T>(work: () => Promise<T>, cas = false): Promise<T> {
    const at = performance.now(); this.stats.operations++;
    try { return await work(); }
    catch (error) { if (cas && casMiss(error)) this.stats.conflicts++; else this.stats.errors++; throw error; }
    finally { this.stats.durationMs += Math.max(0, performance.now() - at); }
  }
  private prepare(sql: string, params?: readonly SqlValue[]) { return this.rawConnection.prepare(sql).bind(...bindings(params).map(v => v instanceof Uint8Array ? Array.from(v) : v)); }
  async query<T extends object>(sql: string, params?: readonly SqlValue[]): Promise<T[]> { return this.measure(async () => { const r = await this.prepare(sql, params).all<T>(); if (!r.success) throw new Error('D1 query failed'); this.record([r]); return r.results; }); }
  async execute(sql: string, params?: readonly SqlValue[]): Promise<{ changes: number }> { return this.measure(async () => { const r = await this.prepare(sql, params).run(); if (!r.success) throw new Error('D1 execute failed'); this.record([r]); return { changes: r.meta.changes }; }); }
  async atomic(statements: readonly SqlStatement[]): Promise<number[]> { if (!statements.length) return []; return this.measure(async () => { const results = await this.rawConnection.batch(statements.map(s => this.prepare(s.sql, s.params))); if (results.some(r => !r.success)) throw new Error('D1 batch failed'); this.record(results); return results.map(r => r.meta.changes); }); }
  async atomicCAS(statements: readonly (SqlStatement & { expectedChanges?: number })[]): Promise<boolean> {
    if (!statements.length) return true;
    // changes() references the immediately previous mutation. A CHECK failure rolls back the entire D1 batch.
    const id = crypto.randomUUID(); const batch: D1PreparedStatement[] = [];
    for (const s of statements) { batch.push(this.prepare(s.sql, s.params)); if (s.expectedChanges !== undefined) { batch.push(this.prepare('INSERT INTO cas_assertions(id,expected,actual) VALUES(?,?,changes())', [id, s.expectedChanges])); batch.push(this.prepare('DELETE FROM cas_assertions WHERE id=?', [id])); } }
    try { return await this.measure(async () => { const r = await this.rawConnection.batch(batch); if (r.some(x => !x.success)) throw new Error('D1 CAS batch failed'); this.record(r); return true; }, true); }
    catch (e) { if (casMiss(e)) return false; throw e; }
  }
  async close(): Promise<void> {}
}
