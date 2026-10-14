#!/usr/bin/env node
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createBinanceFuturesRelay, createBinanceRelayCcxtBoundaries } from '../src/markets/binance-relay.js';
import type { BinanceRelayServiceOptions } from '../src/markets/binance-relay.js';

// nativeMarketIdSchema allows 128 UTF-16 code units. A BMP character needs at
// most 3 UTF-8 bytes, each encoded as %XX (9 target characters per code unit).
// Supplementary characters use 4 bytes for 2 units, so this also bounds them.
export const MAX_RELAY_REQUEST_TARGET_LENGTH = '/fapi/v1/aggTrades?symbol=&limit=100'.length + 128 * 9;

/** Construction neither listens nor performs upstream work; only authorized
 * requests reach the injected service boundaries. Importing never starts the CLI. */
export async function createBinanceRelayServer(options: BinanceRelayServiceOptions) {
  const relay = await createBinanceFuturesRelay(options);
  const server = createServer({ maxHeaderSize: 4096, requestTimeout: 5000, headersTimeout: 5000, keepAliveTimeout: 5000 }, async (req, res) => {
    // No request bodies, absolute targets, user-controlled Host/forwarded URL,
    // credential headers, duplicate auth, or general-purpose forwarding.
    const authorizationCount = req.rawHeaders.filter((_, i) => i % 2 === 0 && req.rawHeaders[i]?.toLowerCase() === 'authorization').length;
    if (!req.url || !req.url.startsWith('/') || req.url.startsWith('//') || req.url.includes('\\') || req.url.length > MAX_RELAY_REQUEST_TARGET_LENGTH ||
        req.headers['transfer-encoding'] || req.headers['content-length'] && req.headers['content-length'] !== '0' || authorizationCount !== 1 ||
        req.headers['x-mbx-apikey'] || req.headers.cookie || req.headers['proxy-authorization']) {
      res.writeHead(400, { 'content-type': 'application/json', 'cache-control': 'no-store', connection: 'close' });
      res.end('{"code":-1,"msg":"unsupported_request"}'); return;
    }
    try {
      const request = new Request(`http://127.0.0.1${req.url}`, { method: req.method ?? 'GET',
        headers: { authorization: req.headers.authorization ?? '' } });
      const response = await relay.handle(request);
      if (res.destroyed) return;
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(await response.text());
    } catch {
      if (!res.destroyed) { res.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end('{"code":-1,"msg":"unavailable"}'); }
    }
  });
  server.maxConnections = 32; server.maxHeadersCount = 16; server.maxRequestsPerSocket = 120;
  server.on('clientError', (_error, socket) => { socket.destroy(); });
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    const closed = new Promise<void>(done => { server.close(() => done()); });
    server.closeAllConnections();
    await Promise.all([closed, relay.close()]);
  })();
  return { server, close };
}

// Run with Node >=22.12 and --import tsx. No outbound work until an authorized
// request reaches one of the two public routes. No secrets or provider errors log.
async function main() {
  const token = process.env.RELAY_TOKEN ?? '';
  const portText = process.env.RELAY_PORT ?? '8788';
  const bind = process.env.RELAY_BIND ?? '127.0.0.1';
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(token) || !/^\d{1,5}$/.test(portText) ||
      Number(portText) < 1 || Number(portText) > 65535 || !['127.0.0.1', '::1', '0.0.0.0', '::'].includes(bind)) {
    throw new Error('invalid_relay_configuration');
  }
  const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy;
  const boundaries = await createBinanceRelayCcxtBoundaries({
    ...(proxy ? { httpsProxy: proxy } : {}),
  });
  const { server, close } = await createBinanceRelayServer({ token, boundaries });
  process.once('SIGINT', () => { void close(); }); process.once('SIGTERM', () => { void close(); });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject); server.listen(Number(portText), bind, () => { server.removeListener('error', reject); resolve(); });
    });
    server.on('error', () => { process.exitCode = 1; void close(); });
    console.info('Binance futures relay listening; public polling only.');
  } catch { await close(); throw new Error('relay_start_failed'); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main().catch(() => { console.error('Binance futures relay failed; check local configuration.'); process.exitCode = 1; });
}
