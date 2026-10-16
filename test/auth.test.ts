import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createNodeSqliteAuthDrizzle } from '../src/auth/drizzle.node-sqlite.js';
import { loadConfig } from '../src/config.js';
import { createAuth, DisabledAccountError } from '../src/auth/index.js';
import { migrateAuth } from '../src/auth/migrations.js';
import * as schema from '../src/auth/schema.sqlite.js';
import { SQLiteDatabase } from '../src/db/sqlite.js';
import type { SQLiteConnection } from '../src/db/sqlite.js';
import { migrateApp } from '../src/db/migrations.js';
import { createEmailTransport } from '../src/auth/email.js';
import type { EmailMessage } from '../src/auth/email.js';

async function fixture(overrides: Record<string, string> = {}) {
  const config = loadConfig({ NODE_ENV: 'test', APP_URL: 'http://localhost:3000', AUTH_SECRET: 'test-auth-secret-at-least-thirty-two-characters', ENCRYPTION_KEY: '11'.repeat(32), EMAIL_PROVIDER: 'console', ...overrides });
  const raw = new DatabaseSync(':memory:');
  const db = new SQLiteDatabase(raw as unknown as SQLiteConnection, 'node:sqlite');
  await migrateAuth(db, 'tables'); await migrateApp(db); await migrateAuth(db, 'guards');
  const messages: EmailMessage[] = [];
  const service = await createAuth(config, db, createNodeSqliteAuthDrizzle(raw), { testEmailTransport: { async verify() {}, async send(message) { messages.push(message); } } });
  const request = (path: string, body?: object, headers: Record<string, string> = {}) => new Request(config.appUrl + '/api/auth' + path, {
    method: body ? 'POST' : 'GET', headers: { origin: config.appUrl, 'content-type': 'application/json', 'x-open-alert-client-ip': '192.0.2.1', ...headers }, ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const call = (path: string, body?: object, headers?: Record<string, string>) => service.handler(request(path, body, headers));
  const invite = (email: string, expiry = Date.now() + 60_000) => db.execute('INSERT INTO invitations(id,email,expires_at) VALUES(?,?,?)', [crypto.randomUUID(), email, expiry]);
  const otp = () => messages.at(-1)!.text.match(/code is (\d{6})/)![1]!;
  const send = (email: string) => call('/email-otp/send-verification-otp', { email, type: 'sign-in' });
  const signIn = (email: string, code = otp(), extra: object = {}) => call('/sign-in/email-otp', { email, otp: code, ...extra });
  return { config, raw, db, service, messages, request, call, invite, otp, send, signIn, close: async () => { service.close(); await db.close(); } };
}
function cookie(response: Response) { return response.headers.getSetCookie().map(c => c.split(';')[0]).join('; '); }

test('real OTP handler registers invited normalized email, hashes OTP and issues 7-day DB cookie session', async () => {
  const f = await fixture();
  try {
    await f.invite('alice@example.com');
    const sent = await f.send('  Alice@Example.COM  ');
    assert.equal(sent.status, 200, await sent.text());
    assert.equal(f.messages.length, 1); const code = f.otp();
    const stored = await f.db.query<{ value: string; expires_at: number }>('SELECT value,expires_at FROM verification');
    assert.equal(stored.length, 1); assert.equal(stored[0]!.value.includes(code), false);
    assert.ok(stored[0]!.expires_at - Date.now() <= 300_000 && stored[0]!.expires_at - Date.now() > 290_000);
    const signed = await f.signIn('Alice@Example.COM', code, { role: 'admin' });
    assert.equal(signed.status, 200, await signed.clone().text());
    const body = await signed.json() as { user: { id: string; role: string; emailVerified: boolean } };
    assert.equal(body.user.role, 'user'); assert.equal(body.user.emailVerified, true);
    const cookies = signed.headers.getSetCookie().join('\n'); assert.match(cookies, /HttpOnly/i); assert.match(cookies, /SameSite=Lax/i);
    const principal = await f.service.getPrincipal(f.request('/get-session', undefined, { cookie: cookie(signed) }));
    assert.equal(principal?.userId, body.user.id); assert.equal(principal?.role, 'user');
    const invites = await f.db.query<{ consumed_by: string }>('SELECT consumed_by FROM invitations'); assert.equal(invites[0]?.consumed_by, body.user.id);
    const sessions = await f.db.query<{ expires_at: number; created_at: number }>('SELECT expires_at,created_at FROM session');
    assert.ok(Math.abs(sessions[0]!.expires_at - sessions[0]!.created_at - 604_800_000) < 2_000);
    assert.equal((await f.signIn('alice@example.com', code)).status, 400);
    assert.equal((await f.db.query('SELECT * FROM account WHERE password IS NOT NULL')).length, 0);
    assert.equal(f.service.capabilities().google, false);
  } finally { await f.close(); }
});

test('invitation required/expired, verified user-only hooks and SQL guards fail closed', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.send('missing@example.com')).status, 403);
    await f.invite('expired@example.com', Date.now() - 1);
    assert.equal((await f.send('expired@example.com')).status, 403);
    assert.equal(f.messages.length, 0);
    await assert.rejects(f.db.execute('INSERT INTO "user"(id,name,email,email_verified,role) VALUES(?,?,?,?,?)', ['x', 'x', 'missing@example.com', 1, 'user']), /AUTH_INVITATION_REQUIRED/);
    await f.invite('valid@example.com');
    await assert.rejects(f.db.execute('INSERT INTO "user"(id,name,email,email_verified,role) VALUES(?,?,?,?,?)', ['x', 'x', 'valid@example.com', 0, 'user']), /AUTH_VERIFIED_USER_REQUIRED/);
    assert.equal((await f.db.query('SELECT id FROM "user"')).length, 0);
    assert.equal((await f.db.query('SELECT id FROM invitations WHERE consumed_by IS NOT NULL')).length, 0);
  } finally { await f.close(); }
});

