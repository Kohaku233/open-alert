import WebSocket from 'ws';
import { instrumentId } from '../markets/normalize.js';
import type { AnomalyEvent, AnomalyStore, VenueHit, AnomalySettings } from './store.js';
import { admit, buildBaseline, displayBase, evaluate, HOUR, MINUTE, tradfiEntity, WINDOWS, DEFAULT_RULES } from './rules.js';
import type { Baseline, Category, CooldownMark, HourBar, RuleConfig, Signal, WindowObservation, WindowKey } from './rules.js';

export type AnomalyVenue = 'binance' | 'okx' | 'mexc';
export const ANOMALY_VENUES: readonly AnomalyVenue[] = ['binance', 'okx', 'mexc'];
export const MIN_QUOTE_VOLUME = 10_000_000, MIN_MARKET_CAP = 10_000_000;
type Fetch = typeof fetch;
interface Bar { t: number; c: number; q: number }
export interface Series {
  key: string; venue: AnomalyVenue; nativeId: string; base: string; category: Category; instrument: string;
  quoteVolume24h: number; hours: Bar[]; minutes: Bar[]; baseline: Baseline | null; coinId: string | null;
}
export interface UniverseRow { venue: AnomalyVenue; nativeId: string; base: string; category: Category; quoteVolume24h: number }
export interface Delivery {
  send(userId: string, message: string, title: string, settings: AnomalySettings): Promise<{ outcome: 'sent' | 'failed' | 'uncertain' | 'skipped'; code: string | null }>;
}
export interface AnomalyEngineOptions {
  store: AnomalyStore; delivery: Delivery; appUrl: string;
  binanceRest?: string; fetch?: Fetch; now?: () => number; rules?: RuleConfig;
  /** Hold the first hit this long so other venues and correlated symbols join one push. */
  gatherMs?: number; evaluateMs?: number; connect?: boolean;
}
export interface AnomalyStatus {
  state: 'starting' | 'running' | 'degraded' | 'stopped';
  series: number; baselines: number; crypto: number; tradfi: number; withMarketCap: number;
  streams: Record<AnomalyVenue, boolean>; lastEvaluationAt: number | null; universeAt: number | null; marketCapAt: number | null;
}
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const num = (v: unknown) => { const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN; return Number.isFinite(n) ? n : NaN; };
const okBar = (b: Bar) => b.c > 0 && b.c <= 1e12 && Number.isSafeInteger(b.t) && b.q >= 0 && Number.isFinite(b.q);

/** Last bar fully closed at or before ts. */
function lastClosedBefore(bars: readonly Bar[], ts: number, span: number): number {
  let lo = 0, hi = bars.length - 1, found = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (bars[mid]!.t + span <= ts) { found = mid; lo = mid + 1; } else hi = mid - 1; }
  return found;
}
export function closeAt(s: Pick<Series, 'minutes' | 'hours'>, ts: number): number | null {
  const m = s.minutes, i = lastClosedBefore(m, ts, MINUTE);
  if (i >= 0 && ts - m[i]!.t < 10 * MINUTE) return m[i]!.c;
  const h = s.hours, j = lastClosedBefore(h, ts, HOUR);
  return j >= 0 && ts - h[j]!.t < 3 * HOUR ? h[j]!.c : null;
}
export function volumeSince(s: Pick<Series, 'minutes' | 'hours'>, from: number): number {
  const firstMinute = s.minutes[0]?.t ?? Infinity;
  let sum = 0;
  for (const bar of s.minutes) if (bar.t >= from) sum += bar.q;
  if (from < firstMinute) for (const bar of s.hours) if (bar.t >= from && bar.t + HOUR <= firstMinute) sum += bar.q;
  return sum;
}
export function mergeMinute(bars: Bar[], bar: Bar, keepMs = 25 * HOUR): void {
  if (!okBar(bar)) return;
  const last = bars.at(-1);
  if (!last || bar.t > last.t) bars.push(bar);
  else if (bar.t === last.t) bars[bars.length - 1] = bar;
  else { const i = bars.findIndex(b => b.t >= bar.t); if (i >= 0 && bars[i]!.t === bar.t) bars[i] = bar; else if (i >= 0) bars.splice(i, 0, bar); }
  const cutoff = bars.at(-1)!.t - keepMs;
  let drop = 0; while (drop < bars.length && bars[drop]!.t < cutoff) drop++;
  if (drop) bars.splice(0, drop);
}

