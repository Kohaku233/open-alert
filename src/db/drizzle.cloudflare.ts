import { drizzle } from 'drizzle-orm/d1';
import { D1SqlDatabase } from './d1.js';
export function createAuthDrizzle(db: D1SqlDatabase, schema: Record<string, unknown>) { return drizzle(db.rawConnection, { schema }); }
