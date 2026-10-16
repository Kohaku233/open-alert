# 配置模板与密钥

配置项以 `src/config.ts` 的校验为准。Node 的 `npm start`、`npm run dev` 和 `npm run admin:invite` 自动加载项目根目录的 `.env`；其他直接 `node` 命令应显式传入 `--env-file=/private/new-installation.env`。Cloudflare 通过 Wrangler 的 vars、Secrets 和绑定提供配置，不能把 Node 的 `.env` 当作 Worker 部署配置。

## Node 生产配置模板

将下列内容保存为部署机器上的私有 `.env`，填入自行生成的值。空占位值不能直接启动。不要提交这个文件；Unix 设置 `chmod 600 .env`，Windows 限制文件 ACL。

```dotenv
NODE_ENV=production
DEPLOYMENT=node
DB_DRIVER=sqlite
SQLITE_PATH=./data/open-alert.sqlite
APP_URL=https://alerts.example.com
PORT=3000
AUTH_SECRET=
ENCRYPTION_KEY=
INVITE_ONLY=true
BOOTSTRAP_TOKEN=
EMAIL_PROVIDER=resend
EMAIL_FROM=Open Alert <alerts@example.com>
RESEND_VERIFY_DOMAIN=true
RESEND_API_KEY=
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
PUSHOVER_APP_TOKEN=
MAX_USERS=1000
MAX_ALERTS_PER_USER=20
MAX_INSTRUMENTS_PER_USER=8
MAX_ACTIVE_ALERTS=2000
MAX_GLOBAL_INSTRUMENTS=200
DAILY_NOTIFICATION_LIMIT=20
GLOBAL_DAILY_NOTIFICATION_LIMIT=20000
```

生产环境省略 `DEV_ORIGIN`。`APP_URL` 必须是对外 HTTPS origin，不能包含路径、查询、片段或 URL 用户信息。Node 服务监听 `0.0.0.0`；直接部署时用防火墙限制内部端口，并通过 HTTPS 反向代理公开服务。Docker Compose 已将应用端口绑定到主机 localhost。

改为 PostgreSQL 时设置 `DB_DRIVER=postgres` 和私有 `DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/DBNAME`。URL 中用户名、密码的保留字符应做百分号编码。Compose PostgreSQL 服务使用 `.env` 中的 `POSTGRES_PASSWORD` 生成连接 URL，因此应生成足够强的 URL-safe 密码；不要留下空密码。不要关闭数据库 TLS 证书验证。

