# Open Alert foundation contract

Scope: new project only. Do not modify or deploy `okx-free-monitor`. This baseline defines contracts and configuration; it does not implement auth, adapters, scheduler, notifications or UI. Dependency versions are exact npm registry versions verified 2026-10-11. Node baseline is >=22.12.0. Runtime entry points and deployment scripts belong to their implementation agents.

## Ownership and module boundaries

- `src/config.ts`: deployment-neutral validated environment and fixed runtime policy. Call once at startup; configuration errors expose field names, never values. Do not log the config object.
- `src/contracts/domain.ts`: domain DTOs and strict request schemas. API handlers must validate bodies at runtime; types alone do not validate JSON.
- `src/contracts/api.ts`: frontend/server response agreement and auth port. The frontend imports types only, never server config, DB adapters or secrets.
- `src/contracts/db.ts`: SQL port, record shapes, repository and scheduler ports. Adapter agent implements `createDb(config, environment): Promise<SqlDatabase>` and repositories. Native SQLite/PG imports stay in Node-only modules; Workers must never bundle them.
- Auth agent owns Better Auth configuration, plugins, Drizzle auth schema, migrations, invitation enforcement, Google and email OTP. Use `@better-auth/drizzle-adapter` 1.7.7 and Drizzle 0.45.4, provider `sqlite` for SQLite/D1 and `pg` for PostgreSQL. Auth Drizzle and app SQL ports use the same physical DB. Explicitly configure unsupported D1 interactive auth transactions rather than pretending they work.
- API agent owns Hono handlers, verified session middleware, ownership, admin permissions, CSRF/origin validation and request limits. Scheduler agent owns shared poller, lease/fencing and durable outbox. Notification agent owns encryption and Pushover. UI agent owns React/Vite and TradingView chart integration.

## Configuration

`loadConfig` accepts `process.env` on Node or Worker string bindings. It defaults to production, Node, SQLite and invite-only. Required: `APP_URL`, `AUTH_SECRET` (>=32 characters), `ENCRYPTION_KEY` (exactly 32 bytes, 64 hex characters or canonical padded base64), `EMAIL_PROVIDER`.

| Variable | Contract |
| --- | --- |
| `DEPLOYMENT` / `DB_DRIVER` | `node` + `sqlite` or `postgres`; `cloudflare` + `d1` only |
| `DATABASE_URL` | Required for PG; `postgres://` or `postgresql://`. TLS policy belongs to adapter; never disable verification globally |
| `SQLITE_PATH` | Default `./data/open-alert.sqlite`; create parent directory and use WAL, busy timeout and foreign keys; production `:memory:` forbidden |
| `APP_URL` | Public origin only, no credentials/path/query/fragment; HTTPS required except localhost/127.0.0.1/::1 in development/test |
| `AUTH_SECRET` / `ENCRYPTION_KEY` | Different secrets; cookie/auth secret and AES-256-GCM storage key respectively |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Optional paired values; absent disables Google and reports capability false |
| `EMAIL_PROVIDER` | `smtp` (Node only), `resend` (Node/Workers fetch) or `console` (development/test only) |
| `EMAIL_FROM` / `SMTP_URL` / `RESEND_API_KEY` | Non-console requires from; SMTP requires smtp(s) URL; Resend requires API key. Auth agent validates sender identity/provider readiness |
| `INVITE_ONLY` | Strict `true`/`false`, default true; enforce on both Google and OTP registration server-side |
| `BOOTSTRAP_TOKEN` | Optional >=32 characters; one-use authenticated bootstrap for an already signed-in user, never persistent admin access |
| `PUSHOVER_APP_TOKEN` | Optional shared server-side application token; each user supplies their own user key and may override with a private application token |
| `PORT` | Node only, default 3000 |
| Limits | Users 1000; alerts/user 20; instruments/user 8; active alerts 2000; global instruments 200; daily notification attempts/user 20. Config validates bounds; repositories enforce quotas atomically |

