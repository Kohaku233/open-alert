# CCXT runtime integration

Open Alert supports Binance, OKX and MEXC USDT spot markets and linear USDT-settled perpetual swaps. Hyperliquid is deferred. CCXT is a client library: it still connects to exchanges and inherits their outages, rate limits and regional restrictions. TradingView widgets are display-only.

## Market identity and catalog authority

Every alert evaluates the exact selected venue and product. Existing bare OKX swap IDs such as `BTC-USDT-SWAP` remain unchanged. Other identities use `venue:type:encodeURIComponent(nativeId)`, for example `binance:spot:BTCUSDT`, `binance:swap:BTCUSDT`, `okx:spot:BTC-USDT` and `mexc:swap:BTC_USDT`. Qualified aliases of a legacy OKX swap are rejected. The CCXT unified symbol is separate from this application identity and from the native market ID. Legacy migration accepts only its original bare OKX swap identities.

Normalization requires explicitly active, consistent USDT spot or linear USDT perpetual metadata and valid price precision. Expiry futures, inverse contracts, options and other quote currencies are excluded. Public CCXT response collections and potentially supported raw rows are validated before exchange parsers can silently drop malformed data. Malformed snapshots fail the refresh; explicit valid empty collections can confirm removals.

Catalog eligibility is per venue. A failed refresh retains prior metadata for display while making that venue ineligible; healthy venues continue independently. Catalog snapshots and delistings are process-local. Restart requires a new successful complete catalog before evaluation resumes. SQL rules survive; durable catalog/delisting history is not implemented.

## Node and Cloudflare behavior

Node injects `createPublicCcxtMarketSource({ mode: 'stream', maxDemand: config.limits.globalInstruments })` into the scheduler. It uses public `ccxt.pro` constructors and `watchTrades`. Its API refreshes the catalog before returning the market directory, including on an idle server.

Cloudflare injects the same public factory in polling mode using regular CCXT constructors, platform `fetch`, an 8,000 ms request timeout and a 10,000 ms polling budget. Stock CCXT Pro WebSocket transport did not work in the tested workerd runtime. The existing `coordinator-v1`, D1 binding, serialized alarms and SQL notification fencing are preserved; no additional collector or paid resource is introduced.

Polling chooses only the newest valid fresh trade from each recent response. An earlier high followed by a newer low does not trigger an upper rule. A full REST page is still a sample, not proof of completeness. The default five-second interval is a sampling setting, not an end-to-end deadline: rate limiting, fair rotation, network and scheduler delays can lengthen it. Brief crossings within a page or between samples can be missed.

Node stream mode retains accepted observations until consumption, subject to freshness, epoch boundaries and capacity. A saturated stream batch or genuinely full pending queue fails closed. Pending queue capacity defaults to 4,096 observations. Replay identities are independently bounded to 10,000 at the monotonic timestamp cursor; exceeding that replay bound produces a recoverable fault requiring a strictly newer trade. ACKed observations cannot re-enter after a reconnect at the blocked timestamp. Subscription changes retire obsolete clients without clearing accepted samples for unchanged markets. Neither runtime guarantees coverage of every exchange trade.

Only active, enabled and unlatched SQL rules on enabled accounts create quote demand. Disabled or paused rules do not independently request prices. Catalog search requests metadata without collecting trades. The frontend searches locally by pair, venue and product and displays up to 40 results. Price snapshots are filtered to the requesting user's saved instruments. TradingView charts are limited to verified legacy OKX swap mappings for BTC, ETH, SOL, XRP, DOGE, ADA, AVAX, DOT, LINK, LTC, BCH and TRX.

Freshness checks both the exchange timestamp and local receipt time, with a default 30-second age limit. A fresh trade does not prove socket connectivity. A quiet market can have no recent trades while its transport remains open. Diagnostics expose `clientOpen` as client construction state. The authenticated status API exposes `scheduler.marketMode`; the dashboard says 「成交价新鲜」 and explains polling limitations.

The scheduler retains captured observations across cycle budgets. SQL generation or lease rejection invalidates the cached rule snapshot and stops evaluation without premature ACK. Pre-edit buffered extrema cannot initialize a new rule generation. Successful reservations remain fenced and are not retried as new triggers. Delivery uncertainty is not an exactly-once guarantee.

