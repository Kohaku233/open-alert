import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { instrumentSchema } from '../contracts/domain.js';
import type { CatalogSelection } from '../api/ports.js';
import type { SessionPrincipal } from '../contracts/api.js';
import type { LiveQuoteHub } from '../markets/live-quotes.js';
import type { MarketQuote } from '../markets/quotes.js';

/** Server -> client frames. Quotes are display-only; `changed` asks the client to
 * re-read its authoritative /api/status snapshot (alert latch, delivery state). */
export type RealtimeServerFrame =
  | { type: 'ready'; heartbeatMs: number }
  | { type: 'quote'; quote: MarketQuote }
  | { type: 'quote_error'; instrument: string; code: 'invalid_request' | 'service_unavailable' }
  | { type: 'changed'; scope: 'alerts' };
/** Client -> server frames. */
export type RealtimeClientFrame =
  | { type: 'subscribe'; instrument: string }
  | { type: 'unsubscribe'; instrument: string }
  | { type: 'ping' };

export const REALTIME_PATH = '/api/live';
export interface RealtimeGatewayOptions {
  trustedOrigins: readonly string[];
  authenticate(request: Request): Promise<SessionPrincipal | null>;
  resolve(instrument: string): Promise<CatalogSelection>;
  hub: LiveQuoteHub;
  maxSubscriptionsPerSocket?: number;
  maxSocketsPerUser?: number;
  heartbeatMs?: number;
}
export interface RealtimeGateway {
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void;
  /** Tell every open socket of this user that durable alert state changed. */
  notifyUser(userId: string): void;
  connections(): number;
  close(): Promise<void>;
}

function toRequest(incoming: IncomingMessage): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (Array.isArray(value)) for (const item of value) headers.append(name, item);
    else if (typeof value === 'string') headers.set(name, value);
  }
  return new Request(new URL(incoming.url ?? '/', 'http://localhost'), { headers });
}
function reject(socket: Duplex, status: number, text: string) {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

export function createRealtimeGateway(options: RealtimeGatewayOptions): RealtimeGateway {
  const maxSubscriptions = options.maxSubscriptionsPerSocket ?? 4;
  const maxSockets = options.maxSocketsPerUser ?? 8;
  const heartbeatMs = options.heartbeatMs ?? 25_000;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024, perMessageDeflate: false });
  const byUser = new Map<string, Set<WebSocket>>();
  const alive = new WeakMap<WebSocket, boolean>();
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (alive.get(ws) === false) { ws.terminate(); continue; }
      alive.set(ws, false); try { ws.ping(); } catch { ws.terminate(); }
    }
  }, heartbeatMs);
  heartbeat.unref?.();
  const send = (ws: WebSocket, frame: RealtimeServerFrame) => {
    // Drop frames to a slow reader instead of buffering without bound.
    if (ws.readyState === ws.OPEN && ws.bufferedAmount < 256 * 1024) ws.send(JSON.stringify(frame));
  };

  function attach(ws: WebSocket, principal: SessionPrincipal) {
    const subscriptions = new Map<string, () => void>();
    const pending = new Set<string>();
    const sockets = byUser.get(principal.userId) ?? new Set<WebSocket>();
    sockets.add(ws); byUser.set(principal.userId, sockets);
    alive.set(ws, true);
    ws.on('pong', () => alive.set(ws, true));
    ws.on('message', async (data, binary) => {
      alive.set(ws, true);
      if (binary) { ws.close(1003, 'text_only'); return; }
      let frame: RealtimeClientFrame;
      try { frame = JSON.parse(String(data)) as RealtimeClientFrame; } catch { ws.close(1007, 'invalid_json'); return; }
      if (!frame || typeof frame !== 'object') { ws.close(1007, 'invalid_frame'); return; }
      if (frame.type === 'ping') return;
      if (frame.type !== 'subscribe' && frame.type !== 'unsubscribe') { ws.close(1007, 'invalid_frame'); return; }
      const parsed = instrumentSchema.safeParse(frame.instrument);
      if (!parsed.success) { send(ws, { type: 'quote_error', instrument: String(frame.instrument).slice(0, 400), code: 'invalid_request' }); return; }
      const instrument = parsed.data;
      if (frame.type === 'unsubscribe') { pending.delete(instrument); subscriptions.get(instrument)?.(); subscriptions.delete(instrument); return; }
      if (subscriptions.has(instrument) || pending.has(instrument)) return;
      if (subscriptions.size + pending.size >= maxSubscriptions) { send(ws, { type: 'quote_error', instrument, code: 'service_unavailable' }); return; }
      pending.add(instrument);
      try {
        const selected = await options.resolve(instrument);
        if (!pending.has(instrument) || ws.readyState !== ws.OPEN) return;
        if (selected.stale) { send(ws, { type: 'quote_error', instrument, code: 'service_unavailable' }); return; }
        if (!selected.market || !selected.available || !selected.market.symbol) { send(ws, { type: 'quote_error', instrument, code: 'invalid_request' }); return; }
        subscriptions.set(instrument, options.hub.subscribe(selected.market, quote => send(ws, { type: 'quote', quote })));
      } catch { send(ws, { type: 'quote_error', instrument, code: 'service_unavailable' }); }
      finally { pending.delete(instrument); }
    });
    ws.on('close', () => {
      pending.clear();
      for (const release of subscriptions.values()) release();
      subscriptions.clear();
      sockets.delete(ws); if (!sockets.size) byUser.delete(principal.userId);
    });
    send(ws, { type: 'ready', heartbeatMs });
  }

  return {
    handleUpgrade(incoming, socket, head) {
      socket.on('error', () => socket.destroy());
      void (async () => {
        const request = toRequest(incoming);
        // Browsers always send Origin on WS; cookie auth requires a trusted one (CSWSH).
        const origin = request.headers.get('origin');
        if (!origin || !options.trustedOrigins.includes(origin)) return reject(socket, 403, 'Forbidden');
        let principal: SessionPrincipal | null = null;
        try { principal = await options.authenticate(request); } catch { return reject(socket, 403, 'Forbidden'); }
        if (!principal) return reject(socket, 401, 'Unauthorized');
        if ((byUser.get(principal.userId)?.size ?? 0) >= maxSockets) return reject(socket, 429, 'Too Many Requests');
        const user = principal;
        wss.handleUpgrade(incoming, socket, head, ws => attach(ws, user));
      })().catch(() => reject(socket, 500, 'Internal Server Error'));
    },
    notifyUser(userId) { for (const ws of byUser.get(userId) ?? []) send(ws, { type: 'changed', scope: 'alerts' }); },
    connections: () => wss.clients.size,
    async close() {
      clearInterval(heartbeat);
      for (const ws of wss.clients) ws.close(1001, 'server_shutdown');
      await new Promise<void>(resolve => wss.close(() => resolve()));
    },
  };
}
