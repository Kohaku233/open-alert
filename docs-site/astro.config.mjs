// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  site: 'https://docs.cryptotool.bar',
  integrations: [
    starlight({
      title: '价格哨站文档',
      description: '价格哨站（Open Alert）的使用说明：价格警报、异动监测、通知渠道与账户。',
      defaultLocale: 'root',
      locales: { root: { label: '简体中文', lang: 'zh-CN' } },
      favicon: '/favicon.svg',
      customCss: ['./src/styles/breakout.css'],
      components: { SiteTitle: './src/components/SiteTitle.astro' },
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/Kohaku233/open-alert' },
      ],
      editLink: { baseUrl: 'https://github.com/Kohaku233/open-alert/edit/feat/anomaly-monitor/docs-site/' },
      lastUpdated: true,
      credits: false,
      sidebar: [
        { label: '开始', items: ['start', 'start/sign-in', 'start/first-alert'] },
        { label: '价格警报', items: ['alerts/how-it-works', 'alerts/markets', 'alerts/chart', 'alerts/manage'] },
        { label: '异动监测', items: ['anomaly/overview', 'anomaly/rules', 'anomaly/filters', 'anomaly/cooldown'] },
        { label: '通知', items: ['notify/channels', 'notify/routes', 'notify/history'] },
        { label: '账户', items: ['account/settings', 'account/limits'] },
        { label: '帮助', items: ['help/faq'] },
      ],
      head: [
        { tag: 'meta', attrs: { name: 'theme-color', content: '#05070a' } },
      ],
    }),
  ],
});