## Offline verification

Build web assets first if `dist/web` is absent, then run:

```sh
node scripts/verify-ccxt-runtime.mjs
```

The verifier stages allowlisted inputs without credentials or live database state, restricts Node network egress to local control sockets, disables Wrangler telemetry and mocks workerd outbound requests. Unexpected hosts, paths, authentication or WebSocket upgrades fail checks. It performs actual Wrangler dry runs, local startup profiling, public factory/workerd HTTP tests and bundled application tests. It exits nonzero on failures or timeouts and saves local evidence in `test-output/ccxt-runtime/`.

Fixtures exercise actual `loadMarkets` and `fetchTrades` through public CCXT constructors. Binance covers spot and linear perpetual exchange metadata and aggregate trades; OKX covers SPOT/SWAP instruments and recent trades; MEXC covers spot exchange metadata, contract detail, aggregate trades and contract deals. The installed MEXC contract HTTP host is `api.mexc.com`. No private deep CCXT imports or hand-written quote endpoint replacement is used.

## Current offline acceptance — 2026-10-13

The accepted execution snapshot used CCXT package **4.5.85**, protobufjs **7.6.6** and Wrangler **4.149.0**. The embedded CCXT runtime version probe reported **4.5.84**; this is distinct from the installed package version. Network guards, real SQLite/Better Auth and mocked provider responses were used. No live notification, deployment or production data change occurred.

| Check | Result |
| --- | --- |
| Backend and web typechecks | Passed |
| Node/web builds and configured Cloudflare dry run | Passed; `minify: true` |
| Uninterrupted full suite | **383 tests: 382 passed, 0 failed, 0 cancelled, 1 skipped** |
| Batch closure | **23/23 closed**, no batch timeout or incomplete TAP |
| Public CCXT factory in actual workerd | **3 passed** |
| Actual bundled Cloudflare application | **8 passed** |
| Catalog validation regressions | **125 passed** |
| Market source tests | **30 passed** |
| Scheduler market tests | **18 passed**, plus the real SQLite subscription regression |
| Compiled Node and built React browser integration | **7/7 journeys, 54 assertions passed** |
| Built UI mock integration | **14/14 journeys, 235 assertions passed** |
| Desktop/mobile market browser checks | **17/17 passed** |

The optional embedded PostgreSQL integration skipped because `@electric-sql/pglite` was absent. The first final market-browser attempt failed on catalog/editor polling timing; an unchanged targeted rerun passed. Both attempts remain recorded. This timing nondeterminism is not hidden by the passing result.

The accepted Worker bundle is **7,882,405 bytes uncompressed / 1,908,875 bytes gzip**, SHA-256 `f7b836e1c4511c01282f577f5a0af25b8cd32728885d6685a7949b4f16cc5f71`. It passes this task's conservative 3 MiB gzip gate. Source/test/web execution-input hashes and built artifact identity matched the accepted snapshot. A release follow-up then aligned the frontend chart whitelist with the backend's TRX mapping, added TRX/TON boundary assertions and made the browser removal test wait for the new catalog response before opening an editor. Web typecheck, web build, configured Cloudflare dry run and all 17 desktop/mobile market checks passed again. The first follow-up reproduced the previously recorded timing race; an intermediate retry-button attempt failed because that control is conditional. Both are retained locally. The full 383-test suite and compiled-Node/mock browser counts above refer to the preceding accepted snapshot; they were not rerun for this frontend-only correction. Backend execution inputs and Worker bundle hash remain unchanged. Evidence is in `test-output/release-followup/summary.json`.

Local final evidence is retained in `test-output/market-upgrade-accepted/summary.json` and its command logs, per-file full-suite results and browser captures. Generated evidence is excluded from public source. Earlier snapshots with 249 passing tests or a compiled-browser fixture failure are superseded by this acceptance; those original logs remain historical evidence.

## Live acceptance and deployment limits

A standalone polling probe on 2026-10-13 used the compiled application factory without the scheduler, accounts, database, notification provider or credentials. All three complete catalog loads failed and no six-product BTC quote acceptance was achieved. A bounded direct-factory diagnostic captured Binance and MEXC connection timeouts and an OKX `ECONNREFUSED 127.0.0.1:443` error. These establish failures in the probe environment, not exchange-wide outages or Cloudflare reachability. Single-market metadata returned through a separate web-fetch tool does not certify the application's full catalog/trade path.

