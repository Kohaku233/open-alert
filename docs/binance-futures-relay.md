# Candidate Binance USDT perpetual relay

This candidate is implemented and has passed offline checks and a live Node acceptance run. It is not deployed to production. At 2026-10-14T04:21:46Z the production relay boundary fetched the full official 927-row USD-M catalog, validated 745 supported active USDT perpetual markets, opened one CCXT Pro BTC aggregate-trade subscription, and supplied four fresh observations with increasing execution timestamps through the application market source. The acceptance bridge was in-process; a public HTTPS endpoint and continuous operation on a persistent host remain unverified. No notifications, production user-data changes or paid provisioning occurred. There is no static/synthetic production metadata fallback.

## Protocol and data provenance

The relay uses the installed public `ccxt` exports. Its REST client calls the public `fapiPublicGetExchangeInfo()` endpoint for the complete official USD-M `/fapi/v1/exchangeInfo` envelope. A bounded HTTP transport feeds CCXT's normal public request/error/JSON handling and does not follow redirects. The existing `createPublicCcxtFactory` `binanceSwapCatalog` provider validates the captured envelope, parses the official rows and applies `normalizeCatalog`. The service never attaches a fresh timestamp to a cached old capture.

After successful validation, one Pro client per demanded native symbol receives those validated parsed markets via public `setMarkets`. No auxiliary spot discovery or credentialed currency request is needed. Supported `watchTrades`/`watchTradesForSymbols` options and explicit `name: 'aggTrade'` subscribe to executed aggregate trades on the USDT linear futures stream. The relay requires each update's raw `info.e === 'aggTrade'`, exact native `info.s`, and exact unified perpetual symbol. Prices, quantities, aggregate IDs, first/last trade IDs, timestamps and maker flags come from raw `info`; floating-point CCXT price conversion is not used.

Only these authenticated GET routes exist:

| Route | Success body |
| --- | --- |
| `/fapi/v1/exchangeInfo` | Complete raw Binance futures envelope, including excluded inactive/non-USDT/dated rows |
| `/fapi/v1/aggTrades?symbol=BTCUSDT&limit=100` | Raw Binance REST aggTrades array containing the latest valid executed aggregate trade, e.g. fields `a,p,q,f,l,T,m` |

`limit=100` is required for compatibility with CCXT's current polling call, but the response intentionally contains **one latest sample**. This protocol can miss transient threshold crossings between polls; it does not promise every intermediate trade or complete recent history. A newly demanded symbol returns 503 until a fresh executed trade arrives. It never returns a fabricated tick, empty successful trade page, ticker, mark price or spot data.

Native IDs use the application’s `nativeMarketIdSchema`: 1–128 UTF-16 code units containing Unicode letters, numbers and marks plus the permitted native-ID punctuation. The exact ID must exist in the normalized active linear USDT swap catalog; no ASCII-only or suffix heuristic narrows that catalog. Supported Unicode symbols (for example `币安人生USDT`) remain in the full raw envelope and can be requested with a percent-encoded `symbol` query. Unified symbols, instrument identities, aliases, extra/duplicate query parameters, private endpoints, caller credentials, arbitrary targets, request bodies and unsupported routes are rejected.

## Bounds and lifecycle

