import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApi } from '../src/api/index.js';
import type { ApiDependencies, CatalogSnapshot, CatalogMarket } from '../src/api/ports.js';
import { loadConfig } from '../src/config.js';
import type { AlertRecord, OutboxRecord, Repositories, UserSettingsRecord } from '../src/contracts/db.js';
import type { Market } from '../src/contracts/domain.js';
import { DEFAULT_NOTIFICATION } from '../src/contracts/domain.js';
import { createNotificationService, notificationMarketLabel } from '../src/notifications/service.js';

const config=loadConfig({NODE_ENV:'test',APP_URL:'http://localhost:3000',AUTH_SECRET:'market-api-fixture-secret-at-least-thirty-two-characters',ENCRYPTION_KEY:'12'.repeat(32),EMAIL_PROVIDER:'console'});
type Venue='binance'|'okx'|'mexc';
type Product='spot'|'swap';
const market=(instrument:string,venue:Venue,type:Product,base='BTC',available?:boolean):CatalogMarket=>({instrument,venue,type,base,quote:'USDT',nativeId:instrument.split(':').at(-1)!,symbol:`${base}/USDT${type==='swap'?':USDT':''}`,tickSize:'0.1',state:'live',tradingViewSymbol:'',...(available===undefined?{}:{available})});
const markets=[market('BTC-USDT-SWAP','okx','swap'),market('okx:spot:BTC-USDT','okx','spot'),market('binance:swap:BTCUSDT','binance','swap'),market('binance:spot:BTCUSDT','binance','spot'),market('mexc:swap:BTC_USDT','mexc','swap'),market('mexc:spot:BTCUSDT','mexc','spot'),market('ETH-USDT-SWAP','okx','swap','ETH')];
const input={name:'BTC ceiling',instrument:'BTC-USDT-SWAP',side:'upper' as const,threshold:100,enabled:true};
function fixture() {
 let catalog:CatalogSnapshot={markets:markets.map(m=>({...m})),updatedAt:1000,stale:false};
 let catalogReads=0,wakes=0,writes=0,anonymous=false;
 const records=new Map<string,AlertRecord>();
 const settings:UserSettingsRecord={userId:'alice',generation:0,disabled:false,enabled:false,dailyLimit:20,notification:DEFAULT_NOTIFICATION};
 const alert=(id:string,instrument:string,enabled=true):AlertRecord=>({id,userId:'alice',name:'old label',instrument,side:'upper',threshold:100,enabled,generation:0,triggered:false,triggerId:null,pendingTriggerId:null,createdAt:1000,updatedAt:1000,deletedAt:null});
 const dependencies={
  config,
  db:{query:async()=>[{last_request:Date.now()}]},
  auth:{getPrincipal:async()=>anonymous?null:{userId:'alice',role:'user',sessionId:'fixture'}},
  repositories:{
   settings:{get:async()=>({...settings}),initialize:async()=>({...settings})},
   alerts:{
    getForUser:async(userId:string,id:string)=>{const a=records.get(id);return a?.userId===userId?{...a}:null;},
    create:async(userId:string,body:typeof input)=>{writes++;const a={...alert(crypto.randomUUID(),body.instrument),...body,userId};records.set(a.id,a);return a;},
    patch:async(userId:string,id:string,generation:number,patch:Partial<AlertRecord>)=>{writes++;const a={...records.get(id)!,...patch,generation:generation+1};records.set(id,a);return a;},
    rearm:async(userId:string,id:string,generation:number)=>{writes++;const a={...records.get(id)!,triggered:false,triggerId:null,generation:generation+1};records.set(id,a);return a;},
   },
   outbox:{lastForAlert:async()=>null},
  },
  catalog:{get:async()=>{catalogReads++;return catalog;}},
  wake:async()=>{wakes++;},
 } as unknown as ApiDependencies;
 const app=createApi(dependencies);
 const call=(path:string,method='GET',body?:unknown)=>app.request(`${config.appUrl}${path}`,{method,headers:{Origin:config.appUrl,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
 const data=async(path:string)=>{const response=await call(path);assert.equal(response.status,200,await response.clone().text());return (await response.json() as any).data;};
 return {dependencies,call,data,records,alert,setCatalog:(value:CatalogSnapshot)=>{catalog=value;},catalog:()=>catalog,reads:()=>catalogReads,writes:()=>writes,wakes:()=>wakes,setAnonymous:()=>{anonymous=true;}};
}

test('coordinator directory response streams after authentication and query validation without a second catalog parse',async()=>{
 const f=fixture();let calls=0;
 f.dependencies.catalog.response=async(query,requestId)=>{
  calls++;assert.match(requestId,/^[0-9a-f-]{36}$/);
  if(query){assert.equal(query.venue,'mexc');assert.equal(query.limit,3);}
  const body=JSON.stringify({ok:true,data:{markets:Array.from({length:10000},()=>markets[0]),stale:false,updatedAt:1000},requestId});
  const response=new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode(body));controller.close();}}),{headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
  response.json=async()=>{assert.fail('Edge must not parse the coordinator directory');};
  response.text=async()=>{assert.fail('Edge must not buffer the coordinator directory');};
  return response;
 };
 const response=await f.call('/api/markets');assert.equal(response.status,200);
 assert.equal(response.headers.get('cache-control'),'no-store');
 assert.equal(response.headers.get('X-Content-Type-Options'),'nosniff');
 const envelope=JSON.parse(new TextDecoder().decode(await response.arrayBuffer()));
 assert.equal(envelope.data.markets.length,10000);assert.equal(envelope.requestId,response.headers.get('X-Request-ID'));
 assert.equal((await f.call('/api/markets?venue=mexc&limit=3')).status,200);
 assert.equal(f.reads(),0);assert.equal(calls,2);
 assert.equal((await f.call('/api/markets?limit=1000')).status,400);
 assert.equal((await f.call('/api/markets?venue=mexc&venue=okx')).status,400);
 assert.equal(calls,2);
 f.setAnonymous();assert.equal((await f.call('/api/markets')).status,401);assert.equal(calls,2);
});

