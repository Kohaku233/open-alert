# 自行部署与运行

先按 [安装说明](INSTALL.md)安装依赖，按 [配置模板](CONFIGURATION.md)填写自己的域名、邮箱和 Secrets。本项目面向运营者自行部署的多用户服务；每个用户独立管理规则和 Pushover 通道，管理员管理邀请与账号状态。多个用户共享行情调度，不能为每位用户创建 DO 或独立轮询器。

## Node SQLite / PostgreSQL

要求 Node >=22.12.0。在项目根目录运行：

```sh
npm run build
npm start
```

构建分别生成 `dist/server` 与 `dist/web`，启动读取可选 `.env` 并运行编译后的服务。服务从工作目录 `dist/web` 提供 SPA，因此直接部署的 systemd/进程管理器须把工作目录设为项目根目录。数据库迁移 SQL 已嵌入源码，迁移执行不依赖工作目录中另有 SQL 文件。

Node 默认 `DEPLOYMENT=node`、`DB_DRIVER=sqlite`、`SQLITE_PATH=./data/open-alert.sqlite`。SQLite 使用 WAL、外键和有限 busy timeout；生产禁止 `:memory:`。父目录应可写，运行数据应在持久化磁盘。PostgreSQL 改为 `DB_DRIVER=postgres`，提供自己的 `DATABASE_URL`。托管数据库保持正常 TLS 证书验证，不要通过全局关闭证书校验解决连接问题。

生产设置 HTTPS `APP_URL`，SPA 与 API 使用同一 origin，通过反向代理终止 TLS。Node 默认在 `0.0.0.0:3000` 监听；直接部署需限制该端口对外访问。客户端 IP 来自实际 socket，服务会覆盖内部 IP header，浏览器自行提供的 forwarded header 不可信。当前 Node 无显式可信代理策略，反向代理后客户端会共享代理 socket IP 的认证限流桶，需要在自己的流量条件下评估。

启动顺序是校验配置、打开同一物理数据库、校验并迁移 auth tables → app tables → auth guards、构造对应 Drizzle 适配器、验证邮箱服务、启动共享调度器。缺少密钥、数据库不可用或邮箱验证失败时显示 setup 页面，health/API 返回 503，监控和认证停止。SIGINT/SIGTERM 会等待运行中工作、释放租约、关闭邮箱资源和数据库。

## Docker Compose

先把 `.env` 改为生产 HTTPS 和真实邮箱配置，不要直接使用开发 console 邮箱。SQLite：

```sh
docker compose up --build -d app
docker compose exec app npm run admin:invite -- you@example.com
```

容器使用 `node` 用户，数据库保存在 `sqlite-data` 卷；主机 `127.0.0.1:3000` 供 HTTPS 反向代理使用。镜像不包含 `.env`，Compose `env_file` 在运行时注入。Dockerfile 用 Debian Node 22 和随包预编译 SQLite；不支持的目标平台需要原生构建阶段，详见 [安装说明](INSTALL.md)。

PostgreSQL 先填写强 URL-safe `POSTGRES_PASSWORD`，再明确选中服务：

```sh
docker compose --profile postgres up --build -d postgres app-postgres
docker compose exec app-postgres npm run admin:invite -- you@example.com
```

应用在主机 `127.0.0.1:3001` 监听，PostgreSQL 仅在内部 Docker 网络开放，数据保存在 `postgres-data` 卷。不要仅执行未选择服务的 `docker compose --profile postgres up`，以免同时启动默认 SQLite 服务。两种安装使用不同公开 origin；同一 origin 不能交替指向两份独立数据库。

健康检查访问 `/api/health`。正常配置后的通知组件在首次真实凭据验证/发送前仍可能为 starting，因此刚启动的 Docker health 不一定立即健康；不能为了显示绿色而伪造通知健康。容器启动、目标架构原生模块和实际 PostgreSQL 连接应在运营者环境验证。

## 邀请与首位管理员

`INVITE_ONLY=true` 为默认，Google 与邮箱 OTP 注册均检查邮箱邀请及用户上限。Node CLI 使用同一 `.env`/数据库，迁移后直接创建七天邀请：

```sh
npm run admin:invite -- you@example.com
```

