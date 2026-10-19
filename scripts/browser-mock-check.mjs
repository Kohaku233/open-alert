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
assets.set('/fonts/Sora-Variable.ttf', ['fonts/Sora-Variable.ttf', 'font/ttf']);
assets.set('/icon.svg', ['icon.svg', 'image/svg+xml']);
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
async function setup(browser, profile, authenticated = false, preferences = {}) {
  const state = { ...F.makeBrowserFixture(), requests: [], failNext: null, stale: false, chartFail: false, nextId: 1, holdStatus: null, holdSettings: null, googleEnabled: false, emailSenderMode: 'console', otpError: null, inviteDelivery: {status:'not_attempted',reason:'resend_sandbox'}, socialError: null };
  const options = profile === 'mobile' ? { ...devices['iPhone 15'], viewport: { width: 390, height: 844 }, defaultBrowserType: undefined } : { viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 };
  const context = await browser.newContext({ ...options, locale: 'zh-CN', colorScheme: 'dark', ...preferences, serviceWorkers: 'block' });
  if (authenticated) await context.addCookies([{ name: cookieName, value: cookieValue, url: origin, httpOnly: true, sameSite: 'Lax' }]);
  await context.addInitScript(({ mark, hide }) => {
    if (hide) return;
    const attach = () => { if (window.top !== window) return; if (!document.body) return; if (document.getElementById('mock-label')) return; const banner = document.createElement('div'); banner.id = 'mock-label'; banner.textContent = mark; banner.setAttribute('style', 'position:fixed;bottom:0;left:0;right:0;z-index:99999;text-align:center;background:#ffdd7a;color:#15222f;font:700 11px/22px sans-serif;pointer-events:none'); document.body.append(banner); };
    document.addEventListener('DOMContentLoaded', attach);
  }, { mark: label, hide: process.env.OPEN_ALERT_HIDE_MOCK_LABEL === '1' });
  const page = await context.newPage(); page.setDefaultTimeout(6000);
  page.on('pageerror', error => runtimeErrors.push(`${profile}: ${error.message}`));
  page.on('console', message => { if (message.type() === 'error' && !/Failed to load resource|ERR_FAILED/.test(message.text())) runtimeErrors.push(`${profile}: ${message.text()}`); });
  await context.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin !== origin) {
      if (url.href === 'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js') {
        chartScripts++;
        if (state.chartFail) return route.abort('failed');
        return route.fulfill({ contentType: 'application/javascript', body: `(()=>{const script=document.currentScript;if(!script?.isConnected)return;window.__mockChartConfigs??=[];window.__mockChartConfigs.push(JSON.parse(script.textContent));const host=script.parentElement?.querySelector('.tradingview-widget-container__widget');if(!host)return;const config=JSON.parse(script.textContent);const iframe=document.createElement('iframe');iframe.title='MOCK TradingView chart';iframe.style='width:100%;height:100%';iframe.srcdoc='<body style="margin:0;background:'+(config.theme==='light'?'#fff':'#111')+';color:'+(config.theme==='light'?'#616161':'#a3a3a3')+';font:14px sans-serif;display:grid;place-items:center;height:100%;min-height:200px"><div>MOCK 图表占位 · 无实时数据<br><small>仅验证嵌入生命周期与页面布局</small></div></body>';host.append(iframe);})();` });
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
    const ok = (data, status = 200) => send({ ok: true, data, ...(method!=='GET'&&state.wakePending?{effects:{schedulerWake:'pending'}}:{}), ...(!state.omitRequestIds ? {requestId:'mock-request'} : {}) }, status);
    const fail = (code, status = 409, headers = {}) => send({ ok: false, error: { code, message: `MOCK ${code}` }, requestId: 'mock-request' }, status, headers);
    try {
      const cookies = await context.cookies(origin);
      const loggedIn = !state.sessionInvalid && cookies.some(c => c.name === cookieName && c.value === cookieValue);
      if (path.startsWith('/api/auth/')) {
        authRequests++;
        if (path === '/api/auth/get-session' && method === 'GET') {
          if (state.holdSession) await state.holdSession.wait;
          return state.sessionReadFails ? send({message:'MOCK session temporarily unavailable'},503) : send(loggedIn ? nativeSession(state) : null);
        }
        if (path === '/api/auth/sign-in/social' && method === 'POST') {
          assert(state.googleEnabled);
          assert.deepEqual(body, { provider: 'google', callbackURL: `${origin}/dashboard`, errorCallbackURL: `${origin}/login` });
          // Local redirect exercises the SDK's real redirect plugin, without Google network.
          return state.socialError ? send(state.socialError, 403) : send({ url: `${origin}/login?error=access_denied`, redirect: true });
        }
        if (path === '/api/auth/email-otp/send-verification-otp' && method === 'POST') {
          if(state.otpError)return send({code:state.otpError,message:'MOCK provider error'},403); assert.deepEqual(body, { email: 'mock@example.test', type: 'sign-in' }); return send({ success: true }); }
        if (path === '/api/auth/sign-in/email-otp' && method === 'POST') {
          assert.equal(body.email, 'mock@example.test');
          if (body.otp !== '123456') return send({ code: 'INVALID_OTP', message: 'Invalid OTP' }, 400);
          return send({ token: 'mock-native-token', user: nativeSession(state).user }, 200, { 'Set-Cookie': `${cookieName}=${cookieValue}; Path=/; HttpOnly; SameSite=Lax` });
        }
        if (path === '/api/auth/sign-out' && method === 'POST') return send({ success: true }, 200, { 'Set-Cookie': `${cookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0` });
        throw new Error(`Unexpected native auth route ${method} ${path}`);
      }
      if (path === '/api/auth-capabilities' && method === 'GET') return ok({ google: state.googleEnabled, emailOtp: true, registration: 'invite', emailSenderMode:state.emailSenderMode });
      if (!loggedIn) return fail('unauthenticated', 401);
      if (state.failNext && state.failNext.path === path && state.failNext.method === method) {
        const error = state.failNext; state.failNext = null;
        if(error.invalidateSession)state.sessionInvalid=true;
        if (error.wait) await error.wait;
        if (error.bump) state.status.settingsGeneration++;
        if (error.raw) return route.fulfill({status:error.status,headers:error.headers,contentType:'text/html',body:'<h1>MOCK rate limit</h1>'});
        if (error.payload) return send(error.payload,error.status,error.headers);
        return fail(error.code, error.status, error.headers);
      }
      if (path === '/api/status' && method === 'GET') {
        if(state.statusUnavailable)return fail('service_unavailable',503);
        const snapshot = structuredClone(state.status), now = Date.now();
        snapshot.prices.forEach(p => { p.timestamp = now - (state.stale ? 60000 : 0); p.receivedAt = p.timestamp; });
        if (state.holdStatus) { const release = state.holdStatus; state.holdStatus = null; await release.wait; }
        return ok({...snapshot,...(url.searchParams.get('include')==='alerts'&&!state.legacyStatus?{alerts:structuredClone(state.alerts)}:{})});
      }
      if (path === '/api/quote' && method === 'GET') {
        if (state.quoteFail) return fail('service_unavailable',503);
        const instrument=url.searchParams.get('instrument');
        if (state.quoteHold) await state.quoteHold;
        let quoteNow;
        try { quoteNow=await page.evaluate(()=>Date.now()); }
        catch(error) { if(/Target page, context or browser has been closed|Execution context was destroyed/.test(error.message))return;throw error; }
        return ok({instrument,price:state.quotePrice ?? 60000,observedAt:quoteNow,timestamp:quoteNow});
      }
      if (path === '/api/markets' && method === 'GET') {
        if(state.catalogFail)return route.fulfill({status:503,contentType:'text/html',headers:{'CF-Ray':'mock-catalog-HKG'},body:'<h1>Worker exceeded resource limits</h1>'});
        return ok({ markets: state.markets, updatedAt: Date.now(), stale: false });
      }
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
      if (path === '/api/admin/invites' && method === 'GET') {
        return ok({items:[...(state.invites?.values()??[])].map(item=>({id:item.id,email:item.email,expiresAt:item.expiresAt,status:item.expiresAt===0?'revoked':item.expiresAt<=Date.now()?'expired':'pending'})),cursor:null});
      }
      if (path.startsWith('/api/admin/invites/') && (method === 'DELETE' || method === 'POST')) {
        const item=[...(state.invites?.values()??[])].find(item=>item.id===path.split('/')[4]);assert(item);
        assert.equal(body.expectedExpiresAt,item.expiresAt);
        if(method==='DELETE'){item.expiresAt=0;return ok({revoked:true});}
        assert.equal(body.confirm,true);return ok({...item,reused:true,emailDelivery:state.inviteDelivery});
      }
      if (path === '/api/admin/invites' && method === 'POST') {
        state.invites ??= new Map();const existing=state.invites.get(body.email);
        if(existing&&existing.expiresAt>Date.now())return ok({...existing,reused:true,emailDelivery:{status:'not_attempted',reason:'existing_invitation'}});
        const result={id:'mock-invite-'+state.invites.size,email:body.email,expiresAt:Date.now()+86400000,reused:false,emailDelivery:state.inviteDelivery};
        state.invites.set(body.email,result);return ok(result,201);
      }
      throw new Error(`Unexpected application route ${method} ${path}`);
    } catch (error) { violations.push(error.message); return fail('internal_error', 500); }
  });
  return { page, context, state };
}
const nav = (page, name) => page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name, exact: true }).click();
const row = (page, name) => page.locator('.alert-row').filter({ has: page.getByText(name, { exact: true }) });
const requests = (state, method, path) => state.requests.filter(r => r.method === method && r.path === path);
const businessRequests = state => state.requests.filter(r=>!r.path.startsWith('/api/auth/') && r.path!=='/api/auth-capabilities');
// A paused virtual clock also freezes the session SDK's first timer, so a fresh document needs one virtual tick to boot.
const tick = page => page.clock.runFor(1);
async function settleBootClock(page) {
  for (let step = 0; step < 16 && await page.locator('[data-slot="boot-stage"]').count(); step++)
    await page.clock.runFor(250);
  await expect(page.locator('[data-slot="boot-stage"]')).toHaveCount(0);
}
async function noOverflow(page) { await check('mobile horizontal overflow', async () => { const size = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: innerWidth })); assert(size.scroll <= size.width+1, JSON.stringify(size)); }); }
async function refreshNavigation(page) { await page.reload(); await expect(page.getByRole('switch', { name: '监控总开关' })).toBeVisible(); }
let browser, timedOut = false;
// Every fresh document boots behind the entrance curtain until its logo is fully
// formed and any view-handshake claims settle. The guard only needs to catch hangs.
const deadline = setTimeout(() => { timedOut = true; process.exitCode = 1; console.error('MOCK 300 second deadline exceeded'); void browser?.close(); server.closeAllConnections(); server.close(); }, 300000);
try {
  const launchEnv = { ...process.env }, cachedLib = join(homedir(), '.cache/okx-browser-check/lib');
  try { await access(join(cachedLib, 'libXdamage.so.1')); launchEnv.LD_LIBRARY_PATH = [cachedLib, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':'); } catch {}
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL, headless: true, env: launchEnv });
  console.log(`MOCK integration — Chromium ${browser.version()} — actual dist/web`);
  const { page, context, state } = await setup(browser, 'desktop');
  await journey('01 native email OTP, unavailable Google, cookie persistence', async () => {
    await page.goto(origin+'/login');
    await check('unconfigured Google is omitted', () => expect(page.getByRole('button', { name: '使用 Google 登录' })).toHaveCount(0));
    await check('email remains the primary available method', () => expect(page.getByRole('button', { name: '发送验证码' })).toBeEnabled());
    await page.getByLabel('邮箱地址').fill('MOCK@EXAMPLE.TEST'); await page.getByRole('button', { name: '发送验证码' }).click();
    await check('native OTP send', () => expect(page.getByLabel('邮件中的验证码')).toBeVisible());
    await check('resend cooldown', () => expect(page.getByRole('button', { name: /秒后重发/ })).toBeDisabled());
    await page.getByLabel('邮件中的验证码').fill('000000'); await page.getByRole('button', { name: '验证并继续' }).click();
    await check('native OTP rejection', () => expect(page.getByRole('alert')).toContainText('验证码不正确或已过期'));
    await page.getByLabel('邮件中的验证码').fill('123456'); await page.getByRole('button', { name: '验证并继续' }).click();
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
    await page.getByRole('button', { name: '创建警报', exact: true }).click(); const dialog = page.getByRole('dialog');
    await check('modal focus inside', async () => assert(await dialog.evaluate(d => d.contains(document.activeElement) && d.getAttribute('aria-modal') === 'true')));
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
  await journey('03b shadcn market keyboard, venue identity, disabled results and focus return', async () => {
    const originalMarkets=state.markets;
    const template=originalMarkets[0];
    state.markets=[...originalMarkets,
      {...template,instrument:'binance:swap:BTCUSDT',venue:'binance',type:'swap',nativeId:'BTCUSDT',symbol:'BTC/USDT:USDT',settle:'USDT',tradingViewSymbol:'BINANCE:BTCUSDT.P'},
      {...template,instrument:'binance:spot:BTCUSDT',venue:'binance',type:'spot',nativeId:'BTCUSDT',symbol:'BTC/USDT',settle:null,tradingViewSymbol:'BINANCE:BTCUSDT'},
      {...template,instrument:'mexc:swap:BTC_USDT',venue:'mexc',type:'swap',nativeId:'BTC_USDT',symbol:'BTC/USDT:USDT',available:false},
      ...Array.from({length:45},(_,i)=>({...template,instrument:`binance:spot:ASSET${i}USDT`,venue:'binance',type:'spot',nativeId:`ASSET${i}USDT`,base:`ASSET${i}`,symbol:`ASSET${i}/USDT`,settle:null,tradingViewSymbol:undefined}))];
    await refreshNavigation(page);
    const trigger=page.getByRole('combobox',{name:'查看市场',exact:true});
    const originalSelection=await trigger.textContent();
    await trigger.click();
    const search=page.getByRole('combobox',{name:'搜索市场',exact:true});
    await check('search auto-focus',()=>expect(search).toBeFocused());
    await check('bounded market results',()=>expect(page.locator('[cmdk-item]')).toHaveCount(40));
    await search.fill('BTC');
    await chooseSelect(page,'交易所','binance');await chooseSelect(page,'市场类型','swap');
    await check('canonical futures result isolated',()=>expect(page.locator('[cmdk-item]')).toHaveCount(1));
    await check('filters preserve selection',()=>expect(trigger).toHaveText(originalSelection));
    await search.focus();await page.keyboard.press('ArrowDown');await page.keyboard.press('Enter');
    await check('keyboard selects Binance futures',()=>expect(trigger).toContainText('Binance · USDT 永续 · BTC / USDT'));
    await check('selection closes popover and returns focus',()=>expect(trigger).toBeFocused());
    await trigger.click();await chooseSelect(page,'市场类型','spot');
    await page.locator('[cmdk-item][data-instrument="binance:spot:BTCUSDT"]').click();
    await check('spot retains distinct identity',()=>expect(trigger).toContainText('Binance · 现货 · BTC / USDT'));
    await trigger.click();await chooseSelect(page,'交易所','mexc');await chooseSelect(page,'市场类型','swap');
    await check('unavailable result disabled',()=>expect(page.locator('[cmdk-item][data-instrument="mexc:swap:BTC_USDT"]')).toHaveAttribute('aria-disabled','true'));
    await search.focus();await page.keyboard.press('Enter');
    await check('disabled option cannot replace selected spot',()=>expect(trigger).toContainText('Binance · 现货 · BTC / USDT'));
    await search.fill('NO_MATCH_123');await check('empty results provide recovery',()=>expect(page.getByText('没有匹配的市场。试试币种名称，或清除交易所和类型筛选。')).toBeVisible());
    await page.keyboard.press('Escape');await check('Escape returns market trigger focus',()=>expect(trigger).toBeFocused());
    state.markets=originalMarkets;await refreshNavigation(page);
    await page.getByRole('button',{name:'创建警报',exact:true}).click();
    await page.getByRole('dialog').getByLabel('警报名称').focus();await page.keyboard.press('Shift+Tab');
    await check('modal Tab remains trapped',async()=>assert(await page.getByRole('dialog').evaluate(d=>d.contains(document.activeElement))));
    await page.keyboard.press('Escape');await check('modal closing restores creating button',()=>expect(page.getByRole('button',{name:'创建警报',exact:true})).toBeFocused());
    chart = await page.locator('iframe').elementHandle();
  });
  await journey('03c response metadata compatibility, upstream diagnostics and no mutation replay', async () => {
    state.omitRequestIds=true;await refreshNavigation(page);
    await check('valid snapshot survives missing diagnostic IDs',()=>expect(page.locator('.connection-error')).toHaveCount(0));
    state.omitRequestIds=false;
    state.failNext={path:'/api/status',method:'GET',status:503,payload:{error:'upstream_unavailable'},headers:{'CF-Ray':'mock-ray-HKG'}};
    await page.reload();await expect(page.locator('.connection-error')).toBeVisible();
    await check('upstream JSON is correctly classified',()=>expect(page.locator('.connection-error')).toContainText('服务暂时不可用'));
    await check('endpoint and HTTP status are actionable',()=>expect(page.locator('.connection-error')).toContainText('接口：/api/status，HTTP 503'));
    await check('Cloudflare trace survives malformed envelope',()=>expect(page.locator('.connection-error')).toContainText('mock-ray-HKG'));
    await page.getByRole('button',{name:'重新读取状态',exact:true}).click();await expect(page.locator('.connection-error')).toHaveCount(0);
    await page.getByRole('button',{name:'创建警报',exact:true}).click();const dialog=page.getByRole('dialog');
    await dialog.getByLabel('警报名称').fill('MOCK uncertain write');await dialog.getByLabel('价格 · USDT').fill('65000');
    state.failNext={path:'/api/alerts',method:'POST',status:502,raw:true};
    const before=requests(state,'POST','/api/alerts').length;
    await dialog.getByRole('button',{name:'创建警报',exact:true}).click();
    await check('malformed write response requires manual reconciliation',()=>expect(dialog.getByRole('alert')).toContainText('可能已经生效'));
    await check('uncertain mutation dispatched exactly once',async()=>assert.equal(requests(state,'POST','/api/alerts').length,before+1));
    await page.keyboard.press('Escape');chart=await page.locator('iframe').elementHandle();
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
    await expect(page.locator('[data-sonner-toast]').filter({hasText:'通知渠道已保存'})).toBeVisible();
    await check('blank keys omitted', async () => assert.deepEqual(requests(state,'PUT','/api/channels').at(-1).fields,['provider']));
    await check('save sends no test', async () => assert.equal(requests(state,'POST','/api/test-notification').length,0));
    await page.getByLabel('替换用户密钥（留空保留）').fill(key); await chooseSelect(page,'应用令牌来源','private'); await page.getByLabel(/^个人应用令牌/).fill(token); await page.getByRole('button',{name:'保存通知渠道'}).click();
    await check('key cleared after save', () => expect(page.getByLabel('替换用户密钥（留空保留）')).toHaveValue(''));
    await check('no reflected raw secrets', async () => { const text = await page.locator('body').innerText(); assert(!text.includes(key)&&!text.includes(token)); });
    await chooseSelect(page,'应用令牌来源','shared'); await page.getByRole('button',{name:'保存通知渠道'}).click();
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
    await check('confirmed fixture test success', () => expect(page.locator('[data-sonner-toast]').filter({hasText:'测试通知已交给 Pushover'})).toBeVisible());
  });
  await journey('06 settings CAS, bounded rate error, monitoring busy lock and stop confirmation', async () => {
    await page.getByLabel('每日通知尝试上限').fill('18'); state.failNext={path:'/api/settings',method:'PATCH',code:'generation_conflict',status:409,bump:true};
    await page.getByRole('button',{name:'保存提醒设置'}).click();
    await check('CAS conflict visible', () => expect(page.getByRole('alert')).toContainText('数据已在其他页面更新'));
    await page.getByRole('button',{name:'重新读取当前设置'}).click(); await page.getByLabel('每日通知尝试上限').fill('18');
    await page.getByRole('button',{name:'保存提醒设置'}).click(); await expect(page.locator('[data-sonner-toast]').filter({hasText:'通知设置已保存'})).toBeVisible();
    await check('fresh settings generation', async () => assert.equal(requests(state,'PATCH','/api/settings').at(-1).expectedGeneration,1));
    // This reused page freezes time after GSAP cached native RAF. Test cooldowns with
    // reduced motion here; the real-clock GSAP journeys below cover normal exits.
    await page.emulateMedia({reducedMotion:'reduce'});
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
    await check('expiry automatically restores exactly one combined snapshot', async () => { await expect(page.locator('.connection-error')).toHaveCount(0); assert.equal(businessCount(),blockedCount+1); });
    await check('expiry never automatically replays POST', async () => assert.equal(requests(state,'POST','/api/test-notification').length,testsBeforeWait));
    await page.getByRole('button',{name:'发送测试通知',exact:true}).click();
    await page.getByRole('dialog').getByRole('button',{name:'确认发送测试'}).click();
    await check('expired POST requires explicit manual retry', () => expect(page.locator('[data-sonner-toast]').filter({hasText:'测试通知已交给 Pushover'})).toBeVisible());
    await page.clock.resume();
    await page.emulateMedia({reducedMotion:'no-preference'});
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
    const catalogsBefore=requests(state,'GET','/api/markets').length;
    await check('5-second status polling', () => expect.poll(()=>requests(state,'GET','/api/status').length,{timeout:7000}).toBeGreaterThan(before));
    await check('poll keeps chart node', async () => assert(await chart.evaluate(node=>node.isConnected)));
    await check('poll does not reload embed', async () => assert.equal(chartScripts,scriptsBefore));
    await check('five-second price poll reuses catalog',async()=>assert.equal(requests(state,'GET','/api/markets').length,catalogsBefore));
    state.status.prices=[]; state.quotePrice=60123; await refreshNavigation(page);
    await check('viewing quote does not need monitored tick', () => expect(page.locator('.price-block')).toContainText('60,123'));
    state.quoteFail=true;
    await check('failed quote retains old value and shows pause honestly', () => expect(page.getByText(/报价更新暂停/)).toBeVisible({timeout:7000}));
    await check('quote error is visible', () => expect(page.getByText(/行情报价更新失败/)).toBeVisible());
    state.quoteFail=false;
    state.chartFail=true; await page.getByRole('button',{name:'重连图表'}).click();
    await check('embed failure fallback', () => expect(page.getByText('图表暂时无法连接')).toBeVisible());
    await check('safe symbol external fallback', () => expect(page.getByRole('link',{name:'在 TradingView 打开',exact:true})).toHaveAttribute('href','https://www.tradingview.com/chart/?symbol=OKX%3ABTCUSDT.P'));
    state.chartFail=false; await page.getByRole('button',{name:'重试图表'}).click(); await expect(page.locator('iframe')).toBeVisible();
    await page.getByRole('combobox',{name:'查看市场',exact:true}).click(); await page.getByRole('combobox',{name:'搜索市场',exact:true}).fill('ETH'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter'); await expect(page.locator('iframe')).toBeVisible();
    await check('symbol change recreates once', async () => { const content=await page.locator('.tradingview-widget-container script').textContent(); assert.equal(JSON.parse(content).symbol,'OKX:ETHUSDT.P'); });
  });
  await journey('07b session catalog survives polling, focus, navigation and mutation; manual refresh and reload fetch again', async () => {
    const cached=await setup(browser,'desktop',true,{reducedMotion:'reduce'}),p=cached.page,s=cached.state;
    await p.clock.install({time:new Date()});
    s.failNext={path:'/api/status',method:'GET',status:503,code:'service_unavailable'};
    await p.goto(origin+'/dashboard');await expect(p.locator('.connection-error')).toBeVisible();
    const initialCatalogs=requests(s,'GET','/api/markets').length;
    await p.clock.runFor(5000);await expect(p.getByRole('switch')).toBeVisible();
    await check('initial status recovery retains successfully loaded directory',async()=>assert.equal(requests(s,'GET','/api/markets').length,initialCatalogs));
    const catalogsBefore=requests(s,'GET','/api/markets').length;
    for(let i=0;i<13;i++){await p.clock.runFor(5000);await new Promise(resolve=>setTimeout(resolve,60));}
    await check('catalog has no one-minute automatic expiry',async()=>assert.equal(requests(s,'GET','/api/markets').length,catalogsBefore));
    await p.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
    await nav(p,'手机通知');await nav(p,'行情与警报');
    await p.getByRole('button',{name:'创建警报',exact:true}).click();
    const editor=p.getByRole('dialog');await editor.getByLabel('警报名称').fill('MOCK 会话目录复用');await editor.getByLabel('价格 · USDT').fill('63000');
    await editor.getByRole('button',{name:'创建警报',exact:true}).click();await expect(row(p,'MOCK 会话目录复用')).toBeVisible();
    await check('focus, route changes and saved alert reuse directory',async()=>assert.equal(requests(s,'GET','/api/markets').length,catalogsBefore));
    const manualBefore=requests(s,'GET','/api/markets').length;
    let release; s.holdStatus={wait:new Promise(resolve=>{release=resolve;})};
    const pollsBefore=requests(s,'GET','/api/status').length;
    await p.clock.runFor(5000);await expect.poll(()=>requests(s,'GET','/api/status').length).toBeGreaterThan(pollsBefore);
    await p.getByRole('combobox',{name:'查看市场',exact:true}).click();
    await p.getByRole('button',{name:'重新读取市场目录',exact:true}).click();
    release();
    await expect.poll(()=>requests(s,'GET','/api/markets').length).toBe(manualBefore+1);await p.keyboard.press('Escape');
    await check('manual retry refreshes cached catalog immediately',async()=>assert.equal(requests(s,'GET','/api/markets').length,manualBefore+1));
    await refreshNavigation(p);
    await check('full page reload starts a new catalog session',async()=>assert.equal(requests(s,'GET','/api/markets').length,manualBefore+2));
    await cached.context.close();
  });
  await journey('07c failed manual directory refresh retains cache without automatic retries and preserves auth/rate limits', async () => {
    const cached=await setup(browser,'desktop',true,{reducedMotion:'reduce'}),p=cached.page,s=cached.state;
    await p.clock.install({time:new Date()});await p.goto(origin+'/dashboard');await expect(p.getByRole('switch')).toBeVisible();
    const catalogsBefore=requests(s,'GET','/api/markets').length;
    const advance=async(seconds)=>{for(let i=0;i<seconds/5;i++){await p.clock.runFor(5000);await new Promise(resolve=>setTimeout(resolve,65));}};
    const manual=async()=>{await p.getByRole('combobox',{name:'查看市场',exact:true}).click();await p.getByRole('button',{name:'重新读取市场目录',exact:true}).click();await p.keyboard.press('Escape');};
    s.catalogFail=true;s.alerts[0].name='MOCK 目录故障期间更新';
    await manual();
    await check('cached directory marked stale while fresh alerts still commit',async()=>{
      await expect(p.getByText('市场目录已过期，新增市场仍需服务端确认支持。')).toBeVisible();
      await expect(p.getByText('MOCK 目录故障期间更新',{exact:true})).toBeVisible();
      await expect(p.locator('.connection-error')).toHaveCount(0);
    });
    const statusBefore=requests(s,'GET','/api/status').length;
    await advance(130);
    await check('failed manual directory refresh is not retried by polling',async()=>{
      assert.equal(requests(s,'GET','/api/markets').length,catalogsBefore+1);
      assert(requests(s,'GET','/api/status').length>=statusBefore+9);
    });
    s.catalogFail=false;await advance(65);
    await check('cached metadata waits for explicit refresh',async()=>assert.equal(requests(s,'GET','/api/markets').length,catalogsBefore+1));
    await manual();
    await check('successful manual refresh clears stale marker',async()=>{
      await expect.poll(()=>requests(s,'GET','/api/markets').length).toBe(catalogsBefore+2);
      await expect(p.getByText('市场目录已过期，新增市场仍需服务端确认支持。')).toHaveCount(0);
    });
    s.failNext={path:'/api/markets',method:'GET',status:429,code:'rate_limited',headers:{'Retry-After':'30'}};
    await manual();
    await check('directory 429 still activates global business cooldown',()=>expect(p.locator('.connection-error')).toContainText('请求过于频繁'));
    const limited=businessRequests(s).length;await advance(20);assert.equal(businessRequests(s).length,limited);
    await advance(15);await expect(p.locator('.connection-error')).toHaveCount(0);
    s.failNext={path:'/api/markets',method:'GET',status:401,code:'unauthenticated',invalidateSession:true};
    await manual();
    await check('cached directory never masks expired login',()=>expect(p.getByRole('heading',{name:'登录或注册',exact:true})).toBeVisible());
    await cached.context.close();
  });
  await journey('07d combined status eliminates list polling and remains compatible with older servers', async () => {
    for(const legacy of [false,true]){
      const fixture=await setup(browser,'desktop',true,{reducedMotion:'reduce'}),p=fixture.page,s=fixture.state;
      s.legacyStatus=legacy;
      await p.clock.install({time:new Date()});await p.goto(origin+'/dashboard');await expect(p.getByRole('switch')).toBeVisible();
      const catalogs=requests(s,'GET','/api/markets').length;
      for(let i=0;i<3;i++){await p.clock.runFor(5000);await new Promise(resolve=>setTimeout(resolve,60));}
      const statusReads=requests(s,'GET','/api/status').length,alertReads=requests(s,'GET','/api/alerts').length;
      await check(legacy?'legacy server list fallback remains available':'combined snapshots need no separate list request',async()=>{
        assert(statusReads>=4);assert.equal(alertReads,legacy?statusReads:0);
        assert.equal(requests(s,'GET','/api/markets').length,catalogs);
      });
      await fixture.context.close();
    }
  });
  await journey('07e committed pending wake shows desktop/mobile warning without replaying a mutation',async()=>{
    for(const profile of ['desktop','mobile']){
      const fixture=await setup(browser,profile,true,{reducedMotion:'reduce'}),p=fixture.page,s=fixture.state;
      await p.goto(origin+'/dashboard');await expect(p.getByRole('switch')).toBeVisible();
      await expect(p.locator('[data-slot="boot-stage"]')).toHaveCount(0);
      await p.getByRole('button',{name:'创建警报',exact:true}).click();
      await p.getByRole('dialog').getByLabel('警报名称').fill('MOCK pending wake');
      await p.getByRole('dialog').getByLabel('价格 · USDT').fill('63000');
      s.wakePending=true;s.statusUnavailable=true;
      await p.getByRole('dialog').getByRole('button',{name:'创建警报',exact:true}).click();
      await check(`${profile} saved effect has an honest persistent warning`,()=>expect(p.locator('.scheduler-wake-warning')).toContainText('修改已保存'));
      if(profile==='mobile'){
        await p.getByRole('button',{name:'EN',exact:true}).click();
        await expect(p.locator('.scheduler-wake-warning')).toContainText('Changes are saved');
      }
      await p.screenshot({path:join(outputs,`wake-pending-${profile}-MOCK.png`),fullPage:true});
      s.statusUnavailable=false;
      await p.locator('.connection-error button').click();
      await check(`${profile} successful reconciliation clears pending warning`,()=>expect(p.locator('.scheduler-wake-warning')).toHaveCount(0));
      await check(`${profile} saved action is never replayed`,async()=>assert.equal(requests(s,'POST','/api/alerts').length,1));
      await fixture.context.close();
    }
  });
  await journey('08 logout expires native cookie and discards delayed workspace response', async () => {
    let release; const held={wait:new Promise(r=>{release=r;})}; state.holdStatus=held;
    const start=requests(state,'GET','/api/status').length;
    await expect.poll(()=>requests(state,'GET','/api/status').length,{timeout:7000}).toBeGreaterThan(start);
    await page.getByRole('button',{name:'退出登录'}).click(); await expect(page.getByRole('heading',{name:'登录或注册'})).toBeVisible(); release();
    await check('logout cookie removed', async () => assert(!(await context.cookies(origin)).some(c=>c.name===cookieName)));
    await check('late workspace cannot show user', () => expect(page.locator('.session-email')).toHaveCount(0));
    await page.reload(); await check('reload remains logged out', () => expect(page.getByRole('heading',{name:'登录或注册'})).toBeVisible());
    await context.close();
  });
  const mobile=await setup(browser,'mobile',true), m=mobile.page;
  await journey('09 390×844 mobile layout, modal focus, navigation and MOCK capture', async () => {
    await m.goto(origin+'/dashboard'); await expect(m.getByRole('switch')).toBeVisible(); await expect(m.locator('iframe')).toBeVisible();
    await noOverflow(m); await m.screenshot({path:join(outputs,'open-alert-ui-mobile-MOCK.png'),fullPage:true,animations:'disabled'});
    const frame=await m.locator('iframe').elementHandle(); await m.getByRole('button',{name:'创建警报',exact:true}).click();
    await check('mobile native modal focus', async () => assert(await m.getByRole('dialog').evaluate(d=>d.contains(document.activeElement)&&d.getAttribute('aria-modal') === 'true')));
    await noOverflow(m); await m.keyboard.press('Escape');
    await check('Escape closes modal', () => expect(m.getByRole('dialog')).toHaveCount(0));
    await check('modal restores focus', async () => assert(await m.getByRole('button',{name:'创建警报',exact:true}).evaluate(b=>b===document.activeElement)));
    await nav(m,'手机通知'); await noOverflow(m); await nav(m,'我的账户'); await noOverflow(m);
    await check('ordinary account hides admin nav', () => expect(m.getByRole('navigation').getByRole('link',{name:'管理',exact:true})).toHaveCount(0));
    await nav(m,'行情与警报'); await check('mobile navigation preserves chart', async () => assert(await frame.evaluate(n=>n.isConnected)));
    await m.goto(origin+'/admin'); await check('ordinary user admin view guarded', () => expect(m.getByText('此页面仅供管理员使用。')).toBeVisible());
    await check('guard issues no admin API', async () => assert.equal(mobile.state.requests.filter(r=>r.path.startsWith('/api/admin/')).length,0));
    await mobile.context.close();
  });
  await journey('10 admin bounded pagination and invitation copy under mobile fixture', async () => {
    // Own fixture: the journey 09 document must not stay parked on /admin when the role changes.
    const fixture=await setup(browser,'mobile',true), p=fixture.page, s=fixture.state;
    s.status.user.role='admin'; s.status.capabilities.canAdmin=true; await p.goto(origin+'/admin');
    await expect(p.getByRole('button',{name:'加载更多账户'})).toBeVisible(); await noOverflow(p);
    await p.getByRole('button',{name:'加载更多账户'}).click();
    await check('admin cursor page fetched', async () => { await expect(p.getByRole('button',{name:'加载更多账户'})).toHaveCount(0); assert.equal(requests(s,'GET','/api/admin/users').length,2); });
    await p.getByLabel('受邀邮箱').fill('invite@example.test'); await p.getByRole('button',{name:'创建邮箱邀请'}).click();
    await check('invite distinguishes admission from restricted email', () => expect(p.getByRole('status').filter({hasText:'已创建 invite@example.test'})).toContainText('当前邮件为测试模式'));
    s.sessionInvalid=true;
    await check('expired session handled on poll', () => expect(p.getByRole('heading',{name:'登录或注册'})).toBeVisible({timeout:7000}));
    await fixture.context.close();
  });
  await journey('11 HTTP-date cooldown, blocked editor, delayed read coalescing and unmount abort', async () => {
    const fixture = await setup(browser,'desktop',true,{reducedMotion:'reduce'}), p = fixture.page, s = fixture.state;
    const time = new Date('2026-10-12T12:00:00.000Z');
    await p.clock.install({time}); await p.clock.pauseAt(time);
    s.alerts = s.alerts.filter(a=>!a.pending);
    await p.goto(origin+'/dashboard'); await tick(p); await expect(p.getByRole('switch')).toBeVisible();
    // The boot entrance owns the first paint and blocks pointer input; with a paused
    // clock it only lifts while virtual time advances. Spend 1.5s of entrance here
    // and subtract it from the later cooldown run so checkpoints stay identical.
    await p.clock.runFor(1500); await expect(p.locator('[data-slot="boot-stage"]')).toHaveCount(0);
    await p.getByRole('button',{name:'创建警报',exact:true}).click();
    await p.getByRole('dialog').getByLabel('警报名称').fill('MOCK blocked by cooldown');
    await p.getByRole('dialog').getByLabel('价格 · USDT').fill('62000');
    s.failNext={path:'/api/status',method:'GET',code:'rate_limited',status:429,headers:{'Retry-After':new Date(time.getTime()+17000).toUTCString()}};
    // Land exactly on the 5s poll so the 429 is observed with the clock frozen at
    // t+5s and the HTTP-date countdown still reads 12 seconds.
    await p.clock.runFor(3500);
    await check('HTTP-date parsed against browser now',()=>expect(p.locator('.connection-error')).toContainText('重试等待：12 秒'));
    const before = businessRequests(s).length, quoteBefore=requests(s,'GET','/api/quote').length;
    await check('editor visibly disabled during cooldown',()=>expect(p.getByRole('dialog').getByRole('button',{name:'创建警报',exact:true})).toBeDisabled());
    await check('editor blocked before action callback',()=>expect(p.getByRole('dialog').getByRole('alert')).toContainText('请求过于频繁'));
    await p.keyboard.press('Escape');
    for(let i=0;i<3;i++) { await p.locator('.connection-error').getByRole('button',{name:'重新读取状态'}).click(); await p.evaluate(()=>document.dispatchEvent(new Event('visibilitychange'))); }
    await p.clock.runFor(11000);
    await check('date cooldown zero requests across all read triggers and POST',async()=>assert.equal(businessRequests(s).length,before));
    await check('HTTP-date countdown reaches one second',()=>expect(p.locator('.connection-error')).toContainText('重试等待：1 秒'));
    let release; s.holdStatus={wait:new Promise(r=>{release=r;})};
    await p.clock.runFor(1000); await expect.poll(()=>businessRequests(s).length-requests(s,'GET','/api/quote').length+quoteBefore).toBe(before+1);
    for(let i=0;i<3;i++) { await p.locator('.connection-error').getByRole('button',{name:'重新读取状态'}).click(); await p.evaluate(()=>document.dispatchEvent(new Event('visibilitychange'))); }
    await p.clock.runFor(3000);
    await check('manual/visible/timer reads merge into held flight',async()=>assert.equal(businessRequests(s).length-requests(s,'GET','/api/quote').length+quoteBefore,before+1));
    release(); await check('visibility never aborts valid in-flight snapshot',()=>expect(p.locator('.connection-error')).toHaveCount(0));
    await check('snapshot refresh does not replay blocked editor POST',async()=>assert.equal(requests(s,'POST','/api/alerts').length,0));
    // A mutation clicked during an admitted read must observe its delayed 429.
    await p.getByRole('button',{name:'创建警报',exact:true}).click();
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
    // Recovery clears the banner on the 1s recovery interval, whose phase is not
    // aligned with a paused clock; keep advancing virtual time until that tick lands.
    await p.keyboard.press('Escape');
    // Each step has to stay small enough that the whole recovery finishes before the
    // next 5s poll, but the real budget must cover a loaded machine's virtual ticks.
    let virtualSteps = 0;
    await expect.poll(async()=>{
      if(virtualSteps<6) { virtualSteps++; await p.clock.runFor(600); }
      return await p.locator('.connection-error').count();
    },{timeout:20000}).toBe(0);
    // Observe browser cancellation, not just a late response ignored by React.
    let releaseUnmount; s.holdStatus={wait:new Promise(r=>{releaseUnmount=r;})};
    const unmountBefore = requests(s,'GET','/api/status').length;
    await p.clock.runFor(5000); await expect.poll(()=>requests(s,'GET','/api/status').length).toBe(unmountBefore+1);
    const aborted = []; p.on('requestfailed',r=>{if(new URL(r.url()).pathname==='/api/status')aborted.push(r.failure().errorText);});
    await p.getByRole('button',{name:'退出登录'}).click();
    await expect.poll(async()=>{await p.clock.runFor(100);return await p.getByRole('heading',{name:'登录或注册'}).count();}).toBe(1);
    await check('workspace unmount aborts pending fetch',async()=>await expect.poll(()=>aborted.some(text=>/ABORTED/.test(text))).toBe(true));
    releaseUnmount(); await fixture.context.close();
  });
  await journey('12 invalid/missing/past Retry-After fallback, non-JSON 429 and independent auth/OTP', async () => {
    const fixture = await setup(browser,'desktop',true,{reducedMotion:'reduce'}), p = fixture.page, s = fixture.state;
    const time = new Date('2026-10-12T14:00:00.000Z');
    await p.clock.install({time}); await p.clock.pauseAt(time);
    s.alerts = s.alerts.filter(a=>!a.pending);
    await p.goto(origin+'/dashboard'); await tick(p); await expect(p.getByRole('switch')).toBeVisible();
    for(const [name,value,raw] of [['invalid','nonsense',false],['missing',null,false],['past','Mon, 12 Oct 2026 13:00:00 GMT',false],['negative','-2',false],['zero','0',true]]) {
      s.failNext={path:'/api/status',method:'GET',code:'rate_limited',status:429,headers:value===null?{}:{'Retry-After':value},raw};
      await p.clock.runFor(5000); await expect(p.locator('.connection-error')).toContainText(/重试等待：6[01] 秒/);
      const before = businessRequests(s).length, quoteBefore=requests(s,'GET','/api/quote').length;
      await p.locator('.connection-error').getByRole('button',{name:'重新读取状态'}).click();
      await p.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
      await p.clock.runFor(59000);
      await check(`${name} header fallback zero requests before expiry`,async()=>assert.equal(businessRequests(s).length,before));
      await p.clock.runFor(1000);
      await check(`${name} header fallback automatically resumes combined snapshot using cached directory`,async()=>{await expect(p.locator('.connection-error')).toHaveCount(0);assert.equal(businessRequests(s).length-requests(s,'GET','/api/quote').length+quoteBefore,before+1);});
    }
    s.failNext={path:'/api/status',method:'GET',code:'rate_limited',status:429,headers:{'Retry-After':'120'}};
    await p.clock.runFor(5000); await expect(p.locator('.connection-error')).toContainText('重试等待：120 秒');
    const before = s.requests.filter(r=>!r.path.startsWith('/api/auth/')&&r.path!=='/api/auth-capabilities').length;
    await p.getByRole('button',{name:'退出登录'}).click();
    await expect.poll(async()=>{await p.clock.runFor(100);return await p.getByRole('heading',{name:'登录或注册'}).count();}).toBe(1);
    await settleBootClock(p);
    await check('login discovery bypasses business cooldown',()=>expect(p.getByRole('button',{name:'发送验证码'})).toBeEnabled());
    await p.getByLabel('邮箱地址').fill('mock@example.test'); await p.getByRole('button',{name:'发送验证码'}).click();
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
      await check('email alternative remains usable',()=>expect(p.getByRole('button',{name:'发送验证码'})).toBeEnabled());
    }
    for (const value of ['<img src=x onerror=alert(1)> MOCK_HTML_LITERAL','https://evil.example/?token=MOCK_RAW_TOKEN','constructor','__proto__','']) {
      await p.goto(`${origin}/?error=${encodeURIComponent(value)}&code=MOCK_SECRET_CODE&state=MOCK_SECRET_STATE`);
      await check('unknown error uses safe generic copy',()=>expect(p.getByRole('alert')).toContainText('Google 登录未完成，请重试或使用邮箱验证码登录'));
      await check('unknown query never reflected or used for navigation',async()=>{
        await expect(p).toHaveURL(origin+'/login');
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
    // Let the entrance curtain finish lifting before the paused clock is asked to
    // accept pointer input on the recovery button.
    await settleBootClock(p);
    await p.evaluate(()=>{window.__authHang='';});
    await p.getByRole('button',{name:'重试连接'}).click();
    await check('session timeout retry restores login',()=>expect(p.getByRole('button',{name:'使用 Google 登录'})).toBeEnabled());
    // The retry re-arms the session entrance; settle it again before the next click.
    await settleBootClock(p);
    await p.evaluate(()=>{window.__authHang='/api/auth/sign-in/social';});
    await p.getByRole('button',{name:'使用 Google 登录'}).click();
    await expect.poll(()=>p.evaluate(()=>window.__authHeld)).toBe(2);
    await p.clock.runFor(14999);
    await check('social busy before 15s',()=>expect(p.getByRole('button',{name:'正在前往 Google…'})).toBeDisabled());
    await p.clock.runFor(1);
    await check('social timeout shows safe actionable error',()=>expect(p.getByRole('alert')).toContainText('请检查网络后重试，也可使用邮箱验证码登录'));
    await check('social timeout clears busy',()=>expect(p.getByRole('button',{name:'使用 Google 登录'})).toBeEnabled());
    await p.clock.runFor(30000);
    await check('timeout never automatically repeats Google',async()=>assert.equal(await p.evaluate(()=>window.__authHeld),2));
    await check('timeout leaves email alternative enabled',()=>expect(p.getByRole('button',{name:'发送验证码'})).toBeEnabled());
    await fixture.context.close();
  });
  await journey('15 selected market independent quotes, alert defaults/filter and MEXC perpetual widget',async()=>{
    const fixture=await setup(browser,'desktop',true),p=fixture.page,s=fixture.state;
    const template=s.markets[0],originalAlerts=structuredClone(s.alerts);
    s.markets=['binance','okx','mexc'].flatMap(venue=>['spot','swap'].map(type=>{
      const nativeId=venue==='okx'?`BTC-USDT${type==='swap'?'-SWAP':''}`:venue==='mexc'&&type==='swap'?'BTC_USDT':'BTCUSDT';
      return {...template,instrument:venue==='okx'&&type==='swap'?nativeId:`${venue}:${type}:${nativeId}`,venue,type,nativeId,base:'BTC',symbol:`BTC/USDT${type==='swap'?':USDT':''}`,settle:type==='swap'?'USDT':null,tradingViewSymbol:`${venue.toUpperCase()}:BTCUSDT${type==='swap'?'.P':''}`};
    }));
    s.status.prices=[];
    await p.goto(origin+'/dashboard');await expect(p.getByRole('switch')).toBeVisible();
    for(const market of s.markets){
      await p.getByRole('combobox',{name:'查看市场',exact:true}).click();
      await chooseSelect(p,'交易所',market.venue);await chooseSelect(p,'市场类型',market.type);
      await p.locator(`[cmdk-item][data-instrument="${market.instrument}"]`).click();
      await check(`${market.instrument} independent quote without monitored tick`,()=>expect(p.locator('.price-block')).toContainText('最新报价'));
      await check(`${market.instrument} exact widget mapping`,async()=>assert.equal(JSON.parse(await p.locator('.tradingview-widget-container script').textContent()).symbol,market.tradingViewSymbol));
      await check(`${market.instrument} panel scope`,()=>expect(p.locator('.alert-row')).toHaveCount(originalAlerts.filter(a=>a.instrument===market.instrument).length));
      await p.getByRole('button',{name:'创建警报',exact:true}).click();
      await check(`${market.instrument} new alert inherits exact venue and product`,()=>expect(p.getByRole('dialog').getByRole('combobox',{name:'警报市场'})).toContainText(`${market.venue==='binance'?'Binance':market.venue.toUpperCase()} · ${market.type==='spot'?'现货':'USDT 永续'}`));
      if(market.venue==='mexc'&&market.type==='swap'){
        await p.getByRole('dialog').getByLabel('警报名称').fill('MOCK MEXC perpetual');
        await p.getByRole('dialog').getByLabel('价格 · USDT').fill('65000');
        await p.getByRole('dialog').getByRole('button',{name:'创建警报',exact:true}).click();await expect(p.getByRole('dialog')).toHaveCount(0);
        await check('saved alert preserves exact MEXC perpetual instrument',async()=>assert.equal(s.alerts.at(-1).instrument,'mexc:swap:BTC_USDT'));
      }else{await p.keyboard.press('Escape');}
    }
    await check('switching never mutates existing alert identities/generations',async()=>assert.deepEqual(s.alerts.slice(0,originalAlerts.length),originalAlerts));
    await p.getByRole('tab',{name:'全部警报',exact:true}).click();
    await check('all alerts management remains available',()=>expect(p.locator('.alert-row')).toHaveCount(originalAlerts.length+1));
    await p.getByRole('tab',{name:'当前市场',exact:true}).click();
    await check('current MEXC market only shows MEXC rule',()=>expect(p.locator('.alert-row')).toHaveCount(1));
    await fixture.context.close();
  });
  await journey('16 invite recovery, email failure states and sandbox login stays available after logout',async()=>{
    const fixture=await setup(browser,'desktop',true),p=fixture.page,s=fixture.state;
    s.status.user.role='admin';s.status.capabilities.canAdmin=true;s.status.capabilities.google=true;
    s.googleEnabled=true;s.emailSenderMode='resend_sandbox';
    await p.goto(origin+'/admin');await expect(p.getByLabel('受邀邮箱')).toBeVisible();
    async function invite(email){await p.getByLabel('受邀邮箱').fill(email);await p.getByRole('button',{name:'创建邮箱邀请',exact:true}).click();await expect(p.locator('.invitation-result')).toContainText(email);}
    await invite('other@example.test');
    await check('restricted mail does not turn committed invitation into error',()=>expect(p.locator('.invitation-result')).toContainText('邀请已生效'));
    const first=s.invites.get('other@example.test');await invite('other@example.test');
    await check('retry recovers existing invite without conflict or expiry extension',async()=>{await expect(p.locator('.invitation-result')).toContainText('本次未重复发送邮件');assert.equal(s.invites.size,1);assert.equal(s.invites.get('other@example.test').expiresAt,first.expiresAt);});
    s.inviteDelivery={status:'failed',reason:'email_rejected'};await invite('failed@example.test');
    await check('email rejection clearly says invitation remains saved',()=>expect(p.locator('.invitation-result')).toContainText('邀请已保存，但邮件发送失败'));
    s.inviteDelivery={status:'uncertain',reason:'email_uncertain'};await invite('uncertain@example.test');
    await check('uncertain delivery warns against repeated sending',()=>expect(p.locator('.invitation-result')).toContainText('邮件投递结果暂不确定'));
    await p.reload();
    await check('invitation list survives page reload',()=>expect(p.locator('.invitation-list li')).toHaveCount(3));
    const revokedRow=p.locator('.invitation-list li').filter({hasText:'other@example.test'});
    await revokedRow.getByRole('button',{name:'撤销邀请',exact:true}).click();
    await p.getByRole('dialog').getByRole('button',{name:'确认撤销'}).click();
    await check('revocation appears in persistent history',()=>expect(revokedRow).toContainText('已撤销'));
    await revokedRow.getByRole('button',{name:'再次邀请'}).click();await p.getByRole('button',{name:'创建邮箱邀请',exact:true}).click();
    await check('revoked email can be invited again deliberately',()=>expect(revokedRow).toContainText('待加入'));
    await p.getByRole('button',{name:'退出登录'}).click();await expect(p.getByLabel('邮箱地址')).toBeEnabled();
    await check('sandbox disclosure replaces misleading disabled-login warning',async()=>{await expect(p.getByText(/邮件服务目前为测试模式/)).toBeVisible();await expect(p.getByText(/邮箱登录尚未启用/)).toHaveCount(0);});
    s.otpError='EMAIL_RECIPIENT_RESTRICTED';await p.getByLabel('邮箱地址').fill('other@example.test');await p.getByRole('button',{name:'发送验证码'}).click();
    await check('specific recipient error never disables email or Google controls',async()=>{await expect(p.getByRole('alert')).toContainText('不能向此邮箱发送验证码');await expect(p.getByLabel('邮箱地址')).toBeEnabled();await expect(p.getByRole('button',{name:'使用 Google 登录'})).toBeEnabled();});
    s.otpError=null;await p.getByLabel('邮箱地址').fill('mock@example.test');await p.getByRole('button',{name:'发送验证码'}).click();
    await check('switching back to configured recipient still sends a code',()=>expect(p.getByLabel('邮件中的验证码')).toBeVisible());
    await fixture.context.close();
  });
  for (const profile of ['desktop','mobile']) await journey('email verification resumes across focus, reload, navigation and expiry ('+profile+')', async () => {
    const fixture=await setup(browser,profile),p=fixture.page,s=fixture.state;
    const time=new Date('2026-10-16T12:00:00.000Z');
    await p.clock.install({time});await p.clock.pauseAt(time);
    s.googleEnabled=true;s.emailSenderMode='resend_sending_only';
    await p.goto(origin+'/login?email=mock%40example.test'); await tick(p);
    // Session and capability requests have to settle before the view can become
    // visible, so advance the paused clock once before reading the prefilled form.
    await settleBootClock(p);
    await expect(p.getByLabel('邮箱地址')).toHaveValue('mock@example.test');
    await p.getByRole('button',{name:'发送验证码',exact:true}).click();
    await expect(p.getByRole('heading',{name:'验证邮箱',exact:true})).toBeVisible();
    await expect(p.getByText('验证码邮件已发送，请检查收件箱或垃圾邮件。')).toBeVisible();
    await p.getByLabel('邮件中的验证码').fill('123');
    await p.clock.runFor(6000);
    let release; s.holdSession={wait:new Promise(r=>{release=r;})};
    const reads=requests(s,'GET','/api/auth/get-session').length;
    const field=await p.getByLabel('邮件中的验证码').elementHandle();
    await p.evaluate(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'visible'});document.dispatchEvent(new Event('visibilitychange'));});
    await expect.poll(()=>requests(s,'GET','/api/auth/get-session').length).toBeGreaterThan(reads);
    await check(profile+' focus revalidation preserves mounted form and typed code',async()=>{assert(await field.evaluate(n=>n.isConnected));await expect(p.getByLabel('邮件中的验证码')).toHaveValue('123');});
    release();s.holdSession=null;
    await p.clock.runFor(6000);s.sessionReadFails=true;
    const failedRefresh=p.waitForResponse(r=>new URL(r.url()).pathname==='/api/auth/get-session'&&r.status()===503);
    await p.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));await failedRefresh;
    await check(profile+' transient background session error preserves the form',async()=>{await expect(p.getByLabel('邮件中的验证码')).toHaveValue('123');assert(await field.evaluate(n=>n.isConnected));await expect(p.getByRole('heading',{name:'无法确认登录状态'})).toHaveCount(0);});
    s.sessionReadFails=false;
    await p.reload(); await tick(p);
    await settleBootClock(p);
    await check(profile+' reload restores code step without persisting code or replaying mail',async()=>{await expect(p.getByRole('heading',{name:'验证邮箱',exact:true})).toBeVisible();await expect(p.getByLabel('邮件中的验证码')).toHaveValue('');assert.equal(requests(s,'POST','/api/auth/email-otp/send-verification-otp').length,1);const stored=await p.evaluate(()=>sessionStorage.getItem('open-alert-email-login-v1'));assert(!stored.includes('123'));});
    await expect(p.getByRole('button',{name:/秒后重发/,exact:false})).toBeDisabled();
    await p.goto(origin+'/account'); await tick(p);
    await settleBootClock(p);
    await check(profile+' navigation returns to same verification step',async()=>{await expect(p).toHaveURL(origin+'/login');await expect(p.getByLabel('邮件中的验证码')).toBeVisible();assert.equal(requests(s,'POST','/api/auth/email-otp/send-verification-otp').length,1);});
    await p.getByRole('button',{name:'更换邮箱',exact:true}).click();
    await expect(p.getByLabel('邮箱地址')).toHaveValue('mock@example.test');
    await check(profile+' same email keeps resend cooldown after changing steps',async()=>{
      const label=await p.getByRole('button',{name:/秒后可重新发送/}).innerText();
      const seconds=Number(label.match(/(\d+)/)?.[1]);
      assert(seconds > 0, label);
      await expect(p.getByRole('button',{name:/秒后可重新发送/})).toBeDisabled();
    });
    await p.getByLabel('邮箱地址').fill('other@example.test');await expect(p.getByRole('button',{name:'发送验证码',exact:true})).toBeEnabled();
    await p.getByLabel('邮箱地址').fill('mock@example.test');await p.getByRole('button',{name:'已有验证码？继续验证'}).click();
    await p.clock.runFor(300000);
    await check(profile+' expiry keeps recovery visible and disables stale verification',async()=>{await expect(p.getByText('验证码已过期，请重新发送。',{exact:true})).toBeVisible();await expect(p.getByRole('button',{name:'验证并继续',exact:true})).toBeDisabled();await expect(p.getByRole('button',{name:'重新发送',exact:true})).toBeEnabled();assert.equal(requests(s,'POST','/api/auth/email-otp/send-verification-otp').length,1);});
    s.otpError='EMAIL_UNCERTAIN';await p.getByRole('button',{name:'重新发送',exact:true}).click();
    await expect(p.getByText(/尚未确认邮件是否送达/)).toBeVisible();
    await p.reload(); await tick(p);
    await settleBootClock(p);
    await check(profile+' uncertain delivery resumes with honest copy and no automatic resend',async()=>{await expect(p.getByText(/尚未确认邮件是否送达/)).toBeVisible();assert.equal(requests(s,'POST','/api/auth/email-otp/send-verification-otp').length,2);});
    await p.getByLabel('邮件中的验证码').fill('123456');await p.getByRole('button',{name:'验证并继续',exact:true}).click();
    await expect(p.getByRole('switch')).toBeVisible();
    await check(profile+' successful verification clears resumable email metadata',async()=>assert.equal(await p.evaluate(()=>sessionStorage.getItem('open-alert-email-login-v1')),null));
    await fixture.context.close();
  });
  for (const profile of ['desktop','mobile']) await journey('appearance, client language, entrance and reduced motion ('+profile+')', async () => {
    const fixture=await setup(browser,profile,true,{locale:'en-GB',colorScheme:'light'}),p=fixture.page,s=fixture.state;
    let releaseSession,releaseStatus;
    s.holdSession={wait:new Promise(resolve=>{releaseSession=resolve;})};
    s.holdStatus={wait:new Promise(resolve=>{releaseStatus=resolve;})};
    await p.goto(origin+'/dashboard');
    await check('client English and light appearance before session resolves',async()=>{
      await expect(p.locator('html')).toHaveAttribute('lang','en');await expect(p.locator('html')).toHaveAttribute('data-theme','light');
      await expect(p.getByRole('status')).toContainText('Checking your session');
      await expect(p.locator('[data-slot="boot-stage"]')).toBeVisible();
      assert.equal(await p.locator('[data-slot="page-skeleton"]').count(),0);
      assert.equal(await p.locator('[data-slot="skeleton"]').count(),0);
      assert.equal(await p.evaluate(()=>localStorage.length),0);
    });
    await noOverflow(p);
    await p.screenshot({path:join(outputs,'appearance-'+profile+'-loading-light-MOCK.png'),fullPage:profile==='desktop',animations:'disabled'});
    s.holdSession=null;releaseSession();
    await check('workspace entrance covers the first snapshot instead of skeletons',async()=>{
      await expect(p.getByRole('status')).toContainText('Loading your alerts and prices');
      assert.equal(await p.locator('[data-slot="page-skeleton"]').count(),0);
    });
    releaseStatus();
    await expect(p.locator('[data-slot="boot-stage"]')).toHaveCount(0,{timeout:15000});
    await expect(p.getByRole('switch')).toBeVisible();
    await chooseSelect(p,'Appearance','dark');
    await expect.poll(()=>p.locator('html').getAttribute('data-theme')).toBe('dark');
    await chooseSelect(p,'Appearance','system');await expect(p.locator('html')).toHaveAttribute('data-theme','light');
    // Match the event-delivery allowance used by the atomic-theme journey below.
    await p.emulateMedia({colorScheme:'dark'});await expect(p.locator('html')).toHaveAttribute('data-theme','dark',{timeout:20000});
    await check('system follows media without saving an override',async()=>assert.equal(await p.evaluate(()=>localStorage.getItem('open-alert-theme')),null));
    await p.getByRole('navigation').getByRole('link',{name:'Account',exact:true}).click();
    await expect(p.getByRole('heading',{name:'Account details',exact:true})).toBeVisible();
    await p.getByRole('navigation').getByRole('link',{name:'Markets & alerts',exact:true}).click();
    await expect(p.locator('iframe')).toHaveCount(1);
    await check('official chart config follows dark mode and remains 4h',async()=>{
      const config=await p.evaluate(()=>window.__mockChartConfigs.at(-1));assert.equal(config.theme,'dark');assert.equal(config.interval,'240');assert.equal(config.locale,'en');
    });
    await expect(p.locator('.route-surface')).toHaveAttribute('data-motion-state','settled');
    await p.evaluate(()=>document.fonts.ready);await p.waitForTimeout(80);
    await p.screenshot({path:join(outputs,'appearance-'+profile+'-dashboard-dark-MOCK.png'),fullPage:profile==='desktop',animations:'disabled'});
    await chooseSelect(p,'Appearance','light');
    await expect.poll(()=>p.evaluate(()=>window.__mockChartConfigs.at(-1)?.theme)).toBe('light');
    await p.emulateMedia({colorScheme:'dark'});await expect(p.locator('html')).toHaveAttribute('data-theme','light');
    await check('explicit light choice persisted',async()=>assert.equal(await p.evaluate(()=>localStorage.getItem('open-alert-theme')),'light'));
    await noOverflow(p);
    await p.evaluate(()=>document.fonts.ready);await p.waitForTimeout(80);
    await p.screenshot({path:join(outputs,'appearance-'+profile+'-dashboard-light-MOCK.png'),fullPage:profile==='desktop',animations:'disabled'});
    const scriptsBefore=await p.evaluate(()=>window.__mockChartConfigs.length);
    await p.getByRole('button',{name:'Monitoring notes & limits'}).click();
    await expect(p.locator('.disclosure-content')).toBeVisible();
    await p.getByRole('navigation').getByRole('link',{name:'Notifications',exact:true}).click();
    await expect(p.getByRole('heading',{name:'Pushover connection',exact:true})).toBeVisible();
    await noOverflow(p);
    await p.screenshot({path:join(outputs,'appearance-'+profile+'-notifications-light-MOCK.png'),fullPage:profile==='desktop',animations:'disabled'});
    await p.getByRole('navigation').getByRole('link',{name:'Markets & alerts',exact:true}).click();
    await check('navigation preserves widget instance',async()=>assert.equal(await p.evaluate(()=>window.__mockChartConfigs.length),scriptsBefore));
    await p.emulateMedia({reducedMotion:'reduce'});
    await p.getByRole('button',{name:'Create alert',exact:true}).click();
    await check('reduced motion and dialog keep working',async()=>{
      await expect(p.getByRole('dialog')).toBeVisible();
      assert(parseFloat(await p.getByRole('dialog').evaluate(node=>getComputedStyle(node).animationDuration))<=0.001);
      assert.equal(await p.getByLabel('Alert name').getAttribute('data-slot'),'input');
    });
    await p.keyboard.press('Escape');
    await p.getByRole('button',{name:'中文',exact:true}).click();await p.reload();
    await expect(p.locator('html')).toHaveAttribute('lang','zh-CN');await expect(p.locator('html')).toHaveAttribute('data-theme','light');
    await fixture.context.close();
  });
  await journey('unauthenticated fast session waits for the logo and locale fallback stays isolated',async()=>{
    for (const [locale,expected] of [['ja-JP','en'],['zh-TW','zh-CN']]) {
      const fixture=await setup(browser,'desktop',false,{locale,colorScheme:'light'});
      const time=new Date();
      await fixture.page.clock.install({time}); await fixture.page.clock.pauseAt(time);
      await fixture.page.goto(origin+'/login'); await tick(fixture.page);
      await fixture.page.clock.runFor(200);
      await check('login stays behind the settling logo',async()=>{
        await expect(fixture.page.locator('[data-slot="boot-stage"]')).toBeVisible();
        await expect(fixture.page.locator('[data-slot="boot-stage"]')).toHaveAttribute('data-boot-phase','entering');
        assert.equal(await fixture.page.getByRole('heading',{name:expected==='en'?'Sign in or create an account':'登录或注册'}).count(),0);
      });
      let sawSettledMark=false;
      for(let step=0;step<8 && !sawSettledMark;step++) {
        await fixture.page.clock.runFor(200);
        sawSettledMark=await fixture.page.locator('[data-slot="boot-stage"][data-mark-ready="true"]').count()===1;
      }
      await check('logo finishes before the login view is revealed',()=>assert(sawSettledMark));
      for(let step=0;step<10 && await fixture.page.locator('[data-slot="boot-stage"]').count();step++) {
        await fixture.page.clock.runFor(200);
      }
      await check('login appears only after the mark is complete',async()=>{
        await expect(fixture.page.getByRole('heading',{name:expected==='en'?'Sign in or create an account':'登录或注册'})).toBeVisible();
        await expect(fixture.page.locator('[data-slot="boot-stage"]')).toHaveCount(0);
      });
      await check('client language '+locale,async()=>{await expect(fixture.page.locator('html')).toHaveAttribute('lang',expected);assert.equal(await fixture.page.evaluate(()=>localStorage.length),0);});
      if(expected==='en') {
        await expect(fixture.page.getByRole('heading',{name:'Sign in or create an account'})).toBeVisible();
        await fixture.page.screenshot({path:join(outputs,'appearance-desktop-login-light-MOCK.png'),fullPage:true,animations:'disabled'});
      }
      await fixture.context.close();
    }
  });
  for (const profile of ['desktop','mobile']) await journey('atomic theme colors and GSAP interruption, focus and cleanup ('+profile+')',async()=>{
    const f=await setup(browser,profile,true,{locale:'en-GB',colorScheme:'light'}),p=f.page,s=f.state;
    await p.goto(origin+'/dashboard');await expect(p.getByRole('switch')).toBeVisible();
    await p.getByRole('button',{name:'Create alert',exact:true}).click();
    await expect(p.locator('[data-slot="dialog-content"]')).toHaveAttribute('data-motion-state','settled');
    await p.getByLabel('Alert name').fill('Unsent draft');
    await p.evaluate(()=>{
      window.__themeFrames=[];
      const observe=()=>{
        const colors=selector=>{const n=document.querySelector(selector);if(!n)return null;const c=getComputedStyle(n);return{bg:c.backgroundColor,text:c.color,border:c.borderColor};};
        window.__themeFrames.push({theme:document.documentElement.dataset.theme,body:colors('body'),dialog:colors('[data-slot="dialog-content"]'),input:colors('[data-slot="dialog-content"] [data-slot="input"]'),select:colors('[data-slot="dialog-content"] [data-slot="select-trigger"]'),primary:colors('[data-slot="dialog-content"] [data-variant="default"]')});
      };
      window.__themeObserver=new MutationObserver(observe);
      window.__themeObserver.observe(document.documentElement,{attributes:true,attributeFilter:['data-theme']});
      observe();
    });
    // Chromium reports an emulated media change as its own task and a loaded machine can
    // delay that delivery, so wait for the browser event before holding the app to it.
    await p.evaluate(()=>{window.__mediaChanges=0;const probe=matchMedia('(prefers-color-scheme: dark)');probe.addEventListener('change',()=>{window.__mediaChanges+=1;});});
    for(const theme of ['dark','light']) {
      await p.evaluate(()=>{window.__mediaChanges=0;});
      await p.emulateMedia({colorScheme:theme});
      await check('emulated media change reaches the document ('+theme+')',async()=>{
        await expect.poll(()=>p.evaluate(()=>window.__mediaChanges),{timeout:20000}).toBeGreaterThan(0);
        await expect(p.locator('html')).toHaveAttribute('data-theme',theme,{timeout:15000});
      });
      await check('theme stays coherent in the first changed frame ('+theme+')',async()=>{
        const sample=await p.evaluate(()=>window.__themeFrames.at(-1));
        const tokens=await p.evaluate(()=>{const s=getComputedStyle(document.documentElement);return{background:s.getPropertyValue('--background').trim(),foreground:s.getPropertyValue('--foreground').trim(),popover:s.getPropertyValue('--popover').trim(),field:s.getPropertyValue('--muted').trim()};});
        const expected=await p.evaluate(values=>{const probe=document.createElement('span');probe.style.color=values.background;document.body.append(probe);const result=Object.fromEntries(Object.entries(values).map(([key,value])=>{probe.style.color=value;return[key,getComputedStyle(probe).color];}));probe.remove();return result;},tokens);
        assert.equal(sample.theme,theme);
        assert.equal(sample.body.bg,expected.background);
        assert.equal(sample.body.text,expected.foreground);
        assert.equal(sample.dialog.bg,expected.popover);
        assert.equal(sample.input.bg,expected.field);
        assert.equal(sample.select.bg,sample.input.bg);assert.equal(sample.select.text,sample.input.text);
        assert.equal(sample.primary.bg,sample.body.text);assert.equal(sample.primary.text,sample.body.bg);
        await expect(p.getByLabel('Alert name')).toHaveValue('Unsent draft');
      });
      await p.getByRole('combobox',{name:'Trigger condition',exact:true}).click();
      await expect(p.locator('[data-slot="select-content"]')).toHaveAttribute('data-motion-state','settled');
      await check('portalled select follows the same palette',async()=>{
        const c=await p.locator('[data-slot="select-content"]').evaluate(n=>({bg:getComputedStyle(n).backgroundColor,color:getComputedStyle(n).color}));
        const tokens=await p.evaluate(()=>{const s=getComputedStyle(document.documentElement);return{background:s.getPropertyValue('--popover').trim(),foreground:s.getPropertyValue('--foreground').trim()};});
        const expected=await p.evaluate(values=>{const probe=document.createElement('span');probe.style.color=values.background;document.body.append(probe);const result=Object.fromEntries(Object.entries(values).map(([key,value])=>{probe.style.color=value;return[key,getComputedStyle(probe).color];}));probe.remove();return result;},tokens);
        assert.equal(c.bg,expected.background);
        assert.equal(c.color,expected.foreground);
      });
      await p.keyboard.press('Escape');await expect(p.locator('[data-slot="select-content"]')).toHaveCount(0);
      await expect(p.getByRole('combobox',{name:'Trigger condition',exact:true})).toContainText('At or above');
    }
    await p.evaluate(()=>window.__themeObserver.disconnect());
    await p.keyboard.press('Escape');await expect(p.locator('[data-slot="dialog-content"]')).toHaveCount(0);
    await check('focus returns after the actual GSAP exit',()=>expect(p.getByRole('button',{name:'Create alert',exact:true})).toBeFocused());
    for(let cycle=0;cycle<5;cycle++) {
      await p.getByRole('button',{name:'Create alert',exact:true}).click();
      await expect(p.locator('[data-slot="dialog-content"]')).toBeVisible();
      await p.keyboard.press('Escape');await expect(p.locator('[data-slot="dialog-content"]')).toHaveCount(0);
    }
    await p.locator('.market-search-trigger').first().click();
    await expect(p.getByRole('combobox',{name:'Search markets',exact:true})).toBeFocused();
    await expect(p.locator('[data-slot="popover-content"]')).toHaveAttribute('data-motion-state','settled');
    await p.locator('[data-slot="popover-content"]').evaluate(n=>{n.dataset.retainedForTest='yes';});
    // Close/reopen in the same event turn: the existing timeline must reverse cleanly.
    await p.evaluate(()=>{const trigger=document.querySelector('.market-search-trigger');trigger.click();queueMicrotask(()=>trigger.click());});
    await expect(p.locator('[data-slot="popover-content"]')).toHaveAttribute('data-motion-state','settled');
    await expect(p.locator('[data-slot="popover-content"]')).toHaveAttribute('data-retained-for-test','yes');
    await p.keyboard.press('Escape');await expect(p.locator('[data-slot="popover-content"]')).toHaveCount(0);
    const chartBefore=await p.evaluate(()=>window.__mockChartConfigs.length);
    const runsBefore=await p.locator('.route-surface').getAttribute('data-motion-runs');
    const readsBefore=requests(s,'GET','/api/status').length;
    await p.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
    await expect.poll(()=>requests(s,'GET','/api/status').length).toBeGreaterThan(readsBefore);
    await check('background refresh does not replay entrances or reset the chart',async()=>{assert.equal(await p.locator('.route-surface').getAttribute('data-motion-runs'),runsBefore);assert.equal(await p.evaluate(()=>window.__mockChartConfigs.length),chartBefore);});
    await p.getByRole('navigation').getByRole('link',{name:'Notifications',exact:true}).click();
    await expect(p.getByRole('heading',{name:'Pushover connection',exact:true})).toBeVisible();
    await expect(p.locator('.settings-page')).toHaveAttribute('data-motion-state','settled');
    await check('navigation underline tracks the actual active link',async()=>{
      const bounds=await p.locator('.app-nav').evaluate(n=>{const a=n.querySelector('[aria-current="page"]').getBoundingClientRect(),i=n.querySelector('.nav-indicator').getBoundingClientRect();return{left:Math.abs(a.left-i.left),width:Math.abs(a.width-i.width)};});assert(bounds.left<1&&bounds.width<1,JSON.stringify(bounds));
    });
    await p.getByRole('navigation').getByRole('link',{name:'Markets & alerts',exact:true}).click();
    await p.getByRole('button',{name:'Monitoring notes & limits'}).click();await expect(p.locator('.disclosure-content')).toHaveAttribute('data-motion-state','settled');
    await p.getByRole('button',{name:'Monitoring notes & limits'}).click();await expect(p.locator('.disclosure-content')).toBeHidden();
    await p.emulateMedia({reducedMotion:'reduce'});
    await p.getByRole('button',{name:'Create alert',exact:true}).click();
    await check('reduced motion keeps the form visible and immediately usable',async()=>{await expect(p.locator('[data-slot="dialog-content"]')).toHaveAttribute('data-motion-state','settled');await p.getByLabel('Alert name').fill('Reduced-motion draft');await expect(p.getByLabel('Alert name')).toHaveValue('Reduced-motion draft');});
    await p.keyboard.press('Escape');await expect(p.locator('[data-slot="dialog-content"]')).toHaveCount(0);
    const motionPath=[...assets.keys()].find(path=>path.startsWith('/assets/motion-'));
    await check('GSAP is installed and no tween retains a detached DOM target',async()=>{
      const status=await p.evaluate(async path=>{const module=await import(path);const engine=Object.values(module).find(value=>value&&value.globalTimeline&&value.matchMedia);if(!engine)return{found:false};const tweens=engine.globalTimeline.getChildren(true,true,false);return{found:true,version:engine.version,detached:tweens.flatMap(t=>t.targets()).filter(n=>n instanceof Element&&!n.isConnected).length};},motionPath);
      assert(status.found);assert.equal(status.version,'3.15.0');assert.equal(status.detached,0);
    });
    await noOverflow(p);await f.context.close();
  });
  await check('no runtime JS errors', async () => assert.deepEqual(runtimeErrors,[]));
  await check('no unknown API or schema violations', async () => assert.deepEqual(violations,[]));
  await check('no external requests except intercepted embed', async () => assert.deepEqual(externalAttempts,[]));
} catch(error) { console.error(error.stack); process.exitCode=1; }
finally {
  if(browser) await browser.close(); server.closeAllConnections(); await new Promise(r=>server.close(r)); clearTimeout(deadline);
  const evidence={mode:'MOCK',timedOut,scope:'Actual production React/Vite UI with intercepted API and chart embed; no real provider/server integration',profiles:['desktop Chromium 1440×1000','iPhone 15 Chromium emulation 390×844'],assertions,journeys:results,apiRequests,authRequests,chartScripts,runtimeErrors,violations,externalAttempts,limitations:['Real backend runtime/DB/session signature integration not tested','Google OAuth and external email delivery not tested','Pushover delivery and OKX feed not tested','TradingView embed substituted with a clearly labelled MOCK frame','Mobile Chromium emulation is not actual Safari'],passed:results.length===29&&results.every(r=>r.passed)&&!process.exitCode};
  await writeFile(join(outputs,'open-alert-browser-check-results-MOCK.json'),JSON.stringify(evidence,null,2)+'\n');
  console.log(`MOCK result: ${results.filter(r=>r.passed).length}/29 journeys, ${assertions} assertions; ${apiRequests} API requests; runtime errors=${runtimeErrors.length}; schema violations=${violations.length}`);
}

async function chooseSelect(page,label,value) {
  await page.getByRole('combobox',{name:label,exact:true}).click();
  await page.locator('[role="option"][data-value="'+value+'"]').click();
}
