import test, { after, before, mock } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import { nativeMarketIdSchema } from '../src/contracts/domain.js';
import type { BinanceRelayBoundaries } from '../src/markets/binance-relay.js';
import { publicExchangeFixture } from './runtime-cloudflare-fixtures.js';

const TOKEN = 'offline_listener_token_01234567890123456789';
const INITIAL = 1_700_000_000_000;
const CATALOG = '/fapi/v1/exchangeInfo';
const target = (id: string) => `/fapi/v1/aggTrades?${new URLSearchParams({ symbol: id, limit: '100' })}`;
const ports = new Set<number>();
const denied: string[] = [];
let listener: typeof import('../scripts/binance-futures-relay.js');

before(async () => {
  const deny = (name: string) => (..._args: unknown[]): never => { denied.push(name); throw new Error('external_network_denied'); };
  const connect = net.Socket.prototype.connect;
  mock.method(net.Socket.prototype, 'connect', function (this: net.Socket, ...args: unknown[]) {
    // Node's HTTP agent passes normalized connect arguments as a tuple.
    const first = Array.isArray(args[0]) ? args[0][0] : args[0];
    const options = typeof first === 'object' && first !== null ? first as net.NetConnectOpts : undefined;
    const host = options && 'host' in options ? options.host : args[1];
    const port = options && 'port' in options ? options.port : first;
    if (host !== '127.0.0.1' || !ports.has(Number(port))) return deny('net.connect')();
    return Reflect.apply(connect, this, args) as net.Socket;
  });
  const request = http.request;
  mock.method(http, 'request', function (...args: unknown[]) {
    const options = args[0] as http.RequestOptions;
    if (options.hostname !== '127.0.0.1' || !ports.has(Number(options.port))) return deny('http.request')();
    return Reflect.apply(request, http, args) as http.ClientRequest;
  });
  mock.method(http, 'get', deny('http.get'));
  mock.method(globalThis, 'fetch', deny('fetch'));
  mock.method(tls, 'connect', deny('tls.connect'));
  mock.method(https, 'request', deny('https.request')); mock.method(https, 'get', deny('https.get'));
  const lookup = dns.lookup;
  mock.method(dns, 'lookup', (...args: unknown[]) => {
    if (args[0] !== '127.0.0.1') return deny('dns.lookup')();
    return Reflect.apply(lookup, dns, args);
  });
  mock.method(dns, 'resolve', deny('dns.resolve'));
  syncBuiltinESMExports();
  listener = await import('../scripts/binance-futures-relay.js');
});
after(() => {
  mock.restoreAll(); syncBuiltinESMExports();
  assert.deepEqual(denied, [], 'No egress attempt may be swallowed by the relay');
});

