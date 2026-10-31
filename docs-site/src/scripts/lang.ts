// Language menu in the header: "Match system", 简体中文, English.
// Picking a language saves it, so later visits open that language; "Match system" clears it.
// The redirect itself happens in an inline script in the page head, before the page paints.
const KEY = 'oa-docs-lang';
type Lang = 'zh' | 'en';

const saved = (): Lang | null => {
  try { const v = localStorage.getItem(KEY); return v === 'zh' || v === 'en' ? v : null; } catch { return null; }
};
const save = (v: Lang | null) => {
  try { if (v) localStorage.setItem(KEY, v); else localStorage.removeItem(KEY); } catch {}
};
/** Chinese browsers get Chinese; every other language gets English. */
export const systemLang = (): Lang => {
  const list = navigator.languages?.length ? navigator.languages : [navigator.language || ''];
  for (const l of list) { if (/^zh(-|$)/i.test(l)) return 'zh'; if (/^en(-|$)/i.test(l)) return 'en'; }
  return 'en';
};

const parts = () => {
  const root = document.querySelector<HTMLElement>('[data-lang-pick]');
  return root ? { root, button: root.querySelector<HTMLButtonElement>('.pill.lang')!, menu: root.querySelector<HTMLElement>('.lang-menu')! } : null;
};
const items = (menu: HTMLElement) => [...menu.querySelectorAll<HTMLElement>('[data-lang-choice]')];

function paint() {
  const p = parts();
  if (!p) return;
  const choice = saved() ?? 'auto';
  for (const item of items(p.menu)) item.setAttribute('aria-checked', String(item.dataset.langChoice === choice));
  const detected = p.menu.querySelector<HTMLElement>('[data-lang-detected]');
  if (detected) detected.textContent = systemLang() === 'en' ? 'English' : '简体中文';
}

function setOpen(open: boolean, focus: 'first' | 'button' | null = null) {
  const p = parts();
  if (!p) return;
  p.menu.hidden = !open;
  p.button.setAttribute('aria-expanded', String(open));
  if (open) {
    paint();
    if (focus === 'first') (items(p.menu).find((i) => i.getAttribute('aria-checked') === 'true') ?? items(p.menu)[0])?.focus();
  } else if (focus === 'button') p.button.focus();
}

export function setupLang() {
  document.addEventListener('click', (e) => {
    const p = parts();
    if (!p) return;
    const target = e.target as Element;
    if (p.button.contains(target)) { setOpen(p.button.getAttribute('aria-expanded') !== 'true'); return; }
    const item = target.closest<HTMLElement>('[data-lang-choice]');
    if (!item || !p.menu.contains(item)) { if (!p.menu.hidden) setOpen(false); return; }
    const here = p.root.dataset.here as Lang;
    const choice = item.dataset.langChoice as Lang | 'auto';
    const next = choice === 'auto' ? systemLang() : choice;
    save(choice === 'auto' ? null : choice);
    if (next === here) { e.preventDefault(); paint(); setOpen(false, 'button'); return; }
    // Another language opens with a full page load, so search loads that language's index.
    if (choice === 'auto') { e.preventDefault(); location.href = p.menu.querySelector<HTMLAnchorElement>(`[data-lang-choice="${next}"]`)!.href; }
  });

  document.addEventListener('keydown', (e) => {
    const p = parts();
    if (!p) return;
    if (e.target === p.button && e.key === 'ArrowDown' && p.menu.hidden) { e.preventDefault(); setOpen(true, 'first'); return; }
    if (p.menu.hidden || !p.root.contains(e.target as Node)) return;
    const list = items(p.menu);
    const at = list.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false, 'button'); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); list[(at + 1) % list.length]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); list[(at - 1 + list.length) % list.length]?.focus(); }
    else if (e.key === 'Home') { e.preventDefault(); list[0]?.focus(); }
    else if (e.key === 'End') { e.preventDefault(); list[list.length - 1]?.focus(); }
    else if (e.key === 'Tab') setOpen(false);
  }, true);

  document.addEventListener('astro:page-load', paint);
  document.addEventListener('astro:before-swap', () => setOpen(false));
}
