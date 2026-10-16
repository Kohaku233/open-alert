#!/usr/bin/env node
/** Real compiled Node + built React browser integration; all provider transports stay local.
 * Build first: npm run build. Run: node scripts/browser-check.mjs (bounded to 55 seconds).
 * Optional UI-only mocked coverage: node scripts/browser-mock-check.mjs.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, rm, writeFile, access, readFile, readdir } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputs = process.env.OPEN_ALERT_BROWSER_OUTPUT_DIR ? resolve(process.env.OPEN_ALERT_BROWSER_OUTPUT_DIR) : resolve(root,'..');
let playwrightPath = process.env.PLAYWRIGHT_MODULE || join(root,'node_modules/playwright/index.mjs');
if (!process.env.PLAYWRIGHT_MODULE) {
  try { await access(playwrightPath); }
  catch { playwrightPath = join(resolve(root,'..'),'okx-free-monitor/node_modules/playwright/index.mjs'); }
}
const { chromium, devices } = await import(pathToFileURL(playwrightPath).href);
const { expect } = await import(pathToFileURL(join(dirname(playwrightPath),'test.mjs')).href);
expect.configure({timeout:3000});
const results = [], children = [], messages = [], transport = [], violations = [], browserErrors = [], cleanupErrors = [];
const guardProbes = [], fixtureReady = [], browserBlocked = [];
const preloads = ['--import',pathToFileURL(join(root,'scripts/local-test-transport.mjs')).href,'--import',pathToFileURL(join(root,'scripts/local-test-types.mjs')).href];
const marketPreload = ['--import',pathToFileURL(join(root,'test/browser-ccxt-fixtures.mjs')).href];
let assertions = 0, apiRequests = 0, browser, server, directory, origin, environment, timedOut = false;
let alice, bob, aliceAlert, bobAlert, aliceId, bobId, sessionCookie, compiledInputs = {};
async function fingerprints() {
  const files=['scripts/browser-check.mjs','test/browser-ccxt-fixtures.mjs','src/markets/ccxt.ts','src/markets/source.ts','src/markets/normalize.ts','src/scheduler/index.ts','dist/server/runtime/node.js','dist/server/markets/ccxt.js','dist/server/markets/source.js','dist/server/markets/normalize.js','dist/server/scheduler/index.js','dist/web/index.html',...(await readdir(join(root,'dist/web/assets'))).map(name=>`dist/web/assets/${name}`)];
  return Object.fromEntries(await Promise.all(files.map(async file=>[file,createHash('sha256').update(await readFile(join(root,file))).digest('hex')])));
}
const startedAt = Date.now();
const check = async (name,fn) => { await fn(); assertions++; console.log(`  CHECK ${name}`); };
const journey = async (name,fn) => { const start=Date.now(); try { await fn(); results.push({name,passed:true,durationMs:Date.now()-start}); console.log(`PASS ${name}`); } catch(error) { results.push({name,passed:false,error:error.message}); throw error; } };
const pause = ms => new Promise(r=>setTimeout(r,ms));
async function until(fn,label,ms=4000) { const deadline=Date.now()+ms; do { const value=await fn(); if(value)return value; await pause(40); } while(Date.now()<deadline&&!timedOut); throw new Error(`Timed out: ${label}`); }
function launch(args,label) {
  // No shell/npm wrapper: every tracked PID is the actual Node process receiving SIGTERM.
  const child=spawn(process.execPath,args,{cwd:root,env:environment,stdio:label==='operator-invite-cli'?['ignore','pipe','pipe']:['ignore','pipe','pipe','ipc']});
  const record={child,label,logs:'',exit:null}; children.push(record);
  child.stdout.on('data',chunk=>{record.logs+=chunk.toString();}); child.stderr.on('data',chunk=>{record.logs+=chunk.toString();});
  child.on('message',message=>{
    if(label==='egress-guard-probe') { guardProbes.push(message); return; }
    if(message.type==='email')messages.push(message);
    else if(message.type==='blocked')violations.push(message);
    else if(message.type==='transport')transport.push({...message,child:label});
    else if(message.type==='ccxt-fixtures-ready')fixtureReady.push({...message,child:label});
  });
  record.exited=new Promise((resolveExit,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>{record.exit={code,signal};resolveExit(record.exit);});});
  return record;
}
async function waitExit(record,ms=4000) {
  let timer; try { return await Promise.race([record.exited,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(`${record.label} did not exit within ${ms}ms: ${record.logs}`)),ms);})]); } finally {clearTimeout(timer);}
}
async function stopServer() {
  if(!server || server.exit)return;
  server.child.kill('SIGTERM');
  // Node may drain idle keep-alive sockets beyond the CLI's four-second budget.
  const exit=await waitExit(server,8000);
  assert.deepEqual(exit,process.platform === 'win32' ? {code:null,signal:'SIGTERM'} : {code:0,signal:null},`${server.label} shutdown: ${JSON.stringify(exit)}\n${server.logs}`);
  assertions++; console.log('  CHECK compiled server stopped after SIGTERM (Windows terminates; POSIX drains)');
}
async function startServer() {
  server=launch([...preloads,...marketPreload,join(root,'dist/server/runtime/node.js')],`compiled-server-${children.length}`);
  let readinessStatus = null;
  try { await until(async()=>{if(server.exit)throw new Error(`Server exited early: ${server.logs}`);try {const r=await fetch(origin+'/api/auth-capabilities',{signal:AbortSignal.timeout(400)});readinessStatus=r.status;return r.ok&&(await r.json()).data.emailOtp;}catch{return false;}},'compiled server readiness',12000); } catch(error) { throw new Error(`${error.message}; HTTP status ${readinessStatus}; ${server.logs}`); }
  assert.match(server.logs,/setup ready/); assertions++;
}
async function api(context,path,method='GET',body,headers={}) {
  apiRequests++;
  const response=await context.request.fetch(origin+path,{method,headers:{origin,'content-type':'application/json',...headers},...(body===undefined?{}:{data:body}),timeout:3000});
  return {status:response.status(),body:await response.json()};
}
async function ok(context,path,method='GET',body,headers={}) {
  const result=await api(context,path,method,body,headers); assert(result.status>=200&&result.status<300,`${method} ${path}: ${JSON.stringify(result)}`); assert.equal(result.body.ok,true);return result.body.data;
}
async function profile(mobile=false) {
  const context=await browser.newContext({...mobile?{...devices['iPhone 15'],defaultBrowserType:undefined}:{viewport:{width:1440,height:1000}},locale:'zh-CN',colorScheme:'dark',serviceWorkers:'block'});
  await context.route('**/*',route=>{
    const url=new URL(route.request().url());
    if(url.origin===origin) {if(url.pathname.startsWith('/api/'))apiRequests++;return route.continue();}
    // TradingView is optional third-party UI; deliberately block its embed without network.
    browserBlocked.push({host:url.hostname,path:url.pathname});
    if(url.href!=='https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js')violations.push({type:'browser-external',host:url.hostname,path:url.pathname});
    return route.abort('blockedbyclient');
  });
  const page=await context.newPage();page.setDefaultTimeout(3000);page.on('pageerror',e=>browserErrors.push(e.message));
  return {context,page};
}
async function login(profile,email,rejectWrong=false) {
  const {page,context}=profile;
  await page.goto(origin+'/login');await page.getByLabel('邮箱地址').fill(email.toUpperCase());await page.getByRole('button',{name:'发送验证码'}).click();
  await expect(page.getByLabel('邮件中的验证码')).toBeVisible();
  const mail=await until(()=>messages.find(m=>m.to===email&&m.otp),'generated local email OTP');
  await page.reload();
  await check('real email challenge survives a full page reload',async()=>{await expect(page.getByRole('heading',{name:'验证邮箱',exact:true})).toBeVisible();await expect(page.getByLabel('邮件中的验证码')).toHaveValue('');});
  const input=await page.getByLabel('邮件中的验证码').elementHandle();
  const other=await context.newPage();await other.goto(origin+'/login');await page.bringToFront();await other.close();
  await check('returning from another tab preserves the verification form',async()=>{assert(await input.evaluate(n=>n.isConnected));await expect(page.getByLabel('邮件中的验证码')).toBeVisible();});
  if(rejectWrong) {
    await page.getByLabel('邮件中的验证码').fill(mail.otp==='000000'?'111111':'000000');await page.getByRole('button',{name:'验证并继续'}).click();
    await check('real handler rejects wrong generated OTP',()=>expect(page.getByRole('alert')).toContainText('验证码不正确或已过期'));
  }
  await page.getByLabel('邮件中的验证码').fill(mail.otp);await page.getByRole('button',{name:'验证并继续'}).click();await expect(page.getByRole('switch')).toBeVisible();
  await check('server-issued HttpOnly SameSite cookie',async()=>{const cookies=await context.cookies(origin);assert(cookies.some(c=>c.name==='better-auth.session_token'&&c.httpOnly&&c.sameSite==='Lax'&&c.value.length>40));});
  return mail.otp;
}
const nav=(page,name)=>page.getByRole('navigation',{name:'主导航'}).getByRole('link',{name,exact:true}).click();
const row=(page,name)=>page.locator('.alert-row').filter({has:page.getByText(name,{exact:true})});
async function selectMarket(picker,instrument,venue='okx',type='swap') {
  const page=picker.page();
  await picker.getByRole('combobox').click();
  await page.getByRole('combobox',{name:'搜索市场',exact:true}).fill(instrument);
  await chooseSelect(page,'交易所',venue);
  await chooseSelect(page,'市场类型',type);
  await page.locator('[cmdk-item][data-instrument="'+instrument+'"]').click();
}
async function createAlert(profile,name,instrument,threshold,enabled=true) {
  const {page,context}=profile;await page.getByRole('button',{name:'创建警报',exact:true}).click();const dialog=page.getByRole('dialog');
  await selectMarket(dialog.locator('.market-search'),instrument);await dialog.getByLabel('警报名称').fill(name);await dialog.getByLabel('价格 · USDT').fill(String(threshold));
  await dialog.getByLabel('启用这条警报').setChecked(enabled);await dialog.getByRole('button',{name:'创建警报',exact:true}).click();
  await page.getByRole('tab',{name:'全部警报',exact:true}).click();
  await expect(row(page,name)).toBeVisible();return (await ok(context,'/api/alerts')).alerts.find(a=>a.name===name);
}
const watchdog=setTimeout(()=>{timedOut=true;for(const r of children)if(!r.exit)r.child.kill('SIGTERM');void browser?.close();},55000);
try {
  await access(join(root,'dist/server/runtime/node.js'));await access(join(root,'dist/web/index.html'));compiledInputs=await fingerprints();
  directory=await mkdtemp(join(tmpdir(),'open-alert-browser-real-'));
  const reservation=createServer();await new Promise(r=>reservation.listen(0,'127.0.0.1',r));const port=reservation.address().port;await new Promise(r=>reservation.close(r));origin=`http://127.0.0.1:${port}`;
  environment={PATH:process.env.PATH,HOME:homedir(),NODE_ENV:'test',DEPLOYMENT:'node',DB_DRIVER:'sqlite',SQLITE_PATH:join(directory,'app.sqlite'),APP_URL:origin,PORT:String(port),AUTH_SECRET:randomBytes(32).toString('hex'),ENCRYPTION_KEY:randomBytes(32).toString('hex'),BOOTSTRAP_TOKEN:randomBytes(32).toString('hex'),EMAIL_PROVIDER:'console',INVITE_ONLY:'true',OPEN_ALERT_LOCAL_TEST:'1',...(process.env.OPEN_ALERT_TEST_NODE_MODULES?{OPEN_ALERT_TEST_NODE_MODULES:process.env.OPEN_ALERT_TEST_NODE_MODULES}:{})};
  const launchEnv={...process.env},cachedLib=join(homedir(),'.cache/okx-browser-check/lib');
  try{await access(join(cachedLib,'libXdamage.so.1'));launchEnv.LD_LIBRARY_PATH=[cachedLib,process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');}catch{}
  browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL,headless:true,env:launchEnv});console.log(`REAL local integration — Chromium ${browser.version()} — compiled Node + dist/web`);
  await journey('01 actual operator CLI invitation and compiled Node launch',async()=>{
    const probe=launch([...preloads,...marketPreload,'--input-type=module','-e',`
      import assert from 'node:assert/strict';
      import { Socket } from 'node:net';
      await assert.rejects(fetch('https://example.invalid/egress-probe'),/Unexpected outbound fetch blocked/);
      assert.throws(()=>new Socket().connect(443,'example.invalid'),/All outbound sockets blocked/);
      process.send({type:'guard-probe-passed',fetchDenied:true,socketDenied:true});
    `],'egress-guard-probe');
    await check('fetch and socket guards reject before any external egress with CCXT fixtures installed',async()=>{
      assert.deepEqual(await waitExit(probe,process.platform==='win32'?12000:4000),{code:0,signal:null},probe.logs);
      assert.equal(guardProbes.filter(m=>m.type==='blocked').length,2);
      assert(guardProbes.some(m=>m.type==='guard-probe-passed'&&m.fetchDenied&&m.socketDenied));
    });
    const cli=launch([...preloads,join(root,'scripts/admin-invite.ts'),'alice@example.test'],'operator-invite-cli');
    const exit=await waitExit(cli,process.platform==='win32'?12000:4000);await check('operator CLI exits zero and creates invitation',async()=>{assert.deepEqual(exit,{code:0,signal:null},cli.logs);assert.match(cli.logs,/Invitation created for alice@example.test/);});
    await startServer();alice=await profile();bob=await profile(true);
    await check('unauthenticated real API denied',async()=>assert.equal((await api(bob.context,'/api/status')).status,401));
    await check('uninvited OTP refused without email',async()=>{const r=await api(bob.context,'/api/auth/email-otp/send-verification-otp','POST',{email:'uninvited@example.test',type:'sign-in'});assert.equal(r.status,403);assert(!messages.some(m=>m.to==='uninvited@example.test'));});
  });
  await journey('02 browser submits real generated OTP and authentic session cookie',async()=>{
    const otp=await login(alice,'alice@example.test',true);
    const status=await ok(alice.context,'/api/status');aliceId=status.user.id;sessionCookie=(await alice.context.cookies(origin)).find(c=>c.name==='better-auth.session_token').value;
    await check('invited normalized verified user starts without admin privilege',async()=>{assert.equal(status.user.email,'alice@example.test');assert.equal(status.user.role,'user');assert.equal(status.settings.enabled,false);});
    await check('real OTP replay rejected',async()=>assert.equal((await api(alice.context,'/api/auth/sign-in/email-otp','POST',{email:'alice@example.test',otp})).status,400));
    await check('cookie unavailable to JS and no token storage',async()=>assert.deepEqual(await alice.page.evaluate(()=>({cookie:document.cookie,local:Object.keys(localStorage),session:Object.keys(sessionStorage)})),{cookie:'',local:[],session:[]}));
    await alice.page.reload();await check('reload retains authenticated UI',()=>expect(alice.page.getByRole('button',{name:'退出登录'})).toBeVisible());
    const tampered=await browser.newContext();try{await tampered.addCookies([{name:'better-auth.session_token',value:sessionCookie.slice(0,-1)+(sessionCookie.endsWith('A')?'B':'A'),url:origin}]);await check('modified signature cannot authenticate',async()=>assert.equal((await api(tampered,'/api/status')).status,401));}finally{await tampered.close();}
  });
  await journey('03 authenticated one-use bootstrap and real admin invitation',async()=>{
    await check('bootstrap requires session even with bearer',async()=>assert.equal((await api(bob.context,'/api/admin/bootstrap','POST',{}, {authorization:`Bearer ${environment.BOOTSTRAP_TOKEN}`})).status,401));
    await check('bootstrap rejects incorrect bearer',async()=>assert.equal((await api(alice.context,'/api/admin/bootstrap','POST',{}, {authorization:'Bearer incorrect-local-token'})).status,403));
    await ok(alice.context,'/api/admin/bootstrap','POST',{}, {authorization:`Bearer ${environment.BOOTSTRAP_TOKEN}`});
    await check('bootstrap persists admin role',async()=>assert.equal((await ok(alice.context,'/api/status')).user.role,'admin'));
    await check('bootstrap cannot be repeated',async()=>assert.equal((await api(alice.context,'/api/admin/bootstrap','POST',{}, {authorization:`Bearer ${environment.BOOTSTRAP_TOKEN}`})).status,409));
    await alice.page.reload();await nav(alice.page,'管理');await alice.page.getByLabel('受邀邮箱').fill('bob@example.test');await alice.page.getByRole('button',{name:'创建邮箱邀请'}).click();
    await check('admin UI creates actual invitation',()=>expect(alice.page.getByRole('status').filter({hasText:'已创建 bob@example.test'})).toBeVisible());
    await login(bob,'bob@example.test');bobId=(await ok(bob.context,'/api/status')).user.id;
    await check('second tenant has distinct identity and cannot list admin users',async()=>{assert.notEqual(aliceId,bobId);assert.equal((await api(bob.context,'/api/admin/users')).status,403);});
  });
  await journey('04 real browser alert CRUD, CAS and tenant-scoped resource guards',async()=>{
    await nav(alice.page,'行情与警报');
    await check('public factory catalogs all three venues and both products without trade demand',async()=>{
      const catalog=await ok(alice.context,'/api/markets');assert.equal(catalog.stale,false);assert.equal(catalog.markets.length,12);
      for(const venue of ['binance','okx','mexc'])for(const type of ['spot','swap'])assert.equal(catalog.markets.filter(m=>m.venue===venue&&m.type===type&&m.available).length,2);
      assert.equal(transport.filter(e=>e.operation==='trades').length,0);
      assert(fixtureReady.some(e=>e.child===server.label));
    });
    aliceAlert=await createAlert(alice,'LOCAL Alice alert','BTC-USDT-SWAP',61000);bobAlert=await createAlert(bob,'LOCAL Bob alert','ETH-USDT-SWAP',4000,false);
    await check('tenants list only their own alerts',async()=>{assert.deepEqual((await ok(alice.context,'/api/alerts')).alerts.map(a=>a.id),[aliceAlert.id]);assert.deepEqual((await ok(bob.context,'/api/alerts')).alerts.map(a=>a.id),[bobAlert.id]);});
    for(const [method,path,body] of [['PATCH',`/api/alerts/${aliceAlert.id}`,{expectedGeneration:0,name:'intrusion'}],['DELETE',`/api/alerts/${aliceAlert.id}`,{expectedGeneration:0}],['POST',`/api/alerts/${aliceAlert.id}/rearm`,{expectedGeneration:0}]])await check(`Bob ${method} Alice resource denied`,async()=>assert.equal((await api(bob.context,path,method,body)).status,404));
    await row(alice.page,'LOCAL Alice alert').getByRole('button',{name:'编辑',exact:true}).click();await alice.page.getByRole('dialog').getByLabel('警报名称').fill('LOCAL Alice persisted');await alice.page.getByRole('button',{name:'保存警报',exact:true}).click();await expect(row(alice.page,'LOCAL Alice persisted')).toBeVisible();
    await check('database increments generation on UI edit',async()=>{aliceAlert=(await ok(alice.context,'/api/alerts')).alerts[0];assert.equal(aliceAlert.generation,1);});
    await check('stale generation rejected by real repository',async()=>assert.equal((await api(alice.context,`/api/alerts/${aliceAlert.id}`,'PATCH',{expectedGeneration:0,name:'stale'})).status,409));
    await check('paused accounts and disabled rules create no trade demand or prices',async()=>{
      assert.equal(bobAlert.enabled,false);
      assert.deepEqual((await ok(alice.context,'/api/status')).prices,[]);assert.deepEqual((await ok(bob.context,'/api/status')).prices,[]);
      assert.equal(transport.filter(e=>e.operation==='trades').length,0);
    });
    await check('mobile real UI has no horizontal overflow',async()=>assert(await bob.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)));
  });
  await journey('05 isolated settings, encrypted channel and local provider test',async()=>{
    await nav(alice.page,'手机通知');await alice.page.getByLabel('Pushover 用户密钥').fill('LOCALUSER'.padEnd(30,'1'));await chooseSelect(alice.page,'应用令牌来源','private');await alice.page.getByLabel(/^个人应用令牌/).fill('LOCALTOKEN'.padEnd(30,'2'));await alice.page.getByRole('button',{name:'保存通知渠道'}).click();await expect(alice.page.locator('[data-sonner-toast]').filter({hasText:'通知渠道已保存'})).toBeVisible();
    await check('saving channel does not deliver a notification',async()=>assert.equal(transport.filter(e=>e.operation==='message').length,0));
    await alice.page.getByLabel('每日通知尝试上限').fill('7');await alice.page.getByRole('button',{name:'保存提醒设置'}).click();await expect(alice.page.locator('[data-sonner-toast]').filter({hasText:'通知设置已保存'})).toBeVisible();
    await check('channel metadata and settings do not leak to Bob',async()=>{const own=await ok(alice.context,'/api/status'),other=await ok(bob.context,'/api/status');assert.equal(own.channel.privateTokenPresent,true);assert.equal(own.settings.dailyLimit,7);assert.equal(other.channel.configured,false);assert.equal(other.channel.userKeyPresent,false);assert.equal(other.settings.dailyLimit,20);assert.equal(JSON.stringify(own).includes('LOCALUSER'),false);});
    await alice.page.getByRole('button',{name:'发送测试通知',exact:true}).click();await alice.page.getByRole('dialog').getByRole('button',{name:'确认发送测试'}).click();await expect(alice.page.locator('[data-sonner-toast]').filter({hasText:'测试通知已交给 Pushover'})).toBeVisible();
    await check('compiled provider sends once only through fake transport',async()=>{assert.equal(transport.filter(e=>e.operation==='message').length,1);assert.equal(transport.find(e=>e.operation==='message').priority,'0');assert.equal((await ok(alice.context,'/api/status')).daily.attempts,1);assert.equal((await ok(bob.context,'/api/status')).daily.attempts,0);});
    const db=new DatabaseSync(environment.SQLITE_PATH,{readOnly:true});
    try {
      await check('database stores encrypted keys and consumes both invitations',async()=>{const channel=db.prepare('SELECT user_key_json,private_token_json FROM channels WHERE user_id=?').get(aliceId);assert(channel);assert.equal(JSON.stringify(channel).includes('LOCALUSER'),false);assert.equal(JSON.stringify(channel).includes('LOCALTOKEN'),false);assert.equal(JSON.parse(channel.user_key_json).algorithm,'A256GCM');assert.equal(db.prepare('SELECT COUNT(*) AS n FROM invitations WHERE consumed_by IS NOT NULL').get().n,2);});
    } finally {db.close();}
    await nav(alice.page,'行情与警报');await alice.page.getByRole('switch').click();await expect(alice.page.getByRole('switch')).toHaveAttribute('aria-checked','true');
    await check('only active rule demand yields fresh tenant-scoped CCXT Pro prices',async()=>{
      await until(async()=>{const status=await ok(alice.context,'/api/status');return status.prices.some(p=>p.instrument==='BTC-USDT-SWAP'&&p.price===60000);},'active CCXT Pro BTC observation');
      assert.deepEqual((await ok(alice.context,'/api/status')).prices.map(p=>p.instrument),['BTC-USDT-SWAP']);
      assert.deepEqual((await ok(bob.context,'/api/status')).prices,[]);
      const calls=transport.filter(e=>e.operation==='trades');assert(calls.length>0);
      assert(calls.every(e=>e.method==='watchTrades'&&e.venue==='okx'&&e.symbol==='BTC/USDT:USDT'));
      assert.equal(transport.filter(e=>e.operation==='message').length,1);
    });
    await ok(alice.context,`/api/alerts/${aliceAlert.id}`,'PATCH',{expectedGeneration:aliceAlert.generation,threshold:59000});
    aliceAlert=(await ok(alice.context,'/api/alerts')).alerts[0];
    await check('real shared scheduler latches breached alert and delivers through local transport',async()=>{await until(async()=>{const a=(await ok(alice.context,'/api/alerts')).alerts[0];return a.last?.outcome==='sent'&&a.triggered&&!a.pending;},'scheduler delivery',8000);assert.equal(transport.filter(e=>e.operation==='message').length,2);assert.equal(transport.filter(e=>e.operation==='message').at(-1).priority,'2');const a=(await ok(alice.context,'/api/alerts')).alerts[0];assert.equal(a.status,'latched');assert.equal(a.last.receiptAvailable,true);assert.equal(JSON.stringify(a).includes('LOCALRECEIPT'),false);});
    await check('scheduler delivery charges only owner quota',async()=>{assert.equal((await ok(alice.context,'/api/status')).daily.attempts,2);assert.equal((await ok(bob.context,'/api/status')).daily.attempts,0);assert.equal((await ok(bob.context,'/api/alerts')).alerts[0].triggered,false);});
    await alice.page.getByRole('switch').click();await alice.page.getByRole('dialog').getByRole('button',{name:'暂停监控',exact:true}).click();await expect(alice.page.getByRole('switch')).toHaveAttribute('aria-checked','false');
  });
  await journey('06 actual process restart persists sessions, roles, alerts and quotas',async()=>{
    await stopServer();const tradeCallsBeforeRestart=transport.filter(e=>e.operation==='trades').length;await startServer();
    await check('restart loads four fresh product/venue catalogs and retains idle demand',async()=>{
      const catalog=await ok(alice.context,'/api/markets');assert.equal(catalog.stale,false);assert.equal(catalog.markets.length,12);
      assert.deepEqual(transport.filter(e=>e.child===server.label&&e.operation==='catalog').map(e=>e.venue).sort(),['binance','binance','mexc','okx']);
      assert.equal(transport.filter(e=>e.operation==='trades').length,tradeCallsBeforeRestart);
      assert.deepEqual((await ok(alice.context,'/api/status')).prices,[]);assert.deepEqual((await ok(bob.context,'/api/status')).prices,[]);
    });
    await alice.page.reload();await bob.page.reload();await expect(alice.page.getByRole('button',{name:'退出登录'})).toBeVisible();await expect(row(bob.page,'LOCAL Bob alert')).toBeVisible();
    await check('restart retains same genuine cookie and identities',async()=>{assert.equal((await alice.context.cookies(origin)).find(c=>c.name==='better-auth.session_token').value,sessionCookie);assert.equal((await ok(alice.context,'/api/status')).user.id,aliceId);assert.equal((await ok(bob.context,'/api/status')).user.id,bobId);});
    await check('restart retains admin role, settings, channel and daily count',async()=>{const status=await ok(alice.context,'/api/status');assert.equal(status.user.role,'admin');assert.equal(status.settings.dailyLimit,7);assert.equal(status.channel.privateTokenPresent,true);assert.equal(status.daily.attempts,2);});
    await check('restart retains alert generation and isolated tenant lists',async()=>{assert.deepEqual((await ok(alice.context,'/api/alerts')).alerts.map(a=>[a.id,a.name,a.generation]),[[aliceAlert.id,'LOCAL Alice persisted',2]]);assert.deepEqual((await ok(bob.context,'/api/alerts')).alerts.map(a=>a.id),[bobAlert.id]);});
    await check('restart preserves latch and does not duplicate delivery',async()=>{const alert=(await ok(alice.context,'/api/alerts')).alerts[0];assert.equal(alert.triggered,true);assert.equal(alert.last.outcome,'sent');assert.equal(alert.last.receiptAvailable,true);assert.equal(transport.filter(e=>e.operation==='message').length,2);});
    await check('restart retains one-use bootstrap consumption',async()=>assert.equal((await api(alice.context,'/api/admin/bootstrap','POST',{}, {authorization:`Bearer ${environment.BOOTSTRAP_TOKEN}`})).status,409));
    await check('restart retains real OTP resend cooldown',async()=>assert.equal((await api(bob.context,'/api/auth/email-otp/send-verification-otp','POST',{email:'bob@example.test',type:'sign-in'})).status,429));
    await check('restart retains test notification cooldown',async()=>{assert.equal((await api(alice.context,'/api/test-notification','POST',{confirm:true})).status,429);assert.equal(transport.filter(e=>e.operation==='message').length,2);});
    await check('retained encrypted channel decrypts and validates after restart',async()=>{const before=transport.filter(e=>e.operation==='validate').length;await ok(alice.context,'/api/channels','PUT',{provider:'pushover'});assert.equal(transport.filter(e=>e.operation==='validate').length,before+1);});
  });
  await journey('07 real UI delete and server-side logout revocation',async()=>{
    await nav(alice.page,'行情与警报');await row(alice.page,'LOCAL Alice persisted').getByRole('button',{name:'删除',exact:true}).click();await alice.page.getByRole('dialog').getByRole('button',{name:'删除警报',exact:true}).click();await check('UI deletion persisted in actual database',async()=>{await expect(row(alice.page,'LOCAL Alice persisted')).toHaveCount(0);assert.equal((await ok(alice.context,'/api/alerts')).alerts.length,0);assert.equal((await ok(bob.context,'/api/alerts')).alerts.length,1);});
    await alice.page.getByRole('button',{name:'退出登录'}).click();await expect(alice.page.getByRole('heading',{name:'登录或注册'})).toBeVisible();
    await check('logout removes real cookie',async()=>assert(!(await alice.context.cookies(origin)).some(c=>c.name==='better-auth.session_token')));
    const replay=await browser.newContext();try{await replay.addCookies([{name:'better-auth.session_token',value:sessionCookie,url:origin}]);await check('copied pre-logout cookie revoked in database',async()=>assert.equal((await api(replay,'/api/status')).status,401));}finally{await replay.close();}
    await check('other tenant remains authenticated after Alice logout',async()=>assert.equal((await ok(bob.context,'/api/status')).user.id,bobId));
    await check('browser has no runtime exceptions',async()=>assert.deepEqual(browserErrors,[]));await check('no unexpected external traffic attempts',async()=>assert.deepEqual(violations,[]));
    await check('compiled server uses only public CCXT method fixtures for exchange work',async()=>{
      assert(transport.filter(e=>e.provider==='ccxt-method-fixture'&&e.operation==='catalog').length>=6);
      assert(transport.filter(e=>e.provider==='ccxt-method-fixture'&&e.operation==='trades').every(e=>e.method==='watchTrades'));
      assert(transport.every(e=>['ccxt-method-fixture','display-quote-fixture','pushover'].includes(e.provider)));
    });
  });
} catch(error) { console.error(error.stack);process.exitCode=1; }
finally {
  try{await browser?.close();}catch(error){cleanupErrors.push(error.message);}
  try{await stopServer();}catch(error){cleanupErrors.push(error.message);}
  for(const record of children)if(!record.exit){cleanupErrors.push(`${record.label} required forced cleanup`);record.child.kill('SIGKILL');try{await waitExit(record,1000);}catch(error){cleanupErrors.push(error.message);}}
  clearTimeout(watchdog);
  if(Object.keys(compiledInputs).length)try{assert.deepEqual(await fingerprints(),compiledInputs,'Source/build inputs changed during compiled integration');}catch(error){cleanupErrors.push(error.message);}
  if(timedOut)cleanupErrors.push('55 second integration deadline exceeded');
  if(cleanupErrors.length){console.error('Cleanup failures:',cleanupErrors);process.exitCode=1;}
  if(directory)await rm(directory,{recursive:true,force:true});
  const evidence={mode:'REAL_LOCAL',scope:'Compiled Node entry point + actual dist/web, real SQLite/Better Auth OTP/session cookies, API and scheduler; public CCXT Pro methods and outbound notification fetch substituted only in test children',passed:results.length===7&&results.every(r=>r.passed)&&!process.exitCode,assertions,journeys:results,apiRequests,generatedOtpEmails:messages.filter(m=>m.otp).length,localEmailMessages:messages.length,providerCalls:transport,fixtureReady,compiledInputs,guardEvidence:{guardProbes,browserBlocked,unexpectedAttempts:violations.length},dependencyCache:process.env.OPEN_ALERT_TEST_NODE_MODULES??null,childExits:children.map(({label,exit})=>({label,...exit})),browserErrors,violations,cleanupErrors,durationMs:Date.now()-startedAt,limitations:['SQLite only; PostgreSQL and Cloudflare not covered by this script','Console fakeemail captures real generated OTP; SMTP/Resend external delivery not tested','Public CCXT Pro classes use test-only loadMarkets/watchTrades/fetchTrades fixtures for Binance/OKX/MEXC; HTTP/WS exchange parsers and live connectivity are not covered','Pushover is a local process fetch substitute; no live provider requests','TradingView embed blocked; mobile is Chromium iPhone emulation, not iOS Safari','Built assets and compiled server must be rebuilt before execution']};
  await writeFile(join(outputs,'open-alert-browser-check-results-LOCAL.json'),JSON.stringify(evidence,null,2)+'\n');
  console.log(`REAL local result: ${results.filter(r=>r.passed).length}/7 journeys, ${assertions} successful checks; ${apiRequests} actual API requests; ${messages.filter(m=>m.otp).length} real generated OTP emails; cleanup failures=${cleanupErrors.length}; ${evidence.durationMs}ms`);
}

async function chooseSelect(page,label,value) {
  await page.getByRole('combobox',{name:label,exact:true}).click();
  await page.locator('[role="option"][data-value="'+value+'"]').click();
}
