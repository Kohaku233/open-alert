import type { SqlDatabase, SqlStatement } from '../contracts/db.js';
import { AUTH_MIGRATIONS } from '../auth/migration-sources.js';
import { APP_MIGRATIONS } from './migration-sources.js';
import { EXPECTED_SCHEMA_CHECKSUMS, type MigrationMarker } from './schema-ready.js';

export interface Migration { version: string; sql: string }
export type MigrationDialect = 'sqlite' | 'postgres';
export interface PreparedMigration extends Migration { checksum: string; statements: readonly SqlStatement[] }
export async function migrationChecksum(sql: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sql));
  return [...new Uint8Array(digest)].map(v => v.toString(16).padStart(2, '0')).join('');
}
export function schemaLedgerSql(dialect: MigrationDialect): string {
  return `CREATE TABLE IF NOT EXISTS schema_migrations (dialect TEXT NOT NULL, version TEXT NOT NULL, checksum TEXT NOT NULL, applied_at ${dialect === 'postgres' ? 'BIGINT' : 'INTEGER'} NOT NULL, PRIMARY KEY(dialect,version))`;
}
/** Auth's explicit marker preserves trigger/function bodies; app files contain simple DDL. */
export async function prepareMigrations(migrations: readonly Migration[], auth = false): Promise<PreparedMigration[]> {
  const versions = new Set<string>();
  for (const migration of migrations) {
    if (!migration.version || versions.has(migration.version)) throw new Error('Duplicate or invalid migration version');
    versions.add(migration.version);
    if (!migration.sql.trim()) throw new Error('Empty migration SQL');
  }
  return Promise.all(migrations.map(async migration => ({ ...migration,
    checksum: await migrationChecksum(migration.sql),
    statements: migration.sql.split(auth ? '--> statement-breakpoint' : ';').map(sql => sql.trim()).filter(Boolean).map(sql => ({ sql })),
  })));
}
export async function readMigrationMarkers(db: SqlDatabase): Promise<MigrationMarker[]> {
  const exists = db.driver === 'postgres'
    ? await db.query("SELECT 1 AS present FROM information_schema.tables WHERE table_schema=current_schema() AND table_name='schema_migrations'")
    : await db.query("SELECT 1 AS present FROM sqlite_schema WHERE type='table' AND name='schema_migrations'");
  return exists.length ? db.query<MigrationMarker>('SELECT dialect,version,checksum,applied_at FROM schema_migrations') : [];
}
/** Validate the entire existing ledger, including migrations outside the stage being applied. */
export function validateMigrationMarkers(markers: readonly MigrationMarker[], dialect: MigrationDialect, expected: Readonly<Record<string, string>>): void {
  const seen = new Set<string>();
  for (const marker of markers) {
    if (marker.dialect !== dialect || !Object.hasOwn(expected, marker.version)) throw new Error('Unknown migration version or dialect');
    if (seen.has(marker.version)) throw new Error('Duplicate migration version in ledger');
    seen.add(marker.version);
    if (marker.checksum !== expected[marker.version]) throw new Error(`Migration checksum mismatch: ${marker.version}`);
    if (!Number.isSafeInteger(marker.applied_at) || marker.applied_at < 0) throw new Error('Invalid migration timestamp');
  }
}
export function migrationStatements(migrations: readonly PreparedMigration[], dialect: MigrationDialect, markers: readonly MigrationMarker[], now: number): SqlStatement[] {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('Invalid migration timestamp');
  const applied = new Set(markers.map(marker => marker.version));
  return migrations.filter(migration => !applied.has(migration.version)).flatMap(migration => [
    ...migration.statements,
    { sql: 'INSERT INTO schema_migrations(dialect,version,checksum,applied_at) VALUES(?,?,?,?)', params: [dialect, migration.version, migration.checksum, now] },
  ]);
}
export async function migrateApp(db: SqlDatabase, now = Date.now(), migrations: readonly Migration[] = APP_MIGRATIONS[db.driver === 'postgres' ? 'postgres' : 'sqlite']): Promise<void> {
  const dialect = db.driver === 'postgres' ? 'postgres' : 'sqlite';
  // Prepare/preflight every migration before even creating the ledger or applying the first DDL.
  const prepared = await prepareMigrations(migrations);
  const expected = { ...EXPECTED_SCHEMA_CHECKSUMS[dialect], ...Object.fromEntries(prepared.map(m => [m.version, m.checksum])) };
  const markers = await readMigrationMarkers(db);
  validateMigrationMarkers(markers, dialect, expected);
  const pending = migrationStatements(prepared, dialect, markers, now);
  if (pending.length) await db.atomic([{ sql: schemaLedgerSql(dialect) }, ...pending]);
}

