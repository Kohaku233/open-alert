import {test,mock} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {build} from 'esbuild';
import {Miniflare,Response as MfResponse} from 'miniflare';
import {createPublicCcxtFactory,createPublicCcxtMarketSource} from '../src/markets/ccxt.js';
import {publicExchangeFixture} from './runtime-cloudflare-fixtures.js';

const demand=['binance:spot:BTCUSDT','binance:swap:BTCUSDT','okx:spot:BTC-USDT','BTC-USDT-SWAP','mexc:spot:BTCUSDT','mexc:swap:BTC_USDT'];
test('public CCXT factory: actual loadMarkets/fetchTrades parse all three venues, spot and swap; no native egress',{timeout:20000},async()=>{
 const unexpected:string[]=[],requests:URL[]=[];
 const native=mock.method(globalThis,'fetch',async()=>{throw new Error('native_egress_denied');});
 let at=Date.now();
 const transport:typeof fetch=async(input,init)=>{
  const url=new URL(String(input));requests.push(url);assert.equal(init?.method,'GET');
  const headers=new Headers(init?.headers);for(const name of ['authorization','x-mbx-apikey','x-mexc-apikey','ok-access-key'])assert.equal(headers.has(name),false);
  const fixture=publicExchangeFixture(url,at,1);if(!fixture){unexpected.push(url.href);throw new Error('offline_egress_denied');}return Response.json(fixture.body);
 };
 const source=createPublicCcxtMarketSource({mode:'polling',fetchImplementation:transport,maxDemand:8,requestTimeoutMs:8000,pollBudgetMs:10000,pollIntervalMs:1});
 try {
  await source.refreshCatalog();assert.equal(source.getMarkets().stale,false);assert.equal(source.getMarkets().markets.length,12);
  assert.equal(requests.length,6);assert.deepEqual(source.getPrices(),[]);
  assert.deepEqual(requests.filter(url=>url.hostname.endsWith('.binance.com')).map(url=>[url.hostname,url.pathname]).sort(),[['api-gcp.binance.com','/api/v3/exchangeInfo'],['fapi.binance.com','/fapi/v1/exchangeInfo']]);
  await source.setDemand(demand);at=Date.now();await source.refresh();
  assert.equal(source.getPrices().length,6);assert.equal(source.priceHealth().state,'healthy');
  for(const id of demand){const samples=source.samples(id);assert.equal(samples.length,1,id);assert.equal(samples[0]!.price,100);assert.equal(samples[0]!.timestamp,at);assert.equal(samples[0]!.instrument,id);}
  await new Promise(r=>setTimeout(r,2));await source.refresh();
  for(const id of demand)assert.equal(source.samples(id).length,1,'Exact page replay is deduplicated');
  await source.setDemand([]);const count=requests.length;await source.refresh();assert.equal(requests.length,count,'Idle source does not fetch trades');
  assert.deepEqual(unexpected,[]);assert.equal(native.mock.callCount(),0);
  const factory=createPublicCcxtFactory({fetchImplementation:transport});
  for(const venue of ['binance','okx','mexc'] as const){const pro=factory(venue,{mode:'stream',timeoutMs:8000,tradesLimit:100});assert.equal((await pro).has.watchTrades,true);assert.equal(typeof (await pro).watchTrades,'function');await (await pro).close();}
 } finally {await source.stop();native.mock.restore();}
});

