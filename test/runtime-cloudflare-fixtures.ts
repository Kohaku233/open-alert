import assert from 'node:assert/strict';

/** Raw public responses for the parsers in ccxt 4.5.85. No setMarkets shortcuts.
 * The handler returns null for every unknown route so callers can deny all egress.
 */
export function publicExchangeFixture(url:URL,at=Date.now(),serial=1):{kind:'catalog'|'trades';body:unknown}|null {
 const bases=['BTC','ETH'];
 const info=(swap:boolean,mexc=false)=>({timezone:'UTC',serverTime:at,rateLimits:[],exchangeFilters:[],symbols:bases.map(base=>({
  symbol:base+'USDT',status:mexc?'1':'TRADING',baseAsset:base,quoteAsset:'USDT',baseAssetPrecision:6,quoteAssetPrecision:1,
  isSpotTradingAllowed:true,isMarginTradingAllowed:false,permissions:['SPOT'],orderTypes:['LIMIT','MARKET'],
  filters:[{filterType:'PRICE_FILTER',minPrice:'0.1',maxPrice:'1000000',tickSize:'0.1'},{filterType:'LOT_SIZE',minQty:'0.001',maxQty:'10000',stepSize:'0.001'}],
  ...(swap?{contractType:'PERPETUAL',deliveryDate:4133404800000,onboardDate:1600000000000,marginAsset:'USDT',pricePrecision:1,quantityPrecision:3}:{}),
 }))});
 if(url.hostname==='api-gcp.binance.com'&&url.pathname==='/api/v3/exchangeInfo')return {kind:'catalog',body:info(false)};
 if(url.hostname==='fapi.binance.com'&&url.pathname==='/fapi/v1/exchangeInfo')return {kind:'catalog',body:info(true)};
 if(url.hostname==='www.okx.com'&&url.pathname==='/api/v5/public/instruments'){
  const type=url.searchParams.get('instType');assert.ok(type==='SPOT'||type==='SWAP');
  return {kind:'catalog',body:{code:'0',msg:'',data:bases.map(base=>({instType:type,instId:`${base}-USDT${type==='SWAP'?'-SWAP':''}`,baseCcy:base,quoteCcy:'USDT',state:'live',tickSz:'0.1',lotSz:'0.001',minSz:'0.001',expTime:'',stk:'',optType:'',
   ...(type==='SWAP'?{settleCcy:'USDT',uly:`${base}-USDT`,ctVal:'0.01',ctType:'linear',ctValCcy:base}:{settleCcy:''}),
  }))}};
 }
 if(url.hostname==='api.mexc.com'&&url.pathname==='/api/v3/exchangeInfo')return {kind:'catalog',body:info(false,true)};
 if(url.hostname==='api.mexc.com'&&url.pathname==='/api/v1/contract/detail')return {kind:'catalog',body:{success:true,code:0,data:bases.map(base=>({symbol:`${base}_USDT`,baseCoin:base,quoteCoin:'USDT',settleCoin:'USDT',contractSize:0.01,priceUnit:0.1,volUnit:1,minVol:1,maxVol:100000,state:0}))}};
 const agg=(host:string,path:string)=>url.hostname===host&&url.pathname===path;
 if(agg('api-gcp.binance.com','/api/v3/aggTrades')||agg('fapi.binance.com','/fapi/v1/aggTrades')||agg('api.mexc.com','/api/v3/aggTrades')){
  assert.match(url.searchParams.get('symbol')??'',/^(BTC|ETH)USDT$/);assert.equal(url.searchParams.get('limit'),'100');
  assert.equal(url.searchParams.has('startTime'),false,'Library must request the recent public page');
  return {kind:'trades',body:[{a:serial,f:serial,l:serial,p:'100',q:'1',T:at,m:false,M:true}]};
 }
 if(url.hostname==='www.okx.com'&&url.pathname==='/api/v5/market/trades'){
  assert.match(url.searchParams.get('instId')??'',/^(BTC|ETH)-USDT(-SWAP)?$/);assert.equal(url.searchParams.get('limit'),'100');
  return {kind:'trades',body:{code:'0',msg:'',data:[{instId:url.searchParams.get('instId'),side:'buy',sz:'1',px:'100',tradeId:String(serial),ts:String(at)}]}};
 }
 if(url.hostname==='api.mexc.com'&&/^\/api\/v1\/contract\/deals\/(BTC|ETH)_USDT$/.test(url.pathname))return {kind:'trades',body:{success:true,code:0,data:[{p:100,v:1,T:1,O:1,M:1,t:at}]}};
 return null;
}
