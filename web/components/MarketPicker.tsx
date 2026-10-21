import { t, useLanguage } from '../i18n.js';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Check, ChevronsUpDown } from 'lucide-react';
import { Button } from './ui/button.js';
import { Label } from './ui/label.js';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover.js';
import { EmptyState } from './Surface.js';
import { FormError } from './Dialog.js';
import { Command, CommandInput, CommandItem, CommandList } from './ui/command.js';
import { FieldSelect } from './FieldSelect.js';
import type { DirectoryMarket, MarketType, Venue } from '../markets.js';
import { findMarket, marketIdentity, marketKey, marketLabel, sameMarket, selectableMarket, typeLabels, useRetainedMarket, venueLabels } from '../markets.js';
export const MARKET_RESULT_LIMIT = 40;
export function MarketPicker({ compact = false, label, markets, value, onChange, disabled = false, stale = false, error = '', onRetry }: {
    label: string;
    compact?: boolean;
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
    const selected = useRetainedMarket(markets, value);
    const identity = marketIdentity(value, selected);
    const available = selectableMarket(findMarket(markets, value));
    const { results, count } = useMemo(() => {
        const tokens = term.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
        const seen = new Set<string>();
        const matching = markets.filter(market => {
            const identity = marketIdentity(market.instrument, market);
            const key = marketKey(market.instrument);
            if (seen.has(key))
                return false;
            seen.add(key);
            if (venue && venue !== identity.venue || type && type !== identity.type)
                return false;
            const search = [market.instrument, identity.nativeId, market.symbol, identity.base, identity.quote,
                identity.venue ? venueLabels[identity.venue] : '', identity.type ? typeLabels[identity.type] : '', identity.type].join(' ').toLocaleLowerCase();
            return tokens.every(token => search.includes(token));
        });
        matching.sort((a, b) => Number(selectableMarket(b)) - Number(selectableMarket(a)) || marketLabel(a.instrument, a).localeCompare(marketLabel(b.instrument, b), 'en'));
        return { results: matching.slice(0, MARKET_RESULT_LIMIT), count: matching.length };
    }, [markets, term, venue, type, language]);
    const unavailable = !!value && !available;
    return <div className="market-search">
    <Popover open={open && !disabled} onOpenChange={next => { if (!disabled || !next) setOpen(next); }}>
      <PopoverTrigger asChild><Button type="button" className="market-search-trigger" role="combobox" aria-label={label} aria-expanded={open && !disabled} disabled={disabled}>
        <span className="market-search-label">{label}</span>
        <span className={`market-search-selection ${compact ? 'compact-market-identity' : ''}`}>{value ? compact ? <><strong>{identity.base || identity.nativeId}<em> / {identity.quote || '—'}</em></strong><small>{identity.venue ? venueLabels[identity.venue!] : ''} · {identity.type ? typeLabels[identity.type!] : ''}</small></> : marketLabel(value, selected) : t("请选择市场")}{unavailable && <span className="amber-text">{t(" · 不可用，已保留")}</span>}</span>
        <ChevronsUpDown className="market-trigger-chevron" aria-hidden="true" />
      </Button></PopoverTrigger>
      <PopoverContent className="ui-market-popover" align="start" aria-label={t("搜索市场")} onOpenAutoFocus={event => { event.preventDefault(); searchRef.current?.focus(); }}>
        <Command shouldFilter={false} label={t("搜索市场")}>
          <CommandInput ref={searchRef} id={`${id}-term`} aria-label={t("搜索市场")} maxLength={100} value={term} onValueChange={setTerm} placeholder={t("币种、交易对或原生代码")} autoComplete="off" spellCheck={false} aria-describedby={`${id}-count`} />
          <div className="market-search-filters">
            <Label htmlFor={`${id}-venue`}>{t("交易所")}<FieldSelect id={`${id}-venue`} label={t("交易所")} value={venue || 'all'} onValueChange={next => setVenue(next === 'all' ? '' : next as Venue)} options={[{value:'all',label:t("全部交易所")},...(Object.keys(venueLabels) as Venue[]).map(item => ({value:item,label:venueLabels[item]}))]} /></Label>
            <Label htmlFor={`${id}-type`}>{t("市场类型")}<FieldSelect id={`${id}-type`} label={t("市场类型")} value={type || 'all'} onValueChange={next => setType(next === 'all' ? '' : next as MarketType)} options={[{value:'all',label:t("全部类型")},{value:'spot',label:t("现货")},{value:'swap',label:t("USDT 永续")}]} /></Label>
          </div>
          <p className="small muted" id={`${id}-count`} role="status">{count > MARKET_RESULT_LIMIT ? t("找到 {0} 个市场，显示前 {1} 个。请缩小搜索或筛选范围。", count, MARKET_RESULT_LIMIT) : t("找到 {0} 个市场。", count)}</p>
          <CommandList aria-label={t("市场搜索结果")} className="market-command-list">
            {results.map(market => {
              const identity=marketIdentity(market.instrument,market);
              return <CommandItem key={market.instrument} value={market.instrument} data-instrument={market.instrument} aria-label={marketLabel(market.instrument,market)} disabled={!selectableMarket(market)} className="market-command-item" onSelect={() => {
                if (disabled || !selectableMarket(market)) return;
                onChange(market.instrument); setOpen(false);
              }}>
                <span className="market-result-symbol"><strong>{identity.base} / {identity.quote}</strong><small>{identity.nativeId}</small></span>
                <span className="market-result-scope"><span>{identity.venue ? venueLabels[identity.venue] : ''}</span><small>{identity.type ? typeLabels[identity.type] : ''}{selectableMarket(market) ? '' : t(" · 不可用")}</small></span>
                <Check className={sameMarket(market.instrument,value) ? 'market-check' : 'market-check invisible'} aria-hidden="true" />
              </CommandItem>;
            })}
            {!results.length && <EmptyState className="market-search-empty">{markets.length ? t("没有匹配的市场。试试币种名称，或清除交易所和类型筛选。") : t("市场目录暂时为空。请重新读取状态。")}</EmptyState>}
          </CommandList>
          <div className="market-search-help"><p className="small muted">{t("选择后保存的是此交易所的此市场。搜索和筛选不会改变已选市场；不可用结果不能选择。")}</p>
          <FormError message={error ? t("目录刷新未完成：") + error : ''}/>
          {onRetry && <Button type="button" disabled={disabled} onClick={onRetry}>{t("重新读取市场目录")}</Button>}
          {stale && <p className="small amber-text">{t("市场目录已过期。保存时由服务端再次确认可用性。")}</p>}</div>
        </Command>
      </PopoverContent>
    </Popover>
    {unavailable && <p className="small amber-text market-selection-note">{t("已保留原市场。当前目录无法确认它可用，不能用它创建新警报。")}</p>}
  </div>;
}
