/** D3/M4 alignment and usable OTP states against the actual dist/web UI; API is MOCK. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
process.env.OPEN_ALERT_FIXTURE_SERVER_ONLY = '1';
const { setup, server, origin, runtimeErrors, violations } = await import('./browser-mock-check.mjs');
const playwright = process.env.PLAYWRIGHT_MODULE || resolve('node_modules/playwright/index.mjs');
const { chromium } = await import(pathToFileURL(playwright).href);
const { expect } = await import(pathToFileURL(join(dirname(playwright), 'test.mjs')).href);
const output = resolve(process.env.OPEN_ALERT_BROWSER_OUTPUT_DIR || '.impeccable/review/login');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
const evidence = { mode: 'MOCK', reference: 'Final handoff D3 1440x900 and M4', captures: [], checks: [] };
async function snapshot(page, name) {
  await page.evaluate(() => document.fonts.ready);
  const geometry = await page.evaluate(() => {
    const box = selector => {
      const n = document.querySelector(selector), r = n.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height, bottom: r.bottom };
    };
    return { viewport: innerWidth, content: document.documentElement.scrollWidth, title: box('.login-intro h1'), panel: box('.login-panel'), access: box('.login-access'), trace: box('.login-signal-field'), tickers: box('.login-proof-row'), brand: box('.public-masthead .brand'), email: box('.login-panel input'), submit: box('.login-panel .primary') };
  });
  assert(geometry.content <= geometry.viewport + 1, name + ': horizontal overflow');
  assert(geometry.email.height >= 48 && geometry.submit.height >= 48, name + ': 48px input/action targets');
  await page.screenshot({ path: join(output, name + '.png'), fullPage: true, animations: 'disabled' });
  evidence.captures.push({ name, ...geometry });
  return geometry;
}
try {
  for (const [name, width, height, locale, colorScheme] of [
    ['desktop-login-MOCK', 1440, 900, 'zh-CN', 'dark'],
    ['desktop-login-tall-MOCK', 1440, 1000, 'zh-CN', 'dark'],
    ['desktop-login-wide-MOCK', 2220, 1244, 'zh-CN', 'dark'],
    ['desktop-login-compact-MOCK', 1024, 768, 'en-GB', 'dark'],
    ['desktop-login-light-MOCK', 1440, 900, 'en-GB', 'light'],
    ['mobile-login-MOCK', 390, 844, 'zh-CN', 'dark'],
    ['mobile-login-light-MOCK', 390, 844, 'en-GB', 'light'],
  ]) {
    const f = await setup(browser, width <= 900 ? 'mobile' : 'desktop', false, { viewport: { width, height }, locale, colorScheme, reducedMotion: 'reduce' });
    f.state.googleEnabled = true;
    const p = f.page;
    await p.goto(origin + '/login');
    await p.locator('[data-slot="boot-stage"]').waitFor({ state: 'detached', timeout: 20000 });
    const g = await snapshot(p, name);
    if (width === 1440 && locale === 'zh-CN') {
      // Approved D3 uses a full-height 920/520 split with fixed top anchors.
      for (const [actual, expected] of [[g.title.x, 56], [g.title.y, 160], [g.panel.x, 977], [g.panel.y, 174], [g.panel.width, 407], [g.trace.y, 420], [g.trace.height, 260], [g.trace.width, 920], [g.tickers.width, 808], [g.access.y, 0]]) assert(Math.abs(actual - expected) < 1, `${name}: ${actual} != D3 ${expected}`);
      assert(g.tickers.height < 80, 'Availability must not add a third ticker row');
      assert.equal(await p.locator('.login-panel .setup-link').count(), 0, 'Desktop help belongs outside the form card');
      assert(Math.abs(g.panel.height - 484) < 3, `D3 panel height ${g.panel.height}`);
      evidence.checks.push(name + ': D3 anchors, card dimensions, trace band, compact tickers');
    }
    if (name === 'mobile-login-MOCK') {
      await p.getByRole('button', { name: '登录遇到问题？', exact: true }).click();
      await expect(p.locator('#login-help')).toBeVisible();
      await p.getByLabel('邮箱地址').fill('mock@example.test');
      await p.getByRole('button', { name: '发送验证码', exact: true }).click();
      await expect(p.getByRole('heading', { name: '验证邮箱', exact: true })).toBeVisible();
      await p.getByLabel('邮件中的验证码').fill('000000');
      await p.getByRole('button', { name: '验证并继续', exact: true }).click();
      await expect(p.getByRole('alert')).toBeVisible();
      await snapshot(p, 'mobile-login-otp-error-help-MOCK');
      await p.reload();
      await expect(p.getByRole('heading', { name: '验证邮箱', exact: true })).toBeVisible();
      await p.getByLabel('邮件中的验证码').fill('123456');
      await p.getByRole('button', { name: '验证并继续', exact: true }).click();
      await expect(p.getByRole('switch', { name: '监控总开关' })).toBeVisible();
      evidence.checks.push('M4: expanded help, invalid OTP, reload recovery and successful sign-in remain usable');
    }
    await f.context.close();
  }
  assert.deepEqual(runtimeErrors, []);
  assert.deepEqual(violations, []);
  evidence.passed = true;
} finally {
  await writeFile(join(output, 'login-layout-MOCK.json'), JSON.stringify({ ...evidence, runtimeErrors, violations }, null, 2));
  await browser.close(); server.closeAllConnections(); await new Promise(r => server.close(r));
}
console.log(`Login layout: ${evidence.captures.length} captures passed; D3 geometry and mobile OTP/error/help verified; runtime errors=${runtimeErrors.length}`);
