# UI correction after the settings release

Baseline: `4668eb7`. The user's current corrections override the deployment and notification-health panels in the older self-hosting references.

## Provenance

- `4668eb7` introduced `AdminRuntime`, including the unwanted notification-provider health row, and the settings workspace/feedback panel and supporting prose.
- The deployment panel was retained from the earlier administrator page.
- `226764d` displayed a source switcher below the market picker. `6732ccd` removed that switcher and placed source actions inside the aggregated asset list. The settings release did not change that selection flow.

## Changes

- `web/components/AdminRuntime.tsx`: remove the notification-provider row, new explanatory prose and raw internal codes; retain database, scheduler, prices and email observations.
- `web/pages/Admin.tsx`: delete the deployment configuration card. Its invitation section uses the full available column instead of reserving a second empty column.
- `web/pages/Account.tsx`: remove the entire workspace/feedback panel, clipboard action, beta feature tags, extra prose, per-metric hints and update timestamp. Retain identity, Pro beta badge, numeric usage, refresh, preferences and sign-out. Reuse the existing settings-grid motion path.
- `web/components/AdminBootstrap.tsx`: remove the browser deployment form, including the hidden query-string entry. Server bootstrap authorization is unchanged.
- `web/components/MarketSourceSelector.tsx`: place an exact-market source select below the dashboard asset picker. It uses the existing FieldSelect primitive and the existing underlying grouping, without additional quote subscriptions or automatic source changes.
- `web/components/MarketPicker.tsx`: dashboard asset-only mode shows aggregated assets, favorites and read-only venue names. Exact source actions remain available in the alert editor. Remove the extra bottom instruction paragraph.
- `web/pages/Dashboard.tsx`: render the picker and source select together above the existing live price. Feed selection still uses the exact market identity, so quotes, charts and alert defaults follow the chosen venue/product.
- `web/layout.css`: remove styles for deleted UI, restore 16px settings titles, retain 24px desktop / 18px mobile panel padding and existing semantic colors, and use 11px source labels with 44px controls. Reduce the market/price minimum gap from 20px to the existing compact 12px spacing so the restored source control fits the original 248px desktop instrument.
- `web/locales/en.ts`: remove translations belonging to the deleted settings additions when unused elsewhere.

The price stream, alert evaluation, anomaly rules, notification routing, invitation policy, Pro access policy, quotas and database schema are outside this correction. No new animation or product-help section is introduced.

## Design authority and verification

Use `DESIGN.md`, `F:/code/design_handoff_openalert_final/README.md`, the existing CSS ownership rules and shared GSAP lifecycle. Validate both themes and desktop/mobile layouts. A screenshot pass must include source switching, fixed-height instrument fit and the actual price/chart/alert market identity; HTTP success alone is insufficient.

All testing is assigned to DeepSeek with maximum reasoning effort. The release record records actual checks, limitations and rollback identifiers.
