// Sidebar order. Each item is a page id: the file path under src/content/docs without ".mdx"
// ("start" is start/index.mdx). Add a new page here after creating its file.
export const nav: { label: string; items: string[] }[] = [
  { label: '开始', items: ['start', 'start/sign-in', 'start/first-alert'] },
  { label: '价格警报', items: ['alerts/how-it-works', 'alerts/markets', 'alerts/chart', 'alerts/manage'] },
  { label: '异动监测', items: ['anomaly/overview', 'anomaly/rules', 'anomaly/filters', 'anomaly/cooldown'] },
  { label: '通知', items: ['notify/channels', 'notify/routes', 'notify/history'] },
  { label: '账户', items: ['account/settings', 'account/limits'] },
  { label: '帮助', items: ['help/faq'] },
];

export const href = (id: string) => `/${id}/`;
