/** Child-process-only public CCXT Pro method fixtures for the compiled browser suite.
 * The production factory still constructs the public ccxt.pro classes. This preload
 * substitutes unified metadata/trades only; it does not test CCXT HTTP/WS parsers.
 * Load AFTER local-test-transport and local-test-types, before the compiled app.
 * Socket/fetch denial remains installed, including for any unexpected CCXT call.
 */
import assert from 'node:assert/strict';
import ccxt from 'ccxt';
if (process.env.OPEN_ALERT_LOCAL_TEST !== '1' || process.env.NODE_ENV !== 'test' || !process.connected) {
  throw new Error('Browser CCXT fixtures require an explicit IPC-connected local test child');
}
const event = data => { if (process.connected) process.send(data); };
const instances = new WeakMap();
let serial = 0;
function state(exchange, venue) {
  let value = instances.get(exchange);
  if (!value) {
    assert.equal(exchange.id, venue);
    assert.equal(exchange.precisionMode, 4, 'Fixture prices use CCXT TICK_SIZE precision');
    assert.equal(exchange.enableRateLimit, true);
    assert.equal(exchange.newUpdates, true);
    assert.equal(exchange.options.tradesLimit, 1000);
    assert.equal(exchange.has.fetchCurrencies, false);
    assert.equal(exchange.has.watchTrades, true);
    assert(!exchange.apiKey && !exchange.secret && !exchange.password, 'Public fixtures require no credentials');
    value = { id: ++serial, closed: false, markets: null, pending: new Set() };
    instances.set(exchange, value);
  }
  assert.equal(value.closed, false, 'Closed fixture instance cannot be reused');
  return value;
}
function rows(venue, products = ['spot', 'swap']) {
  return ['BTC', 'ETH'].flatMap(base => products.map(type => {
    const swap = type === 'swap';
    return {
      id: venue === 'okx' ? `${base}-USDT${swap ? '-SWAP' : ''}` : venue === 'mexc' && swap ? `${base}_USDT` : `${base}USDT`,
      symbol: `${base}/USDT${swap ? ':USDT' : ''}`, base, quote: 'USDT', type,
      active: true, spot: !swap, swap, future: false, option: false, contract: swap,
      linear: swap ? true : undefined, inverse: swap ? false : undefined,
      settle: swap ? 'USDT' : undefined, contractSize: swap ? 0.01 : undefined,
      expiry: undefined, precision: { price: 0.1 },
    };
  }));
}
for (const venue of ['binance', 'okx', 'mexc']) {
  const prototype = ccxt.pro[venue].prototype;
  const originalClose = prototype.close;
  prototype.loadMarkets = async function (reload) {
    const fixture = state(this, venue);
    assert.equal(reload, true, 'Production source must explicitly load a complete catalog');
    let products = ['spot', 'swap'];
    if (venue === 'binance') {
      const types = this.options.fetchMarkets.types;
      assert.deepEqual(types, types[0] === 'spot' ? ['spot'] : ['linear'], 'Binance fixture must request one product per instance');
      products = types.map(type => type === 'linear' ? 'swap' : 'spot');
      assert.equal(this.urls.api.public, 'https://api-gcp.binance.com/api/v3');
    }
    const markets = rows(venue, products);
    fixture.markets = Object.fromEntries(markets.map(market => [market.symbol, market]));
    event({ type: 'transport', provider: 'ccxt-method-fixture', venue, operation: 'catalog', method: 'loadMarkets', instance: fixture.id, rows: markets.length });
    return structuredClone(fixture.markets);
  };
  const trade = function (method, symbol, since, limit) {
    const fixture = state(this, venue);
    assert(fixture.markets?.[symbol], 'Trade demand must use loaded unified market symbols');
    assert.equal(since, undefined);
    assert.equal(limit, undefined);
    return new Promise((resolve, reject) => {
      const work = { timer: null, reject };
      work.timer = setTimeout(() => {
        fixture.pending.delete(work);
        if (fixture.closed) return reject(new Error('Fixture exchange closed'));
        const timestamp = Date.now(), id = String(++serial);
        event({ type: 'transport', provider: 'ccxt-method-fixture', venue, operation: 'trades', method, symbol, instance: fixture.id });
        resolve([{ id, symbol, timestamp, price: symbol.startsWith('BTC/') ? 60000 : 3000, amount: 1, side: 'buy' }]);
      }, 50);
      fixture.pending.add(work);
    });
  };
  prototype.watchTrades = function (symbol, since, limit) { return trade.call(this, 'watchTrades', symbol, since, limit); };
  // An accidental REST path must be visible in evidence and cannot reach the network.
  prototype.fetchTrades = function (symbol, since, limit) { return trade.call(this, 'fetchTrades', symbol, since, limit); };
  prototype.close = async function (...args) {
    const fixture = instances.get(this);
    if (fixture && !fixture.closed) {
      fixture.closed = true;
      for (const work of fixture.pending) { clearTimeout(work.timer); work.reject(new Error('Fixture exchange closed')); }
      fixture.pending.clear();
      event({ type: 'transport', provider: 'ccxt-method-fixture', venue, operation: 'close', instance: fixture.id });
    }
    return originalClose.apply(this, args);
  };
}
event({ type: 'ccxt-fixtures-ready', venues: ['binance', 'okx', 'mexc'], methods: ['loadMarkets', 'watchTrades', 'fetchTrades', 'close'] });

// Display clients use regular CCXT and do not create monitor demand.
for(const venue of ['binance','okx','mexc']){
 const prototype=ccxt[venue].prototype;
 prototype.loadMarkets=async function(reload){
  assert.equal(reload,true);assert.equal(this.options.tradesLimit,100);
  const products=venue==='binance'?this.options.fetchMarkets.types.map(t=>t==='linear'?'swap':'spot'):['spot','swap'];
  this.markets=Object.fromEntries(rows(venue,products).map(m=>[m.symbol,m]));
  event({type:'transport',provider:'display-quote-fixture',venue,operation:'display_catalog'});
  return structuredClone(this.markets);
 };
 prototype.fetchTicker=async function(symbol){
  assert(this.markets[symbol]);event({type:'transport',provider:'display-quote-fixture',venue,operation:'display_quote',symbol});
  return {symbol,last:symbol.startsWith('BTC/')?60000:3000,timestamp:Date.now()};
 };
 prototype.fetchTrades=async function(symbol,since,limit){
  assert(this.markets[symbol]);assert.equal(since,undefined);assert.equal(limit,100);
  event({type:'transport',provider:'display-quote-fixture',venue,operation:'display_quote',symbol,method:'fetchTrades'});
  return [{symbol,price:symbol.startsWith('BTC/')?60000:3000,timestamp:Date.now()}];
 };
}
