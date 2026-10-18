---
name: Open Alert
description: A signal almanac for server-side crypto price alerts, with instrument-like telemetry, editorial type and live motion.
colors:
  paper: "#f2efe7"
  paper-raised: "#fbfaf4"
  paper-field: "#e7e3d8"
  paper-line: "#d5d0c2"
  paper-text: "#111416"
  paper-muted: "#5f655f"
  graphite: "#090c0e"
  graphite-raised: "#111619"
  graphite-field: "#171d20"
  graphite-line: "#27302e"
  graphite-text: "#f3f0e5"
  graphite-muted: "#9da39d"
  instrument: "#121816"
  instrument-line: "#37423c"
  signal: "#d6ff4f"
  signal-ink: "#4c6b00"
  copper: "#f0a36b"
  amber-ink: "#a25519"
  danger: "#ff8b8b"
  danger-ink: "#a52d36"
appearance:
  default: system
  options: [light, dark, system]
  light-canvas: "#f2efe7"
  light-panel: "#fbfaf4"
  light-instrument: "#171a19"
  dark-canvas: "#090c0e"
  dark-panel: "#111619"
  dark-instrument: "#121816"
  tokens: web/redesign.css
  persistence: explicit choices only
language:
  supported: [zh-CN, en]
  default: first supported client language, otherwise English
typography:
  display:
    fontFamily: 'Sora, "Microsoft YaHei", "PingFang SC", sans-serif'
    fontSize: "clamp(44px, 6vw, 82px)"
    fontWeight: 300
    lineHeight: 1.04
    letterSpacing: "-.065em"
  page-title:
    fontSize: "clamp(36px, 4.2vw, 58px)"
    fontWeight: 300
    letterSpacing: "-.055em"
  section-title:
    fontSize: "16px"
    fontWeight: 500
    letterSpacing: "-.035em"
  body:
    fontFamily: 'Sora, "Microsoft YaHei", "PingFang SC", sans-serif'
    fontSize: "14px"
    fontWeight: 400
  telemetry:
    fontFamily: 'Consolas, "SFMono-Regular", monospace'
    fontSize: "9px"
    letterSpacing: ".08em"
    textTransform: uppercase
  live-quote:
    fontSize: "clamp(48px, 6vw, 78px)"
    fontWeight: 300
    lineHeight: .95
    letterSpacing: "-.075em"
    fontVariantNumeric: tabular-nums
  alert-threshold:
    fontFamily: 'Consolas, "SFMono-Regular", monospace'
    fontSize: "22px"
    fontWeight: 500
    letterSpacing: "-.04em"
rounded:
  control: "10px"
  panel: "20px"
  instrument: "24px"
  mobile-panel: "18px"
  pill: "999px"
spacing:
  desktop-rail: "248px"
  compact-rail: "214px"
  desktop-gutter: "42px"
  compact-gutter: "26px"
  mobile-gutter: "18px"
  workspace-gap: "18px"
  instrument-padding: "32px"
  alert-row-padding: "18px 2px 16px"
components:
  button-primary:
    backgroundColor: "{colors.signal}"
    textColor: "#0b0d0e"
    rounded: "{rounded.pill}"
    padding: "0 18px"
    minHeight: "48px"
  instrument-panel:
    backgroundColor: "{colors.instrument}"
    textColor: "{colors.graphite-text}"
    rounded: "{rounded.instrument}"
  alert-panel:
    backgroundColor: "{colors.paper-raised}"
    textColor: "{colors.paper-text}"
    rounded: "{rounded.panel}"
  dark-alert-panel:
    backgroundColor: "{colors.graphite-raised}"
    textColor: "{colors.graphite-text}"
    rounded: "{rounded.panel}"
  input:
    backgroundColor: "{colors.paper-field}"
    textColor: "{colors.paper-text}"
    rounded: "{rounded.control}"
    padding: "10px 12px"
  nav-active:
    backgroundColor: "var(--selected)"
    textColor: "{colors.paper-text}"
    indicator: "3px acid stripe + measured fill"
  status-chip:
    textColor: "{colors.signal}"
    rounded: "{rounded.pill}"
    padding: "3px 6px"
  switch:
    backgroundColor: "var(--control-border)"
    rounded: "{rounded.pill}"
    width: "44px"
    height: "44px"
  switch-enabled:
    backgroundColor: "{colors.signal}"
  dialog:
    backgroundColor: "var(--popover)"
    textColor: "var(--foreground)"
    rounded: "{rounded.panel}"
    padding: "26px"
---

# Design System: Open Alert

## Overview

**Creative North Star: "Signal Almanac"**

Open Alert is presented as a precision instrument for reading price signals, not as a generic admin dashboard. Warm paper and graphite establish two complementary editions of the same almanac. A dark instrument panel behaves like the face of a monitoring device: gridded, numbered and visibly connected to live exchange data. The surrounding workspace stays quiet so that the quote, rule state and next action remain unmistakable.

