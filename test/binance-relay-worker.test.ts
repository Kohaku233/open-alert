import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { Miniflare, Response as MfResponse } from 'miniflare';

const TOKEN = 'offline_worker_probe_token_01234567890123456789';
const RELAY_ORIGIN = 'https://relay.example.test';
const DESTINATION_ORIGIN = 'https://destination.example.test';
const TRADE = { a: 1, p: '100.00000001', q: '0.01000000', f: 1, l: 1, T: 1_700_000_000_000, m: false };
const loopback = (host: unknown) => typeof host === 'string' && ['localhost', '127.0.0.1', '::1', '[::1]'].includes(host);

test('workerd Binance relay: safe import, authenticated native fetch and redirects rejected before destination dispatch', { timeout: 30000 }, async t => {
  // Node may contact only Miniflare's local workerd control/dispatch sockets.
  // Worker HTTP is intercepted separately by outboundService below, never by a
  // replacement for globalThis.fetch inside the Worker.
  const denied: string[] = [];
  const deny = (path: string): never => { denied.push(path); throw new Error('offline_egress_denied'); };
  const nativeFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', function (input: RequestInfo | URL, init?: RequestInit) {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (!loopback(url.hostname)) return deny('node.fetch');
    return nativeFetch(input, init);
  });
  const connect = net.Socket.prototype.connect;
  t.mock.method(net.Socket.prototype, 'connect', function (this: net.Socket, ...args: any[]) {
    const normalized = Array.isArray(args[0]) ? args[0] : args;
    const first = normalized[0];
    // Node's normalized UNIX socket path is local too; no hostname is involved.
    const socketPath = typeof first === 'object' && first !== null ? first.path : typeof first === 'string' ? first : undefined;
    const host = typeof first === 'object' && first !== null ? first.host ?? 'localhost' : typeof normalized[1] === 'string' ? normalized[1] : 'localhost';
    if (!(typeof socketPath === 'string' && socketPath.startsWith('/')) && !loopback(host)) return deny('node.net');
    return (connect as (...args: any[]) => net.Socket).apply(this, args);
  });
  t.mock.method(tls, 'connect', () => deny('node.tls'));
  const lookup = dns.lookup;
  t.mock.method(dns, 'lookup', function (host: string, ...args: any[]) {
    if (!loopback(host)) return deny('node.dns.lookup');
    return (lookup as (...args: any[]) => unknown)(host, ...args);
  });
  for (const name of Object.keys(dns)) {
    if (name.startsWith('resolve') && typeof (dns as unknown as Record<string, unknown>)[name] === 'function') {
      t.mock.method(dns as unknown as Record<string, (...args: any[]) => any>, name, () => deny('node.dns.resolve'));
    }
  }
  syncBuiltinESMExports();

  let directory: string | undefined;
  let mf: Miniflare | undefined;
  const relayRequests: { path: string; authenticated: boolean; tokenInUrl: boolean }[] = [];
  const destinationRequests: { sameOrigin: boolean; tokenPresent: boolean }[] = [];
  const violations: string[] = [];
  const guard = (condition: boolean, message: string) => { if (!condition) violations.push(message); };
  try {
    directory = await mkdtemp(join(tmpdir(), 'open-alert-relay-workerd-'));
    const entry = join(directory, 'probe.ts'), bundle = join(directory, 'probe.js');
    // Bundle the real relay module using the existing CF test's conditions and
    // node:crypto alias. All three exports stay reachable to exercise lazy Node
    // imports without performing upstream discovery or creating a stream.
    await writeFile(entry, String.raw`import {createBinanceRelayFetch,createBinanceFuturesRelay,createBinanceRelayCcxtBoundaries} from ${JSON.stringify(resolve('src/markets/binance-relay.ts'))};
export default {async fetch(request){
 const path=new URL(request.url).pathname;
 if(path==='/import')return Response.json({relayFetch:typeof createBinanceRelayFetch,relayService:typeof createBinanceFuturesRelay,boundaries:typeof createBinanceRelayCcxtBoundaries});
 if(path==='/crypto'){
  const unexpected=async()=>{throw new Error('unexpected_upstream');};
  const relay=await createBinanceFuturesRelay({token:${JSON.stringify(TOKEN)},boundaries:{catalog:unexpected,stream:unexpected}});
  try{return Response.json({status:(await relay.handle(new Request('https://relay.internal/fapi/v1/exchangeInfo'))).status});}finally{await relay.close();}
 }
 if(path==='/https'){const boundaries=await createBinanceRelayCcxtBoundaries();try{return Response.json({catalog:typeof boundaries.catalog,stream:typeof boundaries.stream});}finally{await boundaries.close?.();}}
 // Positive control: prove a native fetch would follow the mocked redirect and
 // reach a valid destination if the adapter's redirect policy regresses.
 if(path==='/follow-control'){const response=await fetch('${RELAY_ORIGIN}/control');return Response.json({status:response.status,redirected:response.redirected,body:await response.json()});}
 if(path==='/denied'){const response=await fetch('https://denied.invalid/');return Response.json({status:response.status});}
 if(path!=='/healthy'&&!/^\/redirect\/(301|302|303|307|308)\/(same|cross)$/.test(path))return new Response('missing',{status:404});
 const relayFetch=createBinanceRelayFetch({url:'${RELAY_ORIGIN}/binance'+path,token:${JSON.stringify(TOKEN)},timeoutMs:5000});
 try{
  const source=new Request('https://fapi.binance.com/fapi/v1/aggTrades?symbol=BTCUSDT&limit=100',{headers:{authorization:'Bearer caller-fixture',cookie:'caller-fixture','x-mbx-apikey':'caller-fixture'}});
  return await relayFetch(source,{redirect:'follow'});
 }catch(error){return Response.json({error:error instanceof Error?error.message:'unexpected_error'},{status:502});}
}};`);
    await build({ entryPoints: [entry], outfile: bundle, bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true,
      external: ['node:*'], alias: { crypto: 'node:crypto' }, conditions: ['workerd', 'worker', 'browser'], nodePaths: [resolve('node_modules')] });
    let denialRequests = 0;
    mf = new Miniflare({ workers: [{
      config: { name: 'binance-relay-offline', compatibilityDate: '2026-10-11', compatibilityFlags: ['nodejs_compat'],
        manifest: { mainModule: 'probe.js', modulesRoot: directory, modules: { 'probe.js': { type: 'esm', contents: await readFile(bundle, 'utf8') } } } },
      dev: { outboundService: { type: 'fetcher', handler: async request => {
        const url = new URL(request.url);
        if ([RELAY_ORIGIN, DESTINATION_ORIGIN].includes(url.origin) && url.pathname === '/capture') {
          // Record a leak as a boolean, never a bearer value, even on failure.
          destinationRequests.push({ sameOrigin: url.origin === RELAY_ORIGIN,
            tokenPresent: request.url.includes(TOKEN) || JSON.stringify([...request.headers]).includes(TOKEN) || (await request.text()).includes(TOKEN) });
          return MfResponse.json([TRADE]);
        }
        if (url.href === RELAY_ORIGIN + '/control') return new MfResponse(null, { status: 302, headers: { location: DESTINATION_ORIGIN + '/capture' } });
        if (url.href === 'https://denied.invalid/') { denialRequests++; return new MfResponse('offline_egress_denied', { status: 599 }); }
        const match = url.pathname.match(/^\/binance(\/healthy|\/redirect\/(301|302|303|307|308)\/(same|cross))\/fapi\/v1\/aggTrades$/);
        if (url.origin !== RELAY_ORIGIN || !match) {
          violations.push('unexpected_worker_destination');
          return new MfResponse('offline_egress_denied', { status: 599 });
        }
        const authenticated = request.headers.get('authorization') === `Bearer ${TOKEN}`;
        const tokenInUrl = request.url.includes(TOKEN);
        relayRequests.push({ path: match[1]!, authenticated, tokenInUrl });
        guard(authenticated, 'relay_authentication_missing');
        guard(!tokenInUrl && !url.username && !url.password, 'relay_token_in_url');
        guard(request.method === 'GET' && await request.text() === '', 'relay_method_or_body');
        guard(request.headers.get('accept') === 'application/json', 'relay_accept_header');
        for (const header of ['cookie', 'x-mbx-apikey', 'proxy-authorization']) guard(!request.headers.has(header), 'caller_header_forwarded');
        guard([...request.headers].every(([name, value]) => name === 'authorization' || !value.includes(TOKEN)), 'relay_token_in_other_header');
        guard(url.search === '?symbol=BTCUSDT&limit=100', 'relay_query_changed');
        if (match[2]) return new MfResponse(`redirect fixture ${TOKEN}`, { status: Number(match[2]),
          headers: { location: (match[3] === 'same' ? RELAY_ORIGIN : DESTINATION_ORIGIN) + '/capture' } });
        return authenticated ? MfResponse.json([TRADE]) : new MfResponse('unauthorized', { status: 401 });
      } } },
    }] });
    const worker = mf;
    await t.test('module import performs no outbound requests', async () => {
      const response = await worker.dispatchFetch('https://probe.internal/import');
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { relayFetch: 'function', relayService: 'function', boundaries: 'function' });
      assert.equal(relayRequests.length, 0); assert.equal(destinationRequests.length, 0); assert.deepEqual(violations, []);
    });
    await t.test('lazy node:crypto initialization rejects unauthenticated requests without egress', async () => {
      const response = await worker.dispatchFetch('https://probe.internal/crypto');
      assert.equal(response.status, 200); assert.deepEqual(await response.json(), { status: 401 });
      assert.equal(relayRequests.length, 0); assert.equal(destinationRequests.length, 0); assert.deepEqual(violations, []);
    });
    await t.test('lazy node:https boundary constructs and closes without egress', async () => {
      const response = await worker.dispatchFetch('https://probe.internal/https');
      assert.equal(response.status, 200); assert.deepEqual(await response.json(), { catalog: 'function', stream: 'function' });
      assert.equal(relayRequests.length, 0); assert.equal(destinationRequests.length, 0); assert.deepEqual(violations, []);
    });
    await t.test('native fetch positive control follows a redirect entirely within the outbound mock', async () => {
      const response = await worker.dispatchFetch('https://probe.internal/follow-control');
      assert.equal(response.status, 200); assert.deepEqual(await response.json(), { status: 200, redirected: true, body: [TRADE] });
      assert.deepEqual(destinationRequests, [{ sameOrigin: false, tokenPresent: false }]);
      destinationRequests.length = 0;
    });
    await t.test('authenticated native Worker fetch returns the exact healthy raw trade response', async () => {
      const response = await worker.dispatchFetch('https://probe.internal/healthy');
      assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.deepEqual(await response.json(), [TRADE]);
      assert.deepEqual(relayRequests, [{ path: '/healthy', authenticated: true, tokenInUrl: false }]);
      assert.deepEqual(destinationRequests, []); assert.deepEqual(violations, []);
    });
    for (const status of [301, 302, 303, 307, 308]) for (const destination of ['same', 'cross']) {
      await t.test(`${status} ${destination} origin redirect rejects without destination dispatch or token leakage`, async () => {
        const before = relayRequests.length;
        const path = `/redirect/${status}/${destination}`;
        const response = await worker.dispatchFetch('https://probe.internal' + path);
        assert.equal(response.status, 502);
        const body = await response.text();
        assert.equal(body, '{"error":"relay_unavailable"}');
        assert.ok(!body.includes(TOKEN), 'Response must not expose the relay token or upstream body');
        assert.ok(!JSON.stringify([...response.headers]).includes(TOKEN), 'Response headers must not expose the relay token');
        assert.equal(relayRequests.length, before + 1, 'Exactly one configured relay request is dispatched');
        assert.deepEqual(relayRequests.at(-1), { path, authenticated: true, tokenInUrl: false });
        assert.deepEqual(destinationRequests, [], 'Redirect destination must never be dispatched, even on the same origin');
        assert.deepEqual(violations, [], 'Do not let sanitized adapter errors hide transport violations');
      });
    }
    await t.test('unknown Worker hosts are denied by the outbound mock', async () => {
      const response = await worker.dispatchFetch('https://probe.internal/denied');
      assert.equal(response.status, 200); assert.deepEqual(await response.json(), { status: 599 });
      assert.equal(denialRequests, 1); assert.equal(relayRequests.length, 11); assert.deepEqual(destinationRequests, []);
    });
  } finally {
    try { await mf?.dispose(); } finally {
      try { if (directory) await rm(directory, { recursive: true, force: true }); } finally {
        t.mock.restoreAll(); syncBuiltinESMExports();
      }
    }
    assert.deepEqual(denied, [], 'No external Node network path may execute');
    assert.deepEqual(violations, [], 'All Worker outbound requests must satisfy the mock allowlist');
  }
});