An isolated temporary Free Cloudflare Worker and its own SQLite Durable Object then tested the actual public factory and source in HKG, without production D1, authentication, scheduler, notification credentials or bindings. OKX loaded **912 supported markets** and produced fresh BTC spot and perpetual quotes. MEXC's public catalog endpoints returned 200, but legitimate Unicode and parenthesized codes were initially rejected by the application's ASCII-only validation. The fix accepts bounded Unicode letters/numbers/marks and the observed code punctuation while rejecting whitespace, controls, formatting characters and ambiguous currency delimiters; canonical percent-encoding and legacy OKX syntax remain enforced. MEXC then loaded **2,505 supported markets** and produced both fresh BTC quotes. These counts are time-specific snapshots, not fixed product limits.

Binance's default spot catalog host returned **403 Request blocked** on two hosted attempts. A diagnostic using its documented public spot market-data host `data-api.binance.vision` also returned 403. This alternate host was used only in the diagnostic, not added to application configuration. The combined catalog failed before a successful futures-path measurement, so neither BTC product passed acceptance. These observations establish access failure from the tested HKG execution path; they do not prove a permanent worldwide block or identify the exact exchange policy responsible. Official documentation pages returned HTTP 202 without usable bodies; the public-host reference was found in indexed official search results.

The temporary Worker was deleted. A fresh resource inventory found no added Durable Object namespaces, and production deployment, D1/DO/secret bindings and pre-existing namespaces matched the captured baseline. No production user-data writes or live notifications were part of this test. No paid upgrade occurred. Explicit CPU-limit configuration was rejected on the Free account and removed from the temporary test configuration.

**Three-venue live acceptance remains blocked by Binance access.** OKX/MEXC catalog and BTC polling requests passed hosted execution, but the full production application, sustained polling, hosted CPU/memory/quota usage and Node Pro streaming/reconnect/throughput have not passed live acceptance. The isolated probe's observed upload startup values ranged from 58 to 125 ms; they do not certify the full application's workload. Production has not received this upgrade.

After the MEXC fix, backend typecheck, Node build, configured Cloudflare dry run and public workerd verification passed. The targeted identity/catalog/API run passed **164 tests**; a subsequent complete suite passed **387 tests: 386 passed, 0 failed, 0 cancelled, 1 optional skip**, with **23/23 batches closed**. Catalog regressions now total 129; public workerd factory tests remain 3 and bundled application tests 8. This supersedes the earlier backend acceptance snapshot. Browser counts above refer to the preceding UI snapshot; no frontend files changed in the MEXC fix. The current Worker is **7,882,451 bytes / 1,908,912 bytes gzip**, SHA-256 `b6812c66a9432b066b9ad80992d013261c1438d75a1929bb0c582b5036dc15b7`. Local evidence is retained in `test-output/batches-2026-10-13T12-06-08-098Z-3/summary.json` and `test-output/ccxt-runtime/result.json`; hosted public diagnostics and cleanup evidence are delivered separately and excluded from repository source.

Official limits checked through their Markdown endpoints on 2026-10-13:

[Workers limits](https://developers.cloudflare.com/workers/platform/limits/index.md), updated 2026-10-12, states 64 MiB uncompressed Worker size for Free/Paid, no compressed size limit, one second global startup, 128 MB isolate memory, Free 10 ms HTTP CPU, 100,000 daily Worker requests, Free 50 subrequests per invocation and six outgoing connections waiting for headers. The 3 MiB gzip gate used above is a conservative task requirement.

[Durable Object limits](https://developers.cloudflare.com/durable-objects/platform/limits/index.md) documents SQLite Durable Objects on Free, 5 GB total Free storage, a default 30 seconds active CPU per request/alarm and six outgoing connections. Its plan-limit and storage qualifications still require checking the actual account and workload.

Local Miniflare and small fixtures do not prove hosted startup, CPU, memory, full-catalog load or affordability. Eight instruments, bounded queues and request budgets limit work but do not certify quotas. Five-second active polling is approximately 17,280 cycles per day. No paid upgrade or extra paid resource is part of this implementation.