The visual system is editorial rather than ornamental. Oversized light-weight Sora headlines, compact monospaced telemetry, a single acid signal color, and copper for latched or uncertain states create hierarchy. Construction lines and orbit diagrams explain the product metaphor: a server-side threshold station that keeps watch after the page closes.

**Key Characteristics:**

- Fixed instrument rail on desktop; compact top utilities and a floating bottom navigation on mobile.
- Warm-paper light edition and graphite-dark edition using the same semantic tokens.
- Acid-lime signal accent, copper latch/warning accent, and explicit words for every state.
- Oversized tabular live quote with a threshold rail showing actual rules and current price.
- GSAP motion tied to real state changes: quote arrival, rail entry, route readiness and measured navigation.
- Official TradingView embed retained unchanged inside a restrained reference-chart panel.

## Colors

Neutral tones carry structure; the acid signal carries live intent. The frontmatter is normative and reflects `web/redesign.css`.

### Primary

- **Acid Signal** (`signal`): Enabled monitoring, fresh quote, active navigation stripe, primary action fill and focus.
- **Instrument Ink** (`graphite-text`): Quote, telemetry values and labels inside the dark instrument.

### Secondary

- **Copper Latch** (`copper`): Triggered rules, stale quotes, lower thresholds and uncertainty.
- **Warm Paper** (`paper`): Light-edition canvas.
- **Graphite** (`graphite`): Dark-edition canvas.

### Semantic

- **Error Rose** (`danger`): Connection and validation failures.
- **Warning Paper / Ink**: Explicit notices that require review without implying failure.

**The State Has Words Rule.** Every color-coded state also has a text label. Freshness, armed/latched state, delivery uncertainty and disabled monitoring are never color-only.

## Typography

Self-hosted Sora is the display and interface face, paired with Microsoft YaHei and PingFang SC for Chinese. Consolas is reserved for telemetry, timestamps, native market IDs and threshold values. The local variable font and SIL OFL 1.1 license ship in `public/fonts/`.

Display type is deliberately light and tightly tracked. Page headings use `clamp(36px, 4.2vw, 58px)` with weight 300. The live quote uses `clamp(48px, 6vw, 78px)` with tabular numbers, so digit changes do not reflow the row. Telemetry labels are 9px uppercase monospace with wide tracking; this is an instrument cue, not body copy.

At 600px, page headings reduce to 38px and the live quote to `clamp(44px, 14vw, 62px)`. Alert thresholds reduce to 20px. User-authored alert names may wrap anywhere. Supporting copy remains at least 10px in compact instrument areas and 11-13px in content panels. Typography inside TradingView remains native.

## Layout

Desktop uses a fixed 248px instrument rail and a fluid content canvas with 42px gutters. At 1180px the rail narrows to 214px and gutters to 26px. The dashboard grid is `minmax(0, 1.65fr) minmax(340px, .85fr)` with an 18px gap.

The dashboard opens with a full-width instrument panel. On desktop it is split into the live quote/rail region and a 286px telemetry stack. The stack reports monitoring state, armed rules, daily notification budget and market-data mode. Below it, the reference chart and alert panel share the workspace row.

At 900px the rail becomes a 70px top utility bar, navigation becomes a floating bottom dock, and the content is single-column with alerts before the chart. The instrument panel stacks its telemetry into a two-by-two grid. At 600px the quote panel uses 20px padding, the chart height is 420px, and touch controls meet the 44px target. At 380px the top utility group tightens and logout becomes an icon-only control with an accessible label.

Chart heights are 540px on desktop and 420px at 600px. The chart panel keeps its own header and market picker; the official embed fills the available chart shell. The fixed mobile dock reserves 108px of bottom padding in the main content.

## Elevation & Depth

Persistent panels are flat and separated by hairlines. The instrument is visually raised by its graphite field, construction grid and acid halo, not by a heavy shadow. The login panel and overlays use `--shadow-deep`; toasts and menus use `--shadow-soft`. Overlays blur the page behind them.

GSAP 3.15 and @gsap/react own motion in `web/motion.tsx`; CSS provides resting states and reduced-motion fallbacks.

- **Page readiness:** heading and instrument clip in over 340ms. Background polling never replays it.
- **Instrument reveal:** telemetry cells and the chart/alert workspace enter in a short stagger once real data is ready; polling never replays it.
- **Live quote:** each real incoming value enters with a short blur-and-rise, direction-aware but never inventing intermediate prices.
- **Threshold rail:** the line draws and a single signal sweep crosses it once per market/rule revision; markers stagger in. Quote changes move the price marker without replaying marker entrances.
- **Navigation:** the measured indicator animates its full box on desktop and mobile. It never stretches a one-pixel painted stripe.
- **Floating surfaces:** reversible 240ms-in/140ms-out timelines; dialog subtrees remain mounted only for their exit.
- **First paint:** one full-screen entrance curtain assembles the brand mark, holds a localized status line while the session and the first snapshot are in flight, then lifts as a single transform. It replaces every page-level skeleton.
- **Loading:** list and chart placeholders breathe, and spinners rotate, only while visible.
- **Pointer signal:** on a mouse device, a soft acid wash follows the pointer across the instrument field. Touch devices and reduced-motion users see the static field.

