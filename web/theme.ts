import { useSyncExternalStore } from 'react';

export type ThemePreference = 'system' | 'light' | 'dark';
const key = 'open-alert-theme';
const listeners = new Set<() => void>();
const media = typeof window !== 'undefined' ? window.matchMedia('(prefers-color-scheme: dark)') : null;
function readPreference(): ThemePreference {
  try { const value = localStorage.getItem(key); return value === 'light' || value === 'dark' ? value : 'system'; }
  catch { return 'system'; }
}
let preference = readPreference();
export function getTheme() { return preference === 'system' ? media?.matches ? 'dark' : 'light' : preference; }
let themeFrame = 0;
function apply() {
  if (typeof document !== 'undefined') {
    const theme = getTheme();
    const root = document.documentElement;
    if (root.dataset.theme !== theme) {
      cancelAnimationFrame(themeFrame);
      root.dataset.themeChanging = 'true';
      // Flush the transition barrier before applying any new foreground/background tokens.
      void root.offsetWidth;
      themeFrame = requestAnimationFrame(() => { themeFrame = requestAnimationFrame(() => { delete root.dataset.themeChanging; }); });
    }
    document.documentElement.dataset.theme = theme;
    document.documentElement.classList.toggle('dark', theme === 'dark');
    document.documentElement.style.colorScheme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#090c0e' : '#f2efe7');
  }
  listeners.forEach(listener => listener());
}
export function setTheme(next: ThemePreference) {
  if (!['system', 'dark', 'light'].includes(next)) return;
  preference = next;
  try { if (next === 'system') localStorage.removeItem(key); else localStorage.setItem(key, next); } catch { /* Storage may be unavailable. */ }
  apply();
}
function subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function useTheme() {
  const theme = useSyncExternalStore(subscribe, getTheme, getTheme);
  const selected = useSyncExternalStore(subscribe, () => preference, () => preference);
  return { theme, preference: selected, setTheme };
}
media?.addEventListener('change', () => { if (preference === 'system') apply(); });
if (typeof window !== 'undefined') window.addEventListener('storage', event => { if (event.key === key || event.key === null) { preference = readPreference(); apply(); } });
apply();
if (typeof document !== 'undefined') {
  const syncVisibility = () => { document.documentElement.dataset.pageHidden = String(document.hidden); };
  document.addEventListener('visibilitychange', syncVisibility);
  syncVisibility();
}