function fixture(rows: { id: string; base: string }[] = [{ id: 'BTCUSDT', base: 'BTC' }]) {
  let loads = 0, closes = 0, streamCloses = 0;
  const starts: string[] = [];
  const pending = new Map<string, (value: unknown) => void>();
  const boundaries: BinanceRelayBoundaries = {
    catalog: async () => {
      loads++;
      const raw = publicExchangeFixture(new URL(`https://fapi.binance.com${CATALOG}`), INITIAL);
      assert.ok(raw?.kind === 'catalog');
      const info = structuredClone(raw.body) as Record<string, unknown> & { symbols: Record<string, unknown>[] };
      const template = info.symbols[0]!;
      info.assets = [{ asset: 'USDT', marginAvailable: true, autoAssetExchange: '-10000' }];
      info.symbols = rows.map(row => ({ ...structuredClone(template), symbol: row.id, baseAsset: row.base }));
      return { capturedAt: INITIAL, exchangeInfo: info };
    },
    stream: async market => {
      starts.push(market.nativeId);
      let settle: ((value: unknown) => void) | undefined;
      return {
        next: () => new Promise(resolve => { settle = resolve; pending.set(market.nativeId, resolve); }),
        close: async () => { streamCloses++; pending.delete(market.nativeId); settle?.([]); },
      };
    },
    close: async () => { closes++; },
  };
  return { boundaries, starts, counts: () => ({ loads, closes, streamCloses }), emit: (id: string) => {
    const row = rows.find(row => row.id === id)!;
    const resolve = pending.get(id); assert.ok(resolve, 'Stream must already have a pending read');
    resolve([{ symbol: `${row.base.toUpperCase()}/USDT:USDT`, info: { e: 'aggTrade', s: id,
      a: 1, p: '100.00000001', q: '0.01000000', f: 1, l: 1, T: INITIAL, m: false } }]);
  } };
}
async function start(f = fixture()) {
  const service = await listener.createBinanceRelayServer({ token: TOKEN, boundaries: f.boundaries, now: () => INITIAL });
  assert.equal(service.server.listening, false);
  assert.deepEqual(f.counts(), { loads: 0, closes: 0, streamCloses: 0 }, 'Factory must be lazy');
  service.server.listen(0, '127.0.0.1'); await once(service.server, 'listening');
  const address = service.server.address(); assert.ok(address && typeof address !== 'string');
  ports.add(address.port);
  return { ...service, ...f, port: address.port, stop: async () => { await service.close(); ports.delete(address.port); } };
}
async function send(port: number, path: string, options: { method?: string; headers?: string[]; body?: string } = {}) {
  const headers = options.headers ?? ['Authorization', `Bearer ${TOKEN}`, 'Connection', 'close'];
  const hasHost = headers.some((name, i) => i % 2 === 0 && name.toLowerCase() === 'host');
  return new Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, method: options.method ?? 'GET', agent: false,
      headers: hasHost ? headers : ['Host', 'ignored.example.test', ...headers] }, res => {
      let body = ''; res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; }); res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode!, body, headers: res.headers }));
    });
    req.on('error', reject); req.setTimeout(2000, () => req.destroy(new Error('loopback_request_timeout')));
    req.end(options.body);
  });
}

// Each request runs through Node's real HTTP parser and the real core service,
// including CCXT catalog parsing. Only upstream catalog/stream I/O is replaced.
test('listener polls supported Unicode native IDs above 256 characters, including a 128-unit native ID', async t => {
  const rows = [
    { id: `${'币'.repeat(30)}USDT`, base: '币'.repeat(30) },
    { id: `${'币'.repeat(32)}${'A'.repeat(92)}USDT`, base: '币'.repeat(32) },
    { id: `${'𐐀'.repeat(16)}USDT`, base: '𐐀'.repeat(16) },
  ];
  assert.equal(target(rows[0]!.id).length, 310);
  assert.equal(rows[1]!.id.length, 128);
  const f = await start(fixture(rows));
  try {
    for (const row of rows) await t.test(`${row.id.length} UTF-16 units, ${target(row.id).length} target characters`, async () => {
      assert.equal(nativeMarketIdSchema.safeParse(row.id).success, true);
      const cold = await send(f.port, target(row.id));
      assert.equal(cold.status, 503, 'A valid cold stream has no manufactured trade');
      assert.equal(JSON.parse(cold.body).code, -1);
      assert.equal(f.starts.at(-1), row.id, 'Encoded target must reach the exact catalog native ID');
      f.emit(row.id);
      const warm = await send(f.port, target(row.id));
      assert.equal(warm.status, 200);
      assert.deepEqual(JSON.parse(warm.body), [{ a: 1, p: '100.00000001', q: '0.01000000', f: 1, l: 1, T: INITIAL, m: false }]);
      assert.equal(warm.headers['cache-control'], 'no-store');
    });
    assert.equal(f.counts().loads, 1); assert.deepEqual(f.starts, rows.map(row => row.id));
  } finally { await f.stop(); }
  assert.deepEqual(f.counts(), { loads: 1, closes: 1, streamCloses: rows.length });
});

test('request-target cap admits the schema worst case and rejects one character beyond it before catalog I/O', async () => {
  const f = await start();
  try {
    const worst = target('币'.repeat(128));
    assert.equal(nativeMarketIdSchema.safeParse('币'.repeat(128)).success, true);
    assert.equal(worst.length, 1188); assert.equal(worst.length, listener.MAX_RELAY_REQUEST_TARGET_LENGTH);
    const tooLong = await send(f.port, `${worst}x`);
    assert.equal(tooLong.status, 400); assert.equal(tooLong.body, '{"code":-1,"msg":"unsupported_request"}');
    assert.equal(tooLong.headers.connection, 'close'); assert.equal(f.counts().loads, 0);
    const atLimit = await send(f.port, worst);
    assert.equal(atLimit.status, 400); assert.equal(atLimit.body, '{"code":-1,"msg":"unsupported_symbol"}');
    assert.equal(f.counts().loads, 1, 'At the cap the core still validates catalog membership');
    assert.deepEqual(f.starts, []);
  } finally { await f.stop(); }
});

