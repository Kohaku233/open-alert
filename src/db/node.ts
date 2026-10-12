import type { AppConfig } from '../config.js';
import type { DbEnvironment, SqlDatabase } from '../contracts/db.js';
import { createSQLite } from './sqlite.js';
import { createPostgres } from './postgres.js';
export async function createDb(config: AppConfig, environment: DbEnvironment = { deployment: 'node' }): Promise<SqlDatabase> {
  if (environment.deployment !== 'node' || config.deployment !== 'node') throw new Error('Node database factory requires Node deployment');
  if (config.dbDriver === 'sqlite') return createSQLite(config.sqlitePath);
  if (config.dbDriver === 'postgres' && config.databaseUrl) return createPostgres(config.databaseUrl);
  throw new Error('Invalid Node database driver');
}
export { createSQLite, createPostgres };