export interface Hit { series: Series; signal: Signal }
export interface Group { id: string; openedAt: number; deadline: number; entities: Map<string, { hits: Hit[]; category: Category; label: string; marketCap: number | null }> }
const pct = (v: number) => `${v >= 0 ? '+' : '−'}${(Math.abs(v) * 100).toFixed(Math.abs(v) >= 0.1 ? 1 : 2)}%`;
const price = (v: number) => v >= 1000 ? v.toFixed(1) : v >= 1 ? v.toPrecision(5) : v.toPrecision(4);
const money = (v: number) => v >= 1e9 ? `$${(v / 1e9).toFixed(1)}B` : `$${Math.round(v / 1e6)}M`;
const sessionText: Record<string, string> = { rth: '美股盘中', off: '美股盘外', weekend: '周末休市', all: '' };

/** Push text for one group; entities are already filtered for the recipient. */
export function formatPush(events: readonly AnomalyEvent[], appUrl: string): { title: string; message: string } {
  const sorted = [...events].sort((a, b) => Math.abs(b.z) - Math.abs(a.z));
  const first = sorted[0]!;
  const headline = (e: AnomalyEvent) => `${e.label} ${pct(e.move)}`;
  const same = sorted.every(e => e.direction === first.direction);
  const title = sorted.length === 1 ? `异动 · ${headline(first)} / ${first.window}`
    : `异动 · ${sorted.length} 个标的${same ? (first.direction === 'up' ? '同步拉升' : '同步下跌') : '剧烈波动'}`;
  const lines: string[] = [];
  for (const e of sorted.slice(0, 6)) {
    const relative = e.category === 'crypto' && e.label !== 'BTC' ? ` · 相对 BTC ${pct(e.relativeMove)}` : '';
    const context = [e.category === 'tradfi' ? sessionText[e.session] : '', e.marketCap ? `市值 ${money(e.marketCap)}` : ''].filter(Boolean).join(' · ');
    lines.push(`${headline(e)} / ${e.window}${relative}`);
    lines.push(`常态波动的 ${Math.abs(e.z).toFixed(1)} 倍 · 成交量 ${e.volumeMultiple.toFixed(1)} 倍${context ? ' · ' + context : ''}`);
    lines.push(e.venues.map(v => `${v.venue.toUpperCase()} ${price(v.price)}`).join(' · '));
    lines.push('');
  }
  if (sorted.length > 6) lines.push(`另有 ${sorted.length - 6} 个标的`);
  const link = `${appUrl}/dashboard?market=${encodeURIComponent(first.venues[0]!.instrument)}`;
  let message = lines.join('\n').trim();
  if ([...message].length + link.length + 2 > 1024) message = [...message].slice(0, 1024 - link.length - 4).join('') + '…';
  return { title: [...title].slice(0, 250).join(''), message: `${message}\n\n${link}` };
}

