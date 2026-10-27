import { useSyncExternalStore } from 'react';

/** Which chart the market panel shows. TradingView stays the default; the built-in
 * chart is served by our backend, so it also works where TradingView is blocked. */
export type ChartKind = 'tradingview' | 'native';
const key = 'open-alert-chart';
const listeners = new Set<() => void>();
function read(): ChartKind {
  try { return localStorage.getItem(key) === 'native' ? 'native' : 'tradingview'; } catch { return 'tradingview'; }
}
let current = read();
if (typeof window !== 'undefined') window.addEventListener('storage', event => {
  if (event.key === key || event.key === null) { current = read(); listeners.forEach(listener => listener()); }
});
export function setChartKind(next: ChartKind) {
  if (next !== 'native' && next !== 'tradingview') return;
  current = next;
  try { localStorage.setItem(key, next); } catch { /* Storage can be disabled; keep the in-memory choice. */ }
  listeners.forEach(listener => listener());
}
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const useChartKind = () => useSyncExternalStore(subscribe, () => current, () => current);
