// @ts-check
import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://docs.cryptotool.bar',
  integrations: [mdx(), sitemap()],
  markdown: { syntaxHighlight: false },
  build: { format: 'directory' },
  // Cloudflare refuses browser prefetch requests for Workers; src/scripts/preload.ts loads pages instead.
  prefetch: false,
});
