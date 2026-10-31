import { z } from 'zod';

/** Runtime-neutral OKX relay contract shared by the API route and the Node relay. */
export const OKX_HOST = 'www.okx.com';
export const OKX_GET_PATHS = [
  'account/balance', 'account/positions', 'account/config', 'account/leverage-info',
  'trade/orders-pending', 'trade/order', 'trade/fills', 'trade/orders-algo-pending', 'trade/order-algo',
  'public/instruments',
] as const;
export const OKX_POST_PATHS = [
  'trade/order', 'trade/cancel-order', 'trade/cancel-batch-orders', 'trade/amend-order', 'trade/order-algo', 'trade/amend-algos', 'trade/cancel-algos',
  'account/set-leverage',
] as const;
const allowed = { GET: new Set<string>(OKX_GET_PATHS.map(p => `/api/v5/${p}`)), POST: new Set<string>(OKX_POST_PATHS.map(p => `/api/v5/${p}`)) };

const header = (max: number) => z.string().min(1).max(max).regex(/^[\x21-\x7e]+$/);
export const okxRelaySchema = z.strictObject({
  method: z.enum(['GET', 'POST']),
  path: z.string().max(64),
  // Query strings are signed by the browser; only plain URL-safe characters are forwarded.
  query: z.string().max(512).regex(/^[A-Za-z0-9_\-.=&%]*$/).default(''),
  body: z.string().max(8192).default(''),
  headers: z.strictObject({ key: header(128), sign: header(128), timestamp: z.string().regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/), passphrase: z.string().min(1).max(128).regex(/^[\x20-\x7e]+$/) }),
  simulated: z.boolean().default(false),
}).superRefine((v, ctx) => {
  if (!allowed[v.method].has(v.path)) ctx.addIssue({ code: 'custom', path: ['path'], message: 'not allowed' });
  if (v.method === 'GET' && v.body) ctx.addIssue({ code: 'custom', path: ['body'], message: 'GET has no body' });
  if (v.method === 'POST' && v.query) ctx.addIssue({ code: 'custom', path: ['query'], message: 'POST has no query' });
  if (v.method === 'POST') { try { JSON.parse(v.body); } catch { ctx.addIssue({ code: 'custom', path: ['body'], message: 'JSON body required' }); } }
});
export type OkxRelayRequest = z.infer<typeof okxRelaySchema>;
export interface OkxRelayResponse { status: number; body: string }

/** The request may already have reached OKX; the caller must reconcile, never resend. */
export class RelayUncertainError extends Error { constructor() { super('relay_uncertain'); } }
/** The request never left this host (DNS, connect refused). Safe to report as a plain failure. */
export class RelayUnavailableError extends Error { constructor() { super('relay_unavailable'); } }

export interface OkxRelay { egress: string | null; forward(req: OkxRelayRequest): Promise<OkxRelayResponse> }
