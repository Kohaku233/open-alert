import { t, useLanguage } from '../i18n.js';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { MouseEvent } from 'react';
import { Check, ChevronDown, Star } from 'lucide-react';
import { Button } from './ui/button.js';
import { Label } from './ui/label.js';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover.js';
import { EmptyState } from './Surface.js';
import { FormError } from './Dialog.js';
import { Command, CommandGroup, CommandInput, CommandItem, CommandList } from './ui/command.js';
import { FieldSelect } from './FieldSelect.js';
import type { DirectoryMarket, MarketType, Venue } from '../markets.js';
import { findMarket, marketIdentity, marketLabel, sameMarket, selectableMarket, typeLabels, useRetainedMarket, venueLabels } from '../markets.js';
import type { AssetGroup } from '../favorites.js';
import { groupByAsset, toggleFavorite, underlying, useFavorites } from '../favorites.js';
export const MARKET_RESULT_LIMIT = 40;
type Row = AssetGroup & { shown: DirectoryMarket[]; target: DirectoryMarket | undefined };

/** Searches by underlying asset: one row per asset, its venues on the right. Choosing the row opens
 * Binance when it lists the asset (else the first venue that does); a venue chip opens that exact market. */
export function MarketPicker({ compact = false, labelOutside = false, assetOnly = false, label, markets, value, onChange, disabled = false, stale = false, error = '', onRetry }: {
    label: string;
    compact?: boolean;
    labelOutside?: boolean;
    assetOnly?: boolean;
    markets: readonly DirectoryMarket[];
    value: string;
    onChange: (instrument: string) => void;
    disabled?: boolean;
    stale?: boolean;
    error?: string;
    onRetry?: () => void;
}) {
    const language = useLanguage();
    const id = useId();
    const searchRef = useRef<HTMLInputElement>(null);
    const [open, setOpen] = useState(false);
    useEffect(() => {
        if (!open) return;
        const frame = requestAnimationFrame(() => searchRef.current?.focus());
        return () => cancelAnimationFrame(frame);
    }, [open]);
    const [term, setTerm] = useState('');
    const [venue, setVenue] = useState<Venue | ''>('');
    const [type, setType] = useState<MarketType | ''>('');
    const favorites = useFavorites();
    const selected = useRetainedMarket(markets, value);
    const identity = marketIdentity(value, selected);
    const currentBase = identity.base ? underlying(identity.base) : '';
    const available = selectableMarket(findMarket(markets, value));
    const groups = useMemo(() => groupByAsset(markets), [markets]);
    const { starred, others, count, marketCount } = useMemo(() => {
        const tokens = term.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
        const rows: Row[] = [];
        let marketCount = 0;
        for (const group of groups.values()) {
            const shown = group.markets.filter(market => {
                const identity = marketIdentity(market.instrument, market);
                if (venue && venue !== identity.venue || type && type !== identity.type) return false;
                const search = [group.base, market.instrument, identity.nativeId, market.symbol, identity.base, identity.quote,
                    identity.venue ? venueLabels[identity.venue] : '', identity.type ? typeLabels[identity.type] : '', identity.type].join(' ').toLocaleLowerCase();
                return tokens.every(token => search.includes(token));
            });
            if (!shown.length) continue;
            marketCount += shown.length;
            rows.push({ ...group, shown, target: shown.find(selectableMarket) });
        }
        // Exact asset first (typing "Q" should not bury Q under QNT), then live assets, then name.
        const exact = term.trim().toUpperCase();
        rows.sort((a, b) => Number(b.base === exact) - Number(a.base === exact) || Number(!!b.target) - Number(!!a.target) || a.base.localeCompare(b.base, 'en'));
        const stars = new Set(favorites.favorites?.map(f => f.base));
        const starred = favorites.favorites ? favorites.favorites.map(f => rows.find(row => row.base === f.base)).filter((row): row is Row => !!row) : [];
        const others = rows.filter(row => !stars.has(row.base)).slice(0, Math.max(0, MARKET_RESULT_LIMIT - starred.length));
        return { starred, others, count: rows.length, marketCount };
    }, [groups, term, venue, type, favorites.favorites, language]);
    const unavailable = !!value && !available;
    const canStar = !!favorites.favorites && !favorites.unavailable;
    function choose(instrument: string) {
        if (disabled) return;
        onChange(instrument); setOpen(false);
    }
    const stop = (event: MouseEvent) => { event.stopPropagation(); event.preventDefault(); };
    function row(group: Row, isStarred: boolean) {
        const current = group.base === currentBase;
        return <CommandItem key={group.base} value={group.base} data-asset={group.base} data-instrument={group.target?.instrument} aria-label={t('{0} · {1} 个市场', group.base, group.shown.length)}
          disabled={!group.target} data-current={current ? 'true' : undefined} className="market-command-item market-asset-row" onSelect={() => { if (group.target) choose(group.target.instrument); }}>
          {canStar && <Button type="button" variant="ghost" className="market-star" aria-pressed={isStarred} disabled={favorites.saving}
            aria-label={isStarred ? t('取消收藏 {0}', group.base) : t('收藏 {0}', group.base)} title={isStarred ? t('取消收藏 {0}', group.base) : t('收藏 {0}（所有交易所）', group.base)}
            onPointerDown={event => event.stopPropagation()} onClick={event => { stop(event); toggleFavorite(group.base, group.target?.instrument ?? null); }}><Star aria-hidden="true"/></Button>}
          <span className="market-result-symbol"><strong>{group.base}<em> / USDT</em></strong>{!assetOnly&&<small>{group.target ? `${venueLabels[marketIdentity(group.target.instrument, group.target).venue!]} · ${typeLabels[marketIdentity(group.target.instrument, group.target).type!]}` : t('暂不可用')}</small>}</span>
          {assetOnly?<span className="market-venue-summary">{[...new Set(group.shown.map(m=>marketIdentity(m.instrument,m).venue))].map(v=>v?venueLabels[v]:'').join(' · ')}</span>:<span className="market-venues">{group.shown.map(market => {
            const m = marketIdentity(market.instrument, market), live = selectableMarket(market), here = sameMarket(market.instrument, value);
            return <Button key={market.instrument} type="button" variant="ghost" className="market-venue" data-instrument={market.instrument} aria-pressed={here} disabled={!live}
              aria-label={marketLabel(market.instrument, market) + (live ? '' : t(' · 不可用'))} title={`${m.nativeId}${live ? '' : t(' · 不可用')}`}
              onPointerDown={event => event.stopPropagation()} onClick={event => { stop(event); if (live) choose(market.instrument); }}>
              {venueLabels[m.venue!]}<small>{m.type === 'swap' ? t('永续') : t('现货')}</small></Button>;
          })}</span>}
          <Check className={current ? 'market-check' : 'market-check invisible'} aria-hidden="true" />
        </CommandItem>;
    }
    return <div className={`market-search ${labelOutside ? 'market-search-external-label' : ''}`}>
    {labelOutside && <Label htmlFor={`${id}-trigger`}>{label}</Label>}
    <Popover open={open && !disabled} onOpenChange={next => { if (!disabled || !next) setOpen(next); }}>
      <PopoverTrigger asChild><Button id={`${id}-trigger`} type="button" className="market-search-trigger" role="combobox" title={marketLabel(value, selected)} aria-label={label} aria-expanded={open && !disabled} disabled={disabled}>
        {!labelOutside && <span className="market-search-label">{label}</span>}
        <span className={`market-search-selection ${compact ? 'compact-market-identity' : ''}`}>{value ? compact ? <><strong>{identity.base || identity.nativeId}<em> / {identity.quote || '—'}</em></strong>{!assetOnly&&<small>{identity.venue ? venueLabels[identity.venue!] : ''} · {identity.type ? typeLabels[identity.type!] : ''}</small>}</> : marketLabel(value, selected) : t("请选择市场")}{unavailable && <span className="amber-text">{t(" · 不可用，已保留")}</span>}</span>
        <ChevronDown className="market-trigger-chevron" aria-hidden="true" />
      </Button></PopoverTrigger>
      <PopoverContent className="ui-market-popover" align="start" aria-label={t("搜索市场")} onOpenAutoFocus={event => { event.preventDefault(); searchRef.current?.focus(); }}>
        <Command shouldFilter={false} label={t("搜索市场")}>
          <CommandInput ref={searchRef} id={`${id}-term`} aria-label={t("搜索市场")} maxLength={100} value={term} onValueChange={setTerm} placeholder={t("币种、交易对或原生代码")} autoComplete="off" spellCheck={false} aria-describedby={`${id}-count`} />
          <div className="market-search-filters">
            <Label htmlFor={`${id}-venue`}>{t("交易所")}<FieldSelect id={`${id}-venue`} label={t("交易所")} value={venue || 'all'} onValueChange={next => setVenue(next === 'all' ? '' : next as Venue)} options={[{value:'all',label:t("全部交易所")},...(Object.keys(venueLabels) as Venue[]).map(item => ({value:item,label:venueLabels[item]}))]} /></Label>
            <Label htmlFor={`${id}-type`}>{t("市场类型")}<FieldSelect id={`${id}-type`} label={t("市场类型")} value={type || 'all'} onValueChange={next => setType(next === 'all' ? '' : next as MarketType)} options={[{value:'all',label:t("全部类型")},{value:'spot',label:t("现货")},{value:'swap',label:t("USDT 永续")}]} /></Label>
          </div>
          <p className="small muted" id={`${id}-count`} role="status">{count > starred.length + others.length ? t("找到 {0} 个标的（{1} 个市场），显示前 {2} 个。请缩小搜索或筛选范围。", count, marketCount, starred.length + others.length) : t("找到 {0} 个标的（{1} 个市场）。", count, marketCount)}</p>
          <CommandList aria-label={t("市场搜索结果")} className="market-command-list">
            {starred.length > 0 && <CommandGroup heading={t('收藏')} className="market-group">{starred.map(group => row(group, true))}</CommandGroup>}
            {others.length > 0 && <CommandGroup heading={starred.length ? t('全部标的') : undefined} className="market-group">{others.map(group => row(group, false))}</CommandGroup>}
            {!starred.length && !others.length && <EmptyState className="market-search-empty">{markets.length ? t("没有匹配的市场。试试币种名称，或清除交易所和类型筛选。") : t("市场目录暂时为空。请重新读取状态。")}</EmptyState>}
          </CommandList>
          <div className="market-search-help">
          <FormError message={error ? t("目录刷新未完成：") + error : favorites.error}/>
          {onRetry && <Button type="button" disabled={disabled} onClick={onRetry}>{t("重新读取市场目录")}</Button>}
          {stale && <p className="small amber-text">{t("市场目录已过期。保存时由服务端再次确认可用性。")}</p>}</div>
        </Command>
      </PopoverContent>
    </Popover>
    {unavailable && <p className="small amber-text market-selection-note">{t("已保留原市场。当前目录无法确认它可用，不能用它创建新警报。")}</p>}
  </div>;
}
