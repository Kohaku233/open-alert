# 旧系统离线迁移 / Offline legacy migration

中文操作要点：此工具只处理旧单用户监控的私有 `monitor_state` 快照，不是新系统多用户整库导出或 SQLite/PG/D1 通用搬迁工具。必须先建立新安装、正常验证登录并完成管理员 bootstrap；目标用户须为真实、已验证管理员，目标规则/通道/outbox 必须为空。快照不能混入凭据，通道使用单独私有文件并以新安装 `ENCRYPTION_KEY` 重新加密。先执行 `--dry-run`，成功导入后总监控仍关闭，queued 事件保持暂停，sending 事件转 uncertain 并不自动重发。Cloudflare CLI 仅离线生成 artifact，不提供远程 apply。

生产切换要先停止旧来源并获取最终权威快照，备份新目标，再导入与显式 release-held；不能从旧系统仍发送时取得的快照直接释放队列。数据库/快照整体没有应用级加密，外层加密与恢复见 [备份说明](BACKUP.md)，完整参数及状态映射如下。

This tooling prepares and imports a private legacy state snapshot into an existing new installation. It never exports from, stops, modifies or deploys the old Worker, reads its environment, sends notifications, verifies SMTP, or changes DNS. The current OKX Worker can remain live while code, fixture tests and offline rehearsal are prepared. A final production snapshot and switch are separate operator actions.

Files: `src/migration/legacy.ts` (parser/planner/importer/cutover), `src/migration/d1-artifact.ts` (offline D1 statements), `src/migration/private-file.node.ts` (private file handling), `scripts/migrate-legacy.ts` (CLI), `test/migration.test.ts` (isolated SQLite tests).

## Source snapshot and private channel input

The inspected legacy source stores JSON in its Durable Object SQLite `monitor_state` table, row `id=1`, column `value`. Its source code does **not** provide an export endpoint. Do not add a public export route, use the public status response as an authoritative backup, or pass existing production access tokens to this CLI.

Acceptable input is a privately obtained backup containing the actual `monitor_state.value`, saved as `legacy-state.json`. Both a raw state JSON object and `{"monitor_state":"<JSON value>"}` are accepted. Supported source versions are v3 (per-market alerts), v2 (BTC alerts without instruments), and v1 (upper/lower `rules`, including early `latched` fields).

Obtaining a final backup must be planned independently using an authorized, server-side backup/recovery process for the actual Durable Object. If a future authorized server-side script is needed, it should read `SELECT value FROM monitor_state WHERE id=1` within the same object's storage context and write directly to private offline storage. There is no new network endpoint in this implementation, and Wrangler D1 commands cannot read a Durable Object database. No such export or live source access occurred during implementation.

Example minimal v3 input (synthetic values):

```json
{
  "version": 3,
  "config": {
    "enabled": true, "upper": null, "lower": null, "dailyLimit": 20,
    "notification": {"priority": 2, "retry": 30, "expire": 1500, "sound": "siren"}
  },
  "running": true,
  "alerts": [{
    "id": "11111111-1111-4111-8111-111111111111",
    "instrument": "ETH-USDT-SWAP", "name": "ETH upper", "side": "upper",
    "threshold": 2000, "enabled": true, "generation": 4,
    "triggered": false, "pending": null, "last": null
  }],
  "legacyLocks": {},
  "daily": {"date": "2026-10-11", "attempts": 11}
}
```

Snapshots are at most 2 MiB and 32 nesting levels. Unix input permissions must be private (`chmod 600`); symlinks and nonregular files are rejected. On Windows, restrict ACLs to the operator account: Unix mode bits cannot validate Windows ACLs. Generated artifacts use exclusive creation and mode 0600, and never overwrite existing files.

Backups contain prices, rule/event IDs, configuration and delivery metadata. Keep them private. Provider credentials, environment exports, session tokens, passwords, authorization values and provider receipt capabilities are rejected even in otherwise ignored fields. If an existing historical record contains a receipt, deliberately redact only that capability to `null` in the offline copy and keep the original backup private. Do not put Pushover secrets inside `config` or the snapshot.

Optional channel input is a **separate** private JSON file:

```json
{"userKey": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "appToken": "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"}
```

`appToken` may be omitted or `null` to use the new installation's shared environment token. Do not migrate shared app tokens from the old environment. When importing a private override, AES-256-GCM encrypts it using the **new** installation's `ENCRYPTION_KEY` with the target user/field AAD. Nothing logs channel plaintext. The reusable importer accepts secrets via a trusted `channelSecrets` callback. Dry-run does not invoke that callback or read the channel file.

## Target ownership and schema

The target user must already exist in the real auth `user` table, have the exact supplied user ID and normalized email, have `email_verified` set, hold `role='admin'`, and have no disabled account flag in `user_settings`. The importer does not create, verify or promote a user and does not accept an unvalidated owner claim.

