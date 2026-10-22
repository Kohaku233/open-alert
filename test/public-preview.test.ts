import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createPublicMarketPreview,PREVIEW_MARKETS} from '../src/markets/public-preview.js';
import {createMarketQuoteService} from '../src/markets/quotes.js';
import {createApi} from '../src/api/index.js';
import type {ApiDependencies} from '../src/api/ports.js';
import {overallHealth} from '../src/scheduler/index.js';

test('public preview coalesces fixed markets and retains timestamps on partial failure',async()=>{
  let now=1700000000000,calls=0,fail=false;
  const preview=createPublicMarketPreview({now:()=>now,read:async market=>{
    calls++;if(fail&&market.venue==='okx')throw Error('offline');
    return [{instrument:market.instrument,price:100,observedAt:now,timestamp:now-100}];
  }});
  const [a,b]=await Promise.all([preview.get(),preview.get()]);assert.equal(calls,3);assert.deepEqual(a,b);
  a.entries[0]!.quote!.price=999;assert.equal((await preview.get()).entries[0]!.quote!.price,100);
  now+=4999;await preview.get();assert.equal(calls,3);
  now++;fail=true;const next=await preview.get();assert.equal(calls,6);
  assert.equal(next.entries[1]!.stale,true);assert.equal(next.entries[1]!.quote!.observedAt,1700000000000);
  assert.equal(next.entries[0]!.stale,false);assert.equal(next.entries[0]!.quote!.observedAt,now);
  assert.deepEqual(next.entries.map(e=>e.instrument),PREVIEW_MARKETS.map(m=>m.instrument));
});

test('public route exposes no private state and does not widen authenticated quote access',async()=>{
  let sessions=0,reads=0;
  const app=createApi({publicPreview:{get:async()=>{reads++;return {entries:[],capturedAt:1};}},auth:{getPrincipal:async()=>{sessions++;return null;}}} as unknown as ApiDependencies);
  const response=await app.request('/api/public-quotes');assert.equal(response.status,200);assert.equal(sessions,0);assert.equal(reads,1);
  assert.match(response.headers.get('cache-control')??'',/s-maxage=5/);
  assert.equal((await app.request('/api/public-quotes?instrument=arbitrary')).status,400);assert.equal(reads,1);
  assert.equal((await app.request('/api/quote?instrument=ETH-USDT-SWAP')).status,401);assert.equal(sessions,1);
});

test('login history contains only actual bounded distinct exchange samples',async()=>{
  const now=1700000000000,market=PREVIEW_MARKETS[1]!;
  const quotes=createMarketQuoteService({now:()=>now,factory:()=>({precisionMode:4,has:{},seedMarket:()=>{},loadMarkets:async()=>({}),close:async()=>{},fetchTrades:async symbol=>[
    ...Array.from({length:120},(_,i)=>({symbol,price:100+i,timestamp:now-120+i})),
    {symbol,price:0,timestamp:now-1000},{symbol:'wrong',price:999,timestamp:now-1000},
  ]})});
  const history=await quotes.recent(market);assert.equal(history.length,90);assert.equal(history[0]!.price,130);assert.equal(history.at(-1)!.price,219);
  assert.equal(new Set(history.map(q=>q.timestamp)).size,90);assert(history.every(q=>q.instrument===market.instrument&&q.observedAt===now));
  await quotes.stop();await assert.rejects(quotes.recent(market),/stopped/);
});

test('absence of provider samples is neutral; real delivery failure still degrades health',()=>{
  const good={state:'healthy' as const,code:null,lastSuccessAt:1};
  assert.equal(overallHealth([good,{state:'degraded',code:'provider_not_checked',lastSuccessAt:null}]),'healthy');
  assert.equal(overallHealth([good,{state:'degraded',code:'provider_rejected',lastSuccessAt:null}]),'degraded');
  assert.equal(overallHealth([good,{state:'unhealthy',code:'provider_not_checked',lastSuccessAt:null}]),'unhealthy');
});
