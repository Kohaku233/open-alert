# Open Alert

[English](#english) · [中文](#中文)

<a id="english"></a>

## English

Self-hosted, multiuser price alerts for Binance, OKX, and MEXC USDT spot markets and linear USDT-settled perpetual swaps. Each user manages their own rules, notification credentials, and daily quota. An operator manages invitations, account status, and capacity. The frontend uses React and Vite, the API uses Hono, Google and email-code login use Better Auth, and notifications are delivered through Pushover.

| Deployment | Storage | Scheduling |
| --- | --- | --- |
| Node, directly or with Docker | SQLite or PostgreSQL | Shared scheduler with database leases and fencing |
| Cloudflare Workers | D1 for accounts, rules, and delivery records | One SQLite Durable Object: `coordinator-v1` |

The backend evaluates executed trade prices from the selected exchange. An upper rule triggers when `price >= threshold`, and a lower rule triggers when `price <= threshold`, including when the first fresh observation already crosses the threshold. A triggered rule stays latched until the user explicitly rearms it. Editing the threshold does not release the latch. Monitoring is off by default for a new account.

Node uses public CCXT Pro `watchTrades` and checks all accepted fresh observations in a batch. Cloudflare uses regular CCXT `fetchTrades` and samples only the latest valid fresh trade in each response, with a default five-second interval. Rate limiting, request budgets, network and scheduler delays can make the actual interval longer. Polling can miss transient threshold crossings, even within a fetched page; stream reconnects or bounded queue/cache overflow can also leave gaps. Neither mode guarantees every exchange trade. The authenticated status API exposes optional `scheduler.marketMode` (`stream` or `polling`), and the dashboard explains the mode. A fresh trade price does not establish transport connectivity; no recent trade does not prove disconnection.

Cloudflare can use an authenticated Vercel Hobby Function in Tokyo for Binance USDT perpetuals. One request batches up to eight monitored markets and preserves executed-trade timestamps and IDs. No persistent Node server or WebSocket listener is required. Spot and other exchanges retain their native paths. See [Binance Vercel relay](docs/binance-vercel-relay.md) for deployment and live Function verification.

Only enabled, unlatched rules for enabled monitoring/accounts create price demand. Paused or disabled rules do not request quotes, and an idle runtime makes no trade requests. Opening the searchable market picker loads metadata but does not subscribe to the selected market; another user's active rule may supply a shared price. The picker searches the catalog locally by venue, type and pair, and shows up to 40 results. TradingView is display-only and is limited to the existing verified OKX perpetual symbols for BTC, ETH, SOL, XRP, DOGE, ADA, AVAX, LINK, DOT, LTC, BCH and TRX. Binance, MEXC and spot chart mappings remain disabled.

Market catalogs and confirmed delistings are held in process memory, not persisted to the database. On a Node process restart or Durable Object recreation, the source starts ineligible and fails closed until a fresh complete catalog load succeeds for the relevant venue. Saved rules survive, but the adapter has no durable catalog/delisting history. See [CCXT runtime integration](docs/ccxt-runtime.md) for sampling, restart behavior and offline verification.

A delivery whose provider receipt cannot be confirmed is marked `uncertain` and is not retried automatically. The system does not promise exactly-once delivery. A free tier does not mean unlimited users, polling, or notifications. Size production according to CPU, D1 operations, Durable Object duration, and third-party quotas.

The included Cloudflare template is invite-only and small: 5 users, 20 alerts per user, 100 active alerts globally, 8 instruments per user and globally, and 20 delivery attempts per user per day with 100 globally. Attempts include tests and failures. This is a starting point. The Worker Free 10 ms CPU limit has not been proven under production load, and the limits do not prevent abusive traffic from exhausting a quota. See [capacity](docs/RUNTIME.md#调度免费额度与容量). Above 100 schedulable rules, evaluation is rotated across cycles and cannot guarantee a five-second check for every rule. The Node defaults in source are unchanged.

### Quick start on Node

Node **>=22.12.0** is required. Use the committed `package-lock.json`. Run these commands from the repository root. On Windows, use `Copy-Item .env.example .env` instead of `cp`.

```sh
npm ci --ignore-scripts --no-audit --no-fund
# Confirm that the SQLite native module can open a database:
node --input-type=module -e "import Database from 'better-sqlite3'; const db=new Database(':memory:'); console.log(db.prepare('SELECT 1 AS ok').get()); db.close();"
cp .env.example .env
node -e "const c=require('node:crypto'); console.log('AUTH_SECRET='+c.randomBytes(32).toString('hex')); console.log('ENCRYPTION_KEY='+c.randomBytes(32).toString('hex')); console.log('BOOTSTRAP_TOKEN='+c.randomBytes(32).toString('hex'))"
```

Write the three generated values into the private `.env`. The locked `better-sqlite3` 13.0.3 includes prebuilt binaries for major platforms. If the native query fails, follow [installation](docs/INSTALL.md) before starting. `--ignore-scripts` does not compile a missing native module.

The example uses local `EMAIL_PROVIDER=console`, so email codes appear only in the server terminal. Google is off until both OAuth values are set. Production requires an HTTPS `APP_URL`, `NODE_ENV=production`, real SMTP or Resend, and no `DEV_ORIGIN`. See [configuration](docs/CONFIGURATION.md). Resend checks domain verification by default. For a verified domain and a sending-only key, set `RESEND_VERIFY_DOMAIN=false` explicitly. For a personal trial, `EMAIL_FROM=onboarding@resend.dev` plus a private `EMAIL_TEST_RECIPIENT` allows mail only to that Resend account address and skips the domain lookup. Public capabilities expose `emailSenderMode` but never the address, and they do not prove that mail was accepted or delivered. Google and email registration remain invitation-gated. Multiuser email login requires a verified domain you control.

```sh
npm run build
npm start
# In another terminal, using the same .env and database:
npm run admin:invite -- you@example.com
```

`npm run build` compiles the Node server and the Vite frontend to `dist/server` and `dist/web`. `npm start` loads an optional `.env`, runs `dist/server/runtime/node.js`, and serves the frontend from the project root.

`INVITE_ONLY=true` by default. The CLI creates a seven-day email invitation. It does not send mail, create a user, or grant administrator access. Sign in with the invited address, then submit the one-time `BOOTSTRAP_TOKEN` on the account page. That operation requires both a verified session and the token. Success persists the consumed state; remove the token from the deployment afterward. Later administrators invite users through the interface, and permissions come from the database role.

A verified account created through email OTP can later sign in with a Google identity that has the same verified email. The first such Google login links the existing account, preserving its user ID and role, without another unused invitation. A new Google user still has to satisfy the invitation and capacity policy. Unverified email, a different email, and a disabled account are rejected.

The user then enters a personal Pushover user key, chooses a private application token or the operator's shared token, sends an explicit test, creates rules, and turns monitoring on. Saving credentials validates them with the provider and does not send a message. A test sends one normal-priority notification and counts against the daily quota. Real alerts use the user's notification settings.

### Deployment and operations

- [Runtime](docs/RUNTIME.md): Node with SQLite or PostgreSQL, Docker, Cloudflare D1 plus one Durable Object, bootstrap order, and capacity.
- [Configuration](docs/CONFIGURATION.md): production `.env`, Worker vars and secrets, Google callback, email and invitations, and every limit.
- [Backup](docs/BACKUP.md): encrypted storage, separate database and key backups, consistency, and restore checks.
- [Migration](docs/MIGRATION.md): offline migration from a real snapshot, administrator ownership, encrypted channels, a paused queue, and an explicit cutover.
- [Installation](docs/INSTALL.md): native-module checks and platform or Docker build boundaries.
- [Initial contract](CONTRACT.md): design reference for shared DTOs, atomic database operations, and authentication and delivery invariants. Statements that something is "not yet implemented" belong to that historical baseline. Current behavior is defined by this README and the deployment documents. The operator documents are indexed in Chinese at [docs/README.zh-CN.md](docs/README.zh-CN.md).

Incomplete configuration shows a setup page and an unavailable status. Authentication and monitoring do not start with placeholder credentials. The source contains no usable secrets or runtime data. Operators supply their own domain, Google OAuth client, email service, and Pushover configuration.

### Development and checks

For development, run `npm run dev` and `npm run dev:web` in two terminals. Vite proxies `/api` to port 3000. `DEV_ORIGIN=http://localhost:5173` trusts only that local browser origin and is rejected in production.

```sh
npm run typecheck
npm run typecheck:web
npm run build
npm run cf:check
# Longer checks, run as needed:
npm run test:foundation
npm test
npm run test:runtime:cf
```

`cf:check` is a Worker bundle dry run. It requires `dist/web`, which `npm run build` or `npm run build:web` creates, and it deploys nothing. `test:runtime:cf` builds the frontend, performs the dry run, and runs local workerd tests. `scripts/test-batches.mjs` runs the full suite in batches and writes results under `test-output/`. Tests simulate external provider HTTP. Real Better Auth and SQL adapters verify sessions, registration, isolation, limits, and delivery claims. The PostgreSQL integration test skips explicitly when that optional engine is unavailable. Packaging and local tests do not prove production behavior for Google, email, Docker, hosted PostgreSQL, or a deployed Durable Object alarm.

Optional Playwright covers the real browser flow. Install it after the project dependencies and build. The extra install is not written back to the lockfile, and another `npm ci` removes it. The default suite does not depend on Playwright.

```sh
npm install --no-save --package-lock=false playwright
npx playwright install chromium
# On Linux, install Chromium system libraries, for example with install --with-deps.
npm run test:browser
# Frontend-only simulated flow:
npm run test:browser:mock
```

`PLAYWRIGHT_MODULE` can point to an existing Playwright `index.mjs`. The browser check starts the compiled Node service with temporary SQLite and exercises persistence through a real OTP, cookie, and API. Mail, market data, and notification transport stay local substitutes, so no live notification is sent. The mobile case is a Chromium viewport and does not represent iOS Safari.

### Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) for changes and [SECURITY.md](SECURITY.md) for private vulnerability reports. Community participation follows [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

### License

This project is licensed under the [Apache License 2.0](LICENSE). Dependencies remain under their own licenses. Google, Cloudflare, Binance, OKX, MEXC, TradingView, and Pushover are used under their own terms and pricing.

<a id="中文"></a>

## 中文

自行部署的多用户价格警报系统，支持 Binance、OKX、MEXC 的 USDT 现货及 USDT 结算线性永续合约。每个用户独立管理规则、通知凭据和每日额度；运营者管理邀请、账号状态与资源上限。前端使用 React/Vite，API 使用 Hono，Google 与邮箱验证码登录使用 Better Auth，通知通过 Pushover 发送。

| 部署方式 | 数据存储 | 调度 |
| --- | --- | --- |
| Node（直接运行或 Docker） | SQLite / PostgreSQL | 共享调度器与数据库租约、fencing |
| Cloudflare Workers | D1（认证、规则、发送记录） | 一个 SQLite Durable Object：`coordinator-v1` |

后端以所选交易所的实际成交价判断触发。上限规则在 `price >= threshold`、下限规则在 `price <= threshold` 时触发，包括首次获得新鲜成交价时已满足阈值的情况。触发后规则保持锁定，需要用户显式重新武装（rearm）；编辑阈值不会解锁。新账户的总监控默认关闭。

Node 使用公共 CCXT Pro `watchTrades` 成交流，逐条评估批次中收到的有效新鲜成交。Cloudflare 使用常规 CCXT `fetchTrades`，每次只采样返回数据中的最新有效新鲜成交，默认间隔 5 秒；限流、请求预算、网络及调度可能让实际间隔更长。轮询可能漏掉短暂越过阈值的成交，包括同一响应中较早的越界成交；流式模式也可能因重连或有限队列/缓存溢出漏掉成交。两种模式都不保证覆盖交易所的每笔成交。认证后的状态 API 通过可选 `scheduler.marketMode`（`stream` / `polling`）报告模式，页面显示对应说明。「成交价新鲜」只表示价格时效；近期没有成交不代表连接断开。

Cloudflare 的 Binance 永续行情可通过东京 Vercel Hobby Function 获取。每轮一次批量调用，最多 8 个监控市场，保留真实成交时间与 ID；无需常驻 Node 主机。现货和其他交易所保持原路径。配置与实测见 [Binance Vercel 中继](docs/binance-vercel-relay.md)。

仅已开启监控、账户可用且未锁定的启用规则产生价格采集需求。暂停或禁用规则不请求报价，空闲运行时不请求成交。打开市场搜索只读取目录，不会为所选市场采集成交；其他用户的启用规则可能提供共享价格。当前搜索在浏览器内按交易所、市场类型与交易对筛选，最多展示 40 个结果。TradingView 仅供参考，只开放已有验证映射的 OKX 永续图表：BTC、ETH、SOL、XRP、DOGE、ADA、AVAX、LINK、DOT、LTC、BCH、TRX；Binance、MEXC 与现货映射尚未开放。

市场目录和已确认下架状态只保存在当前进程内存，不写入数据库。Node 进程重启或 Durable Object 实例重建后，行情源默认不可评估；对应交易所必须完成新的完整目录加载，才能恢复评估（fail closed）。已保存规则保留，但适配器没有持久化目录或下架历史。采样、重启边界与离线验证详见 [CCXT 运行说明](docs/ccxt-runtime.md)。

无法确定提供方是否已接收的发送标记为 `uncertain`，不会自动重发；系统不承诺 exactly-once。免费额度也不代表无限用户、无限轮询或无限通知，生产容量应按实际 CPU、D1 读写、Durable Object 持续时间及外部服务额度评估。

Cloudflare 的 `wrangler.jsonc` 使用邀请制小规模配置：最多 5 位用户、每人 20 条规则、全局 100 条启用规则、每人及全局 8 个品种，每人 20 次/日、全局 100 次/日发送尝试（含测试及失败）。这是试运行起点，Worker Free 的 10 ms CPU 尚未线上验证，也不能抵御恶意访问耗尽额度；预算与线上指标要求见[容量说明](docs/RUNTIME.md#调度免费额度与容量)。若以后放宽到超过 100 条可调度规则，规则会跨轮次轮流评估，不能保证全部每五秒检查。Node 的源码默认容量保持不变。

### 本地 Node 快速开始

要求 Node **>=22.12.0**，使用随源码提交的 `package-lock.json`。以下命令在项目根目录运行；Windows 可用 `Copy-Item .env.example .env` 代替 `cp`。

```sh
npm ci --ignore-scripts --no-audit --no-fund
# 确认 SQLite 原生模块能实际打开数据库，不能只看安装成功：
node --input-type=module -e "import Database from 'better-sqlite3'; const db=new Database(':memory:'); console.log(db.prepare('SELECT 1 AS ok').get()); db.close();"
cp .env.example .env
node -e "const c=require('node:crypto'); console.log('AUTH_SECRET='+c.randomBytes(32).toString('hex')); console.log('ENCRYPTION_KEY='+c.randomBytes(32).toString('hex')); console.log('BOOTSTRAP_TOKEN='+c.randomBytes(32).toString('hex'))"
```

将三项分别生成的随机值写入私有 `.env`。锁定的 `better-sqlite3` 13.0.3 包含主要平台预编译文件；若原生查询失败，按[安装与原生构建说明](docs/INSTALL.md)处理后再启动。`--ignore-scripts` 不会自动完成缺失的原生编译。

示例使用本地 `EMAIL_PROVIDER=console`，邮箱验证码只显示在服务器终端。Google 默认关闭；要启用须同时填写两项 OAuth 配置。生产配置必须使用 HTTPS `APP_URL`、`NODE_ENV=production`、真实 SMTP/Resend，并移除 `DEV_ORIGIN`，见[配置模板与 Secrets](docs/CONFIGURATION.md)。Resend 默认读取域名验证状态；已在控制台验证自有域名且使用 sending-only key 时，显式设 `RESEND_VERIFY_DOMAIN=false`。个人试运行可设 `EMAIL_FROM=onboarding@resend.dev` 和私有 `EMAIL_TEST_RECIPIENT`，只允许向该 Resend 账户邮箱发信，启动不读取域名；公开能力仅说明 `emailSenderMode`，不公开邮箱，也不表示邮件已验证或送达。Google 和邮箱注册仍受邀请制约束，多用户邮箱登录需改用自有已验证域名。

```sh
npm run build
npm start
# 另一个终端，使用相同的 .env 和数据库：
npm run admin:invite -- you@example.com
```

`npm run build` 实际依次执行 Node TypeScript 编译与 Vite 前端构建，分别输出 `dist/server` 和 `dist/web`。`npm start` 加载可选 `.env`，运行 `dist/server/runtime/node.js`，并从项目根目录提供前端资源。

默认 `INVITE_ONLY=true`。CLI 创建有效期七天的邮箱邀请，不发送邀请邮件、不创建用户，也不赋予管理员身份。使用受邀邮箱正常验证登录，然后在账户页提交一次性 `BOOTSTRAP_TOKEN` 完成首位管理员初始化。该操作同时需要已验证会话和 token；成功后持久化标记已消耗，移除部署中的 token。后续管理员通过界面邀请用户，权限依据数据库角色判定。

通过邮箱验证码创建的已验证用户，可直接用同邮箱且 Google 已验证的身份登录原账户；首次 Google 登录自动关联，保留原用户 ID 与角色，无需另行关联或新的未使用邀请。Google 新用户仍须满足邀请与用户上限策略；未验证邮箱、不同邮箱关联及禁用账户均被拒绝。

用户随后填写自己的 Pushover user key，选择私有 application token 或运营者共享 token，显式测试通知、创建规则并开启总监控。保存凭据只进行提供方验证，不发送消息；点击测试才发送普通优先级通知，并计入每日额度。真实警报按用户通知设置发送。

### 部署与备份

- [部署说明](docs/RUNTIME.md)：Node SQLite/PostgreSQL、Docker、Cloudflare D1 + 单个 Durable Object、初始化顺序和容量边界。
- [配置模板](docs/CONFIGURATION.md)：生产 `.env`、Worker vars/Secrets、Google 回调、邮箱与邀请策略、全部限额。
- [备份与恢复](docs/BACKUP.md)：加密存储范围、数据库与密钥分开备份、一致性与恢复验证。
- [旧系统离线迁移](docs/MIGRATION.md)：真实快照、管理员归属校验、加密通道、暂停队列与显式切换。
- [安装说明](docs/INSTALL.md)：原生模块检查、不同平台编译与 Docker 适配边界。
- [初始开发契约](CONTRACT.md)：共享 DTO、数据库原子操作及认证/发送不变量的设计参考；其中“尚未实现”的阶段说明属于历史基线，当前运行方式以本文和部署文档为准。中文运营文档索引见 [docs/README.zh-CN.md](docs/README.zh-CN.md)。

不完整配置会显示 setup 页面并返回不可用状态，认证和监控不会以占位凭据启动。源码不附带可用密钥或运行数据；运营者提供自己的域名、Google OAuth、邮箱和 Pushover 配置。

### 开发与检查

开发时在两个终端运行 `npm run dev` 与 `npm run dev:web`。Vite 将 `/api` 代理到 3000；`DEV_ORIGIN=http://localhost:5173` 仅显式信任本地开发浏览器 origin，生产拒绝该项。

```sh
npm run typecheck
npm run typecheck:web
npm run build
npm run cf:check
# 下列检查耗时更长，按需执行：
npm run test:foundation
npm test
npm run test:runtime:cf
```

`cf:check` 是 Worker 打包 dry-run，执行前必须有 `dist/web`（可先 `npm run build:web`）；不部署网络资源。`test:runtime:cf` 会构建前端、dry-run 并运行本地 workerd 测试。完整测试由 `scripts/test-batches.mjs` 分批执行，结果写入 `test-output/`。测试模拟外部提供方 HTTP，真实 Better Auth 与 SQL 适配器验证会话、注册、隔离、限额和发送声明；缺少可选引擎时 PostgreSQL 集成测试会明确 skip。打包和本地测试不能证明线上 Google、邮件、Docker、托管 PostgreSQL 或部署后的 Durable Object alarm 行为已验证。

真实浏览器集成检查使用可选 Playwright。完成依赖安装与构建后，可执行以下命令；额外安装不写回项目锁文件，重新 `npm ci` 会移除它。默认完整套件不依赖 Playwright。

```sh
npm install --no-save --package-lock=false playwright
npx playwright install chromium
# Linux 系统还需安装 Chromium 所需库，可在测试机器使用 install --with-deps。
npm run test:browser
# 单独前端模拟流程：
npm run test:browser:mock
```

也可用 `PLAYWRIGHT_MODULE` 指向现有 Playwright 的绝对 `index.mjs` 路径。真实浏览器检查启动编译后的 Node 服务与临时 SQLite，通过真实验证码、cookie 和 API 操作验证持久化；邮件、行情与通知网络传输保持本地替代，不发真实通知。移动端是 Chromium 视口模拟，不能代表 iOS Safari。

### 贡献与安全

代码与问题提交见 [CONTRIBUTING.md](CONTRIBUTING.md)，漏洞请按 [SECURITY.md](SECURITY.md) 私下报告。社区参与遵循 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。

### 许可证

项目采用 [Apache License 2.0](LICENSE)，允许按许可证条件使用、修改与分发。依赖仍受各自许可证约束；Google、Cloudflare、Binance、OKX、MEXC、TradingView 和 Pushover 服务按各自条款与收费规则使用。