test('workerd HTTP through public CCXT: loadMarkets and fetchTrades for six products, mocked egress and denied unknown hosts',{timeout:30000},async()=>{
 const directory=await mkdtemp(join(tmpdir(),'open-alert-ccxt-workerd-'));
 const entry=join(directory,'probe.ts'),bundle=join(directory,'probe.js');
 // The temporary probe imports the real source. It does not replace CCXT clients,
 // inject normalized markets, patch the app bundle, or access an exchange directly.
 await writeFile(entry,`import {createPublicCcxtMarketSource} from ${JSON.stringify(resolve('src/markets/ccxt.ts'))};
 export default {async fetch(request){
  if(new URL(request.url).pathname==='/denied'){try{const response=await fetch('https://denied.invalid/');return Response.json({denied:!response.ok});}catch{return Response.json({denied:true});}}
  const source=createPublicCcxtMarketSource({mode:'polling',fetchImplementation:globalThis.fetch,maxDemand:8,requestTimeoutMs:8000,pollBudgetMs:10000});
  try {await source.refreshCatalog();await source.setDemand(${JSON.stringify(demand)});await source.refresh();return Response.json({catalog:source.getMarkets(),prices:source.getPrices(),samples:${JSON.stringify(demand)}.map(id=>source.samples(id)),health:source.priceHealth(),diagnostics:source.diagnostics()});}finally{await source.stop();}
 }};`);
 await build({entryPoints:[entry],outfile:bundle,bundle:true,format:'esm',platform:'browser',target:'es2022',minify:true,
  external:['node:*'],alias:{crypto:'node:crypto'},conditions:['workerd','worker','browser'],nodePaths:[resolve('node_modules')]});
 const seen:{kind:string;url:string}[]=[],unexpected:string[]=[],denied:string[]=[];
 const mf=new Miniflare({workers:[{config:{name:'ccxt-http-offline',compatibilityDate:'2026-10-11',compatibilityFlags:['nodejs_compat'],
  manifest:{mainModule:'probe.js',modulesRoot:directory,modules:{'probe.js':{type:'esm',contents:await readFile(bundle,'utf8')}}}},
  dev:{outboundService:{type:'fetcher',handler:async request=>{
   const url=new URL(request.url);
   if(url.hostname==='denied.invalid'){denied.push(url.href);return new MfResponse('offline_egress_denied',{status:599});}
   assert.equal(request.method,'GET');assert.equal(request.headers.has('authorization'),false);assert.equal(request.headers.has('upgrade'),false);
   const fixture=publicExchangeFixture(url,Date.now(),1);
   if(!fixture){unexpected.push(url.href);throw new Error('offline_egress_denied');}
   seen.push({kind:fixture.kind,url:url.href});return MfResponse.json(fixture.body);
  }}}}]});
 try {
  const response=await mf.dispatchFetch('https://probe.internal/sample');assert.equal(response.status,200);
  const data=await response.json() as {catalog:{stale:boolean;markets:unknown[]};prices:{instrument:string;price:number}[];samples:unknown[][];health:{state:string};diagnostics:unknown};
  assert.equal(data.catalog.stale,false,JSON.stringify(data.diagnostics));assert.equal(data.catalog.markets.length,12);
  assert.equal(data.health.state,'healthy',JSON.stringify(data.diagnostics));assert.deepEqual(data.prices.map(p=>p.instrument).sort(),[...demand].sort());
  assert.ok(data.prices.every(p=>p.price===100));assert.ok(data.samples.every(s=>s.length===1));
  assert.equal(seen.filter(r=>r.kind==='catalog').length,6);assert.equal(seen.filter(r=>r.kind==='trades').length,6);
  assert.deepEqual(seen.map(r=>new URL(r.url)).filter(url=>url.hostname.endsWith('.binance.com')).map(url=>[url.hostname,url.pathname]).sort(),[
   ['api-gcp.binance.com','/api/v3/aggTrades'],['api-gcp.binance.com','/api/v3/exchangeInfo'],
   ['fapi.binance.com','/fapi/v1/aggTrades'],['fapi.binance.com','/fapi/v1/exchangeInfo']
  ]);
  const denial=await mf.dispatchFetch('https://probe.internal/denied');assert.deepEqual(await denial.json(),{denied:true});assert.equal(denied.length,1);assert.deepEqual(unexpected,[]);
 } finally {await mf.dispose();await rm(directory,{recursive:true,force:true});}
});

test('Coordinator alarm deletion racing a wake preserves the persisted recovery alarm',async()=>{
 const {Coordinator}=await import('../src/runtime/cloudflare.js');
 const object=Object.create(Coordinator.prototype) as any;
 let alarm:number|null=Date.now()+5000,releaseDelete:()=>void=()=>{},enteredDelete:()=>void=()=>{};
 const deleting=new Promise<void>(r=>{enteredDelete=r;}),holdDelete=new Promise<void>(r=>{releaseDelete=r;});
 const tasks:Promise<void>[]=[];
 object.revision=0;object.active=false;object.running=Promise.resolve();object.alarmWrites=Promise.resolve();
 object.initialized=Promise.resolve({hasWork:async()=>false,invalidate:()=>{}});
 object.state={storage:{getAlarm:async()=>alarm,setAlarm:async(value:number)=>{alarm=value;},deleteAlarm:async()=>{enteredDelete();await holdDelete;alarm=null;}},waitUntil:(promise:Promise<void>)=>tasks.push(promise)};
 const idle=object.reconcile();await deleting;
 const wake=object.fetch(new Request('https://coordinator.internal/wake',{method:'POST'}));
 await Promise.resolve();releaseDelete();await idle;assert.equal((await wake).status,202);await Promise.all(tasks);
 assert.ok(alarm!==null&&alarm>Date.now());assert.equal(object.active,true);
});
