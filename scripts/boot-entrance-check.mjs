#!/usr/bin/env node
// Inspect rendered frames, rather than trusting the animation's readiness flag.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve, join, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(process.env.OPEN_ALERT_BROWSER_OUTPUT_DIR || join(root, 'work/boot-proof'));
await mkdir(output, { recursive: true });
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE || join(root, 'node_modules/playwright/index.mjs')).href);
const live = process.env.OPEN_ALERT_BOOT_ORIGIN;
const server = live ? null : createServer(async (request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname;
  const file = /^\/(assets|fonts)\//.test(path) || path === '/icon.svg' ? path.slice(1) : 'index.html';
  try {
    const body = await readFile(join(root, 'dist/web', file));
    const type = { '.js': 'application/javascript', '.css': 'text/css', '.ttf': 'font/ttf', '.svg': 'image/svg+xml' }[extname(file)] || 'text/html';
    response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    response.end(body);
  } catch { response.writeHead(404); response.end(); }
});
if (server) await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = live || `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL, headless: true });
const results = [];
const profiles = [
  { name: 'desktop-zh', width: 1440, locale: 'zh-CN' },
  { name: 'desktop-en', width: 1440, locale: 'en-GB' },
  { name: 'mobile-zh', width: 390, locale: 'zh-CN' },
  { name: 'mobile-en', width: 390, locale: 'en-GB' },
  ...(!live ? [
    { name: 'slow-capabilities', width: 390, locale: 'zh-CN', hold: true },
    { name: 'dashboard-redirect', width: 390, locale: 'zh-CN', path: '/dashboard' },
    { name: 'interrupt-exit', width: 1440, locale: 'zh-CN', fail: 'capabilities', interrupt: true },
    { name: 'capability-retry', width: 1440, locale: 'zh-CN', fail: 'capabilities' },
    { name: 'session-retry', width: 390, locale: 'zh-CN', fail: 'session' },
    { name: 'session-rate-limit-retry', width: 1440, locale: 'zh-CN', fail: 'session', status: 429 },
    { name: 'reduced-desktop', width: 1440, locale: 'en-GB', reduced: true },
    { name: 'reduced-mobile', width: 390, locale: 'zh-CN', reduced: true },
  ] : []),
];
try {
  for (const profile of profiles) {
    const context = await browser.newContext({ viewport: { width: profile.width, height: 900 }, locale: profile.locale,
      colorScheme: 'dark', reducedMotion: profile.reduced ? 'reduce' : 'no-preference', serviceWorkers: 'block' });
    const errors = [];
    const page = await context.newPage();
    page.setDefaultTimeout(12000);
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      window.bootFrames = [];
      const identities = new WeakMap();
      let count = 0;
      const sample = () => {
        const stage = document.querySelector('[data-slot="boot-stage"]');
        if (stage) {
          if (!identities.has(stage)) identities.set(stage, ++count);
          const style = selector => getComputedStyle(stage.querySelector(selector));
          const resting = node => {
            const css = getComputedStyle(node), matrix = new DOMMatrixReadOnly(css.transform);
            return Number(css.opacity) >= .999 && Math.abs(matrix.m42) < .1 && Math.abs(matrix.m11 - 1) < .001 && Math.abs(matrix.m22 - 1) < .001;
          };
          const letters = [...stage.querySelectorAll('.boot-char i')];
          const settled = ['.boot-core', '.boot-node', '.boot-kicker', '.boot-note', '.boot-status'].every(selector => resting(stage.querySelector(selector)))
            && letters.every(resting) && ['.boot-frame', '.boot-signal'].every(selector => Math.abs(parseFloat(style(selector).strokeDashoffset)) < .01);
          window.bootFrames.push({ at: performance.now(), id: identities.get(stage), phase: stage.dataset.bootPhase,
            settled, noteOpacity: Number(style('.boot-note').opacity), kickerOpacity: Number(style('.boot-kicker').opacity),
            lastLetterOpacity: Number(getComputedStyle(letters.at(-1)).opacity) });
        }
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    let failure = profile.fail, release;
    let held = profile.hold;
    let gate = new Promise(done => { release = done; });
    if (!live) await context.route('**/api/**', async route => {
      const path = new URL(route.request().url()).pathname;
      const isSession = path === '/api/auth/get-session';
      if (failure === (isSession ? 'session' : 'capabilities')) {
        failure = null;
        return route.fulfill({ status: profile.status || 503, headers: profile.status === 429 ? { 'Retry-After': '60' } : {}, contentType: 'application/json', body: JSON.stringify({ message: 'Unavailable', ok: false, error: { code: 'service_unavailable' } }) });
      }
      if (!isSession && held) await gate;
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(isSession ? null : { ok: true, data: { google: false, emailOtp: true, registration: 'invite', emailSenderMode: 'console' } }) });
    });
    await page.goto(origin + (profile.path || '/login'), { waitUntil: 'domcontentloaded' });
    await page.locator('[data-slot="boot-stage"]').waitFor();
    if (profile.hold) {
      await page.waitForFunction(() => window.bootFrames.some(frame => frame.settled));
      await page.waitForTimeout(300);
      assert.equal(await page.locator('[data-boot-phase="entering"]').count(), 1, 'slow discovery must keep the assembled stage');
      await page.screenshot({ path: join(output, 'assembled-mobile.png') });
      held = false; release();
    }
    if (profile.interrupt)
      await page.waitForFunction(() => window.bootFrames.some(frame => frame.phase === 'exiting'));
    else
      await page.locator('[data-slot="boot-stage"]').waitFor({ state: 'detached' });
    if (profile.fail) {
      held = true;
      if (profile.status === 429) await page.getByText('请求过于频繁，请稍后重试。', { exact: true }).waitFor();
      const button = page.getByRole('button', { name: profile.fail === 'session' ? '重试连接' : '重试读取登录方式' });
      if (profile.interrupt) await button.evaluate(node => node.click());
      else await button.click();
      await page.locator('[data-slot="boot-stage"]').waitFor();
      await page.waitForFunction(() => window.bootFrames.some(frame => frame.id > 1 && frame.settled));
      assert.equal(await page.locator('[data-boot-phase="entering"]').count(), 1, 'old exit callbacks must not dismiss a new stage');
      held = false; release();
      await page.locator('[data-slot="boot-stage"]').waitFor({ state: 'detached' });
    }
    await page.getByLabel(profile.locale.startsWith('zh') ? '邮箱地址' : 'Email address', { exact: true }).fill('check@example.test');
    const frames = await page.evaluate(() => window.bootFrames);
    await writeFile(join(output, profile.name + '-frames.json'), JSON.stringify({ frames, errors }, null, 2));
    const exits = frames.filter((frame, index) => frame.phase === 'exiting' && frames[index - 1]?.phase !== 'exiting');
    assert.equal(new Set(frames.map(frame => frame.id)).size, profile.fail ? 2 : 1, 'claims must not restart an entrance that is still playing');
    assert(exits.length >= 1, 'must observe the actual curtain exit');
    for (const exit of exits) {
      const first = frames.find(frame => frame.id === exit.id && frame.settled);
      assert(first, `${profile.name}: exit without a fully rendered brand: ${JSON.stringify(exit)}`);
      assert(exit.settled, `${profile.name}: exit interrupted the entry: ${JSON.stringify(exit)}`);
      if (!profile.reduced) assert(exit.at - first.at >= 180, `${profile.name}: no readable hold after assembly (${exit.at - first.at}ms)`);
    }
    assert.deepEqual(errors, []);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    if (profile.name === 'desktop-zh') await page.screenshot({ path: join(output, 'login-desktop.png') });
    const result = { name: profile.name, exits: exits.length, readableHoldMs: Math.round(exits[0].at - frames.find(f => f.id === exits[0].id && f.settled).at), runtimeErrors: errors.length };
    results.push(result);
    console.log('PASS', JSON.stringify(result));
    await context.close();
  }
} finally {
  await browser.close();
  if (server) await new Promise(done => server.close(done));
  await writeFile(join(output, 'boot-results.json'), JSON.stringify({ origin, results }, null, 2));
}
