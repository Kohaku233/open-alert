import { t } from './i18n.js';
import { useRef } from 'react';
import type { Market } from '../src/contracts/domain.js';
export type Venue = 'binance' | 'okx' | 'mexc';
export type MarketType = 'spot' | 'swap';
// Optional metadata permits both the expanded API and existing bare OKX fixtures.
export type DirectoryMarket = Omit<Market, 'quote' | 'state' | 'settle' | 'contractSize'> & {
    quote: string;
    state: string;
    available?: boolean;
    venue?: Venue;
    type?: MarketType;
    nativeId?: string;
    symbol?: string;
    settle?: string | null;
    contractSize?: number | null;
};
export interface MarketIdentity {
    instrument: string;
    venue: Venue | null;
    type: MarketType | null;
    nativeId: string;
    base: string;
    quote: string;
}
export const venueLabels: Record<Venue, string> = { binance: 'Binance', okx: 'OKX', mexc: 'MEXC' };
export const typeLabels: Record<MarketType, string> = { get spot() {
        return t("现货");
    }, get swap() {
        return t("USDT 永续");
    } };
const venues = new Set<string>(Object.keys(venueLabels));
export function marketIdentity(instrument: string, market?: DirectoryMarket): MarketIdentity {
    const canonical = /^(binance|okx|mexc):(spot|swap):([^:]+)$/.exec(instrument);
    const legacy = /^[A-Z0-9]{1,24}-USDT-SWAP$/.test(instrument);
    const venue = market?.venue && venues.has(market.venue) ? market.venue : canonical ? canonical[1] as Venue : legacy ? 'okx' : null;
    const type = market?.type === 'spot' || market?.type === 'swap' ? market.type : canonical ? canonical[2] as MarketType : legacy ? 'swap' : null;
    let nativeId = market?.nativeId || canonical?.[3] || instrument;
    if (!market?.nativeId && canonical) {
        try {
            nativeId = decodeURIComponent(nativeId);
        }
        catch { /* Keep unknown native text visible. */ }
    }
    // Only parse units when the venue and product identity are explicit.
    const nativePair = venue && type ? /^(?:([A-Z0-9]+)[_-]USDT(?:-SWAP)?|([A-Z0-9]+)USDT)$/.exec(nativeId) : null;
    return { instrument, venue, type, nativeId, base: market?.base || nativePair?.[1] || nativePair?.[2] || '', quote: market?.quote || (nativePair ? 'USDT' : '') };
}
export function marketKey(instrument: string): string {
    return /^[A-Z0-9]{1,24}-USDT-SWAP$/.test(instrument) ? `okx:swap:${instrument}` : instrument;
}
export const sameMarket = (a: string, b: string) => marketKey(a) === marketKey(b);
export function findMarket(markets: readonly DirectoryMarket[], instrument: string): DirectoryMarket | undefined {
    return markets.find(market => sameMarket(market.instrument, instrument));
}
export function marketLabel(instrument: string, market?: DirectoryMarket): string {
    const identity = marketIdentity(instrument, market);
    const pair = identity.base && identity.quote ? `${identity.base} / ${identity.quote}` : identity.nativeId;
    return `${identity.venue ? venueLabels[identity.venue] : t("未知交易所")} · ${identity.type ? typeLabels[identity.type] : t("未知市场类型")} · ${pair}`;
}
export function marketQuote(instrument: string, market?: DirectoryMarket): string {
    return marketIdentity(instrument, market).quote || t("报价单位未知");
}
export function selectableMarket(market: DirectoryMarket | undefined): boolean {
    if (!market || market.state !== 'live' || market.available === false)
        return false;
    const identity = marketIdentity(market.instrument, market);
    return !!identity.venue && !!identity.type && !!identity.base && identity.quote === 'USDT'
        && (identity.type === 'spot' || !market.settle || market.settle === 'USDT');
}
// Preserve the last known metadata across catalog removals without pretending it is available.
export function useRetainedMarket(markets: readonly DirectoryMarket[], instrument: string): DirectoryMarket | undefined {
    const retained = useRef<DirectoryMarket | undefined>(undefined);
    const current = findMarket(markets, instrument);
    if (current)
        retained.current = current;
    else if (retained.current && !sameMarket(retained.current.instrument, instrument))
        retained.current = undefined;
    return current ?? retained.current;
}
const verifiedOKXBases = new Set(['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'ADA', 'AVAX', 'LINK', 'DOT', 'LTC', 'BCH', 'TRX']);
// Explicit chart allowlist. Embedded chart selection never changes alert identity.
export function verifiedChartSymbol(symbol: string, market?: DirectoryMarket): boolean {
    const match = /^(OKX|BINANCE|MEXC):([A-Z0-9]+)USDT(\.P)?$/.exec(symbol);
    if (!match || !verifiedOKXBases.has(match[2]!))
        return false;
    if (match[1] === 'MEXC' && match[3])
        return false;
    if (!market)
        return true;
    const identity = marketIdentity(market.instrument, market);
    return identity.venue?.toUpperCase() === match[1] && identity.type === (match[3] ? 'swap' : 'spot') && identity.quote === 'USDT' && identity.base === match[2];
}
