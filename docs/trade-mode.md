# Trade mode (OKX)

The Markets page has an alert / trade switch where the old "Create alert" button was.
Trade mode is available on OKX USDT perpetuals and only on the Node deployment.

## Trust model

- The OKX API key, secret and passphrase live only in the browser. They are encrypted with a
  local password (PBKDF2-SHA256, 310k iterations, AES-GCM-256) in `localStorage`
  (`open-alert-okx-vault`). Unlocked credentials stay in memory for the session.
- The browser signs every request (HMAC-SHA256, OKX v5). The server route `POST /api/trade/okx`
  forwards the signed request to `www.okx.com` over IPv4 and stores or logs nothing.
- The relay allowlists read, order, amend and cancel paths only (`src/trade/okx-contract.ts`).
  Withdrawal and transfer endpoints are unreachable. Keys with the `withdraw` permission are refused.
- Limits: tampered frontend code could read an unlocked key; all users share the server IP for
  OKX per-IP rate limits; Cloudflare Workers have no fixed egress IP, so no relay is wired there.

## Uncertain writes

If an order request may have reached OKX but no answer came back (`trade_uncertain`, timeouts,
gateway pages), the order is shown as "result unknown", new orders are blocked, and the browser
queries OKX by client order ID. It never resends. An order absent 35s after signing can no
longer execute (OKX rejects requests older than 30s), so it is released.

## Keyboard mode

B / S arm buy / sell, A arms an alert, C cancels this market's orders, Esc disarms.
A click on the chart then sends at once; Shift+click keeps the side armed. A buy above the
last price (or a sell below it) becomes a trigger-market order. Chart orders above the
per-order notional cap (default 5000 USDT) are not sent. Keyboard hints are desktop only.

## Configuration

`TRADE_EGRESS_IP` (optional) is shown to users as the address to whitelist on their key.
