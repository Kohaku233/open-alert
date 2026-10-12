import { spawnSync } from 'node:child_process';
import { normalizeEmail } from '../src/auth/email.js';
// Arguments are validated; invoke Wrangler without a shell and never read deployment secrets.
try {
 const args=process.argv.slice(2),email=normalizeEmail(args[0]??''),mode=args[1];
 if(args.length!==2||!['--local','--remote'].includes(mode??''))throw new Error('usage');
 const id=crypto.randomUUID(),expires=Date.now()+7*86400000;
 const sql=`INSERT INTO invitations(id,email,expires_at) VALUES('${id}','${email.replaceAll("'","''")}',${expires});`;
 const result=spawnSync(process.execPath,['node_modules/wrangler/bin/wrangler.js','d1','execute','open-alert',mode!,'--command',sql],{stdio:'inherit'});
 if(result.status!==0)throw new Error('db');
} catch {console.error('Invitation failed. Usage: npm run admin:invite:d1 -- email@example.com --local|--remote. Initialize D1 migrations first.');process.exitCode=1;}
