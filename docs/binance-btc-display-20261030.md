# Binance BTC perpetual display investigation

## Scope and evidence

The user reported both the live price and built-in chart missing for Binance BTC USDT perpetuals. Investigation baseline: `913e075`, branch `feat/anomaly-monitor`.

DeepSeek (maximum reasoning effort) checked the existing Instabox deployment without restarting it or sending notifications:

- Production commit and CCXT 4.5.85 matched the local checkout. `BINANCE_ENDPOINTS=vision` was set.
- Public BTC preview quotes continued to advance. This path seeds fixed market metadata and bypasses the scheduler catalog resolver.
- The deployed CCXT catalog loaded 942 Binance swap markets, including BTC and ETH. Catalog refresh itself worked during the later probe.
- The deployed candle service returned 300 BTC 1h candles; BTC 4h and ETH 1h also worked concurrently. An independent display live hub received valid BTC trades.
- The running service reported `active_price_missing` and `trade_queue_overflow`. An independent, intentionally undrained probe approached the 4096-sample queue boundary.

The code establishes the failure mechanism: monitoring `eligible()` excludes instruments whose alert buffer has overflowed, and the display catalog reused that result as market availability. This makes independent quote, candle and browser-stream requests fail their shared market gate. Live user-authenticated requests were not captured, so the attribution to this particular incident remains high confidence rather than a complete authenticated browser reproduction.

## Minimal correction

- `src/markets/source.ts`: add a catalog-only availability predicate and use it in `resolve()` and `getMarkets()`. Continue requiring a current successful catalog and a listed normalized market.
- Keep `eligible()`, `samples()`, `ticks()` and monitoring health conservative when trade completeness is unknown. This correction does not claim to recover an overflowed alert stream.
- `test/markets.test.ts`: reproduce Binance BTC overflow and verify that discovery remains available while alert eligibility, ticks and samples remain blocked. Verify stale/delisted metadata stays unavailable, and cover replay-capacity faults as well.

No Binance endpoints, chart components, UI styles, notification settings, database schema or migration targets are changed.

## Commit provenance

Git authorship alone cannot identify the model: these commits share the same author. The recent model assignments below are supported by the model active at each commit command in the local conversation log.

| Commit | Scope | Model evidence |
| --- | --- | --- |
| `682bbd4`, `1526dac` | Node/browser WebSocket quotes; seeded Binance stream names | Opus 5.5 |
| `787ae4b` | US-accessible Binance endpoints and Worker-to-Node proxy | Opus 5.5 |
| `44fc6aa`, `226764d` | Built-in chart and custom intervals | Opus 5.5 |
| `6732ccd`, `8d7591f`, `12515b3` | Asset picker/drawing tools; notification hub and initial UI | Opus 5.5 |
| `8f25166` | Unified notification routing and Discord | GPT-6.1 Sol |
| `4668eb7` | Pro invitation-beta settings/access/usage | GPT-6.1 Sol |
| `913e075` | Remove unrequested UI and restore separate market source | GPT-6.1 Sol |

The availability coupling predates these recent changes: `3c8736b` (2026-10-15) introduced the relevant eligibility predicate and catalog availability use, and `5d0b48d` (2026-10-19) reused it in indexed resolution. Their model attribution has not been established; do not label them Opus changes based only on the shared Git author.

## Separate findings

The browser's HTTP quote fallback currently depends on the entire socket disconnecting, rather than an individual subscription receiving no quotes. This is a separate resilience gap, not changed here.

One anomaly kline WebSocket probe received Binance close code 1008. That requires separate diagnosis; it is not evidence that the display quote/candle services failed.

## Verification and release

All executable verification is assigned to DeepSeek with maximum reasoning effort. Release evidence, rollback commit and exact check results are recorded after verification in the release note under `work/`.
