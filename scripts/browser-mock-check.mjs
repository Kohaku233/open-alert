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
const results = [], violations = [], runtimeErrors = [], knownRuntimeWarnings = [], externalAttempts = [];
let assertions = 0, apiRequests = 0, authRequests = 0, chartScripts = 0;
const check = async (name, fn) => { assertions++; await fn(); };
const only = process.env.OPEN_ALERT_JOURNEY ? new RegExp(process.env.OPEN_ALERT_JOURNEY) : null;
const allJourneys = [], selectedJourneys = [];
const journey = async (name, fn) => {
  allJourneys.push(name);
  if (only && !only.test(name)) return;
  selectedJourneys.push(name);
  const start = Date.now();
  try {
    await fn();
    results.push({ name, passed: true, durationMs: Date.now() - start });
    console.log(`PASS ${name}`);
  } catch (error) {
    results.push({ name, passed: false, error: error.stack });
    throw error;
  }
};
const assets = new Map([['/', ['index.html', 'text/html']], ['/index.html', ['index.html', 'text/html']], ...['login','dashboard','alerts','notifications','settings','account','admin'].map(p => [`/${p}`, ['index.html','text/html']])]);
assets.set('/fonts/Sora-Variable.ttf', ['fonts/Sora-Variable.ttf', 'font/ttf']);
assets.set('/icon.svg', ['icon.svg', 'image/svg+xml']);
for (const name of await readdir(join(root, 'dist/web/fonts/breakout'))) if (name.endsWith('.woff2')) assets.set('/fonts/breakout/'+name, ['fonts/breakout/'+name,'font/woff2']);
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
async function setup(browser, profile, authenticated = false, { chart = 'tradingview', ...preferences } = {}) {
  const state = { ...F.makeBrowserFixture(), requests: [], failNext: null, stale: false, chartFail: false, nextId: 1, holdStatus: null, holdSettings: null, googleEnabled: false, emailSenderMode: 'console', otpError: null, inviteDelivery: {status:'not_attempted',reason:'resend_sandbox'}, socialError: null };
  const options = profile === 'mobile' ? { ...devices['iPhone 15'], viewport: { width: 390, height: 844 }, defaultBrowserType: undefined } : { viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 };
  const context = await browser.newContext({ ...options, locale: 'zh-CN', colorScheme: 'dark', ...preferences, serviceWorkers: 'block' });
  if (authenticated) await context.addCookies([{ name: cookieName, value: cookieValue, url: origin, httpOnly: true, sameSite: 'Lax' }]);
  await context.addInitScript(({ mark, hide }) => {
    if (hide) return;
    const attach = () => { if (window.top !== window) return; if (!document.body) return; if (document.getElementById('mock-label')) return; const banner = document.createElement('div'); banner.id = 'mock-label'; banner.textContent = mark; banner.setAttribute('style', 'position:fixed;bottom:0;left:0;right:0;z-index:99999;text-align:center;background:#ffdd7a;color:#15222f;font:700 11px/22px sans-serif;pointer-events:none'); document.body.append(banner); };
    document.addEventListener('DOMContentLoaded', attach);
  }, { mark: label, hide: process.env.OPEN_ALERT_HIDE_MOCK_LABEL === '1' });
  // The built-in chart is the product default; older journeys pin TradingView so their embed checks stay meaningful.
  if (chart) await context.addInitScript(kind => { try { if (!localStorage.getItem('open-alert-chart')) localStorage.setItem('open-alert-chart', kind); } catch {} }, chart);
  const page = await context.newPage(); page.setDefaultTimeout(6000);
  page.on('pageerror', error => runtimeErrors.push(`${profile}: ${error.message}`));
  page.on('console', message => {
    if (message.type() !== 'error') return;
    const text = message.text();
    if (/WebSocket connection to 'ws:\/\/[^']+\/api\/live' failed: Error during WebSocket handshake: Unexpected response code: 404/.test(text)) {
      knownRuntimeWarnings.push(`${profile}: ${text}`);
      return;
    }
    if (!/Failed to load resource|ERR_FAILED/.test(text)) runtimeErrors.push(`${profile}: ${text}`);
  });
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
    const evidence = { method, path, fields: body ? Object.keys(body) : [], expectedGeneration: body?.expectedGeneration, confirm: body?.confirm, threshold: body?.threshold, instrument: url.searchParams.get('instrument') ?? body?.instrument, timeframe: url.searchParams.get('timeframe') ?? undefined, appTokenMode: body && Object.hasOwn(body, 'appToken') ? body.appToken === null ? 'clear' : 'replace' : 'retain' };
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
      if (path === '/api/public-quotes' && method === 'GET') {
        if(state.holdPublicQuotes)await state.holdPublicQuotes.wait;
        if(state.publicPreviewFail)return fail('service_unavailable',503);
        const capturedAt=Date.now(),revision=state.previewRevision??0;
        return ok({capturedAt,entries:[['binance:swap:BTCUSDT','BINANCE','BTC/USDT-P',70000],['ETH-USDT-SWAP','OKX','ETH/USDT-P',2500],['mexc:spot:SOLUSDT','MEXC','SOL/USDT',180]].map(([instrument,venue,pair,base])=>{
          const history=Array.from({length:90},(_,i)=>({instrument,price:base+Math.sin((i+revision)*.2)*base*.002,timestamp:capturedAt-(89-i)*500,observedAt:capturedAt}));
          return {instrument,venue,pair,quote:history.at(-1),history,stale:false};
        })});
      }
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
      if (path === '/api/account' && method === 'GET') {
        if ([...url.searchParams.keys()].length) return fail('invalid_request',400);
        return ok(accountView(state));
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
      if (path === '/api/candles' && method === 'GET') {
        // Deterministic synthetic candles around the mock quote; older pages end after two.
        const tfm=/^(\d+)([mhdw])$/.exec(url.searchParams.get('timeframe')??''),tf=tfm?Number(tfm[1])*{m:6e4,h:36e5,d:864e5,w:6048e5}[tfm[2]]:0;
        assert(tf && state.markets.some(m=>m.instrument===url.searchParams.get('instrument')));
        const before=url.searchParams.get('before'), end=before?Number(before):Math.floor(Date.now()/tf)*tf+tf;
        state.candlePages=(state.candlePages??0)+1;
        if(before&&state.candlePages>3)return ok({instrument:url.searchParams.get('instrument'),timeframe:url.searchParams.get('timeframe'),candles:[],done:true});
        const candles=Array.from({length:300},(_,i)=>{const time=end-(300-i)*tf,base=(state.quotePrice??60000)*(1+Math.sin(time/tf/9)*0.01);return [time,base,base*1.003,base*0.997,base*(1+Math.cos(time/tf/5)*0.002),10+i%7];});
        return ok({instrument:url.searchParams.get('instrument'),timeframe:url.searchParams.get('timeframe'),candles,done:false});
      }
      if (path === '/api/anomaly' && method === 'GET') return ok(anomalyView(state));
      if (path === '/api/notify/deliveries' && method === 'GET') return ok({deliveries:notifyState(state).deliveries});
      if (path === '/api/notify' && method === 'GET') return ok(notifyView(state));
      if (path === '/api/notify/channels' && method === 'POST') {
        const n=notifyState(state), config=body.config??{};
        (state.notifyPosts??=[]).push({type:body.type,name:body.name,fields:Object.keys(config)});
        const summary=body.type==='discord'?{webhook:'…'+String(config.webhookUrl??'').split('/').at(-1).slice(-6)}:{tokenSource:config.appToken?'private':'shared',userKey:'…'+String(config.userKey??'').slice(-4)};
        const c={id:'ch-'+(state.nextId++),type:body.type,name:body.name,enabled:true,legacy:false,generation:0,lastOutcome:null,lastCode:null,lastAt:null,updatedAt:Date.now(),configured:true,summary};
        n.channels.push(c);return ok({channel:c},201);
      }
      if (/^\/api\/notify\/channels\/[^/]+(\/test)?$/.test(path)) {
        const n=notifyState(state),id=decodeURIComponent(path.split('/')[4]),c=n.channels.find(x=>x.id===id); if(!c)return fail('not_found',404);
        if (path.endsWith('/test') && method === 'POST') { assert.equal(body.confirm,true); const at=Date.now(); c.lastOutcome='sent'; c.lastAt=at; (state.notifyTests??=[]).push(id); n.deliveries.unshift({id:'delivery-'+(state.nextId++),at,source:'test',channelName:c.name,title:'Open Alert notification test',outcome:'sent',code:null}); return ok({outcome:'sent',at}); }
        if (method === 'PATCH') { (state.notifyPatches??=[]).push(body); if(body.expectedGeneration!==c.generation)return fail('generation_conflict'); if(body.name!==undefined)c.name=body.name; if(body.enabled!==undefined)c.enabled=body.enabled; c.generation++; return ok({channel:c}); }
        if (method === 'DELETE') { n.channels=n.channels.filter(x=>x!==c); n.routes=n.routes.filter(r=>r.channelId!==id); return ok({deleted:true}); }
      }
      if (path === '/api/notify/routes' && method === 'PUT') { const n=notifyState(state);(state.notifyRoutePuts??=[]).push(body); n.routes=body.routes; return ok({routes:notifyView(state).routes}); }      if (path === '/api/favorites' && method === 'GET') return ok({favorites:state.favorites??=[]});
      if (path === '/api/favorites' && method === 'PUT') { (state.favoritePuts??=[]).push(body); state.favorites=body.favorites; return ok({favorites:state.favorites}); }
      if (path === '/api/anomaly/settings' && method === 'PATCH') {
        const a=anomalyState(state),{expectedGeneration,...patch}=body;(state.anomalyPatches??=[]).push(body);
        if(expectedGeneration!==a.generation)return fail('generation_conflict',409);
        if(patch.enabled&&!state.status.channel.userKeyPresent)return fail('channel_unconfigured',409);
        a.settings={...a.settings,...patch};if(patch.notification)a.settings.priority=Math.max(-1,patch.notification.priority);a.generation++;return ok(anomalyView(state));
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
      if (path === '/api/admin/observability' && method === 'GET') return ok(state.observability);
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
// Mock anomaly monitor: one cross-venue stock event and one crypto event.
function anomalyState(state) {
  if (!state.anomaly) {
    const at=Date.now()-36e5, okx=state.markets[0]?.instrument ?? 'okx:BTC/USDT:USDT';
    state.anomaly={generation:0,settings:{enabled:false,crypto:true,tradfi:true,minMoveCrypto:0.25,minMoveTradfi:0.03,priority:1,dailyLimit:10,notification:null},events:[
      {id:'ev-1',groupId:'g-1',at,entity:'tradfi:SKHYNIX',label:'SK Hynix',category:'tradfi',direction:'down',window:'1h',session:'weekend',move:-0.071,relativeMove:-0.071,z:-5.2,volumeMultiple:8.4,marketCap:null,venues:[{venue:'binance',instrument:okx,symbol:'SKHYNIXUSDT',move:-0.071},{venue:'okx',instrument:okx,symbol:'SKHYNIX-USDT-SWAP',move:-0.069}]},
      {id:'ev-2',groupId:'g-2',at:at-864e5,entity:'crypto:quack-ai',label:'Q',category:'crypto',direction:'up',window:'24h',session:'all',move:1.306,relativeMove:1.29,z:9.1,volumeMultiple:21.3,marketCap:262e6,venues:[{venue:'mexc',instrument:okx,symbol:'Q_USDT',move:1.306}]}]};
  }
  return state.anomaly;
}
function notifyState(state) {
  state.notify??={channels:[{id:'legacy-pushover:u',type:'pushover',name:'Pushover',enabled:true,legacy:false,generation:0,lastOutcome:null,lastCode:null,lastAt:null,updatedAt:Date.now(),configured:true,summary:{tokenSource:'shared',userKey:'…abcd'}}],routes:['price_alert','anomaly_crypto','anomaly_tradfi'].map(source=>({source,channelId:'legacy-pushover:u',enabled:true,options:{notification:null,quiet:null,dailyLimit:10}})),deliveries:[]};
  if (state.notify.channels[0]) state.notify.channels[0].configured=!!state.status.channel.userKeyPresent;
  return state.notify;
}
function accountView(state) {
  const channels=notifyState(state).channels.length,favorites=state.favorites?.length??0;
  return {
    user: structuredClone(state.status.user),
    access: {
      plan: 'pro', phase: 'invite_beta', source: 'beta_policy', policyVersion: 1,
      billing: 'not_enabled', expiresAt: null,
      features: {price_alerts:true,anomaly_crypto:true,anomaly_tradfi:true,native_charts:true,drawing_tools:true,market_favorites:true,notification_channels:true},
      limits: {alerts:20,instruments:8,channels:10,favorites:50,priceAttemptsPerDay:state.status.settings.dailyLimit},
    },
    usage: {
      observedAt:Date.now(),utcDate:state.status.daily.date,alerts:state.alerts.length,
      activeAlerts:state.alerts.filter(alert=>alert.enabled&&!alert.triggered).length,
      instruments:new Set(state.alerts.map(alert=>alert.instrument)).size,
      channels,favorites,priceAttempts:state.status.daily.attempts,
    },
  };
}
function notifyView(state) { const n=notifyState(state); return {channels:n.channels,routes:n.routes,types:['pushover','discord'],profiles:{price_alert:{priority:2,retry:30,expire:1500,sound:'siren'},anomaly_crypto:{priority:1,retry:30,expire:1500,sound:'cosmic'},anomaly_tradfi:{priority:1,retry:30,expire:1500,sound:'cosmic'}}}; }function anomalyView(state) {
  const a=anomalyState(state);
  return {settings:a.settings,generation:a.generation,events:a.events,today:1,channelConfigured:!!state.status.channel.userKeyPresent,monitor:{state:'running',series:291,baselines:291,crypto:180,tradfi:111,withMarketCap:170,streams:{binance:true,okx:true,mexc:true},lastEvaluationAt:Date.now(),universeAt:Date.now(),marketCapAt:Date.now()}};
}
const nav = async (page, name) => {
 const href = ({'行情与警报':'/dashboard','Markets & alerts':'/dashboard','Markets':'/dashboard','异动监测':'/anomaly','Anomaly monitor':'/anomaly','手机通知':'/notifications','Notifications':'/notifications','设置':'/settings','Settings':'/settings','我的账户':'/settings','Account':'/settings','管理':'/admin','Alerts':'/alerts'})[name];
 const link=page.locator('nav:visible a[href="'+href+'"]');
 if (await link.count()) return link.click();
 await page.locator('nav:visible a[href="/settings"]').click();
 await page.locator('.mobile-admin-link').click();
};
async function accountControls(page) {
 if (await page.locator('.account-preferences:visible').count()) return;
 const chip=page.locator('.account-chip:visible');
 if (await chip.count()) { await chip.click(); return; }
 await nav(page, '设置');
}
async function languageChoice(page,language) {
 const previous = new URL(page.url()).pathname;
 if (!await page.getByRole('button',{name:language,exact:true}).isVisible()) await accountControls(page);
 await page.getByRole('button',{name:language,exact:true}).click();
 if (await page.locator('.account-menu:visible').count()) { await page.keyboard.press('Escape'); await expect(page.locator('.account-menu')).toHaveCount(0); }
 const names={'/dashboard':'Markets & alerts','/notifications':'Notifications','/settings':'Settings','/account':'Settings','/admin':'管理','/alerts':'Alerts'};
 if (new URL(page.url()).pathname !== previous && names[previous]) await nav(page,names[previous]);
}

async function signOut(page) { await accountControls(page); await page.getByRole('button',{name:'退出登录',exact:true}).click(); }

const row = (page, name) => page.locator('.alert-row').filter({ has: page.getByText(name, { exact: true }) });
const requests = (state, method, path) => state.requests.filter(r => r.method === method && r.path === path);
const sourceSelect = page => page.getByRole('combobox',{name:'行情来源',exact:true});
const sourceLabel = (market,currentBase=market.base) => {
  const canonical=/^(binance|okx|mexc):(spot|swap):/.exec(market.instrument);
  const venue=market.venue??canonical?.[1]??(/^[A-Z0-9]{1,24}-USDT-SWAP$/.test(market.instrument)?'okx':null);
  const type=market.type??canonical?.[2]??'swap';
  const name=venue==='binance'?'Binance':venue?.toUpperCase();
  return `${name} · ${type==='spot'?'现货':'USDT 永续'}${market.base!==currentBase?` · ${market.base}`:''}`;
};
const businessRequests = state => state.requests.filter(r=>!r.path.startsWith('/api/auth/') && r.path!=='/api/auth-capabilities' && r.path!=='/api/public-quotes');
// A paused virtual clock also freezes the session SDK's first timer, so a fresh document needs one virtual tick to boot.
const tick = page => page.clock.runFor(1);
async function settleBootClock(page) {
  for (let step = 0; step < 16 && await page.locator('[data-slot="boot-stage"]').count(); step++)
    await page.clock.runFor(250);
  await expect(page.locator('[data-slot="boot-stage"]')).toHaveCount(0);
}
async function noOverflow(page) { await check('mobile horizontal overflow', async () => { const size = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: innerWidth })); assert(size.scroll <= size.width+1, JSON.stringify(size)); }); }
async function refreshNavigation(page) { await page.reload(); await expect(page.getByRole('switch', { name: '监控总开关' })).toBeVisible(); }
export { setup, server, origin, runtimeErrors, violations, nav, accountControls };
if (process.env.OPEN_ALERT_FIXTURE_SERVER_ONLY !== '1') {
let browser, timedOut = false;
// Every fresh document boots behind the entrance curtain until its logo is fully
// formed and any view-handshake claims settle. The guard only needs to catch hangs.
const deadline = setTimeout(() => { timedOut = true; process.exitCode = 1; console.error('MOCK 420 second deadline exceeded'); void browser?.close(); server.closeAllConnections(); server.close(); }, 420000);
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
    await check('reload session persists', () => expect(page.getByRole('heading', { name: '行情与警报',exact:true })).toBeVisible());
    await check('no browser token storage', async () => assert.deepEqual(await page.evaluate(() => [Object.keys(localStorage).filter(k => k !== 'open-alert-chart'), Object.keys(sessionStorage)]), [[],[]]));
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
    await check('notification rewrite has exactly three sections and no legacy forms',async()=>{
      await expect(page.locator('.notify-panel')).toHaveCount(3);
      await expect(page.getByRole('heading',{name:'通知渠道',exact:true})).toBeVisible();
      await expect(page.getByRole('heading',{name:'推送规则',exact:true})).toBeVisible();
      await expect(page.getByRole('heading',{name:'发送记录',exact:true})).toBeVisible();
      await expect(page.getByRole('button',{name:'保存通知渠道',exact:true})).toHaveCount(0);
      await expect(page.getByRole('button',{name:'保存提醒设置',exact:true})).toHaveCount(0);
    });
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
    await check('edit generation sent', async () => await expect.poll(() => requests(state,'PATCH','/api/alerts/mock-created-1').at(-1)?.expectedGeneration).toBe(0));
    await row(page,'MOCK 已编辑').getByRole('button', {name:'删除',exact:true}).click(); await page.getByRole('dialog').getByRole('button',{name:'取消',exact:true}).click();
    await check('cancel delete no request', async () => assert.equal(requests(state,'DELETE','/api/alerts/mock-created-1').length,0));
    await row(page,'MOCK 已编辑').getByRole('button',{name:'删除',exact:true}).click(); await page.getByRole('dialog').getByRole('button',{name:'删除警报',exact:true}).click();
    await check('deleted row gone', () => expect(row(page,'MOCK 已编辑')).toHaveCount(0));
    await check('delete generation sent', async () => assert.equal(requests(state,'DELETE','/api/alerts/mock-created-1').at(-1).expectedGeneration,1));
  });
  await journey('03b asset picker, dashboard source FieldSelect, disabled sources and focus return', async () => {
    if (!await page.getByRole('switch').count()) {
      await page.goto(origin+'/login');
      await page.getByLabel('邮箱地址').fill('mock@example.test');
      await page.getByRole('button',{name:'发送验证码',exact:true}).click();
      await page.getByLabel('邮件中的验证码').fill('123456');
      await page.getByRole('button',{name:'验证并继续',exact:true}).click();
      await expect(page.getByRole('switch')).toBeVisible();
    }
    const originalMarkets=state.markets,originalAlerts=structuredClone(state.alerts),originalPrices=structuredClone(state.status.prices);
    const template=originalMarkets[0];
    const binanceSwap={...template,instrument:'binance:swap:BTCUSDT',venue:'binance',type:'swap',nativeId:'BTCUSDT',symbol:'BTC/USDT:USDT',settle:'USDT',tradingViewSymbol:'BINANCE:BTCUSDT.P'};
    const binanceSpot={...template,instrument:'binance:spot:BTCUSDT',venue:'binance',type:'spot',nativeId:'BTCUSDT',symbol:'BTC/USDT',settle:null,tradingViewSymbol:'BINANCE:BTCUSDT'};
    const unavailableMexc={...template,instrument:'mexc:swap:BTC_USDT',venue:'mexc',type:'swap',nativeId:'BTC_USDT',symbol:'BTC/USDT:USDT',available:false};
    state.markets=[...originalMarkets,binanceSwap,binanceSpot,unavailableMexc,
      ...Array.from({length:45},(_,i)=>({...template,instrument:`binance:spot:ASSET${i}USDT`,venue:'binance',type:'spot',nativeId:`ASSET${i}USDT`,base:`ASSET${i}`,symbol:`ASSET${i}/USDT`,settle:null,tradingViewSymbol:undefined}))];
    await refreshNavigation(page);
    const trigger=page.getByRole('combobox',{name:'查看市场',exact:true}),source=sourceSelect(page);
    const originalSelection=await trigger.textContent();
    await check('legacy OKX selection renders its canonical source without resetting the quote',async()=>{
      const legacy=originalMarkets.find(market=>market.instrument==='BTC-USDT-SWAP');
      await expect(source).toContainText(sourceLabel(legacy));
      await expect.poll(()=>requests(state,'GET','/api/quote').at(-1)?.instrument).toBe('BTC-USDT-SWAP');
      await expect(page.locator('.price-block')).toContainText(/后台参考成交|报价更新暂停/);
    });
    await check('source FieldSelect stays visible below the closed asset picker',async()=>{
      await expect(source).toBeVisible();await expect(trigger).toHaveAttribute('aria-expanded','false');
      assert.equal(await source.evaluate(node=>node.closest('[data-slot="popover-content"]')===null),true);
      const assetBox=await trigger.boundingBox(),sourceBox=await source.boundingBox();
      assert(assetBox&&sourceBox);assert(sourceBox.y>=assetBox.y+assetBox.height-1,JSON.stringify({assetBox,sourceBox}));
      assert(Math.abs(sourceBox.x-assetBox.x)<2,JSON.stringify({assetBox,sourceBox}));
      assert(sourceBox.height>=44&&sourceBox.height<=45,`desktop source height ${sourceBox.height}`);
      assert.equal(await source.getAttribute('title'),null);
    });
    await trigger.click();
    const search=page.getByRole('combobox',{name:'搜索市场',exact:true});
    await check('search auto-focus',()=>expect(search).toBeFocused());
    await check('bounded asset results',()=>expect(page.locator('[cmdk-item]')).toHaveCount(40));
    await search.fill('BTC');
    await chooseSelect(page,'交易所','binance');await chooseSelect(page,'市场类型','swap');
    const filteredBtc=page.locator('[cmdk-item][data-asset="BTC"]');
    await check('asset filters retain one aggregated asset row',async()=>{
      await expect(page.locator('[cmdk-item]')).toHaveCount(1);
      await expect(filteredBtc.locator('.market-venue-summary')).toContainText('Binance');
    });
    await check('filters preserve selected asset',()=>expect(trigger).toHaveText(originalSelection));
    await search.focus();await page.keyboard.press('ArrowDown');await page.keyboard.press('Enter');
    await check('asset keyboard selection keeps a symbol-only trigger',async()=>{
      await expect(trigger).toContainText('BTC / USDT');assert.doesNotMatch(await trigger.innerText(),/Binance|OKX|MEXC/);
    });
    await check('default Binance perpetual is selected as the exact source',()=>expect(source).toContainText(sourceLabel(binanceSwap)));
    await check('selection closes picker and returns focus',()=>expect(trigger).toBeFocused());
    await source.focus();await page.keyboard.press('Enter');
    await check('source options are keyboard reachable with exact labels',async()=>{
      await expect(page.getByRole('option',{name:sourceLabel(binanceSwap)})).toHaveAttribute('data-state','checked');
      await expect(page.getByRole('option')).toHaveCount(4);
    });
    await page.keyboard.press('Escape');await check('source Escape returns its own focus',()=>expect(source).toBeFocused());
    await chooseSelect(page,'行情来源','BTC-USDT-SWAP');
    await check('source changes to exact OKX perpetual identity',()=>expect(source).toContainText('OKX · USDT 永续'));
    await chooseSelect(page,'行情来源','binance:spot:BTCUSDT');
    await check('source changes to exact Binance spot identity',()=>expect(source).toContainText(sourceLabel(binanceSpot)));
    await source.click();
    await check('unavailable source remains listed but disabled',async()=>{
      await expect(page.getByRole('option',{name:sourceLabel(unavailableMexc)})).toBeDisabled();
      await expect(page.getByRole('option')).toHaveCount(4);
    });
    await page.keyboard.press('Escape');
    await trigger.click();await chooseSelect(page,'交易所','all');await chooseSelect(page,'市场类型','all');await search.fill('BTC');
    const btc=page.locator('[cmdk-item][data-asset="BTC"]');
    await check('asset row aggregates read-only venue names',async()=>{
      await expect(page.locator('[cmdk-item]')).toHaveCount(1);
      await expect(btc.locator('.market-venue-summary')).toContainText('Binance');
      await expect(btc.locator('.market-venue-summary')).toContainText('MEXC');
    });
    await page.waitForTimeout(250);await page.screenshot({path:join(outputs,'market-source-assets-MOCK.png')});
    await btc.getByRole('button',{name:'收藏 BTC',exact:true}).click();
    await check('star in the asset list saves the whole asset',async()=>expect.poll(()=>state.favoritePuts?.at(-1)?.favorites).toEqual([{base:'BTC',preferred:'binance:swap:BTCUSDT'}]));
    await search.fill('');
    await check('starred assets lead the list',async()=>{await expect(page.locator('[cmdk-group-heading]').first()).toHaveText('收藏');await expect(page.locator('[cmdk-item]').first()).toHaveAttribute('data-asset','BTC');});
    await btc.getByRole('button',{name:'取消收藏 BTC',exact:true}).click();
    await check('unstar removes the asset',async()=>expect.poll(()=>state.favoritePuts?.at(-1)?.favorites).toEqual([]));
    await search.fill('NO_MATCH_123');await check('empty results provide recovery',()=>expect(page.getByText('没有匹配的市场。试试币种名称，或清除交易所和类型筛选。')).toBeVisible());
    await page.keyboard.press('Escape');await check('Escape returns asset trigger focus',()=>expect(trigger).toBeFocused());
    await trigger.click();await search.fill('ETH');await page.locator('[cmdk-item][data-asset="ETH"] .market-result-symbol').click();
    await check('asset without Binance falls back to its available source',async()=>{
      await expect(trigger).toContainText('ETH / USDT');await expect(source).toContainText('OKX · USDT 永续');
    });
    await trigger.click();await search.fill('BTC');await page.locator('[cmdk-item][data-asset="BTC"] .market-result-symbol').click();
    const statusBefore=requests(state,'GET','/api/status').length;
    await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
    await expect.poll(()=>requests(state,'GET','/api/status').length).toBeGreaterThan(statusBefore);
    await check('source and asset selection stay stable through a rerender',async()=>{
      await expect(trigger).toContainText('BTC / USDT');await expect(source).toContainText(sourceLabel(binanceSwap));
      await expect(source).toBeVisible();assert.equal(await source.evaluate(node=>node.closest('[data-slot="popover-content"]')===null),true);
    });
    await page.getByRole('button',{name:'创建警报',exact:true}).click();
    const dialog=page.getByRole('dialog',{name:'创建价格警报'});
    await dialog.getByRole('combobox',{name:'警报市场'}).click();
    await page.getByRole('combobox',{name:'搜索市场',exact:true}).fill('BTC');
    await check('AlertEditor keeps exact venue chips and current source selection',async()=>{
      const venue=page.locator('.ui-market-popover .market-venue[data-instrument="binance:swap:BTCUSDT"]');
      await expect(venue).toHaveCount(1);await expect(venue).toHaveAttribute('aria-pressed','true');
      assert((await page.locator('.ui-market-popover .market-venue').count())>1);
    });
    await page.keyboard.press('Escape');await expect(page.locator('.ui-market-popover')).toHaveCount(0);await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');await expect(dialog).toHaveCount(0);
    state.markets=[binanceSpot];
    state.alerts=originalAlerts.map(alert=>({...alert,instrument:binanceSpot.instrument}));
    state.status.prices=originalPrices.map(price=>({...price,instrument:binanceSpot.instrument}));
    await refreshNavigation(page);
    await check('a single available venue still exposes an enabled source selector',async()=>{
      await expect(source).toBeEnabled();await expect(source).toContainText(sourceLabel(binanceSpot));
    });
    state.markets=originalMarkets;state.alerts=originalAlerts.map(alert=>structuredClone(alert));state.status.prices=originalPrices;
    await refreshNavigation(page);
    await page.getByRole('button',{name:'创建警报',exact:true}).click();
    await page.getByRole('dialog').getByLabel('警报名称').focus();await page.keyboard.press('Shift+Tab');
    await check('modal Tab remains trapped',async()=>assert(await page.getByRole('dialog').evaluate(d=>d.contains(document.activeElement))));
    await page.keyboard.press('Escape');await check('modal closing restores creating button',()=>expect(page.getByRole('button',{name:'创建警报',exact:true})).toBeFocused());
    chart = await page.locator('iframe').elementHandle();
  });
  for (const scenario of [
    {name:'desktop-light',profile:'desktop',theme:'light',width:1440},
    {name:'desktop-dark',profile:'desktop',theme:'dark',width:1440},
    {name:'mobile-light',profile:'mobile',theme:'light',width:390},
    {name:'mobile-dark',profile:'mobile',theme:'dark',width:390},
    {name:'desktop-1100-light',profile:'desktop',theme:'light',width:1100},
    {name:'desktop-1100-dark',profile:'desktop',theme:'dark',width:1100},
  ]) await journey('03b source visual '+scenario.name,async()=>{
    const fixture=await setup(browser,scenario.profile,true,{colorScheme:scenario.theme,reducedMotion:'reduce',chart:'tradingview'}),p=fixture.page,s=fixture.state;
    if(scenario.profile==='desktop')await p.setViewportSize({width:scenario.width,height:1000});
    const template=s.markets[0];
    s.markets=[...s.markets,
      {...template,instrument:'binance:swap:BTCUSDT',venue:'binance',type:'swap',nativeId:'BTCUSDT',symbol:'BTC/USDT:USDT',settle:'USDT',tradingViewSymbol:'BINANCE:BTCUSDT.P'},
      {...template,instrument:'binance:spot:BTCUSDT',venue:'binance',type:'spot',nativeId:'BTCUSDT',symbol:'BTC/USDT',settle:null,tradingViewSymbol:'BINANCE:BTCUSDT'},
      {...template,instrument:'mexc:swap:BTC_USDT',venue:'mexc',type:'swap',nativeId:'BTC_USDT',symbol:'BTC/USDT:USDT',available:false}];
    await p.goto(origin+'/dashboard');await expect(p.getByRole('switch')).toBeVisible();
    await expect(p.locator('[data-slot="boot-stage"]')).toHaveCount(0,{timeout:15000});
    await expect(p.locator('html')).toHaveAttribute('data-theme',scenario.theme);
    await chooseSelect(p,'行情来源','binance:swap:BTCUSDT');
    const source=sourceSelect(p),asset=p.getByRole('combobox',{name:'查看市场',exact:true});
    await check('source stays inside the 248px hero at '+scenario.name,async()=>{
      const hero=await p.locator('.signal-hero').boundingBox(),sourceBox=await source.boundingBox();
      assert(hero&&sourceBox);assert(sourceBox.y>=hero.y&&sourceBox.y+sourceBox.height<=hero.y+hero.height+1,JSON.stringify({hero,sourceBox}));
      if(scenario.width>900)assert(Math.abs(hero.height-248)<=1,`desktop hero height ${hero.height}`);
      const size=44;
      assert(sourceBox.height>=size-1&&sourceBox.height<=size+4,`source height ${sourceBox.height}`);
      const fits=await source.evaluate(node=>({client:node.clientHeight,scroll:node.scrollHeight,text:[...node.querySelectorAll('span')].every(child=>child.getBoundingClientRect().bottom<=node.getBoundingClientRect().bottom+1)}));
      assert(fits.client+1>=fits.scroll&&fits.text,JSON.stringify(fits));
      await noOverflow(p);
    });
    await check('new source UI uses 11px-or-larger handoff type and no decorative animation at '+scenario.name,async()=>{
      const fonts=await p.locator('.signal-hero').evaluate(root=>[
        root.querySelector('.market-search-trigger'),root.querySelector('.market-search-selection strong'),
        root.querySelector('.market-source-selector .ui-field-select'),
      ].map(node=>node?parseFloat(getComputedStyle(node).fontSize):0));
      assert(fonts.every(size=>size>=11),JSON.stringify(fonts));
      const animation=await source.evaluate(node=>getComputedStyle(node).animationName);
      assert.equal(animation,'none');
      await expect(p.locator('.route-surface')).toHaveAttribute('data-motion-state','settled');
    });
    await p.evaluate(()=>document.fonts.ready);await p.waitForTimeout(80);
    await p.screenshot({path:join(outputs,`source-ui-${scenario.name}-closed-MOCK.png`),fullPage:true,animations:'disabled'});
    await source.click();
    await check('source options expose every exact venue without help text at '+scenario.name,async()=>{
      await expect(p.getByRole('option')).toHaveCount(4);
      await expect(p.getByRole('option',{name:sourceLabel(s.markets.find(m=>m.instrument==='mexc:swap:BTC_USDT'))})).toBeDisabled();
      assert.equal(await p.locator('.market-source-selector [title]').count(),0);
    });
    await p.screenshot({path:join(outputs,`source-ui-${scenario.name}-source-open-MOCK.png`),fullPage:true,animations:'disabled'});
    await p.keyboard.press('Escape');
    await asset.click();await p.getByRole('combobox',{name:'搜索市场',exact:true}).fill('BTC');
    await p.screenshot({path:join(outputs,`source-ui-${scenario.name}-assets-open-MOCK.png`),fullPage:true,animations:'disabled'});
    await fixture.context.close();
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
    await check('explicit rearm clears latch while monitoring stays paused', async () => { await expect(row(page,'MOCK 投递不确定')).toContainText('总开关关闭'); assert.equal(state.alerts.find(a=>a.id==='mock-uncertain').triggered,false); await expect(row(page,'MOCK 投递不确定').getByRole('button',{name:'重新武装',exact:true})).toHaveCount(0); });
    await check('rearm generation sent', async () => assert.equal(requests(state,'POST','/api/alerts/mock-uncertain/rearm').at(-1).expectedGeneration,2));
    await check('CRUD preserves chart', async () => assert(await chart.evaluate(node => node.isConnected)));
  });
  await journey('05 normal channel editing, retention and explicit notification-centre test confirmation', async () => {
    await nav(page,'手机通知');
    const list=page.getByRole('list',{name:'通知渠道'});
    const initial=list.getByRole('listitem').filter({hasText:'Pushover'});
    await check('migrated channel is normal and deletable',async()=>{await expect(initial).toHaveCount(1);await expect(initial.getByRole('button',{name:'编辑'})).toBeVisible();await expect(initial.getByRole('button',{name:'删除'})).toBeVisible();});
    await initial.getByRole('button',{name:'编辑'}).click();
    const dialog=page.getByRole('dialog');
    await check('channel edit uses the new dialog',()=>expect(dialog.getByRole('heading',{name:'编辑通知渠道'})).toBeVisible());
    await dialog.getByLabel('名称').fill('主手机');await dialog.getByRole('button',{name:'保存渠道'}).click();
    await expect(page.locator('[data-sonner-toast]').filter({hasText:'通知渠道已保存。未发送测试通知。'})).toBeVisible();
    const editRequest=state.requests.filter(r=>r.method==='PATCH'&&r.path.startsWith('/api/notify/channels/')).at(-1);
    await check('edit sends the current generation and no blank config',async()=>{assert.deepEqual(editRequest.fields,['expectedGeneration','name']);assert.equal(editRequest.expectedGeneration,0);assert.equal(state.notify.channels[0].name,'主手机');});
    await check('channel save sends no notification test',async()=>assert.equal(state.requests.filter(r=>r.method==='POST'&&r.path.endsWith('/test')).length,0));
    await check('no reflected raw secrets or legacy form',async()=>{const text=await page.locator('body').innerText();assert(!text.includes(key)&&!text.includes(token));await expect(page.getByRole('button',{name:'保存通知渠道',exact:true})).toHaveCount(0);});
    const primary=list.getByRole('listitem').filter({hasText:'主手机'});
    await primary.getByRole('button',{name:'测试'}).click();await dialog.getByRole('button',{name:'取消',exact:true}).click();
    await check('cancel sends no notification-centre test',async()=>assert.equal(state.requests.filter(r=>r.method==='POST'&&r.path.endsWith('/test')).length,0));
    state.failNext={path:'/api/notify/channels/legacy-pushover%3Au/test',method:'POST',code:'notification_uncertain',status:504};
    await primary.getByRole('button',{name:'测试'}).click();await dialog.getByRole('button',{name:'确认发送测试'}).click();
    await check('notification-centre uncertainty is explicit',()=>expect(dialog.getByRole('alert')).toContainText('可能已经送达'));
    await check('test uses a deliberate confirmation body',async()=>assert.equal(state.requests.filter(r=>r.method==='POST'&&r.path.endsWith('/test')).at(-1).confirm,true));
    await dialog.getByRole('button',{name:'取消',exact:true}).click();
    await primary.getByRole('button',{name:'测试'}).click();await dialog.getByRole('button',{name:'确认发送测试'}).click();
    await check('confirmed notification-centre test succeeds and is logged',async()=>{await expect(page.locator('[data-sonner-toast]').filter({hasText:'测试通知已发到 主手机'})).toBeVisible();await expect(page.getByRole('heading',{name:'发送记录'})).toBeVisible();await expect(page.locator('.notify-delivery-list')).toContainText('Open Alert notification test');});
  });
  await journey('06 notification-centre request cooldown, monitoring busy lock and stop confirmation', async () => {
    // Keep the cooldown on a real center mutation. A blocked POST is never queued or replayed.
    await page.emulateMedia({reducedMotion:'reduce'});
    await page.clock.install(); await page.clock.pauseAt(new Date());
    const channel=state.notify.channels.find(c=>c.name==='主手机');
    const testPath=`/api/notify/channels/${encodeURIComponent(channel.id)}/test`;
    state.failNext={path:testPath,method:'POST',code:'rate_limited',status:429,headers:{'Retry-After':'10'}};
    const businessCount = () => state.requests.filter(r=>!r.path.startsWith('/api/auth/') && r.path!=='/api/auth-capabilities' && r.path!=='/api/public-quotes').length;
    const countBefore429 = businessCount();
    const primary=page.getByRole('list',{name:'通知渠道'}).getByRole('listitem').filter({hasText:'主手机'});
    await primary.getByRole('button',{name:'测试'}).click(); await page.getByRole('dialog').getByRole('button',{name:'确认发送测试'}).click();
    await check('center 429 retry shown', () => expect(page.getByRole('dialog').getByRole('alert')).toContainText('重试等待：10'));
    await check('center 429 sends no immediate refresh', async () => assert.equal(businessCount(),countBefore429+1));
    const blockedCount = businessCount(), testsBeforeWait = state.requests.filter(r=>r.method==='POST'&&r.path===testPath).length;
    await page.getByRole('dialog').getByRole('button',{name:'确认发送测试'}).click();
    await page.keyboard.press('Escape');
    await page.locator('.connection-error').getByRole('button',{name:'重新读取状态'}).click();
    await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
    await page.clock.runFor(9000);
    await check('shared wait blocks manual/visibility/timers/mutation: zero requests', async () => assert.equal(businessCount(),blockedCount));
    await check('remaining wait uses existing model clock', () => expect(page.locator('.connection-error')).toContainText('重试等待：1 秒'));
    await page.clock.runFor(1000);
    await check('expiry automatically restores exactly one combined snapshot', async () => { await expect(page.locator('.connection-error')).toHaveCount(0); assert.equal(businessCount(),blockedCount+1); });
    await check('expiry never automatically replays center test POST', async () => assert.equal(state.requests.filter(r=>r.method==='POST'&&r.path===testPath).length,testsBeforeWait));
    await primary.getByRole('button',{name:'测试'}).click();
    await page.getByRole('dialog').getByRole('button',{name:'确认发送测试'}).click();
    await check('expired center POST requires explicit manual retry', () => expect(page.locator('[data-sonner-toast]').filter({hasText:'测试通知已发到 主手机'})).toBeVisible());
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
        await languageChoice(p,'EN');
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
    await signOut(page); await expect(page.getByRole('heading',{name:'登录或注册'})).toBeVisible(); release();
    await check('logout cookie removed', async () => assert(!(await context.cookies(origin)).some(c=>c.name===cookieName)));
    await check('late workspace cannot show user', () => expect(page.locator('.session-email')).toHaveCount(0));
    await page.reload(); await check('reload remains logged out', () => expect(page.getByRole('heading',{name:'登录或注册'})).toBeVisible());
    await context.close();
  });
  const mobile=await setup(browser,'mobile',true), m=mobile.page;
  await journey('09 390×844 mobile layout, modal focus, navigation and MOCK capture', async () => {
    await m.goto(origin+'/dashboard'); await expect(m.getByRole('switch')).toBeVisible(); await m.getByRole('button',{name:'参考图表 · TradingView'}).click(); await expect(m.locator('iframe')).toBeVisible();
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
  for (const profile of ['desktop','mobile']) await journey('09a settings overview, Pro beta access and guarded admin ('+profile+')',async()=>{
    const member=await setup(browser,profile,true),p=member.page;
    await p.goto(origin+'/settings');
    await expect(p.locator('[data-slot="boot-stage"]')).toHaveCount(0,{timeout:15000});
    await expect(p.getByRole('heading',{name:'设置',level:1})).toBeVisible();
    await check('settings is canonical in desktop and mobile navigation',async()=>{
      await expect(p.getByRole('heading',{name:'账户信息',level:2})).toBeVisible();
      const link=p.locator('nav:visible a[href="/settings"]');
      await expect(link).toHaveText(/设置/);await expect(link).toHaveAttribute('aria-current','page');
      assert.equal(requests(member.state,'GET','/api/account').length,1);
    });
    const access=p.locator('.settings-access');
    await check('normal member receives Pro invite-beta access',async()=>{
      await expect(access.locator('.settings-beta-badge')).toHaveText('Pro · 邀请测试版');
      await expect(access.locator('.settings-usage > div')).toHaveCount(5);
      await expect(access.locator('.settings-usage')).toContainText('3 / 20');
      await expect(access.locator('.settings-usage')).toContainText('1 / 8');
      await expect(access.locator('.settings-usage')).toContainText('1 / 10');
      await expect(access.locator('.settings-usage')).toContainText('0 / 50');
      await expect(access.locator('.settings-usage')).toContainText('0 / 20');
    });
    await check('account keeps identity, raw usage and preferences without added explanation chrome',async()=>{
      await expect(p.locator('.settings-identity')).toContainText('mock@example.test');
      await expect(p.locator('.settings-preferences').getByRole('group',{name:'外观主题'})).toBeVisible();
      assert.equal(await p.locator('.settings-beta-copy,.settings-features,.settings-updated,.settings-shortcuts,.settings-feedback').count(),0);
      for(const text of [
        '邀请测试期间，所有成员均可使用完整 Pro 功能，当前不收费。本轮测试未设置到期时间。',
        '1 条规则已启用','按交易所与市场类型分别计数','在通知中心管理','跨交易所的标的收藏',
        '含失败与重试，按 UTC 零点重置','异动通知的每日上限分别在通知中心设置。测试期间的容量上限用于控制服务负载。',
        '警报、收藏和通知渠道仅属于当前账户。','外观和语言保存在当前浏览器中。',
        '工作区设置','一起完善测试版','遇到问题或有功能建议，可以整理后发给邀请你的人。','复制反馈模板',
      ]) assert.equal(await p.getByText(text,{exact:true}).count(),0,text);
    });
    await check('no billing or upgrade controls',async()=>{
      const control=/升级|购买|订阅|付费方案|billing|upgrade|subscribe|manage plan/i;
      assert.equal(await p.getByRole('button',{name:control}).count(),0);
      assert.equal(await p.getByRole('link',{name:control}).count(),0);
    });
    await check('member settings has no hidden runtime or bootstrap panel',async()=>{
      assert.equal(await p.locator('.runtime-panel,.admin-runtime,.settings-bootstrap').count(),0);
      assert.equal(await p.getByRole('heading',{name:'后台运行状态',exact:true}).count(),0);
      assert.equal(await p.getByRole('heading',{name:'设置初始管理员',exact:true}).count(),0);
      assert.equal(await p.getByRole('button',{name:/进入管理台/}).count(),0);
      assert.equal(await p.getByRole('navigation').getByRole('link',{name:'管理',exact:true}).count(),0);
    });
    if(profile==='mobile')await noOverflow(p);
    await p.evaluate(()=>document.fonts.ready);await p.waitForTimeout(80);
    await p.emulateMedia({colorScheme:'light'});await expect(p.locator('html')).toHaveAttribute('data-theme','light',{timeout:20000});
    await p.screenshot({path:join(outputs,`open-alert-settings-${profile}-member-light-MOCK.png`),fullPage:true,animations:'disabled'});
    await p.emulateMedia({colorScheme:'dark'});await expect(p.locator('html')).toHaveAttribute('data-theme','dark',{timeout:20000});
    await p.screenshot({path:join(outputs,`open-alert-settings-${profile}-member-dark-MOCK.png`),fullPage:true,animations:'disabled'});
    await languageChoice(p,'EN');
    await check('English navigation and account heading use Settings naming',async()=>{
      await expect(p.getByRole('heading',{name:'Settings',level:1})).toBeVisible();
      await expect(p.getByRole('heading',{name:'Account details',level:2})).toBeVisible();
      await expect(p.locator('nav:visible a[href="/settings"]')).toHaveText(/Settings/);
      assert.equal(await p.getByRole('heading',{name:'Workspace settings',exact:true}).count(),0);
      assert.equal(await p.getByRole('button',{name:'Copy feedback template',exact:true}).count(),0);
    });
    await languageChoice(p,'中文');
    await nav(p,'手机通知');
    await expect(p).toHaveURL(origin+'/notifications');
    await nav(p,'设置');await expect(p.getByRole('heading',{name:'设置',level:1})).toBeVisible();
    const adminReads=member.state.requests.filter(r=>r.path.startsWith('/api/admin/')).length;
    await p.goto(origin+'/admin');
    await expect(p.getByText('此页面仅供管理员使用。')).toBeVisible();
    await check('member admin route stays guarded',async()=>assert.equal(member.state.requests.filter(r=>r.path.startsWith('/api/admin/')).length,adminReads));
    await p.goto(origin+'/account?setup=admin');
    await expect(p).toHaveURL(origin+'/settings?setup=admin');
    await check('legacy account redirect preserves query without deployment bootstrap UI',async()=>{
      await expect(p.getByRole('heading',{name:'设置',level:1})).toBeVisible();
      assert.equal(await p.locator('.settings-bootstrap').count(),0);
      assert.equal(await p.getByRole('heading',{name:'设置初始管理员',exact:true}).count(),0);
      assert.equal(await p.getByLabel('一次性引导令牌',{exact:true}).count(),0);
      assert.equal(await p.getByRole('button',{name:'设为初始管理员',exact:true}).count(),0);
    });
    await member.context.close();

    const admin=await setup(browser,profile,true);admin.state.status.user.role='admin';admin.state.status.capabilities.canAdmin=true;
    const a=admin.page;await a.goto(origin+'/settings');
    await expect(a.locator('[data-slot="boot-stage"]')).toHaveCount(0,{timeout:15000});
    await expect(a.getByRole('heading',{name:'设置',level:1})).toBeVisible();
    await check('administrator still receives normal Pro access and admin entry',async()=>{
      await expect(a.locator('.settings-beta-badge')).toHaveText('Pro · 邀请测试版');
      await expect(a.locator('.settings-identity')).toContainText('管理员');
      if(profile==='desktop')await expect(a.getByRole('navigation').getByRole('link',{name:'管理',exact:true})).toBeVisible();
      else await expect(a.getByRole('button',{name:/进入管理台/})).toBeVisible();
      assert.equal(await a.locator('.runtime-panel,.admin-runtime,.settings-bootstrap').count(),0);
    });
    if(profile==='mobile')await noOverflow(a);
    await a.emulateMedia({colorScheme:'light'});await expect(a.locator('html')).toHaveAttribute('data-theme','light',{timeout:20000});
    await a.screenshot({path:join(outputs,`open-alert-settings-${profile}-admin-light-MOCK.png`),fullPage:true,animations:'disabled'});
    await a.emulateMedia({colorScheme:'dark'});await expect(a.locator('html')).toHaveAttribute('data-theme','dark',{timeout:20000});
    await a.screenshot({path:join(outputs,`open-alert-settings-${profile}-admin-dark-MOCK.png`),fullPage:true,animations:'disabled'});
    if(profile==='desktop')await a.getByRole('navigation').getByRole('link',{name:'管理',exact:true}).click();
    else await a.getByRole('button',{name:/进入管理台/}).click();
    await expect(a).toHaveURL(origin+'/admin');
    await check('administrator runtime omits notification-provider and deployment chrome',async()=>{
      await expect(a.getByRole('heading',{name:'管理',level:1})).toBeVisible();
      const runtime=a.locator('.admin-runtime');
      await expect(runtime.getByRole('heading',{name:'后台运行状态'})).toBeVisible();
      assert.deepEqual(await runtime.locator('dt').allTextContents(),['数据库','后台监控','交易所行情','邮件服务']);
      assert.equal(await runtime.getByText('通知投递',{exact:true}).count(),0);
      assert.equal(await runtime.getByText('通知服务',{exact:true}).count(),0);
      assert.equal(await runtime.getByText('provider_not_checked',{exact:true}).count(),0);
      assert.equal(await runtime.locator('code').count(),0);
      assert.equal(await a.locator('.deployment-panel').count(),0);
      assert.equal(await a.getByRole('heading',{name:'部署配置',exact:true}).count(),0);
      assert.equal(await a.getByRole('button',{name:'查看部署配置说明',exact:true}).count(),0);
    });
    await admin.context.close();
  });
  for (const profile of ['desktop','mobile']) await journey('09b anomaly monitor settings, event feed and chart link ('+profile+')',async()=>{
    const fixture=await setup(browser,profile,true),p=fixture.page,s=fixture.state;
    await p.goto(origin+'/dashboard');await expect(p.getByRole('switch')).toBeVisible();
    await nav(p,'异动监测');
    await check('anomaly page heading',()=>expect(p.getByRole('heading',{name:'异动监测',level:1})).toBeVisible());
    await check('nav marks anomaly current',()=>expect(p.locator('nav:visible a[href="/anomaly"]')).toHaveAttribute('aria-current','page'));
    await check('event feed lists merged venues',()=>expect(p.locator('.anomaly-event').first().locator('.anomaly-event-venues a')).toHaveCount(2));
    await check('stock weekend session label',()=>expect(p.getByText('周末休市')).toBeVisible());
    if(profile==='mobile')await noOverflow(p);
    await p.screenshot({path:join(outputs,`open-alert-anomaly-${profile}-MOCK.png`),fullPage:true,animations:'disabled'});
    await p.getByRole('switch',{name:'异动推送'}).click();
    await check('enable sends CAS generation',async()=>expect.poll(()=>(s.anomalyPatches??[]).at(-1)).toEqual({expectedGeneration:0,enabled:true}));
    await check('enabled badge',()=>expect(p.locator('.page-heading .status-pill')).toHaveText('推送中'));
    await p.getByRole('switch',{name:'股票与 TradFi 合约'}).click();
    await check('stock toggle uses next generation',async()=>expect.poll(()=>(s.anomalyPatches??[]).at(-1)).toEqual({expectedGeneration:1,tradfi:false}));
    const crypto=p.getByLabel('币种最小涨跌 · %');await crypto.fill('5');await p.getByRole('button',{name:'保存过滤条件'}).click();
    await check('out-of-range floor rejected locally',async()=>{assert.equal(await crypto.evaluate(i=>i.validity.rangeUnderflow),true);assert.equal(requests(s,'PATCH','/api/anomaly/settings').length,2);});
    await crypto.fill('30');await p.getByRole('button',{name:'保存过滤条件'}).click();
    await check('floor saved as fraction without a page-level daily cap',async()=>{await expect.poll(()=>(s.anomalyPatches??[]).at(-1)).toEqual({expectedGeneration:2,minMoveCrypto:0.3,minMoveTradfi:0.03});await expect(p.getByLabel('每日推送上限')).toHaveCount(0);});
    await check('notification profiles stay in the route centre',async()=>{assert.equal(requests(s,'PATCH','/api/settings').length,0);assert.equal(s.anomalyPatches?.at(-1)?.notification,undefined);});
    await p.locator('.anomaly-event').first().locator('.anomaly-event-venues a').first().click();
    await check('venue link opens dashboard',()=>expect(p).toHaveURL(/\/dashboard\?market=/));
    await fixture.context.close();
  });
  for (const profile of ['desktop','mobile']) await journey('09c notification centre channels, routing and quiet hours ('+profile+')',async()=>{
    const fixture=await setup(browser,profile,true),p=fixture.page,s=fixture.state;
    await p.goto(origin+'/dashboard');await expect(p.getByRole('switch').first()).toBeVisible();
    await nav(p,'手机通知');
    const list=p.getByRole('list',{name:'通知渠道'});
    await check('legacy channel is normal and deletable',async()=>{await expect(list.getByRole('listitem')).toHaveCount(1);await expect(list.getByRole('button',{name:'删除'})).toHaveCount(1);});
    await check('all three rule cards are routable',async()=>{
      for(const source of ['价格警报','币种异动','股票异动']){
        const region=p.getByRole('region',{name:source});await expect(region).toBeVisible();await expect(region.getByRole('switch',{name:source+'发到 Pushover',exact:true})).toHaveCount(1);
      }
    });
    await check('three notification sections and no legacy forms',async()=>{
      await expect(p.locator('.notify-panel')).toHaveCount(3);
      await expect(p.getByRole('heading',{name:'通知渠道',exact:true})).toBeVisible();
      await expect(p.getByRole('heading',{name:'推送规则',exact:true})).toBeVisible();
      await expect(p.getByRole('heading',{name:'发送记录',exact:true})).toBeVisible();
      await expect(p.getByRole('button',{name:'保存通知渠道',exact:true})).toHaveCount(0);
      await expect(p.getByRole('button',{name:'保存提醒设置',exact:true})).toHaveCount(0);
    });
    await p.getByRole('button',{name:'添加渠道'}).click();
    const dialog=p.getByRole('dialog');
    await dialog.getByLabel('名称').fill('备用手机');await dialog.getByLabel('Pushover 用户密钥').fill('short');await dialog.getByRole('button',{name:'添加渠道'}).click();
    await check('invalid key rejected locally',async()=>{await expect(dialog.getByRole('alert')).toContainText('30 位');assert.equal((s.notifyPosts??[]).length,0);});
    await dialog.getByLabel('Pushover 用户密钥').fill('u'.repeat(30));await dialog.getByRole('button',{name:'添加渠道'}).click();
    await check('channel created without exposing key in evidence',async()=>{await expect(dialog).toHaveCount(0);assert.deepEqual(s.notifyPosts,[{type:'pushover',name:'备用手机',fields:['userKey','appToken']}]);});
    await check('new channel listed',()=>expect(list.getByRole('listitem')).toHaveCount(2));
    const priceRules=p.getByRole('region',{name:'价格警报'});
    await priceRules.getByLabel('每日上限').fill('7');
    await priceRules.getByRole('switch',{name:'价格警报发到 备用手机'}).click();
    await p.getByRole('switch',{name:'币种异动发到 备用手机'}).click();
    await p.getByRole('switch',{name:'股票异动免打扰'}).click();
    await p.getByRole('region',{name:'股票异动'}).getByLabel('开始').fill('22:30');
    await check('unsaved badge',()=>expect(p.getByText('未保存')).toBeVisible());
    if(profile==='mobile')await noOverflow(p);
    await p.screenshot({path:join(outputs,`open-alert-notify-center-${profile}-MOCK.png`),fullPage:true,animations:'disabled'});
    await p.getByRole('button',{name:'保存推送路由'}).click();
    await check('routes save all sources with per-route caps and quiet hours',async()=>{await expect.poll(()=>(s.notifyRoutePuts??[]).length).toBe(1);const r=s.notifyRoutePuts[0].routes;
      assert(r.some(x=>x.source==='anomaly_crypto'&&x.channelId.startsWith('ch-')&&x.enabled));
      assert(r.filter(x=>x.source==='price_alert').length===2);
      assert(r.filter(x=>x.source==='price_alert').every(x=>x.options.dailyLimit===7));
      const q=r.filter(x=>x.source==='anomaly_tradfi');assert(q.length===2&&q.every(x=>x.options.quiet?.from==='22:30'&&x.options.quiet.to==='07:00'&&Number.isInteger(x.options.quiet.offsetMinutes)));
      assert(r.every(x=>Number.isInteger(x.options.dailyLimit)&&x.options.dailyLimit>=1&&x.options.dailyLimit<=50));});
    const added=list.getByRole('listitem').filter({hasText:'备用手机'});
    await added.getByRole('button',{name:'测试'}).click();await p.getByRole('dialog').getByRole('button',{name:'确认发送测试'}).click();
    await check('test confirmed and recorded in delivery history',async()=>{await expect.poll(()=>(s.notifyTests??[]).length).toBe(1);await expect(added).toContainText('最近发送成功');await expect(p.locator('.notify-delivery-list')).toContainText('Open Alert notification test');});
    await added.getByRole('button',{name:'编辑'}).click();await p.getByRole('dialog').getByLabel('名称').fill('iPad');await p.getByRole('dialog').getByRole('button',{name:'保存渠道'}).click();
    await check('rename uses CAS generation',async()=>{await expect.poll(()=>(s.notifyPatches??[]).at(-1)).toEqual({expectedGeneration:0,name:'iPad'});});
    const renamed=list.getByRole('listitem').filter({hasText:'iPad'});
    await renamed.getByRole('switch',{name:'启用 iPad'}).click();
    await check('disable uses next generation',async()=>expect.poll(()=>(s.notifyPatches??[]).at(-1)).toEqual({expectedGeneration:1,enabled:false}));
    await renamed.getByRole('button',{name:'删除'}).click();await p.getByRole('dialog').getByRole('button',{name:'删除渠道'}).click();
    await check('channel deleted with its routes',async()=>{await expect(list.getByRole('listitem')).toHaveCount(1);assert(!s.notify.routes.some(r=>r.channelId.startsWith('ch-')));});
    const initial=list.getByRole('listitem').filter({hasText:'Pushover'});
    await initial.getByRole('button',{name:'删除'}).click();await p.getByRole('dialog').getByRole('button',{name:'删除渠道'}).click();
    await check('migrated channel can also be deleted',async()=>{await expect(list.getByRole('listitem')).toHaveCount(0);assert(!s.notify.routes.some(r=>r.channelId==='legacy-pushover:u'));});
    await fixture.context.close();
  });  await journey('10 admin bounded pagination and invitation copy under mobile fixture', async () => {
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
  await journey('10b operator diagnostics distinguish idle, incidents, stale reads and recovery on desktop/mobile',async()=>{
    for(const profile of ['desktop','mobile']){
      const f=await setup(browser,profile,true),p=f.page,s=f.state;s.status.user.role='admin';s.status.capabilities.canAdmin=true;
      await p.goto(origin+'/admin');await p.getByRole('button',{name:'服务运行诊断',exact:true}).click();const panel=p.locator('.ops-panel');
      await check('idle monitor is explained without claiming a delivery test',async()=>{await expect(panel.locator('.ops-state strong')).toHaveText('空闲待命');await expect(panel).toContainText('通知提供方未验证');await expect(panel).toContainText('自动异常推送未启用');});
      s.observability={...s.observability,state:'critical',observedAt:Date.now(),issues:[{component:'queue',code:'delivery_stuck',severity:'critical'}],events:[{component:'queue',code:'delivery_stuck',severity:'critical',openedAt:Date.now()-70000,lastSeenAt:Date.now(),resolvedAt:null}]};
      await panel.getByRole('button',{name:'刷新诊断',exact:true}).click();await expect(panel.locator('.ops-state strong')).toHaveText('发现异常');
      await panel.getByRole('button',{name:'查看行情源与异常恢复记录'}).click();await expect(panel).toContainText('未恢复');
      s.failNext={method:'GET',path:'/api/admin/observability',code:'service_unavailable',status:503};await panel.getByRole('button',{name:'刷新诊断',exact:true}).click();
      await check('failed diagnostics preserve the old record but label it stale',async()=>{await expect(panel.locator('.ops-state strong')).toHaveText('诊断已过期');await expect(panel.getByRole('alert')).toContainText('上次成功读取');});
      s.observability={...F.makeObservabilityFixture(),events:[{...s.observability.events[0],resolvedAt:Date.now()}]};await panel.getByRole('button',{name:'刷新诊断',exact:true}).click();
      await check('healthy observation displays a recovered event',async()=>{await expect(panel.locator('.ops-state strong')).toHaveText('空闲待命');await expect(panel).toContainText('已恢复');});
      await noOverflow(p);await p.screenshot({path:join(outputs,`observability-${profile}-zh-MOCK.png`),fullPage:true});
      await languageChoice(p,'EN');if (!await panel.isVisible()) await p.getByRole('button',{name:'Service diagnostics',exact:true}).click();await expect(panel.getByRole('heading',{name:'Service diagnostics'})).toBeVisible();await noOverflow(p);
      await p.screenshot({path:join(outputs,`observability-${profile}-en-MOCK.png`),fullPage:true});await f.context.close();
    }
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
    // Wait for the admitted save attempt to release its busy lock before dismissal.
    await expect(p.getByRole('button',{name:'关闭对话框',exact:true})).toBeEnabled();
    await p.getByRole('button',{name:'关闭对话框',exact:true}).click();
    await expect(p.getByRole('dialog')).toHaveCount(0);
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
    await signOut(p);
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
    const before = s.requests.filter(r=>!r.path.startsWith('/api/auth/')&&r.path!=='/api/auth-capabilities' && r.path!=='/api/public-quotes').length;
    await signOut(p);
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
    await check('auth traffic leaves business gate intact',async()=>assert.equal(s.requests.filter(r=>!r.path.startsWith('/api/auth/')&&r.path!=='/api/auth-capabilities' && r.path!=='/api/public-quotes').length,before));
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
    const asset= p.getByRole('combobox',{name:'查看市场',exact:true}),source=sourceSelect(p);
    await asset.click();await p.getByRole('combobox',{name:'搜索市场',exact:true}).fill('BTC');
    await check('six exact markets remain one searchable BTC asset',async()=>{
      await expect(p.locator('[cmdk-item][data-asset="BTC"]')).toHaveCount(1);
      await expect(p.locator('[cmdk-item][data-asset="BTC"] .market-venue-summary')).toContainText('Binance');
      await expect(p.locator('[cmdk-item][data-asset="BTC"] .market-venue-summary')).toContainText('OKX');
      await expect(p.locator('[cmdk-item][data-asset="BTC"] .market-venue-summary')).toContainText('MEXC');
    });
    await p.locator('[cmdk-item][data-asset="BTC"] .market-result-symbol').click();
    await check('asset selection defaults to the Binance source while the picker shows only the symbol',async()=>{
      await expect(asset).toContainText('BTC / USDT');assert.doesNotMatch(await asset.innerText(),/Binance|OKX|MEXC/);
      await expect(source).toContainText(sourceLabel(s.markets.find(market=>market.instrument==='binance:swap:BTCUSDT')));
    });
    const statusBefore=requests(s,'GET','/api/status').length;
    await p.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
    await expect.poll(()=>requests(s,'GET','/api/status').length).toBeGreaterThan(statusBefore);
    await check('source identity survives background rerenders',()=>expect(source).toContainText(sourceLabel(s.markets.find(market=>market.instrument==='binance:swap:BTCUSDT'))));
    for(const market of s.markets){
      await chooseSelect(p,'行情来源',market.instrument);
      await check(`${market.instrument} source selector keeps its exact label`,()=>expect(source).toContainText(sourceLabel(market)));
      await check(`${market.instrument} quote request uses the exact instrument`,async()=>expect.poll(()=>requests(s,'GET','/api/quote').at(-1)?.instrument).toBe(market.instrument));
      await check(`${market.instrument} independent quote without monitored tick`,()=>expect(p.locator('.price-block')).toContainText('后台参考成交'));
      await check(`${market.instrument} exact widget mapping`,async()=>assert.equal(JSON.parse(await p.locator('.tradingview-widget-container script').textContent()).symbol,market.tradingViewSymbol));
      await check(`${market.instrument} panel scope`,()=>expect(p.locator('.alert-row')).toHaveCount(originalAlerts.filter(a=>a.instrument===market.instrument).length));
      await p.getByRole('button',{name:'创建警报',exact:true}).click();
      const dialog=p.getByRole('dialog',{name:'创建价格警报'});
      await check(`${market.instrument} new alert inherits exact venue and product`,()=>expect(dialog.getByRole('combobox',{name:'警报市场'})).toContainText(`${market.venue==='binance'?'Binance':market.venue.toUpperCase()} · ${market.type==='spot'?'现货':'USDT 永续'}`));
      await dialog.getByRole('combobox',{name:'警报市场'}).click();
      await check(`${market.instrument} AlertEditor still exposes exact venue chips`,async()=>{
        const venue=p.locator(`.ui-market-popover .market-venue[data-instrument="${market.instrument}"]`);
        await expect(venue).toHaveCount(1);await expect(venue).toHaveAttribute('aria-pressed','true');
        await expect(p.locator('.ui-market-popover .market-venues button')).toHaveCount(6);
      });
      await p.keyboard.press('Escape');await expect(p.locator('.ui-market-popover')).toHaveCount(0);await expect(dialog).toBeVisible();
      if(market.venue==='mexc'&&market.type==='swap'){
        await dialog.getByLabel('警报名称').fill('MOCK MEXC perpetual');
        await dialog.getByLabel('价格 · USDT').fill('65000');
        await dialog.getByRole('button',{name:'创建警报',exact:true}).click();await expect(dialog).toHaveCount(0);
        await check('saved alert preserves exact MEXC perpetual instrument',async()=>assert.equal(s.alerts.at(-1).instrument,'mexc:swap:BTC_USDT'));
      }else{await p.keyboard.press('Escape');await expect(dialog).toHaveCount(0);}
    }
    await check('switching never mutates existing alert identities/generations',async()=>assert.deepEqual(s.alerts.slice(0,originalAlerts.length),originalAlerts));
    await p.getByRole('tab',{name:'全部警报',exact:true}).click();
    await check('all alerts management remains available',()=>expect(p.locator('.alert-row')).toHaveCount(originalAlerts.length+1));
    await p.getByRole('tab',{name:'当前市场',exact:true}).click();
    await check('current MEXC market only shows MEXC rule',()=>expect(p.locator('.alert-row')).toHaveCount(1));
    await fixture.context.close();
  });
  for (const profile of ['desktop','mobile']) await journey('17 built-in chart: switch, history paging, drag to retarget and create at price ('+profile+')',async()=>{
    const fixture=await setup(browser,profile,true,{chart:null}),p=fixture.page,s=fixture.state;
    s.markets=s.markets.map(m=>({...m,venue:'okx',type:'swap',nativeId:m.instrument,symbol:`${m.base}/USDT:USDT`,settle:'USDT'}));
    await p.goto(origin+'/dashboard');await expect(p.getByRole('switch')).toBeVisible();
    if(profile==='mobile'){await p.getByRole('button',{name:/参考图表/}).click();}
    const chart=p.locator('.chart-panel');
    await check('fresh users get the built-in chart first',async()=>{await expect(p.locator('.native-chart')).toHaveCount(1);await expect(p.locator('.tradingview-widget-container')).toHaveCount(0);await expect(chart.locator('.chart-kind-switch [data-slot="button"]').first()).toHaveText('内置图表');});
    await chart.getByRole('button',{name:'内置图表',exact:true}).click();
    await check('choice persisted locally',async()=>assert.equal(await p.evaluate(()=>localStorage.getItem('open-alert-chart')),'native'));
    await check('tradingview embed removed',()=>expect(p.locator('.tradingview-widget-container')).toHaveCount(0));
    await check('candles requested for the selected market',async()=>expect.poll(()=>requests(s,'GET','/api/candles').length).toBeGreaterThan(0));
    await check('chart canvas renders',()=>expect(p.locator('.native-chart canvas').first()).toBeVisible());
    await check('chart ready',()=>expect(p.locator('.native-chart')).toHaveAttribute('data-chart-state','ready'));
    await check('OHLC legend shows the latest candle',()=>expect(p.getByTestId('chart-legend')).toContainText(/O.+H.+L.+C.+%/));
    await check('candle close countdown ticks',async()=>{const first=await p.getByTestId('chart-countdown').textContent();assert.match(first,/^(\d+D )?\d{2}:\d{2}(:\d{2})?$/);await expect.poll(()=>p.getByTestId('chart-countdown').textContent(),{timeout:3000}).not.toBe(first);});
    await noOverflow(p);await p.waitForTimeout(400);await p.screenshot({path:join(outputs,`native-chart-${profile}-MOCK.png`),fullPage:profile==='mobile'});
    // TradingView-style log/auto toggles in the plot's bottom-right corner.
    const modes=p.getByRole('group',{name:'价格坐标'}),logButton=modes.getByRole('button',{name:'对数坐标'}),autoButton=modes.getByRole('button',{name:'自动缩放价格坐标'});
    const axisPixels=()=>p.evaluate(()=>{const shell=document.querySelector('.native-chart');const canvases=[...shell.querySelectorAll('canvas')];const axis=canvases.filter(c=>{const r=c.getBoundingClientRect();return r.width>20&&r.width<140&&r.height>100;}).sort((a,b)=>b.getBoundingClientRect().x-a.getBoundingClientRect().x)[0];return axis?axis.toDataURL():'';});
    await check('scale toggles sit bottom-right, left of the price axis and above the time axis',async()=>{await expect(modes).toBeVisible();const m=await modes.boundingBox(),plot=await p.locator('.native-chart').boundingBox();const widths=await p.locator('.native-chart-shell').evaluate(el=>({price:parseFloat(getComputedStyle(el).getPropertyValue('--price-scale-width')),time:parseFloat(getComputedStyle(el).getPropertyValue('--time-scale-height'))}));assert(widths.price>20&&widths.time>10,JSON.stringify(widths));assert(m.x+m.width<=plot.x+plot.width-widths.price+1,'overlaps price axis');assert(m.x+m.width>=plot.x+plot.width-widths.price-20,'not at the right edge');assert(m.y+m.height<=plot.y+plot.height-widths.time+1,'overlaps time axis');assert(m.y+m.height>=plot.y+plot.height-widths.time-20,'not at the bottom edge');});
    await check('auto is on and log is off by default',async()=>{await expect(autoButton).toHaveAttribute('aria-pressed','true');await expect(logButton).toHaveAttribute('aria-pressed','false');await expect(autoButton).toHaveText('auto');await expect(logButton).toHaveText('log');});
    if(profile==='mobile')await check('scale toggles keep touch-sized targets on phones',async()=>{for(const b of [logButton,autoButton]){const r=await b.boundingBox();assert(r.width>=44&&r.height>=36,JSON.stringify(r));}});
    const linearAxis=await axisPixels();
    await logButton.click();
    await check('log toggle switches the price axis to logarithmic and persists',async()=>{await expect(logButton).toHaveAttribute('aria-pressed','true');assert.equal(await p.evaluate(()=>localStorage.getItem('open-alert-chart-log')),'1');await expect.poll(axisPixels).not.toBe(linearAxis);});
    await p.waitForTimeout(300);await p.screenshot({path:join(outputs,`native-scale-log-${profile}-MOCK.png`)});
    if(profile==='desktop'){
      const plot=await p.locator('.native-chart').boundingBox(),priceWidth=await p.locator('.native-chart-shell').evaluate(el=>parseFloat(getComputedStyle(el).getPropertyValue('--price-scale-width')));
      const ax=plot.x+plot.width-priceWidth/2,ay=plot.y+plot.height*0.4;
      await p.mouse.move(ax,ay);await p.mouse.down();await p.mouse.move(ax,ay+80,{steps:8});await p.mouse.up();
      await check('dragging the price axis turns auto off, like TradingView',()=>expect(autoButton).toHaveAttribute('aria-pressed','false'));
      const manualAxis=await axisPixels();
      await autoButton.click();
      await check('auto toggle refits the price axis',async()=>{await expect(autoButton).toHaveAttribute('aria-pressed','true');await expect.poll(axisPixels).not.toBe(manualAxis);});
      await autoButton.click();
      await check('auto toggle can be switched off directly',()=>expect(autoButton).toHaveAttribute('aria-pressed','false'));
      await autoButton.click();await expect(autoButton).toHaveAttribute('aria-pressed','true');
    }else{
      await autoButton.click();
      await check('tapping auto turns auto-scale off on phones',()=>expect(autoButton).toHaveAttribute('aria-pressed','false'));
      await autoButton.click();
      await check('tapping auto again restores auto-scale on phones',()=>expect(autoButton).toHaveAttribute('aria-pressed','true'));
    }
    await check('log scale survives reload',async()=>{await p.reload();if(profile==='mobile')await p.getByRole('button',{name:/参考图表/}).click();await expect(p.locator('.native-chart')).toHaveAttribute('data-chart-state','ready');await expect(logButton).toHaveAttribute('aria-pressed','true');await expect(autoButton).toHaveAttribute('aria-pressed','true');});
    await logButton.click();
    await check('turning log off restores the linear axis and clears the saved choice',async()=>{await expect(logButton).toHaveAttribute('aria-pressed','false');assert.equal(await p.evaluate(()=>localStorage.getItem('open-alert-chart-log')),null);});
    await noOverflow(p);
    await p.locator('.native-chart-bar').getByRole('button',{name:'1 小时',exact:true}).click();
    await check('timeframe switch requests 1h',async()=>expect.poll(()=>requests(s,'GET','/api/candles').some(r=>r.timeframe==='1h')).toBe(true));
    await expect(p.locator('.native-chart')).toHaveAttribute('data-chart-state','ready');
    // Locate the armed alert's line from the series' own coordinate transform, through the rendered price label.
    const box=await p.locator('.native-chart').boundingBox();
    const alert=s.alerts.find(a=>a.instrument==='BTC-USDT-SWAP'&&!a.triggered&&!a.pending);
    assert(alert,'fixture has an armed BTC alert');
    // Scan for the line: the cursor switches to ns-resize only on a draggable line.
    let lineY=null;
    if(profile==='desktop'){
      for(let y=box.y+8;y<box.y+box.height-30;y+=2){await p.mouse.move(box.x+box.width*0.4,y);if(await p.locator('.native-chart.is-line-hover').count()){lineY=y;break;}}
      await check('armed alert line is hit-testable',async()=>assert.notEqual(lineY,null));
      await p.mouse.down();await p.mouse.move(box.x+box.width*0.4,lineY+40,{steps:6});
      await check('drag shows a live preview label',()=>expect(p.locator('.chart-drag-label')).toBeVisible());
      await p.mouse.up();
    }else{
      for(let y=box.y+8;y<box.y+box.height-30&&lineY===null;y+=4){await p.touchscreen.tap(box.x+box.width*0.4,y);if(await p.locator('.native-chart-shell[data-selected-line="true"]').count())lineY=y;}
      await check('tap selects the alert line',async()=>assert.notEqual(lineY,null));
      const cdp=await p.context().newCDPSession(p);const x=box.x+box.width*0.4;
      await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y:lineY}]});
      for(let i=1;i<=6;i++)await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y:lineY+i*7}]});
      await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    }
    const dialog=p.getByRole('dialog');
    await check('release opens retarget confirmation',()=>expect(dialog.getByRole('heading',{name:'修改目标价？'})).toBeVisible());
    await p.waitForTimeout(400);await p.screenshot({path:join(outputs,`native-retarget-${profile}-MOCK.png`)});
    const shown=Number((await dialog.locator('.retarget-values strong').textContent()).replace(/,/g,''));
    await check('dragging down lowers the target',async()=>assert(shown<alert.threshold,`${shown} < ${alert.threshold}`));
    await check('nothing saved before confirming',async()=>assert.equal(requests(s,'PATCH',`/api/alerts/${alert.id}`).length,0));
    await dialog.getByRole('button',{name:'确认修改',exact:true}).click();await expect(dialog).toHaveCount(0);
    await check('confirm sends threshold-only patch with generation',async()=>{const sent=requests(s,'PATCH',`/api/alerts/${alert.id}`).at(-1);assert.deepEqual([...sent.fields].sort(),['expectedGeneration','threshold']);assert.equal(sent.threshold,shown);assert.equal(sent.expectedGeneration,0);});
    await check('alert list reflects new target',()=>expect(p.locator('.alert-row,.mobile-alert-summary').filter({hasText:alert.name}).first()).toContainText(shown.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}).slice(0,4)));
    // Create at a hovered price (desktop) or long-press point (mobile crosshair).
    if(profile==='desktop'){
      await p.mouse.move(box.x+box.width*0.5,box.y+box.height*0.2);
      const chip=p.locator('.chart-create-at');await expect(chip).toBeVisible();
      await check('create chip sits on the right, clear of the price axis',async()=>{const c=await chip.boundingBox();assert(c.x>box.x+box.width/2,`chip x ${c.x}`);assert(c.x+c.width<box.x+box.width-30,'chip overlaps price scale');});
      await check('hovering a candle updates the legend',async()=>{const before=await p.getByTestId('chart-legend').textContent();await p.mouse.move(box.x+box.width*0.3,box.y+box.height*0.5);await expect.poll(()=>p.getByTestId('chart-legend').textContent()).not.toBe(before);await p.mouse.move(box.x+box.width*0.5,box.y+box.height*0.2);});
      await chip.hover();await chip.click();
      await check('create dialog prefilled from chart price',async()=>{await expect(dialog.getByRole('heading',{name:'创建价格警报'})).toBeVisible();assert(Number(await dialog.getByLabel('价格 · USDT').inputValue())>0);});
      await check('price above market defaults to upper',()=>expect(dialog.getByRole('button',{name:/达到或高于/})).toHaveAttribute('aria-pressed','true'));
      await p.keyboard.press('Escape');
      const tools=p.getByRole('toolbar',{name:'画线工具'});
      await check('drawing rail floats on the left of the plot',async()=>{const r=await tools.boundingBox();assert(r.x<box.x+box.width*0.1&&r.height>r.width,'rail '+JSON.stringify(r));});
      await tools.getByRole('button',{name:'更多线条'}).click();const flyout=p.locator('.draw-flyout');
      await check('group flyout lists TradingView line tools',()=>expect(flyout.locator('.draw-flyout-pick',{hasText:'平行通道'})).toBeVisible());
      await flyout.getByRole('button',{name:'收藏工具 水平线'}).click();
      await check('starred tool appears in the floating favourites bar',async()=>{const fav=p.getByRole('toolbar',{name:'收藏的工具'});await expect(fav.getByRole('button',{name:'水平线',exact:true})).toBeVisible();assert.deepEqual(await p.evaluate(()=>JSON.parse(localStorage.getItem('open-alert-draw-favorites'))),['horizontal-line']);});
      await check('favourites bar drags and stays inside the chart',async()=>{const fav=p.getByRole('toolbar',{name:'收藏的工具'}),grip=fav.getByRole('button',{name:'拖动收藏工具栏'});const settled=async()=>{let last=null;for(let i=0;i<40;i++){const b=await fav.boundingBox();if(last&&b&&Math.abs(b.x-last.x)<0.5&&Math.abs(b.y-last.y)<0.5)return b;last=b;await p.waitForTimeout(50);}return last;};const before=await settled(),g=await grip.boundingBox(),shell=await p.locator('.native-chart-shell').boundingBox();await p.mouse.move(g.x+g.width/2,g.y+g.height/2);await p.mouse.down();await p.mouse.move(g.x-120,g.y+90,{steps:6});await p.mouse.move(g.x-5000,g.y+5000,{steps:4});await p.mouse.up();const after=await fav.boundingBox();assert.ok(after.x<before.x&&after.y>before.y,'bar should move');assert.ok(after.x>=shell.x-1&&after.y+after.height<=shell.y+shell.height+1,'bar should stay inside the chart');const saved=await p.evaluate(()=>JSON.parse(localStorage.getItem('open-alert-draw-favbar')));assert.equal(saved.x,0);assert.equal(saved.y,1);});
      await p.waitForTimeout(250);await p.screenshot({path:join(outputs,'native-draw-flyout-'+profile+'-MOCK.png')});
      await p.keyboard.press('Escape');await expect(flyout).toHaveCount(0);
      await tools.getByRole('button',{name:'趋势线',exact:true}).click();
      await check('armed tool hides the create chip and shows a hint',async()=>{await expect(p.locator('.chart-tool-hint')).toBeVisible();await p.mouse.move(box.x+box.width*0.35,box.y+box.height*0.3);await expect(p.locator('.chart-create-at')).toHaveCount(0);});
      await p.mouse.click(box.x+box.width*0.35,box.y+box.height*0.3);await p.mouse.click(box.x+box.width*0.6,box.y+box.height*0.5);
      await check('trend line saved per market',async()=>expect.poll(()=>p.evaluate(()=>JSON.parse(localStorage.getItem('open-alert-drawings:BTC-USDT-SWAP')||'[]').map(d=>d.kind))).toEqual(['trend-line']));
      await check('placing a drawing opens no alert dialog',()=>expect(dialog).toHaveCount(0));
      await p.waitForTimeout(300);await p.screenshot({path:join(outputs,`native-drawing-${profile}-MOCK.png`)});
      // TradingView-style edit bar for the selected drawing: appears on placement/click, edits are saved, clicks elsewhere close it.
      const editbar=p.getByRole('toolbar',{name:'画线设置'}),saved=()=>p.evaluate(()=>JSON.parse(localStorage.getItem('open-alert-drawings:BTC-USDT-SWAP')||'[]'));
      const lineMid={x:box.x+box.width*0.475,y:box.y+box.height*0.4};
      // An empty plot point: off the trend line, the left rail, the create chip and every alert line.
      const emptySpot=async()=>{for(const fy of [0.12,0.18,0.24,0.62,0.7,0.78]){const pt={x:box.x+box.width*0.2,y:box.y+box.height*fy};await p.mouse.move(pt.x,pt.y);if(!await p.locator('.native-chart.is-line-hover').count())return pt;}throw new Error('no empty chart spot');};
      await check('placed drawing is selected and shows the edit bar',()=>expect(editbar).toBeVisible());
      await check('edit bar sits inside the chart, clear of the drawing rail',async()=>{const b=await editbar.boundingBox(),shell=await p.locator('.native-chart-shell').boundingBox(),rail=await tools.boundingBox();assert(b.x>=shell.x&&b.x+b.width<=shell.x+shell.width&&b.y>=shell.y&&b.y+b.height<=shell.y+shell.height,'outside chart '+JSON.stringify(b));assert(b.x>rail.x+rail.width||b.y>rail.y+rail.height,'covers rail');});
      await check('edit bar offers colour, width, lock, delete and more',async()=>{for(const name of ['线条颜色','线条粗细 2px','锁定画线','删除画线','更多操作'])await expect(editbar.getByRole('button',{name,exact:true})).toBeVisible();});
      await editbar.getByRole('button',{name:'线条颜色',exact:true}).click();
      const pop=p.locator('.draw-edit-pop');
      await check('colour menu shows the palette inside its panel',async()=>{await expect(pop.getByRole('button',{name:'颜色 #f23645'})).toBeVisible();const r=await pop.boundingBox();for(const el of await pop.locator('.draw-edit-color, .draw-edit-custom input').all()){const c=await el.boundingBox();assert(c.x>=r.x&&c.x+c.width<=r.x+r.width+1&&c.height<=40,'control '+JSON.stringify(c));}});
      await p.waitForTimeout(250);await p.screenshot({path:join(outputs,`native-draw-editbar-colors-${profile}-MOCK.png`)});
      await pop.getByRole('button',{name:'颜色 #f23645'}).click();
      await check('picked colour is saved on the drawing',async()=>expect.poll(async()=>(await saved())[0]?.style.color).toBe('#f23645'));
      await p.keyboard.press('Escape');
      await check('Esc closes the menu but keeps the drawing selected',async()=>{await expect(pop).toHaveCount(0);await expect(editbar).toBeVisible();});
      await editbar.getByRole('button',{name:'线条粗细 2px',exact:true}).click();await pop.getByRole('button',{name:'4px',exact:true}).click();
      await check('line width is saved',async()=>expect.poll(async()=>(await saved())[0]?.style.width).toBe(4));
      await check('width menu closes after a pick',()=>expect(pop).toHaveCount(0));
      await editbar.getByRole('button',{name:'线条粗细 4px',exact:true}).click();await pop.getByRole('button',{name:'虚线',exact:true}).click();
      await check('line style is saved',async()=>expect.poll(async()=>(await saved())[0]?.style.lineStyle).toBe('dashed'));
      await editbar.getByRole('button',{name:'锁定画线',exact:true}).click();
      await check('lock is saved and shown',async()=>{await expect.poll(async()=>(await saved())[0]?.locked).toBe(true);await expect(editbar.getByRole('button',{name:'解锁画线',exact:true})).toHaveAttribute('aria-pressed','true');});
      await editbar.getByRole('button',{name:'解锁画线',exact:true}).click();
      await check('unlock is saved',async()=>expect.poll(async()=>(await saved())[0]?.locked).toBe(false));
      await p.waitForTimeout(200);await p.screenshot({path:join(outputs,`native-draw-editbar-${profile}-MOCK.png`)});
      const empty=await emptySpot();await p.mouse.click(empty.x,empty.y);
      await check('clicking empty chart space closes the edit bar',()=>expect(editbar).toHaveCount(0));
      await check('the deselecting click opens no alert dialog',()=>expect(dialog).toHaveCount(0));
      await p.mouse.click(lineMid.x,lineMid.y);
      await check('clicking the drawing reopens the edit bar',()=>expect(editbar).toBeVisible());
      await p.locator('.chart-caption').click();
      await check('clicking outside the chart closes the edit bar',()=>expect(editbar).toHaveCount(0));
      await p.mouse.click(lineMid.x,lineMid.y);await expect(editbar).toBeVisible();
      await editbar.getByRole('button',{name:'更多操作',exact:true}).click();await pop.getByRole('button',{name:'克隆',exact:true}).click();
      await check('clone adds a copy with the same style',async()=>expect.poll(async()=>(await saved()).map(d=>[d.kind,d.style.color,d.style.width])).toEqual([['trend-line','#f23645',4],['trend-line','#f23645',4]]));
      await editbar.getByRole('button',{name:'删除画线',exact:true}).click();
      await check('delete removes only the selected drawing and closes the bar',async()=>{await expect.poll(async()=>(await saved()).length).toBe(1);await expect(editbar).toHaveCount(0);});
      await check('the arming rail hides the edit bar while drawing',async()=>{await p.mouse.click(lineMid.x,lineMid.y);await expect(editbar).toBeVisible();await tools.getByRole('button',{name:'趋势线',exact:true}).click();await expect(editbar).toHaveCount(0);await p.keyboard.press('Escape');});
    }
    // TradingView-style intervals: typed entry on the chart, a starred custom interval, and asset favourites.
    if(profile==='desktop'){
      await p.mouse.move(box.x+box.width*0.5,box.y+box.height*0.5);await p.keyboard.press('Escape');await p.keyboard.type('7');
      const typed=p.getByRole('dialog',{name:'输入周期'});
      await check('typing a digit opens the interval entry',()=>expect(typed).toBeVisible());
      await check('entry previews the interval',()=>expect(typed).toContainText('7 分钟'));
      await p.keyboard.press('Enter');
      await check('typed 7 requests a 7m page',async()=>expect.poll(()=>requests(s,'GET','/api/candles').some(r=>r.timeframe==='7m')).toBe(true));
      await check('unstarred interval shows as a transient pill',()=>expect(p.locator('.timeframe-favorites .is-transient')).toHaveText('7m'));
      await p.mouse.move(box.x+box.width*0.5,box.y+box.height*0.5);await p.keyboard.type('1M');await p.keyboard.press('Enter');
      await check('month input is rejected in place',()=>expect(typed).toContainText('无法识别'));
      await p.keyboard.press('Escape');await check('Esc closes the entry',()=>expect(typed).toHaveCount(0));
    }
    await p.getByRole('button',{name:'更多周期'}).click();
    const menu=p.locator('.timeframe-popover');
    await check('interval menu lists presets',()=>expect(menu.getByRole('button',{name:/^2H/})).toBeVisible());
    await menu.getByRole('button',{name:'加入常用 2H'}).click();
    await check('starred interval saved locally',async()=>expect.poll(()=>p.evaluate(()=>JSON.parse(localStorage.getItem('open-alert-chart-frames')||'[]'))).toContain('2h'));
    await menu.getByLabel('自定义周期').fill('90');await menu.getByRole('button',{name:'应用'}).click();
    await check('custom 90 becomes 90m',async()=>expect.poll(()=>requests(s,'GET','/api/candles').some(r=>r.timeframe==='90m')).toBe(true));
    await check('starred 2H pill in the bar',()=>expect(p.locator('.timeframe-favorites').getByRole('button',{name:'2 小时',exact:true})).toBeVisible());
    await check('menu closes after applying',()=>expect(menu).toHaveCount(0));
    await p.getByRole('button',{name:'更多周期'}).click();await expect(menu).toBeVisible();await p.waitForTimeout(300);
    await p.screenshot({path:join(outputs,'native-timeframes-'+profile+'-MOCK.png')});await p.keyboard.press('Escape');await expect(menu).toHaveCount(0);
    if(profile==='mobile')await check('phones start with the drawing rail collapsed',()=>expect(p.getByRole('button',{name:'展开画线工具'})).toBeVisible());
    await p.getByRole('combobox',{name:'查看市场',exact:true}).click();
    await p.locator('[cmdk-item][data-asset="BTC"]').getByRole('button',{name:'收藏 BTC',exact:true}).click();
    await check('star saves the underlying asset',async()=>expect.poll(()=>s.favoritePuts?.at(-1)?.favorites).toEqual([{base:'BTC',preferred:'BTC-USDT-SWAP'}]));
    await check('starred asset listed first under 收藏',()=>expect(p.locator('[cmdk-group-heading]').first()).toHaveText('收藏'));
    await p.keyboard.press('Escape');
    await noOverflow(p);
    await check('selection survives reload',async()=>{await p.reload();if(profile==='mobile')await p.getByRole('button',{name:/参考图表/}).click();await expect(p.locator('.native-chart canvas').first()).toBeVisible();});
    if(profile==='desktop'){
      await check('drawings restored after reload',async()=>{await expect(p.locator('.native-chart')).toHaveAttribute('data-chart-state','ready');await expect(p.getByRole('button',{name:'清空画线'})).toBeEnabled();});
      await check('restored drawing keeps the edited style',async()=>expect.poll(()=>p.evaluate(()=>JSON.parse(localStorage.getItem('open-alert-drawings:BTC-USDT-SWAP')||'[]').map(d=>[d.style.color,d.style.width,d.style.lineStyle]))).toEqual([['#f23645',4,'dashed']]));
      await p.getByRole('button',{name:'清空画线'}).click();await p.getByRole('button',{name:'再点一次清空'}).click();
      await check('clear removes saved drawings',async()=>expect.poll(()=>p.evaluate(()=>localStorage.getItem('open-alert-drawings:BTC-USDT-SWAP'))).toBe(null));
    }
    if(profile==='mobile'){
      // Phone: tap to place, tap to select; the edit bar keeps 44px targets inside the chart and taps elsewhere close it.
      await expect(p.locator('.native-chart')).toHaveAttribute('data-chart-state','ready');
      // Measure after scrolling: boundingBox is viewport-relative and touchscreen taps use the viewport.
      await p.locator('.native-chart-shell').scrollIntoViewIfNeeded();
      const mbox=await p.locator('.native-chart').boundingBox(),editbar=p.getByRole('toolbar',{name:'画线设置'}),pop=p.locator('.draw-edit-pop');
      await p.getByRole('button',{name:'展开画线工具'}).click();await p.getByRole('toolbar',{name:'画线工具'}).getByRole('button',{name:'趋势线',exact:true}).click();
      await p.touchscreen.tap(mbox.x+mbox.width*0.35,mbox.y+mbox.height*0.35);await p.touchscreen.tap(mbox.x+mbox.width*0.65,mbox.y+mbox.height*0.55);
      await check('mobile: placed drawing shows the edit bar',()=>expect(editbar).toBeVisible());
      await check('mobile: edit bar stays inside the chart with 44px targets',async()=>{const b=await editbar.boundingBox(),shell=await p.locator('.native-chart-shell').boundingBox();assert(b.x>=shell.x-1&&b.x+b.width<=shell.x+shell.width+1&&b.y>=shell.y-1&&b.y+b.height<=shell.y+shell.height+1,'outside chart '+JSON.stringify(b));for(const el of await editbar.locator('[data-slot="button"]').all()){const r=await el.boundingBox();assert(r.height>=44,'short target '+r.height);}});
      await noOverflow(p);
      await editbar.getByRole('button',{name:'线条颜色',exact:true}).tap();
      await check('mobile: palette fits the viewport',async()=>{await expect(pop).toBeVisible();const r=await pop.boundingBox(),vw=await p.evaluate(()=>innerWidth);assert(r.x>=0&&r.x+r.width<=vw,'palette '+JSON.stringify(r));for(const el of await pop.locator('.draw-edit-color').all()){const c=await el.boundingBox();assert(c.width>=44&&c.height>=44&&c.x>=r.x&&c.x+c.width<=r.x+r.width+1,'swatch '+JSON.stringify(c));}});
      await p.waitForTimeout(250);await p.screenshot({path:join(outputs,`native-draw-editbar-colors-${profile}-MOCK.png`)});
      await pop.getByRole('button',{name:'颜色 #089981'}).tap();
      await check('mobile: picked colour is saved',async()=>expect.poll(()=>p.evaluate(()=>JSON.parse(localStorage.getItem('open-alert-drawings:BTC-USDT-SWAP')||'[]')[0]?.style.color)).toBe('#089981'));
      await p.getByText('拖动警报线可直接改价。',{exact:true}).tap();
      await check('mobile: tapping outside closes the menu and the edit bar',async()=>{await expect(pop).toHaveCount(0);await expect(editbar).toHaveCount(0);});
      await p.touchscreen.tap(mbox.x+mbox.width*0.5,mbox.y+mbox.height*0.45);
      await check('mobile: tapping the drawing reopens the edit bar',()=>expect(editbar).toBeVisible());
      await p.waitForTimeout(200);await p.screenshot({path:join(outputs,`native-draw-editbar-${profile}-MOCK.png`)});
      await p.touchscreen.tap(mbox.x+mbox.width*0.5,mbox.y+mbox.height*0.12);
      await check('mobile: tapping empty chart space closes the edit bar',()=>expect(editbar).toHaveCount(0));
      await p.touchscreen.tap(mbox.x+mbox.width*0.5,mbox.y+mbox.height*0.45);await expect(editbar).toBeVisible();
      await editbar.getByRole('button',{name:'删除画线',exact:true}).tap();
      await check('mobile: delete removes the drawing',async()=>expect.poll(()=>p.evaluate(()=>localStorage.getItem('open-alert-drawings:BTC-USDT-SWAP'))).toBe(null));
    }
    await p.locator('.chart-panel').getByRole('button',{name:'TradingView',exact:true}).click();
    await check('switching back restores TradingView embed',()=>expect(p.locator('.tradingview-widget-container script')).toHaveCount(1));
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
    await signOut(p);await expect(p.getByLabel('邮箱地址')).toBeEnabled();
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
    await p.goto(origin+'/settings'); await tick(p);
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
      assert.deepEqual(await p.evaluate(()=>Object.keys(localStorage).filter(k=>k!=='open-alert-chart')),[]);
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
    await nav(p,'Account');
    await expect(p.getByRole('heading',{name:'Account details',exact:true})).toBeVisible();
    await nav(p,'Markets & alerts');
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
    if (await p.locator('.mobile-dock').isVisible()) { await p.locator('.mobile-dock a[href="/alerts"]').click(); } await p.getByRole('button',{name:'Notes & limits'}).click();
    await expect(p.locator('.disclosure-content')).toBeVisible();
    await nav(p,'Notifications');
    await expect(p.getByRole('heading',{name:'Notification centre',level:1})).toBeVisible();
    await noOverflow(p);
    await p.screenshot({path:join(outputs,'appearance-'+profile+'-notifications-light-MOCK.png'),fullPage:profile==='desktop',animations:'disabled'});
    await nav(p,'Markets & alerts');
    await check('navigation preserves widget instance',async()=>assert.equal(await p.evaluate(()=>window.__mockChartConfigs.length),scriptsBefore));
    await p.emulateMedia({reducedMotion:'reduce'});
    await p.getByRole('button',{name:'Create alert',exact:true}).click();
    await check('reduced motion and dialog keep working',async()=>{
      await expect(p.getByRole('dialog')).toBeVisible();
      assert(parseFloat(await p.getByRole('dialog').evaluate(node=>getComputedStyle(node).animationDuration))<=0.001);
      assert.equal(await p.getByLabel('Alert name').getAttribute('data-slot'),'input');
    });
    await p.keyboard.press('Escape');
    await languageChoice(p,'中文');await p.reload();
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
      await check('client language '+locale,async()=>{await expect(fixture.page.locator('html')).toHaveAttribute('lang',expected);assert.deepEqual(await fixture.page.evaluate(()=>Object.keys(localStorage).filter(k=>k!=='open-alert-chart')),[]);});
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
        window.__themeFrames.push({theme:document.documentElement.dataset.theme,body:colors('body'),dialog:colors('[data-slot="dialog-content"]'),input:colors('[data-slot="dialog-content"] [data-slot="input"]'),select:colors('[data-slot="dialog-content"] .market-search-trigger'),primary:colors('[data-slot="dialog-content"] [data-variant="default"]')});
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
        const tokens=await p.evaluate(()=>{const s=getComputedStyle(document.documentElement);return{background:s.getPropertyValue('--background').trim(),foreground:s.getPropertyValue('--foreground').trim(),card:s.getPropertyValue('--card').trim(),field:s.getPropertyValue('--field').trim()};});
        const expected=await p.evaluate(values=>{const probe=document.createElement('span');probe.style.color=values.background;document.body.append(probe);const result=Object.fromEntries(Object.entries(values).map(([key,value])=>{probe.style.color=value;return[key,getComputedStyle(probe).color];}));probe.remove();return result;},tokens);
        assert.equal(sample.theme,theme);
        assert.equal(sample.body.bg,expected.background);
        assert.equal(sample.body.text,expected.foreground);
        assert.equal(sample.dialog.bg,expected.card);
        assert.equal(sample.input.bg,expected.field);
        assert.equal(sample.select.bg,sample.input.bg);assert.equal(sample.select.text,sample.input.text);
        assert.equal(sample.primary.bg,sample.body.text);assert.equal(sample.primary.text,sample.body.bg);
        await expect(p.getByLabel('Alert name')).toHaveValue('Unsent draft');
      });
      await p.getByRole('combobox',{name:'Alert market',exact:true}).click();
      await expect(p.locator('[data-slot="popover-content"]')).toHaveAttribute('data-motion-state','settled');
      await check('portalled select follows the same palette',async()=>{
        const c=await p.locator('[data-slot="popover-content"]').evaluate(n=>({bg:getComputedStyle(n).backgroundColor,color:getComputedStyle(n).color}));
        const tokens=await p.evaluate(()=>{const s=getComputedStyle(document.documentElement);return{background:s.getPropertyValue('--popover').trim(),foreground:s.getPropertyValue('--foreground').trim()};});
        const expected=await p.evaluate(values=>{const probe=document.createElement('span');probe.style.color=values.background;document.body.append(probe);const result=Object.fromEntries(Object.entries(values).map(([key,value])=>{probe.style.color=value;return[key,getComputedStyle(probe).color];}));probe.remove();return result;},tokens);
        assert.equal(c.bg,expected.background);
        assert.equal(c.color,expected.foreground);
      });
      await p.keyboard.press('Escape');await expect(p.locator('[data-slot="popover-content"]')).toHaveCount(0);
      await expect(p.getByRole('combobox',{name:'Alert market',exact:true})).toContainText('BTC');
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
    await nav(p,'Notifications');
    await expect(p.getByRole('heading',{name:'Notification centre',level:1})).toBeVisible();
    await expect(p.locator('.settings-page')).toHaveAttribute('data-motion-state','settled');
    await check('navigation underline tracks the actual active link',async()=>{
      if (await p.locator('.mobile-dock').isVisible()) {
        const selected=p.locator('.mobile-dock a[aria-current="page"]');
        await expect(selected).toHaveAttribute('href','/notifications');
        assert.notEqual(await selected.evaluate(n=>getComputedStyle(n).backgroundColor),'rgba(0, 0, 0, 0)');
      } else {
        const bounds=await p.locator('.app-nav').evaluate(n=>{const a=n.querySelector('[aria-current="page"]').getBoundingClientRect(),i=n.querySelector('.nav-indicator').getBoundingClientRect();return{left:Math.abs(a.left-i.left),top:Math.abs(a.top-i.top),width:Math.abs(a.width-i.width),height:Math.abs(a.height-i.height)};});assert(Object.values(bounds).every(v=>v<1),JSON.stringify(bounds));
      }
    });
    await nav(p,'Markets & alerts');
    if (await p.locator('.mobile-dock').isVisible()) { await p.locator('.mobile-dock a[href="/alerts"]').click(); } await p.getByRole('button',{name:'Notes & limits'}).click();await expect(p.locator('.disclosure-content')).toHaveAttribute('data-motion-state','settled');
    if (await p.locator('.mobile-dock').isVisible()) { await p.locator('.mobile-dock a[href="/alerts"]').click(); } await p.getByRole('button',{name:'Notes & limits'}).click();await expect(p.locator('.disclosure-content')).toBeHidden();
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
  const expectedJourneys = only ? selectedJourneys.length : allJourneys.length;
  const evidence={mode:'MOCK',timedOut,scope:'Actual production React/Vite UI with intercepted API and chart embed; no real provider/server integration',profiles:['desktop Chromium 1440×1000','iPhone 15 Chromium emulation 390×844'],assertions,expectedJourneys,journeys:results,apiRequests,authRequests,chartScripts,runtimeErrors,knownRuntimeWarnings,violations,externalAttempts,limitations:['Real backend runtime/DB/session signature integration not tested','Google OAuth and external email delivery not tested','Pushover, Discord and OKX feed delivery not tested','TradingView embed substituted with a clearly labelled MOCK frame','Mobile Chromium emulation is not actual Safari'],passed:expectedJourneys>0&&results.length===expectedJourneys&&results.every(r=>r.passed)&&runtimeErrors.length===0&&violations.length===0&&!process.exitCode};
  if (!evidence.passed) process.exitCode=1;
  await writeFile(join(outputs,'open-alert-browser-check-results-MOCK.json'),JSON.stringify(evidence,null,2)+'\n');
  console.log(`MOCK result: ${results.filter(r=>r.passed).length}/${expectedJourneys} journeys, ${assertions} assertions; ${apiRequests} API requests; runtime errors=${runtimeErrors.length}; known live-WS 404 warnings=${knownRuntimeWarnings.length}; schema violations=${violations.length}`);
}

}

async function chooseSelect(page,label,value) {
  if (label === 'Appearance') {
    await accountControls(page);
    await page.getByRole('group',{name:'Appearance'}).getByRole('button',{name:({light:'Light',dark:'Dark',system:'System'})[value],exact:true}).click();
    if (await page.locator('.account-menu:visible').count()) { await page.keyboard.press('Escape'); await expect(page.locator('.account-menu')).toHaveCount(0); }
    else if (new URL(page.url()).pathname === '/settings') await nav(page,'Markets & alerts');
    return;
  }
  await page.getByRole('combobox',{name:label,exact:true}).click();
  await page.locator('[role="option"][data-value="'+value+'"]').click();
}
