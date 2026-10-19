import test, { mock } from 'node:test';
import ccxt from 'ccxt';
import { createPublicCcxtMarketSource, publicExchangeConfig } from '../src/markets/ccxt.js';
import { publicExchangeFixture } from './runtime-cloudflare-fixtures.js';
import assert from 'node:assert/strict';
import { instrumentSchema, legacyInstrumentSchema, parseInstrumentIdentity } from '../src/contracts/domain.js';
import { parseLegacySnapshot } from '../src/migration/legacy.js';
import { instrumentId, normalizeCatalog, normalizeMarket } from '../src/markets/normalize.js';
import { createCcxtMarketSource } from '../src/markets/source.js';
import { marketAvailable, marketSourceStale } from '../src/api/markets.js';
import type { Market } from '../src/contracts/domain.js';
import type { CcxtExchange, MarketSourceOptions } from '../src/markets/source.js';
import type { MarketType, Venue } from '../src/contracts/domain.js';
const initial = 1_700_000_000_000;
function market(venue: Venue, type: MarketType = 'swap', base = 'BTC'): Record<string, unknown> {
  return { id: venue === 'okx' ? `${base}-USDT${type === 'swap' ? '-SWAP' : ''}` : venue === 'mexc' && type === 'swap' ? `${base}_USDT` : `${base}USDT`,
    symbol: `${base}/USDT${type === 'swap' ? ':USDT' : ''}`, type, base, quote: 'USDT',
    active: true, spot: type === 'spot', swap: type === 'swap', contract: type === 'swap', future: false, option: false,
    linear: type === 'swap' ? true : undefined, inverse: type === 'swap' ? false : undefined,
    settle: type === 'swap' ? 'USDT' : undefined, contractSize: type === 'swap' ? 0.01 : undefined,
    expiry: undefined, precision: { price: 0.1 } };
}
function catalog(...rows: Record<string, unknown>[]) { return Object.fromEntries(rows.map(row => [row.symbol as string, row])); }
function trade(price: number, timestamp = initial, symbol = 'BTC/USDT:USDT', id = String(price)) { return { id, price, timestamp, symbol, amount: 1, side: 'buy' }; }
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((a,b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
class MockExchange implements CcxtExchange {
  precisionMode = 4; has = { watchTrades: true, fetchTrades: true };
  metadata: unknown; batches: unknown[] = []; loads = 0; closed = 0;
  fetchCalls: { symbol: string; since: number | undefined; limit: number | undefined }[] = [];
  watches: ReturnType<typeof deferred<unknown>>[] = [];
  failCatalog = false; failFetch = false; hangClose = false; hangLoad = false;
  constructor(venue: Venue) { this.metadata = catalog(market(venue), market(venue, 'spot')); }
  async loadMarkets(reload?: boolean) { assert.equal(reload, true); this.loads++; if (this.failCatalog) throw new Error('catalog fail'); if (this.hangLoad) return new Promise<never>(() => {}); return this.metadata; }
  async fetchTrades(symbol: string, since?: number, limit?: number): Promise<unknown> { this.fetchCalls.push({ symbol, since, limit }); if (this.failFetch) throw new Error('poll fail'); return this.batches.shift() ?? []; }
  watchTrades(symbol: string) { assert.ok(symbol.includes('/USDT')); const work = deferred<unknown>(); this.watches.push(work); return work.promise; }
  async close() { this.closed++; if (this.hangClose) return new Promise<never>(() => {}); }
}
function fixture(extra: Partial<MarketSourceOptions> = {}) {
  let time = initial;
  const exchanges: Record<Venue, MockExchange[]> = { binance: [], okx: [], mexc: [] };
  const next: Partial<Record<Venue, MockExchange>> = {};
  const source = createCcxtMarketSource({ mode: 'polling', now: () => time, requestTimeoutMs: 1000, closeTimeoutMs: 10,
    retryBaseMs: 10, retryMaxMs: 100, pollIntervalMs: 1, catalogTtlMs: 100,
    factory(venue, settings) { assert.ok(settings.tradesLimit >= 2); const e = next[venue] ?? new MockExchange(venue); delete next[venue]; exchanges[venue].push(e); return e; }, ...extra });
  return { source, exchanges, next, advance: (ms: number) => { time += ms; }, time: () => time,
    current: (venue: Venue) => exchanges[venue].at(-1)! };
}
const pause = (ms = 5) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean) { for (let n = 0; n < 30; n++) { if (check()) return; await pause(); } assert.ok(check(), 'condition must become true'); }

test('identities isolate venue/product and preserve exactly one OKX legacy representation', () => {
  const ids = new Set<string>();
  for (const venue of ['binance','okx','mexc'] as const) for (const type of ['spot','swap'] as const) {
    const m = normalizeMarket(venue, market(venue,type),4)!; assert.ok(m); ids.add(m.instrument);
    assert.deepEqual(parseInstrumentIdentity(m.instrument), {venue,type,nativeId:m.nativeId});
    assert.equal(instrumentSchema.safeParse(m.instrument).success,true);
    assert.equal(m.settle,type==='swap'?'USDT':null); assert.equal(m.contractSize,type==='swap'?0.01:null);
  }
  assert.equal(ids.size,6); assert.equal(instrumentId('okx','swap','BTC-USDT-SWAP'),'BTC-USDT-SWAP');
  assert.equal(instrumentId('mexc','spot','BTC/USDT'),'mexc:spot:BTC%2FUSDT');
  for (const bad of ['okx:swap:BTC-USDT-SWAP','okx:swap:BTC%2DUSDT%2DSWAP','binance:spot:BTC/USDT','mexc:spot:BTC%2fUSDT','coinbase:spot:BTCUSDT','binance:future:BTCUSDT','mexc:swap:%00','mexc:swap:%252F','binance:spot:'+ 'A'.repeat(129),'btc-USDT-SWAP']) assert.equal(instrumentSchema.safeParse(bad).success,false,bad);
  assert.equal(legacyInstrumentSchema.safeParse('binance:swap:BTCUSDT').success,false);
});
test('metadata accepts only explicit active USDT spot and linear perpetuals with consistent precision', () => {
  const raw = market('okx');
  for (const patch of [{active:undefined},{active:false},{active:'true'},{type:'future'},{type:'option'},{future:true},{future:undefined},{option:true},{expiry:initial},{linear:false},{inverse:true},{settle:'USDC'},{quote:'USD'},{contractSize:0},{contractSize:Infinity},{contractSize:'1'},{symbol:'BTC/USDT'},{id:'ETH-USDT-SWAP'},{id:'BTC_USDT'},{base:'BTC/ETH'},{precision:{price:0}},{precision:{price:NaN}}]) assert.equal(normalizeMarket('okx',{...raw,...patch},4),null,JSON.stringify(patch));
  assert.equal(normalizeMarket('binance',{...market('binance','spot'),contract:true},4),null);
  assert.equal(normalizeMarket('binance',{...market('binance','spot'),settle:'USDT'},4),null);
  assert.equal(normalizeMarket('binance',{...market('binance','spot'),quote:'USDC',symbol:'BTC/USDC'},4),null);
  assert.equal(normalizeMarket('okx',raw,3),null);
  assert.equal(normalizeMarket('okx',{...raw,precision:{price:2}},2)!.tickSize,'0.01');
  assert.throws(()=>normalizeCatalog('okx',{'bad':raw},4),/invalid_catalog_row/);
  assert.throws(()=>normalizeCatalog('okx',catalog(raw),4,0),/catalog_capacity/);
});
test('legacy migration keeps instrument validation strict in rules, queued and historical snapshots', () => {
  const alert = {id:'a',name:'A',instrument:'BTC-USDT-SWAP',side:'upper',threshold:1,enabled:true,generation:0,pending:null,last:null};
  const snapshot = {version:3,config:{enabled:false,dailyLimit:20,notification:{priority:2,retry:30,expire:1500,sound:'siren'}},running:false,alerts:[alert],daily:{date:'2026-10-11',attempts:0}};
  assert.doesNotThrow(()=>parseLegacySnapshot(snapshot));
  assert.throws(()=>parseLegacySnapshot({...snapshot,alerts:[{...alert,instrument:'binance:spot:BTCUSDT'}]}),/invalid_snapshot/);
  assert.throws(()=>parseLegacySnapshot({...snapshot,alerts:[{...alert,pending:{id:'p',phase:'queued',attempts:0,instrument:'mexc:swap:BTC_USDT'}}]}),/invalid_snapshot/);
  assert.throws(()=>parseLegacySnapshot({...snapshot,alerts:[{...alert,last:{outcome:'sent',instrument:'okx:spot:BTC-USDT'}}]}),/invalid_snapshot/);
});
test('shared venue clients load explicitly, complete catalogs remove delistings and isolate failures', async () => {
  const f=fixture(); f.next.mexc=new MockExchange('mexc'); f.next.mexc.failCatalog=true;
  try {
    await Promise.all([f.source.refreshCatalog(),f.source.refreshCatalog()]);
    assert.equal(f.exchanges.binance.length,1); assert.equal(f.current('binance').loads,1);
    assert.equal(f.source.eligible('binance:spot:BTCUSDT'),true); assert.equal(f.source.eligible('BTC-USDT-SWAP'),true);
    assert.equal(f.source.getMarkets().stale,true); assert.equal(f.source.eligible('mexc:swap:BTC_USDT'),false);
    await f.source.setDemand(['BTC-USDT-SWAP']); f.current('okx').batches.push([trade(100)]); await f.source.refresh(); assert.equal(f.source.samples('BTC-USDT-SWAP').length,1);
    f.advance(100); f.current('okx').metadata={}; await f.source.refreshCatalog(); assert.equal(f.source.eligible('BTC-USDT-SWAP'),false); assert.equal(f.source.samples('BTC-USDT-SWAP').length,0);
    f.advance(100); f.current('okx').failCatalog=true; await f.source.refreshCatalog(); assert.ok(!f.source.getMarkets().markets.some(m=>m.instrument==='BTC-USDT-SWAP'));
    assert.equal(f.source.eligible('binance:spot:BTCUSDT'),true);
  } finally {await f.source.stop();}
});
test('indexed catalog selection matches directory semantics across expiry, outages, delisting and stop',async()=>{
 const f=fixture();
 const ids=['BTC-USDT-SWAP','okx:spot:BTC-USDT','binance:spot:BTCUSDT','mexc:swap:BTC_USDT','binance:spot:FAKEUSDT','forged'];
 const parity=()=>{const snapshot=f.source.getMarkets();for(const instrument of ids){const market=snapshot.markets.find(m=>m.instrument===instrument)??null;assert.deepEqual(f.source.resolve!(instrument),{market,stale:marketSourceStale(snapshot,market??{instrument} as Market),available:!!market&&marketAvailable(snapshot,market)});}};
 try{
  parity();await f.source.refreshCatalog();parity();
  const row=f.source.resolve!('BTC-USDT-SWAP').market!;row.base='FORGED';row.available=false;assert.equal(f.source.resolve!('BTC-USDT-SWAP').market!.base,'BTC');assert.equal(f.source.resolve!('BTC-USDT-SWAP').available,true);
  f.advance(100);parity();assert.equal(f.source.resolve!('BTC-USDT-SWAP').stale,true);
  f.current('mexc').failCatalog=true;await f.source.refreshCatalog();parity();assert.equal(f.source.getMarkets().stale,true);assert.equal(f.source.resolve!('BTC-USDT-SWAP').stale,false);
  f.current('okx').metadata={};f.advance(100);await f.source.refreshCatalog();parity();assert.equal(f.source.resolve!('BTC-USDT-SWAP').market,null);assert.equal(f.source.resolve!('BTC-USDT-SWAP').stale,false);
  await f.source.stop();parity();assert.equal(f.source.resolve!('binance:spot:BTCUSDT').available,false);
 }finally{await f.source.stop();}
});

test('indexed lookup freshness stays scoped to the product rather than the whole venue',async()=>{
 let at=initial;const clients=new Map<string,MockExchange>();
 const source=createCcxtMarketSource({mode:'polling',venues:['binance'],splitProducts:['binance'],now:()=>at,catalogTtlMs:100,requestTimeoutMs:1000,closeTimeoutMs:10,
  factory(venue,settings){const client=new MockExchange(venue);client.metadata=catalog(market(venue,settings.product!));clients.set(settings.product!,client);return client;}});
 try{
  await source.refreshCatalog();assert.equal(source.resolve!('binance:spot:BTCUSDT').available,true);assert.equal(source.resolve!('binance:swap:BTCUSDT').available,true);
  clients.get('spot')!.failCatalog=true;at+=100;await source.refreshCatalog();
  assert.equal(source.getMarkets().stale,true);assert.equal(source.resolve!('binance:spot:BTCUSDT').stale,true);assert.equal(source.resolve!('binance:spot:BTCUSDT').available,false);
  assert.equal(source.resolve!('binance:swap:BTCUSDT').stale,false);assert.equal(source.resolve!('binance:swap:BTCUSDT').available,true);
  assert.deepEqual(source.resolve!('binance:swap:FAKEUSDT'),{market:null,stale:false,available:false});
 }finally{await source.stop();}
});

test('large-catalog point lookups never enumerate metadata or change market demand',async t=>{
 const f=fixture({venues:['okx'],maxCatalogMarkets:10000});const exchange=new MockExchange('okx');
 exchange.metadata=catalog(...Array.from({length:5000},(_,i)=>market('okx','swap','COIN'+i)));f.next.okx=exchange;
 try{
  await f.source.refreshCatalog();assert.equal(f.source.getMarkets().markets.length,5000);const before=f.source.diagnostics();
  const iterator=t.mock.method(Map.prototype,'values',()=>{assert.fail('Point lookup enumerated the full metadata map');});
  for(let i=0;i<100;i++){const result=f.source.resolve!('COIN4999-USDT-SWAP');assert.equal(result.available,true);assert.equal(result.market!.base,'COIN4999');}
  assert.equal(iterator.mock.callCount(),0);iterator.mock.restore();assert.deepEqual(f.source.diagnostics(),before);assert.equal(exchange.fetchCalls.length,0);assert.equal(exchange.loads,1);
 }finally{t.mock.restoreAll();await f.source.stop();}
});

test('stream retains every intra-batch crossing; copies, dedup and drain are safe', async () => {
  const f=fixture({venues:['okx'],mode:'stream'});
  try {
    await f.source.refreshCatalog(); await f.source.setDemand(['BTC-USDT-SWAP']); await f.source.refresh();
    const e=f.current('okx'); await until(()=>e.watches.length===1);
    e.watches[0]!.resolve([trade(100),trade(150),trade(50),trade(101)]);
    await until(()=>f.source.samples('BTC-USDT-SWAP').length===4);
    assert.deepEqual(f.source.samples('BTC-USDT-SWAP').map(t=>t.price),[100,150,50,101]);
    assert.equal(f.source.ticks().get('BTC-USDT-SWAP')!.price,101);
    const copy=f.source.samples('BTC-USDT-SWAP'); copy[0]!.price=0; assert.equal(f.source.samples('BTC-USDT-SWAP')[0]!.price,100);
    await until(()=>e.watches.length===2); e.watches[1]!.resolve([trade(150),trade(50)]);
    await until(()=>e.watches.length===3); assert.equal(f.source.samples('BTC-USDT-SWAP').length,4);
    assert.equal(f.source.drainSamples('BTC-USDT-SWAP').length,4); assert.equal(f.source.diagnostics().queued,0); assert.equal(f.source.getPrices().length,1);
  } finally {await f.source.stop();}
});
test('stale, future, wrong symbol and invalid trades cannot become samples or prices', async () => {
  const f=fixture({venues:['okx']}); try {
    await f.source.refreshCatalog(); await f.source.setDemand(['BTC-USDT-SWAP']);
    f.current('okx').batches.push([trade(120,initial-30001),trade(120,initial+5001),trade(120,initial,'BTC/USDT'),trade(-1),trade(Infinity),trade(12,initial+0.5)]);
    await f.source.refresh(); assert.deepEqual(f.source.samples('BTC-USDT-SWAP'),[]); assert.equal(f.source.priceHealth().state,'unhealthy');
    f.advance(1); f.current('okx').batches.push([trade(100,f.time())]); await f.source.refresh(); assert.equal(f.source.priceHealth().state,'healthy');
    f.advance(30001); assert.deepEqual(f.source.getPrices(),[]); assert.deepEqual(f.source.samples('BTC-USDT-SWAP'),[]);
  } finally {await f.source.stop();}
});
test('pre-demand history never supplies old extrema, only one first fresh observation', async () => {
  const f=fixture({venues:['okx']}); try {
    await f.source.refreshCatalog(); f.advance(5); await f.source.setDemand(['BTC-USDT-SWAP']);
    f.current('okx').batches.push([trade(1000,initial),trade(1,initial+1),trade(100,initial+2)]); await f.source.refresh();
    assert.deepEqual(f.source.samples('BTC-USDT-SWAP').map(t=>t.price),[100]);
    f.advance(1); f.current('okx').batches.push([trade(1000,initial),trade(1,initial+1)]); await f.source.refresh(); assert.equal(f.source.samples('BTC-USDT-SWAP').length,1);
    await f.source.setDemand([]); f.advance(1); await f.source.setDemand(['BTC-USDT-SWAP']); assert.deepEqual(f.source.samples('BTC-USDT-SWAP'),[]);
  } finally {await f.source.stop();}
});
test('bounded demand and fair polling retain only one latest sample per request', async () => {
  const f=fixture({venues:['okx'],maxDemand:2,maxQueue:3,maxBatch:10,maxPollRequestsPerVenue:1}); try {
    await f.source.refreshCatalog(); await assert.rejects(f.source.setDemand(['missing']),/instrument_unavailable/);
    await f.source.setDemand(['BTC-USDT-SWAP','okx:spot:BTC-USDT']);
    f.current('okx').batches.push([trade(10),trade(20),trade(30),trade(40)]); await f.source.refresh();
    assert.equal(f.source.eligible('BTC-USDT-SWAP'),true); assert.deepEqual(f.source.samples('BTC-USDT-SWAP').map(t=>t.price),[40]); assert.equal(f.source.diagnostics().queued,1);
    f.advance(1); f.current('okx').batches.push([trade(80,f.time(),'BTC/USDT')]); await f.source.refresh();
    assert.deepEqual(f.source.getPrices().map(t=>t.instrument).sort(),['BTC-USDT-SWAP','okx:spot:BTC-USDT']);
    assert.deepEqual(f.current('okx').fetchCalls.map(call=>call.symbol),['BTC/USDT:USDT','BTC/USDT']);
    await f.source.setDemand(['okx:spot:BTC-USDT']); assert.equal(f.source.diagnostics().instruments.length,1); assert.equal(f.source.diagnostics().queued,1);
  } finally {await f.source.stop();}
  const g=fixture({venues:['okx'],maxDemand:1}); try {await g.source.refreshCatalog(); await assert.rejects(g.source.setDemand(['BTC-USDT-SWAP','okx:spot:BTC-USDT']),/demand_capacity/); assert.equal(g.source.diagnostics().instruments.length,0);} finally {await g.source.stop();}
});
test('saturated CCXT stream cache fails closed even if queue has room', async () => {
  const f=fixture({venues:['okx'],mode:'stream',maxBatch:2}); try {
    await f.source.refreshCatalog(); await f.source.setDemand(['BTC-USDT-SWAP']); await f.source.refresh();
    const e=f.current('okx'); await until(()=>e.watches.length===1); e.watches[0]!.resolve([trade(10),trade(20)]);
    await until(()=>f.source.diagnostics().instruments[0]!.code==='trade_queue_overflow');
    assert.equal(f.source.eligible('BTC-USDT-SWAP'),false); assert.deepEqual(f.source.getPrices(),[]); assert.equal(f.source.diagnostics().queued,0);
  } finally {await f.source.stop();}
});
test('poll failure isolates a venue, clears its prices and reconnects with bounded backoff', async () => {
  const f=fixture(); try {
    await f.source.refreshCatalog(); await f.source.setDemand(['BTC-USDT-SWAP','binance:swap:BTCUSDT']);
    f.current('okx').failFetch=true; f.current('binance').batches.push([trade(90)]); await f.source.refresh();
    assert.equal(f.source.ticks().has('binance:swap:BTCUSDT'),true); assert.equal(f.source.ticks().has('BTC-USDT-SWAP'),false);
    assert.equal(f.current('okx').closed,1); await f.source.refresh(); assert.equal(f.exchanges.okx.length,1);
    f.advance(10); f.next.okx=new MockExchange('okx'); f.next.okx.batches.push([trade(110,f.time())]); await f.source.refresh();
    assert.equal(f.exchanges.okx.length,2); assert.equal(f.current('okx').loads,1); assert.equal(f.source.ticks().get('BTC-USDT-SWAP')!.price,110);
  } finally {await f.source.stop();}
});
test('stream consumes full batches, reconnects and rejects old epoch responses', async () => {
  const f=fixture({venues:['okx'],mode:'stream'}); try {
    await f.source.refreshCatalog(); await f.source.setDemand(['BTC-USDT-SWAP']); await f.source.refresh();
    const old=f.current('okx'); await until(()=>old.watches.length===1);
    old.watches[0]!.resolve([trade(100),trade(140),trade(80),trade(101)]); await until(()=>f.source.samples('BTC-USDT-SWAP').length===4);
    await until(()=>old.watches.length===2); old.watches[1]!.reject(new Error('disconnect')); await until(()=>old.closed===1);
    assert.equal(f.source.getPrices().length,0); await f.source.refresh(); assert.equal(f.exchanges.okx.length,2); // initial metadata client + demanded stream
    f.advance(10); await f.source.refresh(); const current=f.current('okx'); assert.notEqual(current,old); await until(()=>current.watches.length===1);
    current.watches[0]!.resolve([trade(111,f.time())]); await until(()=>f.source.getPrices().length===1);
    await until(()=>current.watches.length===2); await f.source.setDemand([]); current.watches[1]!.resolve([trade(999,f.time())]); await pause();
    assert.equal(f.source.samples('BTC-USDT-SWAP').length,0); assert.equal(f.source.getPrices().length,0);
  } finally {await f.source.stop();}
});
test('full REST pages sample only the latest valid trade regardless of demand coverage or row order', async () => {
  const f=fixture({venues:['okx'],maxBatch:3}); try {
    await f.source.refreshCatalog(); f.advance(10); await f.source.setDemand(['BTC-USDT-SWAP']);
    f.current('okx').batches.push([trade(80,f.time()),trade(1000,initial),trade(150,f.time()-1)]); await f.source.refresh();
    assert.deepEqual(f.source.samples('BTC-USDT-SWAP').map(t=>t.price),[80]); assert.equal(f.source.priceHealth().state,'healthy');
    f.advance(3); f.current('okx').batches.push([trade(90,f.time()),trade(200,f.time()-1),trade(1,f.time()-2)]); await f.source.refresh();
    assert.deepEqual(f.source.samples('BTC-USDT-SWAP').map(t=>t.price),[80,90]); assert.equal(f.source.eligible('BTC-USDT-SWAP'),true);
    assert.ok(f.current('okx').fetchCalls.every(call=>call.limit===3&&call.since===undefined));
  } finally {await f.source.stop();}
});
test('poll budgets bound hanging adapters and rotate instruments', async () => {
  const f=fixture({venues:['okx'],pollBudgetMs:10,requestTimeoutMs:1000}); try {
    await f.source.refreshCatalog(); await f.source.setDemand(['BTC-USDT-SWAP']);
    f.current('okx').fetchTrades=async()=>new Promise<never>(()=>{});
    const started=performance.now(); await f.source.refresh(); assert.ok(performance.now()-started<200);
    assert.equal(f.source.diagnostics().venues[0]!.priceCode,'poll_unavailable');
  } finally {await f.source.stop();}
});
test('metadata load timeout backs off and late factory instances close safely', async () => {
  const f=fixture({venues:['okx'],requestTimeoutMs:10}); f.next.okx=new MockExchange('okx'); f.next.okx.hangLoad=true;
  try {await f.source.refreshCatalog(); assert.equal(f.source.getMarkets().stale,true); assert.equal(f.current('okx').closed,1); await f.source.refreshCatalog(); assert.equal(f.exchanges.okx.length,1);} finally {await f.source.stop();}
  const pending=deferred<CcxtExchange>(), late=new MockExchange('okx');
  const source=createCcxtMarketSource({venues:['okx'],mode:'polling',requestTimeoutMs:10,factory:()=>pending.promise});
  await source.refreshCatalog(); await source.stop(); pending.resolve(late); await until(()=>late.closed===1); assert.deepEqual(source.getPrices(),[]);
});
test('catalog freshness is bounded independently for each venue', async () => {
  const f=fixture(); try {
    await f.source.refreshCatalog(); f.advance(100); f.current('okx').failCatalog=true; await f.source.refreshCatalog();
    assert.equal(f.source.eligible('BTC-USDT-SWAP'),false); assert.equal(f.source.eligible('binance:swap:BTCUSDT'),true); assert.equal(f.source.getMarkets().stale,true);
    f.advance(100); assert.equal(f.source.eligible('binance:swap:BTCUSDT'),false);
  } finally {await f.source.stop();}
});
test('poll demand removal and re-add rejects an obsolete outstanding response', async () => {
  const f=fixture({venues:['okx']}); try {
    await f.source.refreshCatalog(); await f.source.setDemand(['BTC-USDT-SWAP']);
    const response=deferred<unknown>(); f.current('okx').fetchTrades=()=>response.promise;
    const work=f.source.refresh(); await pause(); await f.source.setDemand([]); f.advance(1); await f.source.setDemand(['BTC-USDT-SWAP']);
    response.resolve([trade(999,f.time())]); await work; assert.deepEqual(f.source.getPrices(),[]); assert.equal(f.source.diagnostics().queued,0);
  } finally {await f.source.stop();}
});
test('stream catalog delisting closes old subscriptions and rejects their late prices', async () => {
  const f=fixture({venues:['okx'],mode:'stream'}); try {
    await f.source.refreshCatalog(); await f.source.setDemand(['BTC-USDT-SWAP']); await f.source.refresh(); const old=f.current('okx'); await until(()=>old.watches.length===1);
    f.advance(100); old.metadata={}; f.next.okx=new MockExchange('okx'); f.next.okx.metadata={}; await f.source.refreshCatalog();
    assert.equal(old.closed,1); assert.equal(f.source.eligible('BTC-USDT-SWAP'),false);
    old.watches[0]!.resolve([trade(999,f.time())]); await pause(); assert.deepEqual(f.source.getPrices(),[]);
  } finally {await f.source.stop();}
});
test('stream overflow remains sticky across metadata refresh until demand removal', async () => {
  const f=fixture({venues:['okx'],mode:'stream',maxBatch:2}); try {
    await f.source.refreshCatalog(); await f.source.setDemand(['BTC-USDT-SWAP']); await f.source.refresh();
    const e=f.current('okx'); await until(()=>e.watches.length===1); e.watches[0]!.resolve([trade(10),trade(20)]);
    await until(()=>f.source.diagnostics().instruments[0]!.code==='trade_queue_overflow');
    f.advance(100); e.metadata=catalog({...market('okx'),precision:{price:0.2}}); await f.source.refreshCatalog(); assert.equal(f.source.eligible('BTC-USDT-SWAP'),false);
    assert.equal(f.source.diagnostics().instruments[0]!.code,'trade_queue_overflow');
    await f.source.setDemand([]); await f.source.setDemand(['BTC-USDT-SWAP']); assert.equal(f.source.eligible('BTC-USDT-SWAP'),true);
  } finally {await f.source.stop();}
});
test('stop cancels pending stream work and close cannot block indefinitely', async () => {
  const f=fixture({venues:['okx'],mode:'stream',requestTimeoutMs:10_000});
  await f.source.refreshCatalog(); await f.source.setDemand(['BTC-USDT-SWAP']); await f.source.refresh(); const e=f.current('okx'); await until(()=>e.watches.length===1); e.hangClose=true;
  const started=performance.now(); await f.source.stop(); assert.ok(performance.now()-started<200); await f.source.stop();
  e.watches[0]!.resolve([trade(123)]); await pause(); assert.deepEqual(f.source.getPrices(),[]); assert.equal(f.source.diagnostics().stopped,true);
  await assert.rejects(f.source.setDemand(['BTC-USDT-SWAP']),/market_source_stopped/);
});

test('polling never replays earlier returned trades and permits distinct samples at the cursor timestamp', async () => {
  const f=fixture({venues:['okx']}); try {
    await f.source.refreshCatalog(); f.advance(10); await f.source.setDemand(['BTC-USDT-SWAP']);
    // The first fresh sample may precede demand creation. Cursor starts from it.
    f.current('okx').batches.push([trade(50,initial+1),trade(100,initial+2)]); await f.source.refresh();
    assert.deepEqual(f.source.samples('BTC-USDT-SWAP').map(t=>t.price),[100]);
    f.advance(1); f.current('okx').batches.push([trade(70,initial+3)]); await f.source.refresh();
    f.advance(1); f.current('okx').batches.push([trade(50,initial+1),trade(100,initial+2)]); await f.source.refresh();
    // A replay of the latest row must not fall back to another unseen older row.
    f.advance(1); f.current('okx').batches.push([trade(50,initial+1),trade(70,initial+3)]); await f.source.refresh();
    f.advance(1); f.current('okx').batches.push([trade(90,initial+3,'BTC/USDT:USDT','distinct')]); await f.source.refresh();
    assert.deepEqual(f.source.samples('BTC-USDT-SWAP').map(t=>t.price),[100,70,90]);
    assert.equal(f.source.getPrices()[0]!.price,90); assert.equal(f.source.getPrices()[0]!.timestamp,initial+3);
    f.source.acknowledgeSamples('BTC-USDT-SWAP',f.source.samples('BTC-USDT-SWAP'));
    f.advance(1); f.current('okx').batches.push([trade(90,initial+3,'BTC/USDT:USDT','distinct')]); await f.source.refresh();
    assert.deepEqual(f.source.samples('BTC-USDT-SWAP'),[]); assert.equal(f.source.getPrices()[0]!.price,90);
  } finally {await f.source.stop();}
});

test('stream queue overflow clears crossings and isolates the affected instrument', async () => {
  const f=fixture({venues:['okx'],mode:'stream',maxQueue:3,maxBatch:10}); try {
    await f.source.setDemand(['BTC-USDT-SWAP','okx:spot:BTC-USDT']); await f.source.refresh();
    const e=f.current('okx'); await until(()=>e.watches.length===2);
    e.watches[0]!.resolve([trade(10),trade(20),trade(30),trade(40)]);
    await until(()=>f.source.diagnostics().instruments[0]!.code==='trade_queue_overflow');
    assert.equal(f.source.eligible('BTC-USDT-SWAP'),false); assert.equal(f.source.priceHealth().code,'trade_queue_overflow'); assert.equal(f.source.diagnostics().queued,0);
    assert.equal(f.source.resolve!('BTC-USDT-SWAP').stale,false);assert.equal(f.source.resolve!('BTC-USDT-SWAP').available,false);
    e.watches[1]!.resolve([trade(80,initial,'BTC/USDT')]); await until(()=>f.source.getPrices().length===1);
    assert.equal(f.source.getPrices()[0]!.instrument,'okx:spot:BTC-USDT'); assert.equal(f.source.priceHealth().state,'degraded');
    assert.equal(e.closed,0); assert.ok(f.source.diagnostics().queued<=3);
  } finally {await f.source.stop();}
});

test('ACK removes only captured counts, preserving identical-price arrivals during evaluation', async () => {
  const f=fixture({venues:['okx'],mode:'stream'}); try {
    await f.source.setDemand(['BTC-USDT-SWAP']); await f.source.refresh(); const e=f.current('okx');
    await until(()=>e.watches.length===1); e.watches[0]!.resolve([trade(100,initial,'BTC/USDT:USDT','first')]);
    await until(()=>f.source.samples('BTC-USDT-SWAP').length===1); const captured=f.source.samples('BTC-USDT-SWAP');
    await until(()=>e.watches.length===2); e.watches[1]!.resolve([trade(100,initial,'BTC/USDT:USDT','during-sql'),trade(150)]);
    await until(()=>f.source.samples('BTC-USDT-SWAP').length===3);
    assert.deepEqual(f.source.samples('BTC-USDT-SWAP')[1],captured[0],'Distinct trade IDs can map to identical PriceTicks');
    f.source.acknowledgeSamples('BTC-USDT-SWAP',captured);
    assert.deepEqual(f.source.samples('BTC-USDT-SWAP').map(t=>t.price),[100,150]); assert.equal(f.source.diagnostics().queued,2);
    assert.equal(f.source.getPrices()[0]!.price,150);
    f.source.acknowledgeSamples('BTC-USDT-SWAP',f.source.samples('BTC-USDT-SWAP')); assert.equal(f.source.diagnostics().queued,0);
  } finally {await f.source.stop();}
});

test('canonical SQL demand survives missing and unhealthy catalogs while venue availability stays independent', async () => {
  const f=fixture(); f.next.mexc=new MockExchange('mexc'); f.next.mexc.failCatalog=true;
  const ids=['BTC-USDT-SWAP','binance:swap:BTCUSDT','mexc:swap:BTC_USDT','okx:spot:ETH-USDT'];
  try {
    assert.equal(f.source.mode,'polling'); await f.source.setDemand(ids);
    assert.equal(f.exchanges.okx.length,0,'Demand itself does not open exchanges');
    assert.equal(f.source.diagnostics().instruments.length,4); await f.source.refreshCatalog();
    assert.equal(f.source.eligible(ids[0]!),true); assert.equal(f.source.eligible(ids[1]!),true);
    assert.equal(f.source.eligible(ids[2]!),false); assert.equal(f.source.eligible(ids[3]!),false);
    const snapshot=f.source.getMarkets(); assert.equal(snapshot.stale,true);
    assert.equal(snapshot.markets.find(m=>m.instrument===ids[0])!.available,true);
    assert.ok(Array.isArray(snapshot.sources));
    assert.equal(snapshot.sources.find(s=>s.venue==='okx')!.stale,false);
    assert.equal(snapshot.sources.find(s=>s.venue==='mexc')!.code,'catalog_unavailable');
    await assert.rejects(f.source.setDemand(['okx:swap:BTC-USDT-SWAP']),/instrument_unavailable/);
    assert.equal(f.source.diagnostics().instruments.length,4,'Invalid updates do not destroy existing demand');
    f.current('okx').batches.push([trade(100)]); f.current('binance').batches.push([trade(90)]); await f.source.refresh();
    assert.equal(f.source.getPrices().length,2); assert.equal(f.source.priceHealth().state,'degraded');
    f.advance(100); f.current('okx').failCatalog=true; await f.source.refreshCatalog();
    const unavailable=f.source.getMarkets().markets.find(m=>m.instrument===ids[0])!;
    assert.equal(unavailable.available,false); assert.equal(f.source.getMarkets().markets.find(m=>m.instrument===ids[1])!.available,true);
    assert.equal(f.source.diagnostics().instruments.length,4);
    await f.source.setDemand([]); const calls=Object.values(f.exchanges).flat().reduce((n,e)=>n+e.fetchCalls.length,0); await f.source.refresh();
    assert.equal(Object.values(f.exchanges).flat().reduce((n,e)=>n+e.fetchCalls.length,0),calls,'Zero demand does not poll trades');
  } finally {await f.source.stop();}
});

test('quiet stream waits past request timeout without claiming transport connectivity or reconnecting', async () => {
  const f=fixture({venues:['okx'],mode:'stream',requestTimeoutMs:10}); try {
    await f.source.setDemand(['BTC-USDT-SWAP']); await f.source.refresh(); const e=f.current('okx'); await until(()=>e.watches.length===1);
    await pause(35);
    assert.equal(e.closed,0); assert.equal(f.exchanges.okx.length,1); assert.equal(f.source.diagnostics().venues[0]!.priceCode,null);
    assert.equal(f.source.diagnostics().venues[0]!.clientOpen,true); assert.equal('connected' in f.source.diagnostics().venues[0]!,false);
    assert.equal(f.source.priceHealth().state,'unhealthy','A quiet socket provides no fresh price');
    e.watches[0]!.resolve([trade(100)]); await until(()=>f.source.getPrices().length===1); assert.equal(f.source.priceHealth().state,'healthy');
    await until(()=>e.watches.length===2); f.advance(30001); assert.deepEqual(f.source.getPrices(),[]); assert.equal(e.closed,0);
  } finally {await f.source.stop();}
});

test('restart requires a successful fresh catalog; confirmed delisting cannot resurrect from local history', async () => {
  const f=fixture({venues:['okx']});
  await f.source.refreshCatalog(); await f.source.setDemand(['BTC-USDT-SWAP']); f.advance(100); f.current('okx').metadata={}; await f.source.refreshCatalog();
  assert.equal(f.source.eligible('BTC-USDT-SWAP'),false); await f.source.stop();
  const restarted=fixture({venues:['okx']}); restarted.next.okx=new MockExchange('okx'); restarted.next.okx.failCatalog=true;
  try {
    await restarted.source.setDemand(['BTC-USDT-SWAP']); assert.equal(restarted.source.eligible('BTC-USDT-SWAP'),false);
    await restarted.source.refreshCatalog(); assert.deepEqual(restarted.source.getMarkets().markets,[]); assert.equal(restarted.source.eligible('BTC-USDT-SWAP'),false);
    restarted.advance(10); restarted.next.okx=new MockExchange('okx'); restarted.next.okx.metadata={}; await restarted.source.refreshCatalog();
    assert.equal(restarted.source.getMarkets().stale,false); assert.equal(restarted.source.eligible('BTC-USDT-SWAP'),false);
    assert.equal(restarted.source.diagnostics().instruments.length,1);
  } finally {await restarted.source.stop();}
});

test('public source sets independent Pro cache and REST page sizes without opening sockets', async () => {
  for (const mode of ['stream','polling'] as const) {
    const prototype=(mode==='stream'?ccxt.pro:ccxt).okx.prototype;
    let limit:number|undefined;
    const load=mock.method(prototype,'loadMarkets',async function(this:{options:Record<string,unknown>}) {
      limit=this.options.tradesLimit as number; return catalog(market('okx'));
    });
    const source=createPublicCcxtMarketSource({mode,venues:['okx']});
    try {await source.refreshCatalog(); assert.equal(source.getMarkets().stale,false); assert.equal(limit,mode==='stream'?1000:100); assert.equal(source.mode,mode);}
    finally {await source.stop();load.mock.restore();}
  }
  assert.throws(()=>createPublicCcxtMarketSource({mode:'polling',maxBatch:101}),/public_trade_page_capacity/);
  const custom=createPublicCcxtMarketSource({mode:'stream',maxBatch:2000}); await custom.stop();
  const config=publicExchangeConfig('okx',{mode:'stream',timeoutMs:1000,tradesLimit:1000});
  assert.equal(config.newUpdates,true); assert.equal(config.enableRateLimit,true); assert.equal(config.options!.tradesLimit,1000);
  for (const mode of ['stream','polling'] as const) for (const product of ['spot','swap'] as const) {
    const binance=publicExchangeConfig('binance',{mode,product,timeoutMs:1000,tradesLimit:100});
    assert.deepEqual(binance.options!.fetchMarkets,{types:[product==='spot'?'spot':'linear']});
    assert.equal((binance.urls as {api:{public:string}}).api.public,'https://api-gcp.binance.com/api/v3');
  }
});

test('ACKed high-volume stream traffic has bounded replay history independent of pending capacity', async () => {
  const f=fixture({venues:['okx'],mode:'stream',catalogTtlMs:3_600_000});
  try {
    await f.source.setDemand(['BTC-USDT-SWAP']); await f.source.refresh(); const e=f.current('okx');
    for (let batch=0;batch<50;batch++) {
      await until(()=>e.watches.length===batch+1);
      e.watches[batch]!.resolve(Array.from({length:100},(_,i)=>trade(100+i,f.time(),'BTC/USDT:USDT',`${batch}:${i}`)));
      await until(()=>f.source.samples('BTC-USDT-SWAP').length===100);
      f.source.acknowledgeSamples('BTC-USDT-SWAP',f.source.samples('BTC-USDT-SWAP'));
      assert.equal(f.source.diagnostics().queued,0); assert.equal(f.source.eligible('BTC-USDT-SWAP'),true);
      assert.equal(f.source.diagnostics().instruments[0]!.replayEntries,100);
      if(batch<49) f.advance(100);
    }
    await until(()=>e.watches.length===51);
    e.watches[50]!.resolve([trade(999,initial,'BTC/USDT:USDT','old-replay'),trade(100,f.time(),'BTC/USDT:USDT','49:0')]);
    await until(()=>e.watches.length===52); assert.deepEqual(f.source.samples('BTC-USDT-SWAP'),[]);
    // Thousands of unique trades sharing a millisecond are separate from the
    // pending queue cap too; each drained batch leaves the market usable.
    for(let batch=0;batch<45;batch++) {
      await until(()=>e.watches.length===52+batch);
      e.watches[51+batch]!.resolve(Array.from({length:100},(_,i)=>trade(90,f.time(),'BTC/USDT:USDT',`same:${batch}:${i}`)));
      await until(()=>f.source.samples('BTC-USDT-SWAP').length===100);
      f.source.acknowledgeSamples('BTC-USDT-SWAP',f.source.samples('BTC-USDT-SWAP'));
      assert.equal(f.source.eligible('BTC-USDT-SWAP'),true);
      assert.ok(f.source.diagnostics().instruments[0]!.replayEntries<=f.source.diagnostics().replayCapacity);
    }
  } finally {await f.source.stop();}
});

test('replay timestamp capacity fails closed and recovers on a newer timestamp', async () => {
  const f=fixture({venues:['okx'],mode:'stream',maxReplayEntries:2,maxBatch:10});
  try {
    await f.source.setDemand(['BTC-USDT-SWAP']); await f.source.refresh(); const e=f.current('okx');
    await until(()=>e.watches.length===1); e.watches[0]!.resolve([trade(120),trade(90)]);
    await until(()=>f.source.samples('BTC-USDT-SWAP').length===2); f.source.drainSamples('BTC-USDT-SWAP');
    await until(()=>e.watches.length===2); e.watches[1]!.resolve([trade(80)]);
    await until(()=>f.source.diagnostics().instruments[0]!.code==='trade_replay_capacity');
    assert.equal(f.source.eligible('BTC-USDT-SWAP'),false); assert.equal(f.source.diagnostics().queued,0);
    await until(()=>e.watches.length===3); e.watches[2]!.resolve([trade(120)]);
    await until(()=>e.watches.length===4); assert.deepEqual(f.source.samples('BTC-USDT-SWAP'),[]);
    // A transport fault must not remove the blocked timestamp. An unchanged
    // catalog/reconnected cache cannot replay ACKed extrema to clear the fault.
    e.watches[3]!.reject(new Error('disconnect')); await until(()=>e.closed===1);
    assert.equal(f.source.diagnostics().instruments[0]!.code,'trade_replay_capacity');
    f.advance(10); await f.source.refresh(); const current=f.current('okx'); await until(()=>current.watches.length===1);
    current.watches[0]!.resolve([trade(120),trade(90)]); await until(()=>current.watches.length===2);
    assert.equal(f.source.eligible('BTC-USDT-SWAP'),false); assert.deepEqual(f.source.samples('BTC-USDT-SWAP'),[]);
    f.advance(1); current.watches[1]!.resolve([trade(95,f.time())]);
    await until(()=>f.source.eligible('BTC-USDT-SWAP')); assert.deepEqual(f.source.samples('BTC-USDT-SWAP').map(t=>t.price),[95]);
  } finally {await f.source.stop();}
});

test('same-venue subscription changes preserve retained crossings and reject retired arrivals', async () => {
  const f=fixture({venues:['okx'],mode:'stream'});
  try {
    await f.source.setDemand(['BTC-USDT-SWAP']); await f.source.refresh(); const old=f.current('okx');
    await until(()=>old.watches.length===1); old.watches[0]!.resolve([trade(120),trade(90)]);
    await until(()=>f.source.samples('BTC-USDT-SWAP').length===2); const captured=f.source.samples('BTC-USDT-SWAP');
    await until(()=>old.watches.length===2);
    await f.source.setDemand(['BTC-USDT-SWAP','okx:spot:BTC-USDT']);
    assert.deepEqual(f.source.samples('BTC-USDT-SWAP'),captured); assert.equal(f.source.getPrices()[0]!.price,90);
    old.watches[1]!.resolve([trade(999)]); await pause(); assert.deepEqual(f.source.samples('BTC-USDT-SWAP'),captured);
    await f.source.refresh(); const current=f.current('okx'); await until(()=>current.watches.length===2);
    await f.source.setDemand(['BTC-USDT-SWAP']); assert.deepEqual(f.source.samples('BTC-USDT-SWAP'),captured);
    // The unchanged armed upper rule still has its accepted crossing after both changes.
    assert.equal(f.source.samples('BTC-USDT-SWAP').find(t=>t.price>=100)!.price,120);
    f.source.acknowledgeSamples('BTC-USDT-SWAP',captured); assert.equal(f.source.diagnostics().queued,0);
    await f.source.refresh(); const latest=f.current('okx'); await until(()=>latest.watches.length===1);
    latest.watches[0]!.resolve([trade(120),trade(90)]); await until(()=>latest.watches.length===2);
    assert.deepEqual(f.source.samples('BTC-USDT-SWAP'),[],'Reconnected CCXT replay must stay deduplicated after ACK');
  } finally {await f.source.stop();}
});

test('actual CCXT metadata parsers yield explicit supported flags for all six venue products', {timeout:20000}, async () => {
  const requests:URL[]=[];
  const transport:typeof fetch=async(input,init)=>{
    const url=new URL(String(input)); requests.push(url); assert.equal(init?.method,'GET');
    const response=publicExchangeFixture(url,initial); assert.ok(response&&response.kind==='catalog','Only offline catalog fixture routes are allowed');
    return Response.json(response.body);
  };
  const native=mock.method(globalThis,'fetch',async()=>{throw new Error('native_egress_denied');});
  const source=createPublicCcxtMarketSource({mode:'polling',fetchImplementation:transport,requestTimeoutMs:8000});
  try {
    await source.refreshCatalog(); const snapshot=source.getMarkets(); assert.equal(snapshot.stale,false,JSON.stringify(source.diagnostics())); assert.equal(snapshot.markets.length,12);
    for (const venue of ['binance','okx','mexc'] as const) for (const type of ['spot','swap'] as const) {
      assert.equal(snapshot.markets.filter(m=>m.venue===venue&&m.type===type).length,2); assert.ok(snapshot.markets.filter(m=>m.venue===venue&&m.type===type).every(m=>m.available));
    }
    assert.equal(requests.length,6);
    assert.deepEqual(requests.filter(url=>url.pathname==='/api/v3/exchangeInfo'&&url.hostname.endsWith('.binance.com')).map(url=>url.hostname),['api-gcp.binance.com']);
    assert.deepEqual(requests.filter(url=>url.pathname==='/fapi/v1/exchangeInfo').map(url=>url.hostname),['fapi.binance.com']);
    assert.equal(native.mock.callCount(),0);
  } finally {await source.stop();native.mock.restore();}
});