Cloudflare bindings: `DB` D1, `COORDINATOR` Durable Object namespace, optional `ASSETS`; configuration secrets stored as Worker secrets. Node implementation must not import Workers globals. Set secure, HttpOnly, SameSite=Lax cookies; only validated local development may use nonsecure cookies. Trusted origin is `APP_URL`; no wildcard credentialed CORS. Use Vite `/api` proxy in development and same-origin assets/API in production.

## Database agreement

`query(sql, params) -> rows`, `execute(sql, params) -> { changes }`, `atomic(statements) -> changes[]` are asynchronous. Atomic is ordered and all-or-nothing; zero rows changed is a successful statement, not a rollback signal. No transaction callback is exposed: D1 requires a single `DB.batch(preparedStatements)`. Node SQLite uses one synchronous transaction (`BEGIN IMMEDIATE`), PG one checked-out Pool client with BEGIN/COMMIT/ROLLBACK. On failure every mutation rolls back and the promise rejects. Return one change count per submitted statement, including zero. Normalize safe PG bigint values to numbers; reject overflow. Bind null explicitly; SQL values exclude undefined/booleans (use 0/1).

Canonical application SQL uses `?` placeholders, fixed identifiers and bound user values. PG adapter converts placeholders to `$1...$n` with a lexer aware of strings, quoted identifiers, comments and dollar quotes; never naive regex replacement. Canonical queries cannot use PG `?` JSON operators. Dialect-specific migration/DDL stays outside canonical queries; no SQLite-only `INSERT OR IGNORE` in shared repository SQL.

App migrations are versioned per `sqlite` (also D1) and `postgres`; migration IDs/checksums are recorded. No auto-destructive schema synchronization. App timestamps: epoch-ms INTEGER (SQLite/D1), BIGINT (PG); flags: integer 0/1 in both; IDs: TEXT; JSON: encoded TEXT in both. Auth dates/booleans follow generated Drizzle dialect types and must not be coerced to app-column conventions.

Required app tables, keys and indexes (implementation agent writes actual migrations):

| Table | Required fields / constraints |
| --- | --- |
| `user_settings` | `user_id` PK FK auth user; enabled, disabled, generation, daily_limit, notification_json, created_at, updated_at. New user starts disabled, generation 0 |
| `alerts` | id PK; user_id FK; name, instrument, side, threshold, enabled; generation >=0, triggered 0/1, trigger_id nullable, pending_trigger_id nullable; created_at, updated_at, deleted_at. Index `(user_id,deleted_at)`, active partial index `(instrument,id)` WHERE enabled=1 AND triggered=0 AND deleted_at IS NULL; CHECK pending implies triggered and matching trigger_id |
| `channels` | user_id PK; generation; encrypted user-key JSON; encrypted private-token JSON nullable; updated_at. No plaintext secret columns |
| `outbox` | trigger_id PK; alert_id,user_id FKs; generation, settings_generation, channel_generation; immutable trigger snapshot (instrument,name,side,threshold,price,timestamp,notification_json); phase, attempts,next_at,created_at,updated_at,claim_id,claim_fence; encrypted receipt JSON nullable, code. UNIQUE `(alert_id,generation)`; partial index `(next_at,trigger_id)` WHERE phase='queued' |
| `daily_usage` | `(user_id,utc_date)` PK; attempts >=0, updated_at. Counts actual delivery attempts including tests, atomically |
| `scheduler_lease` | id PK (only `coordinator-v1`), owner_id, fence monotonic, expires_at |
| `invitations` | id PK, normalized email, expires_at, consumed_by nullable, consumed_at nullable; unique active invite policy; never expose bearer invite secrets |
| `app_meta` | key PK, value; bootstrap-consumed flag must be claimed atomically |
| `schema_migrations` | dialect + version PK, checksum, applied_at |

Auth agent generates separate SQLite and PG auth schemas for exact Better Auth + emailOTP plugin configuration: at minimum user, session, account, verification; additional plugin fields/tables follow generated output. Map `user` consistently, then add app FKs. Do not invent a single cross-dialect auth schema or apply app timestamp conventions to auth dates. Better Auth owns auth CRUD; repositories own app CRUD. Soft-delete alerts to retain outbox audit history; user deletion must resolve sending/pending events and credentials before removing foreign-key parents.

