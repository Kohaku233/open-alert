# Binance futures on Vercel Hobby

Cloudflare can use the small Node.js Function in `relay/` for Binance USDT-M
perpetual trade data. It requires no persistent Node server, WebSocket listener,
proxy agents, or Binance API keys. Binance spot and other exchanges keep their
native CCXT transports.

## Deployment

Deploy **only the `relay/` directory** as a Vercel project, with no frontend
framework or build command. `relay/vercel.json` pins the function to Tokyo
(`hnd1`). Set the same randomly generated `BINANCE_RELAY_TOKEN` on Vercel and
Cloudflare. Keep Vercel Authentication enabled; generate an automation bypass
secret in the project's Deployment Protection settings.

Set these Cloudflare secrets, then deploy the updated Worker:

```text
BINANCE_RELAY_URL=https://your-relay-project.vercel.app
BINANCE_RELAY_TOKEN=<same secret as Vercel>
BINANCE_RELAY_BYPASS=<Vercel automation bypass secret>
```

The URL is the deployment base, without `/api/market`. Use a stable project
alias rather than a deployment-specific hostname. Relay mode requires
`MAX_GLOBAL_INSTRUMENTS<=8`; the checked-in Worker template already uses eight.
Do not publish any secret in Wrangler vars, `VITE_*`, URLs, logs or source code.

## Protocol and behavior

- Authenticated `GET /api/market` returns the official complete futures catalog.
- Authenticated `POST /api/market` accepts only `{ "symbols": ["BTCUSDT", "ETHUSDT"] }`,
  with one to eight distinct USDT symbols. It fetches each symbol's last 100
  executed aggregate trades concurrently and returns `{ capturedAt, trades }`.
- One POST covers all demanded Binance perpetuals in a scheduler refresh.
  The eight-symbol cap applies across users. Idle monitoring makes no trade calls.
- CCXT retains exchange-specific parsing and the existing source retains trade
  timestamps, IDs, freshness, cursor progression and replay protection. Mark price
  and ticker snapshots are not substitutes for executed trades.
- No caller can supply a target hostname or URL. This is not an arbitrary proxy.
- Non-200, malformed, missing-symbol or over-age responses invalidate the affected
  Binance futures scope. Binance spot and other exchanges continue independently.
- Prices older than 30 seconds cannot trigger. Polling may miss brief crossings;
  this preserves the existing Cloudflare sampling semantics.

With a five-second cadence, 30 days of uninterrupted demand makes approximately
518,400 trade-batch invocations. Catalog calls are additional. Invocation count
alone does not establish remaining CPU, memory or transfer allowance; monitor
actual Vercel usage. Cold starts and exchange/network delays affect the cadence.

## Verification on 2026-10-14

An actual Vercel Function (not only Sandbox) reported `hnd1` and returned HTTP 200
for six consecutive BTC/ETH batches at five-second intervals. Each symbol returned
100 executed trades; BTC trade age at capture was 18–728 ms. The authenticated
catalog call returned HTTP 200 and 927 raw symbols, including excluded products.
These observations confirm connectivity at test time, not future IP availability.

The Worker source integration is tested with native CCXT parsers, including
multiple futures in one batch, isolated spot transport, upstream failure,
recovery and idle behavior. The main Open Alert production deployment has not
been replaced by this verification.

The Function's `X-Open-Alert-Region` response header confirms its actual region.
Check that header after deployment. Keep deployment protection and application
authentication separate; Cloudflare needs both credentials.
