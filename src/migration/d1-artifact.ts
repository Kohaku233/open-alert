import type { SqlDatabase } from '../contracts/db.js';
import { AUTH_MIGRATIONS } from '../auth/migration-sources.js';
import { APP_MIGRATIONS } from '../db/migration-sources.js';
import { migrationChecksum } from '../db/migrations.js';
import { buildLegacyImportStatements, LegacyMigrationError } from './legacy.js';
import type { LegacyImportOptions, LegacyImportPlan, MigrationStatement } from './legacy.js';
export interface D1MigrationArtifact {
  format: 'open-alert-legacy-d1-v1'; fingerprint: string; stateChecksum: string;
  statements: MigrationStatement[];
  /** SQL for private SQLite rehearsal only. D1 must execute statements via atomicCAS. */
  sqliteRehearsalSql: string;
}
function literal(value: unknown): string {
  if (value === null) return 'NULL';
  if (typeof value === 'number' && Number.isSafeInteger(value) || typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string') return `'${value.replaceAll("'","''")}'`;
  throw new LegacyMigrationError('invalid_sql_value');
}
export async function buildD1Artifact(plan: LegacyImportPlan, options: Pick<LegacyImportOptions,'channelSecrets' | 'encryptionKey' | 'limits'>): Promise<D1MigrationArtifact> {
  const schemaGuards: MigrationStatement[] = [];
  for (const m of [...AUTH_MIGRATIONS.sqlite,...APP_MIGRATIONS.sqlite]) schemaGuards.push({
    sql: 'UPDATE schema_migrations SET applied_at=applied_at WHERE dialect=? AND version=? AND checksum=?',
    params: ['sqlite',m.version,await migrationChecksum(m.sql)], expectedChanges: 1,
  });
  const statements = [...schemaGuards,...await buildLegacyImportStatements(plan,options,'d1')];
  const lines = ['-- PRIVATE: prices, IDs, email, migration metadata and encrypted channel data.',
    '-- SQLite rehearsal only. For D1 use D1SqlDatabase.atomicCAS(statements) in one batch.',
    '-- Do not run statements individually or pass this script directly to wrangler d1 execute.',
    'BEGIN IMMEDIATE;'];
  const assertionId = `legacy:${plan.fingerprint}`;
  for (const s of statements) {
    let index = 0;
    // All statements are generated SQL with placeholders outside quoted literals.
    lines.push(`${s.sql.replace(/\?/g, () => literal(s.params?.[index++]))};`);
    if (index !== (s.params?.length ?? 0)) throw new LegacyMigrationError('invalid_sql_binding_count');
    if (s.expectedChanges !== undefined) lines.push(`INSERT INTO cas_assertions(id,expected,actual) VALUES(${literal(assertionId)},${s.expectedChanges},changes());`,
      `DELETE FROM cas_assertions WHERE id=${literal(assertionId)};`);
  }
  lines.push('COMMIT;');
  return { format:'open-alert-legacy-d1-v1',fingerprint:plan.fingerprint,stateChecksum:plan.stateChecksum,statements,sqliteRehearsalSql:lines.join('\n')+'\n' };
}
/** Trusted offline artifact only. Operator supplies a D1 adapter, never a public import route. */
export async function applyD1Artifact(db: SqlDatabase, artifact: D1MigrationArtifact): Promise<void> {
  if (db.driver !== 'd1' || artifact.format !== 'open-alert-legacy-d1-v1') throw new LegacyMigrationError('invalid_d1_artifact');
  if (!await db.atomicCAS(artifact.statements)) throw new LegacyMigrationError('d1_target_changed');
}
