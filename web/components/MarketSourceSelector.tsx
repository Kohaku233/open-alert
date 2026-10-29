import { useMemo } from 'react';
import type { DirectoryMarket } from '../markets.js';
import { findMarket, marketIdentity, marketLabel, sameMarket, selectableMarket, typeLabels, venueLabels } from '../markets.js';
import { groupByAsset, underlying } from '../favorites.js';
import { FieldSelect } from './FieldSelect.js';
import { t } from '../i18n.js';

/** Keep the quote source visible separately from asset search. Values are exact market identities. */
export function MarketSourceSelector({markets,value,onChange,disabled=false}:{
  markets:readonly DirectoryMarket[];value:string;onChange:(instrument:string)=>void;disabled?:boolean;
}){
  const groups=useMemo(()=>groupByAsset(markets),[markets]);
  const identity=marketIdentity(value,findMarket(markets,value));
  const sources=groups.get(underlying(identity.base))?.markets??[];
  const sourceValue=sources.find(m=>sameMarket(m.instrument,value))?.instrument??value;
  const options=sources.map(market=>{
    const source=marketIdentity(market.instrument,market);
    return {value:market.instrument,label:`${venueLabels[source.venue!]} · ${typeLabels[source.type!]}${source.base!==identity.base?` · ${source.base}`:''}`,disabled:!selectableMarket(market)};
  });
  if(value&&!sources.some(m=>sameMarket(m.instrument,value)))options.unshift({value,label:marketLabel(value),disabled:true});
  return <div className="market-source-selector"><FieldSelect label={t('行情来源')} value={sourceValue} disabled={disabled||!options.length} options={options}
    onValueChange={instrument=>{if(selectableMarket(findMarket(markets,instrument)))onChange(instrument);}}/></div>;
}
