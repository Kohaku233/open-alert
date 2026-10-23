# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Self-hosted operators and invited users who monitor crypto markets across Binance, OKX, and MEXC. They are usually away from the dashboard when a threshold is crossed, so they need confidence that a server-side rule is armed, current, and able to reach their phone. Administrators also manage invitations, account access, and deployment health.

## Product Purpose

Open Alert turns a chosen exchange market and threshold into a one-shot server-side alert. The backend evaluates the exchange's latest executed trade price, latches a trigger until the user explicitly rearms it, and sends the result to Pushover. Success means the user can leave the page, trust the rule state, and act on a timely phone notification without watching a chart.

## Positioning

Unlike chart-only alerts, Open Alert separates display from execution: the TradingView chart is reference-only while the server evaluates the selected exchange's own fresh trade price. It is self-hosted, multiuser, bilingual, and explicit about freshness, delivery uncertainty, quotas, and market identity. The product never pretends that a missing price or an unconfirmed provider receipt is a success.

## Operating Context

Users work from desktop and mobile browsers, usually in short check-ins. They create or edit rules, choose an exact venue/product/pair, enable a global monitoring switch, and review latched or pending delivery states. The dashboard polls status and alerts while visible; quote reads are independent of saved rules. Operators configure deployment secrets, email/Google login, Pushover credentials, and either Node storage or Cloudflare D1 plus a Durable Object.

## Capabilities and Constraints

- Supports Binance, OKX, and MEXC spot and linear USDT perpetual markets.
- Upper rules trigger at or above the threshold; lower rules trigger at or below it.
- Triggered rules remain latched until an explicit rearm.
- Editing a triggered rule does not release its latch.
- Queued or sending deliveries cannot be edited, deleted, or rearmed.
- Delivery outcomes include sent, failed, expired, cancelled, uncertain, and daily limit.
- An uncertain provider result is never automatically retried.
- Monitoring is off by default for a new account.
- The included Cloudflare template starts with small invite-only user, alert, market, and delivery limits.
- The market catalog is static metadata for a workspace session and can be manually refreshed.
- A TradingView chart is display-only and must retain its native controls and attribution.
- The interface supports Simplified Chinese and English, light/dark/system appearance, keyboard access, and a 390px mobile viewport.
- The frontend may import contract types from `src/contracts` only; it must not import server configuration, database adapters, or secrets.

## Brand Commitments

- Product name: Open Alert / 价格哨站.
- Existing bilingual voice is direct, operational, and explicit about uncertainty.
- Preserve the existing semantic SVG identity rather than introducing a raster replacement.
- Preserve equal Chinese and English functionality.
- Inferred from the repository and the current redesign brief: this visual replacement should feel like a premium SaaS product while remaining an operational instrument, not a decorative marketing mock.

## Evidence on Hand

- Product behavior and limits: `README.md`, `CONTRACT.md`, `docs/`.
- API and state contracts: `src/contracts/api.ts`, `src/contracts/domain.ts`.
- Frontend behavior: `web/model.ts`, `web/api.ts`, `web/useMarketQuote.ts`.
- Existing surfaces: `web/pages/`, `web/components/`, `web/legacy/`, `web/workbench.css`.
- Existing self-hosted display font: `public/fonts/Sora-Variable.ttf`.
- No verified customer logos, testimonials, benchmarks, or production claims are present. Future work must not fabricate them.

## Product Principles

1. State must be legible before it is beautiful: armed, latched, pending, stale, and uncertain always have words.
2. The instrument disappears into the task; motion confirms state and direction without delaying an operation.
3. Display data and execution data stay visibly distinct.
4. Failure and uncertainty are first-class states, never hidden behind optimistic color.
5. Every desktop interaction has a complete mobile and keyboard path.

## Accessibility & Inclusion

Keyboard focus must remain visible, controls must have readable labels, status must not rely on color alone, touch targets must remain usable on mobile, and reduced-motion preferences must remove non-essential movement without hiding content.