test('email resend cooldown persists across factory restart and IP change; attempt budget invalidates OTP', async () => {
  const f = await fixture({ INVITE_ONLY: 'false' });
  try {
    assert.equal((await f.send('budget@example.com')).status, 200);
    const correct = f.otp();
    const throttled = await f.call('/email-otp/send-verification-otp', { email: 'BUDGET@example.com', type: 'sign-in' }, { 'x-open-alert-client-ip': '192.0.2.2' });
    assert.equal(throttled.status, 429); assert.ok(Number(throttled.headers.get('Retry-After')) > 0);
    const restarted = await createAuth(f.config, f.db, createNodeSqliteAuthDrizzle(f.raw), { testEmailTransport: { async verify() {}, async send() { throw new Error('must not send'); } } });
    assert.equal((await restarted.handler(f.request('/email-otp/send-verification-otp', { email: 'budget@example.com', type: 'sign-in' }, { 'x-open-alert-client-ip': '192.0.2.3' }))).status, 429);
    restarted.close();
    const wrong = correct === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) assert.equal((await f.signIn('budget@example.com', wrong)).status, 400);
    assert.equal((await f.signIn('budget@example.com', correct)).status, 403);
    assert.equal((await f.db.query('SELECT id FROM "user"')).length, 0);
  } finally { await f.close(); }
});