### Trigger reservation invariant

Every reservation uses a fresh random `triggerId`, expected rule generation, settings generation, channel generation and current scheduler lease. Never enqueue based on an in-memory hit alone. The adapter MUST run both operations below in the same physical DB atomic batch:

```sql
UPDATE alerts SET triggered=1, trigger_id=?, pending_trigger_id=?, updated_at=?
WHERE id=? AND user_id=? AND generation=? AND enabled=1
  AND triggered=0 AND pending_trigger_id IS NULL AND deleted_at IS NULL
  AND EXISTS (SELECT 1 FROM user_settings s WHERE s.user_id=alerts.user_id
    AND s.enabled=1 AND s.disabled=0 AND s.generation=?)
  AND EXISTS (SELECT 1 FROM channels c WHERE c.user_id=alerts.user_id AND c.generation=?)
  AND EXISTS (SELECT 1 FROM scheduler_lease l WHERE l.id='coordinator-v1'
    AND l.owner_id=? AND l.fence=? AND l.expires_at>?);
-- INSERT includes the immutable snapshot, initialized queued/attempts=0.
INSERT INTO outbox (trigger_id,alert_id,user_id,generation,settings_generation,
  channel_generation,instrument,name,side,threshold,price,timestamp,
  notification_json,phase,attempts,next_at,created_at,updated_at)
SELECT ?,a.id,a.user_id,a.generation,?,?,a.instrument,a.name,a.side,a.threshold,
  ?,?,?,'queued',0,?,?,?
FROM alerts a WHERE a.id=? AND a.user_id=? AND a.generation=?
  AND a.triggered=1 AND a.trigger_id=? AND a.pending_trigger_id=?;
```

All trigger ID placeholders refer to the SAME new ID. Success requires counts `[1,1]`; `[0,0]` means stale/ineligible, return false. `[0,1]` or `[1,0]` is an invariant failure: stop coordinator and report unhealthy. Fresh unique IDs prevent a failed CAS from matching another scheduler's earlier lock. The snapshot price must pass freshness and inclusive threshold test before reservation, and DB guard generations make cached rule/user/channel state invalid after edits. Auth disabled status must propagate synchronously into `user_settings.disabled` before disabling a user.

### Send claim and mutation rules

Before HTTP, atomically serialize quota/claim through a conditional no-op UPDATE of the shared lease row (PG row lock; SQLite/D1 serialized writes), ensure a daily-usage row exists, then CAS queued -> sending with a unique claim ID. Claim requires current unexpired owner/fence, current alert generation + matching trigger_id/pending_trigger_id, enabled user/alert, unchanged settings/channel generation, remaining UTC quota, `next_at<=now`, attempts<3 and age<=10 minutes. Increment outbox attempts and daily attempts only WHERE the NEW claim ID is current. Every dependent statement is guarded; zero changes never grants permission to send. Commit first, issue HTTP once for that claim, then finish with matching claim ID/fence and pending trigger ID. Provider success requires validated response, never only HTTP 200.

Concurrent CAS misses consume no quota. A confirmed provider rejection can queue a bounded retry; timeout, disconnect after dispatch, malformed success or restart during sending becomes `uncertain`, stays latched and is never automatically resent. Expired/quota-blocked events finalize latched. Fence changes invalidate old DB writes. Pushover has no transactional deduplication: an in-flight HTTP request cannot be recalled by a new DB fence; this design prevents blind resend and does not claim exactly-once delivery.

Edit/rearm/delete conflict (409) while that alert is queued/sending. Edits increment generation and preserve latch; rearm alone increments generation, clears latch and trigger_id, retains last result. Deletes increment generation and soft-delete. Settings edits/channel replacement/deletion conflict while any user event is pending; a deliberate disable cancels queued events atomically and leaves sending events uncertain after recovery, never cancels an already dispatched request. Use generation guards in all mutations, quota and limit updates. Owner-scoped queries include `user_id` even when ID is globally unique.

## Rule and scheduler behavior

