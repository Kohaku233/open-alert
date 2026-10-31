import { request as httpsRequest } from 'node:https';
import { okxRelaySchema, OKX_HOST, RelayUncertainError, RelayUnavailableError, type OkxRelay, type OkxRelayResponse } from './okx-contract.js';
export { RelayUncertainError, RelayUnavailableError, okxRelaySchema } from './okx-contract.js';

/**
 * Stateless OKX REST relay. The browser holds the API key and signs every
 * request; this module only forwards the already-signed request to a fixed
 * host over IPv4 so users can whitelist one egress address. Nothing is logged
 * or stored, and withdrawal/transfer endpoints are not reachable.
 */
export interface RawRequest { method: 'GET' | 'POST'; path: string; headers: Record<string, string>; body: string; timeoutMs: number }
export type RawSender = (req: RawRequest) => Promise<OkxRelayResponse>;

const MAX_RESPONSE = 2 * 1024 * 1024;
// Errors that prove no byte reached OKX; anything else after dispatch is uncertain.
const NOT_SENT = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH']);
export const nodeSender: RawSender = req => new Promise((resolve, reject) => {
  const r = httpsRequest({ host: OKX_HOST, family: 4, method: req.method, path: req.path, headers: req.headers, timeout: req.timeoutMs }, res => {
    const chunks: Buffer[] = []; let size = 0;
    res.on('data', (c: Buffer) => { size += c.length; if (size > MAX_RESPONSE) { r.destroy(); reject(new RelayUncertainError()); return; } chunks.push(c); });
    res.on('end', () => resolve({ status: res.statusCode ?? 502, body: Buffer.concat(chunks).toString('utf8') }));
    res.on('error', () => reject(new RelayUncertainError()));
  });
  r.on('timeout', () => r.destroy(new Error('timeout')));
  r.on('error', (error: NodeJS.ErrnoException) => reject(NOT_SENT.has(error.code ?? '') ? new RelayUnavailableError() : new RelayUncertainError()));
  r.end(req.body || undefined);
});

export function createOkxRelay(options: { send?: RawSender; egress?: string | null; timeoutMs?: number } = {}): OkxRelay {
  const send = options.send ?? nodeSender;
  return {
    egress: options.egress ?? null,
    async forward(req) {
      const parsed = okxRelaySchema.parse(req);
      const headers: Record<string, string> = {
        'OK-ACCESS-KEY': parsed.headers.key, 'OK-ACCESS-SIGN': parsed.headers.sign,
        'OK-ACCESS-TIMESTAMP': parsed.headers.timestamp, 'OK-ACCESS-PASSPHRASE': parsed.headers.passphrase,
        Accept: 'application/json', 'User-Agent': 'open-alert-relay',
      };
      if (parsed.method === 'POST') headers['Content-Type'] = 'application/json';
      if (parsed.simulated) headers['x-simulated-trading'] = '1';
      const path = parsed.path + (parsed.query ? `?${parsed.query}` : '');
      try { return await send({ method: parsed.method, path, headers, body: parsed.body, timeoutMs: options.timeoutMs ?? 8000 }); }
      catch (error) { if (error instanceof RelayUnavailableError || error instanceof RelayUncertainError) throw error; throw new RelayUncertainError(); }
    },
  };
}