export interface RegistrationPolicy { maxUsers: number; inviteOnly: boolean }
export function validateRegistrationPolicy(policy: RegistrationPolicy): void {
  if (!Number.isSafeInteger(policy.maxUsers) || policy.maxUsers < 1 || policy.maxUsers > 100_000 || typeof policy.inviteOnly !== 'boolean') throw new Error('Invalid registration policy: maxUsers must be 1..100000 and inviteOnly must be boolean');
}
export interface SchemaObject { name: string; type: string }
export interface D1SchemaState { markers: readonly MigrationMarker[]; objects: readonly SchemaObject[] }
export interface D1MigrationPlan { statements: readonly SqlStatement[]; versions: readonly string[] }

export async function readD1SchemaState(db: SqlDatabase): Promise<D1SchemaState> {
  if (db.driver === 'postgres') throw new Error('D1 migrations require a SQLite/D1 database');
  const objects = await db.query<SchemaObject>("SELECT name,type FROM sqlite_schema WHERE type IN ('table','index','trigger','view')");
  const markers = objects.some(object => object.name === 'schema_migrations' && object.type === 'table')
    ? await db.query<MigrationMarker>('SELECT dialect,version,checksum,applied_at FROM schema_migrations') : [];
  return { objects, markers };
}

function declaredObjects(migration: PreparedMigration): SchemaObject[] {
  return migration.statements.flatMap(({ sql }) => {
    const match = sql.match(/^CREATE\s+(?:UNIQUE\s+)?(TABLE|INDEX|TRIGGER)\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?([A-Za-z_][A-Za-z0-9_]*)/i);
    return match ? [{ type: match[1]!.toLowerCase(), name: match[2]! }] : [];
  });
}
function sqlText(value: string): string { return `'${value.replaceAll("'", "''")}'`; }

