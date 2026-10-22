/** Bounded whole-product verification. API and prices below are MOCK. */
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
process.env.OPEN_ALERT_FIXTURE_SERVER_ONLY='1';
const {setup,server,origin,nav,runtimeErrors,violations}=await import('./browser-mock-check.mjs');
const {chromium}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
const out=path.resolve(process.env.OPEN_ALERT_BROWSER_OUTPUT_DIR||'.impeccable/review/system-confirmation');await mkdir(out,{recursive:true});
const browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL||'chrome',headless:true});
const results=[];
const profiles=[['wide',1440,'zh-CN','dark'],['compact',1080,'en-GB','light'],['tablet',768,'zh-CN','dark'],['phone',390,'en-GB','dark'],['small',320,'zh-CN','light']];
async function capture(p,name){
 await p.evaluate(()=>document.fonts.ready);
 await p.locator('#mock-label').evaluate(n=>n.style.cssText='position:static;display:block;text-align:center;background:#ffdd7a;color:#15222f;font:700 11px/22px sans-serif;pointer-events:none');
 const bounds=await p.evaluate(()=>({viewport:innerWidth,width:document.documentElement.scrollWidth}));assert(bounds.width<=bounds.viewport+1,name+' page overflow');
 await p.screenshot({path:path.join(out,name+'-MOCK.png'),fullPage:true,animations:'disabled'});results.push({name,...bounds});
}
async function ready(p,route){await p.goto(origin+route);await p.locator('[data-slot="boot-stage"]').waitFor({state:'detached',timeout:25000});}
try{
 for(const [name,width,locale,colorScheme] of profiles){
  const f=await setup(browser,width<=900?'mobile':'desktop',true,{viewport:{width,height:900},locale,colorScheme,reducedMotion:'reduce'}),p=f.page,s=f.state;
  const en=locale.startsWith('en');s.status.user.role='admin';s.status.capabilities.canAdmin=true;
  s.markets[0].base='VERYLONGTOKEN';s.alerts[0].name='A long alert name / 一个需要正常换行的警报名称';
  await ready(p,'/dashboard');
  const hero=await p.locator('.signal-hero').evaluate(n=>{const outer=n.getBoundingClientRect();return {bottom:outer.bottom,price:n.querySelector('.price-block').getBoundingClientRect().bottom,telemetry:n.querySelector('.telemetry-stack').getBoundingClientRect().bottom};});
  assert(hero.price<=hero.bottom+1&&hero.telemetry<=hero.bottom+1,name+' signal content must not be clipped');
  if(width>900){
   const bounds=await p.locator('.alerts-panel .panel-heading').evaluate(n=>{const h=n.getBoundingClientRect(),t=n.querySelector('.alert-scope').getBoundingClientRect();return {right:h.right,scope:t.right,width:n.clientWidth,scroll:n.scrollWidth};});
   assert(bounds.scope<=bounds.right+1&&bounds.scroll<=bounds.width+1,name+' alert header overflow');
  }
  const trigger=p.locator('.signal-hero-main .market-search-trigger');
  const field=await trigger.evaluate(n=>({scroll:n.scrollWidth,width:n.clientWidth}));assert(field.scroll<=field.width+1,name+' market identity overflow');
  await capture(p,name+'-dashboard');
  await trigger.click();const search=p.locator('[cmdk-input]');await search.waitFor({state:'visible'});
  const focus=await search.evaluate(n=>({outline:getComputedStyle(n).outlineStyle,shadow:getComputedStyle(n).boxShadow,wrapper:getComputedStyle(n.parentElement).boxShadow}));assert.equal(focus.outline,'none');assert.equal(focus.shadow,'none');assert.notEqual(focus.wrapper,'none');
  await capture(p,name+'-market-search');
  await p.getByRole('combobox',{name:en?'Exchange':'交易所',exact:true}).click();await p.locator('[data-slot="select-content"]').waitFor({state:'visible'});await capture(p,name+'-nested-select');await p.keyboard.press('Escape');await p.keyboard.press('Escape');
  await p.getByRole('button',{name:en?'Create alert':'创建警报',exact:true}).click();await p.getByRole('dialog').waitFor({state:'visible'});await capture(p,name+'-editor');await p.keyboard.press('Escape');await p.getByRole('dialog').waitFor({state:'detached'});
  for(const route of ['/alerts','/notifications','/account','/admin']){await ready(p,route);if(route==='/account')assert.equal(await p.locator('.runtime-health .health-row').count(),4);await capture(p,name+route.replace('/','-'));}
  await f.context.close();
  const login=await setup(browser,width<=900?'mobile':'desktop',false,{viewport:{width,height:900},locale,colorScheme,reducedMotion:'reduce'});login.state.googleEnabled=true;await ready(login.page,'/login');
  await login.page.locator('.login-proof-row [data-quote-state="ready"]').first().waitFor();assert.equal(await login.page.locator('.login-proof-row [data-quote-state="ready"]').count(),3);assert(await login.page.locator('.login-proof-row').isVisible());await capture(login.page,name+'-login');await login.context.close();
 }
 // The user's exact interaction must have no sliding marker, list animation,
 // page reveal replay, or changes to the saved rules.
 const f=await setup(browser,'desktop',true,{reducedMotion:'no-preference'}),p=f.page;await ready(p,'/dashboard');await p.locator('.dashboard-v2[data-motion-state="settled"]').waitFor();
 const runs=await p.locator('.dashboard-v2').getAttribute('data-motion-runs');const rules=JSON.stringify(f.state.alerts);
 for(const label of ['全部警报','当前市场','全部警报','当前市场']){
  await p.getByRole('tab',{name:label,exact:true}).click();
  assert.equal(await p.locator('.alert-scope .segment-indicator').count(),0);
  assert.equal(await p.locator('.alert-scope').evaluate(n=>n.getAnimations({subtree:true}).length),0);
  assert.equal(await p.locator('.dashboard-v2').getAttribute('data-motion-runs'),runs);assert.equal(JSON.stringify(f.state.alerts),rules);
 }
 await f.context.close();
 const loading=await setup(browser,'desktop',false,{reducedMotion:'no-preference'});let release;loading.state.holdSession={wait:new Promise(r=>release=r)};await loading.page.goto(origin+'/login');await loading.page.locator('.boot-status [data-slot="spinner"]').waitFor();
 const frames=await loading.page.locator('.boot-status [data-slot="spinner"]').evaluate(async n=>{const values=new Set([n.textContent]);await new Promise(resolve=>{let i=0;const timer=setInterval(()=>{values.add(n.textContent);if(++i===5){clearInterval(timer);resolve();}},100);});return values.size;});assert(frames>1,'Boot must use the shared animated braille loader');await capture(loading.page,'boot-loading');release();await loading.page.locator('[data-slot="boot-stage"]').waitFor({state:'detached'});
 const before=await loading.page.locator('.login-trace-line').getAttribute('d');loading.state.previewRevision=7;await loading.page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));await loading.page.waitForFunction(old=>document.querySelector('.login-trace-line')?.getAttribute('d')!==old,before,{timeout:10000});
 loading.state.publicPreviewFail=true;await loading.page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));await loading.page.locator('.login-proof-row [data-quote-state="stale"]').first().waitFor();assert(await loading.page.locator('#login-email').isEnabled());await capture(loading.page,'login-stale');await loading.context.close();
 assert.deepEqual(runtimeErrors,[]);assert.deepEqual(violations,[]);await writeFile(path.join(out,'system-check-MOCK.json'),JSON.stringify({passed:true,profiles,captures:results,checks:['long identities','header bounds','search wrapper focus','nested popovers','4 measured health components','3 public quotes','static alert filtering','boot braille frames','trade trace updates','quote failure preserves login'],runtimeErrors,violations},null,2));console.log(JSON.stringify({passed:true,captures:results.length,profiles:profiles.length,runtimeErrors:runtimeErrors.length}));
}finally{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
