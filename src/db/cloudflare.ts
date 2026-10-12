import type { AppConfig } from '../config.js';
import type { DbEnvironment, SqlDatabase } from '../contracts/db.js';
import { D1SqlDatabase } from './d1.js';
export async function createDb(config: AppConfig, environment: DbEnvironment): Promise<SqlDatabase> {
  if (config.dbDriver !== 'd1' || config.deployment !== 'cloudflare' || environment.deployment !== 'cloudflare') throw new Error('D1 database factory requires Cloudflare deployment');
  return new D1SqlDatabase(environment.bindings.DB);
}
export { D1SqlDatabase };
