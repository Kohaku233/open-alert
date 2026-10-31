<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="public/brand/logo-mark.svg">
    <img src="public/brand/logo-mark-light.svg" width="72" height="72" alt="Open Alert logo">
  </picture>
</p>

<h1 align="center">Open Alert</h1>

<p align="center">
  Self-hosted crypto price alerts and perpetual market anomaly monitoring.<br>
  Watch Binance, OKX, and MEXC. Send alerts to Pushover and Discord.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="License: Apache-2.0"></a>
  <a href="package.json"><img src="https://img.shields.io/badge/Node.js-%3E%3D22.12.0-417E38" alt="Node.js >=22.12.0"></a>
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#deployment">Deployment</a> ·
  <a href="#documentation">Documentation</a> ·
  <a href="CONTRIBUTING.md">Contributing</a> ·
  <a id="中文" href="docs/README.zh-CN.md">简体中文</a>
</p>

<a id="english"></a>

Open Alert runs your monitoring rules on the server, so alerts continue when you close the dashboard. Each account has its own rules, notification channels, and quotas. Administrators manage invitations, account access, and deployment health.

The project is in invite beta. Enabled accounts receive the Pro feature set; billing is not enabled. Available features depend on the selected runtime. See [beta access](docs/beta-access.md) and the [deployment comparison](#deployment).

## Features

- **Three exchanges, two market types.** Monitor USDT spot markets and linear USDT-settled perpetual swaps on Binance, OKX, and MEXC. Rules retain the exact exchange and market you choose.
- **Price alerts that stay latched.** Set an upper or lower threshold. Each rule triggers once and stays locked until you explicitly rearm it.
- **Perpetual market anomalies.** Detect unusual moves across crypto and stock/TradFi contracts using volatility, trading volume, and liquidity filters. Crypto moves are measured relative to BTC; related signals are grouped before delivery.
- **A notification center.** Route price alerts and anomaly signals to Pushover or Discord, with per-source priorities, quiet hours, daily limits, and delivery history.
- **Charts and drawing tools.** Use the built-in candlestick chart with custom timeframes, alert lines, and drawings, or switch to the official TradingView embed. Star assets across exchanges.
- **Multiuser access.** Sign in with email codes or Google. Invite users, disable accounts, and inspect runtime health from the administrator interface.
- **Desktop and mobile.** Chinese and English, light and dark themes, keyboard-accessible controls, and reduced-motion support.

Anomaly monitoring, the notification center, built-in candle history, favorites, and browser WebSocket updates are currently provided by the Node runtime.

## Quick start

This starts a local Node installation with SQLite. You need **Node.js 22.12.0 or newer**, npm, and Git.

### 1. Install

```sh
git clone https://github.com/Kohaku233/open-alert.git
cd open-alert
npm ci --ignore-scripts --no-audit --no-fund
cp .env.example .env
```

On Windows PowerShell, use `Copy-Item .env.example .env`. Use the committed lockfile. If SQLite cannot load on your platform, follow the [native-module installation guide](docs/INSTALL.md).

### 2. Configure

Generate three independent values:

```sh
node -e "const c=require('node:crypto'); for(const key of ['AUTH_SECRET','ENCRYPTION_KEY','BOOTSTRAP_TOKEN']) console.log(key+'='+c.randomBytes(32).toString('hex'))"
```

Copy the values into the corresponding fields in your private `.env`. The example already selects local development, SQLite, and `APP_URL=http://localhost:3000`.

For local development, `EMAIL_PROVIDER=console` prints login codes in the server terminal. Google login is optional and requires both OAuth configuration values. Production email and HTTPS settings are covered in [Configuration](docs/CONFIGURATION.md).

### 3. Build and start

Replace the example address with your own email:

```sh
npm run build
npm run admin:invite -- you@example.com
npm start
```

Open **[localhost:3000](http://localhost:3000)** and sign in with the invited email. For the local console provider, read the code from the server terminal.

The invitation CLI uses the same `.env` and database as the application. It creates a seven-day invitation without sending mail, creating an account, or granting an administrator role. To become the first administrator, follow the [authenticated bootstrap procedure](docs/RUNTIME.md#邀请与首位管理员); the current interface has no bootstrap form.

### 4. Create your first alert

1. In **Notification center**, add a Pushover or Discord channel and send an explicit test.
2. Enable the **Price alerts** route for that channel and save the routing rules.
3. Choose an exchange and market, then create a price alert.
4. Turn on the monitoring switch. New accounts start with monitoring paused.

Saving a channel validates its configuration without sending a test message. Pushover needs your user key and either a personal application token or the operator's shared token. Discord uses a channel webhook URL.

## Deployment

| Capability | Node / Docker | Standalone Cloudflare Workers |
| --- | --- | --- |
| Storage | SQLite or PostgreSQL | D1 |
| Price collection | CCXT Pro trade streams | CCXT REST latest-trade sampling |
| Scheduling | Shared scheduler with database leases | One Durable Object with alarms and Cron recovery |
| Notifications | Pushover and Discord through the notification center | Legacy Pushover channel API |
| Anomaly monitoring | Supported | Not connected |
| Built-in candle history and favorites | Supported | Not connected |
| Browser updates | WebSocket with polling fallback | HTTP polling |
| Email | SMTP or Resend; console for local development | Resend; console for local development |

**Node provides the full current feature set.** The shared frontend exposes pages that require Node services; those pages are unavailable on a standalone Worker. Cloudflare can also serve the assets and forward `/api/*`, including WebSocket upgrades, to a Node deployment through `NODE_BACKEND_URL`.

For production, set `NODE_ENV=production` and configure an HTTPS public origin, a real email provider, persistent storage, and your own credentials. Remove `DEV_ORIGIN` and replace the development console email provider. Back up the database and encryption key before upgrades. See [deployment and operations](docs/RUNTIME.md), [configuration](docs/CONFIGURATION.md), and [backup and recovery](docs/BACKUP.md).

Docker Compose includes SQLite and PostgreSQL service options. Standalone Cloudflare requires explicit D1 migrations before deployment; its template starts with 5 users, 8 global markets, and 100 global notification attempts per day. These are starting limits, not a production capacity guarantee. See [capacity planning](docs/RUNTIME.md#调度免费额度与容量).

For Cloudflare deployments that need a separate Binance perpetual data path, an optional authenticated [Vercel relay](docs/binance-vercel-relay.md) batches up to eight monitored markets per request.

## How alerts work

The backend evaluates the selected exchange's executed trade price. Upper rules match `price >= threshold`; lower rules match `price <= threshold`. The first fresh observation can trigger a rule if the condition is already met.

- **Explicit rearming.** Editing a triggered rule preserves its latch. Queued or sending alerts cannot be edited, deleted, or rearmed. Pausing monitoring cancels queued deliveries; requests already dispatched cannot be recalled.
- **Fresh data only.** Price alerts check both exchange and local receipt timestamps and reject invalid or stale observations. Page quotes and charts are display data and never trigger rules or enable monitoring.
- **Durable delivery state.** Price alerts reserve the trigger and outbox entry atomically, then commit a fenced send claim and quota before contacting a provider. Confirmed rejections have bounded retries. Ambiguous results become `uncertain` and are not automatically resent.
- **Independent anomaly monitoring.** Anomaly subscriptions have their own switch, filters, and per-user cooldowns. Anomaly pushes are dispatched once and do not use the price-alert outbox retry flow.

The system does not promise exactly-once delivery or coverage of every exchange trade. Node streams can have reconnect or buffer gaps. Cloudflare samples the latest trade, targeting five-second intervals, and can miss brief crossings. Network, rate limits, and scheduling can lengthen those intervals. A `sent` result means provider acceptance, not device display or a read receipt.

Market catalogs are cached in memory and require a fresh load after a restart. The browser loads the directory once per workspace session and refreshes it on explicit request. Browser WebSockets deliver display quotes and alert-change notifications; status reads reconcile every 30 seconds while connected, with five-second polling as the fallback. Read the [market runtime guide](docs/ccxt-runtime.md) for collection and recovery details; its dated verification snapshots describe earlier revisions.

## Documentation

| Guide | Contents |
| --- | --- |
| [简体中文](docs/README.zh-CN.md) | Chinese project overview and quick start |
| [Installation](docs/INSTALL.md) | Requirements, native SQLite checks, and platform setup |
| [Configuration](docs/CONFIGURATION.md) | Environment variables, email, Google login, secrets, and limits |
| [Deployment](docs/RUNTIME.md) | Node, Docker, Cloudflare, administrator bootstrap, and capacity |
| [Notifications](docs/notification-center.md) | Channels, source routing, quiet hours, and delivery history |
| [Observability](docs/OBSERVABILITY.md) | Health, readiness, incidents, and external probes |
| [Backup and recovery](docs/BACKUP.md) | Database consistency, key storage, and restore procedures |
| [Legacy migration](docs/MIGRATION.md) | Offline import, ownership checks, and explicit cutover |
| [Market runtime](docs/ccxt-runtime.md) | Market identity, sampling, failure handling, and verification |
| [Binance relay](docs/binance-vercel-relay.md) | Optional Cloudflare-to-Vercel market-data relay |
| [Beta access](docs/beta-access.md) | Account features, usage limits, and current billing status |

## Development

After the quick-start configuration, run the backend and frontend in separate terminals:

```sh
npm run dev
```

```sh
npm run dev:web
```

Vite serves the frontend on `http://localhost:5173` and proxies `/api` to port 3000. The example `.env` explicitly trusts that local origin.

| Command | Purpose |
| --- | --- |
| `npm run typecheck` | Check backend and test types |
| `npm run typecheck:web` | Check frontend types |
| `npm run build` | Build the Node server and web assets |
| `npm test` | Run the batched Node test suite |
| `npm run lint:css` | Inspect CSS cascade overrides |
| `npm run lint:css:dupes` | Check duplicate CSS ownership against the baseline |
| `npm run cf:check` | Bundle the Worker without deploying; requires built web assets |
| `npm run test:runtime:cf` | Build and test the local Cloudflare runtime |

Tests use local provider substitutes and write results to `test-output/`. PostgreSQL integration requires the optional embedded engine. Local checks do not establish production provider availability or hosted capacity.

Browser checks use an optional Playwright installation after `npm run build`:

```sh
npm install --no-save --package-lock=false playwright
npx playwright install chromium
npm run test:browser
npm run test:browser:mock
```

The first command leaves the project lockfile unchanged. On Linux, Chromium may also need system dependencies; `PLAYWRIGHT_MODULE` can point to an existing Playwright `index.mjs`. Browser checks use temporary data and local mail, market, and notification substitutes. Mobile checks emulate a Chromium viewport, not a physical iOS device.

### Project structure

```text
src/
  api/             HTTP routes and service ports
  auth/            Better Auth, email, and registration policy
  contracts/       Domain schemas and shared interfaces
  db/              SQL adapters, repositories, and migrations
  markets/         Catalogs, trades, quotes, and candle history
  scheduler/       Rule evaluation, leases, and delivery claims
  anomaly/         Statistical detection and signal aggregation
  notifications/   Encryption, providers, and source routing
  runtime/         Node and Cloudflare entry points
web/               React pages, charts, components, and styles
migrations/        SQLite and PostgreSQL schema sources
relay/             Optional Vercel Binance relay
test/              Unit and integration tests
scripts/           Operator tools and verification scripts
```

The stack is TypeScript, React, Vite, Hono, Better Auth, Drizzle, and CCXT. UI components use [shadcn/ui and Radix](web/components/ui/README.md); the built-in chart uses Lightweight Charts. [CONTRACT.md](CONTRACT.md) records the original foundation design and includes historical constraints that predate the current feature set.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. Use [GitHub Issues](https://github.com/Kohaku233/open-alert/issues) for reproducible bugs and feature requests. Community participation follows the [Code of Conduct](CODE_OF_CONDUCT.md).

For vulnerabilities, follow [SECURITY.md](SECURITY.md) and report privately through [GitHub Security Advisories](https://github.com/Kohaku233/open-alert/security/advisories/new).

## License

[Apache License 2.0](LICENSE). Dependencies retain their own licenses; external services are subject to their own terms and pricing.