- Upper hits `last>=threshold`, lower hits `last<=threshold`; level test includes first fresh tick after reconnect. Continuing price/out-and-back does not retrigger a latched rule.
- Positive finite JSON price <=1e12; independent alerts need no upper/lower pair constraint. Instrument must exist in OKX live USDT swaps catalog; regex alone is insufficient. Use `last`, never bid/ask/mark fallback.
- Exchange timestamp <=now+5s, age<=30s; receivedAt<=now, age<=30s. Invalid/stale/missing prices produce no trigger and report feed degradation. Do not return invented tick prices.
- One shared OKX bulk SWAP ticker fetch every 5s for all users; no per-user poller. 5s is a target, not a promise under Worker alarm/network delays. Do not catch up by replaying missed polls. Bounded timeout and watchdog detect delays. TradingView UI chart is display-only; backend OKX price decides triggers.
- Node runs one scheduler process by default and uses DB lease + fence for restart/multiple-process protection. Renew with matching owner/fence; failure/expiry immediately stops new reservations/sends. Acquire/takeover increments fence monotonically.
- Cloudflare uses exactly one DO: `COORDINATOR.idFromName('coordinator-v1')`; alarm polling, no cron-as-5s substitute. D1 holds app/auth/outbox and fences; DO storage is not a second authoritative rule DB.
- Cloudflare defaults: at most 100 evaluations / 4 reservations per tick, 32 due rows / 4 claims / 4 sequential sends per drain. The 2.5s evaluation budget, 25s drain budget, 9s send deadline, 40s lease and SQL quotas still apply; ambiguity stops the batch without replaying that event. Batch size is not a guaranteed throughput or notification SLA.
- Cache only indexed active rules/catalog; refresh at most every 30s and invalidate on local writes where practical. Paginate within configured limits and bound CPU/work per alarm; persist continuation and mark degraded when a cycle overruns. Every reservation and send rechecks DB generations and fence, including user settings/channel changes. Notification retry batches must not starve price polling.
- New settings default `enabled=false`; new alert may be enabled but user must explicitly enable monitoring. No guessed default thresholds. All outcomes including sent, failed, uncertain, expired and capped remain latched until rearm.
- Notify defaults priority 2/retry 30s/expire 1500s/sound siren. Priority -2..2; retry 30..3600; expire 30..10800 and >=retry; sound identifier max64. Emergency receipt is secret and encrypted.

## Credentials and auth

Every user stores their own Pushover user key encrypted. Resolve app token as encrypted private override first, shared `PUSHOVER_APP_TOKEN` second; never accept a recipient user ID or plaintext env token from frontend. AES-256-GCM: fresh random 12-byte IV for each encryption; base64 ciphertext includes authentication tag; AAD binds app version, user ID and field (`userKey`, `appToken`, `receipt`). Envelope defined in domain.ts. Never return decrypted secrets, encrypted blobs or provider receipts in API/logs. Changing the encryption key requires an explicit re-encryption migration, not silent reset.

Better Auth sessions are the source of user ID and role. Never trust body/query/header `userId`. Google and emailOTP registrations both enforce invitation/user limits, verified identities, and disabled-account policy. OTP must be short-lived, stored hashed, rate-limited by normalized email and source, attempt-limited and never returned to browser; console OTP only local dev. Auth agent must pin plugin options supported by 1.7.7 and verify generated schema before runtime.

Bootstrap requires BOTH a verified signed-in session and `Authorization: Bearer <BOOTSTRAP_TOKEN>`, and atomically consumes bootstrap flag only when no admin exists. Subsequent admin calls require verified admin role; bootstrap token does not authorize them. Admin invites are created explicitly; their delivery is separately owned by auth implementation. Missing Google credentials disables Google visibly; missing/invalid production email config prevents startup. Transport failures surface unhealthy/degraded and explicit API errors. External credentials are operator setup tasks for the main agent, never fabricated.

## HTTP and frontend agreement