test('market directory stays complete, bounded search filters venue/product and exact lookup never aliases a market',async()=>{
 const f=fixture();
 const directory=await f.data('/api/markets');assert.equal(directory.markets.length,markets.length);assert.equal(directory.total,undefined);
 const search=await f.data('/api/markets?q=btc&venue=binance&type=swap&limit=1&offset=0');
 assert.equal(search.total,1);assert.equal(search.limit,1);assert.equal(search.offset,0);assert.deepEqual(search.markets.map((m:Market)=>m.instrument),['binance:swap:BTCUSDT']);
 const first=await f.data('/api/markets?q=btc&limit=2'),second=await f.data('/api/markets?q=BTC&limit=2&offset=2');
 assert.equal(first.total,6);assert.equal(second.total,6);assert.equal(new Set([...first.markets,...second.markets].map((m:Market)=>m.instrument)).size,4);
 for(const m of markets){const exact=await f.data(`/api/markets?instrument=${encodeURIComponent(m.instrument)}`);assert.equal(exact.total,1);assert.equal(exact.markets[0].instrument,m.instrument);}
 const missing=await f.data('/api/markets?instrument=FAKE-USDT-SWAP');assert.equal(missing.total,0);
 const filtered=await f.data('/api/markets?instrument=BTC-USDT-SWAP&venue=binance');assert.equal(filtered.total,0);
 const encoded=market('mexc:swap:BTC%2FUSDT%3AUSDT','mexc','swap');
 f.setCatalog({...f.catalog(),markets:[...markets,encoded]});
 const encodedLookup=await f.data(`/api/markets?instrument=${encodeURIComponent(encoded.instrument)}`);assert.equal(encodedLookup.total,1);assert.equal(encodedLookup.markets[0].instrument,encoded.instrument);
 f.setCatalog({...f.catalog(),markets});
 const empty=await f.data('/api/markets?q=not-a-market');assert.equal(empty.total,0);assert.deepEqual(empty.markets,[]);
 const beyond=await f.data('/api/markets?q=btc&offset=100000');assert.equal(beyond.total,6);assert.deepEqual(beyond.markets,[]);
 assert.equal(f.writes(),0);assert.equal(f.wakes(),0);
});

test('product-specific outage keeps Binance spot usable and missing failed futures returns 503',async()=>{
 const f=fixture();f.setCatalog({...f.catalog(),stale:true,markets:markets.filter(m=>m.instrument!=='binance:swap:BTCUSDT'),sources:[{venue:'binance',type:'spot',updatedAt:1000,stale:false},{venue:'binance',type:'swap',updatedAt:null,stale:true,code:'catalog_unavailable'},{venue:'okx',updatedAt:1000,stale:false},{venue:'mexc',updatedAt:1000,stale:false}]});
 const choices=await f.data('/api/markets?q=btc&venue=binance');assert.deepEqual(choices.markets.map((m:Market)=>m.instrument),['binance:spot:BTCUSDT']);assert.equal((await f.call('/api/alerts','POST',{...input,instrument:'binance:spot:BTCUSDT'})).status,201);
 assert.equal((await f.call('/api/alerts','POST',{...input,instrument:'binance:swap:BTCUSDT'})).status,503);assert.equal((await f.call('/api/alerts','POST',{...input,instrument:'binance:spot:FAKEUSDT'})).status,400);assert.equal(f.writes(),1);
 f.setCatalog({...f.catalog(),markets:[...f.catalog().markets,market('binance:swap:BTCUSDT','binance','swap')]});const exact=await f.data('/api/markets?instrument=binance%3Aswap%3ABTCUSDT');assert.equal(exact.markets[0].available,false);
 const old=f.alert('retained-futures','binance:swap:BTCUSDT',false);f.records.set(old.id,old);assert.equal((await f.call('/api/alerts/retained-futures','PATCH',{expectedGeneration:0,enabled:true})).status,503);assert.equal((await f.call('/api/alerts/retained-futures/rearm','POST',{expectedGeneration:0})).status,503);
});