它不验证 SMTP 连通性、不发送邮件、不创建用户/会话、不授予管理员。受邀邮箱正常登录并验证后，在账户页使用 `BOOTSTRAP_TOKEN` 的一次性初始化动作。服务同时要求已验证 cookie 会话、可信 Origin 和 `Authorization: Bearer BOOTSTRAP_TOKEN`，只在尚无管理员时原子地消耗持久化标记。完成后删除该部署 Secret；更换 token 不会重置已消耗状态。

后续管理员依据数据库中的 Better Auth 身份与角色执行操作，可通过管理界面创建邀请。用户必须自己保存并测试 Pushover 通道、创建规则、开启总监控；新账户默认关闭。Google 回调设为 `APP_URL/api/auth/callback/google`，缺少两项 Google 配置时能力报告会明确关闭入口。

## Cloudflare：D1 + 一个 Durable Object

`wrangler.jsonc` 是新安装模板，全部零的 D1 ID 不能直接用于生产。创建新的 D1（不要复用旧监控数据库），填写其 ID，保留 SQLite DO class migration 与 `DB`、`COORDINATOR`、`ASSETS` 绑定。namespace 仅使用 `COORDINATOR.idFromName('coordinator-v1')`。

以下远程命令供运营者在自己的授权环境执行，会创建/修改 Cloudflare 资源；本地检查无需执行它们：

```sh
npx wrangler d1 create open-alert
# 将返回的 database_id 填入 wrangler.jsonc；按 CONFIGURATION.md 设置 vars。
# 交互输入自己的值，不要在命令文本中写明文 secret：
npx wrangler secret put AUTH_SECRET
npx wrangler secret put ENCRYPTION_KEY
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put BOOTSTRAP_TOKEN
```

Worker 生产仅支持本项目 Resend 邮箱适配器；必须填写 `EMAIL_PROVIDER=resend`、已验证发件域名的 `EMAIL_FROM`，key 需允许读取 `/domains` 与发送邮件。可选 Google 和共享 Pushover 值同样放 Secrets。`APP_URL` 和公开限额放 vars，生产省略 `DEV_ORIGIN`。配置域名/路由，使 `APP_URL` 与实际公开 origin 一致。

D1 必须先显式迁移，`--max-users` 和 `--invite-only` 与 Worker 配置完全一致：

```sh
npm run db:migrate:d1 -- --remote --max-users 5 --invite-only true
npm run build:web
npm run cf:check
# 数据库、公开 origin 与 Secrets 都已配置后：
npm run cf:deploy
npm run admin:invite:d1 -- you@example.com --remote
```

顺序为新库 → 配置/Secrets → D1 schema/策略 → 构建与 dry-run → 部署 → 首个邀请 → 正常验证登录 → 一次性 bootstrap。迁移 CLI 检查 schema 对象及 checksums，原子应用 tables、app、guards 与策略；重复执行跳过已应用 DDL。并发旧计划失败时可重试。运行时只读 migration ledger 和注册策略，缺失或不一致时拒绝服务；API 请求不会自动迁移 D1。

`db:migrate:d1` 兼容 Wrangler 在 remote `--file --json` 结果前输出进度文本：只解析末尾完整 JSON 数组，逐项要求 `success: true` 和 `results` 数组；尾随非空白内容、失败结果或截断 JSON 均拒绝，不回显 Wrangler 原始输出。可在隔离本地环境运行 `node scripts/test-batches.mjs test/config.test.ts test/schema-ready.test.ts` 验证解析器与本地 D1 迁移，无需远程操作。

`db:migrate:d1` 可用 `--database NAME`、`--config PATH`，但现有 `admin:invite:d1` CLI 固定使用默认配置和数据库名称 `open-alert`，没有这些参数。改名部署需由运营者使用对应数据库的受控工具创建邀请，不能假设 CLI 会自动跟随改名。

确认 `/api/auth-capabilities` 报告实际启用的邮箱 OTP 后登录。D1 invitation CLI 不发邮件也不授予角色。bootstrap 与 Node 相同。完成后可 `npx wrangler secret delete BOOTSTRAP_TOKEN`。

会话查询 `/api/auth/get-session` 使用明确的每 IP 每分钟 60 次规则。原生限流器的默认一小时窗口仅用于保留共享表里的邮箱小时计数；使用安装版本实际支持的 `/**` 路径通配符，把未单独配置路径的小时默认值映射为 60 秒。该 fallback 保留库的更严格特殊规则，例如 Google 登录每 10 秒 3 次。显式的验证码发送、验证码校验及邮箱独立冷却规则保持不变。能力接口初始化失败返回可重试的 503，不伪装为登录未配置。

