// Keeps the HTML of every docs page in memory so clicks open without waiting on the network.
// Cloudflare refuses browser prefetch requests (Sec-Purpose: prefetch) for Workers, so pages are
// fetched with plain requests while the browser is idle, and handed to the client router on click.
const TTL = 10 * 60 * 1000;
const cache = new Map<string, { at: number; html: Promise<string | null> }>();

const keyOf = (href: string) => {
  const url = new URL(href, location.href);
  return url.origin === location.origin && !url.search ? url.pathname : null;
};

function warm(href: string) {
  const key = keyOf(href);
  if (!key) return;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return;
  const html = fetch(key, { credentials: 'same-origin' })
    .then((r) => (r.ok && (r.headers.get('content-type') ?? '').includes('text/html') ? r.text() : null))
    .catch(() => null);
  cache.set(key, { at: Date.now(), html });
  void html.then((text) => { if (!text) cache.delete(key); });
}

const docLinks = () => [...document.querySelectorAll<HTMLAnchorElement>('#side a, .top .brand, main a[href^="/"]')].map((a) => a.href);

function warmAll() {
  const saveData = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData;
  if (saveData) return;
  const queue = [...new Set(docLinks())];
  // A few at a time, so page assets and fonts load first.
  const next = (): void => {
    const href = queue.shift();
    if (!href) return;
    warm(href);
    const entry = cache.get(keyOf(href) ?? '');
    if (entry) void entry.html.finally(next); else next();
  };
  const start = () => { for (let i = 0; i < 3; i++) next(); };
  if ('requestIdleCallback' in window) requestIdleCallback(start, { timeout: 2000 }); else setTimeout(start, 600);
}

export function setupPreload() {
  // Hovering, focusing or touching a link fetches it right away, ahead of the idle queue.
  const eager = (e: Event) => { const a = (e.target as Element | null)?.closest?.('a'); if (a instanceof HTMLAnchorElement) warm(a.href); };
  document.addEventListener('pointerover', eager, { passive: true });
  document.addEventListener('focusin', eager);
  document.addEventListener('touchstart', eager, { passive: true });
  document.addEventListener('astro:page-load', warmAll);

  document.addEventListener('astro:before-preparation', (event) => {
    const e = event as Event & { to: URL; formData?: FormData; newDocument: Document; loader: () => Promise<void> };
    const key = e.formData ? null : keyOf(e.to.href);
    const hit = key ? cache.get(key) : undefined;
    if (!hit || Date.now() - hit.at >= TTL) return;
    const fallback = e.loader;
    e.loader = async () => {
      const html = await hit.html;
      if (!html) return fallback();
      const doc = new DOMParser().parseFromString(html, 'text/html');
      if (!doc.querySelector('[name="astro-view-transitions-enabled"]')) return fallback();
      doc.querySelectorAll('noscript').forEach((el) => el.remove());
      e.newDocument = doc;
    };
  });
}