App response: `{ok:true,data,requestId,effects?}` or `{ok:false,error:{code,message,fields?},requestId}`. Mutations that wake the scheduler report `effects.schedulerWake: 'confirmed' | 'pending'`. A pending effect means the database write committed but wake acknowledgement failed after bounded retries; never replay the mutation automatically. Epoch-ms numbers and nullable timestamps. `/api/auth/*` retains Better Auth's native protocol; frontend uses its official React client. App endpoints listed in `ApiRouteMap`; responses never depend on a frontend-internal shape.

`GET /api/status?include=alerts` optionally includes the tenant's hydrated `alerts` array, sharing the status request's auth/limit checks and alert read. Plain `/api/status` and `/api/alerts` remain supported. The combined read reduces round trips; it is not a cross-SQL/DO transaction. Runtime startup failure returns a retryable 503 from `/api/auth-capabilities`, never a fabricated successful disabled-method response.

| Routes | Authorization / behavior |
| --- | --- |
| `/api/auth/*` | Better Auth Google/OTP/session endpoints; auth agent owns route and origin policy |
| `GET /api/health` | Public minimal health only; no user, infrastructure or secret details; unavailable gets 503 |
| `GET /api/status` | Session required; own settings, quota, safe channel state and runtime health; no other users |
| `GET /api/markets` | Session required; supported live swaps + TradingView symbol and stale flag |
| `GET /api/quote` | Session + strict instrument validation; display-only. Cloudflare resolves availability/freshness and price in one trusted coordinator call; unsupported400, unavailable503. Never adds alert demand or starts sending |
| `GET/POST /api/alerts` | Own alerts; create validates catalog, schema and atomic per-user/global limits; 201 create |
| `PATCH/DELETE /api/alerts/:id` | Own alert; expectedGeneration required; omitted patch values retained; delete JSON body contains expectedGeneration |
| `POST /api/alerts/:id/rearm` | Explicit action with expectedGeneration, never inferred from edits |
| `GET/PUT/DELETE /api/channels` | Own channel; PUT never sends a test. Omitted appToken retains override, null removes override; DELETE removes both credentials |
| `POST /api/test-notification` | Explicit `{confirm:true}` only; rate-limited, counts daily quota, ordinary priority and no automatic emergency test. Return success only confirmed delivery; uncertain/rejection returns error |
| `PATCH /api/settings` | Own monitoring flag/daily limit/notification; expectedGeneration; merge and strict validation then atomic CAS |
| `POST /api/admin/bootstrap` | Session + one-use bootstrap bearer, as above |
| `/api/admin/users`, `/api/admin/users/:id`, `/api/admin/invites`, `/api/admin/status` | Admin role; bounded pagination; changing disabled status revokes sessions/blocks claims; no credential export |

All state changes require trusted Origin (or explicit authenticated non-browser policy), JSON content type where body exists, request size bounds and session middleware. GET never mutates or sends notifications. Disabled users get 403 and hidden resource IDs get 404. HTTP codes: validation400, unauthenticated401, forbidden403, missing404, CAS/pending/limit409, rate-limit429 + Retry-After, unavailable503; provider rejection502 and uncertain504. Delete returns 200 envelope, not an empty 204. No arbitrary URL webhook/provider parameters accepted.

Health aggregation must reflect real DB/feed/lease/provider/email errors, with safe codes and lastSuccessAt. An unavailable component cannot be reported healthy by fallback; cached prices retain original timestamps and show stale. UI must display unavailable/loading/armed/latched/queued/sending and notification uncertainty distinctly, disable Google if absent, and require deliberate channel test and rearm actions.

## Baseline checks and references

Run `npm install`, `npm run typecheck`, `npm run test:foundation`. Future agents add appropriate adapter/rules/auth tests and entry scripts after implementation; this baseline must not advertise runnable monitoring/deployment yet.

Official Better Auth adapter reference read: https://better-auth.com/docs/adapters/drizzle.md. Current adapter is a separate package. npm registry `version`, `engines`, `peerDependencies` were checked for the pinned packages. @types/node intentionally uses latest Node-22 type release 22.20.5, instead of latest Node-26 types. Cloudflare types are imported by type only. `nodemailer` 10 and its latest published types 8 require auth-agent compilation checks; no SMTP transport is implemented in this foundation.