test('invalid bounded search fails before catalog access and still requires authentication',async()=>{
 const f=fixture();
 for(const query of [`q=${'a'.repeat(81)}`,'venue=bybit','venue=OKX','type=future','type=SPOT','limit=101','limit=0','limit=1.1','limit=1e2','limit=','limit=-1','offset=-1','offset=100001','offset=1.5','offset=Infinity','q=a&q=b','venue=okx&venue=binance','unknown=1','instrument=BTCUSDT','instrument=binance%3Aswap%3ABTCUSDT%0A']){
  const response=await f.call(`/api/markets?${query}`);assert.equal(response.status,400,query);assert.equal((await response.json() as any).error.code,'invalid_request');
 }
 assert.equal(f.reads(),0);
 assert.equal((await f.call(`/api/markets?q=${'a'.repeat(80)}`)).status,200);
 f.setAnonymous();assert.equal((await f.call('/api/markets?q=btc')).status,401);
});

test('partial venue outage isolates search and create/enable/rearm; stale exact labels remain available for display',async()=>{
 const f=fixture();
 f.setCatalog({...f.catalog(),stale:true,sources:{okx:{updatedAt:1000,stale:false},binance:{updatedAt:1000,stale:true,code:'catalog_unavailable'},mexc:{updatedAt:1000,stale:false}}});
 const choices=await f.data('/api/markets?q=btc');assert.equal(choices.total,4);assert.equal(choices.markets.some((m:Market)=>m.instrument.startsWith('binance:')),false);
 const directory=await f.data('/api/markets');assert.equal(directory.markets.length,7);assert.equal(directory.markets.find((m:Market)=>m.instrument==='binance:spot:BTCUSDT').available,false);
 const exact=await f.data('/api/markets?instrument=binance%3Aswap%3ABTCUSDT');assert.equal(exact.total,1);assert.equal(exact.markets[0].available,false);
 for(const instrument of ['BTC-USDT-SWAP','mexc:swap:BTC_USDT','mexc:spot:BTCUSDT']){const response=await f.call('/api/alerts','POST',{...input,instrument});assert.equal(response.status,201,await response.clone().text());}
 for(const instrument of ['binance:spot:BTCUSDT','binance:swap:BTCUSDT']){
  assert.equal((await f.call('/api/alerts','POST',{...input,instrument})).status,503);
  const a=f.alert(instrument,instrument,false);f.records.set(a.id,a);
  assert.equal((await f.call(`/api/alerts/${a.id}`,'PATCH',{expectedGeneration:0,enabled:true})).status,503);
  assert.equal((await f.call(`/api/alerts/${a.id}/rearm`,'POST',{expectedGeneration:0})).status,503);
  assert.equal(f.records.get(a.id)!.generation,0);
 }
 assert.equal(f.writes(),3);assert.equal(f.wakes(),3);
 const healthy=f.alert('healthy-existing','mexc:swap:BTC_USDT',false);f.records.set(healthy.id,{...healthy,triggered:true,triggerId:'old-trigger'});
 assert.equal((await f.call(`/api/alerts/${healthy.id}`,'PATCH',{expectedGeneration:0,enabled:true})).status,200);
 assert.equal((await f.call(`/api/alerts/${healthy.id}/rearm`,'POST',{expectedGeneration:1})).status,200);
 assert.equal(f.records.get(healthy.id)!.triggered,false);assert.equal(f.records.get(healthy.id)!.generation,2);
 f.setCatalog({...f.catalog(),sources:[{venue:'okx',updatedAt:1000,stale:false},{venue:'mexc',updatedAt:1000,stale:false},{venue:'binance',updatedAt:1000,stale:true}]});
 assert.equal((await f.call('/api/alerts','POST',input)).status,201);
});

