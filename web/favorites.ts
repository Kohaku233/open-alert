import { useSyncExternalStore } from 'react';
import { errorText, request } from './api.js';
import { t } from './i18n.js';
import type { DirectoryMarket } from './markets.js';
import { marketIdentity, selectableMarket } from './markets.js';

/** A starred underlying (BTC, NVDA...) across every venue; `preferred` is the market it was starred from. */
export interface Favorite { base: string; preferred: string | null }
export const FAVORITE_LIMIT = 50;

/** One key per underlying: 1000PEPE and PEPE, or NVDA and NVDASTOCK, are the same asset. */
export function underlying(base: string): string {
  const upper = base.toUpperCase().replace(/^1000+(?=[A-Z])/, '').replace(/^1M(?=[A-Z])/, '');
  return upper.length > 5 && upper.endsWith('STOCK') ? upper.slice(0, -5) : upper;
}
const venueOrder = { binance: 0, okx: 1, mexc: 2 } as const;

export interface AssetGroup { base: string; markets: DirectoryMarket[]; available: DirectoryMarket[] }
/** Every USDT market grouped by underlying, Binance → OKX → MEXC, swap before spot. */
export function groupByAsset(markets: readonly DirectoryMarket[]): Map<string, AssetGroup> {
  const groups = new Map<string, AssetGroup>();
  for (const market of markets) {
    const identity = marketIdentity(market.instrument, market);
    if (!identity.base || !identity.venue || !identity.type) continue;
    const key = underlying(identity.base);
    const group = groups.get(key) ?? { base: key, markets: [], available: [] };
    if (group.markets.some(m => m.instrument === market.instrument)) continue;
    group.markets.push(market);
    if (selectableMarket(market)) group.available.push(market);
    groups.set(key, group);
  }
  const rank = (m: DirectoryMarket) => { const x = marketIdentity(m.instrument, m); return venueOrder[x.venue!] * 2 + Number(x.type === 'spot'); };
  for (const group of groups.values()) { group.markets.sort((a, b) => rank(a) - rank(b)); group.available.sort((a, b) => rank(a) - rank(b)); }
  return groups;
}

// One shared list for every picker on the page; loaded once per session.
type State = { favorites: Favorite[] | null; unavailable: boolean; saving: boolean; error: string };
let state: State = { favorites: null, unavailable: false, saving: false, error: '' };
let loading: Promise<void> | null = null;
let generation = 0;
const listeners = new Set<() => void>();
function set(next: Partial<State>) { state = { ...state, ...next }; listeners.forEach(listener => listener()); }
function load() {
  if (loading) return;
  const mine = generation;
  loading = request<{ favorites: Favorite[] }>('/api/favorites', 'GET')
    .then(result => { if (mine === generation) set({ favorites: result.favorites }); })
    .catch(() => { if (mine === generation) { set({ unavailable: true }); loading = null; } });
}
async function save(next: Favorite[]) {
  const previous = state.favorites;
  if (!previous) return;
  set({ favorites: next, saving: true, error: '' });
  try { set({ favorites: (await request<{ favorites: Favorite[] }>('/api/favorites', 'PUT', { favorites: next })).favorites }); }
  catch (cause) { set({ favorites: previous, error: errorText(cause) }); }
  finally { set({ saving: false }); }
}
export function toggleFavorite(base: string, preferred: string | null) {
  const list = state.favorites;
  if (!list || !base) return;
  if (list.some(f => f.base === base)) void save(list.filter(f => f.base !== base));
  else if (list.length >= FAVORITE_LIMIT) set({ error: t('最多收藏 {0} 个标的。', FAVORITE_LIMIT) });
  else void save([...list, { base, preferred }]);
}
// The list belongs to the signed-in user: drop it once no picker is mounted (logout unmounts the workspace).
const subscribe = (listener: () => void) => {
  listeners.add(listener); load();
  return () => { listeners.delete(listener); if (!listeners.size) { state = { favorites: null, unavailable: false, saving: false, error: '' }; loading = null; generation++; } };
};
export const useFavorites = () => useSyncExternalStore(subscribe, () => state, () => state);
