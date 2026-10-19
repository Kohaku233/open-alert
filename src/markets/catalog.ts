import { parseInstrumentIdentity } from '../contracts/domain.js';
import type { CatalogMarket, CatalogSnapshot } from '../api/ports.js';

export function marketSourceStale(snapshot: CatalogSnapshot, market: CatalogMarket): boolean {
  if (snapshot.sources) {
    const identity = parseInstrumentIdentity(market.instrument);
    if (!identity) return true;
    const { venue, type } = identity;
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
