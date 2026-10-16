import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { createNodeSqliteAuthDrizzle } from '../src/auth/drizzle.node-sqlite.js';
import { loadConfig } from '../src/config.js';
import { createAuth, DisabledAccountError } from '../src/auth/index.js';
import type { OpenAlertAuth } from '../src/auth/index.js';
import { migrateAuth } from '../src/auth/migrations.js';
import { SQLiteDatabase } from '../src/db/sqlite.js';
import type { SQLiteConnection } from '../src/db/sqlite.js';
import { migrateApp } from '../src/db/migrations.js';
import type { EmailMessage } from '../src/auth/email.js';

type Profile = { sub: string; email: string; email_verified?: unknown; name?: string; role?: string };
type User = { id: string; email: string; emailVerified: boolean; role: string };
type Session = { user: User; session: { id: string; userId: string } };
type Flow = { state: string; cookie: string; url: URL };
const cookies = (response: Response) => response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
const hasSessionCookie = (response: Response) => response.headers.getSetCookie().some(value => /(?:^|\.)session_token=[^;]/.test(value));

async function fixture(overrides: Record<string, string> = {}) {
  let service: OpenAlertAuth;
  // Real local HTTP boundary, including separate Set-Cookie headers and redirect handling.
  const server = createServer(async (incoming, outgoing) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      const headers = new Headers();
      for (const [key, value] of Object.entries(incoming.headers)) {
        if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join('; ') : value);
      }
      const body = Buffer.concat(chunks).toString();
      const response = await service.handler(new Request(origin + incoming.url, {
        method: incoming.method ?? 'GET', headers, ...(body ? { body } : {}),
      }));
      outgoing.statusCode = response.status;
      response.headers.forEach((value, key) => { if (key !== 'set-cookie') outgoing.setHeader(key, value); });
      if (response.headers.getSetCookie().length) outgoing.setHeader('set-cookie', response.headers.getSetCookie());
      outgoing.end(await response.text());
    } catch { outgoing.writeHead(500); outgoing.end('Local test server failed'); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const config = loadConfig({ NODE_ENV: 'test', APP_URL: origin, AUTH_SECRET: 'google-http-test-secret-at-least-thirty-two-characters',
    ENCRYPTION_KEY: '11'.repeat(32), EMAIL_PROVIDER: 'console', GOOGLE_CLIENT_ID: 'fixture.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'fixture-secret', ...overrides });
  const raw = new DatabaseSync(':memory:');
  const db = new SQLiteDatabase(raw as unknown as SQLiteConnection, 'node:sqlite');
  await migrateAuth(db, 'tables'); await migrateApp(db); await migrateAuth(db, 'guards');
  const messages: EmailMessage[] = [];
  service = await createAuth(config, db, createNodeSqliteAuthDrizzle(raw), { testEmailTransport: { async verify() {}, async send(message) { messages.push(message); } } });
  const originalFetch = globalThis.fetch;
  const grants = new Map<string, { profile: Profile; flow: Flow }>();
  let tokenRequests = 0;
  const unexpectedRequests: string[] = [];
  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin === origin) return originalFetch(input, init);
    if (url.href === 'https://oauth2.googleapis.com/token') {
      tokenRequests++;
      assert.equal(request.method, 'POST');
      const body = new URLSearchParams(await request.text());
      const grant = grants.get(body.get('code') ?? '');
      assert.ok(grant, 'Only this test-issued authorization code may be exchanged');
      assert.equal(body.get('grant_type'), 'authorization_code');
      assert.equal(body.get('client_id'), config.google!.clientId);
      assert.equal(body.get('client_secret'), config.google!.clientSecret);
      assert.equal(body.get('redirect_uri'), origin + '/api/auth/callback/google');
      const verifier = body.get('code_verifier');
      assert.ok(verifier);
      assert.equal(createHash('sha256').update(verifier).digest('base64url'), grant.flow.url.searchParams.get('code_challenge'));
      // Better Auth 1.7.7's default Google provider decodes user info from id_token;
      // it does not call a userinfo endpoint. Stub only the transport, not the provider,
      // mapper, adapter, state checks, HTTP callbacks, cookie issuance or sessions.
      const claims = { iss: 'https://accounts.google.com', aud: config.google!.clientId, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600, name: 'Google fixture', ...grant.profile };
      const idToken = [Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url'), Buffer.from(JSON.stringify(claims)).toString('base64url'), 'fixture-signature'].join('.');
      return Response.json({ access_token: 'fixture-private-access-token', refresh_token: 'fixture-private-refresh-token', token_type: 'Bearer', expires_in: 3600, scope: 'openid email profile', id_token: idToken });
    }
    unexpectedRequests.push(url.origin + url.pathname);
    throw new Error('Unexpected outbound HTTP is prohibited');
  }) as typeof fetch;
  const call = (path: string, body?: object, cookie = '') => fetch(origin + '/api/auth' + path, {
    method: body ? 'POST' : 'GET', redirect: 'manual', headers: { origin, 'content-type': 'application/json', 'x-open-alert-client-ip': '192.0.2.10', ...(cookie ? { cookie } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const invite = (email: string, expiry = Date.now() + 60_000) => db.execute('INSERT INTO invitations(id,email,expires_at) VALUES(?,?,?)', [crypto.randomUUID(), email, expiry]);
  const otpUser = async (email: string, role = 'user') => {
    await invite(email);
    const send = await call('/email-otp/send-verification-otp', { email, type: 'sign-in' });
    assert.equal(send.status, 200, await send.clone().text());
    const otp = messages.at(-1)!.text.match(/code is (\d{6})/)![1]!;
    const login = await call('/sign-in/email-otp', { email, otp });
    assert.equal(login.status, 200, await login.clone().text());
    const user = (await login.json() as { user: User }).user;
    if (role !== 'user') await db.execute('UPDATE "user" SET role=? WHERE id=?', [role, user.id]);
    const logout = await call('/sign-out', {}, cookies(login));
    assert.equal(logout.status, 200);
    assert.equal((await db.query('SELECT id FROM session')).length, 0);
    return { ...user, role };
  };
  const begin = async (path = '/sign-in/social', cookie = ''): Promise<Flow> => {
    const start = await call(path, { provider: 'google', callbackURL: origin + '/account', errorCallbackURL: origin + '/login', role: 'admin' }, cookie);
    assert.equal(start.status, 200, await start.clone().text());
    const url = new URL((await start.json() as { url: string }).url);
    assert.equal(url.origin, 'https://accounts.google.com');
    assert.equal(url.searchParams.get('prompt'), 'select_account');
    assert.equal(url.searchParams.get('redirect_uri'), origin + '/api/auth/callback/google');
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.ok(url.searchParams.get('state'));
    assert.match(cookies(start), /better-auth\.(?:oauth_)?state=/);
    assert.equal(hasSessionCookie(start), false);
    return { state: url.searchParams.get('state')!, cookie: cookies(start), url };
  };
  const callback = async (flow: Flow, profile: Profile, cookie = flow.cookie, state = flow.state) => {
    const code = crypto.randomUUID();
    grants.set(code, { flow, profile });
    return call('/callback/google?' + new URLSearchParams({ code, state }), undefined, cookie);
  };
  const google = async (profile: Profile) => callback(await begin(), profile);
  const session = async (response: Response): Promise<Session> => {
    assert.equal(response.status, 302, await response.clone().text());
    assert.equal(response.headers.get('location'), origin + '/account');
    assert.ok(hasSessionCookie(response));
    const cookie = cookies(response);
    const result = await call('/get-session', undefined, cookie);
    assert.equal(result.status, 200, await result.clone().text());
    const body = await result.json() as Session;
    assert.ok(body?.session?.id);
    assert.equal(body.session.userId, body.user.id);
    const principal = await service.getPrincipal(new Request(origin + '/api/auth/get-session', { headers: { cookie } }));
    assert.equal(principal?.userId, body.user.id);
    assert.equal(principal?.role, body.user.role);
    const stored = await db.query<{ id: string; user_id: string }>('SELECT id,user_id FROM session WHERE id=?', [body.session.id]);
    assert.equal(stored[0]?.user_id, body.user.id);
    return body;
  };
  const denied = async (response: Response, error: string, status = 302) => {
    assert.equal(response.status, status, await response.clone().text());
    assert.equal(hasSessionCookie(response), false);
    if (status === 302) {
      const target = new URL(response.headers.get('location')!);
      assert.equal(target.origin, origin);
      assert.equal(target.searchParams.get('error'), error);
    } else assert.equal((await response.clone().json() as { code: string }).code, error);
    const exposed = (await response.clone().text()) + response.headers.get('location');
    for (const secret of ['fixture-private-access-token', 'fixture-private-refresh-token', 'fixture-secret', 'private-profile@example.com']) assert.equal(exposed.includes(secret), false);
    const sessionResponse = await call('/get-session', undefined, cookies(response));
    assert.equal(sessionResponse.status, 200);
    assert.equal(await sessionResponse.json(), null);
    assert.equal(await service.getPrincipal(new Request(origin + '/api/auth/get-session', { headers: { cookie: cookies(response) } })), null);
  };
  const disable = (id: string) => db.execute('INSERT INTO user_settings(user_id,enabled,disabled,generation,daily_limit,notification_json,created_at,updated_at) VALUES(?,0,1,0,20,?,?,?) ON CONFLICT(user_id) DO UPDATE SET disabled=1', [id, '{}', Date.now(), Date.now()]);
  return { db, service, origin, call, invite, otpUser, begin, callback, google, session, denied, disable, tokenRequests: () => tokenRequests, close: async () => {
    globalThis.fetch = originalFetch;
    service.close(); await db.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    assert.deepEqual(unexpectedRequests, []);
  } };
}

test('Google HTTP callback implicitly links OTP user at cap with consumed expired invite, retaining original id and user/admin role', async t => {
  for (const role of ['user', 'admin']) await t.test(role, async () => {
    const f = await fixture({ MAX_USERS: '1' });
    try {
      const original = await f.otpUser('owner@example.com', role);
      await f.db.execute('UPDATE invitations SET expires_at=?', [Date.now() - 1]);
      assert.equal((await f.db.query('SELECT id FROM invitations WHERE consumed_by IS NULL')).length, 0);
      assert.equal(f.service.auth.options.account?.accountLinking?.disableImplicitLinking, false);
      assert.deepEqual(f.service.auth.options.account?.accountLinking?.trustedProviders, ['google']);
      assert.equal(f.service.auth.options.account?.accountLinking?.requireLocalEmailVerified, true);
      assert.equal(f.service.auth.options.account?.accountLinking?.allowDifferentEmails, false);
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await f.google({ sub: 'google-owner', email: '  OWNER@Example.COM  ', email_verified: true, role: role === 'admin' ? 'user' : 'admin' });
        const result = await f.session(response);
        assert.equal(result.user.id, original.id); assert.equal(result.user.role, role);
        assert.equal(result.user.email, original.email); assert.equal(result.user.emailVerified, true);
      }
      assert.equal((await f.db.query('SELECT id FROM "user"')).length, 1);
      const accounts = await f.db.query<{ user_id: string; account_id: string; provider_id: string }>('SELECT user_id,account_id,provider_id FROM account');
      assert.deepEqual(accounts.map(row => ({ ...row })), [{ user_id: original.id, account_id: 'google-owner', provider_id: 'google' }]);
      assert.equal((await f.db.query<{ consumed_by: string }>('SELECT consumed_by FROM invitations'))[0]?.consumed_by, original.id);
      assert.equal(f.tokenRequests(), 2);
    } finally { await f.close(); }
  });
});

test('Google HTTP registration consumes only its matching valid invite and cannot accept provider/admin input', async () => {
  const f = await fixture();
  try {
    await f.invite('new@example.com'); await f.invite('unrelated@example.com');
    const result = await f.session(await f.google({ sub: 'google-new', email: 'NEW@Example.COM', email_verified: true, role: 'admin' }));
    assert.equal(result.user.role, 'user'); assert.equal(result.user.email, 'new@example.com');
    assert.equal((await f.db.query('SELECT id FROM "user"')).length, 1);
    assert.equal((await f.db.query<{ user_id: string }>('SELECT user_id FROM account'))[0]?.user_id, result.user.id);
    assert.equal((await f.db.query<{ consumed_by: string }>('SELECT consumed_by FROM invitations WHERE email=?', ['new@example.com']))[0]?.consumed_by, result.user.id);
    assert.equal((await f.db.query<{ consumed_by: string | null }>('SELECT consumed_by FROM invitations WHERE email=?', ['unrelated@example.com']))[0]?.consumed_by, null);
  } finally { await f.close(); }
});

test('Google new user without valid matching invitation cannot register, link or get a session', async t => {
  for (const kind of ['missing', 'expired', 'revoked', 'different-email']) await t.test(kind, async () => {
    const f = await fixture();
    try {
      if (kind === 'expired') await f.invite('new@example.com', Date.now() - 1);
      if (kind === 'revoked') await f.invite('new@example.com', 0);
      if (kind === 'different-email') await f.invite('other@example.com');
      await f.denied(await f.google({ sub: 'google-new', email: 'new@example.com', email_verified: true }), 'INVITATION_REQUIRED');
      for (const table of ['"user"', 'account', 'session']) assert.equal((await f.db.query(`SELECT id FROM ${table}`)).length, 0);
      assert.equal((await f.db.query('SELECT id FROM invitations WHERE consumed_by IS NOT NULL')).length, 0);
    } finally { await f.close(); }
  });
});

test('Google profile must contain literal email_verified=true even for trusted Google, existing linked user and explicit linking', async t => {
  for (const mode of ['new', 'implicit', 'linked', 'explicit']) for (const claim of [false, undefined, 'true']) await t.test(`${mode}: ${String(claim)}`, async () => {
    const f = await fixture();
    try {
      let cookie = '';
      if (mode === 'new') await f.invite('private-profile@example.com');
      else {
        const user = await f.otpUser('private-profile@example.com', 'admin');
        if (mode === 'linked' || mode === 'explicit') {
          const login = await f.google({ sub: 'google-existing', email: user.email, email_verified: true });
          await f.session(login);
          if (mode === 'explicit') cookie = cookies(login);
          else assert.equal((await f.call('/sign-out', {}, cookies(login))).status, 200);
        }
      }
      const beforeAccounts = await f.db.query('SELECT id,user_id FROM account');
      const beforeUsers = await f.db.query('SELECT id,role,email_verified FROM "user"');
      const beforeSessions = await f.db.query('SELECT id FROM session');
      const flow = await f.begin(mode === 'explicit' ? '/link-social' : '/sign-in/social', cookie);
      const response = await f.callback(flow, { sub: mode === 'linked' ? 'google-existing' : 'google-unverified', email: 'private-profile@example.com', ...(claim === undefined ? {} : { email_verified: claim }) }, [flow.cookie, cookie].filter(Boolean).join('; '));
      // Mapper APIError occurs outside callbackOAuth's redirect catch in 1.7.7.
      await f.denied(response, 'VERIFIED_EMAIL_REQUIRED', 403);
      assert.deepEqual(await f.db.query('SELECT id,user_id FROM account'), beforeAccounts);
      assert.deepEqual(await f.db.query('SELECT id,role,email_verified FROM "user"'), beforeUsers);
      assert.deepEqual(await f.db.query('SELECT id FROM session'), beforeSessions);
      assert.equal((await f.db.query('SELECT id FROM invitations WHERE email=? AND consumed_by IS NOT NULL', ['private-profile@example.com'])).length, mode === 'new' ? 0 : 1);
    } finally { await f.close(); }
  });
});

test('Google cannot implicitly link to an unverified local email or re-verify a previously linked unverified user', async t => {
  for (const linked of [false, true]) await t.test(`linked=${linked}`, async () => {
    const f = await fixture();
    try {
      const original = await f.otpUser('local@example.com', 'admin');
      if (linked) {
        const login = await f.google({ sub: 'google-local', email: original.email, email_verified: true });
        await f.session(login); await f.call('/sign-out', {}, cookies(login));
      }
      await f.db.execute('UPDATE "user" SET email_verified=0 WHERE id=?', [original.id]);
      const before = await f.db.query('SELECT id,user_id FROM account');
      await f.denied(await f.google({ sub: 'google-local', email: original.email, email_verified: true }), linked ? 'VERIFIED_EMAIL_REQUIRED' : 'account_not_linked');
      assert.deepEqual(await f.db.query('SELECT id,user_id FROM account'), before);
      assert.deepEqual((await f.db.query('SELECT id,role,email_verified FROM "user"')).map(row => ({ ...row })), [{ id: original.id, role: 'admin', email_verified: 0 }]);
      assert.equal((await f.db.query('SELECT id FROM session')).length, 0);
    } finally { await f.close(); }
  });
});

test('Google bound to one user cannot sign in with another local email or move via link-social', async () => {
  const f = await fixture();
  try {
    const owner = await f.otpUser('owner@example.com', 'admin');
    const other = await f.otpUser('other@example.com');
    const first = await f.google({ sub: 'google-owner', email: owner.email, email_verified: true });
    await f.session(first); await f.call('/sign-out', {}, cookies(first));
    const before = await f.db.query('SELECT id,user_id,account_id FROM account');
    await f.denied(await f.google({ sub: 'google-owner', email: other.email, email_verified: true }), 'email_does_not_match');
    const otherLogin = await f.google({ sub: 'google-other', email: other.email, email_verified: true });
    await f.session(otherLogin);
    const cookie = cookies(otherLogin);
    const flow = await f.begin('/link-social', cookie);
    await f.denied(await f.callback(flow, { sub: 'google-owner', email: other.email, email_verified: true }, flow.cookie + '; ' + cookie), 'account_already_linked_to_different_user');
    assert.deepEqual(await f.db.query('SELECT id,user_id,account_id FROM account WHERE account_id=?', ['google-owner']), before);
    assert.deepEqual((await f.db.query('SELECT id,role FROM "user" ORDER BY email')).map(row => ({ ...row })), [{ id: other.id, role: 'user' }, { id: owner.id, role: 'admin' }]);
    assert.equal((await f.db.query('SELECT id FROM session')).length, 1);
  } finally { await f.close(); }
});

test('explicit link-social rejects a different Google email and requires a verified enabled local session', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.call('/link-social', { provider: 'google', callbackURL: f.origin })).status, 403);
    const user = await f.otpUser('local@example.com', 'admin');
    const login = await f.google({ sub: 'google-local', email: user.email, email_verified: true });
    await f.session(login);
    const cookie = cookies(login);
    const before = await f.db.query('SELECT id,user_id FROM account');
    const flow = await f.begin('/link-social', cookie);
    await f.denied(await f.callback(flow, { sub: 'google-different', email: 'different@example.com', email_verified: true }, flow.cookie + '; ' + cookie), 'email_does_not_match');
    assert.deepEqual(await f.db.query('SELECT id,user_id FROM account'), before);
    await f.db.execute('UPDATE "user" SET email_verified=0 WHERE id=?', [user.id]);
    assert.equal((await f.call('/link-social', { provider: 'google', callbackURL: f.origin }, cookie)).status, 403);
    await f.db.execute('UPDATE "user" SET email_verified=1 WHERE id=?', [user.id]);
    await f.disable(user.id);
    assert.equal((await f.call('/link-social', { provider: 'google', callbackURL: f.origin }, cookie)).status, 403);
    await assert.rejects(f.service.getPrincipal(new Request(f.origin + '/api/auth/get-session', { headers: { cookie } })), DisabledAccountError);
  } finally { await f.close(); }
});