Initialize the new installation through its normal runtime, sign in using its configured email/Google flow, and complete its normal admin bootstrap first. Close the runtime while rehearsing/importing, so monitoring cannot consume or cancel migrated work. The CLI checks the checked-in auth and app migration checksums against `schema_migrations`; it does not fabricate auth tables or run DDL. Database access is through the normal `createDb` SQLite/PostgreSQL factory.

The owner's target must contain no alerts (including deleted ones), outbox, channel profile, channel version slots, or test notifications. A freshly initialized, disabled-by-default `user_settings` row with generation zero is allowed; a modified or enabled settings row is rejected. Existing daily quota rows are allowed and never reset. Other owners' data remains protected, and colliding global alert/event IDs abort the import. Imported alert counts and instruments must satisfy the new configured limits; offline D1 staging uses the standard limits unless the caller supplies the actual installation's limits.

A global app write lock, auth-row guard, empty-target checks, inserts and manifest all commit in a single `atomicCAS` transaction. Late failures roll back everything, including newly encrypted channel rows and the migration ledger. No schema change is required: migration manifests live in private `app_meta` keys.

## Dry-run and import with Node SQLite or PostgreSQL

Use Node 22.12+ and the installed project dependencies. Load **only the new installation's** runtime config explicitly. The full config still requires actual production SMTP/Resend settings in production; migration does not instantiate an email transport or send mail. SQLite uses `SQLITE_PATH`; PostgreSQL uses `DB_DRIVER=postgres` and `DATABASE_URL` through the same CLI.

```sh
node --env-file=/private/new-installation.env --import tsx scripts/migrate-legacy.ts \
  --target node --dry-run \
  --source-id old-worker-production \
  --owner-id EXISTING_AUTH_USER_ID --owner-email owner@example.com \
  --snapshot /private/legacy-state.json

node --env-file=/private/new-installation.env --import tsx scripts/migrate-legacy.ts \
  --target node --apply \
  --source-id old-worker-production \
  --owner-id EXISTING_AUTH_USER_ID --owner-email owner@example.com \
  --snapshot /private/legacy-state.json \
  --channel-file /private/new-channel.json
```

Omit `--channel-file` to import no credentials and configure the new channel later through its authenticated interface. Imported queued events expect channel generation zero; configuring a first new channel gives generation zero. Replacing a channel before cutover causes queued validation to fail rather than silently changing their destination.

Node dry-run validates the actual target and installed migrations and makes no SQL mutations. Printed output contains only status, fingerprint and counts. Raw SQL errors, email, names, snapshot values and secrets are never printed. Do not use dry-run against production during unapproved implementation: local fixture targets are sufficient.

Reimporting the same canonical state/source/owner fingerprint returns `already_imported` without modifying alerts, latches, generations, channels or quota—even after legitimate post-import edits. A changed snapshot or different owner for that source is rejected. Importing a different source into the same owner is also rejected. Treat an import as final: rehearsal/final snapshots go into separate disposable targets, not incremental merges. The source ID is an operator-selected stable, nonsecret identifier.

## Exact state mapping

| Legacy state | New behavior |
| --- | --- |
| Alert UUID, name, market, side, threshold, enabled, generation | Retained; v2 adds `BTC-USDT-SWAP` only where absent |
| `triggered`, old `latched`, pending latch | Retained as one-shot latch; edits/import never rearm |
| `config.enabled`, `running` | Preserved in manifest; new `user_settings.enabled=false` |
| Queued event | Immutable price/threshold/market/notification snapshot and attempts preserved in outbox; `next_at=Number.MAX_SAFE_INTEGER` holds it; original retry time retained in manifest |
| Sending event | Terminal `uncertain`, `legacy_send_uncertain`, latch retained, no pending pointer, never automatically resent |
| Last result with complete original snapshot | Outbox retains event ID and earlier generation when applicable; ambiguous generation collisions fail |
| Legacy last result missing original price/threshold/timestamp | Original result retained in manifest only; no invented price, timestamp or fabricated delivery |
| Thresholdless legacy lock | Original and normalized/recovery records in manifest; no invented alert; queued lock recovery cancelled, sending lock recovery uncertain |
| Daily usage | Same source UTC date, user/global attempts set to maximum of existing and source counts, never reset |
| Previous price | Retained as migration metadata; not used as a fresh price or crossing trigger |

Queued work for actual alerts must include the original instrument (v2 defaults BTC), side, threshold, price, timestamp, creation time, notification snapshot and retry time. Incomplete or conflicting queued work fails during planning. An interrupted sending record with incomplete snapshot fields is retained as terminal `uncertain` in private metadata while preserving the alert latch and clearing its pending pointer; no original price is fabricated. A pending ID, duplicate IDs, incompatible generation, or conflicting snapshot never gets silently rewritten. The target enforces one outbox event per alert generation. Typical old `last` objects omit generation and snapshot fields; these remain intact in the manifest rather than occupying a fabricated generation. History-only metadata is not currently shown as native delivery history by the existing API.

