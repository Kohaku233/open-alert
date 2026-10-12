import type { SqlDatabase } from '../contracts/db.js';
import { AUTH_MIGRATIONS } from './migration-sources.js';
import { migrationStatements, prepareMigrations, readMigrationMarkers, schemaLedgerSql, validateMigrationMarkers } from '../db/migrations.js';
import { EXPECTED_SCHEMA_CHECKSUMS } from '../db/schema-ready.js';

/** Stage tables before app FKs; stage guards after invitations/user_settings. Marker preserves SQL function bodies. */
export async function migrateAuth(db: SqlDatabase, stage: 'tables' | 'guards', now = Date.now()): Promise<void> {
  const dialect = db.driver === 'postgres' ? 'postgres' : 'sqlite';
  const prepared = await prepareMigrations(AUTH_MIGRATIONS[dialect], true);
  const markers = await readMigrationMarkers(db);
  const expected = { ...EXPECTED_SCHEMA_CHECKSUMS[dialect], ...Object.fromEntries(prepared.map(m => [m.version, m.checksum])) };
  validateMigrationMarkers(markers, dialect, expected);
  const migration = prepared[stage === 'tables' ? 0 : 1]!;
  if (stage === 'guards' && (!markers.some(marker => marker.version === prepared[0]!.version) || !markers.some(marker => marker.version === '0001_app'))) throw new Error('Auth guards require auth tables and app migrations first');
  const pending = migrationStatements([migration], dialect, markers, now);
  if (pending.length) await db.atomic([{ sql: schemaLedgerSql(dialect) }, ...pending]);
}