本地 Worker 用 `.dev.vars` 配置本地 development、console 邮箱与 `APP_URL=http://localhost:8787`，迁移/邀请都使用 `--local`，构建前端后运行 `npm run cf:dev`。本地与远程 D1 独立，不能用一次本地初始化代替生产迁移。Worker import 链不包含本项目原生 SQLite/PG/SMTP 适配器。

## 调度、免费额度与容量

服务自身的指标、异常/恢复记录、就绪接口和外部探测边界见 [服务运行诊断](OBSERVABILITY.md)。正常空闲/未探测与真实故障分开说明，不改变原 health 聚合，不自动发送额外通知。

DO 仅在可调度规则或 queued/sending outbox 存在时设置持久化目标五秒 alarm。无工作时移除 alarm，不轮询 ticker；对象内没有 resident timer 或 watchdog interval。写操作提交后，对幂等 wake 最多尝试 3 次、每次最多等待 1.5 秒；仍失败时以 `effects.schedulerWake='pending'` 明确报告后台待确认，不自动重放已提交的写操作。status 成功核对工作后可修复缺少的 alarm。正向工作探测最多复用 1 秒，并合并同一 revision 的并发探测；空闲结果不缓存，以免遮蔽新工作。

独立 Worker Cron 每分钟调用内部 `/reconcile` 核对持久化工作并补设 alarm，不依赖网页打开；空闲时只做工作检查，不抓行情、不发送通知。这是尽力恢复机制，不是固定 60 秒的恢复 SLA。仓库 `wrangler.jsonc` 已声明 Cron；若使用自定义 API 上传代码，必须另行同步并验证 Cron 触发器，不能只上传新版本就认为补偿已启用。部署凭据和生产变更仍需正常操作验证。行情缺失/过期保留原时间戳和 unknown/unhealthy 状态。

默认 SQL 调度租约统一使用 `RUNTIME_POLICY.leaseMs=40000`，保留网络与投递预算余量。工作台每 5 秒请求 `/api/status?include=alerts`，一次返回状态和警报，减少重复认证、限流写入和规则读取；旧服务缺少内嵌数组时才回退 `/api/alerts`。警报列表以一条 SQL 取每条规则的当前 pending 和最新完成结果，避免逐条历史查询；不读取完整历史日志。Cloudflare 展示报价通过内部 `/quote-lookup` 在一次协调器调用中校验市场与读取报价，认证、输入校验、400/503 错误和只读语义不变。

业务 API 对已存在的用户设置只读取、不重复执行初始化 INSERT；状态接口复用同一请求内的设置读取，每个新请求仍重新读取并检查禁用状态。缺失记录仍可并发安全地初始化；读失败返回 503，不能误当缺失后写回默认值。内置行情源通过 `resolve(instrument)` 按交易所/产品范围和 Map 索引选择单个市场，不为单品种报价、规则写入或常规 tick 复制全目录；每次仍重新判断目录有效期、停止、下架和队列溢出。未实现该可选端口的自定义源保留旧的全目录回退。

Cloudflare 默认每 tick 最多 100 条规则评估、最多 4 次 reservation；每 drain 最多读 32 条待发送记录、4 次 claim 与 4 次串行发送。cursor 跨 cycle 延续，SQL commit 再检查身份、generation、限额和 fencing。若以后提高容量到超过 100 条可调度规则，会跨轮次轮流评估；4 次 reservation 或 2.5 秒评估时间预算也可提前结束本轮，因此不能保证每条规则都在五秒内检查或通知。慢发送与 polling 独立，平台 eviction、网络及 alarm 延迟会拉长周期，大 backlog 需要多轮。内部 `/snapshot`、`/catalog`、`/catalog-response`、`/quote-lookup`、`/wake`、`/reconcile` 仅可通过 namespace 调用。小批次仍受 25 秒 drain、单次 9 秒发送预算约束，结果不明时停止本批，不自动重发；人数、品种和每日配额不变。没有证明 500 个活跃监控用户的吞吐与通知时延。

