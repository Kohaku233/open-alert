import type { SqlDatabase } from '../contracts/db.js';

// SHA-256 of the exact checked-in SQL strings. Regression tests verify these literals.
// Keep this module independent of migration-sources: Worker startup must not hash/load DDL.
export const EXPECTED_SCHEMA_CHECKSUMS = {
  sqlite: {
    auth_0001_auth: '59de85d5d12b726fca6f113ad298cfae5063fbde88e4f1f82d775b8d990d2662',
    '0001_app': '1a331e25fb9fc7098d294e74b26ae6ba9a411575b83f5aaad46684989e1e1273',
    '0002_scheduler_indexes': 'c72f0edb3a174c8dde870870dbfde92b01b540c80498c206b61848bfe100ef67',
    auth_0002_registration_guards: 'dcda3b2fd473f7299e13901cbfad367a70803f0adbd3a20d33f1a366adfe2d3d',
  },
  postgres: {
    auth_0001_auth: '5ed9f349aa6ab4b66c5dcdd0caf4bbc440487d7c778e1abbf2ba66422fc7808c',
    '0001_app': '307e08d2ea7203fb3294d601aa80182186cfffa05af570a12ac97e5d2cf03e6a',
    '0002_scheduler_indexes': 'c72f0edb3a174c8dde870870dbfde92b01b540c80498c206b61848bfe100ef67',
    auth_0002_registration_guards: 'cf42911ac5c611ae4070df3dc31ae212e11d4126c5387f8a6d91d21690aec1e0',
  },
} as const;

export interface MigrationMarker { dialect: string; version: string; checksum: string; applied_at: number }
export class SchemaNotReadyError extends Error {
  readonly code = 'schema_not_ready';
  constructor() { super('Database schema is not ready; run the explicit database migration command.'); this.name = 'SchemaNotReadyError'; }
}

/** One read, no writes, no DDL and no runtime SQL hashing. Unknown/duplicate markers fail closed. */
export async function requireDatabaseSchema(db: SqlDatabase): Promise<void> {
  try {
    const dialect = db.driver === 'postgres' ? 'postgres' : 'sqlite';
    const expected: Readonly<Record<string, string>> = EXPECTED_SCHEMA_CHECKSUMS[dialect];
    const rows = await db.query<MigrationMarker>('SELECT dialect,version,checksum,applied_at FROM schema_migrations');
    const seen = new Set<string>();
    if (rows.length !== Object.keys(expected).length) throw new SchemaNotReadyError();
    for (const row of rows) {
      if (row.dialect !== dialect || !Object.hasOwn(expected, row.version) || seen.has(row.version)
        || expected[row.version] !== row.checksum || !Number.isSafeInteger(row.applied_at) || row.applied_at < 0) throw new SchemaNotReadyError();
      seen.add(row.version);
    }
  } catch { throw new SchemaNotReadyError(); }
}
