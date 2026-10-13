#!/usr/bin/env node
/** Isolated MOCK market UI regression. Run after npm run build:web.
 * node test/browser-market-check.mjs — optional PLAYWRIGHT_MODULE points to local Playwright.
 * All external requests are intercepted; no production login, provider traffic or notifications.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, readdir, access, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { homedir } from 'node:os';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.env.OPEN_ALERT_LOCAL_TEST = '1';
await import('../scripts/local-test-types.mjs');
const { makeBrowserFixture } = await import('./browser-fixtures.ts');
const helpers = await import('../web/markets.ts');
let playwrightPath = process.env.PLAYWRIGHT_MODULE || join(root, 'node_modules/playwright/index.mjs');
try { await access(playwrightPath); } catch { playwrightPath = join(root, '../okx-free-monitor/node_modules/playwright/index.mjs'); }
const { chromium, devices } = await import(pathToFileURL(playwrightPath).href);
const { expect } = await import(pathToFileURL(join(dirname(playwrightPath), 'test.mjs')).href);
expect.configure({ timeout: 7000 });
const evidenceDir = process.env.OPEN_ALERT_MARKET_OUTPUT_DIR || join(root, 'test/browser-market-evidence');
await mkdir(evidenceDir, { recursive: true });
const assets = new Map([['/', 'index.html'], ...['dashboard', 'login', 'account', 'notifications'].map(p => [`/${p}`, 'index.html'])]);
for (const name of await readdir(join(root, 'dist/web/assets'))) assets.set(`/assets/${name}`, `assets/${name}`);
const server = createServer(async (req, res) => {
  const asset = assets.get(new URL(req.url, 'http://localhost').pathname);
  if (!asset) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': asset.endsWith('.html') ? 'text/html' : asset.endsWith('.css') ? 'text/css' : 'application/javascript' });
  res.end(await readFile(join(root, 'dist/web', asset)));
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
const failures = [], results = [], external = [], errors = [];
let assertions = 0, browser;
async function check(name, run) { await run(); assertions++; results.push(name); }
const legacy = { instrument: 'BTC-USDT-SWAP', base: 'BTC', quote: 'USDT', tickSize: '0.1', state: 'live', tradingViewSymbol: 'OKX:BTCUSDT.P' };
const six = ['binance', 'okx', 'mexc'].flatMap(venue => ['spot', 'swap'].map(type => {
  const nativeId = venue === 'okx' ? type === 'swap' ? 'BTC-USDT-SWAP' : 'BTC-USDT' : venue === 'mexc' && type === 'swap' ? 'BTC_USDT' : 'BTCUSDT';
  return { ...legacy, venue, type, nativeId, symbol: type === 'swap' ? 'BTC/USDT:USDT' : 'BTC/USDT', settle: type === 'swap' ? 'USDT' : null, contractSize: type === 'swap' ? 1 : null,
    instrument: venue === 'okx' && type === 'swap' ? legacy.instrument : `${venue}:${type}:${encodeURIComponent(nativeId)}`, tradingViewSymbol: venue === 'okx' && type === 'swap' ? legacy.tradingViewSymbol : '' };
}));
async function setup(profile) {
  const fixture = makeBrowserFixture();
  const state = { ...fixture, markets: [legacy, ...six.filter(m => m.instrument !== legacy.instrument).map(m => ({ ...m })), ...Array.from({ length: 100 }, (_, i) => ({ ...six[0], instrument: `binance:spot:MOCK${i}USDT`, nativeId: `MOCK${i}USDT`, symbol: `MOCK${i}/USDT`, base: `MOCK${i}` })), { ...six[0], instrument: 'binance:spot:HALTUSDT', nativeId: 'HALTUSDT', symbol: 'HALT/USDT', base: 'HALT', state: 'live', available: false }], marketFail: false, stale: false, priceAge: 0, mutations: [], chartLoads: 0 };
  state.alerts = [fixture.alerts[0]];
  const context = await browser.newContext(profile === 'mobile' ? { ...devices['iPhone 15'], serviceWorkers: 'block' } : { viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
  await context.addInitScript(() => {
    document.addEventListener('DOMContentLoaded', () => { const mark = document.createElement('div'); mark.textContent = 'MOCK / 模拟数据 · 无真实行情或通知'; mark.style = 'position:fixed;top:0;left:0;right:0;background:#ffdd7a;color:#15222f;font:700 11px/22px sans-serif;text-align:center;z-index:99999;pointer-events:none'; document.body.append(mark); });
  });
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) {
      if (url.href === 'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js') {
        state.chartLoads++;
        return route.fulfill({ contentType: 'application/javascript', body: `(()=>{const frame=document.createElement('iframe');frame.title='MOCK chart';frame.srcdoc='<body style="background:#12202d;color:#a6b7c7">MOCK reference chart — no real prices</body>';frame.style='width:100%;height:100%';document.currentScript.parentElement.append(frame);})();` });
      }
      external.push(url.origin); return route.abort('blockedbyclient');
    }
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const req = route.request(), method = req.method(), path = url.pathname;
    const send = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
    const ok = data => send({ ok: true, data, requestId: 'market-mock' });
    const body = req.postData() ? req.postDataJSON() : null;
    if (path === '/api/auth/get-session') return send({ user: { ...state.status.user, emailVerified: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, session: { id: 'mock-session', userId: state.status.user.id, expiresAt: new Date(Date.now() + 86400000).toISOString(), token: 'MOCK' } });
    if (path === '/api/status') {
      const data = structuredClone(state.status); data.prices.forEach(p => { p.timestamp = Date.now() - state.priceAge; p.receivedAt = Date.now() - state.priceAge; }); return ok(data);
    }
    if (path === '/api/markets') return state.marketFail ? send({ ok: false, error: { code: 'service_unavailable', message: 'MOCK directory failure' }, requestId: 'market-mock' }, 503) : ok({ markets: state.markets, stale: state.stale, updatedAt: Date.now() });
    if (path === '/api/alerts' && method === 'GET') return ok({ alerts: state.alerts });
    if (path === '/api/alerts' && method === 'POST') {
      assert(helpers.selectableMarket(helpers.findMarket(state.markets, body.instrument)));
      state.mutations.push({ method, path, body });
      const alert = { ...fixture.alerts[0], ...body, id: `created-${state.mutations.length}` }; state.alerts.push(alert); return ok({ alert });
    }
    if (path.startsWith('/api/alerts/') && method === 'PATCH') {
      const alert = state.alerts.find(a => a.id === path.split('/').at(-1)); assert(alert); assert.equal(body.expectedGeneration, alert.generation);
      if (body.instrument !== undefined || body.enabled === true) assert(helpers.selectableMarket(helpers.findMarket(state.markets, body.instrument ?? alert.instrument)));
      state.mutations.push({ method, path, body }); Object.assign(alert, body, { generation: alert.generation + 1 }); return ok({ alert });
    }
    failures.push(`Unexpected route ${method} ${path}`); return send({ ok: false, error: { code: 'internal_error', message: 'MOCK unexpected route' }, requestId: 'market-mock' }, 500);
  });
  const page = await context.newPage(); page.setDefaultTimeout(7000); page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/dashboard'); await expect(page.getByRole('switch')).toBeVisible();
  return { page, context, state };
}
async function noOverflow(page) { const size = await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]); assert(size[0] <= size[1] + 1, JSON.stringify(size)); }
try {
  await check('legacy metadata fallback and exact chart policy', async () => {
    assert.equal(helpers.marketLabel(legacy.instrument, legacy), 'OKX · USDT 永续 · BTC / USDT');
    assert.equal(helpers.marketIdentity('UNRECOGNIZED').venue, null);
    assert.equal(helpers.marketIdentity('binance:spot:BTC%2FUSDT').nativeId, 'BTC/USDT');
    assert(helpers.verifiedChartSymbol('OKX:BTCUSDT.P', legacy));
    assert(helpers.verifiedChartSymbol('OKX:TRXUSDT.P', { ...legacy, instrument: 'TRX-USDT-SWAP', base: 'TRX' }));
    assert(!helpers.verifiedChartSymbol('OKX:TONUSDT.P'));
    for (const symbol of ['BINANCE:BTCUSDT', 'MEXC:BTCUSDT.P', 'OKX:MOCKUSDT.P', 'OKX:BTCUSDT.P?x=1', '<script>']) assert(!helpers.verifiedChartSymbol(symbol));
    assert(!helpers.verifiedChartSymbol('OKX:BTCUSDT.P', six[0]));
  });
  const env = { ...process.env }, lib = join(homedir(), '.cache/okx-browser-check/lib');
  try { await access(join(lib, 'libXdamage.so.1')); env.LD_LIBRARY_PATH = [lib, env.LD_LIBRARY_PATH].filter(Boolean).join(':'); } catch {}
  browser = await chromium.launch({ headless: true, env });
  for (const profile of ['desktop', 'mobile']) {
    const { page, context, state } = await setup(profile);
    const picker = page.locator('.chart-toolbar .market-search');
    await check(`${profile}: polling/stream mode, sampling limitation and honest price freshness`, async () => {
      state.status.scheduler.marketMode = 'polling';
      await page.reload();
      const mode = page.getByLabel('行情采集模式');
      await expect(mode).toContainText('成交价轮询');
      await expect(mode).toContainText('默认每 5 秒');
      await expect(mode).toContainText('限流或调度可能延长间隔');
      await expect(mode).toContainText('可能漏掉短暂越过阈值');
      await expect(page.locator('.health')).toContainText('成交价新鲜');
      await expect(page.locator('.health')).not.toContainText('已连接');
      await expect(page.getByText('仅采集启用且未锁定规则所需的成交价', { exact: false })).toBeVisible();
      await expect(page.getByText('近期无成交不代表断线', { exact: false })).toBeVisible();
      await noOverflow(page);
      await page.screenshot({ path: join(evidenceDir, `${profile}-polling-MOCK.png`), fullPage: false });
      state.status.scheduler.marketMode = 'stream';
      await page.reload();
      await expect(mode).toContainText('成交流监控');
      await expect(mode).toContainText('逐条检查收到的有效新鲜成交');
      await expect(mode).not.toContainText('每 5 秒');
      await noOverflow(page);
      await page.screenshot({ path: join(evidenceDir, `${profile}-stream-MOCK.png`), fullPage: false });
      state.priceAge = 60_000;
      await page.reload();
      await expect(page.locator('.health')).toContainText('成交价已过期');
      await expect(page.locator('.price-block')).toContainText('价格已过期，停止触发');
      state.status.prices = [];
      await page.reload();
      await expect(page.locator('.health')).toContainText('暂无新鲜成交价');
      await expect(page.locator('.health')).not.toContainText('不可用');
      delete state.status.scheduler.marketMode;
      await page.reload();
      await expect(mode).toContainText('行情模式未报告');
      await expect(mode).not.toContainText('成交流监控');
      state.status.prices = [{ instrument: legacy.instrument, price: 60000, timestamp: Date.now(), receivedAt: Date.now() }];
      state.priceAge = 0;
      await page.reload();
      await expect(page.locator('.health')).toContainText('成交价新鲜');
    });
    await check(`${profile}: legacy selection, keyboard disclosure and bounded results`, async () => {
      await expect(picker.locator('summary')).toContainText('OKX · USDT 永续 · BTC / USDT');
      await picker.locator('summary').focus(); await page.keyboard.press('Enter');
      await expect(picker.getByLabel('搜索市场')).toBeVisible();
      await expect(picker.getByLabel('市场搜索结果').locator('option')).toHaveCount(41);
      await expect(picker.getByRole('status')).toContainText('显示前 40 个');
      await picker.getByLabel('搜索市场').fill('BTC');
      await expect(picker.getByLabel('市场搜索结果').locator('option')).toHaveCount(7);
      const choices = picker.getByLabel('市场搜索结果');
      await choices.focus(); await page.keyboard.press('Home'); await page.keyboard.press('ArrowDown');
      const keyboardValue = await choices.inputValue(); assert(keyboardValue);
      await expect(picker.locator('summary')).toContainText(helpers.marketLabel(keyboardValue, helpers.findMarket(state.markets, keyboardValue)));
      assert.equal(await choices.evaluate(node => node === document.activeElement), true);
    });
    await check(`${profile}: all six exact identities, chart policy and source prices`, async () => {
      for (const market of six) {
        await picker.getByLabel('交易所', { exact: true }).selectOption(market.venue);
        await picker.getByLabel('市场类型', { exact: true }).selectOption(market.type);
        await expect(picker.getByLabel('市场搜索结果').locator('option')).toHaveCount(2);
        await picker.getByLabel('市场搜索结果').selectOption(market.instrument);
        await expect(picker.locator('summary')).toContainText(helpers.marketLabel(market.instrument, market));
        await expect(page.locator('.market-header .contract')).toHaveText(`${helpers.venueLabels[market.venue]} · ${helpers.typeLabels[market.type]}`);
        if (market.venue !== 'okx' || market.type !== 'swap') { await expect(page.locator('.empty-chart')).toContainText('暂无已验证'); await expect(page.locator('iframe')).toHaveCount(0); }
      }
      state.status.prices = [{ instrument: six.at(-1).instrument, price: 60123, timestamp: Date.now(), receivedAt: Date.now() }];
      await expect(page.locator('.price-block')).toContainText('MEXC 最新成交价', { timeout: 8000 });
      await noOverflow(page);
      await page.screenshot({ path: join(evidenceDir, `${profile}-search-MOCK.png`), fullPage: true });
    });
    await check(`${profile}: empty filters and unavailable results cannot change selection`, async () => {
      const original = await picker.locator('summary').textContent();
      await picker.getByLabel('搜索市场').fill('NO_SUCH_MARKET');
      await expect(picker.getByText('没有匹配的市场。', { exact: false })).toBeVisible();
      await expect(picker.locator('summary')).toHaveText(original);
      await picker.getByLabel('交易所', { exact: true }).selectOption(''); await picker.getByLabel('市场类型', { exact: true }).selectOption('');
      await picker.getByLabel('搜索市场').fill('HALT');
      await expect(picker.getByLabel('市场搜索结果').locator('option').filter({ hasText: 'HALT / USDT' })).toHaveJSProperty('disabled', true);
      await expect(picker.locator('summary')).toHaveText(original);
    });
    await check(`${profile}: shared editor searches and submits exact source identity`, async () => {
      await page.getByRole('button', { name: '＋ 创建警报', exact: true }).click();
      const dialog = page.getByRole('dialog'); await dialog.locator('.market-search summary').click();
      await dialog.getByLabel('搜索市场').fill('BTC'); await dialog.getByLabel('交易所', { exact: true }).selectOption('binance'); await dialog.getByLabel('市场类型', { exact: true }).selectOption('spot');
      await dialog.getByLabel('市场搜索结果').selectOption(six[0].instrument);
      await dialog.getByLabel('警报名称').fill('MOCK Binance spot'); await dialog.getByLabel('价格 · USDT').fill('61000');
      await dialog.getByRole('button', { name: '创建警报', exact: true }).click();
      await expect(dialog).toHaveCount(0); assert.equal(state.mutations.at(-1).body.instrument, six[0].instrument);
      const row = page.locator('.alert-row').filter({ hasText: 'MOCK Binance spot' }); await expect(row).toContainText('Binance · 现货 · BTC / USDT');
      await row.getByRole('button', { name: '编辑', exact: true }).click();
      await dialog.locator('.market-search summary').focus(); await page.keyboard.press('Enter');
      await noOverflow(page); await page.evaluate(() => window.scrollTo(0, 0)); await page.screenshot({ path: join(evidenceDir, `${profile}-editor-MOCK.png`), fullPage: false });
      await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0);
    });
    await check(`${profile}: source-unavailable selected row remains visible and rejects new alert`, async () => {
      state.markets.find(m => m.instrument === six.at(-1).instrument).available = false;
      await expect(picker.locator('summary')).toContainText('不可用，已保留', { timeout: 8000 });
      await expect(page.getByRole('button', { name: '＋ 创建警报', exact: true })).toBeDisabled();
    });
    await check(`${profile}: removed selected market retained across polling; unavailable old alert editable`, async () => {
      const instrument = six.at(-1).instrument;
      state.markets = state.markets.filter(m => m.instrument !== instrument && m.instrument !== legacy.instrument);
      // The prior unavailable label predates removal; wait for a catalog response
      // containing this removal before opening an editor that captures its inputs.
      await page.waitForResponse(async response => {
        if (new URL(response.url()).pathname !== '/api/markets' || !response.ok()) return false;
        const payload = await response.json();
        return !payload.data.markets.some(m => m.instrument === instrument || m.instrument === legacy.instrument);
      }, { timeout: 10000 });
      await expect(picker.locator('summary')).toContainText('不可用，已保留', { timeout: 8000 });
      await expect(picker.locator('summary')).toContainText('MEXC · USDT 永续 · BTC / USDT');
      await expect(page.getByRole('button', { name: '＋ 创建警报', exact: true })).toBeDisabled();
      const row = page.locator('.alert-row').filter({ hasText: 'MOCK BTC 上沿' }); await row.locator('.instrument-button').click();
      await expect(picker.locator('summary')).toContainText('OKX · USDT 永续 · BTC / USDT');
      await expect(picker.locator('summary')).toContainText('不可用，已保留');
      await row.getByRole('button', { name: '编辑', exact: true }).click(); const dialog = page.getByRole('dialog');
      await expect(dialog.locator('.market-search summary')).toContainText('不可用，已保留');
      await dialog.getByLabel('警报名称').fill('MOCK retained unavailable'); await dialog.getByRole('button', { name: '保存警报', exact: true }).click();
      await expect(dialog).toHaveCount(0); assert(!Object.hasOwn(state.mutations.at(-1).body, 'instrument')); assert(!Object.hasOwn(state.mutations.at(-1).body, 'enabled')); assert.equal(state.alerts[0].instrument, legacy.instrument);
      const saved = page.locator('.alert-row').filter({ hasText: 'MOCK retained unavailable' });
      await saved.getByRole('button', { name: '编辑', exact: true }).click();
      await dialog.getByLabel('启用这条警报').uncheck(); await dialog.getByRole('button', { name: '保存警报', exact: true }).click();
      await expect(dialog).toHaveCount(0); assert.equal(state.mutations.at(-1).body.enabled, false);
      await saved.getByRole('button', { name: '编辑', exact: true }).click(); await dialog.getByLabel('启用这条警报').check();
      await expect(dialog.getByRole('button', { name: '保存警报', exact: true })).toBeDisabled();
      await page.keyboard.press('Escape');
    });
    await check(`${profile}: directory failure recovery, stale and empty states`, async () => {
      state.marketFail = true;
      await expect(page.locator('.connection-error')).toBeVisible({ timeout: 8000 });
      await expect(picker.getByText('目录刷新未完成：', { exact: false })).toBeVisible();
      const selection = await picker.locator('summary').textContent();
      state.marketFail = false; state.markets = []; state.stale = true;
      await picker.getByRole('button', { name: '重新读取市场目录' }).click();
      await expect(picker.getByText('市场目录暂时为空。', { exact: false })).toBeVisible();
      await expect(picker.getByText('市场目录已过期。', { exact: false })).toBeVisible();
      await expect(picker.locator('summary')).toHaveText(selection);
      await noOverflow(page);
    });
    await context.close(); console.log(`PASS ${profile} market search / source / preservation / editor / recovery`);
  }
  assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.deepEqual(failures, []);
} catch (error) { failures.push(error.stack); process.exitCode = 1; console.error(error); }
finally {
  await browser?.close(); await new Promise(done => server.close(done));
  await writeFile(join(evidenceDir, 'results-MOCK.json'), JSON.stringify({ mode: 'MOCK', assertions, passed: !failures.length, results, failures, errors, external, limitations: ['Synthetic directory and prices; no real exchange or notification/provider integration', 'Mobile Chromium emulation, not iOS Safari', 'Binance/MEXC chart mappings intentionally disabled pending verification'] }, null, 2));
}