test('disabled OTP or linked Google account denies fresh login without changing role, creating a duplicate or adding a binding/session', async t => {
  for (const linked of [false, true]) await t.test(`linked=${linked}`, async () => {
    const f = await fixture();
    try {
      const user = await f.otpUser('disabled@example.com', 'admin');
      if (linked) {
        const login = await f.google({ sub: 'google-disabled', email: user.email, email_verified: true });
        await f.session(login); await f.call('/sign-out', {}, cookies(login));
      }
      await f.disable(user.id);
      const before = await f.db.query('SELECT id,user_id FROM account');
      await f.denied(await f.google({ sub: 'google-disabled', email: user.email, email_verified: true }), 'ACCOUNT_DISABLED');
      assert.deepEqual(await f.db.query('SELECT id,user_id FROM account'), before);
      assert.deepEqual((await f.db.query('SELECT id,role FROM "user"')).map(row => ({ ...row })), [{ id: user.id, role: 'admin' }]);
      assert.equal((await f.db.query('SELECT id FROM session')).length, 0);
    } finally { await f.close(); }
  });
});

test('disable during callback is guarded both before account insertion and before session creation', async t => {
  for (const phase of ['before-account', 'after-account']) await t.test(phase, async () => {
    const f = await fixture();
    try {
      const user = await f.otpUser('race@example.com', 'admin');
      if (phase === 'before-account') {
        const validate = f.service.auth.options.user!.validateUserInfo!;
        f.service.auth.options.user!.validateUserInfo = async (data, ctx) => {
          const result = await validate(data, ctx);
          if (data.source.action === 'link-account') await f.disable(user.id);
          return result;
        };
      } else {
        f.service.auth.options.databaseHooks!.account!.create!.after = async () => { await f.disable(user.id); };
      }
      await f.denied(await f.google({ sub: 'google-race', email: user.email, email_verified: true }), 'ACCOUNT_DISABLED');
      assert.equal((await f.db.query('SELECT id FROM account')).length, phase === 'after-account' ? 1 : 0);
      // A disable after the account write may leave that binding, but never a session/access.
      assert.equal((await f.db.query('SELECT id FROM session')).length, 0);
      assert.deepEqual((await f.db.query('SELECT id,role FROM "user"')).map(row => ({ ...row })), [{ id: user.id, role: 'admin' }]);
    } finally { await f.close(); }
  });
});