/** Pure preflight/planner shared by the Wrangler file transport and actual D1 batch initializer. */
export async function planD1Schema(state: D1SchemaState, policy: RegistrationPolicy, now = Date.now()): Promise<D1MigrationPlan> {
  validateRegistrationPolicy(policy);
  const auth = await prepareMigrations(AUTH_MIGRATIONS.sqlite, true);
  const app = await prepareMigrations(APP_MIGRATIONS.sqlite);
  const migrations = [auth[0]!, app[0]!, auth[1]!, ...app.slice(1)];
  // Catch stale runtime literals in the migration command too.
  for (const migration of migrations) {
    if (migration.checksum !== EXPECTED_SCHEMA_CHECKSUMS.sqlite[migration.version as keyof typeof EXPECTED_SCHEMA_CHECKSUMS.sqlite]) throw new Error('Expected schema checksums need updating');
  }
  validateMigrationMarkers(state.markers, 'sqlite', EXPECTED_SCHEMA_CHECKSUMS.sqlite);
  const applied = new Set(state.markers.map(marker => marker.version));
  let missing = false;
  for (const migration of migrations) {
    if (!applied.has(migration.version)) missing = true;
    else if (missing && migration.version !== '0002_scheduler_indexes') throw new Error('Migration ledger is not an ordered prefix');
    // Node installs app indexes before auth guards; existing D1 installs add them after guards.
    if (migration.version === '0002_scheduler_indexes' && applied.has(migration.version) && !applied.has('0001_app')) throw new Error('Scheduler indexes require app tables');
    for (const object of declaredObjects(migration)) {
      const matches = state.objects.filter(existing => existing.name === object.name);
      if (applied.has(migration.version) ? matches.length !== 1 || matches[0]!.type !== object.type : matches.length !== 0) throw new Error('Partial or conflicting database schema');
    }
  }
  const ledgerObjects = state.objects.filter(object => object.name === 'schema_migrations');
  if (ledgerObjects.length > 1 || ledgerObjects.some(object => object.type !== 'table') || (!ledgerObjects.length && state.markers.length)) throw new Error('Invalid migration ledger');
  const pending = migrationStatements(migrations, 'sqlite', state.markers, now);
  const assertion = `schema_migration_assert_${crypto.randomUUID().replaceAll('-', '')}`;
  const ledgerChecks = state.markers.map(marker => `EXISTS(SELECT 1 FROM schema_migrations WHERE dialect=${sqlText(marker.dialect)} AND version=${sqlText(marker.version)} AND checksum=${sqlText(marker.checksum)} AND applied_at=${marker.applied_at})`);
  // Recheck the preflight snapshot inside the same atomic batch/import before any migration DDL.
  // Concurrent commands may fail and retry; they can never leave a half-applied migration.
  const managed = ['schema_migrations', ...migrations.flatMap(declaredObjects).map(object => object.name)];
  const existing = state.objects.filter(object => managed.includes(object.name));
  const objectChecks = existing.map(object => `EXISTS(SELECT 1 FROM sqlite_schema WHERE name=${sqlText(object.name)} AND type=${sqlText(object.type)})`);
  const assertions: SqlStatement[] = [
    { sql: `CREATE TABLE ${assertion} (ok INTEGER NOT NULL CHECK(ok=1))` },
    { sql: `INSERT INTO ${assertion}(ok) SELECT CASE WHEN (SELECT COUNT(*) FROM sqlite_schema WHERE name IN (${managed.map(sqlText).join(',')}))=${existing.length}${objectChecks.map(check => ` AND ${check}`).join('')} THEN 1 ELSE 0 END` },
    { sql: schemaLedgerSql('sqlite') },
    { sql: `INSERT INTO ${assertion}(ok) SELECT CASE WHEN (SELECT COUNT(*) FROM schema_migrations)=${state.markers.length}${ledgerChecks.map(check => ` AND ${check}`).join('')} THEN 1 ELSE 0 END` },
  ];
  return {
    versions: migrations.filter(migration => !applied.has(migration.version)).map(migration => migration.version),
    statements: [...assertions, ...pending,
      { sql: `INSERT INTO auth_registration_policy(id,max_users,invite_only) VALUES('registration',?,?) ON CONFLICT(id) DO UPDATE SET max_users=excluded.max_users,invite_only=excluded.invite_only`, params: [policy.maxUsers, policy.inviteOnly ? 1 : 0] },
      { sql: `DROP TABLE ${assertion}` }],
  };
}

/** Explicit deployment/test initializer. Never call from a Worker request or isolate startup. */
export async function applyD1Schema(db: SqlDatabase, policy: RegistrationPolicy, now = Date.now()): Promise<readonly string[]> {
  const plan = await planD1Schema(await readD1SchemaState(db), policy, now);
  await db.atomic(plan.statements);
  return plan.versions;
}

/** Wrangler --file uses a transactional local batch or remote D1 import. No BEGIN/COMMIT. */
export function d1MigrationSql(plan: D1MigrationPlan): string {
  return plan.statements.map(statement => {
    let index = 0;
    const sql = statement.sql.replace(/\?/g, () => {
      const value = statement.params?.[index++];
      if (typeof value === 'string') return sqlText(value);
      if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
      throw new Error('Unsupported migration binding');
    });
    if (index !== (statement.params?.length ?? 0)) throw new Error('Migration binding count mismatch');
    return `${sql.trim().replace(/;$/, '')};`;
  }).join('\n\n') + '\n';
}
