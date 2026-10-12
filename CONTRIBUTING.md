# Contributing

贡献说明 / Contributing guide

## 报告问题

请使用 GitHub Issues 报告可复现缺陷，并说明部署方式、版本、预期行为和实际行为。不要粘贴密钥、Cookie、会话、邮箱、数据库导出或生产日志。安全漏洞请按 [SECURITY.md](SECURITY.md) 私下报告。

## 提交更改

1. 从 `main` 创建主题分支。
2. 保持更改聚焦，并更新受影响的测试或文档。
3. 运行 `npm run typecheck`、`npm run typecheck:web` 及相关测试。
4. 使用清晰的英文提交说明，建议采用 Conventional Commits，例如 `fix: preserve alert generation`。
5. 发起 Pull Request，说明行为变化和验证方式。

认证、授权、数据库迁移和通知投递需要明确的失败路径测试。不要提交 `.env`、数据库、备份、构建产物或依赖目录。

提交贡献即表示你同意按本仓库的 Apache License 2.0 授权该贡献。

## Reporting issues

Use GitHub Issues for reproducible defects. Include the deployment type, version, expected behavior, and actual behavior. Never paste secrets, cookies, sessions, email addresses, database exports, or production logs. Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## Submitting changes

1. Create a topic branch from `main`.
2. Keep the change focused and update affected tests or documentation.
3. Run `npm run typecheck`, `npm run typecheck:web`, and the relevant tests.
4. Use a clear English commit message. [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) are recommended, for example `fix: preserve alert generation`.
5. Open a pull request describing the behavior change and verification.

Authentication, authorization, database migration, and notification delivery changes need explicit failure-path tests. Do not commit `.env`, databases, backups, build output, or dependency directories.

By submitting a contribution, you agree to license it under the repository's Apache License 2.0.