test('expired OTP cannot sign in; disabled account denies existing session, new OTP and new session insert', async () => {
  const f = await fixture({ INVITE_ONLY: 'false' });
  try {
    await f.send('expired-code@example.com'); const expired = f.otp();
    await f.db.execute('UPDATE verification SET expires_at=?', [Date.now() - 1000]);
    assert.equal((await f.signIn('expired-code@example.com', expired)).status, 400);
    await f.send('blocked@example.com'); const signed = await f.signIn('blocked@example.com');
    assert.equal(signed.status, 200, await signed.clone().text());
    const user = (await signed.json() as { user: { id: string } }).user;
    await f.db.execute('INSERT INTO user_settings(user_id,enabled,disabled,generation,daily_limit,notification_json,created_at,updated_at) VALUES(?,0,1,0,20,?, ?,?)', [user.id, '{}', Date.now(), Date.now()]);
    await assert.rejects(f.service.getPrincipal(f.request('/get-session', undefined, { cookie: cookie(signed) })), DisabledAccountError);
    assert.equal((await f.call('/get-session', undefined, { cookie: cookie(signed) })).status, 403);
    await f.db.execute('DELETE FROM rate_limit');
    assert.equal((await f.send('blocked@example.com')).status, 403);
    await assert.rejects(f.service.auth.api.signInEmailOTP({ body: { email: 'blocked@example.com', otp: expired } }));
    await assert.rejects(f.db.execute('INSERT INTO session(id,user_id,token,expires_at,updated_at) VALUES(?,?,?,?,?)', ['session-block', user.id, 'never', Date.now()+1000, Date.now()]), /AUTH_ACCOUNT_DISABLED/);
  } finally { await f.close(); }
});

test('concurrent real OTP registrations cannot exceed MAX_USERS and only committed insert consumes invite', async () => {
  const f = await fixture({ MAX_USERS: '1' });
  try {
    await f.invite('one@example.com'); await f.invite('two@example.com');
    await f.send('one@example.com'); const one = f.otp(); await f.send('two@example.com'); const two = f.otp();
    const results = await Promise.all([f.signIn('one@example.com', one), f.signIn('two@example.com', two)]);
    assert.equal(results.filter(r => r.status === 200).length, 1);
    assert.equal((await f.db.query('SELECT id FROM "user"')).length, 1);
    assert.equal((await f.db.query('SELECT id FROM invitations WHERE consumed_by IS NOT NULL')).length, 1);
  } finally { await f.close(); }
});

