import test from 'node:test';
import assert from 'node:assert/strict';
import {createCcxtMarketSource} from '../src/markets/source.js';
import type {CcxtExchange, MarketSourceOptions} from '../src/markets/source.js';
import {createPublicCcxtMarketSource} from '../src/markets/ccxt.js';
import {publicExchangeFixture} from './runtime-cloudflare-fixtures.js';
import type {MarketType} from '../src/contracts/domain.js';
const spot='binance:spot:BTCUSDT',swap='binance:swap:BTCUSDT',initial=1700000000000;
function fixture(extra:Partial<MarketSourceOptions>={}) {
 let at=initial;const clients:{product:MarketType;closed:number;fail:boolean;rows:any;calls:number}[]=[];
 const source=createCcxtMarketSource({mode:'polling',venues:['binance'],splitProducts:['binance'],now:()=>at,catalogTtlMs:100,retryBaseMs:1,retryMaxMs:10,pollIntervalMs:1,closeTimeoutMs:1,...extra,
 factory:(_venue,settings)=>{const product=settings.product!;const client={product,closed:0,fail:false,calls:0,rows:{}};const isSwap=product==='swap',symbol=`BTC/USDT${isSwap?':USDT':''}`;
 client.rows={[symbol]:{id:'BTCUSDT',symbol,base:'BTC',quote:'USDT',type:product,spot:!isSwap,swap:isSwap,active:true,future:false,option:false,contract:isSwap,linear:isSwap||undefined,inverse:isSwap?false:undefined,settle:isSwap?'USDT':undefined,contractSize:isSwap?0.01:undefined,precision:{price:0.1}}};clients.push(client);
 return {precisionMode:4,has:{fetchTrades:true,watchTrades:true},loadMarkets:async()=>{if(client.fail)throw Error('blocked');return client.rows;},fetchTrades:async()=>{client.calls++;return [{id:String(at),timestamp:at,price:isSwap?200:100,symbol,amount:1}];},watchTrades:async()=>new Promise(()=>{}),close:async()=>{client.closed++;}} satisfies CcxtExchange;}});
 return {source,clients,advance:(ms=1)=>{at+=ms;},current:(type:MarketType)=>clients.filter(c=>c.product===type).at(-1)!};
}
test('split products preserve healthy samples and metadata through isolated catalog failure and recovery',async()=>{
 const f=fixture();try{await f.source.refreshCatalog();await f.source.setDemand([spot,swap]);await f.source.refresh();assert.equal(f.source.diagnostics().queued,2);
 f.advance(100);f.current('swap').fail=true;await f.source.refreshCatalog();assert.equal(f.source.eligible(spot),true);assert.equal(f.source.eligible(swap),false);assert.equal(f.source.samples(spot).length,1);assert.equal(f.source.samples(swap).length,0);
 const retained=f.source.getMarkets().markets.find(m=>m.instrument===swap)!;assert.equal(retained.available,false);assert.equal(retained.state,'live');assert.notEqual(f.source.diagnostics().instruments.find(d=>d.instrument===swap)?.code,'market_delisted');
 f.advance();await f.source.refresh();assert.equal(f.source.eligible(swap),true);assert.equal(f.source.ticks().get(swap)?.price,200);assert.equal(f.source.samples(spot).length,2);
 }finally{await f.source.stop();assert(f.clients.every(c=>c.closed===1));}
});
test('shared venue request budget alternates products and global demand and queue bounds hold',async()=>{
 const f=fixture({maxPollRequestsPerVenue:1,maxDemand:2,maxQueue:1});try{await f.source.refreshCatalog();await assert.rejects(f.source.setDemand([spot,swap,'binance:spot:ETHUSDT']),/demand_capacity/);assert.equal(f.source.diagnostics().instruments.length,0);await f.source.setDemand([spot,swap]);await f.source.refresh();assert.deepEqual(f.clients.map(c=>c.calls),[1,0]);assert.equal(f.source.diagnostics().queued,1);
 f.advance();await f.source.refresh();assert.deepEqual(f.clients.map(c=>c.calls),[1,1]);assert.equal(f.source.diagnostics().queued,1);assert.equal(f.source.eligible(swap),false);assert.equal(f.source.eligible(spot),true);
 }finally{await f.source.stop();}
});
test('split catalogs retain one venue capacity and wrong-product snapshots fail closed',async()=>{
 const f=fixture({maxCatalogMarkets:1});try{await f.source.refreshCatalog();assert.equal(f.source.getMarkets().markets.length,1);const sources=f.source.getMarkets().sources;assert(Array.isArray(sources));assert.equal(sources.length,2);assert.equal(f.source.getMarkets().stale,true);}finally{await f.source.stop();}
 const g=fixture();try{await g.source.refreshCatalog();g.advance(100);g.current('swap').rows=g.current('spot').rows;await g.source.refreshCatalog();assert.equal(g.source.eligible(spot),true);assert.equal(g.source.eligible(swap),false);assert.equal(g.source.getMarkets().markets.filter(m=>m.instrument===spot).length,1);}finally{await g.source.stop();}
});
test('stream subscription and disconnect in futures preserve accepted spot observations',async()=>{
 let at=initial;const pending=new Map<MarketType,((value:unknown)=>void)[]>(),failures=new Map<MarketType,((error:Error)=>void)[]>();const closed:MarketType[]=[];
 const source=createCcxtMarketSource({mode:'stream',venues:['binance'],splitProducts:['binance'],now:()=>at,closeTimeoutMs:1,
 factory:(_venue,{product})=>{const type=product!,isSwap=type==='swap',symbol=`BTC/USDT${isSwap?':USDT':''}`;return {precisionMode:4,has:{watchTrades:true,fetchTrades:true},loadMarkets:async()=>({[symbol]:{id:'BTCUSDT',symbol,base:'BTC',quote:'USDT',type,spot:!isSwap,swap:isSwap,active:true,future:false,option:false,contract:isSwap,linear:isSwap||undefined,inverse:isSwap?false:undefined,settle:isSwap?'USDT':undefined,contractSize:isSwap?0.01:undefined,precision:{price:0.1}}}),fetchTrades:async()=>[],watchTrades:async()=>new Promise((resolve,reject)=>{pending.set(type,[...pending.get(type)??[],resolve]);failures.set(type,[...failures.get(type)??[],reject]);}),close:async()=>{closed.push(type);}};}});
 const wait=async(check:()=>boolean)=>{for(let n=0;n<40&&!check();n++)await new Promise(resolve=>setTimeout(resolve,2));assert(check());};
 try{await source.refreshCatalog();await source.setDemand([spot]);await source.refresh();await wait(()=>pending.has('spot'));pending.get('spot')![0]!([{id:'spot1',price:100,symbol:'BTC/USDT',timestamp:at,amount:1}]);await wait(()=>source.samples(spot).length===1);
 const spotCloses=closed.filter(t=>t==='spot').length;await source.setDemand([spot,swap]);assert.equal(closed.filter(t=>t==='spot').length,spotCloses);assert.equal(source.samples(spot).length,1);await source.refresh();await wait(()=>failures.has('swap'));failures.get('swap')![0]!(Error('disconnect'));await wait(()=>source.diagnostics().venues.find(v=>v.type==='swap')?.priceCode==='stream_unavailable');assert.equal(source.samples(spot).length,1);assert.equal(source.ticks().get(spot)?.price,100);assert.equal(closed.filter(t=>t==='spot').length,spotCloses);
 at++;source.acknowledgeSamples(spot,source.samples(spot));assert.equal(source.samples(spot).length,0);
 }finally{await source.stop();}
});