- Catalog TTL is at most 15 minutes; expiry invalidates all watchers and samples. Refresh occurs on the next authenticated request and coalesces concurrent callers. No expired catalog is served during refresh or failure. A successful empty official catalog removes all eligibility.
- Catalog bounds: 8 MiB response and at most 20,000 complete raw market rows. Trade response/WebSocket payload bound: 64 KiB. WebSocket redirect following and compression are disabled.
- At most eight symbol clients and one retained trade per client: at most eight retained trade samples globally, below the 100-sample requirement. Pro's per-client trade cache is also set to one. Each watcher has only one pending start and one pending `next()`.
- Samples require recent executed-trade time and local arrival time, each at most 30 seconds old, with at most five seconds of future skew. Replay does not update arrival freshness; regressing timestamps/aggregate IDs are ignored. Malformed stream batches invalidate the existing sample.
- A symbol untouched for 60 seconds is retired; cleanup runs at least once per second and on requests. A quiet stream with continuing request demand keeps its single pending `next()` until cancellation; absence of trades does not trigger a timeout, failure cooldown or reconnection. Catalog expiry/removal, cancellation, stream failure and process close clear cached samples and close clients.
- Starts and catalog calls have bounded waits. An uncooperative asynchronous dependency retains its capacity/single-flight slot until it settles; late results cannot revive a closed or expired service. Shutdown waits at most one second for close boundaries.
- REST 418/429 choose the greatest valid future explicit `Retry-After` (seconds or HTTP date) or numeric `banned until` expiry, without exposing the message/IP. A two-minute explicit expiry remains two minutes. Only when none is usable does 418 default to 24 hours or 429 to 60 seconds. Other catalog failures cool down for 60 seconds. Stream failures cool down only the affected native symbol for 60 seconds; unrelated symbols can start and serve normally. Failure entries belong exclusively to the current catalog (at most 20,000), are pruned on expiry and cleared on catalog invalidation/replacement or shutdown. Requests do not continuously reconnect/retry during cooldown.
- Defaults: 120 authenticated supported requests/minute, 16 concurrent handlers, 32 HTTP connections, 4 KiB request headers, 16 header fields, five-second request/header/keepalive timeouts. TLS termination should enforce its own connection/rate limits before the Node listener.
- Bearer verification hashes both values and uses Node `crypto.timingSafeEqual` on fixed-length digests. Invalid authentication reaches no catalog or stream boundary. Only generic operational/error messages are logged; raw errors, token, URL and IP are suppressed.

## Local operation and integration

Use an **existing authorized always-on Node host**, with Node >=22.12, a process supervisor and an existing HTTPS/TLS reverse proxy. No paid host is provisioned. Bind defaults to loopback; expose the relay through TLS termination and keep the plain HTTP listener private.

Generate a random secret locally with `crypto.randomBytes(32).toString('base64url')` and place it in a private environment/secret store. The accepted `RELAY_TOKEN` alphabet is URL-safe ASCII (`A-Z a-z 0-9 _ -`), 32–256 characters. Do not reuse exchange credentials or place the token in URLs, frontend bundles, shell logs or committed files. Both Node relay and server-side Cloudflare client need this shared secret.

Environment:

| Variable | Meaning |
| --- | --- |
| `RELAY_TOKEN` | Required generated bearer secret |
| `RELAY_PORT` | Integer 1–65535; default `8788` |
| `RELAY_BIND` | Default `127.0.0.1`; accepted `127.0.0.1`, `::1`, `0.0.0.0`, `::` |
| `HTTPS_PROXY` | Optional operator-configured HTTP/HTTPS CONNECT proxy, supplied through CCXT's supported `httpsProxy` and `wssProxy` properties |

On the existing authorized Node host, start under its process supervisor:

```sh
node --import tsx scripts/binance-futures-relay.ts
```

The locked production dependencies include `http-proxy-agent` 7.0.2 and `https-proxy-agent` 7.0.6. The REST boundary loads CCXT's supported proxy modules before its catalog request; Pro loads them before opening its WebSocket. There is no new server/router dependency. The process reads the exported environment; when using a private environment file, pass Node's `--env-file` explicitly before `--import`.

The Cloudflare coordinator already integrates the adapter through a Binance-swap-only transport override. Set both server-side bindings `BINANCE_RELAY_URL` and `BINANCE_RELAY_TOKEN`; either alone is rejected. The URL must use HTTPS without userinfo, query, fragment or percent-encoded path. Store the bearer token using Cloudflare Secrets (`npx wrangler secret put BINANCE_RELAY_TOKEN`) or the dashboard Secrets interface. Supply the URL as a binding or a Secret. Never put either private deployment configuration or tokens into the public repository or frontend variables.

