/** Pure anomaly rules. Every network, clock and persistence concern lives elsewhere
 * so the statistical behaviour can be tested deterministically. */
export type Category = 'crypto' | 'tradfi';
export type Session = 'all' | 'rth' | 'off' | 'weekend';
export type WindowKey = '15m' | '1h' | '4h' | '24h';
export type Direction = 'up' | 'down';
export const HOUR = 3_600_000, MINUTE = 60_000;
export const WINDOWS: readonly { key: WindowKey; ms: number }[] = [
  { key: '15m', ms: 15 * MINUTE }, { key: '1h', ms: HOUR }, { key: '4h', ms: 4 * HOUR }, { key: '24h', ms: 24 * HOUR },
];
export interface HourBar { t: number; c: number; q: number }
export interface RuleConfig {
  /** |return| must be at least this many session standard deviations. */
  z: Record<Category, number>;
  /** Window quote volume must be at least this multiple of its session median. */
  volumeMultiple: number;
  /** System floor on the simple move; users may only raise it. Crypto is BTC-relative. */
  minMove: Record<Category, number>;
  minSamples: number;
}
export const DEFAULT_RULES: Readonly<RuleConfig> = Object.freeze({
  z: { crypto: 6, tradfi: 4 }, volumeMultiple: 3, minMove: { crypto: 0.10, tradfi: 0.02 }, minSamples: 100,
});

/** Second Sunday of March to first Sunday of November, switching at 07:00/06:00 UTC. */
function usDaylight(t: number): boolean {
  const year = new Date(t).getUTCFullYear();
  const nthSunday = (month: number, n: number) => { const first = new Date(Date.UTC(year, month, 1)).getUTCDay(); return Date.UTC(year, month, 1 + ((7 - first) % 7) + (n - 1) * 7); };
  return t >= nthSunday(2, 2) + 7 * HOUR && t < nthSunday(10, 1) + 6 * HOUR;
}
/** Crypto trades as one regime. TradFi contracts split into US regular hours, weekday
 * off-hours and weekends: a quiet weekend makes a 6% move far rarer than in session. */
export function sessionOf(t: number, category: Category): Session {
  if (category === 'crypto') return 'all';
  const d = new Date(t), day = d.getUTCDay();
  if (day === 0 || day === 6) return 'weekend';
  const open = (usDaylight(t) ? 13.5 : 14.5) * 60, minute = d.getUTCHours() * 60 + d.getUTCMinutes();
  return minute >= open && minute < open + 390 ? 'rth' : 'off';
}

export interface Baseline {
  /** Root-mean-square log return per window and session. */
  sd: Partial<Record<WindowKey, Partial<Record<Session, number>>>>;
  medianVolume: Partial<Record<WindowKey, Partial<Record<Session, number>>>>;
  builtAt: number;
}
const median = (values: number[]) => { const s = [...values].sort((a, b) => a - b); return s.length ? s[s.length >> 1]! : NaN; };

/** 30 days of hourly bars (t = open time) → per-session volatility. Crypto returns are
 * measured against BTC over the same interval so market-wide moves are not coin anomalies. */
export function buildBaseline(bars: readonly HourBar[], category: Category, btc: ReadonlyMap<number, number> | null, now: number, rules: RuleConfig = DEFAULT_RULES): Baseline {
  const sorted = [...bars].filter(b => b.c > 0 && Number.isFinite(b.c) && Number.isFinite(b.q)).sort((a, b) => a.t - b.t);
  const index = new Map(sorted.map((b, i) => [b.t, i])), prefix = [0];
  for (const bar of sorted) prefix.push(prefix.at(-1)! + Math.max(0, bar.q));
  const result: Baseline = { sd: {}, medianVolume: {}, builtAt: now };
  for (const hours of [1, 4, 24]) {
    const returns = new Map<Session, number[]>(), volumes = new Map<Session, number[]>();
    for (let i = 0; i < sorted.length; i++) {
      const start = index.get(sorted[i]!.t - hours * HOUR);
      if (start === undefined) continue;
      let r = Math.log(sorted[i]!.c / sorted[start]!.c);
      if (btc) {
        const b0 = btc.get(sorted[start]!.t), b1 = btc.get(sorted[i]!.t);
        if (!b0 || !b1) continue;
        r -= Math.log(b1 / b0);
      }
      const session = sessionOf(sorted[i]!.t + HOUR - 1, category);
      (returns.get(session) ?? returns.set(session, []).get(session)!).push(r);
      (volumes.get(session) ?? volumes.set(session, []).get(session)!).push(prefix[i + 1]! - prefix[start + 1]!);
    }
    const key = `${hours}h` as WindowKey;
    for (const [session, values] of returns) {
      if (values.length < rules.minSamples) continue;
      const sd = Math.sqrt(values.reduce((sum, r) => sum + r * r, 0) / values.length);
      if (!(sd > 0)) continue;
      (result.sd[key] ??= {})[session] = sd;
      (result.medianVolume[key] ??= {})[session] = median(volumes.get(session)!);
      // Sub-hour volatility scales with the square root of time; volume linearly.
      if (hours === 1) { (result.sd['15m'] ??= {})[session] = sd / 2; (result.medianVolume['15m'] ??= {})[session] = median(volumes.get(session)!) / 4; }
    }
  }
  return result;
}

