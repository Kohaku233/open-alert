import { timingSafeEqual } from 'node:crypto';

const MAX_SYMBOLS = 8;
function authorized(value, token) {
  if (!token || typeof value !== 'string') return false;
  const a = Buffer.from(value), b = Buffer.from(`Bearer ${token}`);
  return a.length === b.length && timingSafeEqual(a, b);
}
async function upstream(path) {
  const response = await fetch(`https://fapi.binance.com${path}`, {
    signal: AbortSignal.timeout(6500), redirect: 'error', headers: { accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`binance_http_${response.status}`);
  return response.json();
}
// Fixed public market-data routes only. No caller-supplied URLs or Binance keys.
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Open-Alert-Region', process.env.VERCEL_REGION ?? 'unknown');
  if (!authorized(req.headers.authorization, process.env.BINANCE_RELAY_TOKEN)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    if (req.method === 'GET') {
      const exchangeInfo = await upstream('/fapi/v1/exchangeInfo');
      if (!Array.isArray(exchangeInfo.symbols)) throw new Error('invalid_catalog');
      return res.status(200).json(exchangeInfo);
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    if (!body || Object.keys(body).some(key => key !== 'symbols') || !Array.isArray(body.symbols) ||
        !body.symbols.length || body.symbols.length > MAX_SYMBOLS ||
        body.symbols.some(symbol => typeof symbol !== 'string' || !/^[A-Z0-9]{1,32}USDT$/.test(symbol)) ||
        new Set(body.symbols).size !== body.symbols.length) {
      return res.status(400).json({ error: 'invalid_symbols' });
    }
    const trades = Object.fromEntries(await Promise.all(body.symbols.map(async symbol => {
      // Preserve executed-trade timestamps and IDs; mark/ticker prices cannot
      // replace trades without changing the alert engine's trigger semantics.
      const rows = await upstream(`/fapi/v1/aggTrades?symbol=${symbol}&limit=100`);
      if (!Array.isArray(rows) || rows.length > 100) throw new Error('invalid_trades');
      return [symbol, rows];
    })));
    return res.status(200).json({ capturedAt: Date.now(), trades });
  } catch (error) {
    console.warn('Binance market request failed:', error instanceof Error ? error.message : 'upstream_failure');
    return res.status(502).json({ error: 'market_data_unavailable' });
  }
}
