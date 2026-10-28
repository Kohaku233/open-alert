import test from 'node:test';
import assert from 'node:assert/strict';
import { admit, buildBaseline, evaluate, sessionOf, tradfiEntity, displayBase, HOUR, MINUTE, DEFAULT_RULES } from '../src/anomaly/rules.js';
import type { HourBar } from '../src/anomaly/rules.js';
import { closeAt, createAnomalyEngine, formatPush, mergeMinute, volumeSince } from '../src/anomaly/engine.js';
import type { Series } from '../src/anomaly/engine.js';
import { createAnomalyStore, ensureAnomalySchema } from '../src/anomaly/store.js';
import type { AnomalyEvent } from '../src/anomaly/store.js';
import { createSQLite } from '../src/db/sqlite.js';

const T0 = Date.UTC(2026, 9, 1); // Thursday
/** Deterministic pseudo-random walk so baselines are reproducible. */
function walk(hours: number, sdFor: (t: number) => number, seed = 7, start = 100): HourBar[] {
  let x = seed, c = start; const out: HourBar[] = [];
  const rand = () => { x = (x * 1103515245 + 12345) % 2147483648; return x / 2147483648; };
  for (let i = 0; i < hours; i++) {
    const t = T0 + i * HOUR, u = rand() || 1e-9, v = rand();
    c *= Math.exp(sdFor(t) * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v));
    out.push({ t, c, q: 1000 + rand() * 200 });
  }
  return out;
}

test('sessions split US regular hours, weekday off-hours and weekends with DST', () => {
  assert.equal(sessionOf(Date.UTC(2026, 9, 1, 14), 'crypto'), 'all');
  assert.equal(sessionOf(Date.UTC(2026, 9, 1, 13, 30), 'tradfi'), 'rth'); // EDT open 13:30 UTC
  assert.equal(sessionOf(Date.UTC(2026, 9, 1, 20), 'tradfi'), 'off');
  assert.equal(sessionOf(Date.UTC(2026, 10, 10, 14), 'tradfi'), 'off'); // EST open is 14:30 UTC
  assert.equal(sessionOf(Date.UTC(2026, 10, 10, 14, 30), 'tradfi'), 'rth');
  assert.equal(sessionOf(Date.UTC(2026, 9, 17, 14), 'tradfi'), 'weekend'); // Saturday 10/17
});

test('aliases merge wrappers of one underlying; 1000x prefixes are display-normalised', () => {
  for (const base of ['SKHYNIX', 'SKHY', 'SKHYNIXSTOCK', 'CSOPSKHYNIX2L', 'SKHYSTOCK']) assert.equal(tradfiEntity(base), 'SKHYNIX');
  assert.equal(tradfiEntity('TESLA'), 'TSLA'); assert.equal(tradfiEntity('NBISSTOCK'), 'NBIS'); assert.equal(tradfiEntity('MU'), 'MU');
  assert.equal(displayBase('1000PEPE'), 'PEPE'); assert.equal(displayBase('1INCH'), '1INCH');
});

test('weekend baseline flags a move that all-session history would call ordinary (MU 10/17)', () => {
  // Regular hours move 1.2%/h; weekday off-hours 0.2%/h; weekends 0.1%/h.
  const bars = walk(30 * 24, t => { const s = sessionOf(t + HOUR - 1, 'tradfi'); return s === 'weekend' ? 0.001 : s === 'off' ? 0.002 : 0.012; });
  const b = buildBaseline(bars, 'tradfi', null, T0 + 31 * 24 * HOUR);
  const weekend = b.sd['24h']!.weekend!, rth = b.sd['24h']!.rth!;
  assert.ok(weekend < rth * 0.8, `weekend sd ${weekend} should be far below rth ${rth}`);
  // Saturday 23:00 UTC: the 24h window starts after Friday's US close.
  const saturday = Date.UTC(2026, 9, 17, 23);
  const move = -0.059, priceThen = 100, priceNow = priceThen * (1 + move);
  const signal = evaluate('tradfi', false, b, saturday, { '24h': { priceNow, priceThen, volume: b.medianVolume['24h']!.weekend! * 4, btcReturn: null } });
  assert.ok(signal, 'weekend −5.9% must be flagged'); assert.equal(signal.session, 'weekend'); assert.equal(signal.direction, 'down');
  // The same move during regular hours is inside normal volatility.
  const tuesday = Date.UTC(2026, 9, 20, 15);
  assert.equal(evaluate('tradfi', false, b, tuesday, { '24h': { priceNow, priceThen, volume: b.medianVolume['24h']!.rth! * 4, btcReturn: null } }), null);
});

