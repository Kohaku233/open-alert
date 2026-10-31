import { navigate } from 'astro:transitions/client';

// Site search backed by the Pagefind index generated at build time (npm run build).
type Result = { url: string; meta: { title?: string }; excerpt: string };
type Pagefind = { search: (q: string) => Promise<{ results: { data: () => Promise<Result> }[] }>; init?: () => Promise<void> };

let engine: Promise<Pagefind | null> | undefined;
const load = () => (engine ??= import(/* @vite-ignore */ '/pagefind/pagefind.js' as string)
  .then(async (m: Pagefind) => { await m.init?.(); return m; })
  .catch(() => null));

// The dialog lives in the page body, which is replaced on every in-page navigation; look it up each time.
const dialogEl = () => document.getElementById('find') as HTMLDialogElement | null;
const open = () => {
  const dialog = dialogEl();
  if (dialog && !dialog.open) { dialog.showModal(); dialog.querySelector('input')!.select(); void load(); }
};

export function setupSearch() {
  addEventListener('keydown', (e) => {
    const dialog = dialogEl();
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); open(); }
    else if (e.key === '/' && dialog && !dialog.open && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) { e.preventDefault(); open(); }
  });
  document.addEventListener('astro:before-swap', () => dialogEl()?.close());
  document.addEventListener('astro:page-load', bindDialog);
}

function bindDialog() {
  const dialog = dialogEl();
  if (!dialog) return;
  const input = dialog.querySelector('input')!;
  const list = dialog.querySelector('.find-list')!;
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);
  document.querySelectorAll('[data-find-key]').forEach((k) => (k.textContent = mac ? '⌘K' : 'Ctrl K'));

  document.querySelectorAll<HTMLElement>('[data-find-open]').forEach((b) => (b.onclick = open));
  dialog.querySelector<HTMLElement>('[data-find-close]')!.onclick = () => dialog.close();
  dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });

  const text = (key: 'empty' | 'down' | 'none') => dialog.dataset[key] ?? '';
  let seq = 0;
  const show = (html: string) => { list.innerHTML = html; };
  const empty = (text: string) => show(`<li class="find-empty">${text}</li>`);
  empty(text('empty'));
  input.addEventListener('input', async () => {
    const q = input.value.trim(); const id = ++seq;
    if (!q) return empty(text('empty'));
    const pf = await load();
    if (id !== seq) return;
    if (!pf) return empty(text('down'));
    const found = await pf.search(q);
    const items = await Promise.all(found.results.slice(0, 8).map((r) => r.data()));
    if (id !== seq) return;
    if (!items.length) return empty(text('none'));
    const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
    show(items.map((r) => `<li><a href="${esc(r.url)}"><b>${esc(r.meta.title ?? r.url)}</b><span>${r.excerpt}</span></a></li>`).join(''));
  });
  input.addEventListener('keydown', (e) => {
    const anchors = [...list.querySelectorAll<HTMLAnchorElement>('a')];
    // A search field's first Escape only clears the text; close the dialog straight away instead.
    if (e.key === 'Escape') { e.preventDefault(); dialog.close(); return; }
    if (e.key === 'Enter' && anchors[0]) { e.preventDefault(); dialog.close(); void navigate(anchors[0].href); }
    if (e.key === 'ArrowDown' && anchors[0]) { e.preventDefault(); anchors[0].focus(); }
  });
  list.addEventListener('click', (e) => { if ((e.target as Element).closest('a')) dialog.close(); });
  list.addEventListener('keydown', (e) => {
    const anchors = [...list.querySelectorAll<HTMLAnchorElement>('a')];
    const i = anchors.indexOf(document.activeElement as HTMLAnchorElement);
    if (e instanceof KeyboardEvent && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      const next = e.key === 'ArrowDown' ? i + 1 : i - 1;
      if (next < 0) input.focus(); else anchors[Math.min(next, anchors.length - 1)]?.focus();
    }
  });
}
