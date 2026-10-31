import test from 'node:test';
import assert from 'node:assert/strict';
import { bollinger, clampParam, computeIndicator, createIndicator, ema, INDICATORS, macd, MAX_INDICATORS, parseIndicators, rsi, sma } from '../web/indicators.js';

const close = (actual: number | null | undefined, expected: number, digits = 6) => {
  assert.notEqual(actual, null); assert.notEqual(actual, undefined);
  assert.ok(Math.abs(actual! - expected) < 10 ** -digits, `${actual} ≈ ${expected}`);
};
// Wilder's classic 14-period RSI worksheet closes (New Concepts in Technical Trading Systems, also used by StockCharts).
const WILDER = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28, 46.00, 46.03, 46.41, 46.22, 45.64];

test('sma averages full windows and leaves warm-up empty', () => {
  assert.deepEqual(sma([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);
  assert.deepEqual(sma([1, 2], 3), [null, null]);
});

test('ema seeds with the first simple average, then smooths with 2/(n+1)', () => {
  const out = ema([1, 2, 3, 4, 5, 6], 3);
  assert.deepEqual(out.slice(0, 2), [null, null]);
  close(out[2], 2); close(out[3], 3); close(out[4], 4); close(out[5], 5);
  const step = ema([10, 10, 10, 20], 3);
  close(step[3], 15);
  // Leading nulls (e.g. MACD's line before the slow EMA exists) are skipped, not treated as zero.
  const skipped = ema([null, null, 2, 4, 6], 2);
  assert.deepEqual(skipped.slice(0, 3), [null, null, null]); close(skipped[3], 3); close(skipped[4], 5);
});

test('rsi matches Wilder smoothing on the reference worksheet', () => {
  const out = rsi(WILDER, 14);
  assert.equal(out.slice(0, 14).every(value => value === null), true);
  // Independently computed with Wilder's average gain/loss recursion.
  close(out[14], 70.464135, 5); close(out[15], 66.249619, 5); close(out[16], 66.480942, 5);
  close(out[17], 69.346853, 5); close(out[18], 66.294713, 5); close(out[19], 57.915021, 5);
  assert.deepEqual(rsi([1, 2, 3, 4], 3).slice(3), [100]);
  assert.deepEqual(rsi([4, 3, 2, 1], 3).slice(3), [0]);
});

test('macd line, signal and histogram line up with their EMAs', () => {
  const closes = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 4) * 5 + i * 0.3);
  const out = macd(closes, 12, 26, 9);
  const fast = ema(closes, 12), slow = ema(closes, 26);
  assert.equal(out.macd[24], null); close(out.macd[25], fast[25]! - slow[25]!);
  const signal = ema(out.macd, 9);
  assert.equal(out.signal[32], null); close(out.signal[33], signal[33]!);
  close(out.histogram[59], out.macd[59]! - out.signal[59]!);
  assert.equal(out.histogram[32], null);
});

test('bollinger uses population standard deviation around the SMA', () => {
  const out = bollinger([2, 4, 4, 4, 5, 5, 7, 9], 8, 2);
  close(out.basis[7], 5); close(out.upper[7], 9); close(out.lower[7], 1);
  assert.equal(out.upper[6], null);
});

test('computeIndicator routes every definition and keeps output aligned with input', () => {
  const closes = Array.from({ length: 80 }, (_, i) => 50 + (i % 7));
  for (const definition of INDICATORS) {
    const params = Object.fromEntries(definition.params.map(param => [param.key, param.value]));
    const result = computeIndicator({ kind: definition.kind, params }, closes);
    assert.deepEqual(Object.keys(result).sort(), definition.lines.map(line => line.key).sort(), definition.kind);
    for (const values of Object.values(result)) assert.equal(values.length, closes.length);
  }
});

test('createIndicator picks the next common length and an unused colour', () => {
  const first = createIndicator('ma', [], 'a'), second = createIndicator('ma', [first], 'b');
  assert.equal(first.params.period, 20); assert.equal(second.params.period, 50);
  assert.notEqual(first.color, second.color);
  assert.deepEqual(createIndicator('macd', [], 'm').params, { fast: 12, slow: 26, signal: 9 });
  assert.deepEqual(createIndicator('boll', [], 'x').params, { period: 20, multiplier: 2 });
});

test('parseIndicators drops malformed saves and clamps parameters', () => {
  assert.deepEqual(parseIndicators(null), []);
  assert.deepEqual(parseIndicators('not json'), []);
  assert.deepEqual(parseIndicators('{"kind":"rsi"}'), []);
  const parsed = parseIndicators(JSON.stringify([
    { id: 'r', kind: 'rsi', params: { period: 9999 }, color: 2 },
    { id: 'r', kind: 'rsi', params: { period: 5 }, color: 0 },
    { id: 'b', kind: 'boll', params: { period: 'x', multiplier: 2.04 }, color: 99 },
    { id: 'z', kind: 'unknown', params: {} },
    null, 7,
  ]));
  assert.deepEqual(parsed, [
    { id: 'r', kind: 'rsi', params: { period: 500 }, color: 2 },
    { id: 'b', kind: 'boll', params: { period: 20, multiplier: 2 }, color: 1 },
  ]);
  const many = Array.from({ length: 12 }, (_, i) => ({ id: `m${i}`, kind: 'ema', params: { period: 10 }, color: 0 }));
  assert.equal(parseIndicators(JSON.stringify(many)).length, MAX_INDICATORS);
  assert.equal(clampParam({ key: 'p', label: '', min: 1, max: 500, step: 1 }, 0), 1);
  assert.equal(clampParam({ key: 'm', label: '', min: 0.1, max: 10, step: 0.1 }, 2.26), 2.3);
});
