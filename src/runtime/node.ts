import { serve } from '@hono/node-server';
import { readFile } from 'node:fs/promises';
import { resolve,extname,sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { ConfigurationError, loadConfig } from '../config.js';
import { createApp } from '../api/index.js';
import { createNodeServices } from './node-services.js';
import { createApiNotifications } from './notifications.js';
import { setupHtml,trustedRequest,unavailableApi } from './common.js';
import { createNotificationService } from '../notifications/index.js';
import { createScheduler } from '../scheduler/index.js';
import { createPublicCcxtMarketSource } from '../markets/ccxt.js';
import { createMarketQuoteService } from '../markets/quotes.js';
import { createPublicMarketPreview } from '../markets/public-preview.js';
import { createObservability } from './observability.js';
import { createLiveQuoteHub } from '../markets/live-quotes.js';
import { createRealtimeGateway, REALTIME_PATH } from './realtime.js';
const types: Record<string,string>={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon','.woff2':'font/woff2'};
export async function serveAssets(request: Request,root=resolve('dist/web')): Promise<Response> {
  if(!['GET','HEAD'].includes(request.method))return new Response('Method not allowed',{status:405});
  let path:string;try{path=decodeURIComponent(new URL(request.url).pathname);}catch{return new Response('Bad request',{status:400});}
  if(path.includes('\0')||path.includes('\\'))return new Response('Not found',{status:404});
  const file=resolve(root,'.'+path);
  if(file!==root&&!file.startsWith(root+sep))return new Response('Not found',{status:404});
  let content:Uint8Array,extension=extname(file);
  try {content=await readFile(file);}catch {
    if(extension)return new Response('Not found',{status:404});
    try {content=await readFile(resolve(root,'index.html'));extension='.html';}
    catch {return new Response('Build the web app with npm run build:web',{status:503});}
  }
  return new Response(request.method==='HEAD'?null:new Uint8Array(content),{headers:{'Content-Type':types[extension]??'application/octet-stream','X-Content-Type-Options':'nosniff','Cache-Control':extension==='.html'?'no-cache':'public, max-age=3600'}});
}
export async function createNodeRuntime(env: Record<string,unknown>=process.env) {
  const config=loadConfig(env);if(config.deployment!=='node')throw new ConfigurationError(['DEPLOYMENT']);
  const services=await createNodeServices(config);
  const notifications=createApiNotifications(config);
  const binanceEndpoints=config.binanceEndpoints;
  const quotes=createMarketQuoteService({binanceEndpoints});
  // Alert state changes reach open dashboards immediately; bound to the gateway below.
  let notifyUser:(userId:string)=>void=()=>{};
  const engine=createScheduler({...services,notifications:createNotificationService({...services,provider:notifications}),onUserActivity:userId=>notifyUser(userId),
    marketSource:createPublicCcxtMarketSource({mode:'stream',maxDemand:config.limits.globalInstruments,binanceEndpoints})});
  const monitor=createObservability({engine,db:services.db,cronRequired:false,probe:()=>({at:Date.now(),api:{state:'healthy',code:null,lastSuccessAt:Date.now()},email:services.auth.emailHealth()})});
  let monitorWork:ReturnType<typeof monitor.capture>|null=null;
  const observe=()=>{if(monitorWork)return monitorWork;monitorWork=engine.hasWork().catch(()=>monitor.pulse()).then(()=>monitor.capture()).finally(()=>{monitorWork=null;});return monitorWork;};
  const app=createApp({...services,notifications,quotes,publicPreview:createPublicMarketPreview({read:market=>quotes.recent(market)}),catalog:{get:async()=>{await engine.refreshCatalog();return engine.getMarkets();},resolve:async instrument=>{await engine.refreshCatalog();return engine.resolveMarket(instrument);}},runtime:{snapshot:async()=>({...await engine.snapshot(),marketMode:'stream' as const}),observe},wake:async()=>{engine.invalidate();void engine.tick().then(()=>engine.drain()).catch(()=>{});}});
  const live=createLiveQuoteHub({snapshot:market=>quotes.get(market),binanceEndpoints});
  const realtime=createRealtimeGateway({trustedOrigins:config.trustedOrigins,hub:live,
    authenticate:request=>services.auth.getPrincipal(request),
    resolve:async instrument=>{await engine.refreshCatalog();return engine.resolveMarket(instrument);}});
  notifyUser=userId=>realtime.notifyUser(userId);
  let started=false,monitorTimer:ReturnType<typeof setInterval>|undefined;
  return {
    config,services,engine,app,realtime,
    fetch:async(request: Request,address:string|null=null)=>{const r=trustedRequest(request,address);return new URL(r.url).pathname.startsWith('/api/')?app.fetch(r):serveAssets(r);},
    start(){if(!started){started=true;engine.start();const inspect=()=>{void observe().catch(()=>console.error('open_alert_monitor_failed'));};inspect();monitorTimer=setInterval(inspect,60000);}},
    async stop(){clearInterval(monitorTimer);await monitorWork?.catch(()=>{});await realtime.close();await live.stop();await quotes.stop();await engine.stop();services.auth.close();await services.db.close();},
  };
}
export async function startNode(env: Record<string,unknown>=process.env) {
  let runtime:Awaited<ReturnType<typeof createNodeRuntime>>|null=null;
  try {runtime=await createNodeRuntime(env);runtime.start();}
  catch(error) {console.error(error instanceof ConfigurationError?error.message:'Open Alert startup unavailable: database or email configuration/readiness failed');}
  const fallbackPort=Number(env.PORT??3000);const port=runtime?.config.port??(Number.isInteger(fallbackPort)&&fallbackPort>0&&fallbackPort<=65535?fallbackPort:3000);
  const server=serve({port,hostname:'0.0.0.0',fetch:(request,context)=> {
    if(!runtime){const path=new URL(request.url).pathname;return path.startsWith('/api/')?unavailableApi(path):new Response(setupHtml,{status:503,headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'}});}
    const incoming=(context as {incoming?: IncomingMessage}).incoming;
    return runtime.fetch(request,incoming?.socket.remoteAddress??null);
  }});
  // The browser realtime channel shares the HTTP port; every other upgrade path is refused.
  server.on('upgrade',(request:IncomingMessage,socket:Duplex,head:Buffer)=>{
    const path=new URL(request.url??'/','http://localhost').pathname;
    if(runtime&&path===REALTIME_PATH)runtime.realtime.handleUpgrade(request,socket,head);
    else{socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');socket.destroy();}
  });
  console.info(`Open Alert HTTP server listening on port ${port}; setup ${runtime?'ready':'required'}`);
  let stopping=false;
  const stop=async()=>{if(stopping)return;stopping=true;server.close();await runtime?.stop();};
  for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>{void stop().catch(()=>{process.exitCode=1;});});
  return {server,runtime,stop};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)await startNode();
