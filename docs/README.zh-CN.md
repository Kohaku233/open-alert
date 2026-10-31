# Open Alert · 价格哨站

自行部署的多用户价格警报与永续合约异动监控工具。监测 Binance、OKX、MEXC，通过 Pushover 和 Discord 接收通知。

[English](../README.md) · [快速开始](#快速开始) · [部署方式](#部署方式) · [文档](#文档) · [参与贡献](../CONTRIBUTING.md)

规则在服务端运行，关闭网页后仍会继续监控。每个账户独立管理警报、通知渠道和额度，管理员负责邀请、账户状态及服务运行诊断。

项目目前处于邀请测试阶段，可用账户获得 Pro 功能权限，尚未启用付费。具体功能也取决于部署的运行时，见[测试资格说明](beta-access.md)和下方的[部署对比](#部署方式)。

## 功能

- **三家交易所，现货与永续。** 支持 USDT 现货及 USDT 结算线性永续。每条规则保存完整的交易所、市场类型和交易对标识。
- **一次触发，明确重新武装。** 设置价格上限或下限，触发后保持锁定，直到手动重新武装。
- **永续合约异动。** 结合常态波动、成交量和流动性筛选币种及股票/TradFi 合约。币种扣除 BTC 同期涨跌，相关信号聚合后推送。
- **通知中心。** 将价格警报、币种异动和股票异动发往 Pushover 或 Discord，设置提醒级别、免打扰、每日上限，并查看投递记录。
- **图表与画线。** 内置 K 线支持自定义周期、警报线及画线工具，也可切换官方 TradingView 图表；标的收藏覆盖不同交易所。
- **多用户管理。** 邮箱验证码或 Google 登录，支持邀请、停用账户和管理员运行诊断。
- **桌面与移动端。** 中英文、浅色与深色主题、键盘操作及减少动态效果支持。

异动监控、通知中心、内置 K 线、收藏及浏览器 WebSocket 更新目前由 Node 运行时提供。

## 快速开始

以下步骤在本地使用 Node 和 SQLite。需要 **Node.js 22.12.0 或更新版本**、npm 和 Git。

### 1. 安装

```sh
git clone https://github.com/Kohaku233/open-alert.git
cd open-alert
npm ci --ignore-scripts --no-audit --no-fund
cp .env.example .env
```

Windows PowerShell 使用 `Copy-Item .env.example .env`。保留随项目提交的锁文件；若 SQLite 原生模块无法加载，按[安装说明](INSTALL.md)处理。

### 2. 配置

生成三个独立随机值：

```sh
node -e "const c=require('node:crypto'); for(const key of ['AUTH_SECRET','ENCRYPTION_KEY','BOOTSTRAP_TOKEN']) console.log(key+'='+c.randomBytes(32).toString('hex'))"
```

将结果分别写入私有 `.env` 的对应字段。示例已选择本地开发、SQLite 和 `APP_URL=http://localhost:3000`。

本地 `EMAIL_PROVIDER=console` 会将登录验证码输出到服务器终端。Google 登录需要同时配置两项 OAuth 值。生产环境的邮箱和 HTTPS 设置见[配置文档](CONFIGURATION.md)。

### 3. 构建并启动

将示例邮箱换成自己的地址：

```sh
npm run build
npm run admin:invite -- you@example.com
npm start
```

打开 **[localhost:3000](http://localhost:3000)**，使用受邀邮箱登录；本地 console 模式的验证码在服务器终端查看。

邀请 CLI 与应用使用同一份 `.env` 和数据库，创建七天有效的邀请，不发送邮件、不创建账户、不授予管理员角色。首位管理员按[已登录会话初始化流程](RUNTIME.md#邀请与首位管理员)设置，当前界面没有初始化表单。

### 4. 创建第一条警报

1. 在**通知中心**添加 Pushover 或 Discord 渠道，明确发送一条测试消息。
2. 为该渠道开启**价格警报**路由并保存。
3. 选择交易所和市场，创建目标价格警报。
4. 打开监控总开关。新账户默认暂停监控。

保存渠道只验证配置，不发送测试消息。Pushover 需要自己的 user key，以及个人 application token 或运营者配置的共享 token；Discord 使用频道 Webhook URL。

## 部署方式

| 能力 | Node / Docker | 独立 Cloudflare Workers |
| --- | --- | --- |
| 数据库 | SQLite / PostgreSQL | D1 |
| 价格采集 | CCXT Pro 成交流 | CCXT REST 最新成交采样 |
| 调度 | 共享调度器与数据库租约 | 单个 Durable Object alarm，Cron 补偿 |
| 通知 | 通知中心，支持 Pushover、Discord | 原有 Pushover 渠道 API |
| 异动监控 | 支持 | 尚未接入 |
| 内置 K 线与收藏 | 支持 | 尚未接入 |
| 浏览器更新 | WebSocket，断开后轮询 | HTTP 轮询 |
| 邮件 | SMTP / Resend；本地开发可用 console | Resend；本地开发可用 console |

**Node 提供当前完整功能。** 共用前端中的部分页面依赖 Node 服务，在独立 Worker 上不可用。也可以由 Cloudflare 提供静态资源，通过 `NODE_BACKEND_URL` 将 `/api/*`（含 WebSocket）转发到 Node。

生产环境设置 `NODE_ENV=production`，配置 HTTPS 公开地址、真实邮件服务、持久化存储和自己的凭据，移除 `DEV_ORIGIN`，停用开发用 console 邮箱。升级前备份数据库和加密密钥。具体步骤见[部署与运行](RUNTIME.md)、[配置模板](CONFIGURATION.md)及[备份恢复](BACKUP.md)。

Docker Compose 提供 SQLite 和 PostgreSQL 两种服务配置。独立 Cloudflare 部署前必须显式迁移 D1；模板从 5 位用户、全局 8 个市场、每日全局 100 次发送尝试起步。这些是初始限额，不代表已经验证的生产容量，详见[容量说明](RUNTIME.md#调度免费额度与容量)。

Cloudflare 可选用经过认证的 [Vercel Binance 永续中继](binance-vercel-relay.md)，每轮请求最多批量获取八个监控市场。

## 警报如何工作

后台按所选交易所的真实成交价判断：上限规则在 `price >= threshold` 时触发，下限规则在 `price <= threshold` 时触发。第一次获得新鲜成交价时，如果已满足条件，也会触发。

- **明确重新武装。** 编辑已触发规则不会解锁。排队或发送中的警报不能编辑、删除或重新武装。暂停监控会取消排队事件，已发出的请求无法撤回。
- **只使用新鲜价格。** 价格警报同时检查交易所时间与本地接收时间，拒绝无效、过期数据。页面报价和图表仅作展示，不触发规则，也不开启监控。
- **持久化投递状态。** 触发锁存与通知入队原子提交，发送前持久化占用和额度。明确拒绝允许有限重试，结果不明记为 `uncertain`，不自动重发。
- **异动独立运行。** 异动订阅有自己的开关、过滤条件和用户冷却记录。异动消息只分发一次，不使用价格警报的通知队列重试流程。

系统不承诺每笔成交都被覆盖，也不承诺端到端恰好投递一次。Node 成交流可能有重连或缓冲缺口；Cloudflare 以五秒为目标间隔采样最新成交，可能漏掉短暂越界。网络、限流和调度会拉长间隔。`sent` 表示提供方已接收，不代表设备已经显示或用户已读。

市场目录缓存在内存，重启后须重新加载。浏览器在每次工作台会话首次进入时读取目录，之后由用户手动刷新。WebSocket 推送展示报价及警报变化，连接正常时每 30 秒读取状态；断开后回退到每五秒轮询。[行情运行说明](ccxt-runtime.md)记录采样和恢复细节，其中带日期的验证结果对应历史版本。

## 文档

| 文档 | 内容 |
| --- | --- |
| [安装与原生模块](INSTALL.md) | 环境要求、SQLite 检查和平台安装 |
| [配置模板与密钥](CONFIGURATION.md) | 环境变量、邮件、Google、Secrets 和限额 |
| [部署与运行](RUNTIME.md) | Node、Docker、Cloudflare、管理员初始化与容量 |
| [通知中心](notification-center.md) | 渠道、消息路由、免打扰和发送记录 |
| [服务运行诊断](OBSERVABILITY.md) | 健康、就绪、事件和外部探测 |
| [备份与恢复](BACKUP.md) | 数据库一致性、密钥保存和恢复 |
| [旧系统离线迁移](MIGRATION.md) | 快照导入、归属校验和显式切换 |
| [行情运行说明](ccxt-runtime.md) | 市场标识、采样、故障处理和验证 |
| [Binance Vercel 中继](binance-vercel-relay.md) | 可选的 Cloudflare 永续行情路径 |
| [测试资格与用量](beta-access.md) | 账户权限、容量和付费状态 |

## 开发

完成快速开始中的配置后，在两个终端分别启动后端与前端：

```sh
npm run dev
```

```sh
npm run dev:web
```

Vite 在 `http://localhost:5173` 提供前端，将 `/api` 代理到 3000。示例 `.env` 已显式信任该本地开发地址。

| 命令 | 用途 |
| --- | --- |
| `npm run typecheck` | 后端与测试类型检查 |
| `npm run typecheck:web` | 前端类型检查 |
| `npm run build` | 构建 Node 服务和前端资源 |
| `npm test` | 分批运行 Node 测试套件 |
| `npm run lint:css` | 检查 CSS 层叠覆盖 |
| `npm run lint:css:dupes` | 对照基线检查样式重复归属 |
| `npm run cf:check` | Worker 打包检查，不部署；需先构建前端 |
| `npm run test:runtime:cf` | 构建并验证本地 Cloudflare 运行时 |

测试用本地替代服务模拟外部提供方，结果写入 `test-output/`。PostgreSQL 集成需要可选的嵌入式引擎。本地通过不代表线上提供方可用或托管容量已经验证。

浏览器检查使用可选 Playwright，先完成 `npm run build`：

```sh
npm install --no-save --package-lock=false playwright
npx playwright install chromium
npm run test:browser
npm run test:browser:mock
```

额外安装不改锁文件。Linux 可能需要安装 Chromium 系统依赖，也可用 `PLAYWRIGHT_MODULE` 指向已有的 Playwright `index.mjs`。浏览器检查使用临时数据及本地邮件、行情、通知替代服务；移动端检查模拟 Chromium 视口，不能代表实体 iOS 设备。

项目使用 TypeScript、React、Vite、Hono、Better Auth、Drizzle 和 CCXT；界面基于 [shadcn/ui 与 Radix](../web/components/ui/README.md)，内置图表使用 Lightweight Charts。目录结构见[英文 README](../README.md#project-structure)。[初始开发契约](../CONTRACT.md)保留早期设计，其中部分约束早于当前功能。

## 参与贡献

提交修改前请阅读[贡献指南](../CONTRIBUTING.md)。可复现问题和功能建议通过 [GitHub Issues](https://github.com/Kohaku233/open-alert/issues)提交，社区交流遵循[行为准则](../CODE_OF_CONDUCT.md)。

安全漏洞按[安全策略](../SECURITY.md)通过 [GitHub Security Advisories](https://github.com/Kohaku233/open-alert/security/advisories/new)私下报告。

## 许可证

项目采用 [Apache License 2.0](../LICENSE)。依赖保留各自许可证，外部服务受各自条款及收费规则约束。