export function createAnomalyEngine(options: AnomalyEngineOptions) {
  const now = options.now ?? Date.now, rules = options.rules ?? DEFAULT_RULES;
  const fetcher = options.fetch ?? fetch, bnRest = options.binanceRest ?? 'https://fapi.binance.com/fapi/v1';
  const gatherMs = options.gatherMs ?? 30_000, evaluateMs = options.evaluateMs ?? 10_000;
  const series = new Map<string, Series>();
  const coinIds = new Map<string, string>(), marketCaps = new Map<string, number>();
  /** Shared feed de-duplication only; it never decides whether a user is pushed. */
  const lastPush = new Map<string, CooldownMark>();
  /** Per user × entity: the last move actually pushed to that user. */
  const userMarks = new Map<string, CooldownMark>();
  const userKey = (userId: string, entity: string) => `${userId}\u0000${entity}`;
  const sockets = new Map<AnomalyVenue, WebSocket[]>();
  const connected: Record<AnomalyVenue, boolean> = { binance: false, okx: false, mexc: false };
  const timers: ReturnType<typeof setInterval>[] = [];
  let group: Group | null = null, stopped = false, started = false, flushing: Promise<void> | null = null;
  let lastEvaluationAt: number | null = null, universeAt: number | null = null, marketCapAt: number | null = null, mappingAt = 0;

  async function json(url: string, attempts = 3): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await fetcher(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
        if (response.status === 429 && attempt < attempts) { await response.body?.cancel(); await sleep(5000 * (attempt + 1)); continue; }
        if (!response.ok) { await response.body?.cancel(); throw new Error(`http_${response.status}`); }
        return await response.json();
      } catch (error) { if (attempt >= attempts || stopped) throw error; await sleep(1000 * (attempt + 1)); }
    }
  }
  const list = (v: unknown, key?: string): Record<string, unknown>[] => { const value = key && v && typeof v === 'object' ? (v as Record<string, unknown>)[key] : v; return Array.isArray(value) ? value.filter(x => x && typeof x === 'object') as Record<string, unknown>[] : []; };

  async function universe(venue: AnomalyVenue): Promise<UniverseRow[]> {
    if (venue === 'binance') {
      const [info, tickers] = await Promise.all([json(`${bnRest}/exchangeInfo`), json(`${bnRest}/ticker/24hr`)]);
      const volume = new Map(list(tickers).map(t => [String(t.symbol), num(t.quoteVolume)]));
      return list(info, 'symbols').filter(s => s.quoteAsset === 'USDT' && s.marginAsset === 'USDT' && s.status === 'TRADING' && (s.contractType === 'PERPETUAL' || s.contractType === 'TRADIFI_PERPETUAL'))
        .map(s => ({ venue, nativeId: String(s.symbol), base: String(s.baseAsset), category: s.underlyingType === 'COIN' ? 'crypto' as const : 'tradfi' as const, quoteVolume24h: volume.get(String(s.symbol)) ?? 0 }));
    }
    if (venue === 'okx') {
      const [info, tickers] = await Promise.all([json('https://www.okx.com/api/v5/public/instruments?instType=SWAP'), json('https://www.okx.com/api/v5/market/tickers?instType=SWAP')]);
      const volume = new Map(list(tickers, 'data').map(t => [String(t.instId), num(t.volCcy24h) * num(t.last)]));
      return list(info, 'data').filter(s => s.settleCcy === 'USDT' && s.state === 'live' && /^[A-Z0-9]+-USDT-SWAP$/.test(String(s.instId)))
        .map(s => ({ venue, nativeId: String(s.instId), base: String(s.instId).split('-')[0]!, category: s.instCategory === '1' ? 'crypto' as const : 'tradfi' as const, quoteVolume24h: volume.get(String(s.instId)) ?? 0 }));
    }
    const [info, tickers] = await Promise.all([json('https://contract.mexc.com/api/v1/contract/detail'), json('https://contract.mexc.com/api/v1/contract/ticker')]);
    const volume = new Map(list(tickers, 'data').map(t => [String(t.symbol), num(t.amount24)]));
    return list(info, 'data').filter(s => s.quoteCoin === 'USDT' && s.settleCoin === 'USDT' && s.state === 0 && /^[A-Z0-9]+_USDT$/.test(String(s.symbol)))
      .map(s => ({ venue, nativeId: String(s.symbol), base: String(s.baseCoin), category: s.type === 1 ? 'crypto' as const : 'tradfi' as const, quoteVolume24h: volume.get(String(s.symbol)) ?? 0 }));
  }
  async function refreshUniverse(): Promise<boolean> {
    let changed = false;
    for (const venue of ANOMALY_VENUES) {
      let rows: UniverseRow[];
      try { rows = await universe(venue); } catch { console.warn('open_alert_anomaly_universe_failed', venue); continue; }
      if (!rows.length) continue;
      const keep = new Set<string>();
      for (const row of rows) {
        // BTC stays in scope as the crypto reference even if a venue's volume dips.
        if (row.quoteVolume24h < MIN_QUOTE_VOLUME && !(row.category === 'crypto' && displayBase(row.base) === 'BTC')) continue;
        let instrument: string; try { instrument = instrumentId(venue, 'swap', row.nativeId); } catch { continue; }
        const key = `${venue}:${row.nativeId}`; keep.add(key);
        const existing = series.get(key);
        if (existing) { existing.quoteVolume24h = row.quoteVolume24h; existing.category = row.category; continue; }
        series.set(key, { key, venue, nativeId: row.nativeId, base: row.base, category: row.category, instrument, quoteVolume24h: row.quoteVolume24h, hours: [], minutes: [], baseline: null, coinId: coinIds.get(key) ?? null });
        changed = true;
      }
      for (const key of [...series.keys()]) if (key.startsWith(venue + ':') && !keep.has(key)) { series.delete(key); changed = true; }
    }
    universeAt = now();
    return changed;
  }

  /** Map by CoinGecko's exchange ticker coin_id, never by symbol text: Q is quack-ai, not another Q. */
  async function refreshMapping() {
    const ids: Record<AnomalyVenue, string> = { binance: 'binance_futures', okx: 'okex_swap', mexc: 'mxc_futures' };
    for (const venue of ANOMALY_VENUES) {
      try {
        const body = await json(`https://api.coingecko.com/api/v3/derivatives/exchanges/${ids[venue]}?include_tickers=unexpired`);
        for (const t of list(body, 'tickers')) if (typeof t.coin_id === 'string' && t.coin_id && typeof t.symbol === 'string') coinIds.set(`${venue}:${t.symbol}`, t.coin_id);
      } catch { console.warn('open_alert_anomaly_mapping_failed', venue); }
      await sleep(2500);
    }
    for (const s of series.values()) s.coinId = s.category === 'crypto' ? coinIds.get(s.key) ?? null : null;
    mappingAt = now();
  }
  async function refreshMarketCaps() {
    const wanted = [...new Set([...series.values()].map(s => s.coinId).filter((v): v is string => !!v))];
    for (let i = 0; i < wanted.length; i += 200) {
      try {
        const rows = list(await json(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&per_page=250&ids=${wanted.slice(i, i + 200).map(encodeURIComponent).join(',')}`));
        for (const row of rows) { const cap = num(row.market_cap); if (typeof row.id === 'string' && cap >= 0) marketCaps.set(row.id, cap); }
      } catch { console.warn('open_alert_anomaly_market_cap_failed'); }
      await sleep(2500);
    }
    marketCapAt = now();
  }

  async function hourly(s: Series, from: number): Promise<Bar[]> {
    if (s.venue === 'binance') { const rows = await json(`${bnRest}/klines?symbol=${s.nativeId}&interval=1h&limit=750`); return Array.isArray(rows) ? (rows as unknown[][]).map(r => ({ t: num(r[0]), c: num(r[4]), q: num(r[7]) })) : []; }
    if (s.venue === 'mexc') {
      const d = (await json(`https://contract.mexc.com/api/v1/contract/kline/${s.nativeId}?interval=Min60&start=${Math.floor(from / 1000)}&end=${Math.floor(now() / 1000)}`) as { data?: { time?: number[]; close?: number[]; amount?: number[] } }).data;
      return d?.time ? d.time.map((t, i) => ({ t: t * 1000, c: num(d.close?.[i]), q: num(d.amount?.[i]) })) : [];
    }
    const out: Bar[] = [];
    let after = now() + HOUR;
    for (let page = 0; page < 10 && after > from; page++) {
      const rows = (await json(`https://www.okx.com/api/v5/market/history-candles?instId=${s.nativeId}&bar=1H&after=${after}&limit=100`) as { data?: string[][] }).data ?? [];
      if (!rows.length) break;
      for (const r of rows) out.push({ t: num(r[0]), c: num(r[4]), q: num(r[7]) });
      after = num(rows.at(-1)![0]); await sleep(150);
    }
    return out;
  }
  async function recentMinutes(s: Series): Promise<Bar[]> {
    if (s.venue === 'binance') return (await json(`${bnRest}/klines?symbol=${s.nativeId}&interval=1m&limit=300`) as unknown[][]).map(r => ({ t: num(r[0]), c: num(r[4]), q: num(r[7]) }));
    if (s.venue === 'okx') return ((await json(`https://www.okx.com/api/v5/market/candles?instId=${s.nativeId}&bar=1m&limit=300`) as { data?: string[][] }).data ?? []).map(r => ({ t: num(r[0]), c: num(r[4]), q: num(r[7]) }));
    const d = (await json(`https://contract.mexc.com/api/v1/contract/kline/${s.nativeId}?interval=Min1&start=${Math.floor((now() - 5 * HOUR) / 1000)}`) as { data?: { time?: number[]; close?: number[]; amount?: number[] } }).data;
    return d?.time ? d.time.map((t, i) => ({ t: t * 1000, c: num(d.close?.[i]), q: num(d.amount?.[i]) })) : [];
  }
  const btcOf = (venue: AnomalyVenue) => [...series.values()].find(s => s.venue === venue && s.category === 'crypto' && displayBase(s.base) === 'BTC');
  async function loadSeries(s: Series) {
    const at = now(), from = at - 31 * 24 * HOUR;
    const closedHour = Math.floor(at / HOUR) * HOUR;
    s.hours = (await hourly(s, from)).filter(b => okBar(b) && b.t >= from && b.t + HOUR <= closedHour).sort((a, b) => a.t - b.t);
    for (const bar of (await recentMinutes(s)).sort((a, b) => a.t - b.t)) mergeMinute(s.minutes, bar);
    const btc = s.category === 'crypto' && displayBase(s.base) !== 'BTC' ? btcOf(s.venue) : null;
    if (btc && !btc.hours.length) throw new Error('btc_reference_missing');
    s.baseline = buildBaseline(s.hours, s.category, btc ? new Map(btc.hours.map(b => [b.t, b.c])) : null, at, rules);
  }
  let loading: Promise<void> | null = null;
  function loadBaselines(force = false) {
    if (loading) return loading;
    loading = (async () => {
      const due = [...series.values()].filter(s => force || !s.baseline || now() - s.baseline.builtAt > 24 * HOUR);
      // BTC first: other crypto baselines are measured relative to it.
      const isBtc = (s: Series) => s.category === 'crypto' && displayBase(s.base) === 'BTC';
      let failed = 0;
      for (const s of due.filter(isBtc)) { try { await loadSeries(s); } catch { failed++; } }
      const rest = due.filter(s => !isBtc(s));
      let next = 0;
      await Promise.all(Array.from({ length: 3 }, async () => {
        while (!stopped && next < rest.length) {
          const s = rest[next++]!;
          try { await loadSeries(s); } catch { failed++; }
          await sleep(120);
        }
      }));
      console.info('open_alert_anomaly_baselines', JSON.stringify({ loaded: due.length - failed, failed, total: series.size }));
    })().finally(() => { loading = null; });
    return loading;
  }

  // ---------- streams ----------
  function onMinute(venue: AnomalyVenue, nativeId: string, bar: Bar) { const s = series.get(`${venue}:${nativeId}`); if (s) mergeMinute(s.minutes, bar); }
  function socket(venue: AnomalyVenue, url: string, open: (ws: WebSocket) => void, message: (data: unknown) => void, ping?: () => string) {
    let retry = 1000, heartbeat: ReturnType<typeof setInterval> | undefined;
    const list = sockets.get(venue) ?? sockets.set(venue, []).get(venue)!;
    const connect = () => {
      if (stopped) return;
      const ws = new WebSocket(url, { handshakeTimeout: 15_000 });
      list.push(ws);
      const send = (text: string) => { if (ws.readyState === WebSocket.OPEN) { try { ws.send(text); } catch { /* socket closing; the close handler reconnects */ } } };
      (ws as WebSocket & { safeSend?: (text: string) => void }).safeSend = send;
      ws.on('open', () => { retry = 1000; connected[venue] = true; open(ws); if (ping) heartbeat = setInterval(() => send(ping()), 15_000); });
      ws.on('message', data => { try { const text = String(data); if (text === 'pong') return; message(JSON.parse(text)); } catch { /* ignore malformed frames */ } });
      ws.on('error', () => { /* close follows */ });
      ws.on('close', () => {
        clearInterval(heartbeat); const i = list.indexOf(ws); if (i >= 0) list.splice(i, 1);
        if (!list.length) connected[venue] = false;
        if (!stopped && !(ws as WebSocket & { retired?: boolean }).retired) { setTimeout(connect, retry); retry = Math.min(retry * 2, 60_000); }
      });
    };
    connect();
  }
  function connectStreams() {
    for (const venue of ANOMALY_VENUES) for (const ws of sockets.get(venue) ?? []) { (ws as WebSocket & { retired?: boolean }).retired = true; ws.terminate(); }
    sockets.clear();
    const ids = (venue: AnomalyVenue) => [...series.values()].filter(s => s.venue === venue).map(s => s.nativeId);
    const chunk = <T,>(items: T[], size: number) => Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, i * size + size));
    for (const part of chunk(ids('binance'), 150)) {
      socket('binance', `wss://fstream.binance.com/market/stream?streams=${part.map(id => id.toLowerCase() + '@kline_1m').join('/')}`, () => {}, raw => {
        const k = (raw as { data?: { s?: string; k?: Record<string, unknown> } }).data;
        if (k?.s && k.k) onMinute('binance', k.s, { t: num(k.k.t), c: num(k.k.c), q: num(k.k.q) });
      });
    }
    for (const part of chunk(ids('okx'), 100)) {
      socket('okx', 'wss://ws.okx.com:443/ws/v5/business', ws => (ws as WebSocket & { safeSend: (t: string) => void }).safeSend(JSON.stringify({ op: 'subscribe', args: part.map(instId => ({ channel: 'candle1m', instId })) })), raw => {
        const m = raw as { arg?: { instId?: string }; data?: string[][] };
        if (m.arg?.instId && m.data) for (const r of m.data) onMinute('okx', m.arg.instId, { t: num(r[0]), c: num(r[4]), q: num(r[7]) });
      }, () => 'ping');
    }
    for (const part of chunk(ids('mexc'), 100)) {
      socket('mexc', 'wss://contract.mexc.com/edge', ws => { for (const symbol of part) (ws as WebSocket & { safeSend: (t: string) => void }).safeSend(JSON.stringify({ method: 'sub.kline', param: { symbol, interval: 'Min1' } })); }, raw => {
        const m = raw as { channel?: string; symbol?: string; data?: Record<string, unknown> };
        if (m.channel === 'push.kline' && m.symbol && m.data) onMinute('mexc', m.symbol, { t: num(m.data.t) * 1000, c: num(m.data.c), q: num(m.data.a) });
      }, () => JSON.stringify({ method: 'ping' }));
    }
  }

  // ---------- detection ----------
  const entityOf = (s: Series) => s.category === 'crypto' ? (s.coinId ? 'c:' + s.coinId : null) : 't:' + tradfiEntity(s.base);
  const labelOf = (s: Series) => s.category === 'crypto' ? displayBase(s.base).toUpperCase() : tradfiEntity(s.base);
  function observe(s: Series, at: number): Partial<Record<WindowKey, WindowObservation>> {
    const last = s.minutes.at(-1);
    if (!last || at - last.t > 10 * MINUTE) return {};
    const btc = s.category === 'crypto' ? btcOf(s.venue) : null, btcNow = btc?.minutes.at(-1)?.c;
    const out: Partial<Record<WindowKey, WindowObservation>> = {};
    for (const { key, ms } of WINDOWS) {
      const then = closeAt(s, at - ms);
      if (then === null) continue;
      const btcThen = btc ? closeAt(btc, at - ms) : null;
      out[key] = { priceNow: last.c, priceThen: then, volume: volumeSince(s, at - ms), btcReturn: btcNow && btcThen ? Math.log(btcNow / btcThen) : null };
    }
    return out;
  }
  /** One pass over every eligible series; returns the strongest hit per entity. */
  function scan(at: number): Map<string, Hit[]> {
    const hits = new Map<string, Hit[]>();
    for (const s of series.values()) {
      if (!s.baseline || s.quoteVolume24h < MIN_QUOTE_VOLUME) continue;
      const entity = entityOf(s);
      if (!entity) continue; // crypto unknown to CoinGecko has no verifiable market cap
      if (s.category === 'crypto' && (marketCaps.get(s.coinId!) ?? 0) < MIN_MARKET_CAP) continue;
      const signal = evaluate(s.category, displayBase(s.base) === 'BTC', s.baseline, at, observe(s, at), rules);
      if (signal) (hits.get(entity) ?? hits.set(entity, []).get(entity)!).push({ series: s, signal });
    }
    return hits;
  }
  const strength = (h: Hit) => Math.abs(h.signal.z) / rules.z[h.series.category];
  function tick() {
    if (stopped) return;
    const at = now(); lastEvaluationAt = at;
    for (const [entity, hits] of scan(at)) {
      const best = hits.reduce((a, b) => strength(b) > strength(a) ? b : a), s = best.series;
      const pending = group?.entities.get(entity);
      if (pending) { mergeHits(pending.hits, hits); continue; }
      // Every candidate joins the group; the shared feed and each user apply their own cooldown at flush.
      group ??= { id: crypto.randomUUID(), openedAt: at, deadline: at + gatherMs, entities: new Map() };
      group.entities.set(entity, { hits: [...hits], category: s.category, label: labelOf(s), marketCap: s.coinId ? marketCaps.get(s.coinId) ?? null : null });
    }
    if (group && at >= group.deadline && !flushing) {
      const ready = group; group = null;
      flushing = flush(ready).catch(() => console.error('open_alert_anomaly_flush_failed')).finally(() => { flushing = null; });
    }
  }
  function mergeHits(target: Hit[], hits: Hit[]) {
    for (const hit of hits) {
      const i = target.findIndex(h => h.series.key === hit.series.key);
      if (i < 0) target.push(hit); else if (strength(hit) > strength(target[i]!)) target[i] = hit;
    }
  }
  function toEvents(g: Group): AnomalyEvent[] {
    return [...g.entities.entries()].map(([entity, e]) => {
      const best = e.hits.reduce((a, b) => strength(b) > strength(a) ? b : a);
      const venues: VenueHit[] = [...e.hits].sort((a, b) => strength(b) - strength(a)).map(h => ({ venue: h.series.venue, instrument: h.series.instrument, symbol: h.series.nativeId, price: h.signal.price, move: h.signal.move, z: h.signal.z, volumeMultiple: h.signal.volumeMultiple, window: h.signal.window }));
      return { id: crypto.randomUUID(), groupId: g.id, at: g.openedAt, entity, label: e.label, category: e.category, direction: best.signal.direction, window: best.signal.window, session: best.signal.session,
        move: best.signal.move, relativeMove: best.signal.relativeMove, z: best.signal.z, volumeMultiple: best.signal.volumeMultiple, marketCap: e.marketCap, venues };
    });
  }
  async function flush(g: Group) {
    const events = toEvents(g), at = now();
    const markOf = (e: AnomalyEvent): CooldownMark => ({ at, direction: e.direction, move: e.category === 'crypto' ? e.relativeMove : e.move });
    const dayStart = Math.floor(now() / 86_400_000) * 86_400_000;
    const plans: { userId: string; settings: AnomalySettings; mine: AnomalyEvent[] }[] = [];
    for (const { userId, settings } of await options.store.subscribers()) {
      const mine = events.filter(e => (e.category === 'crypto' ? settings.crypto && Math.abs(e.relativeMove) >= settings.minMoveCrypto : settings.tradfi && Math.abs(e.move) >= settings.minMoveTradfi)
        && admit(userMarks.get(userKey(userId, e.entity)), markOf(e)));
      if (mine.length) plans.push({ userId, settings, mine });
    }
    // Feed keeps its own 24h de-duplication, but anything pushed to someone is always recorded.
    const pushed = new Set(plans.flatMap(p => p.mine.map(e => e.id)));
    const recorded = events.filter(e => { const ok = admit(lastPush.get(e.entity), markOf(e)); if (ok) lastPush.set(e.entity, markOf(e)); return ok || pushed.has(e.id); });
    if (recorded.length) {
      await options.store.insertEvents(recorded);
      console.info('open_alert_anomaly_group', JSON.stringify(recorded.map(e => [e.label, e.window, Number((e.move * 100).toFixed(1)), Number(e.z.toFixed(1)), e.venues.map(v => v.venue)])));
    }
    for (const { userId, settings, mine } of plans) {
      // Mark first: neither a slow provider nor the daily cap may re-offer the same move every gather window.
      for (const e of mine) userMarks.set(userKey(userId, e.entity), markOf(e));
      if ((await options.store.deliveriesSince(dayStart, userId)).length >= settings.dailyLimit) { console.warn('open_alert_anomaly_daily_limit'); continue; }
      const { title, message } = formatPush(mine, options.appUrl);
      let result: Awaited<ReturnType<Delivery['send']>>;
      try { result = await options.delivery.send(userId, message, title, settings); } catch { result = { outcome: 'uncertain', code: 'delivery_failed' }; }
      if (result.outcome !== 'skipped') await options.store.recordDelivery(g.id, userId, now(), mine.map(e => ({ entity: e.entity, ...markOf(e) })), result.outcome, result.code);
    }
  }

  async function restoreCooldowns() {
    // Restore feed and per-user cooldowns so a restart does not repeat the last day's records or pushes.
    for (const e of (await options.store.recentEvents(500, now() - 24 * HOUR)).reverse()) {
      const move = e.category === 'crypto' ? e.relativeMove : e.move;
      if (admit(lastPush.get(e.entity), { at: e.at, direction: e.direction, move })) lastPush.set(e.entity, { at: e.at, direction: e.direction, move });
    }
    for (const d of await options.store.deliveriesSince(now() - 24 * HOUR))
      for (const m of d.marks) userMarks.set(userKey(d.userId, m.entity), { at: m.at, direction: m.direction, move: m.move });
  }
  async function boot() {
    await restoreCooldowns();
    await refreshUniverse();
    await refreshMapping();
    await refreshMarketCaps();
    if (options.connect !== false) connectStreams();
    await loadBaselines();
    timers.push(setInterval(() => { void hourlyRefresh().catch(() => console.warn('open_alert_anomaly_refresh_failed')); }, HOUR));
  }
  async function hourlyRefresh() {
    const changed = await refreshUniverse();
    if (now() - mappingAt > 24 * HOUR) await refreshMapping();
    else for (const s of series.values()) s.coinId = s.category === 'crypto' ? coinIds.get(s.key) ?? null : null;
    await refreshMarketCaps();
    if (changed && options.connect !== false) connectStreams();
    await loadBaselines();
    await options.store.prune(now() - 30 * 24 * HOUR);
  }
  return {
    start() {
      if (started) return; started = true;
      timers.push(setInterval(tick, evaluateMs));
      void boot().catch(() => console.error('open_alert_anomaly_boot_failed'));
    },
    async stop() {
      stopped = true; for (const timer of timers) clearInterval(timer);
      for (const list of sockets.values()) for (const ws of list) { (ws as WebSocket & { retired?: boolean }).retired = true; ws.terminate(); }
      await flushing?.catch(() => {});
    },
    status(): AnomalyStatus {
      const all = [...series.values()], baselines = all.filter(s => s.baseline).length;
      const live = ANOMALY_VENUES.filter(v => connected[v]).length;
      return { state: stopped ? 'stopped' : !universeAt || baselines < all.length * 0.5 ? 'starting' : live < 3 ? 'degraded' : 'running',
        series: all.length, baselines, crypto: all.filter(s => s.category === 'crypto').length, tradfi: all.filter(s => s.category === 'tradfi').length,
        withMarketCap: all.filter(s => s.coinId && (marketCaps.get(s.coinId) ?? 0) >= MIN_MARKET_CAP).length,
        streams: { ...connected }, lastEvaluationAt, universeAt, marketCapAt };
    },
    /** Test seams. */
    internals: { series, coinIds, marketCaps, lastPush, userMarks, restoreCooldowns, tick, scan, flush, toEvents, refreshUniverse, get group() { return group; } },
  };
}
export type AnomalyEngine = ReturnType<typeof createAnomalyEngine>;