Quota includes attempts, not just successes. Import and uncertain recovery do not send or increment quota. Imported already-used quota may exceed the new daily limit and remains conservatively exhausted. Global import uses `max(existing,source)`; for multiple independent legacy producers, plan combined quota accounting separately rather than assuming this single-source tool sums their usage.

## Offline Cloudflare / D1 preparation

No Cloudflare resource or credential is required for this command, and it makes no network connection:

```sh
node --import tsx scripts/migrate-legacy.ts \
  --target cloudflare --dry-run \
  --source-id old-worker-production \
  --owner-id EXISTING_AUTH_USER_ID --owner-email owner@example.com \
  --snapshot /private/legacy-state.json

node --import tsx scripts/migrate-legacy.ts \
  --target cloudflare --stage /private/legacy-d1.artifact.json \
  --source-id old-worker-production \
  --owner-id EXISTING_AUTH_USER_ID --owner-email owner@example.com \
  --snapshot /private/legacy-state.json
```

For encrypted channels during staging, explicitly provide the new key in `ENCRYPTION_KEY` and the separate `--channel-file`. The artifact contains parameterized D1 statements, expected row counts, schema checksum guards, the fingerprint, migration metadata, and a SQLite-only rehearsal SQL string. This is an **offline plan**: the CLI cannot validate an owner in a nonexistent D1 target and labels validation as deferred. It has no remote execution option and does not invoke Wrangler.

Do not feed the rehearsal SQL directly to `wrangler d1 execute`, execute individual statements, or expose the artifact over HTTP. Cross-statement rollback matters. When a new D1 installation exists, an explicitly authorized operator may load the trusted private artifact and use `applyD1Artifact(new D1SqlDatabase(bindings.DB), artifact)` within a trusted administrative tool. Its single `atomicCAS` call uses the existing D1 adapter's transactional batch and CHECK assertions to verify exact changed-row counts and rollback on mismatch. Schema checksums, existing verified admin identity, empty target, ID conflicts and limits are validated in that same batch. Alternatively use `importLegacyState` with the bound D1 adapter to obtain normal idempotency and target diagnostics. No generic authenticated/unauthenticated API route is added.

Replaying the raw staged artifact against a populated target fails safely; `importLegacyState` provides the explicit `already_imported` result. Keep the artifact private and intact; its fingerprint describes source state, not a signature for arbitrary SQL. The artifact application helper is exclusively for trusted operator input. Local fixture SQLite rehearsal validates generated SQL syntax, bindings, rows and guards; it is not evidence of a deployed D1 import. No remote D1 execution was tested or performed.

## Final switch and releasing held work

Keep the old live Worker unchanged during preparation. Before an actual production switch, the operator must schedule the source stop, obtain an authoritative final source snapshot, back up the new target, and import into a fresh target. Do not release held work from a snapshot taken while the old system continued delivering: old queued events may have been sent after that snapshot.

Node has an explicit cutover helper:

```sh
node --env-file=/private/new-installation.env --import tsx scripts/migrate-legacy.ts \
  --target node --release-held --confirm-source-stopped \
  --source-id old-worker-production \
  --owner-id EXISTING_AUTH_USER_ID --owner-email owner@example.com
```

This acknowledgement is an operator assertion; the tool cannot verify the old source has stopped. It validates the admin again, requires the held generation-zero settings and an existing channel, enables settings deliberately, updates queued events' settings generation and restores each original retry time atomically. It does not send, rearm, change generations of alerts, or revive uncertain events. A repeated release returns `already_released`. Runtime settings edits or queued cancellations before release cause an error; restore from the target backup or rehearse in a fresh installation instead of resetting migration ledgers manually. Source `running=false`/`config.enabled=false` remain in metadata; the explicit release is the decision to enable monitoring, so skip it when the desired state is still off.

After release, the normal scheduler may expire old queued events under its existing ten-minute max-pending-age policy or apply attempt/quota limits. It never automatically resends an `uncertain` event. A fresh OKX last price may trigger an unlatched rule at inclusive equality (`>=` upper / `<=` lower); historical previous price does not seed polling. If new monitoring should stay off, leave the import held.

For Cloudflare, call the same `releaseLegacyHold` function with the trusted D1 adapter only during a separately authorized cutover. Do not create a public endpoint for it. Test the new login and channel independently with synthetic targets before any final DNS/source switch.

## Validation

```sh
node --import tsx --test test/migration.test.ts
npx tsc --noEmit
```

Tests use synthetic private state and real SQLite migrations. They cover no-write dry-run, owner verification, ID/generation preservation, separate AES-GCM channel encryption, held queues, sending uncertainty, old locks/history, quota max, no-overwrite, rollback, reimport rejection, explicit release, equality trigger behavior, generated D1 SQL guards and private CLI files. Implementation and tests do not read production credentials or mutate production resources.
