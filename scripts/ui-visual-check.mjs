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
import { readFile, writeFile, readdir, access, mkdir } from 'node:fs/promises';
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
async function setup(browser, profile, authenticated = false) {
  const state = { ...F.makeBrowserFixture(), requests: [], failNext: null, stale: false, chartFail: false, nextId: 1, holdStatus: null, holdSettings: null, googleEnabled: false, emailSenderMode: 'console', otpError: null, inviteDelivery: {status:'not_attempted',reason:'resend_sandbox'}, socialError: null };
  const options = profile === 'mobile' ? { ...devices['iPhone 15'], viewport: { width: 390, height: 844 }, defaultBrowserType: undefined } : { viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 };
  const context = await browser.newContext({ ...options, serviceWorkers: 'block' });
  if (authenticated) await context.addCookies([{ name: cookieName, value: cookieValue, url: origin, httpOnly: true, sameSite: 'Lax' }]);
  await context.addInitScript(mark => {
    const attach = () => { if (window.top !== window) return; if (!document.body) return; if (document.getElementById('mock-label')) return; const banner = document.createElement('div'); banner.id = 'mock-label'; banner.textContent = mark; banner.setAttribute('style', 'position:fixed;bottom:0;left:0;right:0;z-index:99999;text-align:center;background:#ffdd7a;color:#15222f;font:700 11px/22px sans-serif;pointer-events:none'); document.body.append(banner); };
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
        return route.fulfill({ contentType: 'application/javascript', body: `(()=>{const script=document.currentScript;if(!script?.isConnected)return;const host=script.parentElement?.querySelector('.tradingview-widget-container__widget');if(!host)return;const iframe=document.createElement('iframe');iframe.title='MOCK TradingView chart';iframe.style='width:100%;height:100%';iframe.srcdoc='<body style="margin:0;background:#111;color:#a3a3a3;font:14px sans-serif;display:grid;place-items:center;height:100%;min-height:200px"><div>MOCK 图表占位 · 无实时数据<br><small>仅验证嵌入生命周期与页面布局</small></div></body>';host.append(iframe);})();` });
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
      if (path === '/api/quote' && method === 'GET') {
        if (state.quoteFail) return fail('service_unavailable',503);
        const instrument=url.searchParams.get('instrument');
        if (state.quoteHold) await state.quoteHold;
        let quoteNow;
        try { quoteNow=await page.evaluate(()=>Date.now()); }
        catch(error) { if(/Target page, context or browser has been closed/.test(error.message))return;throw error; }
        return ok({instrument,price:state.quotePrice ?? 60000,observedAt:quoteNow,timestamp:quoteNow});
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
async function noOverflow(page) { await check('mobile horizontal overflow', async () => { const size = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: innerWidth })); assert(size.scroll <= size.width+1, JSON.stringify(size)); }); }
async function refreshNavigation(page) { await page.reload(); await expect(page.getByRole('switch', { name: '监控总开关' })).toBeVisible(); }

const review = join(root, '.impeccable/review');
await mkdir(review, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  for (const profile of ['desktop', 'mobile']) {
    const {page, context, state} = await setup(browser, profile, true);
    await page.goto(origin+'/dashboard');
    await expect(page.getByRole('switch')).toBeVisible();
    await expect(page.locator('iframe')).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(450);
    await noOverflow(page);
    await page.screenshot({ path: join(review, profile+'.png'), fullPage: true });
    const retainedAlerts = state.alerts;
    state.alerts=[]; await page.reload();
    await expect(page.getByText('此市场暂无警报',{exact:true})).toBeVisible();
    await expect(page.locator('.alert-scope-count')).toHaveText('0 条');
    await expect(page.getByRole('tab',{name:'当前市场',exact:true})).toHaveAttribute('aria-selected','true');
    assert.equal(JSON.parse(await page.locator('.tradingview-widget-container script').textContent()).interval,'240');
    await page.locator('.alerts-panel').screenshot({path:join(review,profile+'-empty-zh.png')});
    state.alerts=retainedAlerts; await page.reload();
    const selected = await page.locator('.market-search-selection').first().textContent();
    await page.getByRole('button',{name:'EN',exact:true}).click();
    await expect(page.locator('html')).toHaveAttribute('lang','en');
    await expect(page.getByRole('heading',{name:'Markets & alerts',exact:true})).toBeVisible();
    await expect.poll(async () => JSON.parse(await page.locator('.tradingview-widget-container script').textContent()).locale).toBe('en');
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(350);
    await noOverflow(page);
    await page.screenshot({ path: join(review, profile+'-en.png'), fullPage: true });
    state.alerts=[]; await page.reload();
    await expect(page.getByText('No alerts for this market',{exact:true})).toBeVisible();
    await expect(page.locator('.alert-scope-count')).toHaveText('0 alerts');
    const scopeTab=page.getByRole('tab',{name:'Current market',exact:true});
    await scopeTab.focus(); await page.keyboard.press('End');
    await expect(page.getByRole('tab',{name:'All alerts',exact:true})).toHaveAttribute('aria-selected','true');
    await page.keyboard.press('Home');await expect(scopeTab).toHaveAttribute('aria-selected','true');
    await noOverflow(page);
    await page.locator('.alerts-panel').screenshot({path:join(review,profile+'-empty-en.png')});
    state.alerts=retainedAlerts; await page.reload();
    if (profile==='mobile') {
      const controls = await page.locator('.languages button,.header-actions>button,.icon-button,.instrument-button,.alert-buttons button,button.ui-monitor-switch').evaluateAll(nodes => nodes.map(node => ({name:node.getAttribute('aria-label') || node.textContent, width:node.getBoundingClientRect().width,height:node.getBoundingClientRect().height})));
      assert(controls.every(control => control.width >= 44 && control.height >= 44),JSON.stringify(controls));
      state.status.settings.enabled=true; await page.reload();
      await expect(page.getByRole('switch')).toHaveAttribute('aria-checked','true');
      await page.screenshot({path:join(review,'mobile-enabled-en.png'),fullPage:true});
      const thumb=await page.getByRole('switch').evaluate(node => { const track=node.getBoundingClientRect(),handle=node.querySelector('span').getBoundingClientRect();return {right:handle.right <= track.right,width:handle.width}; });
      assert(thumb.right); assert.equal(thumb.width,20);
      state.status.settings.enabled=false; await page.reload();
    }
    const userRules = state.alerts.map(x => JSON.stringify(x));
    await page.getByRole('button',{name:'Create alert',exact:true}).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByLabel('Alert name')).toBeVisible();
    await expect(page.getByRole('dialog').getByText(/already meets the condition/)).toHaveCount(0);
    assert.equal(await page.getByLabel('Alert name').getAttribute('data-slot'),'input');
    assert.equal(await page.getByRole('dialog').getByRole('combobox',{name:'Trigger condition',exact:true}).getAttribute('data-slot'),'select-trigger');
    await noOverflow(page);
    await page.screenshot({path:join(review,profile+'-editor-shadcn-en.png'),fullPage:true});
    await page.getByRole('dialog').locator('.market-search-trigger').click();
    await expect(page.locator('.ui-market-popover')).toBeVisible();
    await noOverflow(page);
    await page.screenshot({path:join(review,profile+'-market-shadcn-en.png'),fullPage:true});
    await page.keyboard.press('Escape');
    await expect(page.locator('.ui-market-popover')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await page.getByRole('navigation').getByRole('link',{name:'Notifications',exact:true}).click();
    await expect(page.getByRole('heading',{name:'Notifications',exact:true})).toBeVisible();
    await noOverflow(page);
    await page.screenshot({path:join(review,profile+'-notifications-en.png'),fullPage:true});
    await page.getByRole('navigation').getByRole('link',{name:'Account',exact:true}).click();
    await noOverflow(page);
    await page.screenshot({path:join(review,profile+'-account-en.png'),fullPage:true});
    assert.deepEqual(state.alerts.map(x=>JSON.stringify(x)),userRules);
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('lang','en');
    await page.getByRole('navigation').getByRole('link',{name:'Markets & alerts',exact:true}).click();
    await page.getByRole('button',{name:'中文',exact:true}).click();
    await expect(page.locator('html')).toHaveAttribute('lang','zh-CN');
    assert.equal(await page.locator('.market-search-selection').first().textContent(),selected);
    await context.close();
    const login = await setup(browser,profile,false);
    await login.page.goto(origin+'/login');
    await login.page.getByRole('button',{name:'EN',exact:true}).click();
    await expect(login.page.getByRole('heading',{name:'Sign in or create an account'})).toBeVisible();
    login.state.emailSenderMode='resend_sending_only'; login.state.googleEnabled=true;
    await login.page.reload();
    await expect(login.page.getByText(/Email is in test mode/)).toHaveCount(0);
    await expect(login.page.getByRole('button',{name:'Send verification code'})).toBeEnabled();
    await login.page.evaluate(() => document.fonts.ready); await noOverflow(login.page);
    await login.page.screenshot({path:join(review,profile+'-login-en.png'),fullPage:true});
    await login.page.getByLabel('Email address',{exact:true}).fill('mock@example.test');
    await login.page.getByRole('button',{name:'Send verification code'}).click();
    await expect(login.page.getByLabel('Code from your email')).toBeVisible();
    await noOverflow(login.page); await login.page.screenshot({path:join(review,profile+'-otp-en.png'),fullPage:true});
    await login.context.close();
    const admin = await setup(browser,profile,true);
    admin.state.status.user.role='admin'; admin.state.status.capabilities.canAdmin=true; admin.state.inviteDelivery={status:'accepted',reason:null};
    await admin.page.goto(origin+'/admin');
    await admin.page.getByRole('button',{name:'EN',exact:true}).click();
    await expect(admin.page.getByRole('heading',{name:'Admin',exact:true})).toBeVisible();
    await admin.page.evaluate(() => document.fonts.ready); await noOverflow(admin.page);
    await admin.page.screenshot({path:join(review,profile+'-admin-en.png'),fullPage:true});
    await admin.page.getByLabel('Invited email').fill('invited@example.test');
    await admin.page.getByRole('button',{name:'Create email invitation'}).click();
    await expect(admin.page.locator('.invitation-result')).toContainText('accepted the invitation email');
    await noOverflow(admin.page);
    await admin.page.screenshot({path:join(review,profile+'-invitation-result-en.png'),fullPage:true});
    await admin.page.getByLabel('Invited email').fill('invited@example.test');
    await admin.page.getByRole('button',{name:'Create email invitation'}).click();
    await expect(admin.page.locator('.invitation-result')).toContainText('No duplicate email was sent');
    await admin.context.close();
    console.log('PASS', profile, 'Chinese/English, preserved rules/market, persistence and responsive settings');
  }
  assert.equal(runtimeErrors.length,0,JSON.stringify(runtimeErrors));
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
