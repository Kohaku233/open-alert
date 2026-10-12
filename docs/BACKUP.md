# 备份、恢复与密钥迁移

本项目对每位用户的 Pushover user key、私有 application token 和 emergency receipt 使用 AES-256-GCM 字段加密，AAD 绑定用户及字段。**数据库整体不是加密数据库**：邮箱、会话、规则、行情/发送记录、配额和管理员信息仍是敏感数据。数据库 dump、旧系统 JSON 快照、离线 D1 artifact 都应作为私有备份，额外加密后保存到受控位置。

当前没有通用“导出全部用户并导入另一数据库”的产品接口或一键跨 SQLite/PostgreSQL/D1 迁移命令。`scripts/migrate-legacy.ts` 仅支持 [旧单用户状态的离线导入](MIGRATION.md)，不能用于新系统整库跨后端搬迁。

## 一致性与加密保存

1. 记录源码版本、数据库类型、迁移版本/checksum、注册策略和备份时间。迁移/升级前制作可恢复副本。
2. 停止目标安装的调度与写入，再通过数据库支持的方式获得一致性快照。不要只复制运行中的 SQLite 主文件而遗漏 WAL；不要把公开 status JSON 当作备份。
3. 用受信任的备份工具将快照加密，限制文件权限，将解密能力与备份文件分开保管。应用 `ENCRYPTION_KEY` 仍须单独安全保存。
4. 在隔离目标恢复并核对管理员、用户/规则数量、迁移账本、配额、锁定/uncertain 状态及凭据可解密性。恢复的旧会话也属于敏感能力，不要公开临时目标。

例如已有 `age` 时，使用自己的接收者公钥加密数据库快照（以下为占位命令）：

```sh
age -r YOUR_AGE_RECIPIENT -o /private/open-alert-backup.sql.age /private/open-alert-backup.sql
age -d -i /private/age-identity.txt -o /private/restored.sql /private/open-alert-backup.sql.age
```

`age` 是运营者额外安装的工具，不是项目依赖；它的 identity 与应用加密密钥作用不同。确认加密产物可恢复后，按自己的存储策略清理明文中间文件；不要把备份或 identity 放在项目、Web 目录或 Docker build context 内。Windows 限制 ACL，Unix 明文副本使用 0600。

## SQLite / Docker

停止所有连接该数据库的应用进程（Compose 使用 `docker compose stop app`），记录卷名和 `SQLITE_PATH`。可使用 SQLite 支持的 backup API/`.backup` 得到一致性副本，或在所有连接停止后备份数据库及残留 `-wal`/`-shm` 文件。Docker 卷为真实数据来源；`docker compose down -v` 会删除数据，不应用于保留数据的升级。

恢复到私有新路径或新卷，保留文件权限，并使容器 `node` 用户可读写。使用同一加密密钥和匹配源码版本先验证迁移账本；自动迁移只适用于项目支持的版本变化，不能代替备份。恢复试验期间保持出口隔离，避免恢复队列触发真实通知。

## PostgreSQL

使用数据库支持的 `pg_dump`/`pg_restore` 或托管服务快照，保持运行版本兼容。连接凭据通过私有服务配置或受限环境提供，不要写到可共享命令记录。普通 `pg_dump` 可以得到事务一致性快照；为备份切换中的队列状态，仍建议停止应用写入与发送。将 dump 另行加密，恢复到新数据库后验证 migration checksum、角色和数据，保留原备份。

## Cloudflare D1

D1 支持数据库 export 与 Time Travel，覆盖范围和保留窗口取决于平台及套餐。运营者在自己的授权环境执行，例如：

```sh
npx wrangler d1 export open-alert --remote --output /private/open-alert-backup.sql
```

导出含敏感认证数据，应立即额外加密保存；Time Travel 的恢复操作也需在自己的维护窗口执行。D1 备份不包含 Worker Secrets、DO alarm/临时调度状态或 Wrangler 配置。同步保留配置版本和独立密钥备份。项目中 D1 是认证/规则/outbox 的权威存储；DO 负责共享调度，不能用 DO 临时状态替代 D1 备份。

官方参考：[D1 export](https://developers.cloudflare.com/d1/best-practices/import-export-data/)、[Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)、[SQLite Backup API](https://www.sqlite.org/backup.html)、[PostgreSQL backup](https://www.postgresql.org/docs/current/backup.html)。

## 加密密钥与发送恢复

恢复原密文时必须使用原 `ENCRYPTION_KEY`。丢失密钥后，备份中的通知凭据无法解密。`AUTH_SECRET` 和邮箱/Google/Pushover 服务配置也应由自己的 Secret 管理系统备份；不要将所有解密材料与数据库放在同一个公开包中。

本项目未提供已存凭据的密钥轮换 CLI。需要轮换时，先备份并暂停写入，在受控迁移中用旧密钥逐个解密、用新密钥和原用户/字段 AAD 重新加密，覆盖全部受保护字段后验证并切换配置。只改环境变量会让已有密文不可用。旧系统导入的私有通道使用新安装的密钥重新加密，但它不负责整库密钥轮换。

数据库恢复可能回退到某次发送之前；提供方可能已经收到该通知。数据库快照无法撤销外部发送，也无法证明快照里的 `queued` 尚未发送。恢复后先隔离发送、核对 outbox 和提供方记录，决定取消或保留队列再启用监控。运行时对中断的 `sending` 采用 `uncertain`，不会自动重发；历史配额、锁定状态和不确定事件不应通过清空表来重置。
