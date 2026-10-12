import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db/node.js';
import { createRepositories } from '../src/db/repositories.js';
import { initializeDatabase } from '../src/runtime/common.js';
import { normalizeEmail } from '../src/auth/email.js';
/** Operator-only direct DB invitation; creates no account and grants no admin role. */
try {
  const args=process.argv.slice(2);if(args.length!==1)throw new Error('usage');
  const email=normalizeEmail(args[0]!);const config=loadConfig(process.env);
  if(config.deployment!=='node')throw new Error('deployment');
  const db=await createDb(config);
  try {
    await initializeDatabase(db);
    const invite=await createRepositories(db,config).admin.createInvitation(email,Date.now()+7*86400000,Date.now());
    console.info(`Invitation created for ${invite.email}; expires ${new Date(invite.expiresAt).toISOString()}. Sign in normally, then use the authenticated one-use bootstrap action.`);
  } finally {await db.close();}
} catch {console.error('Invitation failed. Usage: npm run admin:invite -- email@example.com. Check runtime configuration, database access, user capacity and existing invitations.');process.exitCode=1;}
