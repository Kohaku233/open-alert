import test from 'node:test';
import assert from 'node:assert/strict';
import ccxt from 'ccxt';
import { handleUnhandledRejection, isTransientSocketRejection } from '../src/runtime/rejections.js';

test('closed-socket sends from ccxt are logged and survive; unknown rejections still exit', t => {
  const warn = t.mock.method(console, 'warn', () => {});
  const error = t.mock.method(console, 'error', () => {});
  const exits: number[] = [];
  const exit = (code: number) => { exits.push(code); };
  // The exact error ccxt's WsClient.send rejects with when ws reports sendAfterClose.
  assert.equal(handleUnhandledRejection(new Error('WebSocket is not open: readyState 3 (CLOSED)'), exit), 'ignored');
  assert.equal(handleUnhandledRejection(new ccxt.NetworkError('binance connection closed'), exit), 'ignored');
  assert.equal(handleUnhandledRejection(new ccxt.RequestTimeout('okx ping timeout'), exit), 'ignored');
  assert.deepEqual(exits, []);
  assert.equal(warn.mock.callCount(), 3);
  assert.match(String(warn.mock.calls[0]!.arguments[0]), /open_alert_ws_send_after_close/);
  assert.equal(handleUnhandledRejection(new TypeError('x is undefined'), exit), 'fatal');
  assert.equal(handleUnhandledRejection('WebSocket is not open', exit), 'fatal');
  assert.equal(handleUnhandledRejection(new ccxt.BadSymbol('nope'), exit), 'fatal');
  assert.deepEqual(exits, [1, 1, 1]);
  assert.equal(error.mock.callCount(), 3);
  assert.equal(isTransientSocketRejection(new Error('Something WebSocket is not open')), false);
});
