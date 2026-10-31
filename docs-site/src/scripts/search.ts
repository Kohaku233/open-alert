// Site search backed by the Pagefind index generated at build time (npm run build).
type Result = { url: string; meta: { title?: string }; excerpt: string };
type Pagefind = { search: (q: string) => Promise<{ results: { data: () => Promise<Result> }[] }>; init?: () => Promise<void> };

let engine: Promise<Pagefind | null> | undefined;
const load = () => (engine ??= import(/* @vite-ignore */ '/pagefind/pagefind.js' as string)
  .then(async (m: Pagefind) => { await m.init?.(); return m; })
  .catch(() => null));

export function setupSearch() {
  const dialog = document.getElementById('find') as HTMLDialogElement;
  const input = dialog.querySelector('input')!;
  const list = dialog.querySelector('.find-list')!;
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);
  document.querySelectorAll('[data-find-key]').forEach((k) => (k.textContent = mac ? '⌘K' : 'Ctrl K'));

  const open = () => { if (!dialog.open) { dialog.showModal(); input.select(); void load(); } };
  document.querySelectorAll('[data-find-open]').forEach((b) => b.addEventListener('click', open));
  dialog.querySelector('[data-find-close]')!.addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });
  addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); open(); }
    else if (e.key === '/' && !dialog.open && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) { e.preventDefault(); open(); }
  });

  let seq = 0;
  const show = (html: string) => { list.innerHTML = html; };
  const empty = (text: string) => show(`<li class="find-empty">${text}</li>`);
  empty('输入关键词，例如“冷却”“Discord”“相对 BTC”。');
  input.addEventListener('input', async () => {
    const q = input.value.trim(); const id = ++seq;
    if (!q) return empty('输入关键词，例如“冷却”“Discord”“相对 BTC”。');
    const pf = await load();
    if (id !== seq) return;
    if (!pf) return empty('搜索暂时不可用，请刷新页面后再试。');
    const found = await pf.search(q);
    const items = await Promise.all(found.results.slice(0, 8).map((r) => r.data()));
    if (id !== seq) return;
    if (!items.length) return empty('没有找到相关内容，换个说法试试。');
    const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
    show(items.map((r) => `<li><a href="${esc(r.url)}"><b>${esc(r.meta.title ?? r.url)}</b><span>${r.excerpt}</span></a></li>`).join(''));
  });
  input.addEventListener('keydown', (e) => {
    const anchors = [...list.querySelectorAll<HTMLAnchorElement>('a')];
    if (e.key === 'Enter' && anchors[0]) { location.href = anchors[0].href; }
    if (e.key === 'ArrowDown' && anchors[0]) { e.preventDefault(); anchors[0].focus(); }
  });
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