test('crypto is judged net of BTC and needs volume, z and the absolute floor together', () => {
  const bars = walk(30 * 24, () => 0.01), btc = new Map(walk(30 * 24, () => 0.004, 99, 50000).map(b => [b.t, b.c]));
  const b = buildBaseline(bars, 'crypto', btc, T0 + 31 * 24 * HOUR);
  const sd = b.sd['1h']!.all!, med = b.medianVolume['1h']!.all!, at = T0 + 31 * 24 * HOUR;
  const big = Math.exp(Math.max(8 * sd, 0.2));
  const obs = (ratio: number, btcReturn: number, volume = med * 5) => ({ '1h': { priceNow: 100 * ratio, priceThen: 100, volume, btcReturn } });
  assert.ok(evaluate('crypto', false, b, at, obs(big, 0)));
  assert.equal(evaluate('crypto', false, b, at, obs(big, Math.log(big))), null, 'moving with BTC is not an anomaly');
  assert.equal(evaluate('crypto', false, b, at, obs(big, 0, med)), null, 'volume below 3x median');
  assert.equal(evaluate('crypto', false, b, at, { '1h': { priceNow: 100 * big, priceThen: 100, volume: med * 5, btcReturn: null } }), null, 'missing BTC reference');
  // A high-z move smaller than the 10% system floor is ignored.
  const tiny = buildBaseline(walk(30 * 24, () => 0.001), 'crypto', btc, at);
  assert.equal(evaluate('crypto', false, tiny, at, { '1h': { priceNow: 105, priceThen: 100, volume: tiny.medianVolume['1h']!.all! * 5, btcReturn: 0 } }), null);
  assert.equal(DEFAULT_RULES.z.crypto, 6);
});

test('cooldown: same direction needs 2x, reversals always pass, expiry resets', () => {
  const first = { at: 0, direction: 'up' as const, move: 0.3 };
  assert.equal(admit(first, { at: HOUR, direction: 'up', move: 0.5 }), false);
  assert.equal(admit(first, { at: HOUR, direction: 'up', move: 0.6 }), true);
  assert.equal(admit(first, { at: HOUR, direction: 'down', move: -0.2 }), true, 'Q: +130% then −72% must both push');
  assert.equal(admit(first, { at: 24 * HOUR, direction: 'up', move: 0.31 }), true);
});

test('minute buffer merges updates, keeps order and window helpers read closed bars', () => {
  const bars: { t: number; c: number; q: number }[] = [];
  for (let i = 0; i < 5; i++) mergeMinute(bars, { t: i * MINUTE, c: 10 + i, q: 1 });
  mergeMinute(bars, { t: 4 * MINUTE, c: 20, q: 3 });
  mergeMinute(bars, { t: 2 * MINUTE, c: 12.5, q: 2 });
  mergeMinute(bars, { t: 6 * MINUTE, c: NaN, q: 1 });
  assert.deepEqual(bars.map(b => b.c), [10, 11, 12.5, 13, 20]);
  const s = { minutes: bars, hours: [] };
  assert.equal(closeAt(s, 3 * MINUTE), 12.5);
  assert.equal(volumeSince(s, 3 * MINUTE), 4);
});

const event = (over: Partial<AnomalyEvent>): AnomalyEvent => ({ id: 'e', groupId: 'g', at: T0, entity: 'c:quack-ai', label: 'Q', category: 'crypto', direction: 'up', window: '1h', session: 'all', move: 0.57, relativeMove: 0.56, z: 9.4, volumeMultiple: 20, marketCap: 262e6,
  venues: [{ venue: 'binance', instrument: 'binance:swap:QUSDT', symbol: 'QUSDT', price: 0.0321, move: 0.57, z: 9.4, volumeMultiple: 20, window: '1h' }, { venue: 'mexc', instrument: 'mexc:swap:Q_USDT', symbol: 'Q_USDT', price: 0.0322, move: 0.55, z: 8, volumeMultiple: 18, window: '1h' }], ...over });