test('listener retains malformed target, route, body and duplicate authorization protections before catalog I/O', async t => {
  const f = await start();
  const auth = ['Authorization', `Bearer ${TOKEN}`, 'Connection', 'close'];
  const cases: { name: string; path: string; method?: string; headers?: string[]; body?: string; status?: number }[] = [
    { name: 'absolute target', path: `http://example.test${CATALOG}` },
    { name: 'network-path target', path: `//example.test${CATALOG}` },
    { name: 'backslash', path: '/fapi\\v1/exchangeInfo' },
    { name: 'private route', path: '/fapi/v1/account' },
    { name: 'spot route', path: '/api/v3/exchangeInfo' },
    { name: 'encoded path', path: '/fapi/v1/%65xchangeInfo' },
    { name: 'fragment', path: `${CATALOG}#fragment` },
    { name: 'malformed percent encoding', path: '/fapi/v1/aggTrades?symbol=%E5%A&limit=100' },
    { name: 'malformed UTF-8', path: '/fapi/v1/aggTrades?symbol=%FF&limit=100' },
    { name: 'control in symbol', path: target('BTC\u0000USDT') },
    { name: 'whitespace in symbol', path: target('BTC USDT') },
    { name: '129 decoded units below target cap', path: target('A'.repeat(129)) },
    { name: 'extra query parameter', path: `${target('BTCUSDT')}&url=http://example.test` },
    { name: 'duplicate symbol', path: `${target('BTCUSDT')}&symbol=ETHUSDT` },
    { name: 'duplicate limit', path: `${target('BTCUSDT')}&limit=100` },
    { name: 'wrong limit', path: '/fapi/v1/aggTrades?symbol=BTCUSDT&limit=1' },
    { name: 'catalog query', path: `${CATALOG}?symbol=BTCUSDT` },
    { name: 'POST', path: CATALOG, method: 'POST' },
    { name: 'body', path: CATALOG, headers: [...auth, 'Content-Length', '4'], body: 'body' },
    { name: 'chunked body', path: CATALOG, headers: [...auth, 'Transfer-Encoding', 'chunked'], body: 'body' },
    { name: 'duplicate auth with mixed casing', path: CATALOG, headers: [...auth, 'aUtHoRiZaTiOn', `Bearer ${TOKEN}`] },
    { name: 'missing auth', path: CATALOG, headers: ['Connection', 'close'] },
    { name: 'wrong auth', path: CATALOG, headers: ['Authorization', 'Bearer offline_wrong', 'Connection', 'close'], status: 401 },
    ...['X-MBX-APIKEY', 'Cookie', 'Proxy-Authorization'].map(name => ({ name, path: CATALOG, headers: [...auth, name, 'offline_value'] })),
  ];
  try {
    for (const { name, path, status = 400, ...options } of cases) await t.test(name, async () => {
      const response = await send(f.port, path, options);
      assert.equal(response.status, status); assert.equal(response.headers['cache-control'], 'no-store');
      assert.equal(response.body.includes(TOKEN), false);
      assert.equal(f.counts().loads, 0); assert.deepEqual(f.starts, []);
    });
  } finally { await f.stop(); }
});

test('Host and forwarding headers do not change the fixed relay origin; zero length GET remains supported', async () => {
  const f = await start();
  try {
    const response = await send(f.port, CATALOG, { headers: ['Host', 'example.test:443', 'Authorization', `Bearer ${TOKEN}`,
      'Forwarded', 'host=other.example.test;proto=https', 'X-Forwarded-Host', 'other.example.test', 'X-Forwarded-Proto', 'https',
      'Content-Length', '0', 'Connection', 'close'] });
    assert.equal(response.status, 200); assert.equal(f.counts().loads, 1); assert.deepEqual(f.starts, []);
    assert.equal(f.server.maxConnections, 32); assert.equal(f.server.maxHeadersCount, 16); assert.equal(f.server.maxRequestsPerSocket, 120);
    const a = f.close(), b = f.close(); assert.equal(a, b); await a;
    assert.equal(f.server.listening, false); assert.equal(f.counts().closes, 1);
  } finally { await f.stop(); }
});

