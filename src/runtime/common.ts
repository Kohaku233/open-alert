import { createAuth } from '../auth/index.js';
import type { AuthFactoryOptions } from '../auth/index.js';
import { migrateAuth } from '../auth/migrations.js';
import { createRepositories, migrateApp } from '../db/index.js';
import type { AppConfig } from '../config.js';
import type { SqlDatabase } from '../contracts/db.js';
import { requireDatabaseSchema } from '../db/schema-ready.js';
export async function initializeDatabase(db: SqlDatabase) {
  await migrateAuth(db,'tables');
  await migrateApp(db);
  await migrateAuth(db,'guards');
}
export async function initializeServices(config: AppConfig,db: SqlDatabase,drizzle: Parameters<typeof createAuth>[2],options: AuthFactoryOptions = {}) {
  if (config.deployment === 'cloudflare') await requireDatabaseSchema(db);
  else await initializeDatabase(db);
  const auth=await createAuth(config,db,drizzle,config.deployment === 'cloudflare' ? {...options,registrationPolicy:'require'} : options);
  const repositories=createRepositories(db,config);
  return {config,db,auth,repositories};
}
/** Overwrite internal IP metadata at the HTTP boundary; browser headers are never authoritative. */
export function trustedRequest(request: Request,address: string|null): Request {
  const headers=new Headers(request.headers);headers.delete('x-open-alert-client-ip');
  if(address&&address.length<=64&&!/[\r\n]/.test(address))headers.set('x-open-alert-client-ip',address);
  return new Request(request,{headers});
}
export function unavailableApi(path: string): Response {
  const requestId=crypto.randomUUID();
  if(path==='/api/auth-capabilities')return Response.json({ok:true,data:{google:false,emailOtp:false,registration:'closed',inviteOnly:true,emailProvider:'unconfigured',emailSenderMode:'unconfigured'},requestId},{headers:{'Cache-Control':'no-store'}});
  if(path==='/api/health')return Response.json({ok:true,data:{state:'unhealthy'},requestId},{status:503,headers:{'Cache-Control':'no-store'}});
  if(path.startsWith('/api/auth/'))return Response.json({code:'AUTH_UNAVAILABLE',message:'Deployment configuration is incomplete'},{status:503});
  return Response.json({ok:false,error:{code:'service_unavailable',message:'Deployment configuration is incomplete'},requestId},{status:503,headers:{'Cache-Control':'no-store'}});
}
export const setupHtml = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Open Alert · Setup required</title><style>:root{color-scheme:light}body{margin:0;background:#f3f5f8;color:#142033;font:16px/1.65 system-ui}main{max-width:680px;margin:12vh auto;padding:38px;background:white;border:1px solid #d9e0ea;border-radius:16px}h1{line-height:1.2}code{background:#edf1f7;padding:3px 6px;border-radius:4px}</style><main><p>OPEN ALERT</p><h1>Deployment setup required</h1><p>The server is reachable. Authentication and monitoring are disabled until deployment configuration and email readiness pass.</p><p>Configure <code>APP_URL</code>, <code>AUTH_SECRET</code>, <code>ENCRYPTION_KEY</code> and <code>EMAIL_PROVIDER</code>, then restart. Production needs a verified email sender and HTTPS.</p><p>See the project README and <code>docs/RUNTIME.md</code> for Node, Docker and Cloudflare setup. Health remains unavailable until startup succeeds.</p><button disabled>Sign-in unavailable</button></main></html>`;
