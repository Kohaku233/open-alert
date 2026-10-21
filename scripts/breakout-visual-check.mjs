/** Final handoff matrix against dist/web. All quotes, users and chart frames are MOCK. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
process.env.OPEN_ALERT_FIXTURE_SERVER_ONLY = '1';
const { setup, server, origin, runtimeErrors, violations, nav } = await import('./browser-mock-check.mjs');
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
const output = resolve(process.env.OPEN_ALERT_BROWSER_OUTPUT_DIR || '.impeccable/review');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
const evidence = { mode: 'MOCK', viewports: [], checks: [] };
async function capture(page, name) {
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.locator('#mock-label').evaluate(n => n.style.cssText = 'position:static;display:block;text-align:center;background:#ffdd7a;color:#15222f;font:700 11px/22px sans-serif;pointer-events:none');
  const width = await page.evaluate(() => ({ viewport: innerWidth, content: document.documentElement.scrollWidth }));
  assert(width.content <= width.viewport + 1, `${name}: horizontal overflow ${JSON.stringify(width)}`);
  if (name === 'mobile-account-MOCK' || name === 'mobile-account-light-MOCK') {
    const bounds = await page.evaluate(() => ({ logout: document.querySelector('.mobile-account-actions > button:last-child').getBoundingClientRect().bottom, dock: document.querySelector('.mobile-dock').getBoundingClientRect().top, cards: [...document.querySelectorAll('.account-grid .settings-panel')].map(n=>Math.round(n.getBoundingClientRect().width)) }));
    assert(bounds.logout <= bounds.dock, 'Logout must clear dock: ' + JSON.stringify(bounds));
    assert.equal(new Set(bounds.cards).size, 1, 'Mobile account cards must stretch equally');
  }
  if (name === 'mobile-dashboard-MOCK') {
    const bounds = await page.evaluate(() => ({ tickHidden: getComputedStyle(document.querySelector('.trace-caption')).display === 'none', dock: document.querySelector('.mobile-dock').getBoundingClientRect(), thumb: document.querySelector('.monitor-cell [data-slot="switch-thumb"]').getBoundingClientRect().width }));
    assert(bounds.tickHidden, 'Mobile trace must stay compact');
    assert.equal(bounds.dock.x, 12);
    assert.equal(bounds.thumb, 16);
  }
  if (name === 'mobile-alerts-MOCK') {
    const bounds = await page.locator('.heading-lockup h1').evaluate(n => ({height:n.getBoundingClientRect().height,font:parseFloat(getComputedStyle(n).fontSize),right:n.getBoundingClientRect().right,actions:document.querySelector('.heading-actions').getBoundingClientRect().left}));
    assert(bounds.height <= bounds.font * 1.15 && bounds.right < bounds.actions, 'Alert heading and action must fit on one row');
  }
  if (name === 'desktop-account-menu-MOCK') {
    const lines = await page.locator('.account-menu .languages button').first().evaluate(n => {const range=document.createRange();range.selectNodeContents(n);return new Set([...range.getClientRects()].map(r=>Math.round(r.y))).size;});
    assert.equal(lines, 1, 'Account menu language labels must not wrap');
  }
  await page.screenshot({ path: join(output, name + '.png'), fullPage: true, animations: 'disabled' });
  evidence.viewports.push({ name, ...width });
}
try {
  for (const profile of ['desktop', 'mobile']) {
    const f = await setup(browser, profile, true, { reducedMotion: 'reduce', ...(profile === 'desktop' ? { viewport: { width: 1440, height: 900 } } : {}) });
    const { page: p, state: s } = f;
    s.status.user.role = 'admin'; s.status.capabilities.canAdmin = true;
    s.status.settings.enabled = true;
    s.alerts = s.alerts.slice(0, 2);
    s.alerts[0].name = 'MOCK · 突破前高'; s.alerts[0].threshold = 72500;
    s.alerts[1].name = 'MOCK · 回踩支撑'; s.alerts[1].threshold = 66000; s.alerts[1].side = 'lower';
    s.quotePrice = 70876.96;
    await p.clock.install();
    await p.goto(origin + '/dashboard');
    await p.locator('[data-slot="boot-stage"]').waitFor({ state: 'detached', timeout: 20000 });
    console.log(profile,'ready');
    for (let i = 1; i <= 90; i++) {
      s.quotePrice = 70876.96 + Math.sin(i * .4) * 240 + Math.sin(i * .83) * 90;
      await p.clock.runFor(5100);
      await new Promise(r => setTimeout(r, 50));
      if (i % 30 === 0) console.log(profile, 'trace sampling', i, await p.locator('.trace-caption').innerText());
    }
    await capture(p, `${profile}-dashboard-MOCK`);
    if (profile === 'desktop') {
      await p.getByRole('button', { name: '账户菜单', exact: true }).click();
      await capture(p, 'desktop-account-menu-MOCK');
      await p.keyboard.press('Escape');
    }
    await p.getByRole('button', { name: '创建警报', exact: true }).click();
    await p.getByLabel('警报名称').fill('MOCK · 新的突破警报');
    await p.getByRole('button', { name: '+1%', exact: true }).click();
    const target = Number(await p.locator('.threshold-input').inputValue());
    assert(Math.abs(target / s.quotePrice - 1.01) < .000001);
    await capture(p, `${profile}-create-alert-MOCK`);
    await p.locator('.threshold-input').focus();
    await capture(p, `${profile}-create-alert-focused-MOCK`);
    await p.keyboard.press('Escape');
    await p.getByRole('dialog').waitFor({state:'detached'});
    await p.clock.runFor(100);
    await p.locator('.signal-hero-main .market-search-trigger').click();
    await p.clock.runFor(100);
    assert.equal(await p.locator('.signal-hero-main .market-search-trigger').getAttribute('aria-expanded'), 'true');
    await p.locator('[data-slot="popover-content"]').waitFor({state:'visible'});
    await capture(p, `${profile}-market-picker-MOCK`);
    await p.keyboard.press('Escape');
    await nav(p, '手机通知'); await capture(p, `${profile}-notifications-MOCK`);
    await nav(p, '我的账户'); await capture(p, `${profile}-account-MOCK`);
    await p.getByRole('button', { name: '浅色', exact: true }).click();
    await capture(p, `${profile}-account-light-MOCK`);
    await p.getByRole('button', { name: '深色', exact: true }).click();
    await nav(p, '管理'); await p.getByRole('heading', { name: '账户列表', exact: true }).waitFor();
    await capture(p, `${profile}-admin-MOCK`);
    await nav(p, '行情与警报');
    if (profile === 'mobile') {
      await p.locator('.mobile-dock a[href="/alerts"]').click();
      assert.equal(await p.locator('.alerts-route .alert-row').count(), s.alerts.length);
      assert(!await p.locator('.signal-hero').isVisible());
      await capture(p, 'mobile-alerts-MOCK');
    }
    evidence.checks.push(`${profile}: shortcuts, navigation, account preferences, admin, no horizontal overflow`);
    await f.context.close();
    const login = await setup(browser, profile, false, { reducedMotion: 'reduce', ...(profile === 'desktop' ? { viewport: { width: 1440, height: 900 } } : {}) });
    login.state.googleEnabled = true;
    await login.page.goto(origin + '/login');
    await login.page.locator('[data-slot="boot-stage"]').waitFor({ state: 'detached', timeout: 20000 });
    await capture(login.page, `${profile}-login-MOCK`);
    await login.context.close();
  }
  assert.deepEqual(runtimeErrors, []); assert.deepEqual(violations, []);
  evidence.passed = true;
} finally {
  await writeFile(join(output, 'breakout-matrix-MOCK.json'), JSON.stringify({ ...evidence, runtimeErrors, violations }, null, 2));
  await browser.close(); server.closeAllConnections(); await new Promise(r => server.close(r));
}
console.log(JSON.stringify(evidence));