市场目录包含多个交易所的完整元数据。Cloudflare 的 `/api/markets` 在边缘完成会话、限流和查询参数校验后，由协调器生成目录或搜索结果的 API envelope，边缘仅转发响应流，避免重复解析和编码整个目录消耗 HTTP CPU 预算。浏览器首次进入工作台时读取目录，当前页面会话内复用；每五秒只读取状态与警报，恢复前台、切换页面或保存警报均不重新读取目录。用户可在市场选择器中手动重新读取，刷新网页或重新登录也会重新获取。已有目录在手动刷新遇到临时网络或 5xx 错误时保留元数据并明确标记过期，不自动重复请求，等待下次手动更新。后台交易所目录仍按约一小时 TTL 更新。目录失败不会阻止新的状态和警报显示；401、403 和 429 仍按原有登录、权限和全局冷却规则处理。保存警报始终由服务端重新确认所选市场可用性。

下面数字为官方资料核对时的 Free 参考，平台规则可能调整；应在上线时再次核对，并测量真实负载：

| 资源 | Free 参考与本项目影响 |
| --- | --- |
| Workers | HTTP CPU 10 ms，请求 100000/日；认证/解析未得到 10 ms 保证 |
| DO compute | 请求 100000/日（包含 alarms），duration 13000 GB-s/日；按每个对象分配的 128 MB 计算 |
| D1 | rows read 500万/日，rows written 10万/日，账号总存储 5 GB、单库 500 MB；表和索引操作均影响额度 |
| SQLite DO storage | rows read 500万/日，rows written 10万/日，总存储 5 GB；`setAlarm` 每次计一行写入，与 D1 分开核算 |

按官方示例中的 0.128 GB 计算，一个全天驻留对象为 `86400 × 0.128 = 11059.2 GB-s/日`，两个为 22118.4，超过共享 Free duration。五秒 alarm 一天约 17280 次，不含用户/API 调用。移除 timer 让空闲对象可能进入免 duration 状态，但持续 I/O 或持续规则会让对象仍驻留；同账号其他项目也使用套餐额度。每次 `setAlarm` 还涉及 DO 存储写入。

本仓库的 Worker vars 使用邀请制小规模起点：`MAX_USERS=5`、`MAX_ALERTS_PER_USER=20`、`MAX_INSTRUMENTS_PER_USER=8`、`MAX_ACTIVE_ALERTS=100`、`MAX_GLOBAL_INSTRUMENTS=8`、`DAILY_NOTIFICATION_LIMIT=20`、`GLOBAL_DAILY_NOTIFICATION_LIMIT=100`。`MAX_ACTIVE_ALERTS` 的写入容量检查统计启用且未删除的规则（含已触发锁定规则）；实际调度还要求规则未触发、用户监控开启且通道可用。每日发送尝试按 UTC 计数，包含测试、失败和重试。Node 与源码默认值仍为较大容量，原全局 20000 次/日仅成功通知核心事务就约写入 108万行，不适合作为 Free 建议。

以下按一个对象全天持续工作、100 条可调度规则、缓存未反复失效、无持续积压的正常小流量场景估算；这是预算拆解，不是实测资源上界：

| 路径 | 每日基础量与额外开销 |
| --- | --- |
| 五秒 alarm | `86400 / 5 = 17280` 次 DO alarm 请求及约同量 `setAlarm` 存储写；wake、status 修复、重试另计。持续驻留 duration 参考为 11059.2 GB-s。 |
| active/profile 缓存 | `activeRulesRefreshMs=30000`，约 2880 次刷新；每次返回最多 100 条 joined rows，即 28.8万条返回行/日。SQL 实际扫描 alerts 索引/表、user_settings 与 channels，返回行数不能当作 D1 `rows_read`；invalidations、重新初始化和分页也会增加读取。 |
| 工作探测与 due 队列 | 正常每 cycle 在 tick 前及 drain 后各一次 `hasWork`，约 34560 次探测/日，另有约 17280 次 due 查询、每次最多 32 行；status/wake 增加探测，profile 不可用及 backlog 会增加扫描。读取预算必须合计这些索引、JOIN 和队列操作，不能只算缓存返回行数。 |
| SQL 租约 | 实际 scheduler lease 为 40 秒，剩余时间超过 20 秒时复用缓存；稳定五秒周期约每 20 秒续租一次，即约 4320 次 D1 单行 UPDATE/日，另计初次 acquire、恢复、eviction 与慢发送后的续租。不是每五秒写租约。 |
| 通知核心事务 | 既有本地 D1 实测成功 reservation/claim/finish 为 12/27/15 行写入，合计 54 行，已包含索引与 CAS CHECK 断言的插入/删除；100 次成功约 5400 行。加常规续租约 9720 行/日，仍未包含认证、API、rearm、测试、失败/重试、恢复和超额 queued 事件清理。 |

