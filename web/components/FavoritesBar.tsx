import { useEffect, useMemo, useState } from 'react';
import { Star } from 'lucide-react';
import { errorText, request } from '../api.js';
import { t } from '../i18n.js';
import type { DirectoryMarket } from '../markets.js';
import { marketIdentity, sameMarket, selectableMarket, typeLabels, venueLabels } from '../markets.js';
import { Button } from './ui/button.js';

interface Favorite { base: string; preferred: string | null }
export const FAVORITE_LIMIT = 50;
/** One key per underlying: 1000PEPE and PEPE, or NVDA and NVDASTOCK, are the same asset. */
export function underlying(base: string): string {
  const upper = base.toUpperCase().replace(/^1000+(?=[A-Z])/, '').replace(/^1M(?=[A-Z])/, '');
  return upper.length > 5 && upper.endsWith('STOCK') ? upper.slice(0, -5) : upper;
}
const order = { binance: 0, okx: 1, mexc: 2 } as const;

/** Starred underlyings (not single venues) plus a venue switcher for the asset on screen. */
export function FavoritesBar({ markets, value, onChange, disabled }: { markets: readonly DirectoryMarket[]; value: string; onChange: (instrument: string) => void; disabled?: boolean }) {
  const [favorites, setFavorites] = useState<Favorite[] | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    request<{ favorites: Favorite[] }>('/api/favorites', 'GET', undefined, { signal: controller.signal })
      .then(result => setFavorites(result.favorites))
      .catch(() => { if (!controller.signal.aborted) setUnavailable(true); });
    return () => controller.abort();
  }, []);
  // Every live USDT market grouped by underlying, Binance → OKX → MEXC, swap before spot.
  const byBase = useMemo(() => {
    const groups = new Map<string, DirectoryMarket[]>();
    for (const market of markets) {
      if (!selectableMarket(market)) continue;
      const identity = marketIdentity(market.instrument, market);
      const key = underlying(identity.base);
      groups.set(key, [...groups.get(key) ?? [], market]);
    }
    for (const list of groups.values()) list.sort((a, b) => {
      const x = marketIdentity(a.instrument, a), y = marketIdentity(b.instrument, b);
      return order[x.venue!] - order[y.venue!] || Number(x.type === 'spot') - Number(y.type === 'spot') || x.base.length - y.base.length;
    });
    return groups;
  }, [markets]);
  const current = marketIdentity(value, markets.find(m => sameMarket(m.instrument, value)));
  const base = current.base ? underlying(current.base) : '';
  const venues = base ? byBase.get(base) ?? [] : [];
  const starred = !!favorites?.some(f => f.base === base);

  async function save(next: Favorite[]) {
    if (!favorites) return;
    const previous = favorites;
    setFavorites(next); setSaving(true); setError('');
    try { setFavorites((await request<{ favorites: Favorite[] }>('/api/favorites', 'PUT', { favorites: next })).favorites); }
    catch (cause) { setFavorites(previous); setError(errorText(cause)); }
    finally { setSaving(false); }
  }
  function toggle() {
    if (!favorites || !base) return;
    if (starred) void save(favorites.filter(f => f.base !== base));
    else if (favorites.length >= FAVORITE_LIMIT) setError(t('最多收藏 {0} 个标的。', FAVORITE_LIMIT));
    else void save([...favorites, { base, preferred: value }]);
  }
  function open(favorite: Favorite) {
    const list = byBase.get(favorite.base) ?? [];
    const target = list.find(m => favorite.preferred && sameMarket(m.instrument, favorite.preferred)) ?? list[0];
    if (target) onChange(target.instrument);
  }
  function pickVenue(instrument: string) {
    onChange(instrument);
    // Remember the venue last used for a starred asset, without a save per click when nothing changed.
    if (favorites && starred && !favorites.some(f => f.base === base && f.preferred === instrument)) void save(favorites.map(f => f.base === base ? { ...f, preferred: instrument } : f));
  }
  if (unavailable) return null;
  return <div className="favorites-bar">
    <div className="favorites-row" role="group" aria-label={t('收藏的标的')}>
      <Button type="button" variant="ghost" className="favorite-toggle" aria-pressed={starred} disabled={disabled || saving || !favorites || !base}
        aria-label={starred ? t('取消收藏 {0}', base) : t('收藏 {0}', base || t('当前标的'))} title={starred ? t('取消收藏 {0}', base) : t('收藏 {0}（所有交易所）', base)} onClick={toggle}>
        <Star aria-hidden="true"/><span>{starred ? t('已收藏') : t('收藏')}</span></Button>
      {favorites?.length ? <ul className="favorites-list">{favorites.map(favorite => { const listed = byBase.has(favorite.base); return <li key={favorite.base}>
        <Button type="button" variant="ghost" className="favorite-chip" aria-current={favorite.base === base ? 'true' : undefined} disabled={disabled || !listed}
          title={listed ? t('{0} · {1} 个市场', favorite.base, byBase.get(favorite.base)!.length) : t('{0} 目前没有可用市场', favorite.base)} onClick={() => open(favorite)}>{favorite.base}</Button>
      </li>; })}</ul> : favorites && <span className="favorites-empty">{t('点星标收藏当前标的，之后可在任意交易所间切换')}</span>}
    </div>
    {venues.length > 1 && <div className="favorites-venues" role="group" aria-label={t('{0} 的其他交易所', base)}>
      {venues.map(market => { const identity = marketIdentity(market.instrument, market); return <Button key={market.instrument} type="button" variant="ghost" aria-pressed={sameMarket(market.instrument, value)} disabled={disabled}
        title={`${venueLabels[identity.venue!]} · ${typeLabels[identity.type!]} · ${identity.base}/${identity.quote}`} onClick={() => pickVenue(market.instrument)}>
        {venueLabels[identity.venue!]}<small>{identity.type === 'swap' ? t('永续') : t('现货')}</small></Button>; })}
    </div>}
    {error && <p className="small amber-text favorites-error" role="alert">{error}</p>}
  </div>;
}
