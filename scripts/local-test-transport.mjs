/** Child-process-only test transport: no credentials, real external network or API mocks. */
import { Socket } from 'node:net';
import { syncBuiltinESMExports } from 'node:module';
if (process.env.OPEN_ALERT_LOCAL_TEST !== '1' || process.env.NODE_ENV !== 'test') throw new Error('Test transport requires explicit local test environment');
const event = data => { if (process.connected) process.send(data); };
// This compiled-server child needs no outbound socket: all provider fetches are in memory.
Socket.prototype.connect = function () {
  event({ type: 'blocked', host: 'unexpected outbound socket' });
  throw new Error('All outbound sockets blocked by local integration test');
};
syncBuiltinESMExports();
const info = console.info.bind(console);
console.info = (...args) => {
  const message = args.join(' ');
  if (message.startsWith('[Open Alert development email]')) {
    const match = message.match(/^\[Open Alert development email\] ([^\n]+)\n[\s\S]*code is (\d{6})\./);
    event({ type: 'email', to: message.split('\n')[0].replace('[Open Alert development email] ', ''), ...(match ? { otp: match[2] } : {}) });
    info('[LOCAL fakeemail] captured generated message; content redacted'); return;
  }
  info(...args);
};
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const reply = data => Response.json(data);
  if (url.origin === 'https://www.okx.com' && url.pathname === '/api/v5/public/instruments') {
    event({ type: 'transport', provider: 'okx', operation: 'catalog' });
    return reply({ code: '0', data: ['BTC','ETH'].map(base => ({ instType:'SWAP', instId:`${base}-USDT-SWAP`, state:'live', settleCcy:'USDT', tickSz:'0.1' })) });
  }
  if (url.origin === 'https://www.okx.com' && url.pathname === '/api/v5/market/tickers') {
    event({ type: 'transport', provider: 'okx', operation: 'tickers' });
    return reply({ code:'0', data:['BTC','ETH'].map(base => ({instId:`${base}-USDT-SWAP`,last:base === 'BTC' ? '60000':'3000',ts:String(Date.now())})) });
  }
  if (url.origin === 'https://api.pushover.net') {
    const body = new URLSearchParams(String(init?.body ?? ''));
    if (body.get('user') !== 'LOCALUSER'.padEnd(30,'1') || body.get('token') !== 'LOCALTOKEN'.padEnd(30,'2')) {
      event({ type:'blocked', host:'unexpected fake notification credentials' }); throw new Error('Only synthetic fixture credentials accepted');
    }
    if (url.pathname === '/1/users/validate.json') { event({type:'transport',provider:'pushover',operation:'validate'}); return reply({status:1,request:'local-validation'}); }
    if (url.pathname === '/1/messages.json') { event({type:'transport',provider:'pushover',operation:'message',priority:body.get('priority')}); return reply({status:1,request:'local-message',receipt:'LOCALRECEIPT'.padEnd(30,'3')}); }
  }
  event({type:'blocked',host:url.hostname}); throw new Error('Unexpected outbound fetch blocked');
};