Reduced motion removes loops and sets controls immediately. Motion never delays focus, form input or a mutation.

## Shapes

Controls use 10-11px radii. Content panels use 20px; the instrument uses 24px on desktop and 20px on mobile. Pills, status chips, switches and the mobile dock are fully rounded. Circles appear only as live-state pips and orbit nodes. The SVG brand is an open angular frame with a threshold pulse and signal square; no raster identity ships.

## Components

- **Instrument rail:** Brand, kicker, route navigation, runtime status, appearance/language, account and sign-out. The active route uses a measured fill plus a 3px acid stripe. On mobile, only the brand and utilities remain in the top bar; routes move to the bottom dock.
- **Signal instrument:** Market identity, source/product chip, native ID, oversized live quote, freshness label, daily attempts, threshold rail and four telemetry cells. The rail plots only real rule thresholds and the current quote.
- **Primary action:** Acid fill, dark ink, pill shape and plus icon. It remains disabled when no selectable market, a request is in flight, or the alert limit is reached.
- **Alert rows:** Rule name and state chip, exact market, direction and threshold, pending/latched copy, last delivery outcome/time, then explicit Edit, Rearm and Delete actions. Latching is never cleared by editing.
- **Monitoring switch:** A square 44px hit area containing the visible track. Enabled uses acid; disabled uses control gray. Confirmation is required to pause all monitoring.
- **Inputs and selects:** Warm field fill in light mode, graphite field in dark mode, visible labels and explicit errors. The MarketPicker remains a searchable command surface with venue/type filters.
- **Dialogs:** Reversible motion, native focus trap, 26px desktop padding and 22px on mobile. Uncertain delivery and already-breached rearm warnings remain visible before confirmation.
- **Chart and feedback:** Official TradingView embed, 4-hour default, native controls and attribution are unchanged. App-level reconnect/fallback copy sits outside the iframe. Toasts announce mutation results.

**The Native Chart Rule.** Preserve TradingView controls and attribution when adapting the surrounding workbench.

## Do's and Don'ts

### Do:

- Do keep the live quote and rule state above decoration in the hierarchy.
- Do pair signal/copper colors with explicit Chinese and English labels.
- Do use motion only for real state transitions and keep it interruptible.
- Do retain keyboard focus, 44px mobile targets and reduced-motion behavior.
- Do retain the original SVG identity and the untouched TradingView embed.

### Don't:

- Don't turn the product into a fictional marketing page with invented customers or metrics.
- Don't use color as the only explanation of monitoring or delivery state.
- Don't replay quote or rail entrances on every 5-second poll.
- Don't load raster replacements for the shipped SVG identity.
- Don't replace, restyle inside, or obscure the official TradingView iframe.

## Shared components and loading

All pages compose shadcn/Radix primitives from `web/components/ui`. Product
patterns in `web/components/Surface.tsx` provide Panel, PageHeader, Notice,
EmptyState, Disclosure, PageError and ListSkeleton. Preserve semantic HTML
for content, links and forms while composing reusable controls and surfaces.
The component README records upstream source and local adaptations.

Session bootstrap and the first snapshot for every workspace route are covered by
the entrance curtain in `web/components/BootStage.tsx`, which publishes a
translated `role="status"` line and never renders a skeleton. The provider keeps
the routes mounted so the session request starts immediately, but gates their
visible output until the logo's frame, signal and node have all formed. The login
view adds a capabilities claim, so an unauthenticated fast response still reveals
a usable sign-in surface only after the brand entrance is readable. Views register
their own `useBootClaim`, so a reload, a session timeout or a sign-out redirect
re-arms the curtain instead of flashing a half-built layout. Reduced motion skips
the formation wait and exposes the settled view immediately. Invitation and account
lists still use ListSkeleton, and the chart uses its own field placeholder. Initial
failures replace the placeholder with a stable retry state. Background refresh
retains existing content. Never fabricate quotes or candlesticks in loading
placeholders.

Light/dark/system preferences are available before authentication and persist
across routes. TradingView receives the effective theme via documented embed
configuration and retains its 4-hour default. Changing theme or language recreates
the official embed; ordinary polling and navigation keep it mounted. Client
language detection supports Chinese and English; an explicit choice takes
precedence. Automatic defaults never write localStorage.

Theme colors change together without independent background/foreground fades.
Canonical shadcn variables own component color; the functional signal color is
separate from the neutral selected surface. `web/redesign.css` imports after
the legacy and component layers and owns the current visual system. Inputs,
menus, dialogs and Sonner notifications share these tokens. TradingView
replaces its embed before paint when theme changes, showing a matching loading
surface until the new official widget has loaded.
