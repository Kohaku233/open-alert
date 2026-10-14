import { useSyncExternalStore } from 'react';
import { english } from './locales/en.js';

export type Language = 'zh-CN' | 'en';
const listeners = new Set<() => void>();
function initialLanguage(): Language {
  try { return localStorage.getItem('open-alert-language') === 'en' ? 'en' : 'zh-CN'; }
  catch { return 'zh-CN'; }
}
let language: Language = initialLanguage();
function applyLanguage() {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = language;
  document.title = language === 'en' ? 'Open Alert · Price monitoring' : '价格哨站 · Open Alert';
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
