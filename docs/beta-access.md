# Invite beta access

All authenticated, enabled beta accounts receive the Pro feature set. Administrator access is a separate role and is never granted by the Pro plan.

`src/access/policy.ts` is the server authority. Its versioned policy produces `ProductAccess` with `plan: pro`, `phase: invite_beta`, `source: beta_policy`, no expiry and billing disabled. It intentionally does not model a paid subscription or start a trial timer. A later billing integration must explicitly supply a new server policy; it must not derive privileges from browser state.

Existing capacity limits remain in force: alerts and distinct market slots use deployment limits, notification channels allow ten, and market favorites allow fifty. The per-user price-alert attempt quota remains in the existing ledger; notification-source limits remain in the notification center.

`GET /api/account` returns the current user's identity, access policy and measured usage. It uses the normal authenticated, disabled-account and rate-limit guards, accepts no query parameters, and never returns credentials, billing instruments or operator diagnostics. Unsupported runtime-specific counts are null, not a fabricated zero.

`/settings` is the user settings page. `/account` redirects there and preserves the query string. It presents account details, Pro beta access/usage, local browser preferences, notification/monitoring links and a copyable feedback template. Feedback is not submitted automatically.

Runtime component details are on the administrator page. First-deployment administrator bootstrap remains available only through the deliberate `/settings?setup=admin` entry and still requires the verified account, deployment token and server-side bootstrap checks.

No payment checkout, billing schema or automatic beta expiry is enabled by this release.
