import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Miniflare } from 'miniflare';
import type { D1Database } from '@cloudflare/workers-types';
import type { SqlDatabase } from '../src/contracts/db.js';
import { D1SqlDatabase } from '../src/db/d1.js';
import { createSQLite } from '../src/db/sqlite.js';
import { AUTH_MIGRATIONS } from '../src/auth/migration-sources.js';
import { APP_MIGRATIONS } from '../src/db/migration-sources.js';
import { migrateAuth } from '../src/auth/migrations.js';
import { applyD1Schema, d1MigrationSql, migrationChecksum, migrateApp, planD1Schema, readD1SchemaState } from '../src/db/migrations.js';
import { EXPECTED_SCHEMA_CHECKSUMS, requireDatabaseSchema, SchemaNotReadyError, type MigrationMarker } from '../src/db/schema-ready.js';
import { parseD1MigrationArgs, parseWranglerOutput } from '../scripts/d1-migrate.js';

const now = 1_800_000_000_000;
const policy = { maxUsers: 5, inviteOnly: true };
function fixtureMarkers(): MigrationMarker[] { return Object.entries(EXPECTED_SCHEMA_CHECKSUMS.sqlite).map(([version, checksum]) => ({ dialect: 'sqlite', version, checksum, applied_at: now })); }
async function snapshot(db: SqlDatabase) {
  const objects = await db.query("SELECT name,type,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name");
  const markers = await readD1SchemaState(db);
  return { objects, markers };
}

test('runtime checksum literals exactly match checked-in SQL in both dialects', async () => {
  for (const dialect of ['sqlite', 'postgres'] as const) {
    for (const migration of [...AUTH_MIGRATIONS[dialect], ...APP_MIGRATIONS[dialect]]) {
      assert.equal(await migrationChecksum(migration.sql), EXPECTED_SCHEMA_CHECKSUMS[dialect][migration.version as keyof typeof EXPECTED_SCHEMA_CHECKSUMS.sqlite]);
    }
  }
});

test('runtime readiness uses exactly one read, validates all markers and never hashes or writes', async () => {
  const fixtures = [fixtureMarkers(), [], fixtureMarkers().slice(0, 2),
    [...fixtureMarkers(), fixtureMarkers()[0]!], fixtureMarkers().map((m, i) => i ? m : { ...m, checksum: 'bad' }),
    fixtureMarkers().map((m, i) => i ? m : { ...m, dialect: 'postgres' }),
    fixtureMarkers().map((m, i) => i ? m : { ...m, version: 'future_version' }),
    fixtureMarkers().map((m, i) => i ? m : { ...m, applied_at: -1 })];
  for (const [index, rows] of fixtures.entries()) {
    let reads = 0;
    const db = { driver: 'd1', query: async (sql: string) => { reads++; assert.equal(sql, 'SELECT dialect,version,checksum,applied_at FROM schema_migrations'); return rows; },
      execute: () => { throw new Error('write forbidden'); }, atomic: () => { throw new Error('write forbidden'); } } as unknown as SqlDatabase;
    if (!index) await requireDatabaseSchema(db); else await assert.rejects(requireDatabaseSchema(db), SchemaNotReadyError);
    assert.equal(reads, 1);
  }
  await assert.rejects(requireDatabaseSchema({ driver: 'd1', query: async () => { throw new Error('missing or unavailable database'); } } as unknown as SqlDatabase), SchemaNotReadyError);
});

test('empty SQLite fails closed; initialization stages auth/app/guards and repeats without DDL', async () => {
  const db = await createSQLite(':memory:', true);
  try {
    await assert.rejects(requireDatabaseSchema(db), SchemaNotReadyError);
    assert.deepEqual(await applyD1Schema(db, policy, now), ['auth_0001_auth', '0001_app', 'auth_0002_registration_guards', '0002_scheduler_indexes']);
    await requireDatabaseSchema(db);
    const before = await snapshot(db);
    assert.deepEqual(await applyD1Schema(db, { maxUsers: 9, inviteOnly: false }, now + 1), []);
    assert.deepEqual(await snapshot(db), before);
    assert.deepEqual((await db.query('SELECT * FROM auth_registration_policy')).map(row => ({ ...row })), [{ id: 'registration', max_users: 9, invite_only: 0 }]);
    assert.equal((await db.query("SELECT name FROM sqlite_schema WHERE name LIKE 'schema_migration_assert_%'")).length, 0);
  } finally { await db.close(); }
});