When relay mode is enabled, explicitly configure `MAX_GLOBAL_INSTRUMENTS=8` or less, and keep `MAX_INSTRUMENTS_PER_USER` no larger. Configuration rejects higher global capacity; without relay mode the ordinary Node defaults remain available. Run one application consumer per relay. Eight swaps at the default five-second cadence require about 96 trade requests and one catalog request per minute, within the default 120/minute limit; retries share this budget.

The integration shape is:

```ts
const source = createPublicCcxtMarketSource({
  mode: 'polling',
  fetchImplementation: platformFetch,
  binanceSwapFetchImplementation: createBinanceRelayFetch({
    url: serverSideRelayUrl,
    token: serverSideRelayToken,
    fetchImplementation: platformFetch,
    timeoutMs: 8000,
  }),
  catalogTtlMs: 60_000,
  maxDemand: 8,
});
```

A validated 503 `{code: -1, msg: 'no_fresh_trade', symbol: nativeId}` clears only the requested symbol's samples and current quote, retaining replay protection. Other symbols keep their client, observations and prices. Wrong-symbol, malformed, transport and catalog failures remain fail-closed. This response is never an empty successful trade page. The HTTP listener accepts request targets up to 1,188 characters, derived from the permitted 128 UTF-16-unit native ID and worst-case percent encoding.

The wrapper accepts HTTPS base URLs without userinfo/query/hash; explicit loopback HTTP is accepted for local tests. A base path may identify an existing TLS reverse-proxy mount; the reverse proxy must strip it before the Node listener. The wrapper accepts only the exact `https://fapi.binance.com` origin and the two supported paths/queries, creates new bearer-only headers, omits cookies, rejects redirects/non-200/non-JSON/oversized/malformed responses, and imposes a ten-second deadline. The relay token is never attached to other exchanges, whose fetch input/init pass through unchanged. Other Binance routes, including spot/private endpoints, reject instead of falling through. Configure Binance swap-only routing separately; this helper does not configure product scope.

## Offline verification

`test/binance-relay.test.ts` replaces public transport boundaries and guards global fetch, TCP/TLS, HTTP/HTTPS and DNS against real network access. It verifies authentication before work, unsupported/private routes, exact swaps, full Unicode envelope preservation and real CCXT Unicode trade routing, capture freshness/TTL, single-flight refresh, exact explicit/default 418/429 durations, bounded per-symbol failure cooldowns and unrelated-symbol isolation, raw aggTrade conversion, sample freshness, quiet demanded streams and idle cancellation, eight-symbol/global sample capacity, concurrent request limits, stalled/late starts, close rejection, URL/header safety, redirect/status/body bounds and the actual public CCXT production adapter with an in-memory HTTPS response. `test/binance-swap-catalog.test.ts` independently exercises the real CCXT catalog parser/provider/normalizer.

Run the guarded focused suites with:

```sh
node scripts/test-batches.mjs --local test/binance-relay.test.ts test/binance-swap-catalog.test.ts
```

The release verification on 2026-10-14 completed root, scripts and web typechecks, Node/web builds, a Cloudflare dry run, and 29 normally closed offline batches: 565 tests, 564 passed, one optional PostgreSQL skip, zero failures or cancellations. Additional workerd probes verified relay imports and quiet-symbol isolation through native Worker fetch and actual CCXT. The checked-in listener suite covers long Unicode request targets and CLI startup/shutdown; the relay suite covers actual proxy-agent initialization.

Live acceptance established complete official catalog access and progressing executed-trade samples through the Node relay and application source. It used an in-process request bridge and the existing environment's transport. It does not establish public HTTPS reachability or sustained operation on the eventual persistent host. Before production cutover, verify those on that host, including restart/reconnect behavior and resource use. Exchange IP restrictions may recur; honor returned cooldowns. Keep the existing production bindings, Durable Object identity and saved rules. Notification delivery requires its own explicitly requested test.
