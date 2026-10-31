// @ts-check
import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';
import { rename, rm } from 'node:fs/promises';

// Astro writes src/pages/en/404.astro to en/404/index.html. Cloudflare serves the nearest
// 404.html for a missing path, so move it next to the English pages.
const english404 = {
  name: 'english-404',
  hooks: {
    'astro:build:done': async ({ dir }) => {
      await rename(new URL('en/404/index.html', dir), new URL('en/404.html', dir));
      await rm(new URL('en/404/', dir), { recursive: true });
    },
  },
};

export default defineConfig({
  site: 'https://docs.cryptotool.bar',
  integrations: [mdx(), sitemap({ filter: (page) => !page.includes('/404'), i18n: { defaultLocale: 'zh', locales: { zh: 'zh-CN', en: 'en' } } }), english404],
  markdown: { syntaxHighlight: false },
  build: { format: 'directory' },
  // Cloudflare refuses browser prefetch requests for Workers; src/scripts/preload.ts loads pages instead.
  prefetch: false,
});
