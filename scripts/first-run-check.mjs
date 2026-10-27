/** MOCK first-run guide captures against dist/web: fresh account, midway, complete. */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
process.env.OPEN_ALERT_FIXTURE_SERVER_ONLY = '1';
const { setup, server, runtimeErrors, origin } = await import('./browser-mock-check.mjs');
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE || resolve('node_modules/playwright/index.mjs')).href);
const output = resolve(process.env.OPEN_ALERT_BROWSER_OUTPUT_DIR || 'work/first-run');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL, headless: true });
const fresh = state => { state.alerts = []; state.status.channel = { ...state.status.channel, configured: false, userKeyPresent: false, privateTokenPresent: false, tokenSource: 'none' }; state.status.settings.enabled = false; };
try {
  for (const profile of ['desktop', 'mobile']) for (const theme of profile === 'desktop' ? ['dark', 'light'] : ['dark']) {
    const f = await setup(browser, profile, true, { colorScheme: theme });
    fresh(f.state);
    await f.page.goto(origin + '/dashboard');
    const guide = f.page.getByRole('region', { name: '三步开始价格监控' });
    await guide.waitFor();
    assert.equal(await guide.locator('[aria-current="step"]').innerText().then(s => s.includes('连接手机通知')), true);
    // Desktop shows waiting steps disabled; mobile collapses them to one summary row.
    const later = guide.getByRole('button', { name: '创建第一条警报' });
    if (profile === 'desktop') assert.equal(await later.isDisabled(), true); else assert.equal(await later.isVisible(), false);
    const width = await f.page.evaluate(() => ({ v: innerWidth, c: document.documentElement.scrollWidth }));
    assert(width.c <= width.v + 1, 'overflow ' + JSON.stringify(width));
    await f.page.waitForTimeout(700);
    await f.page.screenshot({ path: join(output, `first-run-${profile}-${theme}-step1-MOCK.png`), fullPage: profile === 'mobile', animations: 'disabled' });
    // Midway: channel saved, no alert yet.
    f.state.status.channel = { ...f.state.status.channel, configured: true, userKeyPresent: true, tokenSource: 'shared' };
    await f.page.reload(); await guide.waitFor();
    assert.equal(await guide.locator('[aria-current="step"]').innerText().then(s => s.includes('设置第一条价格警报')), true);
    await guide.getByRole('button', { name: '创建第一条警报' }).click();
    await f.page.getByRole('dialog').waitFor(); await f.page.keyboard.press('Escape');
    await f.page.waitForTimeout(700);
    if (profile === 'desktop' && theme === 'dark') await f.page.screenshot({ path: join(output, `first-run-${profile}-${theme}-step2-MOCK.png`), animations: 'disabled' });
    await guide.getByRole('button', { name: '收起引导' }).click();
    assert.equal(await guide.locator('ol').count(), 0);
    // Complete: guide disappears.
    f.state.alerts = [ { id:'a1', name:'BTC', instrument:'BTC-USDT-SWAP', side:'upper', threshold:61000, enabled:true, generation:0, triggered:false, triggerId:null, pending:null, last:null, status:'armed', createdAt:Date.now(), updatedAt:Date.now() } ];
    f.state.status.settings.enabled = true;
    await f.page.reload(); await f.page.getByRole('switch').waitFor();
    assert.equal(await f.page.getByRole('region', { name: '三步开始价格监控' }).count(), 0);
    console.log('PASS', profile, theme);
    await f.context.close();
  }
  // The mock server has no /api/live; the app falls back to polling.
  assert.deepEqual(runtimeErrors.filter(e => !e.includes('/api/live')), []);
} finally { await browser.close(); server.close(); }
