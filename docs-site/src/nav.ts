import type { Lang } from './i18n';

// Sidebar order. Each item is a page id: the file path under src/content/docs without ".mdx"
// ("start" is start/index.mdx). The English page has the same id under src/content/docs/en.
// Add a new page here after creating both files.
export const nav: { label: Record<Lang, string>; items: string[] }[] = [
  { label: { zh: '开始', en: 'Get started' }, items: ['start', 'start/sign-in', 'start/first-alert'] },
  { label: { zh: '价格警报', en: 'Price alerts' }, items: ['alerts/how-it-works', 'alerts/markets', 'alerts/chart', 'alerts/manage'] },
  { label: { zh: '异动监测', en: 'Anomalies' }, items: ['anomaly/overview', 'anomaly/rules', 'anomaly/filters', 'anomaly/cooldown'] },
  { label: { zh: '通知', en: 'Notifications' }, items: ['notify/channels', 'notify/routes', 'notify/history'] },
  { label: { zh: '账户', en: 'Account' }, items: ['account/settings', 'account/limits'] },
  { label: { zh: '帮助', en: 'Help' }, items: ['help/faq'] },
];

export { pageHref as href } from './i18n';