test('push text lists venues once, stays inside Pushover limits and links the chart', () => {
  const one = formatPush([event({})], 'https://cryptotool.bar');
  assert.match(one.title, /^异动 · Q \+57\.0% \/ 1h$/);
  assert.match(one.message, /相对 BTC \+56\.0%/); assert.match(one.message, /BINANCE 0\.03210 · MEXC 0\.03220/); assert.match(one.message, /市值 \$262M/);
  assert.ok(one.message.endsWith('https://cryptotool.bar/dashboard?market=binance%3Aswap%3AQUSDT'));
  const sector = formatPush(Array.from({ length: 12 }, (_, i) => event({ entity: 't:' + i, label: 'TECH' + i, category: 'tradfi', session: 'weekend', direction: 'down', move: -0.05, z: -5 - i, marketCap: null })), 'https://cryptotool.bar');
  assert.equal(sector.title, '异动 · 12 个标的同步下跌'); assert.match(sector.message, /周末休市/); assert.match(sector.message, /另有 6 个标的/);
  assert.ok([...sector.message].length <= 1024 && [...sector.title].length <= 250);
});

function liveSeries(key: string, venue: 'binance' | 'okx' | 'mexc', base: string, category: 'crypto' | 'tradfi', at: number, jump: number, coinId: string | null): Series {
  const hours = walk(30 * 24, () => category === 'crypto' ? 0.01 : 0.004, key.length * 13).map(b => ({ ...b, t: b.t + (at - T0 - 30 * 24 * HOUR) }));
  const last = hours.at(-1)!.c, minutes = Array.from({ length: 70 }, (_, i) => ({ t: at - (70 - i) * MINUTE, c: i < 69 ? last : last * jump, q: i < 69 ? 10 : 30000 }));
  return { key, venue, nativeId: key.split(':')[1]!, base, category, instrument: `${venue}:swap:${key.split(':')[1]}`, quoteVolume24h: 5e7, hours, minutes, baseline: buildBaseline(hours, category, null, at), coinId };
}

test('engine merges venues and correlated symbols into one push per user, honours toggles, cooldown and market cap', async () => {
  const db = await createSQLite(':memory:', true);
  try {
    await db.execute('CREATE TABLE "user" (id TEXT PRIMARY KEY)'); await db.execute('CREATE TABLE user_settings (user_id TEXT PRIMARY KEY, disabled INTEGER NOT NULL DEFAULT 0)');
    for (const id of ['u1', 'u2', 'u3']) await db.execute('INSERT INTO "user"(id) VALUES(?)', [id]);
    await ensureAnomalySchema(db); await ensureAnomalySchema(db);
    const store = createAnomalyStore(db);
    await store.patchSettings('u1', 0, { enabled: true }, 1);
    await store.patchSettings('u2', 0, { enabled: true, crypto: false }, 1);
    await store.patchSettings('u3', 0, { enabled: false }, 1);
    await assert.rejects(store.patchSettings('u1', 0, { tradfi: false }, 2), /generation_conflict/);
    let clock = Date.UTC(2026, 9, 17, 12); // Saturday
    const sent: { userId: string; title: string; message: string }[] = [];
    const engine = createAnomalyEngine({ store, appUrl: 'https://x.test', now: () => clock, gatherMs: 30_000, connect: false,
      delivery: { send: async (userId, message, title) => { sent.push({ userId, title, message }); return { outcome: 'sent', code: null }; } } });
    const { series, marketCaps, tick } = engine.internals;
    const btcB = liveSeries('binance:BTCUSDT', 'binance', 'BTC', 'crypto', clock, 1, 'bitcoin'), btcM = liveSeries('mexc:BTC_USDT', 'mexc', 'BTC', 'crypto', clock, 1, 'bitcoin');
    for (const s of [btcB, btcM,
      liveSeries('binance:QUSDT', 'binance', 'Q', 'crypto', clock, 1.6, 'quack-ai'), liveSeries('mexc:Q_USDT', 'mexc', 'Q', 'crypto', clock, 1.58, 'quack-ai'),
      liveSeries('mexc:TINY_USDT', 'mexc', 'TINY', 'crypto', clock, 1.9, 'tiny-coin'), liveSeries('mexc:NOID_USDT', 'mexc', 'NOID', 'crypto', clock, 1.9, null),
      liveSeries('okx:SKHYNIX-USDT-SWAP', 'okx', 'SKHYNIX', 'tradfi', clock, 0.9, null), liveSeries('mexc:SKHYNIXSTOCK_USDT', 'mexc', 'SKHYNIXSTOCK', 'tradfi', clock, 0.91, null)]) series.set(s.key, s);
    marketCaps.set('bitcoin', 1e12); marketCaps.set('quack-ai', 262e6); marketCaps.set('tiny-coin', 2e6);
    tick(); clock += 10_000; tick();
    assert.equal(sent.length, 0, 'held for the gather window');
    clock += 30_000; tick(); await new Promise(r => setTimeout(r, 50));
    assert.equal(sent.length, 2);
    const u1 = sent.find(s => s.userId === 'u1')!, u2 = sent.find(s => s.userId === 'u2')!;
    assert.match(u1.title, /2 个标的剧烈波动/); assert.match(u1.message, /BINANCE .* · MEXC/); assert.match(u1.message, /SKHYNIX/);
    assert.doesNotMatch(u1.message, /TINY|NOID/, 'market cap below $10M or unmapped coins are skipped');
    assert.doesNotMatch(u2.message, /Q /); assert.match(u2.title, /SKHYNIX/);
    const events = await store.recentEvents(10);
    assert.equal(events.length, 2); assert.deepEqual(events.find(e => e.label === 'SKHYNIX')!.venues.map(v => v.venue).sort(), ['mexc', 'okx']);
    // Still elevated a minute later: cooldown suppresses a repeat.
    clock += 60_000; tick(); clock += 40_000; tick(); await new Promise(r => setTimeout(r, 50));
    assert.equal(sent.length, 2);
    assert.equal((await store.deliveriesSince(0, 'u1')).length, 1);
    await engine.stop();
  } finally { await db.close(); }
});

