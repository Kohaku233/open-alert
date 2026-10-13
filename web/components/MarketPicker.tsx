import { useId, useMemo, useState } from 'react';
import type { DirectoryMarket, MarketType, Venue } from '../markets.js';
import { findMarket, marketIdentity, marketKey, marketLabel, sameMarket, selectableMarket, typeLabels, useRetainedMarket, venueLabels } from '../markets.js';

export const MARKET_RESULT_LIMIT = 40;
export function MarketPicker({ label, markets, value, onChange, disabled = false, stale = false, error = '', onRetry }: {
  label: string; markets: readonly DirectoryMarket[]; value: string; onChange: (instrument: string) => void;
  disabled?: boolean; stale?: boolean; error?: string; onRetry?: () => void;
}) {
  const id = useId();
  const [term, setTerm] = useState('');
  const [venue, setVenue] = useState<Venue | ''>('');
  const [type, setType] = useState<MarketType | ''>('');
  const selected = useRetainedMarket(markets, value);
  const available = selectableMarket(findMarket(markets, value));
  const { results, count } = useMemo(() => {
    const tokens = term.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const seen = new Set<string>();
    const matching = markets.filter(market => {
      const identity = marketIdentity(market.instrument, market);
      const key = marketKey(market.instrument);
      if (seen.has(key)) return false;
      seen.add(key);
      if (venue && venue !== identity.venue || type && type !== identity.type) return false;
      const search = [market.instrument, identity.nativeId, market.symbol, identity.base, identity.quote,
        identity.venue ? venueLabels[identity.venue] : '', identity.type ? typeLabels[identity.type] : '', identity.type].join(' ').toLocaleLowerCase();
      return tokens.every(token => search.includes(token));
    });
    matching.sort((a, b) => Number(selectableMarket(b)) - Number(selectableMarket(a)) || marketLabel(a.instrument, a).localeCompare(marketLabel(b.instrument, b), 'en'));
    return { results: matching.slice(0, MARKET_RESULT_LIMIT), count: matching.length };
  }, [markets, term, venue, type]);
  const visibleValue = results.find(market => sameMarket(market.instrument, value))?.instrument ?? '';
  const unavailable = !!value && !available;
  return <div className="market-search">
    <details>
      <summary aria-disabled={disabled || undefined} onClick={event => { if (disabled) event.preventDefault(); }}>
        <span className="market-search-label">{label}</span>
        <span className="market-search-selection">{value ? marketLabel(value, selected) : '请选择市场'}{unavailable && <span className="amber-text"> · 不可用，已保留</span>}</span>
      </summary>
      <div className="market-search-body">
        <fieldset disabled={disabled}>
          <label htmlFor={`${id}-term`}>搜索市场<input id={`${id}-term`} type="search" maxLength={100} value={term} onChange={event => setTerm(event.target.value)} placeholder="币种、交易对或原生代码" autoComplete="off" spellCheck={false} aria-describedby={`${id}-count`} /></label>
          <div className="market-search-filters"><label htmlFor={`${id}-venue`}>交易所<select id={`${id}-venue`} aria-label="交易所" value={venue} onChange={event => setVenue(event.target.value as Venue | '')}><option value="">全部交易所</option>{(Object.keys(venueLabels) as Venue[]).map(item => <option key={item} value={item}>{venueLabels[item]}</option>)}</select></label><label htmlFor={`${id}-type`}>市场类型<select id={`${id}-type`} aria-label="市场类型" value={type} onChange={event => setType(event.target.value as MarketType | '')}><option value="">全部类型</option><option value="spot">现货</option><option value="swap">USDT 永续</option></select></label></div>
          <p className="small muted" id={`${id}-count`} role="status">{count > MARKET_RESULT_LIMIT ? `找到 ${count} 个市场，显示前 ${MARKET_RESULT_LIMIT} 个。请缩小搜索或筛选范围。` : `找到 ${count} 个市场。`}</p>
          {!!results.length && <label htmlFor={`${id}-results`}>市场搜索结果<select id={`${id}-results`} className="market-search-results" size={Math.min(results.length + 1, 6)} value={visibleValue} onChange={event => {
            const next = findMarket(markets, event.target.value);
            if (selectableMarket(next)) onChange(next!.instrument);
          }} aria-describedby={`${id}-count ${id}-help`}><option value="" disabled>{visibleValue ? '选择其他市场' : '请选择搜索结果'}</option>{results.map(market => <option key={market.instrument} value={market.instrument} disabled={!selectableMarket(market)}>{marketLabel(market.instrument, market)}{selectableMarket(market) ? '' : ' · 不可用'}</option>)}</select></label>}
          {!results.length && <p className="market-search-empty">{markets.length ? '没有匹配的市场。试试币种名称，或清除交易所和类型筛选。' : '市场目录暂时为空。请重新读取状态。'}</p>}
          <p className="small muted" id={`${id}-help`}>选择后保存的是此交易所的此市场。搜索和筛选不会改变已选市场；不可用结果不能选择。</p>
        </fieldset>
        {error && <p className="form-error" role="alert">目录刷新未完成：{error}</p>}
        {(error || !markets.length) && onRetry && <button type="button" disabled={disabled} onClick={onRetry}>重新读取市场目录</button>}
        {stale && <p className="small amber-text">市场目录已过期。保存时由服务端再次确认可用性。</p>}
      </div>
    </details>
    {unavailable && <p className="small amber-text market-selection-note">已保留原市场。当前目录无法确认它可用，不能用它创建新警报。</p>}
  </div>;
}
