import { legacyInstrumentSchema, nativeMarketIdSchema, parseInstrumentIdentity } from '../contracts/domain.js';
import type { Market, MarketType, Venue } from '../contracts/domain.js';

export type NormalizedMarket = Market & {
  venue: Venue; type: MarketType; nativeId: string; symbol: string;
  settle: 'USDT' | null; contractSize: number | null;
};
export const VENUES: readonly Venue[] = ['binance', 'okx', 'mexc'];
export const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const chartBases = new Set(['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'ADA', 'AVAX', 'DOT', 'LINK', 'LTC', 'BCH', 'TRX']);
const currency = (v: unknown): v is string => typeof v === 'string' && /^[A-Z0-9]{1,32}$/.test(v);
const positive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 1e12;

export function instrumentId(venue: Venue, type: MarketType, nativeId: string): string {
  if (!VENUES.includes(venue) || !['spot', 'swap'].includes(type) || !nativeMarketIdSchema.safeParse(nativeId).success) throw new Error('invalid_market_identity');
  if (venue === 'okx' && type === 'swap' && legacyInstrumentSchema.safeParse(nativeId).success) return nativeId;
  const id = `${venue}:${type}:${encodeURIComponent(nativeId)}`;
  if (!parseInstrumentIdentity(id)) throw new Error('invalid_market_identity');
  return id;
}

/** CCXT precisionMode: DECIMAL_PLACES=2, SIGNIFICANT_DIGITS=3, TICK_SIZE=4.
 * Significant digits cannot describe a fixed tick size, so that metadata is rejected.
 * Deliberate scope: USDT spot and linear USDT perpetuals only. No synthetic pairs,
 * inverse contracts, expiry futures, options, or composite ticker fallbacks.
 */
export function normalizeMarket(venue: Venue, raw: unknown, precisionMode: number): NormalizedMarket | null {
  if (!record(raw) || raw.active !== true || !currency(raw.base) || raw.quote !== 'USDT' || raw.base === raw.quote ||
      !nativeMarketIdSchema.safeParse(raw.id).success || raw.future === true || raw.option === true ||
      raw.expiry != null || raw.strike != null || raw.optionType != null) return null;
  const type = raw.type;
  if (type !== 'spot' && type !== 'swap') return null;
  if (type === 'spot' ? raw.spot !== true || raw.swap !== false || raw.contract !== false || raw.linear === true || raw.inverse === true || raw.settle != null || raw.contractSize != null
    : raw.swap !== true || raw.spot !== false || raw.contract !== true || raw.linear !== true || raw.inverse !== false || raw.settle !== 'USDT' || !positive(raw.contractSize)) return null;
  if (raw.future !== false || raw.option !== false || !record(raw.precision)) return null;
  const precision = raw.precision.price;
  let tickSize: number;
  if (precisionMode === 4 && positive(precision)) tickSize = precision;
  else if (precisionMode === 2 && typeof precision === 'number' && Number.isInteger(precision) && precision >= 0 && precision <= 18) tickSize = 10 ** -precision;
  else return null;
  const expectedSymbol = `${raw.base}/USDT${type === 'swap' ? ':USDT' : ''}`;
  if (raw.symbol !== expectedSymbol) return null;
  const nativeId = raw.id as string;
  // Canonical OKX legacy IDs must also agree with their unified base/quote metadata.
  if (venue === 'okx' && type === 'swap' && nativeId !== `${raw.base}-USDT-SWAP`) return null;
  return {
    instrument: instrumentId(venue, type, nativeId), venue, type, nativeId, symbol: expectedSymbol,
    base: raw.base, quote: 'USDT', settle: type === 'swap' ? 'USDT' : null,
    contractSize: type === 'swap' ? raw.contractSize as number : null,
    tickSize: String(tickSize), state: 'live', tradingViewSymbol: venue === 'okx' && type === 'swap' && chartBases.has(raw.base) ? `OKX:${raw.base}USDT.P` : '',
  };
}

/** Exclusion needs explicit out-of-scope metadata. Missing or contradictory
 * supported-product fields are failures, not evidence of a delisting. */
function excludedMarket(raw: Record<string, unknown>): boolean {
  if (raw.active === false || currency(raw.quote) && raw.quote !== 'USDT' || currency(raw.base) && raw.base === raw.quote) return true;
  if (raw.spot !== false || raw.contract !== true) return false;
  if (raw.type === 'future') return raw.future === true && raw.swap === false && raw.option === false;
  if (raw.type === 'option') return raw.option === true && raw.swap === false && raw.future === false;
  return raw.type === 'swap' && raw.swap === true && raw.future === false && raw.option === false && (
    raw.linear === false && raw.inverse === true || currency(raw.settle) && raw.settle !== 'USDT'
  );
}

/** A successful empty catalog is authoritative and removes every prior market. */
export function normalizeCatalog(venue: Venue, value: unknown, precisionMode: number, maxMarkets = 20_000): Map<string, NormalizedMarket> {
  if (!record(value)) throw new Error('invalid_catalog');
  const keys = Object.keys(value);
  if (keys.length > maxMarkets) throw new Error('catalog_capacity');
  const next = new Map<string, NormalizedMarket>(), symbols = new Set<string>(), nativeIds = new Set<string>();
  for (const key of keys) {
    const raw = value[key];
    if (!record(raw) || raw.symbol !== key) throw new Error('invalid_catalog_row');
    if (excludedMarket(raw)) continue;
    const market = normalizeMarket(venue, raw, precisionMode);
    if (!market) throw new Error('invalid_catalog_metadata');
    const nativeKey = `${market.type}:${market.nativeId}`;
    if (next.has(market.instrument) || symbols.has(market.symbol) || nativeIds.has(nativeKey)) throw new Error('duplicate_market');
    next.set(market.instrument, market); symbols.add(market.symbol); nativeIds.add(nativeKey);
  }
  return next;
}
