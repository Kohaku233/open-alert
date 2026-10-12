import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare } from 'miniflare';
import type { D1Database } from '@cloudflare/workers-types';
import { drizzle } from 'drizzle-orm/d1';
import { loadConfig } from '../src/config.js';
import { D1SqlDatabase } from '../src/db/d1.js';
import { migrateApp } from '../src/db/migrations.js';
import { migrateAuth } from '../src/auth/migrations.js';
import { createAuth } from '../src/auth/index.js';
import * as schema from '../src/auth/schema.sqlite.js';

test('real local workerd D1 applies trigger migrations and supports Better Auth OTP atomic registration', async () => {
  const mf = new Miniflare({ workers: [{ config: { name: 'auth-test', compatibilityDate: '2026-10-11', manifest: { mainModule: 'index.js', modulesRoot: '/', modules: { 'index.js': { type: 'esm', contents: 'export default { fetch(){return new Response("fixture")} }' } } }, env: { DB: { type: 'd1', id: 'open-alert-auth-local-test' } } } }] });
  try {
    const raw = await mf.getD1Database('DB') as unknown as D1Database;
    const db = new D1SqlDatabase(raw);
    await migrateAuth(db, 'tables'); await migrateApp(db); await migrateAuth(db, 'guards');
    const config = loadConfig({ NODE_ENV: 'test', DEPLOYMENT: 'cloudflare', DB_DRIVER: 'd1', APP_URL: 'https://alert.example.com', AUTH_SECRET: 'd1-auth-secret-at-least-thirty-two-characters', ENCRYPTION_KEY: '33'.repeat(32), EMAIL_PROVIDER: 'resend', EMAIL_FROM: 'alerts@example.com', RESEND_API_KEY: 'fixture-not-live', MAX_USERS: '1' });
    const codes = new Map<string, string>();
    const auth = await createAuth(config, db, drizzle(raw, { schema }), { testEmailTransport: { async verify() {}, async send(message) { codes.set(message.to, message.text.match(/code is (\d{6})/)![1]!); } } });
    const call = (path: string, body: object) => auth.handler(new Request(config.appUrl + '/api/auth' + path, { method: 'POST', headers: { origin: config.appUrl, 'content-type': 'application/json', 'x-open-alert-client-ip': '192.0.2.10' }, body: JSON.stringify(body) }));
    for (const email of ['d1-one@example.com', 'd1-two@example.com']) {
      await db.execute('INSERT INTO invitations(id,email,expires_at) VALUES(?,?,?)', [crypto.randomUUID(), email, Date.now() + 60_000]);
      const response = await call('/email-otp/send-verification-otp', { email, type: 'sign-in' }); assert.equal(response.status, 200, await response.text());
    }
    const responses = await Promise.all([...codes].map(([email, otp]) => call('/sign-in/email-otp', { email, otp })));
    assert.equal(responses.filter(r => r.status === 200).length, 1);
    assert.equal((await db.query('SELECT id FROM "user"')).length, 1);
    assert.equal((await db.query('SELECT id FROM invitations WHERE consumed_by IS NOT NULL')).length, 1);
    const winner = responses.find(r => r.status === 200)!;
    const cookie = winner.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
    assert.ok(await auth.getPrincipal(new Request(config.appUrl + '/api/status', { headers: { cookie } })));
    assert.equal((await auth.auth.$context).adapter.options?.transaction, false);
    auth.close();
  } finally { await mf.dispose(); }
});
