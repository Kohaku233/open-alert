import type { Market } from '../contracts/domain.js';
import type { MarketQuote } from './quotes.js';

// Fixed public display markets. These snapshots never create scheduler demand.
export const PREVIEW_MARKETS: readonly Market[] = [
  { instrument:'binance:swap:BTCUSDT',venue:'binance',type:'swap',nativeId:'BTCUSDT',symbol:'BTC/USDT:USDT',base:'BTC',quote:'USDT',settle:'USDT',contractSize:1,tickSize:'0.1',state:'live',tradingViewSymbol:'BINANCE:BTCUSDT.P' },
  { instrument:'ETH-USDT-SWAP',venue:'okx',type:'swap',nativeId:'ETH-USDT-SWAP',symbol:'ETH/USDT:USDT',base:'ETH',quote:'USDT',settle:'USDT',contractSize:0.1,tickSize:'0.01',state:'live',tradingViewSymbol:'OKX:ETHUSDT.P' },
  { instrument:'mexc:spot:SOLUSDT',venue:'mexc',type:'spot',nativeId:'SOLUSDT',symbol:'SOL/USDT',base:'SOL',quote:'USDT',settle:null,contractSize:null,tickSize:'0.01',state:'live',tradingViewSymbol:'MEXC:SOLUSDT' },
];
export interface PublicPreviewEntry {
  instrument: string; venue: string; pair: string;
  quote: MarketQuote | null; history: MarketQuote[]; stale: boolean;
}
export interface PublicMarketPreview { entries: PublicPreviewEntry[]; capturedAt: number }

export function createPublicMarketPreview(options: { read: (market: Market) => Promise<MarketQuote[]>; now?: () => number }) {
  const now=options.now??Date.now;
  let cached: PublicMarketPreview | null=null, flight: Promise<PublicMarketPreview> | null=null;
  async function refresh(): Promise<PublicMarketPreview> {
    const entries=await Promise.all(PREVIEW_MARKETS.map(async market=>{
      const prior=cached?.entries.find(entry=>entry.instrument===market.instrument);
      const identity={instrument:market.instrument,venue:market.venue!.toUpperCase(),pair:market.base+'/USDT'+(market.type==='swap'?'-P':'')};
      try {
        const history=(await options.read(market)).filter(q=>q.instrument===market.instrument&&Number.isFinite(q.price)&&q.price>0&&q.price<=1e12&&Number.isSafeInteger(q.observedAt)&&q.observedAt<=now()+5000&&now()-q.observedAt<=30000).slice(-90);
        const quote=history.at(-1)??null;
        if(!quote)throw new Error('preview_unavailable');
        return {...identity,quote,history,stale:now()-quote.observedAt>15000};
      }catch{return {...identity,quote:prior?.quote??null,history:prior?.history??[],stale:true};}
    }));
    cached={entries,capturedAt:now()};return cached;
  }
  return {get(): Promise<PublicMarketPreview> {
    if(cached&&now()>=cached.capturedAt&&now()-cached.capturedAt<5000)return Promise.resolve(structuredClone(cached));
    flight??=refresh().finally(()=>{flight=null;});return flight.then(value=>structuredClone(value));
  }};
}