// Child processes receive only synthetic relay configuration. Preload a guard so
// even a startup regression cannot dispatch through native sockets/fetch/DNS.
const guardUrl = `data:text/javascript,${encodeURIComponent(`
  import net from 'node:net'; import tls from 'node:tls'; import http from 'node:http';
  import https from 'node:https'; import dns from 'node:dns'; import { syncBuiltinESMExports } from 'node:module';
  const deny = () => { process.stderr.write('external_network_denied\\n'); throw new Error('external_network_denied'); };
  const connect = net.Socket.prototype.connect, lookup = dns.lookup;
  net.Socket.prototype.connect = function (...args) {
    const first = Array.isArray(args[0]) ? args[0][0] : args[0];
    // tsx uses Unix/named-pipe IPC; it never reaches an IP network.
    if (typeof first === 'string' && !/^\\\\d+$/.test(first) || first && typeof first.path === 'string') {
      return Reflect.apply(connect, this, args);
    }
    return deny();
  };
  dns.lookup = (...args) => args[0] === '127.0.0.1' ? Reflect.apply(lookup, dns, args) : deny();
  globalThis.fetch = deny; tls.connect = deny;
  http.request = deny; http.get = deny; https.request = deny; https.get = deny; dns.resolve = deny;
  syncBuiltinESMExports();
`)}`;
function child(args: string[], env: Record<string, string> = {}) {
  const proc = spawn(process.execPath, ['--import', guardUrl, '--import', 'tsx', ...args], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  proc.stdout.setEncoding('utf8'); proc.stderr.setEncoding('utf8');
  proc.stdout.on('data', chunk => { stdout += chunk; }); proc.stderr.on('data', chunk => { stderr += chunk; });
  const timer = setTimeout(() => proc.kill('SIGKILL'), 10_000);
  const closed = once(proc, 'close').then(([code, signal]) => { clearTimeout(timer); return { code, signal, stdout, stderr }; });
  return { proc, closed };
}
test('import is inert with invalid environment; direct CLI keeps sanitized configuration failure', async () => {
  const script = fileURLToPath(new URL('../scripts/binance-futures-relay.ts', import.meta.url));
  const imported = await child(['--input-type=module', '-e', `await import(${JSON.stringify(new URL('../scripts/binance-futures-relay.ts', import.meta.url).href)});`]).closed;
  assert.deepEqual(imported, { code: 0, signal: null, stdout: '', stderr: '' });
  const failed = await child([script], { RELAY_TOKEN: 'offline_invalid_config' }).closed;
  assert.deepEqual(failed, { code: 1, signal: null, stdout: '', stderr: 'Binance futures relay failed; check local configuration.\n' });
});

test('direct CLI listens only on loopback without upstream work and exits cleanly on SIGTERM', async () => {
  const reserve = net.createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening');
  const address = reserve.address(); assert.ok(address && typeof address !== 'string');
  await new Promise<void>(resolve => reserve.close(() => resolve()));
  const run = child([fileURLToPath(new URL('../scripts/binance-futures-relay.ts', import.meta.url))], {
    RELAY_TOKEN: TOKEN, RELAY_BIND: '127.0.0.1', RELAY_PORT: String(address.port),
  });
  try {
    const ready = await Promise.race([
      once(run.proc.stdout, 'data').then(([chunk]) => String(chunk)),
      run.closed.then(() => ''),
    ]);
    assert.equal(ready, 'Binance futures relay listening; public polling only.\n');
    run.proc.kill('SIGTERM');
    assert.deepEqual(await run.closed, { code: 0, signal: null, stdout: ready, stderr: '' });
  } finally {
    if (run.proc.exitCode === null && run.proc.signalCode === null) run.proc.kill('SIGTERM');
    await run.closed;
  }
});