test('real public CCXT factory loads spot when futures is 403, then recovers futures without retiring spot',async()=>{
 let at=Date.now(),blocked=true;const calls:string[]=[];
 const source=createPublicCcxtMarketSource({mode:'polling',venues:['binance'],now:()=>at,catalogTtlMs:100,retryBaseMs:1,retryMaxMs:10,pollIntervalMs:1,closeTimeoutMs:10,
 fetchImplementation:async(input)=>{const url=new URL(String(input));calls.push(url.hostname+url.pathname);if(blocked&&url.hostname==='fapi.binance.com')return new Response('Request blocked',{status:403});const f=publicExchangeFixture(url,at,calls.length);assert(f,'unexpected egress '+url);return Response.json(f.body);}});
 try{await source.refreshCatalog();assert.equal(source.eligible(spot),true);assert.equal(source.eligible(swap),false);await source.setDemand([spot,swap]);await source.refresh();assert.equal(source.ticks().get(spot)?.price,100);assert.equal(source.ticks().has(swap),false);assert(calls.includes('api-gcp.binance.com/api/v3/aggTrades'));assert(!calls.includes('fapi.binance.com/fapi/v1/aggTrades'));
 blocked=false;at++;await source.refresh();assert.equal(source.eligible(swap),true);assert.equal(source.ticks().get(swap)?.price,100);assert.equal(source.samples(spot).length,2);assert(calls.includes('fapi.binance.com/fapi/v1/aggTrades'));assert.equal(calls.filter(c=>c==='api-gcp.binance.com/api/v3/exchangeInfo').length,1);
 }finally{await source.stop();}
});