/** btcReturn is the BTC log return over the same window (crypto only). */
export interface WindowObservation { priceNow: number; priceThen: number; volume: number; btcReturn: number | null }
export interface Signal {
  window: WindowKey; direction: Direction; session: Session; price: number;
  /** Simple returns: raw venue move and, for crypto, the move net of BTC. */
  move: number; relativeMove: number; z: number; volumeMultiple: number;
}
/** Strongest window passing every condition, or null. */
export function evaluate(category: Category, isBtc: boolean, baseline: Baseline, now: number,
  windows: Partial<Record<WindowKey, WindowObservation>>, rules: RuleConfig = DEFAULT_RULES): Signal | null {
  const session = sessionOf(now, category);
  let best: Signal | null = null, bestScore = 0;
  for (const { key } of WINDOWS) {
    const w = windows[key], sd = baseline.sd[key]?.[session], med = baseline.medianVolume[key]?.[session];
    if (!w || !(w.priceThen > 0) || !(w.priceNow > 0) || !sd || !Number.isFinite(w.volume) || !(med! > 0)) continue;
    const raw = Math.log(w.priceNow / w.priceThen);
    let relative = raw;
    if (category === 'crypto' && !isBtc) { if (w.btcReturn === null) continue; relative -= w.btcReturn; }
    const z = relative / sd, volumeMultiple = w.volume / med!;
    const relativeMove = Math.expm1(relative);
    if (Math.abs(z) < rules.z[category] || volumeMultiple < rules.volumeMultiple || Math.abs(relativeMove) < rules.minMove[category]) continue;
    const score = Math.abs(z) / rules.z[category];
    if (score > bestScore) { bestScore = score; best = { window: key, direction: relative > 0 ? 'up' : 'down', session, price: w.priceNow, move: Math.expm1(raw), relativeMove, z, volumeMultiple }; }
  }
  return best;
}

export interface CooldownMark { at: number; direction: Direction; move: number }
/** Same direction within the cooldown needs at least `multiple` × the last pushed move.
 * A reversal always passes: a +130% pump followed by −72% is two stories. */
export function admit(previous: CooldownMark | undefined, next: CooldownMark, cooldownMs = 24 * HOUR, multiple = 2): boolean {
  if (!previous || next.at - previous.at >= cooldownMs || previous.direction !== next.direction) return true;
  return Math.abs(next.move) >= multiple * Math.abs(previous.move);
}

/** Several tickers of one underlying (2x wrappers, venue suffixes) are one entity. */
const ALIASES: Readonly<Record<string, string>> = {
  SKHY: 'SKHYNIX', CSOPSKHYNIX2L: 'SKHYNIX', SAMSUNGEM: 'SAMSUNG', CSOPSAMSUNG2L: 'SAMSUNG', TESLA: 'TSLA', TSLL: 'TSLA',
  NVIDIA: 'NVDA', NVDL: 'NVDA', NVD: 'NVDA', COINBASE: 'COIN', ROBINHOOD: 'HOOD', MUU: 'MU', TSMC: 'TSM', MSTU: 'MSTR',
  AAPU: 'AAPL', AMZU: 'AMZN', GGLL: 'GOOGL', MSFU: 'MSFT', HK0700: 'TENCENT', HK1810: 'XIAOMI', BABAHK: 'BABA',
  NAS100: 'US100', SPX500: 'US500', USOIL: 'CL', UKOIL: 'BZ', NGAS: 'NATGAS', NG: 'NATGAS', XCU: 'COPPER',
};
export function tradfiEntity(base: string): string {
  const upper = base.toUpperCase();
  const stripped = upper.length > 5 && upper.endsWith('STOCK') ? upper.slice(0, -5) : upper;
  return ALIASES[stripped] ?? stripped;
}
export function displayBase(base: string): string { return base.replace(/^1000+(?=[A-Z])/, '').replace(/^1M(?=[A-Z])/, ''); }