新增 `0002_scheduler_indexes` 为待处理 outbox、pending alert 和 sending test 建索引；已有 D1 必须先显式迁移，缺少新版 ledger 时 runtime 关闭服务。既有本地 D1 在 20000 条已完成历史下，空闲工作探测从 20002 行降为 3 行；该结果不是所有 profile/队列状态的读上界。100 次发送限额不会阻止额外 reservation、被 quota 拒绝的 claim/清理事务、用户编辑或认证请求。建议试运行先把 D1 的 500万读/10万写每日额度至少留出一半作为认证、API、扫描放大、重启及同账号其他项目的余量；上表基础写入低于此目标，但实际读写是否满足仍须线上指标确认。

这些限额不能抵御恶意访问耗尽 Workers 请求、D1 或 DO 额度，也不保证认证、加密及 JSON 解析满足 Worker Free 每请求 10 ms CPU；该 CPU 边界尚未线上验证。上线观察 Worker CPU 与 `exceededCpu`、D1 `rows_read`/`rows_written`、DO requests/duration 与存储读写，依据实际指标进一步调低容量。Free 超额可能直接拒绝操作，批处理与缓存不构成可用性或免费容量保证。邮件/Pushover、域名和主机费用另计。

官方来源：[Workers limits](https://developers.cloudflare.com/workers/platform/limits/)、[DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)、[D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)、[D1 limits](https://developers.cloudflare.com/d1/platform/limits/)。本地 workerd 和 bundle dry-run 不证明生产账单或平台限制满足。

## 运行、升级与验证范围

health 公开安全状态，登录后 status 只返回本人的规则、行情、通道状态和 UTC quota。authenticated API 限流默认每用户 120 次/分钟；变更要求可信 Origin、会话与所需 JSON。日志只输出配置字段名或安全错误类别，不记录配置对象。

应用限流采用以首个成功请求为起点的固定窗口：窗口内成功只递增 count，不更新起点；达到额度后的拒绝不修改计数或起点，`Retry-After` 向上取整为距窗口结束的秒数（至少 1 秒）。到达起点加窗口长度的精确边界后，下一个成功请求原子重置为 count=1、起点=当前时间。API 每用户 120 次/60 秒，邮箱验证码发送冷却 1 次/60 秒、发送总额 10 次/小时、邮箱验证尝试 10 次/60 秒均保留原额度。每次额度占用使用同一条 `INSERT … ON CONFLICT … RETURNING`，多实例共享数据库时也不能超额。应用桶继续使用 `app-auth:` 私有摘要前缀，与 BetterAuth 原生按路径/IP 的限流桶分离；原生 IP 配额和 OTP 行为不变。

此修复不需要 schema 迁移、key 版本升级或清空 rate_limit。旧桶的 last_request 在升级后作为固定起点保留，窗口内新请求不再延长它；旧 API 桶最迟在原最后成功请求后 60 秒恢复，邮箱小时桶按其原最后成功请求后 1 小时恢复。

通知计算实际尝试（测试/失败也计入），确认的提供方拒绝可按 60/120 秒间隔重试，最多三次、事件年龄不超过十分钟。超时、发送后断连、格式异常或 sending 中重启为 uncertain，保持锁定并不自动重发。所有最终状态都需要显式 rearm。

升级前按 [备份与恢复](BACKUP.md)保存数据库及独立 Secrets，在隔离环境演练。D1 更新 schema/注册策略必须显式执行迁移，Node 启动自动校验支持的迁移。旧单用户监控迁移见 [MIGRATION.md](MIGRATION.md)，它不会自动读取旧生产环境或执行线上切换。

`npm run cf:check` 只打包，`npm run test:runtime:cf` 使用本地 workerd 和模拟提供方。真实 Google callback、SMTP/Resend、Pushover、Docker daemon、托管 PostgreSQL 和线上 DO eviction/alarm 时序需要运营者环境验证；开源交付的本地检查不作这些验证承诺。