test('duplicate app versions and later checksum mismatches are rejected before any DDL', async () => {
  const db = await createSQLite(':memory:', true);
  try {
    await assert.rejects(migrateApp(db, now, [{ version: 'new', sql: 'CREATE TABLE must_not_exist(id INTEGER);' }, { version: 'new', sql: 'SELECT 1;' }]), /Duplicate/);
    assert.deepEqual((await readD1SchemaState(db)).objects, []);
    await applyD1Schema(db, policy, now);
    const before = await snapshot(db);
    await assert.rejects(migrateApp(db, now, [{ version: 'new', sql: 'CREATE TABLE must_not_exist(id INTEGER);' }, { version: '0001_app', sql: 'SELECT 1;' }]), /checksum mismatch/);
    assert.deepEqual(await snapshot(db), before);
    await db.execute("UPDATE schema_migrations SET checksum='bad' WHERE version='0001_app'");
    const corrupt = await snapshot(db);
    await assert.rejects(migrateAuth(db, 'tables', now), /checksum mismatch/);
    await assert.rejects(applyD1Schema(db, policy, now), /checksum mismatch/);
    assert.deepEqual(await snapshot(db), corrupt);
  } finally { await db.close(); }
});

test('partial objects, missing objects, foreign/unknown markers and out-of-order markers fail without writes', async () => {
  const db = await createSQLite(':memory:', true);
  try {
    await db.execute('CREATE TABLE "user"(id TEXT PRIMARY KEY)');
    const before = await snapshot(db);
    await assert.rejects(applyD1Schema(db, policy, now), /Partial/);
    assert.deepEqual(await snapshot(db), before);
  } finally { await db.close(); }
  const ready = await createSQLite(':memory:', true);
  try {
    await applyD1Schema(ready, policy, now);
    const original = await readD1SchemaState(ready);
    await assert.rejects(planD1Schema({ ...original, markers: [...original.markers, original.markers[0]!] }, policy, now), /Duplicate/);
    await assert.rejects(planD1Schema({ ...original, markers: original.markers.map((marker, index) => index ? marker : { ...marker, version: 'unknown' }) }, policy, now), /Unknown/);
    await assert.rejects(planD1Schema({ ...original, markers: original.markers.map(marker => ({ ...marker, dialect: 'postgres' })) }, policy, now), /Unknown/);
    await assert.rejects(planD1Schema({ ...original, markers: original.markers.filter(marker => marker.version !== 'auth_0001_auth') }, policy, now), /ordered prefix|Partial/);
    await ready.execute('DROP TRIGGER auth_user_registration_guard');
    const before = await snapshot(ready);
    await assert.rejects(applyD1Schema(ready, policy, now), /Partial/);
    assert.deepEqual(await snapshot(ready), before);
  } finally { await ready.close(); }
});

test('known ordered prefix resumes missing migrations; invalid policy does not mutate', async () => {
  const db = await createSQLite(':memory:', true);
  try {
    await migrateAuth(db, 'tables', now);
    await migrateApp(db, now);
    await assert.rejects(requireDatabaseSchema(db), SchemaNotReadyError);
    const before = await snapshot(db);
    await assert.rejects(applyD1Schema(db, { maxUsers: 0, inviteOnly: true }, now), /Invalid registration/);
    assert.deepEqual(await snapshot(db), before);
    assert.deepEqual(await applyD1Schema(db, policy, now), ['auth_0002_registration_guards']);
    await requireDatabaseSchema(db);
  } finally { await db.close(); }
});

test('actual local workerd D1 applies full schema, guard policy and atomic rollback, including concurrent planners', { timeout: 45_000 }, async () => {
  const mf = new Miniflare({ workers: [{ config: { name: 'schema-test', compatibilityDate: '2026-10-11', manifest: { mainModule: 'index.js', modulesRoot: '/', modules: { 'index.js': { type: 'esm', contents: 'export default { fetch(){return new Response("fixture")} }' } } }, env: { DB: { type: 'd1', id: 'open-alert-schema-local-test' } } } }] });
  try {
    const raw = await mf.getD1Database('DB') as unknown as D1Database;
    const db = new D1SqlDatabase(raw);
    const state = await readD1SchemaState(db);
    const planA = await planD1Schema(state, policy, now), planB = await planD1Schema(state, policy, now);
    const outcomes = await Promise.allSettled([db.atomic(planA.statements), db.atomic(planB.statements)]);
    assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
    await requireDatabaseSchema(db);
    assert.equal((await db.query('SELECT * FROM schema_migrations')).length, 4);
    assert.deepEqual(await applyD1Schema(db, policy, now + 1), []);
    await assert.rejects(db.execute('INSERT INTO "user"(id,name,email,email_verified,role,updated_at) VALUES(?,?,?,?,?,?)', ['one', 'One', 'one@example.test', 1, 'user', now]), /AUTH_INVITATION_REQUIRED/);
    await db.execute('INSERT INTO invitations(id,email,expires_at) VALUES(?,?,?)', ['invite', 'one@example.test', now + 86400_000]);
    await db.execute('INSERT INTO "user"(id,name,email,email_verified,role,updated_at) VALUES(?,?,?,?,?,?)', ['one', 'One', 'one@example.test', 1, 'user', now]);
    assert.equal((await db.query<{ consumed_by: string }>('SELECT consumed_by FROM invitations'))[0]!.consumed_by, 'one');
    const before = await snapshot(db);
    const plan = await planD1Schema(await readD1SchemaState(db), { maxUsers: 10, inviteOnly: false }, now);
    await assert.rejects(db.atomic([...plan.statements, { sql: 'INSERT INTO definitely_missing_table VALUES(1)' }]));
    assert.deepEqual(await snapshot(db), before);
    assert.equal((await db.query<{ max_users: number }>('SELECT max_users FROM auth_registration_policy'))[0]!.max_users, 5);
    assert.equal((await db.query("SELECT name FROM sqlite_schema WHERE name LIKE 'schema_migration_assert_%'")).length, 0);
  } finally { await mf.dispose(); }
});