test('explicit per-market availability supports partial snapshots and denies inactive selection even on fresh sources',async()=>{
 const f=fixture(),unavailable='binance:swap:BTCUSDT';
 f.setCatalog({...f.catalog(),stale:true,markets:markets.map(m=>({...m,available:m.instrument!==unavailable}))});
 assert.equal((await f.call('/api/alerts','POST',input)).status,201);
 f.setCatalog({...f.catalog(),stale:false,sources:{binance:{updatedAt:1000,stale:false},okx:{updatedAt:1000,stale:false},mexc:{updatedAt:1000,stale:false}}});
 const a=f.alert('existing',unavailable,false);f.records.set(a.id,a);
 assert.equal((await f.call('/api/alerts','POST',{...input,instrument:unavailable})).status,400);
 assert.equal((await f.call(`/api/alerts/${a.id}`,'PATCH',{expectedGeneration:0,enabled:true})).status,400);
 assert.equal((await f.call(`/api/alerts/${a.id}/rearm`,'POST',{expectedGeneration:0})).status,400);
 assert.equal(f.records.get(a.id)!.generation,0);
 assert.equal((await f.data(`/api/markets?instrument=${encodeURIComponent(unavailable)}`)).markets[0].available,false);
 // Pending/generation/ownership errors take precedence over catalog outages.
 f.records.set('pending',{...a,id:'pending',pendingTriggerId:'queued-event'});
 f.records.set('changed',{...a,id:'changed',generation:2});
 const reads=f.reads();
 for(const [id,code] of [['pending','pending_delivery'],['changed','generation_conflict']] as const){const response=await f.call(`/api/alerts/${id}/rearm`,'POST',{expectedGeneration:0});assert.equal(response.status,409);assert.equal((await response.json() as any).error.code,code);}
 assert.equal((await f.call('/api/alerts/missing/rearm','POST',{expectedGeneration:0})).status,404);assert.equal(f.reads(),reads);
});

test('notification labels derive venue, product and quote from legacy and qualified snapshots',async()=>{
 for(const [instrument,venue,product,quote] of [['BTC-USDT-SWAP','OKX','USDT perpetual','USDT'],['binance:spot:BTCUSDT','BINANCE','Spot','USDT'],['binance:swap:BTCUSDT','BINANCE','USDT perpetual','USDT'],['okx:spot:ETH-USDT','OKX','Spot','USDT'],['mexc:swap:BTC_USDT','MEXC','USDT perpetual','USDT'],['mexc:spot:BTCUSDT','MEXC','Spot','USDT'],['okx:spot:BTC-EUR','OKX','Spot','EUR']] as const){
  const result=notificationMarketLabel(instrument);assert.ok(result.label.includes(venue),result.label);assert.ok(result.label.includes(product),result.label);assert.equal(result.quote,quote);
 }
 assert.deepEqual(notificationMarketLabel('mexc:swap:BTC%2FUSDT%3AUSDT'),{label:'MEXC · USDT perpetual · BTC/USDT',quote:'USDT'});
 assert.deepEqual(notificationMarketLabel('binance:spot:UNRECOGNIZED'),{label:'BINANCE · Spot · UNRECOGNIZED',quote:''});
 assert.deepEqual(notificationMarketLabel('okx:swap:BTC-USDT-SWAP'),{label:'Market unavailable',quote:''});
 const invalid=notificationMarketLabel('https://attacker.invalid\nTOKEN');assert.deepEqual(invalid,{label:'Market unavailable',quote:''});
 const sent:string[]=[];
 const provider={send:async(_user:string,_channel:unknown,message:string)=>{sent.push(message);return {outcome:'sent' as const,code:null,receipt:null};}};
 const repositories={settings:{get:async()=>({enabled:true,disabled:false,generation:2})},channels:{get:async()=>({generation:3})}} as unknown as Repositories;
 const service=createNotificationService({config,repositories,provider:provider as any});
 const event={phase:'sending',claimId:'claimed',claimFence:1,userId:'alice',settingsGeneration:2,channelGeneration:3,name:'Snapshot name',instrument:'mexc:swap:BTC_USDT',side:'upper',price:101,threshold:100,timestamp:1700000000000,notification:DEFAULT_NOTIFICATION} as OutboxRecord;
 const original=JSON.stringify(event);assert.equal((await service.deliver(event)).outcome,'sent');assert.equal(JSON.stringify(event),original);
 assert.match(sent[0]!,/MEXC · USDT perpetual · BTC\/USDT: 101 USDT \(at or above 100 USDT\)/);
 assert.match(sent[0]!,/Snapshot name/);assert.match(sent[0]!,/Exchange timestamp:/);
 assert.equal((await service.deliver({...event,phase:'queued'})).code,'delivery_not_claimed');assert.equal(sent.length,1);
});
