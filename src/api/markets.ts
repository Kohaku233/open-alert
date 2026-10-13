import { z } from 'zod';
import { instrumentSchema, parseInstrumentIdentity } from '../contracts/domain.js';
import type { Market } from '../contracts/domain.js';
import type { CatalogSnapshot } from './ports.js';

const venues = ['binance', 'okx', 'mexc'] as const;
type Venue = typeof venues[number];
type CatalogMarket = Market & { venue?: Venue; type?: 'spot' | 'swap'; nativeId?: string; symbol?: string; available?: boolean };
const unsignedInteger = z.string().regex(/^\d{1,6}$/).transform(Number);
export const marketQuerySchema = z.strictObject({
  q: z.string().max(80).trim().optional(),
  venue: z.enum(venues).optional(),
  type: z.enum(['spot', 'swap']).optional(),
  instrument: instrumentSchema.optional(),
  limit: unsignedInteger.pipe(z.number().int().min(1).max(100)).default(50),
  offset: unsignedInteger.pipe(z.number().int().min(0).max(100_000)).default(0),
});
export type MarketQuery = z.infer<typeof marketQuerySchema>;

/** Metadata is optional for legacy OKX swaps. Qualified identities never alias by base. */
function identity(market: CatalogMarket): { venue?: Venue; type?: 'spot' | 'swap' } {
  const parsed = parseInstrumentIdentity(market.instrument);
  return parsed ? { venue: parsed.venue, type: parsed.type } : {};
}
export function marketSourceStale(snapshot: CatalogSnapshot, market: CatalogMarket): boolean {
  if (snapshot.sources) {
    const {venue,type} = identity(market);
    if (!venue) return true;
    if (Array.isArray(snapshot.sources)) {
      const matches = snapshot.sources.filter(s => s.venue === venue && (!s.type || s.type === type));
      return !matches.length || matches.some(s => s.stale || s.updatedAt === null);
    }
    const source = snapshot.sources[venue];
    return !source || source.stale || source.updatedAt === null;
  }
  // A source can publish eligibility directly when it has no per-venue snapshot.
  return snapshot.stale && market.available !== true;
}
export function marketAvailable(snapshot: CatalogSnapshot, market: CatalogMarket): boolean {
  return market.state === 'live' && market.available !== false && !marketSourceStale(snapshot, market);
}
export function catalogDirectory(snapshot: CatalogSnapshot): CatalogSnapshot {
  return { ...snapshot, markets: snapshot.markets.map(m => ({ ...m, available: marketAvailable(snapshot, m) })) };
}
export function searchMarkets(snapshot: CatalogSnapshot, query: MarketQuery) {
  const terms = (query.q ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const matches = snapshot.markets.filter((m: CatalogMarket) => {
    const id = identity(m);
    if (query.instrument !== undefined && m.instrument !== query.instrument) return false;
    if (query.venue !== undefined && query.venue !== id.venue) return false;
    if (query.type !== undefined && query.type !== id.type) return false;
    // Exact lookup retains stale metadata for existing alert labels; search offers live choices.
    if (query.instrument === undefined && !marketAvailable(snapshot, m)) return false;
    const text = [m.instrument, m.base, m.quote, m.nativeId, m.symbol, id.venue, id.type].filter(Boolean).join(' ').toLowerCase();
    return terms.every(term => text.includes(term));
  }).sort((a, b) => a.instrument < b.instrument ? -1 : a.instrument > b.instrument ? 1 : 0);
  return { ...snapshot, markets: matches.slice(query.offset, query.offset + query.limit).map(m => ({ ...m, available: marketAvailable(snapshot, m) })), total: matches.length, limit: query.limit, offset: query.offset };
}
