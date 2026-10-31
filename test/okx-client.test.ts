import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { setLanguage } from '../web/i18n.js';
setLanguage('zh-CN');
import { OkxError, OkxUncertainError, baseFor, clientOrderId, contractsFor, floorTo, parseInstrument, parseReply, queryString, roundTo, sign } from '../web/trade/okx.js';
import { openRecord, sealCredentials } from '../web/trade/vault.js';

test('OKX signature matches HMAC-SHA256 base64 over timestamp + method + path + body', async () => {
  const secret = '22582BD0CFF14C41EDBF1AB98506286D';
  const prehash = '2026-10-31T00:00:00.000ZPOST/api/v5/trade/order{"instId":"BTC-USDT-SWAP","sz":"1"}';
  assert.equal(await sign(secret, prehash), createHmac('sha256', secret).update(prehash).digest('base64'));
  const get = '2026-10-31T00:00:00.000ZGET/api/v5/account/positions?instType=SWAP';
  assert.equal(await sign(secret, get), createHmac('sha256', secret).update(get).digest('base64'));
});

test('query strings drop empty values and stay inside the relay character set', () => {
  assert.equal(queryString({ instType: 'SWAP', instId: undefined, limit: 30, ccy: '' }), 'instType=SWAP&limit=30');
  assert.match(queryString({ instId: 'BTC-USDT-SWAP', clOrdId: 'oa1abc' }), /^[A-Za-z0-9_\-.=&%]*$/);
});

test('contract sizing floors to the lot and never rounds up', () => {
  const btc = parseInstrument({ instId: 'BTC-USDT-SWAP', ctVal: '0.01', lotSz: '0.01', minSz: '0.01', tickSz: '0.1', lever: '100' })!;
  assert.equal(contractsFor(0.0137, btc), '1.37');
  assert.equal(contractsFor(0.01379, btc), '1.37');
  assert.equal(baseFor(1.37, btc), 0.0137);
  const eth = parseInstrument({ instId: 'ETH-USDT-SWAP', ctVal: '0.1', lotSz: '1', minSz: '1', tickSz: '0.01' })!;
  assert.equal(contractsFor(0.29, eth), '2');
  assert.equal(contractsFor(0.3, eth), '3');
  assert.equal(roundTo(67420.06, '0.1'), '67420.1');
  assert.equal(floorTo(0.3, '0.1'), '0.3');
  assert.equal(roundTo(0.000123456, '1e-6'), '0.000123');
  assert.equal(parseInstrument({ instId: 'X' }), null);
});

test('client order ids are short alphanumerics with the oa prefix', () => {
  for (let i = 0; i < 50; i++) {
    const id = clientOrderId();
    assert.match(id, /^oa[a-z0-9]{1,30}$/);
    assert.ok(id.length <= 32);
  }
  assert.notEqual(clientOrderId(1, new Uint8Array(8)), clientOrderId(1, new Uint8Array(8).fill(7)));
});

test('replies distinguish success, per-item rejection and unknown write outcomes', () => {
  assert.deepEqual(parseReply({ status: 200, body: '{"code":"0","data":[{"ordId":"1","sCode":"0"}]}' }, 'POST'), [{ ordId: '1', sCode: '0' }]);
  assert.throws(() => parseReply({ status: 200, body: '{"code":"1","msg":"","data":[{"sCode":"51008","sMsg":"Insufficient"}]}' }, 'POST'), (error: unknown) => error instanceof OkxError && error.code === '51008' && error.message === '保证金不足。');
  assert.throws(() => parseReply({ status: 401, body: '{"code":"50113","msg":"Invalid Sign"}' }, 'GET'), (error: unknown) => error instanceof OkxError && error.code === '50113');
  assert.throws(() => parseReply({ status: 502, body: '<html>bad gateway</html>' }, 'POST', 123), (error: unknown) => error instanceof OkxUncertainError && error.signedAt === 123);
  assert.throws(() => parseReply({ status: 502, body: '<html>bad gateway</html>' }, 'GET'), OkxError);
});

test('vault round-trips credentials and rejects a wrong password', async () => {
  const creds = { key: 'key-abcd1234', secret: 's3cret', passphrase: 'pass phrase', demo: true };
  const record = await sealCredentials(creds, 'correct horse', 100_000);
  assert.equal(record.hint, '1234');
  assert.ok(!JSON.stringify(record).includes('s3cret'));
  assert.deepEqual(await openRecord(record, 'correct horse'), creds);
  await assert.rejects(openRecord(record, 'wrong horse'));
});

test('TP/SL helpers: P&L in USDT, wrong-side prices and decimal drafts', async () => {
  const { pnlAt, protectProblem, decimalDraft } = await import('../web/trade/useTradeDesk.js');
  assert.ok(Math.abs(pnlAt('long', 66800, 68000, 0.02) - 24) < 1e-9);
  assert.ok(Math.abs(pnlAt('short', 66800, 68000, 0.02) + 24) < 1e-9);
  assert.equal(protectProblem('long', 'tp', 68000, 67420), null);
  assert.match(protectProblem('long', 'sl', 68500, 67420)!, /做多的止损价要低于/);
  assert.match(protectProblem('short', 'tp', 68000, 67420)!, /做空的止盈价要低于/);
  assert.equal(protectProblem('short', 'sl', 68000, 67420), null);
  assert.equal(decimalDraft('1,653.5abc'), '1653.5');
  assert.equal(decimalDraft('-1e5'), '15');
  assert.equal(decimalDraft('1.2.3'), '1.23');
  assert.equal(decimalDraft('67 420。5'), '67420.5');
});
