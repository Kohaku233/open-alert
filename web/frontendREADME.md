# Frontend

React, TypeScript, and Vite. Frontend source imports types from `src/contracts` only. It does not import server configuration, database adapters, or secrets. The interface is Simplified Chinese and is laid out for a 390px mobile viewport as well as desktop.

## Build and routes

From the repository root:

```sh
npm run typecheck:web
npm run build:web
```

Static output is `dist/web`. Page paths are `/login`, `/dashboard`, `/notifications`, `/account`, and `/admin`. Both Node and Cloudflare must return the SPA `index.html` for those pages and return static assets normally. `/api/*` must never be rewritten to the SPA.

During development, Vite proxies `/api` to `http://127.0.0.1:3000` and preserves `Origin`. The backend must explicitly trust the frontend origin, or both must run behind one origin. Production is same-origin only.

## API behavior

`GET /api/auth-capabilities` is public and uses the standard envelope:

```ts
{ ok: true, data: { google: boolean, emailOtp: boolean, registration: 'invite' | 'open' | 'closed' }, requestId: string }
```

The login page reads this before asking for a session. A missing or invalid response disables the login actions and can be retried. A capability value of false means that method is not configured.

`PUT /api/channels` treats an omitted `userKey` as "keep the stored key" after one has been saved. The first configuration must include a user key. Omitting `appToken` keeps the current override, `null` removes a personal override, and a string replaces it. The form keeps submitted secrets in memory only and clears them after a successful save. Saving validates credentials and does not send a notification. The separate test action requires explicit confirmation, sends one normal-priority notification, and counts against the daily quota. The interface shows presence and a mask, never the real key, ciphertext, or provider receipt.

`GET /api/admin/users` is bounded with `?limit=50&cursor=...` and returns `Paginated<UserIdentity>`. Creating an invitation shows creation and expiry only. It does not claim that email was sent.

## Authentication

The client uses Better Auth 1.7.7 through `better-auth/react` and `emailOTPClient` from `better-auth/client/plugins`. Session state comes from the client API and an HttpOnly cookie. The browser does not parse session payloads, use browser storage for credentials, or hold an application bearer token. The first email-code registration is created by the server plugin, which enforces the invitation and closed-registration policy.

The code entry accepts the server default of six digits. Codes are never returned to the browser. The one-time administrator bootstrap token is entered only on the signed-in account page and sent as an Authorization bearer to `POST /api/admin/bootstrap` with an empty body. The input is cleared immediately. Ordinary pages have no administrator or cloud-platform token field.

## Market data and updates

The workspace refreshes the signed-in user's status and alerts every five seconds. Market metadata loads once per workspace session and refreshes only on explicit request; routine polling does not reload the catalog. A failed refresh keeps the last display and shows the connection error. Freshness uses a 30-second window around the exchange timestamp and `receivedAt`. Prices are shown as received, including stale prices. The client never invents a price, and triggering always happens on the server.

Alert edits, deletion, rearm, and settings changes send `expectedGeneration`. A conflict rereads the current state and tells the user. Editing does not release a latch. Queued or sending alerts cannot be edited, deleted, or rearmed. Turning monitoring off requires confirmation because a request already sent cannot be withdrawn. Every terminal delivery state remains latched, and `uncertain` warns that delivery may already have happened.

The shared market picker reads the authenticated `/api/markets` snapshot, searches market metadata, filters Binance/OKX/MEXC and spot/USDT perpetuals, and renders at most 40 results. It retains selected identities when the directory no longer contains them or marks them unavailable. `available: false` prevents a new selection. Existing alert edits omit unchanged instrument and enablement fields so other edits can preserve unavailable markets without implicitly re-enabling them.

The TradingView advanced chart is an official reference embed. Only the incumbent exact OKX perpetual allowlist is accepted (BTC, ETH, SOL, XRP, DOGE, ADA, AVAX, LINK, DOT, LTC, BCH, TON), also matched to the selected venue/type/base/quote. Binance and MEXC mappings stay disabled until verified. Symbol changes inside the widget are disabled. The chart instance survives status refreshes, edits, notification changes, and page navigation; it is rebuilt when its verified symbol changes or the user reconnects. The client does not read the iframe document. Price and chart copy distinguish the selected exchange's backend latest trade price from the reference chart. An unavailable verified embed offers retry and safe external-link fallback.

## Shared visual and loading rules

`app.css` declares the cascade order. `tokens.css` owns theme values; `controls.css` owns inputs, search focus wrappers, static active tab backgrounds and bounded popovers; `layout.css` owns responsive geometry. Full shadows use `--elevation-*`, while `--shadow-*` contain colors. Long pairs, English labels and narrow layouts must shrink or wrap within the component.

`npm run lint:css` fails when a declaration can never apply because a later layer or rule sets the same property on the same selector. Remove the losing declaration instead of adding another override. Reduced motion has one owner, the `base` layer in `ui.css`. `!important` is reserved for that rule, theme-change suppression, `[hidden]`, and the two overrides of non-layered sources (GSAP inline dialog transforms and Sonner's injected stylesheet).

`Spinner` is the shared 90ms braille indicator for boot and asynchronous work. It stops its timer when hidden or reduced motion is requested; skeletons remain static. Alert scope tabs have no marker or entrance animation.

`GET /api/public-quotes` is unauthenticated and accepts no query parameters. It exposes only three fixed display markets, genuine observed prices/history and freshness: Binance BTC/USDT perpetual, OKX ETH/USDT perpetual and MEXC SOL/USDT spot. A shared five-second cache coalesces requests. It never loads tenant rules or changes scheduler demand. Private `/api/quote` and `/api/markets` retain session protection. Login polls only while visible and keeps prior data on failure, marking it stale without changing old timestamps. There is no fabricated fallback history.

Account/admin health summaries omit unverified notification-provider availability. Actual failed and uncertain deliveries remain operational incidents; credential validation and explicit test-send behavior are unchanged.

## Checks

`npm run test:browser:mock` checks the compiled frontend against local fixtures. `npm run test:browser` runs the compiled Node service with temporary SQLite. See the repository README for the optional Playwright installation. The mobile check is a Chromium viewport and does not represent a physical iOS Safari device. Local checks do not prove Google, email, Pushover, OKX, or TradingView behavior on a deployed site.