test('cooldown is per user: a sub-threshold feed record never blocks a later push above that user floor; restart restores it', async () => {
  const db = await createSQLite(':memory:', true);
  try {
    await db.execute('CREATE TABLE "user" (id TEXT PRIMARY KEY)'); await db.execute('CREATE TABLE user_settings (user_id TEXT PRIMARY KEY, disabled INTEGER NOT NULL DEFAULT 0)');
    for (const id of ['strict', 'loose']) await db.execute('INSERT INTO "user"(id) VALUES(?)', [id]);
    await ensureAnomalySchema(db);
    const store = createAnomalyStore(db);
    await store.patchSettings('strict', 0, { enabled: true, minMoveCrypto: 0.25 }, 1);
    await store.patchSettings('loose', 0, { enabled: true, minMoveCrypto: 0.10 }, 1);
    let clock = Date.UTC(2026, 9, 20, 12);
    const sent: { userId: string; title: string }[] = [];
    const make = () => createAnomalyEngine({ store, appUrl: 'https://x.test', now: () => clock, gatherMs: 0, connect: false,
      delivery: { send: async (userId, _message, title) => { sent.push({ userId, title }); return { outcome: 'sent', code: null }; } } });
    const settle = () => new Promise(r => setTimeout(r, 50));
    const place = (engine: ReturnType<typeof make>, jump: number) => {
      const { series, marketCaps } = engine.internals;
      series.set('binance:BTCUSDT', liveSeries('binance:BTCUSDT', 'binance', 'BTC', 'crypto', clock, 1, 'bitcoin'));
      series.set('binance:QUSDT', liveSeries('binance:QUSDT', 'binance', 'Q', 'crypto', clock, jump, 'quack-ai'));
      marketCaps.set('bitcoin', 1e12); marketCaps.set('quack-ai', 262e6);
    };
    let engine = make();
    place(engine, 1.15); engine.internals.tick(); await settle();
    assert.deepEqual(sent.map(s => s.userId), ['loose'], '+15% only reaches the 10% user');
    clock += HOUR; place(engine, 1.28); engine.internals.tick(); await settle();
    assert.deepEqual(sent.map(s => s.userId), ['loose', 'strict'], '+28% reaches the 25% user although it is not 2x the shared +15%');
    assert.equal((await store.recentEvents(10)).length, 2, 'every pushed move is in the shared feed');
    await engine.stop();
    // A restart restores each user's own cooldown from deliveries.
    engine = make(); await engine.internals.restoreCooldowns();
    clock += HOUR; place(engine, 1.25); engine.internals.tick(); await settle();
    assert.equal(sent.length, 2, '+25% is below 2x of what either user last received');
    clock += HOUR; place(engine, 0.7); engine.internals.tick(); await settle();
    assert.deepEqual(sent.slice(2).map(s => s.userId).sort(), ['loose', 'strict'], 'a reversal bypasses every user cooldown');
    await engine.stop();
  } finally { await db.close(); }
});