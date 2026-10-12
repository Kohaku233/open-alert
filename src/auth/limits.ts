import type { SqlDatabase } from '../contracts/db.js';

/** App keys are separate from native per-path IP rules; last_request is this fixed window's start. */
export async function consumeAuthLimit(db: SqlDatabase, key: string, max: number, windowMs: number, now = Date.now()): Promise<{ allowed: boolean; retryAfter: number }> {
  const id = crypto.randomUUID();
  // Both CASE expressions read the old row on SQLite/D1 and PostgreSQL. Only expiry resets the start.
  const claim = await db.query<{ last_request: number }>(`INSERT INTO rate_limit (id, "key", count, last_request) VALUES (?, ?, 1, ?)
    ON CONFLICT ("key") DO UPDATE SET
      count=CASE WHEN rate_limit.last_request<=? THEN 1 ELSE rate_limit.count+1 END,
      last_request=CASE WHEN rate_limit.last_request<=? THEN ? ELSE rate_limit.last_request END
    WHERE rate_limit.last_request<=? OR rate_limit.count<?
    RETURNING last_request`,
    [id, key, now, now - windowMs, now - windowMs, now, now - windowMs, max]);
  if (claim.length === 1) return { allowed: true, retryAfter: 0 };
  const rows = await db.query<{ last_request: number }>('SELECT last_request FROM rate_limit WHERE "key"=?', [key]);
  return { allowed: false, retryAfter: Math.max(1, Math.ceil(((rows[0]?.last_request ?? now) + windowMs - now) / 1000)) };
}
export async function privateLimitKey(prefix: string, value: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
  return `app-auth:${prefix}:${Array.from(signature, byte => byte.toString(16).padStart(2, '0')).join('')}`;
}
