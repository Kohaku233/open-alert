import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { d1MigrationSql, planD1Schema, validateMigrationMarkers, validateRegistrationPolicy, type RegistrationPolicy, type SchemaObject } from '../src/db/migrations.js';
import { EXPECTED_SCHEMA_CHECKSUMS, type MigrationMarker } from '../src/db/schema-ready.js';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const wranglerPath = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url));
export const D1_MIGRATION_USAGE = 'tsx scripts/d1-migrate.ts --local|--remote --max-users 1000 --invite-only true|false [--database open-alert] [--config path] [--persist-to path (local only)]';
export interface D1MigrationArgs extends RegistrationPolicy { mode: '--local' | '--remote'; database: string; config?: string; persistTo?: string }
export function parseD1MigrationArgs(args: readonly string[]): D1MigrationArgs {
  let mode: '--local' | '--remote' | undefined;
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === '--local' || arg === '--remote') {
      if (mode) throw new Error('Exactly one local/remote mode is required');
      mode = arg; continue;
    }
    if (!['--max-users', '--invite-only', '--database', '--config', '--persist-to'].includes(arg) || values.has(arg)) throw new Error('Unknown or duplicate argument');
    const value = args[++index];
    if (!value || value.startsWith('-') || value.includes('\0') || /[\r\n]/.test(value)) throw new Error('Missing or invalid argument');
    values.set(arg, value);
  }
  const users = values.get('--max-users');
  const invited = values.get('--invite-only');
  const database = values.get('--database') ?? 'open-alert';
  if (!mode || !users || !/^[1-9]\d*$/.test(users) || !['true', 'false'].includes(invited ?? '') || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(database)) throw new Error('Explicit target and registration policy are required');
  if (values.has('--persist-to') && mode !== '--local') throw new Error('Persistence path is local only');
  const result: D1MigrationArgs = { mode, database, maxUsers: Number(users), inviteOnly: invited === 'true' };
  validateRegistrationPolicy(result);
  if (values.has('--config')) result.config = resolve(values.get('--config')!);
  if (values.has('--persist-to')) result.persistTo = resolve(values.get('--persist-to')!);
  return result;
}

interface WranglerResult { success: boolean; results: Record<string, unknown>[] }
/** Progress may precede the JSON document; never recover an inner array from a damaged document. */
export function parseWranglerOutput(stdout: string): WranglerResult[] {
  // Wrangler prints its JSON on a new line. Use the first document boundary, not the
  // last '[': a failed/truncated outer document can contain a convincing success array.
  const start = stdout.search(/^[\t ]*(?:[\[{"\d-]|true\b|false\b|null\b)/m);
  if (start === -1) throw new Error('Invalid Wrangler response');
  let parsed: unknown;
  try { parsed = JSON.parse(stdout.slice(start)); } catch { throw new Error('Invalid Wrangler response'); }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some(result => !result || typeof result !== 'object' || Array.isArray(result) || result.success !== true || !Array.isArray(result.results))) throw new Error('Wrangler reported an unsuccessful operation');
  return parsed as WranglerResult[];
}

/** Never inherit Wrangler output: it may contain credentials, URLs, account IDs or SQL errors. */
async function wrangler(args: D1MigrationArgs, operation: readonly string[]): Promise<WranglerResult[]> {
  const argv = [wranglerPath, 'd1', 'execute', args.database, args.mode, '--json', '--yes', ...operation];
  if (args.config) argv.push('--config', args.config);
  if (args.persistTo) argv.push('--persist-to', args.persistTo);
  const stdout = await new Promise<string>((accept, reject) => {
    execFile(process.execPath, argv, {
      cwd: projectRoot, encoding: 'utf8', timeout: 60_000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024,
      env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG_SANITIZE: 'true' },
    }, (error, output) => { if (error) reject(new Error('Wrangler execution failed')); else accept(output); });
  });
  return parseWranglerOutput(stdout);
}

export async function migrateD1WithWrangler(args: D1MigrationArgs): Promise<{ status: 'migrated'; versions: readonly string[]; maxUsers: number; inviteOnly: boolean }> {
  validateRegistrationPolicy(args);
  const objectsResult = await wrangler(args, ['--command', "SELECT name,type FROM sqlite_schema WHERE type IN ('table','index','trigger','view')"]);
  const objects = objectsResult[0]!.results as unknown as SchemaObject[];
  const markers = objects.some(object => object.name === 'schema_migrations' && object.type === 'table')
    ? (await wrangler(args, ['--command', 'SELECT dialect,version,checksum,applied_at FROM schema_migrations']))[0]!.results as unknown as MigrationMarker[] : [];
  const plan = await planD1Schema({ objects, markers }, args);
  const directory = await mkdtemp(join(tmpdir(), 'open-alert-d1-migrate-'));
  try {
    const path = join(directory, 'schema.sql');
    await writeFile(path, d1MigrationSql(plan), { mode: 0o600 });
    // File imports are atomic remotely; Wrangler's local path executes the same file via D1 batch.
    await wrangler(args, ['--file', path]);
  } finally { await rm(directory, { recursive: true, force: true }); }
  const applied = (await wrangler(args, ['--command', 'SELECT dialect,version,checksum,applied_at FROM schema_migrations']))[0]!.results as unknown as MigrationMarker[];
  validateMigrationMarkers(applied, 'sqlite', EXPECTED_SCHEMA_CHECKSUMS.sqlite);
  if (applied.length !== Object.keys(EXPECTED_SCHEMA_CHECKSUMS.sqlite).length) throw new Error('D1 migration did not complete');
  return { status: 'migrated', versions: plan.versions, maxUsers: args.maxUsers, inviteOnly: args.inviteOnly };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseD1MigrationArgs(process.argv.slice(2));
    console.log(JSON.stringify(await migrateD1WithWrangler(args)));
  } catch {
    console.error(`D1 migration failed. Check the selected database, Wrangler access and migration ledger. Usage: ${D1_MIGRATION_USAGE}`);
    process.exitCode = 1;
  }
}
