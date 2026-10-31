/* Browser-side OKX REST client. The API key never leaves this module unsigned:
   every request is signed here with HMAC-SHA256 and sent through the stateless
   /api/trade/okx relay, which only forwards allowlisted paths. */
import { AppError, request } from '../api.js';
import { t } from '../i18n.js';

export interface OkxCredentials { key: string; secret: string; passphrase: string; demo: boolean }
export interface OkxInstrument { instId: string; ctVal: string; lotSz: string; minSz: string; tickSz: string; maxLever: number }

/** OKX answered and rejected the request; nothing was executed. */
export class OkxError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'OkxError'; }
}
/** The write may already have reached OKX. Reconcile by client order id; never resend. */
export class OkxUncertainError extends Error {
  /** signedAt bounds reconciliation: OKX rejects any request whose timestamp is over 30s old. */
  constructor(readonly signedAt = Date.now()) { super(t('交易所结果未知，可能已经生效。正在按客户端订单号核对，请勿重复下单。')); this.name = 'OkxUncertainError'; }
}

const encoder = new TextEncoder();
function base64(bytes: ArrayBuffer): string {
  let text = '';
  for (const byte of new Uint8Array(bytes)) text += String.fromCharCode(byte);
  return btoa(text);
}
/** OKX signature: base64(HMAC-SHA256(secret, timestamp + METHOD + requestPath + body)). */
export async function sign(secret: string, prehash: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return base64(await crypto.subtle.sign('HMAC', key, encoder.encode(prehash)));
}

type Params = Record<string, string | number | boolean | undefined>;
export function queryString(params: Params = {}): string {
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) if (value !== undefined && value !== '') search.set(name, String(value));
  return search.toString();
}

// OKX rejects requests whose timestamp is more than 30s off; known codes get readable text.
const okxMessages: Record<string, string> = {
  get 50102() { return t('本机时间与交易所相差过大，请校准系统时间后重试。'); },
  get 50103() { return t('API Key 无效或已删除。'); },
  get 50105() { return t('Passphrase 不正确。'); },
  get 50110() { return t('当前出口 IP 不在 API Key 的白名单里。'); },
  get 50111() { return t('API Key 无效或已删除。'); },
  get 50113() { return t('签名无效，请检查 Secret。'); },
  get 50119() { return t('API Key 不存在，请确认实盘与模拟盘设置一致。'); },
  get 50120() { return t('API Key 没有交易权限。'); },
  get 51008() { return t('保证金不足。'); },
  get 51603() { return t('订单不存在。'); },
};

export async function okxCall<T = Record<string, string>>(creds: OkxCredentials, method: 'GET' | 'POST', path: string, params?: Params | Params[], options: { signal?: AbortSignal } = {}): Promise<T[]> {
  const full = `/api/v5/${path}`;
  const query = method === 'GET' ? queryString(params as Params | undefined) : '';
  const body = method === 'POST' ? JSON.stringify(params ?? {}) : '';
  const signedAt = Date.now(), timestamp = new Date(signedAt).toISOString();
  const signature = await sign(creds.secret, `${timestamp}${method}${full}${query ? `?${query}` : ''}${body}`);
  let reply: { status: number; body: string };
  try {
    reply = await request<{ status: number; body: string }>('/api/trade/okx', 'POST', {
      method, path: full, query, body, simulated: creds.demo,
      headers: { key: creds.key, sign: signature, timestamp, passphrase: creds.passphrase },
    }, options);
  } catch (error) {
    // The relay call itself is a POST, so a lost response is uncertain for writes only.
    if (method === 'POST' && error instanceof AppError && (error.code === 'trade_uncertain' || error.code === 'request_uncertain')) throw new OkxUncertainError(signedAt);
    throw error;
  }
  return parseReply<T>(reply, method, signedAt);
}

export function parseReply<T>(reply: { status: number; body: string }, method: 'GET' | 'POST', signedAt = Date.now()): T[] {
  let parsed: { code?: unknown; msg?: unknown; data?: unknown };
  try { parsed = JSON.parse(reply.body) as typeof parsed; }
  catch {
    // A gateway page instead of JSON after a write means OKX may still have executed it.
    if (method === 'POST' && reply.status >= 500) throw new OkxUncertainError(signedAt);
    throw new OkxError('invalid_response', t('交易所返回了无法识别的内容（HTTP {0}）。', reply.status));
  }
  const code = String(parsed.code ?? '');
  const data = Array.isArray(parsed.data) ? parsed.data as (T & { sCode?: string; sMsg?: string })[] : [];
  if (code === '0') {
    const failed = data.find(item => item && item.sCode !== undefined && item.sCode !== '0');
    if (failed) throw new OkxError(failed.sCode!, okxMessages[failed.sCode!] ?? (failed.sMsg || t('交易所拒绝了请求（{0}）。', failed.sCode)));
    return data;
  }
  // Batch endpoints report "1"/"2" with per-item codes; surface the first item's reason.
  const item = data.find(entry => entry && entry.sCode && entry.sCode !== '0');
  const reason = item?.sCode ?? code;
  throw new OkxError(reason, okxMessages[reason] ?? (item?.sMsg || (typeof parsed.msg === 'string' && parsed.msg) || t('交易所拒绝了请求（{0}）。', reason)));
}

export function decimals(step: string): number {
  const [coefficient = '', exponent = '0'] = step.toLowerCase().split('e');
  const [, fraction = ''] = coefficient.split('.');
  return Math.max(0, fraction.replace(/0+$/, '').length - Number(exponent));
}
/** Floors to a step (lot or tick) and prints with that step's precision, avoiding float residue. */
export function floorTo(value: number, step: string): string {
  const unit = Number(step), places = decimals(step);
  if (!(unit > 0) || !Number.isFinite(value)) return '0';
  return (Math.floor(value / unit + 1e-9) * unit).toFixed(places);
}
export function roundTo(value: number, step: string): string {
  const unit = Number(step), places = decimals(step);
  if (!(unit > 0) || !Number.isFinite(value)) return '0';
  return (Math.round(value / unit) * unit).toFixed(places);
}
/** Swap orders are sized in contracts; one contract is ctVal units of the base coin. */
export function contractsFor(baseQty: number, inst: OkxInstrument): string { return floorTo(baseQty / Number(inst.ctVal), inst.lotSz); }
export function baseFor(contracts: number, inst: OkxInstrument): number {
  return Number((contracts * Number(inst.ctVal)).toFixed(decimals(inst.ctVal) + decimals(inst.lotSz)));
}
/** Client order ids are 1-32 alphanumerics; the prefix marks orders sent from Open Alert. */
export function clientOrderId(now = Date.now(), random = crypto.getRandomValues(new Uint8Array(8))): string {
  const tail = [...random].map(byte => (byte % 36).toString(36)).join('');
  return `oa${now.toString(36)}${tail}`.slice(0, 32);
}
export function parseInstrument(raw: Record<string, string>): OkxInstrument | null {
  const fields = ['instId', 'ctVal', 'lotSz', 'minSz', 'tickSz'] as const;
  if (fields.some(name => typeof raw[name] !== 'string' || !raw[name])) return null;
  return { instId: raw.instId!, ctVal: raw.ctVal!, lotSz: raw.lotSz!, minSz: raw.minSz!, tickSz: raw.tickSz!, maxLever: Number(raw.lever) || 0 };
}