改为 Node SMTP 时设置 `EMAIL_PROVIDER=smtp`、`EMAIL_FROM` 和私有 `SMTP_URL=smtps://USER:PASSWORD@HOST:465`（或支持 STARTTLS 的 `smtp://...:587`），移除不用的 Resend 值。SMTP URL query 不用于削弱 TLS 或超时策略。启动会验证 SMTP 连接，发件地址及域名还需满足服务商要求。Resend 默认 `RESEND_VERIFY_DOMAIN=true`，启动会读取 `/domains` 确认 `EMAIL_FROM` 对应域名已验证，需要具有域名读取及发信权限的 API key；[官方权限说明](https://resend.com/docs/api-reference/api-keys/create-api-key)中 `sending_access` 只能发信。

已在 Resend 控制台验证自己的发件域名、但使用 sending-only key 时，显式设置 `RESEND_VERIFY_DOMAIN=false`。此模式启动只校验本地配置，不请求 `/domains`，也不发送验证邮件；它不能证明 key 可用、域名已验证或邮件已送达，实际发信仍由 Resend 校验并返回结果。

个人试运行可使用以下配置（Node 私有 `.env` 或 Worker 的对应绑定）：

```dotenv
EMAIL_PROVIDER=resend
EMAIL_FROM=onboarding@resend.dev
RESEND_VERIFY_DOMAIN=false
EMAIL_TEST_RECIPIENT=owner@example.com
INVITE_ONLY=true
```

`EMAIL_TEST_RECIPIENT` 必须换成与 Resend 账户关联的邮箱，保存在私有配置；Worker 使用 Secret，不写公开 vars。保留私有 `RESEND_API_KEY`。`onboarding@resend.dev`（含显示名及大小写变体）自动进入 sandbox 模式，必须配置有效的测试收件人；此时即使 `RESEND_VERIFY_DOMAIN=true` 也不读取域名。邮箱会 trim 并转小写。只允许向指定邮箱发送 OTP 或邀请邮件，其他收件人在 HTTP 请求前以 `email_rejected` 拒绝，不会改写收件人或把他人的验证码转寄。此限制仅适用于 Resend sandbox 发件人，自有发件地址、SMTP 和 console 不受该收件人设置限制。

[Resend 官方说明](https://resend.com/docs/knowledge-base/403-error-resend-dev-domain)：`resend.dev` 只能向 Resend 账户邮箱发送测试邮件；要为多用户提供邮箱登录及邀请邮件，必须验证自己的发件域名并更换 `EMAIL_FROM`。Google 登录仍受同一 `INVITE_ONLY=true` 邀请策略约束，开启 Google 不代表开放注册。

公开 `/api/auth-capabilities` 的 `emailSenderMode` 仅说明配置模式：`resend_domain_check`、`resend_sending_only` 或 `resend_sandbox`（其他值为 `smtp`、`console`、`unconfigured`），不返回发件地址、测试收件人或 key。`emailOtp=true` 表示应用允许尝试 OTP 发送；sandbox 只支持指定邮箱，sending-only/sandbox 启动成功不代表提供方或发件域名验证成功。

创建邀请与发送邀请邮件分别返回结果。邀请先保存；邮件被拒绝或结果不确定时，邀请仍然有效。同一邮箱的未使用、未过期邀请会原样返回，不延长有效期，也不重复发送邮件。测试模式对其他邮箱不尝试发信；受邀者仍可使用已启用的 Google 登录。要向其他邮箱发送邀请或验证码，必须配置自有已验证发件域名。一次邮件失败会反映在运行健康状态中，但不会关闭已配置的验证码登录入口；用户可按发送频率限制重试。

## Cloudflare 配置

`wrangler.jsonc` 已显式设置邀请制小规模配置：5 位用户、每人 20 条规则、全局最多 100 条启用规则、每人及全局最多 8 个品种、每人 20 次/日及全局 100 次/日发送尝试。仅 Worker 模板覆盖这些值，Node 配置与源码默认值保持不变。保留 `DB`、`COORDINATOR` 和 `ASSETS` 绑定；上线时填写自己的 D1 ID、公开 origin 与邮箱配置。当前模板保留全零 D1 ID，未填写 `APP_URL`、邮箱或 Google。

以下 `vars` 示例与模板的容量配置一致：

```json
{
  "NODE_ENV": "production",
  "DEPLOYMENT": "cloudflare",
  "DB_DRIVER": "d1",
  "APP_URL": "https://alerts.example.com",
  "EMAIL_PROVIDER": "resend",
  "EMAIL_FROM": "Open Alert <alerts@example.com>",
  "INVITE_ONLY": "true",
  "MAX_USERS": "5",
  "MAX_ALERTS_PER_USER": "20",
  "MAX_INSTRUMENTS_PER_USER": "8",
  "MAX_ACTIVE_ALERTS": "100",
  "MAX_GLOBAL_INSTRUMENTS": "8",
  "DAILY_NOTIFICATION_LIMIT": "20",
  "GLOBAL_DAILY_NOTIFICATION_LIMIT": "100"
}
```

这是合并到现有 `vars` 的示例，不能替代整个 Wrangler 配置文件。Cloudflare 不支持本项目的 SMTP 适配器。下列值使用 `npx wrangler secret put NAME` 的交互输入或平台 Secrets 设置：

| Secret | 用途 |
| --- | --- |
| `AUTH_SECRET` | 必需，至少 32 字符，认证与会话相关密钥 |
| `ENCRYPTION_KEY` | 必需，AES-256-GCM 32 字节；64 个十六进制字符或规范带 padding 的 base64 |
| `RESEND_API_KEY` | Resend 必需；默认需域名读取及发信权限，sending-only 模式只需发信权限 |
| `EMAIL_TEST_RECIPIENT` | Resend sandbox 必需；与 Resend 账户关联的唯一允许收件邮箱，保持私有 |
| `BOOTSTRAP_TOKEN` | 首位管理员初始化时使用，至少 32 字符；完成后删除 |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | 可选，必须同时配置；缺少二者时 Google 入口关闭 |
| `PUSHOVER_APP_TOKEN` | 可选，运营者共享的服务端 application token |
| `BINANCE_RELAY_BYPASS` | Vercel 自动化部署保护绕过密钥，仅保存在 Cloudflare Secrets |
| `BINANCE_RELAY_TOKEN` | 可选，与Vercel Function 的 `BINANCE_RELAY_TOKEN` 一致，32–256 位 URL-safe 随机值；必须配对 `BINANCE_RELAY_URL` |

`AUTH_SECRET`、`ENCRYPTION_KEY`、`BOOTSTRAP_TOKEN` 分别生成，不能复用。数据库备份恢复需要原加密密钥；单纯替换 `ENCRYPTION_KEY` 不能轮换已存凭据。不要把 Secrets 写入 Wrangler vars、前端 `VITE_*` 变量或源码。

本地 Worker 可把 Secrets 放在忽略版本管理的 `.dev.vars`，并设 `NODE_ENV=development`、本地 `APP_URL=http://localhost:8787`、`EMAIL_PROVIDER=console`。本地迁移和邀请使用 `--local`；生产使用 `--remote`。两种数据库互相独立。

## Binance 永续 relay

Cloudflare 可通过东京 Vercel Hobby Function 批量采集 Binance 永续真实成交。设置 `BINANCE_RELAY_URL`、`BINANCE_RELAY_TOKEN` 和部署保护所需的 `BINANCE_RELAY_BYPASS` Secrets；全局品种限制为 8。URL 为中继项目的 HTTPS 基址，不带 `/api/market`。详见 [Vercel 中继部署与实测](binance-vercel-relay.md)。

## 限额与注册策略

默认邀请制同时约束 Google 与邮箱 OTP 注册。关闭邀请制时设 `INVITE_ONLY=false`，用户上限依然有效。D1 的 `MAX_USERS` 和 `INVITE_ONLY` 必须与 `db:migrate:d1` CLI 写入的持久化策略一致；更改时先运行显式迁移/策略命令，再切换 Worker 配置。Node 启动负责同步其注册策略。

以下是源码默认值（Node 模板沿用）；Cloudflare 的 `wrangler.jsonc` 显式覆盖为上面的较小配置，不能把此表当作 Free 容量建议。

| 配置 | 源码默认值 | 允许值 |
| --- | ---: | --- |
| `MAX_USERS` | 1000 | 1–100000 |
| `MAX_ALERTS_PER_USER` | 20 | 1–100 |
| `MAX_INSTRUMENTS_PER_USER` | 8 | 1–100，不能高于全局品种数 |
| `MAX_ACTIVE_ALERTS` | 2000 | 1–100000 |
| `MAX_GLOBAL_INSTRUMENTS` | 200 | 1–1000 |
| `DAILY_NOTIFICATION_LIMIT` | 20 | 1–20 |
| `GLOBAL_DAILY_NOTIFICATION_LIMIT` | 20000 | 1–2000000 |

每日额度使用 UTC 日期，计算实际发送尝试（包含测试和失败尝试），不限于成功数。这些是应用层上限，不代表免费平台可承载的用户数或通知数。运营者应依据部署资源、外部服务额度和实际指标调低限额。

## Google 与用户 Pushover

Google OAuth 客户端配置 Web application，授权回调 URI 使用 `APP_URL/api/auth/callback/google`（例如 `https://alerts.example.com/api/auth/callback/google`）。邀请邮箱须与最终验证身份匹配；只有一项 Google 值时配置校验失败。

已有邮箱 OTP 用户可直接使用同邮箱的 Google 身份登录原账户，首次登录自动关联，保留原用户 ID、数据库角色及已消耗邀请；无需先在设置页显式关联，即使用户已达到上限或原邀请已过期，已有用户仍可正常登录。仅信任 Google，要求提供方 `email_verified === true` 且本地邮箱已验证，邮箱先 trim 并转小写。不同邮箱的登录/关联、归属其他用户的 Google account、未验证邮箱均拒绝；新 Google 用户仍须有匹配的有效未使用邀请（邀请制开启时）且未达到用户上限，新用户角色固定为 `user`。

禁用账户拒绝 Google 登录、关联与会话访问，并在 account 创建和 session 创建前再次检查。若账号恰在关联记录写入后被禁用，已写入的关联记录可能保留，但不会创建会话或恢复访问，也不会重置角色。Better Auth 1.7.7 的 Google mapper 对未验证 profile 直接返回安全的 HTTP 403 `VERIFIED_EMAIL_REQUIRED`；它发生在 OAuth 回调重定向捕获之外，不应依赖所有失败都跳转 `errorCallbackURL`。

每位用户在自己的通知设置填写 Pushover user key；application token 优先使用用户私有覆盖值，未设置才使用服务端共享 token。凭据和 emergency receipt 在数据库中按用户和字段绑定加密，不返回浏览器。保存会请求提供方验证凭据而不发送消息；用户点击测试才发送普通优先级消息并消耗额度。Pushover 客户端授权、提供方额度、邮件服务额度和 Cloudflare/主机费用分别核算。


### 邀请管理与登录体验

管理员可通过 `GET /api/admin/invites` 分页查看待加入、已加入、已过期、已撤销的记录。`POST /api/admin/invites/:id/resend` 需显式提交 `confirm:true` 与 `expectedExpiresAt`，不续期；同邮箱的创建邮件与重发共用持久化的一分钟限制。邀请邮件发送失败不回滚邀请，也不会自动重试。Resend 创建邮件带稳定的 Idempotency-Key。API 的 `accepted` 仅表示邮件服务已接受，不代表收件箱投递成功。

`DELETE /api/admin/invites/:id` 需 `expectedExpiresAt`，通过 CAS 将未使用的有效邀请到期时间设为 0，保留撤销记录并阻止后续注册；已发邮件无法撤回。再次邀请会重新启用记录，已注册邮箱返回 `account_exists`。管理员确认受邀者仍需要访问后，才应重新邀请。

Google 使用 `prompt=select_account`，每次选择账号；同邮箱关联仍要求 Google 与本地邮箱均已验证，停用账户、未受邀用户与已撤销邀请不能借此注册。邮件提供中文/英文 HTML 与纯文本，邀请链接只预填邮箱，不携带认证令牌或授予登录权限。浏览器消费预填邮箱后清理 URL。验证码仍为 6 位、5 分钟有效，前端按真实时间与 Retry-After 倒计时，不在浏览器存储 OTP。
