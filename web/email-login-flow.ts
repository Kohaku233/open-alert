// Only resumable UI metadata belongs here. Never persist an OTP or session token.
export const EMAIL_LOGIN_STORAGE_KEY = 'open-alert-email-login-v1';
export const OTP_LIFETIME_MS = 5 * 60_000;
const RETENTION_MS = 30 * 60_000;
export interface EmailAttempt {
  email: string;
  requestedAt: number;
  expiresAt: number;
  retryAt: number;
  delivery: 'pending' | 'accepted' | 'uncertain' | 'failed';
}
export interface EmailLoginFlow { email: string; step: 'email' | 'code'; attempts: EmailAttempt[] }
export function emailAddress(value: string) {
  const normalized = value.trim().toLowerCase();
  return normalized.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) ? normalized : '';
}
function empty(): EmailLoginFlow { return { email: '', step: 'email', attempts: [] }; }
export function parseEmailLoginFlow(raw: string | null, now = Date.now()): EmailLoginFlow {
  try {
    if (!raw || raw.length > 16_384) return empty();
    const data = JSON.parse(raw);
    if (data.version !== 1 || typeof data.email !== 'string' || data.email.length > 254 || !Array.isArray(data.attempts)) return empty();
    const attempts: EmailAttempt[] = data.attempts.filter((a: EmailAttempt) => a && typeof a.email === 'string' && emailAddress(a.email) === a.email
      && ['pending', 'accepted', 'uncertain', 'failed'].includes(a.delivery)
      && [a.requestedAt, a.expiresAt, a.retryAt].every(Number.isSafeInteger)
      && a.requestedAt <= now && a.requestedAt > now - RETENTION_MS
      && a.expiresAt >= 0 && a.expiresAt <= a.requestedAt + OTP_LIFETIME_MS
      && a.retryAt >= a.requestedAt && a.retryAt <= a.requestedAt + 86_400_000).slice(-8).map((a: EmailAttempt) => ({
        email: a.email, requestedAt: a.requestedAt, expiresAt: a.expiresAt, retryAt: a.retryAt, delivery: a.delivery,
      }));
    const attempt = attempts.find(a => a.email === emailAddress(data.email));
    return { email: data.email, step: data.step === 'code' && attempt && attempt.delivery !== 'failed' ? 'code' : 'email', attempts };
  } catch { return empty(); }
}
export function readEmailLoginFlow(): EmailLoginFlow {
  try { return parseEmailLoginFlow(window.sessionStorage.getItem(EMAIL_LOGIN_STORAGE_KEY)); }
  catch { return empty(); }
}
export function saveEmailLoginFlow(flow: EmailLoginFlow) {
  try { window.sessionStorage.setItem(EMAIL_LOGIN_STORAGE_KEY, JSON.stringify({ version: 1, ...flow })); }
  catch { /* The current component still works when browser storage is disabled. */ }
}
export function clearEmailLoginFlow() {
  try { window.sessionStorage.removeItem(EMAIL_LOGIN_STORAGE_KEY); } catch { /* Storage can be disabled. */ }
}
export function withAttempt(flow: EmailLoginFlow, attempt: EmailAttempt): EmailLoginFlow {
  return { ...flow, attempts: [...flow.attempts.filter(a => a.email !== attempt.email && a.requestedAt > Date.now() - RETENTION_MS), attempt].slice(-8) };
}