test('actual local D1 rolls back first-time DDL and markers on a late failure', { timeout: 45_000 }, async () => {
  const mf = new Miniflare({ workers: [{ config: { name: 'schema-rollback-test', compatibilityDate: '2026-10-11', manifest: { mainModule: 'index.js', modulesRoot: '/', modules: { 'index.js': { type: 'esm', contents: 'export default { fetch(){return new Response("fixture")} }' } } }, env: { DB: { type: 'd1', id: 'open-alert-schema-rollback-local-test' } } } }] });
  try {
    const db = new D1SqlDatabase(await mf.getD1Database('DB') as unknown as D1Database);
    const before = await snapshot(db);
    const plan = await planD1Schema(await readD1SchemaState(db), policy, now);
    await assert.rejects(db.atomic([...plan.statements, { sql: 'INSERT INTO definitely_missing_table VALUES(1)' }]));
    assert.deepEqual(await snapshot(db), before);
    await applyD1Schema(db, policy, now);
    await requireDatabaseSchema(db);
  } finally { await mf.dispose(); }
});

test('CLI rejects implicit target/policy, malformed limits, conflicting targets and unknown options', () => {
  const valid = ['--local', '--max-users', '1000', '--invite-only', 'true'];
  assert.deepEqual(parseD1MigrationArgs(valid), { mode: '--local', database: 'open-alert', maxUsers: 1000, inviteOnly: true });
  for (const args of [[], ['--local'], ['--max-users', '1000', '--invite-only', 'true'], [...valid, '--remote'], [...valid, '--local'], [...valid, '--unknown', 'value'], [...valid, '--max-users', '1'], valid.map(v => v === '1000' ? '100001' : v), valid.map(v => v === '1000' ? '1;DROP TABLE user' : v), valid.map(v => v === 'true' ? 'yes' : v), ['--remote', '--max-users', '2', '--invite-only', 'false', '--persist-to', '/tmp/state']]) assert.throws(() => parseD1MigrationArgs(args));
});

test('Wrangler parser accepts plain JSON and remote file progress followed by the complete result array', () => {
  const results = [{ success: true, results: [{ name: 'schema_migrations', type: 'table', note: 'brackets [ ] and escaped "quotes" \\ remain data' }] }, { success: true, results: [] }];
  for (const json of [JSON.stringify(results), JSON.stringify(results, null, 2)]) {
    for (const prefix of ['', '\r\n\t ', 'Checking if file needs uploading\nUploading schema.sql\nProcessing [1/2]...\nExecuted 4 queries\n', 'Uploading complete.\rProcessing complete.\r\n']) {
      assert.deepEqual(parseWranglerOutput(`${prefix}${json}\r\n \t`), results);
    }
  }
});

test('Wrangler parser rejects suffix text, concatenated documents and missing result arrays', () => {
  const json = JSON.stringify([{ success: true, results: [] }]);
  for (const output of ['', 'Progress only\n', `Progress\n${json}\nDone`, `${json} sensitive-suffix`, `${json}\n${json}`, `${json}\n{"error":"failed"}`, '{}', 'null', 'true', '42', '"text"']) {
    assert.throws(() => parseWranglerOutput(output));
  }
});

test('Wrangler parser requires a nonempty array and literal success plus results on every operation', () => {
  for (const result of [[], [null], [true], [[]], [{}], [{ success: false, results: [] }], [{ success: 'true', results: [] }], [{ success: 1, results: [] }], [{ success: true }], [{ success: true, results: {} }], [{ success: true, results: [] }, { success: false, results: [], error: 'SQL failed' }], { success: true, results: [] }]) {
    assert.throws(() => parseWranglerOutput(`Processing complete\n${JSON.stringify(result)}`), { message: 'Wrangler reported an unsuccessful operation' });
  }
});