test('Google new invited user still obeys MAX_USERS without consuming invite or creating account/session', async () => {
  const f = await fixture({ MAX_USERS: '1' });
  try {
    await f.otpUser('existing@example.com', 'admin');
    await f.invite('new@example.com');
    await f.denied(await f.google({ sub: 'google-over-cap', email: 'new@example.com', email_verified: true }), 'USER_LIMIT_REACHED');
    assert.equal((await f.db.query('SELECT id FROM "user"')).length, 1);
    assert.equal((await f.db.query('SELECT id FROM account')).length, 0);
    assert.equal((await f.db.query('SELECT id FROM session')).length, 0);
    assert.equal((await f.db.query<{ consumed_by: string | null }>('SELECT consumed_by FROM invitations WHERE email=?', ['new@example.com']))[0]?.consumed_by, null);
  } finally { await f.close(); }
});

test('link-social state issued before disable cannot add a Google binding even without sending the old session cookie', async () => {
  const f = await fixture();
  try {
    const user = await f.otpUser('disabled-link@example.com', 'admin');
    const login = await f.google({ sub: 'google-first', email: user.email, email_verified: true });
    await f.session(login);
    const flow = await f.begin('/link-social', cookies(login));
    await f.disable(user.id);
    const before = await f.db.query('SELECT id,user_id FROM account');
    await f.denied(await f.callback(flow, { sub: 'google-new-link', email: user.email, email_verified: true }), 'ACCOUNT_DISABLED');
    assert.deepEqual(await f.db.query('SELECT id,user_id FROM account'), before);
    assert.equal((await f.db.query('SELECT id FROM session')).length, 1);
    assert.equal((await f.call('/get-session', undefined, cookies(login))).status, 403);
    await assert.rejects(f.service.getPrincipal(new Request(f.origin + '/api/auth/get-session', { headers: { cookie: cookies(login) } })), DisabledAccountError);
  } finally { await f.close(); }
});

test('Google state cookie binding and replay are enforced before token exchange', async () => {
  const f = await fixture();
  try {
    const user = await f.otpUser('state@example.com');
    const profile = { sub: 'google-state', email: user.email, email_verified: true };
    const flow = await f.begin();
    await f.denied(await f.callback(flow, profile, ''), 'state_mismatch');
    assert.equal(f.tokenRequests(), 0);
    await f.denied(await f.callback(flow, profile, flow.cookie, 'tampered-state'), 'state_mismatch');
    assert.equal(f.tokenRequests(), 0);
    await f.session(await f.callback(flow, profile));
    assert.equal(f.tokenRequests(), 1);
    await f.denied(await f.callback(flow, profile), 'state_mismatch');
    assert.equal(f.tokenRequests(), 1);
    assert.equal((await f.db.query('SELECT id FROM account')).length, 1);
    assert.equal((await f.db.query('SELECT id FROM session')).length, 1);
  } finally { await f.close(); }
});
