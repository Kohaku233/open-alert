import type { D1Database } from '@cloudflare/workers-types';
import type { SqlDatabase, SqlStatement, SqlValue } from '../contracts/db.js';
import { bindings } from './sql.js';
export class D1SqlDatabase implements SqlDatabase {
  readonly driver = 'd1' as const;
  constructor(readonly rawConnection: D1Database) {}
  private prepare(sql: string, params?: readonly SqlValue[]) { return this.rawConnection.prepare(sql).bind(...bindings(params).map(v => v instanceof Uint8Array ? Array.from(v) : v)); }
  async query<T extends object>(sql: string, params?: readonly SqlValue[]): Promise<T[]> { const r = await this.prepare(sql, params).all<T>(); if (!r.success) throw new Error('D1 query failed'); return r.results; }
  async execute(sql: string, params?: readonly SqlValue[]): Promise<{ changes: number }> { const r = await this.prepare(sql, params).run(); if (!r.success) throw new Error('D1 execute failed'); return { changes: r.meta.changes }; }
  async atomic(statements: readonly SqlStatement[]): Promise<number[]> { if (!statements.length) return []; const results = await this.rawConnection.batch(statements.map(s => this.prepare(s.sql, s.params))); if (results.some(r => !r.success)) throw new Error('D1 batch failed'); return results.map(r => r.meta.changes); }
  async atomicCAS(statements: readonly (SqlStatement & { expectedChanges?: number })[]): Promise<boolean> {
    if (!statements.length) return true;
    // changes() references the immediately previous mutation. A CHECK failure rolls back the entire D1 batch.
    const id = crypto.randomUUID(); const batch = [];
    for (const s of statements) { batch.push(this.prepare(s.sql, s.params)); if (s.expectedChanges !== undefined) { batch.push(this.prepare('INSERT INTO cas_assertions(id,expected,actual) VALUES(?,?,changes())', [id, s.expectedChanges])); batch.push(this.prepare('DELETE FROM cas_assertions WHERE id=?', [id])); } }
    try { const r = await this.rawConnection.batch(batch); if (r.some(x => !x.success)) throw new Error('D1 CAS batch failed'); return true; }
    catch (e) { if (/CHECK constraint failed.*(?:cas_assertions|expected\s*=\s*actual)/i.test(String(e))) return false; throw e; }
  }
  async close(): Promise<void> {}
}