test('Wrangler parser never salvages a nested success array from failed or maliciously truncated JSON', () => {
  const success = JSON.stringify([{ success: true, results: [] }], null, 2);
  for (const output of [
    `Progress\n${success.slice(0, -1)}`,
    `Progress\n${success.slice(0, -3)}`,
    `Progress\n[\n${success}`,
    `Progress\n[{"success":false,"results":\n${success}`,
    `Progress\n{"error":"failed","results":\n${success}`,
    `Progress\n{"error":"failed","results":\n${success}\n}`,
    `Progress\n[{"success":false,"results":\n${success}\n}]`,
    `Progress\n[{"success":true,"results":[],"note":"unterminated\n${success}`,
    `Progress\n"unterminated\n${success}`,
    `Progress\n[{"success":false,"results":[]},\n${success}\n]`,
    `Progress\n[]\n${success}`,
  ]) assert.throws(() => parseWranglerOutput(output));
});

test('Wrangler parser failures never expose raw progress, SQL errors or secrets', () => {
  const secret = 'fixture-sensitive-token-never-print';
  const success = JSON.stringify([{ success: true, results: [] }]);
  for (const output of [`Uploading https://example.test/?token=${secret}\n${success}\n${secret}`, `Processing ${secret}\n[{"success":true,"results":[],"secret":"${secret}"`, JSON.stringify([{ success: false, results: [], error: `SQL error ${secret}` }]), JSON.stringify({ error: secret })]) {
    assert.throws(() => parseWranglerOutput(output), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(['Invalid Wrangler response', 'Wrangler reported an unsuccessful operation'].includes(error.message));
      assert.equal(`${error.stack}${JSON.stringify(error)}`.includes(secret), false);
      assert.equal(error.cause, undefined);
      return true;
    });
  }
});

test('Wrangler CLI migrates disposable local D1 and emits only a bounded safe summary', { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'open-alert-schema-cli-test-'));
  try {
    const config = join(directory, 'wrangler.jsonc');
    await writeFile(config, JSON.stringify({ name: 'schema-cli-test', compatibility_date: '2026-10-11', d1_databases: [{ binding: 'DB', database_name: 'schema-test', database_id: '00000000-0000-0000-0000-000000000001' }] }));
    const projectRoot = fileURLToPath(new URL('..', import.meta.url));
    const args = ['--import', 'tsx', fileURLToPath(new URL('../scripts/d1-migrate.ts', import.meta.url)), '--local', '--max-users', '7', '--invite-only', 'true', '--database', 'schema-test', '--config', config, '--persist-to', join(directory, 'state')];
    const run = () => spawnSync(process.execPath, args, { cwd: projectRoot, encoding: 'utf8', timeout: 55_000, maxBuffer: 1024 * 1024, env: { ...process.env, CLOUDFLARE_API_TOKEN: 'fixture-secret-never-print', WRANGLER_SEND_METRICS: 'false' } });
    const first = run();
    assert.equal(first.status, 0, first.stderr);
    assert.deepEqual(JSON.parse(first.stdout).versions, ['auth_0001_auth', '0001_app', 'auth_0002_registration_guards', '0002_scheduler_indexes']);
    assert.ok(!`${first.stdout}${first.stderr}`.includes('fixture-secret-never-print'));
    assert.deepEqual(Object.keys(JSON.parse(first.stdout)).sort(), ['inviteOnly', 'maxUsers', 'status', 'versions']);
    assert.ok(!d1MigrationSql(await planD1Schema({ markers: [], objects: [] }, policy, now)).includes('BEGIN TRANSACTION'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});


test('previous three-marker D1 installation upgrades scheduler indexes without rewriting original checksums',async()=>{
 const db=await createSQLite(':memory:',true);
 try{
  await migrateAuth(db,'tables',now);await migrateApp(db,now,[APP_MIGRATIONS.sqlite[0]]);await migrateAuth(db,'guards',now);
  const prior=await db.query<{version:string;checksum:string}>('SELECT version,checksum FROM schema_migrations ORDER BY version');assert.equal(prior.length,3);
  await assert.rejects(requireDatabaseSchema(db),SchemaNotReadyError);
  assert.deepEqual(await applyD1Schema(db,policy,now+1),['0002_scheduler_indexes']);await requireDatabaseSchema(db);
  const current=await db.query<{version:string;checksum:string}>('SELECT version,checksum FROM schema_migrations WHERE version<>? ORDER BY version',['0002_scheduler_indexes']);assert.deepEqual(current,prior);
  assert.deepEqual(await applyD1Schema(db,policy,now+2),[]);
 }finally{await db.close();}
});