test('password and OTP disclosure routes disabled; untrusted Origin rejected; Google start uses official OAuth', async () => {
  const f = await fixture({ INVITE_ONLY: 'false', GOOGLE_CLIENT_ID: 'fixture.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'fixture-secret' });
  try {
    for (const path of ['/sign-up/email', '/email-otp/get-verification-otp', '/email-otp/create-verification-otp', '/email-otp/reset-password']) assert.equal((await f.call(path, { email: 'x@example.com', password: 'not-allowed', type: 'sign-in' })).status, 404);
    assert.equal((await f.call('/email-otp/send-verification-otp', { email: 'x@example.com', type: 'sign-in' }, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await f.call('/email-otp/send-verification-otp', { email: 'x@example.com', type: 'forget-password' })).status, 403);
    const result = await f.call('/sign-in/social', { provider: 'google', callbackURL: f.config.appUrl });
    assert.equal(result.status, 200, await result.clone().text());
    const body = await result.json() as { url: string }; const url = new URL(body.url);
    assert.equal(url.hostname, 'accounts.google.com'); assert.ok(url.searchParams.get('state'));
    assert.equal(url.searchParams.get('redirect_uri'), f.config.appUrl + '/api/auth/callback/google');
    assert.equal(f.service.auth.options.account?.accountLinking?.disableImplicitLinking, false);
    assert.equal(f.service.capabilities().google, true);
    // This checks local OAuth initiation/state, not live Google token/profile verification.
  } finally { await f.close(); }
});

test('concurrent resend and replay remain single-use; native IP quota spans many normalized emails', async () => {
  const f = await fixture({ INVITE_ONLY: 'false' });
  try {
    const resends = await Promise.all(Array.from({ length: 5 }, () => f.send('race@example.com')));
    assert.equal(resends.filter(r => r.status === 200).length, 1); assert.equal(f.messages.length, 1);
    const code = f.otp();
    const logins = await Promise.all([f.signIn('race@example.com', code), f.signIn('race@example.com', code)]);
    assert.equal(logins.filter(r => r.status === 200).length, 1);
    assert.equal((await f.db.query('SELECT id FROM session')).length, 1);
    await f.db.execute('DELETE FROM rate_limit');
    for (let i = 0; i < 5; i++) assert.equal((await f.send(`ip-${i}@example.com`)).status, 200);
    const limited = await f.send('ip-final@example.com'); assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('Retry-After')) > 0);
  } finally { await f.close(); }
});

test('email delivery failure is explicit 503 and retryable capability; startup verify failure aborts factory', async () => {
  const f = await fixture({ INVITE_ONLY: 'false' });
  try {
    const failed = await createAuth(f.config, f.db, createNodeSqliteAuthDrizzle(f.raw), { testEmailTransport: { async verify() {}, async send() { throw new Error('sensitive provider detail never exposed'); } } });
    const response = await failed.handler(f.request('/email-otp/send-verification-otp', { email: 'failure@example.com', type: 'sign-in' }));
    assert.equal(response.status, 503); assert.equal((await response.text()).includes('sensitive'), false);
    assert.equal(failed.capabilities().emailOtp, true); assert.equal(failed.emailHealth().state, 'unhealthy');
    failed.close();
    await assert.rejects(createAuth(f.config, f.db, createNodeSqliteAuthDrizzle(f.raw), { testEmailTransport: { async verify() { throw new Error('bad readiness'); }, async send() {} } }), { code: 'email_unavailable' });
  } finally { await f.close(); }
});

test('Resend capabilities disclose only sender mode, preserve Google invitation policy, and do no startup HTTP for sandbox or sending-only', async () => {
  const f = await fixture();
  try {
    for (const sender of ['onboarding@resend.dev', 'alerts@example.com']) {
      const emailConfig = loadConfig({ ...f.config, NODE_ENV: 'test', APP_URL: f.config.appUrl, AUTH_SECRET: f.config.authSecret, ENCRYPTION_KEY: f.config.encryptionKey,
        EMAIL_PROVIDER: 'resend', EMAIL_FROM: sender, RESEND_API_KEY: 'private-fixture-key', RESEND_VERIFY_DOMAIN: 'false', EMAIL_TEST_RECIPIENT: 'private-owner@example.com',
        GOOGLE_CLIENT_ID: 'fixture-client', GOOGLE_CLIENT_SECRET: 'fixture-secret', INVITE_ONLY: 'true' });
      let requests = 0;
      const service = await createAuth(emailConfig, f.db, createNodeSqliteAuthDrizzle(f.raw), { emailTransportFactory: config => createEmailTransport(config, (async () => {
        requests++;
        throw new Error('Unexpected HTTP request');
      }) as typeof fetch) });
      try {
        const capabilities = service.capabilities();
        assert.equal(capabilities.emailSenderMode, sender === 'onboarding@resend.dev' ? 'resend_sandbox' : 'resend_sending_only');
        assert.equal(capabilities.emailOtp, true);
        assert.equal(capabilities.google, true);
        assert.equal(capabilities.inviteOnly, true);
        assert.equal(capabilities.registration, 'invite');
        assert.equal(requests, 0);
        const publicState = JSON.stringify({ capabilities, health: service.emailHealth() });
        for (const privateValue of [sender, 'private-fixture-key', 'private-owner@example.com']) assert.equal(publicState.includes(privateValue), false);
        assert.equal(service.emailHealth().lastSuccessAt, null);
        const response = await service.handler(f.request('/email-otp/send-verification-otp', { email: 'not-invited@example.com', type: 'sign-in' }));
        assert.equal(response.status, 403);
        assert.equal(requests, 0);
        await f.db.execute('DELETE FROM rate_limit');
      } finally { service.close(); }
    }
  } finally { await f.close(); }
});

test('secure cookies, role read from DB, signout revocation and unauthenticated explicit binding', async () => {
  const f = await fixture({ INVITE_ONLY: 'false', APP_URL: 'https://alert.example.com', GOOGLE_CLIENT_ID: 'fixture.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'fixture' });
  try {
    assert.equal((await f.call('/link-social', { provider: 'google', callbackURL: f.config.appUrl })).status, 403);
    await f.send('role@example.com'); const login = await f.signIn('role@example.com');
    assert.equal(login.status, 200); assert.match(login.headers.getSetCookie().join('\n'), /Secure/i);
    const user = (await login.json() as { user: { id: string } }).user;
    await f.db.execute('UPDATE "user" SET role=? WHERE id=?', ['admin', user.id]);
    assert.equal((await f.service.getPrincipal(f.request('/get-session', undefined, { cookie: cookie(login) })))?.role, 'admin');
    const signedOut = await f.call('/sign-out', {}, { cookie: cookie(login) }); assert.equal(signedOut.status, 200);
    assert.equal(await f.service.getPrincipal(f.request('/get-session', undefined, { cookie: cookie(login) })), null);
  } finally { await f.close(); }
});


test('invitation expiring after OTP delivery cannot register or consume the invitation', async () => {
  const f = await fixture();
  try {
    await f.invite('late@example.com');
    assert.equal((await f.send('late@example.com')).status, 200);
    const code = f.otp();
    await f.db.execute('UPDATE invitations SET expires_at=? WHERE email=?', [Date.now() - 1, 'late@example.com']);
    assert.equal((await f.signIn('late@example.com', code)).status, 403);
    assert.equal((await f.db.query('SELECT id FROM "user"')).length, 0);
    assert.equal((await f.db.query('SELECT id FROM session')).length, 0);
    assert.equal((await f.db.query('SELECT id FROM invitations WHERE consumed_by IS NOT NULL')).length, 0);
  } finally { await f.close(); }
});

test('profile update cannot change role or another user; OTP transport rejects cross-site mutations', async () => {
  const f = await fixture({ INVITE_ONLY: 'false' });
  try {
    const crossSite = await f.call('/email-otp/send-verification-otp', { email: 'cross-site@example.com', type: 'sign-in' }, { 'sec-fetch-site': 'cross-site' });
    assert.equal(crossSite.status, 403);
    assert.equal(f.messages.length, 0);
    await f.send('owner@example.com'); const login = await f.signIn('owner@example.com');
    const owner = (await login.json() as { user: { id: string } }).user;
    await f.send('other@example.com'); const otherLogin = await f.signIn('other@example.com');
    const other = (await otherLogin.json() as { user: { id: string } }).user;
    const changed = await f.call('/update-user', { name: 'Updated owner', role: 'admin', id: other.id, emailVerified: false }, { cookie: cookie(login) });
    assert.equal(changed.status, 400, await changed.text());
    const allowed = await f.call('/update-user', { name: 'Updated owner', id: other.id, emailVerified: false }, { cookie: cookie(login) });
    assert.equal(allowed.status, 200, await allowed.text());
    const users = await f.db.query<{ id: string; name: string; role: string; email_verified: number }>('SELECT id,name,role,email_verified FROM "user"');
    assert.equal(users.find(u => u.id === owner.id)?.name, 'Updated owner');
    assert.equal(users.find(u => u.id === other.id)?.name, '');
    assert.ok(users.every(u => u.role === 'user' && u.email_verified === 1));
  } finally { await f.close(); }
});

test('failed policy initialization closes verified transport instead of leaking its resources', async () => {
  const f = await fixture();
  try {
    let closes = 0;
    const failedDb = { driver: f.db.driver, async execute() { throw new Error('fixture policy failure'); } } as unknown as typeof f.db;
    await assert.rejects(createAuth(f.config, failedDb, createNodeSqliteAuthDrizzle(f.raw), { testEmailTransport: { async verify() {}, async send() {}, close() { closes++; } } }), /fixture policy failure/);
    assert.equal(closes, 1);
  } finally { await f.close(); }
});

test('raw SQL cannot bypass user limit, failed INSERT rolls back invite consumption, and existing login works at cap', async () => {
  const f = await fixture({ MAX_USERS: '2' });
  try {
    await f.invite('first@example.com');
    await f.send('first@example.com');
    const signed = await f.signIn('first@example.com');
    assert.equal(signed.status, 200);
    const first = (await signed.json() as { user: { id: string } }).user;
    await f.invite('second@example.com');
    // The guard accepts this registration, then the primary-key constraint fails.
    // Its invitation must remain available for a later successful insertion.
    await assert.rejects(f.db.execute('INSERT INTO "user"(id,name,email,email_verified,role) VALUES(?,?,?,?,?)', [first.id, 'duplicate id', 'second@example.com', 1, 'user']), /UNIQUE/);
    assert.equal((await f.db.query<{ consumed_by: string | null }>('SELECT consumed_by FROM invitations WHERE email=?', ['second@example.com']))[0]?.consumed_by, null);
    await f.db.execute('INSERT INTO "user"(id,name,email,email_verified,role) VALUES(?,?,?,?,?)', ['second', 'second', 'second@example.com', 1, 'user']);
    await f.invite('over-cap@example.com');
    await assert.rejects(f.db.execute('INSERT INTO "user"(id,name,email,email_verified,role) VALUES(?,?,?,?,?)', ['third', 'third', 'over-cap@example.com', 1, 'user']), /AUTH_USER_LIMIT/);
    assert.equal((await f.db.query('SELECT id FROM "user"')).length, 2);
    assert.equal((await f.db.query('SELECT id FROM invitations WHERE consumed_by IS NOT NULL')).length, 2);
    await f.db.execute('DELETE FROM rate_limit');
    assert.equal((await f.send('first@example.com')).status, 200);
    assert.equal((await f.signIn('first@example.com')).status, 200);
    assert.equal((await f.db.query('SELECT id FROM "user"')).length, 2);
  } finally { await f.close(); }
});

test('sandbox recipient rejection after logout never disables other login attempts or changes account status',async()=>{
 const f=await fixture({EMAIL_PROVIDER:'resend',EMAIL_FROM:'onboarding@resend.dev',RESEND_API_KEY:'test-private-key',EMAIL_TEST_RECIPIENT:'owner@example.com'});try{
  await f.invite('owner@example.com');await f.invite('other@example.com');
  assert.equal((await f.send('owner@example.com')).status,200);const signed=await f.signIn('owner@example.com');assert.equal(signed.status,200);
  assert.equal((await f.call('/sign-out',{},{cookie:cookie(signed)})).status,200);
  const denied=await f.send('other@example.com');assert.equal(denied.status,403);assert.equal((await denied.json() as any).code,'EMAIL_RECIPIENT_RESTRICTED');
  assert.equal(f.service.emailHealth().state,'healthy');assert.equal(f.service.capabilities().emailOtp,true);assert.equal(f.messages.length,1);
  await f.db.execute('DELETE FROM rate_limit');assert.equal((await f.send('owner@example.com')).status,200);assert.equal(f.messages.length,2);
  assert.equal((await f.signIn('owner@example.com')).status,200);assert.equal((await f.db.query('SELECT user_id FROM user_settings WHERE disabled=1')).length,0);
 }finally{await f.close();}
});
test('provider failure remains observable while configured login can recover on a later successful request',async()=>{
 const f=await fixture({INVITE_ONLY:'false'});let fail=true;
 const service=await createAuth(f.config,f.db,createNodeSqliteAuthDrizzle(f.raw),{testEmailTransport:{async verify(){},async send(){if(fail)throw new Error('offline');}}});
 try{
  assert.equal((await service.handler(f.request('/email-otp/send-verification-otp',{email:'first@example.com',type:'sign-in'}))).status,503);
  assert.equal(service.emailHealth().state,'unhealthy');assert.equal(service.capabilities().emailOtp,true);
  fail=false;assert.equal((await service.handler(f.request('/email-otp/send-verification-otp',{email:'second@example.com',type:'sign-in'}))).status,200);
  assert.equal(service.emailHealth().state,'healthy');assert.equal(service.capabilities().emailOtp,true);
 }finally{service.close();await f.close();}
});
