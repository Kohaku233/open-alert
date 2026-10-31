// Two languages: Chinese at the site root, English under /en/. Pages live in
// src/content/docs (Chinese) and src/content/docs/en (English) with the same file names.
export type Lang = 'zh' | 'en';

export const langOf = (pathname: string): Lang => (/^\/en(\/|$)/.test(pathname) ? 'en' : 'zh');
export const htmlLang = (lang: Lang) => (lang === 'en' ? 'en' : 'zh-CN');

/** Docs URL for a page id ("start/sign-in") or "" for the home page. */
export const pageHref = (lang: Lang, id = '') => `${lang === 'en' ? '/en' : ''}/${id ? `${id}/` : ''}`;

/** The same page in the other language. */
export const counterpart = (pathname: string) =>
  langOf(pathname) === 'en' ? pathname.replace(/^\/en(?=\/|$)/, '') || '/' : `/en${pathname}`;

const strings = {
  zh: {
    siteName: '价格哨站', siteSuffix: '价格哨站文档', homeAria: '价格哨站文档首页',
    skip: '跳到正文', search: '搜索文档', searchHint: '搜索文档、规则、通知渠道…', searchInput: '搜索关键词',
    searchEmpty: '输入关键词，例如“冷却”“Discord”“相对 BTC”。', searchDown: '搜索暂时不可用，请刷新页面后再试。',
    searchNone: '没有找到相关内容，换个说法试试。', searchResults: '搜索结果', close: '关闭',
    site: '站点', theme: '切换明暗主题', dark: '深色', light: '浅色', menu: '打开文档目录', console: '打开控制台',
    sidebar: '文档目录', crumbsHome: '文档', pager: '上一篇和下一篇', prev: '上一篇', next: '下一篇',
    toc: '本页目录', tocTitle: '本页内容', anchor: '链接到本节',
    group: '分类', reading: '阅读约', minutes: (n: number) => `${n} 分钟`, updated: '更新于',
    switchTo: 'English', switchAria: 'Read this page in English', copy: '复制', copied: '已复制', copyFailed: '复制失败',
  },
  en: {
    siteName: 'Open Alert', siteSuffix: 'Open Alert Docs', homeAria: 'Open Alert docs home',
    skip: 'Skip to content', search: 'Search docs', searchHint: 'Search docs, rules, channels…', searchInput: 'Search terms',
    searchEmpty: 'Type a keyword, such as “cooldown”, “Discord” or “relative to BTC”.', searchDown: 'Search is unavailable right now. Reload the page and try again.',
    searchNone: 'Nothing found. Try different words.', searchResults: 'Search results', close: 'Close',
    site: 'Site', theme: 'Toggle light and dark theme', dark: 'Dark', light: 'Light', menu: 'Open the docs menu', console: 'Open the app',
    sidebar: 'Docs menu', crumbsHome: 'Docs', pager: 'Previous and next page', prev: 'Previous', next: 'Next',
    toc: 'On this page', tocTitle: 'On this page', anchor: 'Link to this section',
    group: 'Section', reading: 'Reading time', minutes: (n: number) => `${n} min`, updated: 'Updated',
    switchTo: '中文', switchAria: '阅读本页中文版', copy: 'Copy', copied: 'Copied', copyFailed: 'Copy failed',
  },
} as const;

export const ui = (lang: Lang) => strings[lang];
