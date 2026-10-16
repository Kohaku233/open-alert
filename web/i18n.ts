import { useSyncExternalStore } from 'react';
import { english } from './locales/en.js';

export type Language = 'zh-CN' | 'en';
const listeners = new Set<() => void>();
export function resolveClientLanguage(languages: readonly string[]): Language {
  for (const value of languages) {
    if (/^zh(?:-|$)/i.test(value)) return 'zh-CN';
    if (/^en(?:-|$)/i.test(value)) return 'en';
  }
  return 'en';
}
function initialLanguage(): Language {
  try { const saved = localStorage.getItem('open-alert-language'); if (saved === 'en' || saved === 'zh-CN') return saved; } catch { /* Use client preference when storage is disabled. */ }
  return resolveClientLanguage(typeof navigator === 'undefined' ? ['en'] : navigator.languages?.length ? navigator.languages : [navigator.language]);
}
let language: Language = initialLanguage();
function applyLanguage() {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = language;
  document.title = language === 'en' ? 'Open Alert · Price monitoring' : '价格哨站 · Open Alert';
}
if (typeof window !== 'undefined') {
  window.addEventListener('languagechange', () => {
    try { if (localStorage.getItem('open-alert-language')) return; } catch { /* No manual preference. */ }
    language = initialLanguage(); applyLanguage(); listeners.forEach(listener => listener());
  });
  window.addEventListener('storage', event => {
    if (event.key === 'open-alert-language' || event.key === null) { language = initialLanguage(); applyLanguage(); listeners.forEach(listener => listener()); }
  });
}
applyLanguage();
export const getLanguage = () => language;
export function setLanguage(next: Language) {
  if (next !== 'en' && next !== 'zh-CN') return;
  language = next;
  try { localStorage.setItem('open-alert-language', next); } catch { /* Private browser storage can be disabled. */ }
  applyLanguage(); listeners.forEach(listener => listener());
}
function subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function useLanguage() { return useSyncExternalStore(subscribe, getLanguage, getLanguage); }
export function t(text: string, ...values: unknown[]): string {
  const template = language === 'en' ? english[text] ?? text : text;
  return template.replace(/\{(\d+)\}/g, (_match, index: string) => {
    const value = values[Number(index)];
    return String(value ?? '');
  });
}
