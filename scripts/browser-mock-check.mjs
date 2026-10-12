#!/usr/bin/env node
/**
 * MOCK frontend integration against the actual production Vite build.
 * Run from anywhere: node /path/to/open-alert/scripts/browser-mock-check.mjs
 * Uses local optional playwright or PLAYWRIGHT_MODULE; supports the legacy sibling cache.
 * No package changes, credentials, external network, email, notification or deployment.
 * Chromium desktop and iPhone 15 viewport/touch emulation; not actual iOS Safari.
 * Native Better Auth responses + HttpOnly cookie fixture; app envelopes use typed DTOs.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile, readdir, access } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { homedir } from 'node:os';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputs = process.env.OPEN_ALERT_BROWSER_OUTPUT_DIR ? resolve(process.env.OPEN_ALERT_BROWSER_OUTPUT_DIR) : resolve(root, '..');
// Native loader has no persistent esbuild subprocess to leak after node:test/imports.
process.env.OPEN_ALERT_LOCAL_TEST = '1';
await import('./local-test-types.mjs');
const F = await import(pathToFileURL(join(root, 'test/browser-fixtures.ts')).href);
let playwrightPath = process.env.PLAYWRIGHT_MODULE || join(root,'node_modules/playwright/index.mjs');
if (!process.env.PLAYWRIGHT_MODULE) {
  try { await access(playwrightPath); }
  catch { playwrightPath = join(resolve(root,'..'),'okx-free-monitor/node_modules/playwright/index.mjs'); }
}
const { chromium, devices } = await import(pathToFileURL(playwrightPath).href);
const { expect } = await import(pathToFileURL(join(dirname(playwrightPath), 'test.mjs')).href);
expect.configure({ timeout: 6000 });
const results = [], violations = [], runtimeErrors = [], externalAttempts = [];
let assertions = 0, apiRequests = 0, authRequests = 0, chartScripts = 0;
const check = async (name, fn) => { assertions++; await fn(); };
const journey = async (name, fn) => { const start = Date.now(); try { await fn(); results.push({ name, passed: true, durationMs: Date.now() - start }); console.log(`PASS ${name}`); } catch (error) { results.push({ name, passed: false, error: error.stack }); throw error; } };
const assets = new Map([['/', ['index.html', 'text/html']], ['/index.html', ['index.html', 'text/html']], ...['login','dashboard','notifications','account','admin'].map(p => [`/${p}`, ['index.html','text/html']])]);
for (const name of await readdir(join(root, 'dist/web/assets'))) assets.set(`/assets/${name}`, [`assets/${name}`, name.endsWith('.css') ? 'text/css' : 'application/javascript']);
const server = createServer(async (req, res) => {
  try { const item = assets.get(new URL(req.url, 'http://localhost').pathname); if (!item) { res.writeHead(404); return res.end('Not found'); } const body = await readFile(join(root, 'dist/web', item[0])); res.writeHead(200, { 'Content-Type': item[1], 'Cache-Control': 'no-store' }); res.end(body); }
  catch { res.writeHead(500); res.end('Asset error'); }
});
await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
const origin = `http://127.0.0.1:${server.address().port}`;
const label = 'MOCK / 模拟数据 · 无真实行情、邮件或通知';
const cookieName = 'better-auth.session_token';
const cookieValue = 'mock-cookie-session.not-a-real-signature';
const key = 'MOCKKEY'.padEnd(30, '1');
const token = 'MOCKTOKEN'.padEnd(30, '2');
assert.equal(key.length, 30); assert.equal(token.length, 30);
function nativeSession(state) {
  const user = { ...state.status.user, emailVerified: true, image: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  return { user, session: { id: 'mock-session', userId: user.id, token: 'mock-native-token', expiresAt: new Date(Date.now()+86400000).toISOString(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ipAddress: '127.0.0.1', userAgent: 'MOCK' } };
}
async function setup(browser, profile, authenticated = false) {
  const state = { ...F.makeBrowserFixture(), requests: [], failNext: null, stale: false, chartFail: false, nextId: 1, holdStatus: null, holdSettings: null, googleEnabled: false, socialError: null };
  const options = profile === 'mobile' ? { ...devices['iPhone 15'], viewport: { width: 390, height: 844 }, defaultBrowserType: undefined } : { viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 };
  const context = await browser.newContext({ ...options, serviceWorkers: 'block' });
  if (authenticated) await context.addCookies([{ name: cookieName, value: cookieValue, url: origin, httpOnly: true, sameSite: 'Lax' }]);
  await context.addInitScript(mark => {
    const attach = () => { if (!document.body) return; if (document.getElementById('mock-label')) return; const banner = document.createElement('div'); banner.id = 'mock-label'; banner.textContent = mark; banner.setAttribute('style', 'position:fixed;top:0;left:0;right:0;z-index:99999;text-align:center;background:#ffdd7a;color:#15222f;font:700 11px/22px sans-serif;pointer-events:none'); document.body.append(banner); };
    document.addEventListener('DOMContentLoaded', attach);
  }, label);
  const page = await context.newPage(); page.setDefaultTimeout(6000);
  page.on('pageerror', error => runtimeErrors.push(`${profile}: ${error.message}`));
  page.on('console', message => { if (message.type() === 'error' && !/Failed to load resource|ERR_FAILED/.test(message.text())) runtimeErrors.push(`${profile}: ${message.text()}`); });
  await context.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin !== origin) {
      if (url.href === 'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js') {
        chartScripts++;
        if (state.chartFail) return route.abort('failed');
        return route.fulfill({ contentType: 'application/javascript', body: `(()=>{const script=document.currentScript;const host=script.parentElement;const iframe=document.createElement('iframe');iframe.title='MOCK TradingView chart';iframe.style='width:100%;height:100%';iframe.srcdoc='<body style="margin:0;background:#12202d;color:#a6b7c7;font:14px sans-serif;display:grid;place-items:center;height:95vh"><div>MOCK 图表占位 · 无实时数据<br><small>仅验证嵌入生命周期与页面布局</small></div></body>';host.append(iframe);})();` });
      }
      externalAttempts.push({ profile, origin: url.origin, path: url.pathname }); return route.abort('blockedbyclient');
    }
    if (!url.pathname.startsWith('/api/')) return route.continue();
    apiRequests++;
    const method = req.method(), path = url.pathname;
    const body = req.postData() ? req.postDataJSON() : undefined;
    // Request evidence deliberately excludes raw OTP/key/token/bearer values.
    const evidence = { method, path, fields: body ? Object.keys(body) : [], expectedGeneration: body?.expectedGeneration, confirm: body?.confirm, appTokenMode: body && Object.hasOwn(body, 'appToken') ? body.appToken === null ? 'clear' : 'replace' : 'retain' };
    state.requests.push(evidence);
    const send = (data, status = 200, headers = {}) => route.fulfill({ status, headers, contentType: 'application/json', body: JSON.stringify(data) });
    const ok = (data, status = 200) => send({ ok: true, data, requestId: 'mock-request' }, status);
    const fail = (code, status = 409, headers = {}) => send({ ok: false, error: { code, message: `MOCK ${code}` }, requestId: 'mock-request' }, status, headers);
    try {
      const cookies = await context.cookies(origin);
      const loggedIn = !state.sessionInvalid && cookies.some(c => c.name === cookieName && c.value === cookieValue);
      if (path.startsWith('/api/auth/')) {
        authRequests++;
        if (path === '/api/auth/get-session' && method === 'GET') return send(loggedIn ? nativeSession(state) : null);
        if (path === '/api/auth/sign-in/social' && method === 'POST') {
          assert(state.googleEnabled);
          assert.deepEqual(body, { provider: 'google', callbackURL: `${origin}/dashboard`, errorCallbackURL: `${origin}/login` });
          // Local redirect exercises the SDK's real redirect plugin, without Google network.
          return state.socialError ? send(state.socialError, 403) : send({ url: `${origin}/login?error=access_denied`, redirect: true });
        }
        if (path === '/api/auth/email-otp/send-verification-otp' && method === 'POST') { assert.deepEqual(body, { email: 'mock@example.test', type: 'sign-in' }); return send({ success: true }); }
        if (path === '/api/auth/sign-in/email-otp' && method === 'POST') {
          assert.equal(body.email, 'mock@example.test');
          if (body.otp !== '123456') return send({ code: 'INVALID_OTP', message: 'Invalid OTP' }, 400);
          return send({ token: 'mock-native-token', user: nativeSession(state).user }, 200, { 'Set-Cookie': `${cookieName}=${cookieValue}; Path=/; HttpOnly; SameSite=Lax` });
        }
        if (path === '/api/auth/sign-out' && method === 'POST') return send({ success: true }, 200, { 'Set-Cookie': `${cookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0` });
        throw new Error(`Unexpected native auth route ${method} ${path}`);
      }
      if (path === '/api/auth-capabilities' && method === 'GET') return ok({ google: state.googleEnabled, emailOtp: true, registration: 'invite' });
      if (!loggedIn) return fail('unauthenticated', 401);
      if (state.failNext && state.failNext.path === path && state.failNext.method === method) {
        const error = state.failNext; state.failNext = null;
        if (error.wait) await error.wait;
        if (error.bump) state.status.settingsGeneration++;
        if (error.raw) return route.fulfill({status:error.status,headers:error.headers,contentType:'text/html',body:'<h1>MOCK rate limit</h1>'});
        return fail(error.code, error.status, error.headers);
      }
      if (path === '/api/status' && method === 'GET') {
        const snapshot = structuredClone(state.status), now = Date.now();
        snapshot.prices.forEach(p => { p.timestamp = now - (state.stale ? 60000 : 0); p.receivedAt = p.timestamp; });
        if (state.holdStatus) { const release = state.holdStatus; state.holdStatus = null; await release.wait; }
        return ok(snapshot);
      }
      if (path === '/api/markets' && method === 'GET') return ok({ markets: state.markets, updatedAt: Date.now(), stale: false });
      if (path === '/api/alerts' && method === 'GET') return ok({ alerts: state.alerts });
      if (path === '/api/alerts' && method === 'POST') {
        const input = F.createAlertSchema.parse(body); assert(state.markets.some(m => m.instrument === input.instrument));
        const alert = { ...input, id: `mock-created-${state.nextId++}`, generation: 0, triggered: false, triggerId: null, pending: null, last: null, status: input.enabled ? 'armed' : 'disabled', createdAt: Date.now(), updatedAt: Date.now() };
        state.alerts.push(alert); return ok({ alert }, 201);
      }
      const match = path.match(/^\/api\/alerts\/([^/]+)(\/rearm)?$/);
      if (match) {
        const alert = state.alerts.find(a => a.id === match[1]); if (!alert) return fail('not_found', 404);
        if (alert.pending) return fail('pending_delivery');
        if (body.expectedGeneration !== alert.generation) return fail('generation_conflict');
        if (method === 'PATCH') { const { expectedGeneration, ...patch } = F.patchAlertSchema.parse(body); Object.assign(alert, patch, { generation: expectedGeneration+1, updatedAt: Date.now() }); return ok({ alert }); }
        if (method === 'POST' && match[2]) { F.rearmAlertSchema.parse(body); Object.assign(alert, { generation: alert.generation+1, triggered: false, triggerId: null, status: 'armed' }); return ok({ alert }); }
        if (method === 'DELETE') { F.rearmAlertSchema.parse(body); state.alerts = state.alerts.filter(a => a !== alert); return ok({ deleted: true }); }
      }
      if (path === '/api/settings' && method === 'PATCH') {
        assert(Number.isInteger(body.expectedGeneration));
        if (body.expectedGeneration !== state.status.settingsGeneration) return fail('generation_conflict');
        if (state.holdSettings) { const release = state.holdSettings; state.holdSettings = null; await release.wait; }
        if (state.alerts.some(a => a.pending) && body.enabled !== false) return fail('pending_delivery');
        if (body.notification) F.notificationOptionsSchema.parse(body.notification);
        const { expectedGeneration, ...patch } = body; Object.assign(state.status.settings, patch); state.status.settingsGeneration++;
        state.status.daily.limit = state.status.settings.dailyLimit;
        return ok({ settings: state.status.settings, generation: state.status.settingsGeneration });
      }
      if (path === '/api/channels') {
        if (method === 'GET') return ok(state.status.channel);
        if (state.alerts.some(a => a.pending)) return fail('pending_delivery');
        if (method === 'PUT') {
          F.putChannelSchema.extend({ userKey: F.putChannelSchema.shape.userKey.optional() }).parse(body);
          if (!body.userKey && !state.status.channel.userKeyPresent) return fail('invalid_request', 400);
          const privateTokenPresent = body.appToken === undefined ? state.status.channel.privateTokenPresent : body.appToken !== null;
          state.status.channel = { provider: 'pushover', configured: true, userKeyPresent: true, privateTokenPresent, tokenSource: privateTokenPresent ? 'private' : 'shared', updatedAt: Date.now() }; return ok(state.status.channel);
        }
        if (method === 'DELETE') { state.status.channel = { provider: 'pushover', configured: false, userKeyPresent: false, privateTokenPresent: false, tokenSource: 'shared', updatedAt: null }; return ok(state.status.channel); }
      }
      if (path === '/api/test-notification' && method === 'POST') { F.testNotificationSchema.parse(body); state.status.daily.attempts++; return ok({ outcome: 'sent', at: Date.now() }); }
      if (path === '/api/admin/users' && method === 'GET') { assert.equal(url.searchParams.get('limit'), '50'); return ok({ items: [{ ...state.status.user, id: 'mock-member', email: 'member@example.test', role: 'user' }], cursor: url.searchParams.has('cursor') ? null : 'mock-page-2' }); }
      if (path === '/api/admin/status' && method === 'GET') return ok({ activeUsers: 2, activeAlerts: state.alerts.length, health: state.status.health });
      if (path === '/api/admin/invites' && method === 'POST') return ok({ id: 'mock-invite', email: body.email, expiresAt: Date.now()+86400000 }, 201);
      throw new Error(`Unexpected application route ${method} ${path}`);
    } catch (error) { violations.push(error.message); return fail('internal_error', 500); }
  });
  return { page, context, state };
}
const nav = (page, name) => page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name, exact: true }).click();
const row = (page, name) => page.locator('.alert-row').filter({ has: page.getByText(name, { exact: true }) });
const requests = (state, method, path) => state.requests.filter(r => r.method === method && r.path === path);
const businessRequests = state => state.requests.filter(r=>!r.path.startsWith('/api/auth/') && r.path!=='/api/auth-capabilities');
async function noOverflow(page) { await check('mobile horizontal overflow', async () => { const size = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: innerWidth })); assert(size.scroll <= size.width+1, JSON.stringify(size)); }); }
async function refreshNavigation(page) { await page.reload(); await expect(page.getByRole('switch', { name: '手机报警总开关' })).toBeVisible(); }
let browser, timedOut = false;
const deadline = setTimeout(() => { timedOut = true; process.exitCode = 1; console.error('MOCK 50 second deadline exceeded'); void browser?.close(); server.closeAllConnections(); server.close(); }, 50000);
try {
  const launchEnv = { ...process.env }, cachedLib = join(homedir(), '.cache/okx-browser-check/lib');
  try { await access(join(cachedLib, 'libXdamage.so.1')); launchEnv.LD_LIBRARY_PATH = [cachedLib, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':'); } catch {}
  browser = await chromium.launch({ headless: true, env: launchEnv });
  console.log(`MOCK integration — Chromium ${browser.version()} — actual dist/web`);
  const { page, context, state } = await setup(browser, 'desktop');
  await journey('01 native email OTP, unavailable Google, cookie persistence', async () => {
    await page.goto(origin+'/login');
    await check('Google unavailable', () => expect(page.getByRole('button', { name: '使用 Google 登录' })).toBeDisabled());
    await check('Google config guidance', () => expect(page.getByText('此部署尚未配置 Google 登录。')).toBeVisible());
    await page.getByLabel('邮箱地址').fill('MOCK@EXAMPLE.TEST'); await page.getByRole('button', { name: '发送登录验证码' }).click();
    await check('native OTP send', () => expect(page.getByLabel('邮件中的验证码')).toBeVisible());
    await check('resend cooldown', () => expect(page.getByRole('button', { name: /秒后重发/ })).toBeDisabled());
    await page.getByLabel('邮件中的验证码').fill('000000'); await page.getByRole('button', { name: '验证并登录' }).click();
    await check('native OTP rejection', () => expect(page.getByRole('alert')).toContainText('验证码不正确或已过期'));
    await page.getByLabel('邮件中的验证码').fill('123456'); await page.getByRole('button', { name: '验证并登录' }).click();
    await check('signed in dashboard', () => expect(page.getByRole('switch')).toHaveAttribute('aria-checked','false'));
    await check('HttpOnly fixture cookie', async () => assert((await context.cookies(origin)).some(c => c.name === cookieName && c.httpOnly)));
    await refreshNavigation(page);
    await check('reload session persists', () => expect(page.getByRole('button', { name: '退出登录' })).toBeVisible());
    await check('no browser token storage', async () => assert.deepEqual(await page.evaluate(() => [Object.keys(localStorage), Object.keys(sessionStorage)]), [[],[]]));
  });
  let chart;
  await journey('02 queued/sending locks, uncertainty and desktop MOCK capture', async () => {
    await expect(page.locator('iframe[title="MOCK TradingView chart"]')).toBeVisible(); chart = await page.locator('iframe').elementHandle();
    const pending = row(page,'MOCK 排队通知');
    await check('queued edit lock', () => expect(pending.getByRole('button', { name: '编辑', exact: true })).toBeDisabled());
    await check('queued rearm lock', () => expect(pending.getByRole('button', { name: '重新武装', exact: true })).toBeDisabled());
    await check('queued delete lock', () => expect(pending.getByRole('button', { name: '删除', exact: true })).toBeDisabled());
    await check('uncertain copy', () => expect(row(page,'MOCK 投递不确定')).toContainText('可能已经送达，请先查看手机'));
    await nav(page,'手机通知');
    await check('channel pending lock', () => expect(page.getByRole('button', { name: '保存通知渠道' })).toBeDisabled());
    await check('settings pending lock', () => expect(page.getByRole('button', { name: '保存提醒设置' })).toBeDisabled());
    await check('test pending lock', () => expect(page.getByRole('button', { name: '发送测试通知' })).toBeDisabled());
    await nav(page,'行情与警报');
    await check('page navigation preserves frame', async () => assert(await chart.evaluate(node => node === document.querySelector('.tradingview-widget-container iframe'))));
    await page.screenshot({ path: join(outputs,'open-alert-ui-desktop-MOCK.png'), fullPage: true });
    state.alerts.find(a => a.id === 'mock-pending').pending.phase = 'sending'; await refreshNavigation(page);
    await check('sending edit lock', () => expect(row(page,'MOCK 排队通知').getByRole('button',{name:'编辑',exact:true})).toBeDisabled());
    await check('sending rearm lock', () => expect(row(page,'MOCK 排队通知').getByRole('button',{name:'重新武装',exact:true})).toBeDisabled());
    await check('sending delete lock', () => expect(row(page,'MOCK 排队通知').getByRole('button',{name:'删除',exact:true})).toBeDisabled());
    state.alerts = state.alerts.filter(a => a.id !== 'mock-pending'); await refreshNavigation(page); chart = await page.locator('iframe').elementHandle();
  });
  await journey('03 alert CRUD, modal keyboard focus and generation guards', async () => {
    await page.getByRole('button', { name: '＋ 创建警报' }).click(); const dialog = page.getByRole('dialog');
    await check('modal focus inside', async () => assert(await dialog.evaluate(d => d.contains(document.activeElement) && d.matches(':modal'))));
    await check('no guessed threshold', () => expect(dialog.getByLabel('价格 · USDT')).toHaveValue(''));
    await dialog.getByLabel('警报名称').fill('<img src=x onerror=alert(1)> MOCK'); await dialog.getByLabel('价格 · USDT').fill('62000'); await dialog.getByRole('button', { name: '创建警报', exact:true }).click();
    await check('created row', () => expect(row(page,'<img src=x onerror=alert(1)> MOCK')).toBeVisible());
    await check('name escaped', () => expect(page.locator('.alert-name img')).toHaveCount(0));
    const created = row(page,'<img src=x onerror=alert(1)> MOCK'); await created.getByRole('button', { name:'编辑', exact:true }).click();
    await page.getByRole('dialog').getByLabel('警报名称').fill('MOCK 已编辑'); await page.getByRole('button', { name:'保存警报', exact:true }).click();
    await check('edit generation sent', async () => assert.equal(requests(state,'PATCH','/api/alerts/mock-created-1').at(-1).expectedGeneration,0));
    await row(page,'MOCK 已编辑').getByRole('button', {name:'删除',exact:true}).click(); await page.getByRole('dialog').getByRole('button',{name:'取消',exact:true}).click();
    await check('cancel delete no request', async () => assert.equal(requests(state,'DELETE','/api/alerts/mock-created-1').length,0));
    await row(page,'MOCK 已编辑').getByRole('button',{name:'删除',exact:true}).click(); await page.getByRole('dialog').getByRole('button',{name:'删除警报',exact:true}).click();
    await check('deleted row gone', () => expect(row(page,'MOCK 已编辑')).toHaveCount(0));
    await check('delete generation sent', async () => assert.equal(requests(state,'DELETE','/api/alerts/mock-created-1').at(-1).expectedGeneration,1));
  });
  await journey('04 latch retained on edit; explicit rearm warning and CAS', async () => {
    await row(page,'MOCK 投递不确定').getByRole('button',{name:'编辑',exact:true}).click(); await page.getByRole('dialog').getByLabel('价格 · USDT').fill('58000'); await page.getByRole('button',{name:'保存警报',exact:true}).click();
    await check('edit keeps latch', () => expect(row(page,'MOCK 投递不确定')).toContainText('已触发并锁定'));
    await row(page,'MOCK 投递不确定').getByRole('button',{name:'重新武装',exact:true}).click();
    await check('uncertain warning', () => expect(page.getByRole('dialog')).toContainText('上次投递结果不确定，可能已经送达'));
    await check('already breached warning', () => expect(page.getByRole('dialog')).toContainText('当前新鲜成交价已经满足条件'));
    await page.getByRole('dialog').getByRole('button',{name:'重新武装',exact:true}).click();
    await check('explicit rearm clears latch', () => expect(row(page,'MOCK 投递不确定')).toContainText('已武装'));
    await check('rearm generation sent', async () => assert.equal(requests(state,'POST','/api/alerts/mock-uncertain/rearm').at(-1).expectedGeneration,2));
    await check('CRUD preserves chart', async () => assert(await chart.evaluate(node => node.isConnected)));
  });
  await journey('05 channel retention, secret clearing and explicit test confirmation', async () => {
    await nav(page,'手机通知'); await page.getByRole('button',{name:'保存通知渠道'}).click();
    await expect(page.getByRole('status').filter({hasText:'通知渠道已保存'})).toBeVisible();
    await check('blank keys omitted', async () => assert.deepEqual(requests(state,'PUT','/api/channels').at(-1).fields,['provider']));
    await check('save sends no test', async () => assert.equal(requests(state,'POST','/api/test-notification').length,0));
    await page.getByLabel('替换用户密钥（留空保留）').fill(key); await page.getByLabel('应用令牌来源').selectOption('private'); await page.getByLabel(/^个人应用令牌/).fill(token); await page.getByRole('button',{name:'保存通知渠道'}).click();
    await check('key cleared after save', () => expect(page.getByLabel('替换用户密钥（留空保留）')).toHaveValue(''));
    await check('no reflected raw secrets', async () => { const text = await page.locator('body').innerText(); assert(!text.includes(key)&&!text.includes(token)); });
    await page.getByLabel('应用令牌来源').selectOption('shared'); await page.getByRole('button',{name:'保存通知渠道'}).click();
    await expect(page.locator('dd').filter({hasText:'使用部署共享令牌'})).toBeVisible();
    await check('explicit null token', async () => assert.equal(requests(state,'PUT','/api/channels').at(-1).appTokenMode,'clear'));
    await page.getByRole('button',{name:'发送测试通知',exact:true}).click(); await page.getByRole('dialog').getByRole('button',{name:'取消',exact:true}).click();
    await check('cancel sends no test', async () => assert.equal(requests(state,'POST','/api/test-notification').length,0));
    state.failNext={path:'/api/test-notification',method:'POST',code:'notification_uncertain',status:504};
    await page.getByRole('button',{name:'发送测试通知',exact:true}).click(); await page.getByRole('dialog').getByRole('button',{name:'确认发送测试'}).click();
    await check('test uncertainty shown', () => expect(page.getByRole('dialog').getByRole('alert')).toContainText('可能已经送达'));
    await check('test deliberate confirm body', async () => assert.equal(requests(state,'POST','/api/test-notification').at(-1).confirm,true));
    await page.getByRole('dialog').getByRole('button',{name:'取消',exact:true}).click();
    await page.getByRole('button',{name:'发送测试通知',exact:true}).click(); await page.getByRole('dialog').getByRole('button',{name:'确认发送测试'}).click();
    await check('confirmed fixture test success', () => expect(page.getByRole('status').filter({hasText:'测试通知已交给 Pushover'})).toBeVisible());
  });
  await journey('06 settings CAS, bounded rate error, monitoring busy lock and stop confirmation', async () => {
    await page.getByLabel('每日通知尝试上限').fill('18'); state.failNext={path:'/api/settings',method:'PATCH',code:'generation_conflict',status:409,bump:true};
    await page.getByRole('button',{name:'保存提醒设置'}).click();
    await check('CAS conflict visible', () => expect(page.getByRole('alert')).toContainText('数据已在其他页面更新'));
    await page.getByRole('button',{name:'重新读取当前设置'}).click(); await page.getByLabel('每日通知尝试上限').fill('18');
    await page.getByRole('button',{name:'保存提醒设置'}).click(); await expect(page.getByRole('status').filter({hasText:'通知设置已保存'})).toBeVisible();
    await check('fresh settings generation', async () => assert.equal(requests(state,'PATCH','/api/settings').at(-1).expectedGeneration,1));
    await page.clock.install(); await page.clock.pauseAt(new Date());
    state.failNext={path:'/api/test-notification',method:'POST',code:'rate_limited',status:429,headers:{'Retry-After':'10'}};
    const businessCount = () => state.requests.filter(r=>!r.path.startsWith('/api/auth/') && r.path!=='/api/auth-capabilities').length;
    const countBefore429 = businessCount();
    await page.getByRole('button',{name:'发送测试通知',exact:true}).click(); await page.getByRole('dialog').getByRole('button',{name:'确认发送测试'}).click();
    await check('429 retry shown', () => expect(page.getByRole('dialog').getByRole('alert')).toContainText('重试等待：10'));
    await check('429 mutation error sends no immediate refresh', async () => assert.equal(businessCount(),countBefore429+1));
    const blockedCount = businessCount(), testsBeforeWait = requests(state,'POST','/api/test-notification').length;
    await page.getByRole('dialog').getByRole('button',{name:'确认发送测试'}).click();
    await page.keyboard.press('Escape');
    await page.locator('.connection-error').getByRole('button',{name:'重新读取状态'}).click();
    await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
    await page.clock.runFor(9000);
    await check('shared wait blocks manual/visibility/timers/mutation: zero requests', async () => assert.equal(businessCount(),blockedCount));
    await check('remaining wait uses existing model clock', () => expect(page.locator('.connection-error')).toContainText('重试等待：1 秒'));
    await page.clock.runFor(1000);
    await check('expiry automatically restores exactly one snapshot', async () => { await expect(page.locator('.connection-error')).toHaveCount(0); assert.equal(businessCount(),blockedCount+3); });
    await check('expiry never automatically replays POST', async () => assert.equal(requests(state,'POST','/api/test-notification').length,testsBeforeWait));
    await page.getByRole('button',{name:'发送测试通知',exact:true}).click();
    await page.getByRole('dialog').getByRole('button',{name:'确认发送测试'}).click();
    await check('expired POST requires explicit manual retry', () => expect(page.getByRole('status').filter({hasText:'测试通知已交给 Pushover'})).toBeVisible());
    await page.clock.resume();
    await nav(page,'行情与警报');
    let release; state.holdSettings={wait:new Promise(r=>{release=r;})};
    await page.getByRole('switch').click();
    await check('mutation busy lock', () => expect(page.getByRole('switch')).toBeDisabled()); release();
    await expect(page.getByRole('switch')).toHaveAttribute('aria-checked','true');
    await page.getByRole('switch').click();
    await check('pause cannot recall warning', () => expect(page.getByRole('dialog')).toContainText('已经开始发送的请求无法撤回'));
    await page.getByRole('dialog').getByRole('button',{name:'暂停监控',exact:true}).click();
    await check('paused explicitly', () => expect(page.getByRole('switch')).toHaveAttribute('aria-checked','false'));
  });
  await journey('07 actual polling preserves chart, missing/stale price and embed failure', async () => {
    const before = requests(state,'GET','/api/status').length; const scriptsBefore=chartScripts;
    await check('5-second status polling', () => expect.poll(()=>requests(state,'GET','/api/status').length,{timeout:7000}).toBeGreaterThan(before));
    await check('poll keeps chart node', async () => assert(await chart.evaluate(node=>node.isConnected)));
    await check('poll does not reload embed', async () => assert.equal(chartScripts,scriptsBefore));
    state.status.prices=[]; await refreshNavigation(page);
    await check('missing tick shown, no invented price', () => expect(page.getByText('尚未获得后台价格')).toBeVisible());
    state.status.prices=[{instrument:'BTC-USDT-SWAP',price:60000,timestamp:Date.now(),receivedAt:Date.now()}]; state.stale=true; await refreshNavigation(page);
    await check('stale tick explicit', () => expect(page.getByText(/价格已过期，停止触发/)).toBeVisible());
    state.chartFail=true; await page.getByRole('button',{name:'重连图表'}).click();
    await check('embed failure fallback', () => expect(page.getByText('图表暂时无法连接')).toBeVisible());
    await check('safe symbol external fallback', () => expect(page.getByRole('link',{name:'在 TradingView 打开',exact:true})).toHaveAttribute('href','https://www.tradingview.com/chart/?symbol=OKX%3ABTCUSDT.P'));
    state.chartFail=false; await page.getByRole('button',{name:'重试图表'}).click(); await expect(page.locator('iframe')).toBeVisible();
    await page.getByLabel('查看合约').selectOption('ETH-USDT-SWAP'); await expect(page.locator('iframe')).toBeVisible();
    await check('symbol change recreates once', async () => { const content=await page.locator('.tradingview-widget-container script').textContent(); assert.equal(JSON.parse(content).symbol,'OKX:ETHUSDT.P'); });
  });
  await journey('08 logout expires native cookie and discards delayed workspace response', async () => {
    let release; const held={wait:new Promise(r=>{release=r;})}; state.holdStatus=held;
    const start=requests(state,'GET','/api/status').length;
    await expect.poll(()=>requests(state,'GET','/api/status').length,{timeout:7000}).toBeGreaterThan(start);
    await page.getByRole('button',{name:'退出登录'}).click(); await expect(page.getByRole('heading',{name:'登录我的哨站'})).toBeVisible(); release();
    await check('logout cookie removed', async () => assert(!(await context.cookies(origin)).some(c=>c.name===cookieName)));
    await check('late workspace cannot show user', () => expect(page.locator('.session-email')).toHaveCount(0));
    await page.reload(); await check('reload remains logged out', () => expect(page.getByRole('heading',{name:'登录我的哨站'})).toBeVisible());
    await context.close();
  });
  const mobile=await setup(browser,'mobile',true), m=mobile.page;
  await journey('09 390×844 mobile layout, modal focus, navigation and MOCK capture', async () => {
    await m.goto(origin+'/dashboard'); await expect(m.getByRole('switch')).toBeVisible(); await expect(m.locator('iframe')).toBeVisible();
    await noOverflow(m); await m.screenshot({path:join(outputs,'open-alert-ui-mobile-MOCK.png'),fullPage:true});
    const frame=await m.locator('iframe').elementHandle(); await m.getByRole('button',{name:'＋ 创建警报'}).click();
    await check('mobile native modal focus', async () => assert(await m.getByRole('dialog').evaluate(d=>d.contains(document.activeElement)&&d.matches(':modal'))));
    await noOverflow(m); await m.keyboard.press('Escape');
    await check('Escape closes modal', () => expect(m.getByRole('dialog')).toHaveCount(0));
    await check('modal restores focus', async () => assert(await m.getByRole('button',{name:'＋ 创建警报'}).evaluate(b=>b===document.activeElement)));
    await nav(m,'手机通知'); await noOverflow(m); await nav(m,'我的账户'); await noOverflow(m);
    await check('ordinary account hides admin nav', () => expect(m.getByRole('navigation').getByRole('link',{name:'管理',exact:true})).toHaveCount(0));
    await nav(m,'行情与警报'); await check('mobile navigation preserves chart', async () => assert(await frame.evaluate(n=>n.isConnected)));
    await m.goto(origin+'/admin'); await check('ordinary user admin view guarded', () => expect(m.getByText('此页面仅供管理员使用。')).toBeVisible());
    await check('guard issues no admin API', async () => assert.equal(mobile.state.requests.filter(r=>r.path.startsWith('/api/admin/')).length,0));
  });
  await journey('10 admin bounded pagination and invitation copy under mobile fixture', async () => {
    mobile.state.status.user.role='admin'; mobile.state.status.capabilities.canAdmin=true; await m.reload();
    await expect(m.getByRole('button',{name:'加载更多账户'})).toBeVisible(); await noOverflow(m);
    await m.getByRole('button',{name:'加载更多账户'}).click();
    await check('admin cursor page fetched', async () => { await expect(m.getByRole('button',{name:'加载更多账户'})).toHaveCount(0); assert.equal(requests(mobile.state,'GET','/api/admin/users').length,2); });
    await m.getByLabel('受邀邮箱').fill('invite@example.test'); await m.getByRole('button',{name:'创建邮箱邀请'}).click();
    await check('invite does not claim sent email', () => expect(m.getByRole('status').filter({hasText:'已创建 invite@example.test'})).toContainText('此操作不表示邀请邮件已发送'));
    mobile.state.sessionInvalid=true;
    await check('expired session handled on poll', () => expect(m.getByRole('heading',{name:'登录我的哨站'})).toBeVisible({timeout:7000}));
    await mobile.context.close();
  });
  await journey('11 HTTP-date cooldown, blocked editor, delayed read coalescing and unmount abort', async () => {
    const fixture = await setup(browser,'desktop',true), p = fixture.page, s = fixture.state;
    const time = new Date('2026-10-12T12:00:00.000Z');
    await p.clock.install({time}); await p.clock.pauseAt(time);
    s.alerts = s.alerts.filter(a=>!a.pending);
    await p.goto(origin+'/dashboard'); await expect(p.getByRole('switch')).toBeVisible();
    await p.getByRole('button',{name:'＋ 创建警报'}).click();
    await p.getByRole('dialog').getByLabel('警报名称').fill('MOCK blocked by cooldown');
    await p.getByRole('dialog').getByLabel('价格 · USDT').fill('62000');
    s.failNext={path:'/api/status',method:'GET',code:'rate_limited',status:429,headers:{'Retry-After':new Date(time.getTime()+17000).toUTCString()}};
    await p.clock.runFor(5000);
    await check('HTTP-date parsed against browser now',()=>expect(p.locator('.connection-error')).toContainText('重试等待：12 秒'));
    const before = businessRequests(s).length;
    await p.getByRole('dialog').getByRole('button',{name:'创建警报',exact:true}).click();
    await check('editor blocked before action callback',()=>expect(p.getByRole('dialog').getByRole('alert')).toContainText('请求过于频繁'));
    await p.keyboard.press('Escape');
    for(let i=0;i<3;i++) { await p.locator('.connection-error').getByRole('button',{name:'重新读取状态'}).click(); await p.evaluate(()=>document.dispatchEvent(new Event('visibilitychange'))); }
    await p.clock.runFor(11000);
    await check('date cooldown zero requests across all read triggers and POST',async()=>assert.equal(businessRequests(s).length,before));
    await check('HTTP-date countdown reaches one second',()=>expect(p.locator('.connection-error')).toContainText('重试等待：1 秒'));
    let release; s.holdStatus={wait:new Promise(r=>{release=r;})};
    await p.clock.runFor(1000); await expect.poll(()=>businessRequests(s).length).toBe(before+3);
    for(let i=0;i<3;i++) { await p.locator('.connection-error').getByRole('button',{name:'重新读取状态'}).click(); await p.evaluate(()=>document.dispatchEvent(new Event('visibilitychange'))); }
    await p.clock.runFor(3000);
    await check('manual/visible/timer reads merge into held flight',async()=>assert.equal(businessRequests(s).length,before+3));
    release(); await check('visibility never aborts valid in-flight snapshot',()=>expect(p.locator('.connection-error')).toHaveCount(0));
    await check('snapshot refresh does not replay blocked editor POST',async()=>assert.equal(requests(s,'POST','/api/alerts').length,0));
    // A mutation clicked during an admitted read must observe its delayed 429.
    await p.getByRole('button',{name:'＋ 创建警报'}).click();
    await p.getByRole('dialog').getByLabel('警报名称').fill('MOCK delayed limit');
    await p.getByRole('dialog').getByLabel('价格 · USDT').fill('62000');
    let releaseLimit;
    s.failNext={path:'/api/status',method:'GET',code:'rate_limited',status:429,headers:{'Retry-After':'2'},wait:new Promise(r=>{releaseLimit=r;})};
    const delayedBefore = requests(s,'GET','/api/status').length;
    await p.clock.runFor(5000); await expect.poll(()=>requests(s,'GET','/api/status').length).toBe(delayedBefore+1);
    await p.getByRole('dialog').getByRole('button',{name:'创建警报',exact:true}).click();
    await check('mutation waits for already admitted read',()=>expect(p.getByRole('dialog').getByRole('button',{name:'正在保存…',exact:true})).toBeDisabled());
    releaseLimit();
    await check('delayed read 429 blocks waiting mutation callback',()=>expect(p.getByRole('dialog').getByRole('alert')).toContainText('重试等待：2 秒'));
    await check('delayed 429 never dispatches POST',async()=>assert.equal(requests(s,'POST','/api/alerts').length,0));
    await p.keyboard.press('Escape'); await p.clock.runFor(2000); await expect(p.locator('.connection-error')).toHaveCount(0);
    // Observe browser cancellation, not just a late response ignored by React.
    let releaseUnmount; s.holdStatus={wait:new Promise(r=>{releaseUnmount=r;})};
    const unmountBefore = requests(s,'GET','/api/status').length;
    await p.clock.runFor(5000); await expect.poll(()=>requests(s,'GET','/api/status').length).toBe(unmountBefore+1);
    const aborted = []; p.on('requestfailed',r=>{if(new URL(r.url()).pathname==='/api/status')aborted.push(r.failure().errorText);});
    await p.getByRole('button',{name:'退出登录'}).click();
    await expect.poll(async()=>{await p.clock.runFor(100);return await p.getByRole('heading',{name:'登录我的哨站'}).count();}).toBe(1);
    await check('workspace unmount aborts pending fetch',async()=>await expect.poll(()=>aborted.some(text=>/ABORTED/.test(text))).toBe(true));
    releaseUnmount(); await fixture.context.close();
  });
  await journey('12 invalid/missing/past Retry-After fallback, non-JSON 429 and independent auth/OTP', async () => {
    const fixture = await setup(browser,'desktop',true), p = fixture.page, s = fixture.state;
    const time = new Date('2026-10-12T14:00:00.000Z');
    await p.clock.install({time}); await p.clock.pauseAt(time);
    s.alerts = s.alerts.filter(a=>!a.pending);
    await p.goto(origin+'/dashboard'); await expect(p.getByRole('switch')).toBeVisible();
    for(const [name,value,raw] of [['invalid','nonsense',false],['missing',null,false],['past','Mon, 12 Oct 2026 13:00:00 GMT',false],['negative','-2',false],['zero','0',true]]) {
      s.failNext={path:'/api/status',method:'GET',code:'rate_limited',status:429,headers:value===null?{}:{'Retry-After':value},raw};
      await p.clock.runFor(5000); await expect(p.locator('.connection-error')).toContainText('重试等待：60 秒');
      const before = businessRequests(s).length;
      await p.locator('.connection-error').getByRole('button',{name:'重新读取状态'}).click();
      await p.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
      await p.clock.runFor(59000);
      await check(`${name} header fallback zero requests before expiry`,async()=>assert.equal(businessRequests(s).length,before));
      await p.clock.runFor(1000);
      await check(`${name} header fallback automatically resumes at expiry`,async()=>{await expect(p.locator('.connection-error')).toHaveCount(0);assert.equal(businessRequests(s).length,before+3);});
    }
    s.failNext={path:'/api/status',method:'GET',code:'rate_limited',status:429,headers:{'Retry-After':'120'}};
    await p.clock.runFor(5000); await expect(p.locator('.connection-error')).toContainText('重试等待：120 秒');
    const before = s.requests.filter(r=>!r.path.startsWith('/api/auth/')&&r.path!=='/api/auth-capabilities').length;
    await p.getByRole('button',{name:'退出登录'}).click();
    await expect.poll(async()=>{await p.clock.runFor(100);return await p.getByRole('heading',{name:'登录我的哨站'}).count();}).toBe(1);
    await check('login discovery bypasses business cooldown',()=>expect(p.getByRole('button',{name:'发送登录验证码'})).toBeEnabled());
    await p.getByLabel('邮箱地址').fill('mock@example.test'); await p.getByRole('button',{name:'发送登录验证码'}).click();
    await expect(p.getByLabel('邮件中的验证码')).toBeVisible();
    await check('OTP sends during business cooldown',async()=>assert.equal(requests(s,'POST','/api/auth/email-otp/send-verification-otp').length,1));
    await expect(p.getByRole('button',{name:'60 秒后重发',exact:true})).toBeDisabled();
    // React registers the next OTP timeout after each render: flush each virtual tick.
    for(let remaining=59;remaining>=1;remaining--) { await p.clock.runFor(1000); await expect(p.getByRole('button',{name:`${remaining} 秒后重发`,exact:true})).toBeDisabled(); }
    await check('OTP independent resend timer still blocks at 59s',()=>expect(p.getByRole('button',{name:'1 秒后重发',exact:true})).toBeDisabled());
    await p.clock.runFor(1000); await p.getByRole('button',{name:'重新发送',exact:true}).click();
    await check('OTP resend at 60s does not wait for business 120s',async()=>await expect.poll(()=>requests(s,'POST','/api/auth/email-otp/send-verification-otp').length).toBe(2));
    await check('auth traffic leaves business gate intact',async()=>assert.equal(s.requests.filter(r=>!r.path.startsWith('/api/auth/')&&r.path!=='/api/auth-capabilities').length,before));
    await fixture.context.close();
  });
  await journey('13 Google enabled, social callbacks, safe known/unknown errors and legacy normalization', async () => {
    const fixture = await setup(browser,'desktop'), p = fixture.page, s = fixture.state;
    s.googleEnabled = true;
    await p.addInitScript(() => {
      window.__routeReplacements = [];
      const replace = history.replaceState.bind(history);
      history.replaceState = (data, title, url) => { window.__routeReplacements.push(String(url)); replace(data, title, url); };
    });
    await p.goto(origin+'/login');
    await check('configured Google enabled',()=>expect(p.getByRole('button',{name:'使用 Google 登录'})).toBeEnabled());
    await p.getByRole('button',{name:'使用 Google 登录'}).click();
    await check('native redirect returns cancelled error',()=>expect(p.getByRole('alert')).toContainText('Google 登录已取消或未获授权'));
    await check('social callback body checked and called once',async()=>assert.equal(requests(s,'POST','/api/auth/sign-in/social').length,1));
    const cases = [
      ['account_not_linked','未能完成账户关联'], ['invalid_code','凭证无效或已过期'],
      ['access_denied','已取消或未获授权'], ['state_mismatch','验证状态不匹配'],
      ['state_not_found','请求已过期或验证状态已丢失'], ['state_expired','请求已过期或验证状态已丢失'],
      ['invitation_required','尚未获得邀请'], ['invite_required','尚未获得邀请'],
      ['account_disabled','账户已停用'], ['user_disabled','账户已停用'],
      ['registration_closed','注册已关闭'], ['signup_disabled','注册已关闭'],
    ];
    for (const [code, text] of cases) for (const variant of [code, code.toUpperCase()]) {
      const legacy = variant === code.toUpperCase();
      await p.goto(`${origin}${legacy ? '/' : '/login'}?error=${variant}&code=MOCK_SECRET_CODE&state=MOCK_SECRET_STATE&token=MOCK_SECRET_TOKEN&error_description=MOCK_PRIVATE_MESSAGE&callbackURL=https%3A%2F%2Fevil.example%2F#MOCK_PRIVATE_HASH`);
      await check(`${legacy?'legacy':'login'} ${variant} mapped`,()=>expect(p.getByRole('alert')).toContainText(text));
      await check('callback consumed and all query/hash removed',()=>expect(p).toHaveURL(origin+'/login'));
      await check('normalization forwards only allowlisted error',async()=>{
        const replacements=await p.evaluate(()=>window.__routeReplacements);
        assert(replacements.every(url=>url==='/login'||/^\/login\?error=[a-z_]+$/.test(url)));
        assert(replacements.every(url=>!url.includes('MOCK_')&&!url.includes('evil.example')));
        if(legacy)assert.match(replacements[0],/^\/login\?error=[a-z_]+$/);
        assert.equal(replacements.at(-1),'/login');
      });
      await check('email alternative remains usable',()=>expect(p.getByRole('button',{name:'发送登录验证码'})).toBeEnabled());
    }
    for (const value of ['<img src=x onerror=alert(1)> MOCK_HTML_LITERAL','https://evil.example/?token=MOCK_RAW_TOKEN','constructor','__proto__','']) {
      await p.goto(`${origin}/?error=${encodeURIComponent(value)}&code=MOCK_SECRET_CODE&state=MOCK_SECRET_STATE`);
      await check('unknown error uses safe generic copy',()=>expect(p.getByRole('alert')).toContainText('Google 登录未完成，请重试或使用邮箱验证码登录'));
      await check('unknown query never reflected or used for navigation',async()=>{
        assert.equal(p.url(),origin+'/login');
        const text=await p.locator('body').innerText();
        assert(!text.includes('MOCK_')&&!text.includes('evil.example')&&!text.includes('<img'));
        assert.equal(await p.locator('.login-panel img').count(),0);
        assert.deepEqual(await p.evaluate(()=>window.__routeReplacements),['/login?error=oauth_failed','/login']);
      });
    }
    await check('callback pages never auto-restart Google',async()=>assert.equal(requests(s,'POST','/api/auth/sign-in/social').length,1));
    s.socialError={code:'INVITATION_REQUIRED',message:'MOCK_PRIVATE_MESSAGE'};
    await p.getByRole('button',{name:'使用 Google 登录'}).click();
    await check('native social error mapped without server message',()=>expect(p.getByRole('alert')).toContainText('尚未获得邀请'));
    await check('social busy cleared on failure',()=>expect(p.getByRole('button',{name:'使用 Google 登录'})).toBeEnabled());
    await p.reload(); await check('consumed callback is not replayed on reload',()=>expect(p.getByRole('alert')).toHaveCount(0));
    await fixture.context.close();
    const existing=await setup(browser,'desktop',true);
    await existing.page.goto(origin+'/login?error=access_denied&code=MOCK_SECRET_CODE&state=MOCK_SECRET_STATE');
    await check('existing session goes to dashboard',()=>expect(existing.page).toHaveURL(origin+'/dashboard'));
    await check('existing session shows workspace without OAuth login loop',()=>expect(existing.page.getByRole('switch')).toBeVisible());
    await check('existing session never starts social login',async()=>assert.equal(requests(existing.state,'POST','/api/auth/sign-in/social').length,0));
    await existing.context.close();
  });
  await journey('14 SDK 15s session/social timeout, pending/busy recovery with virtual clock', async () => {
    const fixture=await setup(browser,'desktop'), p=fixture.page, s=fixture.state;
    s.googleEnabled=true;
    // Hold the transport until its real SDK AbortSignal fires; keep auth library code intact.
    await p.addInitScript(() => {
      window.__authHang='/api/auth/get-session'; window.__authHeld=0;
      const nativeFetch=window.fetch.bind(window);
      window.fetch=(input,init)=>{
        const path=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url,location.href).pathname;
        if(path!==window.__authHang)return nativeFetch(input,init);
        window.__authHeld++;
        return new Promise((resolve,reject)=>{
          const signal=init?.signal;
          const abort=()=>reject(new DOMException('MOCK aborted transport','AbortError'));
          if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});
        });
      };
    });
    const time=new Date('2026-10-12T16:00:00.000Z');
    await p.clock.install({time}); await p.clock.pauseAt(time);
    await p.goto(origin+'/login'); await p.clock.runFor(1);
    await expect.poll(()=>p.evaluate(()=>window.__authHeld)).toBe(1);
    await p.clock.runFor(14998);
    await check('session pending before 15s',()=>expect(p.getByRole('status').filter({hasText:'正在确认登录状态'})).toBeVisible());
    await p.clock.runFor(2);
    await check('session timeout exits pending with retry',()=>expect(p.getByRole('heading',{name:'无法确认登录状态'})).toBeVisible());
    await p.evaluate(()=>{window.__authHang='';});
    await p.getByRole('button',{name:'重试连接'}).click();
    await check('session timeout retry restores login',()=>expect(p.getByRole('button',{name:'使用 Google 登录'})).toBeEnabled());
    await p.evaluate(()=>{window.__authHang='/api/auth/sign-in/social';});
    await p.getByRole('button',{name:'使用 Google 登录'}).click();
    await expect.poll(()=>p.evaluate(()=>window.__authHeld)).toBe(2);
    await p.clock.runFor(14999);
    await check('social busy before 15s',()=>expect(p.getByRole('button',{name:'使用 Google 登录'})).toBeDisabled());
    await p.clock.runFor(1);
    await check('social timeout shows safe actionable error',()=>expect(p.getByRole('alert')).toContainText('请检查网络后重试，也可使用邮箱验证码登录'));
    await check('social timeout clears busy',()=>expect(p.getByRole('button',{name:'使用 Google 登录'})).toBeEnabled());
    await p.clock.runFor(30000);
    await check('timeout never automatically repeats Google',async()=>assert.equal(await p.evaluate(()=>window.__authHeld),2));
    await check('timeout leaves email alternative enabled',()=>expect(p.getByRole('button',{name:'发送登录验证码'})).toBeEnabled());
    await fixture.context.close();
  });
  await check('no runtime JS errors', async () => assert.deepEqual(runtimeErrors,[]));
  await check('no unknown API or schema violations', async () => assert.deepEqual(violations,[]));
  await check('no external requests except intercepted embed', async () => assert.deepEqual(externalAttempts,[]));
} catch(error) { console.error(error.stack); process.exitCode=1; }
finally {
  if(browser) await browser.close(); server.closeAllConnections(); await new Promise(r=>server.close(r)); clearTimeout(deadline);
  const evidence={mode:'MOCK',timedOut,scope:'Actual production React/Vite UI with intercepted API and chart embed; no real provider/server integration',profiles:['desktop Chromium 1440×1000','iPhone 15 Chromium emulation 390×844'],assertions,journeys:results,apiRequests,authRequests,chartScripts,runtimeErrors,violations,externalAttempts,limitations:['Real backend runtime/DB/session signature integration not tested','Google OAuth and external email delivery not tested','Pushover delivery and OKX feed not tested','TradingView embed substituted with a clearly labelled MOCK frame','Mobile Chromium emulation is not actual Safari'],passed:results.length===14&&results.every(r=>r.passed)&&!process.exitCode};
  await writeFile(join(outputs,'open-alert-browser-check-results-MOCK.json'),JSON.stringify(evidence,null,2)+'\n');
  console.log(`MOCK result: ${results.filter(r=>r.passed).length}/14 journeys, ${assertions} assertions; ${apiRequests} API requests; runtime errors=${runtimeErrors.length}; schema violations=${violations.length}`);
}
