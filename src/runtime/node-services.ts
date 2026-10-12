import type { AppConfig } from '../config.js';
import { createDb } from '../db/node.js';
import { createAuthDrizzle } from '../db/drizzle.node.js';
import { SQLiteDatabase } from '../db/sqlite.js';
import { PostgresDatabase } from '../db/postgres.js';
import * as sqliteSchema from '../auth/schema.sqlite.js';
import * as postgresSchema from '../auth/schema.postgres.js';
import { createNodeEmailTransport } from '../auth/email.node.js';
import { initializeServices } from './common.js';
export async function createNodeServices(config: AppConfig) {
  const db=await createDb(config);
  try {
    const drizzle=db instanceof SQLiteDatabase ? await createAuthDrizzle(db,sqliteSchema) : await createAuthDrizzle(db as PostgresDatabase,postgresSchema);
    return await initializeServices(config,db,drizzle,{emailTransportFactory:createNodeEmailTransport,authSchema:db.driver==='postgres'?postgresSchema:sqliteSchema});
  } catch(error) {await db.close();throw error;}
}
