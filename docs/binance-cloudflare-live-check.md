# Hosted Cloudflare Binance connectivity check

On 2026-10-14 at 18:48–18:49 Asia/Shanghai, an isolated diagnostic Worker in the same Cloudflare account as open-alert ran fixed public Binance requests from HKG. It had no application bindings, database access, secrets, notification provider, or scheduled trigger. The production Worker was not modified. The diagnostic Worker was deleted after the check.

| Request | Result |
| --- | --- |
| data-api.binance.vision/api/v3/aggTrades, BTCUSDT | HTTP 403 |
| api-gcp.binance.com/api/v3/exchangeInfo | HTTP 200, 3,725 raw symbol rows |
| fapi.binance.com/fapi/v1/exchangeInfo | HTTP 403, upstream request blocked |
| fstream.binance.com/market/ws/btcusdt@aggTrade, WebSocket upgrade | HTTP 403; no WebSocket accepted or trades received |
| api-gcp.binance.com/api/v3/aggTrades, BTCUSDT | HTTP 200; trade timestamp 1791974965746, captured at 1791974966964 |
| api-gcp.binance.com/api/v3/aggTrades, ETHUSDT | HTTP 200; trade timestamp 1791974966295, captured at 1791974966964 |

The spot trade samples were fresh at capture. This was a short endpoint connectivity check, not a sustained stream, reconnect test, all-symbol catalog normalization test, or application alert acceptance test. The 3,725 rows are raw catalog entries, not the supported USDT spot count. No trades came from the rejected futures WebSocket. No blocked upstream request was retried or replaced with another venue's prices.

Production Worker settings inspected during the check had neither BINANCE_RELAY_URL nor BINANCE_RELAY_TOKEN. Its last modification was 2026-10-13T09:12:45.865643Z, earlier than the current main relay integration commits. Thus the implemented relay path is not currently configured in that deployment; repository code alone does not establish that production uses it.

The pinned CCXT 4.5.85 already generates wss://fstream.binance.com/market/ws for aggTrade via getWsUrl/getFutureWsCategory. A legacy-looking base URL in CCXT configuration is not evidence of a missing /market route. No endpoint rewrite was made.

Conclusion: preserve the working api-gcp spot transport. Neither the market-data-only spot hostname nor the futures WebSocket provided a working alternative from this observed HKG Worker. For Binance swaps, an accessible persistent backend relay still needs deployment, server-side binding configuration, and public HTTPS acceptance. These results do not prove every Cloudflare region or future request will behave identically.
