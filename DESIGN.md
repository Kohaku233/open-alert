---
name: Open Alert — Breakout 3a
description: A precise signal instrument from the approved final HTML handoff, with a split-circle identity and event-driven trade trace.
colors:
  charcoal: "#05070a"
  rail: "#07090c"
  panel: "#0a0e10"
  instrument: "#090d0c"
  field: "#07090b"
  popover: "#0b1012"
  line: "#1a2123"
  line-emphasis: "#26302e"
  ivory: "#f3f0e5"
  muted: "#959c94"
  signal: "#d6ff4f"
  trace-head: "#f4ffd2"
  copper: "#f0a36b"
  latch-field: "#241d14"
  latch-line: "#74552f"
  latch-text: "#ffdba8"
  selected: "#1b2419"
  danger: "#ff8b8b"
  light-canvas: "#f2efe7"
  light-panel: "#fbfaf4"
  light-rail: "#e8e4d9"
  light-field: "#f4f2e9"
  light-instrument: "#f4f3e9"
  light-ink: "#111416"
  light-muted: "#545a53"
  light-line: "#d5d0c2"
  light-signal: "#5f7d00"
  light-copper: "#a25519"
  light-danger: "#a52d36"
typography:
  display:
    fontFamily: '"Geist", "Noto Sans SC", "Microsoft YaHei", sans-serif'
    fontSize: "clamp(42px, 4.45vw, 64px)"
    fontWeight: 200
    lineHeight: 1.06
    letterSpacing: ".04em"
  headline:
    fontFamily: '"Geist", "Noto Sans SC", "Microsoft YaHei", sans-serif'
    fontSize: "32px"
    fontWeight: 200
    lineHeight: 1.1
    letterSpacing: ".04em"
  title:
    fontFamily: '"Geist", "Noto Sans SC", "Microsoft YaHei", sans-serif'
    fontSize: "16px"
    fontWeight: 500
    letterSpacing: "0"
  body:
    fontFamily: '"Geist", "Noto Sans SC", "Microsoft YaHei", sans-serif'
    fontSize: "14px"
    fontWeight: 400
  label:
    fontFamily: '"Geist Mono", "Noto Sans SC", monospace'
    fontSize: "11px"
    fontWeight: 400
    lineHeight: 1.5
  index:
    fontFamily: '"Unbounded", "Geist", "Noto Sans SC", sans-serif'
    fontSize: "10px"
    fontWeight: 300
    lineHeight: 1.4
    letterSpacing: ".24em"
  live-quote:
    fontFamily: '"Geist", "Noto Sans SC", "Microsoft YaHei", sans-serif'
    fontSize: "clamp(44px, 4.2vw, 60px)"
    fontWeight: 200
    lineHeight: .95
    letterSpacing: "-.075em"
  threshold:
    fontFamily: '"Geist Mono", "Noto Sans SC", monospace'
    fontSize: "22px"
    fontWeight: 500
    lineHeight: 1.2
    letterSpacing: "-.04em"
rounded:
  control: "12px"
  compact-panel: "18px"
  panel: "20px"
  instrument: "24px"
  pill: "999px"
spacing:
  tight: "4px"
  inline: "8px"
  compact: "12px"
  workspace: "16px"
  panel: "24px"
  desktop-gutter: "32px"
components:
  button-primary:
    backgroundColor: "{colors.ivory}"
    textColor: "{colors.charcoal}"
    rounded: "{rounded.pill}"
    padding: "0 18px"
    height: "44px"
  button-primary-hover:
    backgroundColor: "#dad8cf"
    textColor: "{colors.charcoal}"
  button-outline:
    backgroundColor: "transparent"
    textColor: "{colors.ivory}"
    rounded: "{rounded.pill}"
    padding: "8px 16px"
  button-text:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    padding: "0"
  input:
    backgroundColor: "{colors.field}"
    textColor: "{colors.ivory}"
    rounded: "{rounded.control}"
    padding: "10px 12px"
    height: "44px"
  panel:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ivory}"
    rounded: "{rounded.panel}"
    padding: "{spacing.panel}"
  nav-active:
    backgroundColor: "{colors.selected}"
    textColor: "{colors.ivory}"
    rounded: "{rounded.control}"
    padding: "0 13px"
    height: "46px"
  state-chip:
    textColor: "{colors.signal}"
    rounded: "{rounded.pill}"
    padding: "3px 7px"
    typography: "{typography.label}"
  signal-instrument:
    backgroundColor: "{colors.instrument}"
    textColor: "{colors.ivory}"
    rounded: "{rounded.instrument}"
    height: "248px"
  dialog:
    backgroundColor: "{colors.popover}"
    textColor: "{colors.ivory}"
    rounded: "{rounded.instrument}"
    padding: "28px"
    width: "560px"
---

# Design System: Open Alert — Breakout 3a

## Overview

**Creative North Star: "Breakout 3a — the signal instrument"**

Open Alert is an operating instrument for exchange-price alerts. Its approved world is the final Breakout HTML handoff: a split-circle SVG mark, charcoal fields, a thin trade trace, compact operational labels and calm, very light headings. The quote, monitoring state and rule actions carry the hierarchy. The English page indexes and dotted signal field are deliberate parts of this user-approved world.

This replaces the previous Signal Almanac identity. Design authority is the README and final HTML/SVG files in F:/code/design_handoff_openalert_final/. The implemented source of truth is the final cascade in web/breakout.css, web/alignment.css, web/login.css, web/boot.css and web/fonts.css, together with the shipped React components. web/redesign.css supplies inherited primitives and light appearance; it is no longer the visual authority by itself. Dark appearance follows the supplied reference. Light and system appearance remain supported through semantic tokens; the light edition is a functional adaptation, not a claim of a second supplied reference.

**Key Characteristics:**

- Split-circle Breakout SVG identity with displaced upper and lower halves.
- Charcoal and ivory structure; lime signals state and copper signals a lower threshold, pause, latch or warning.
- Geist and Noto Sans SC interface, Geist Mono telemetry, and restrained Unbounded page indexes.
- Fixed desktop rail, a three-column signal instrument, and a separate mobile alerts route.
- Real trade sampling moves the trace; boot and loading motion report actual lifecycle state.
- Existing alert, authentication, accessibility and notification constraints remain visible.

## Colors

The dark reference uses near-black tonal separation and warm ivory, with small functional signal accents. Frontmatter records the dark palette and the inherited light palette actually used by the current cascade.

### Primary

- **Ivory:** Primary action fill and important text in dark appearance. Primary actions invert the semantic text/canvas pair in light appearance.
- **Signal Lime:** Armed monitoring, fresh quote, upper thresholds, active-route stripe and focus. The SVG upper half and the handoff's dotted signal field also use this identity color.

### Secondary

- **Copper Latch:** Lower thresholds, paused monitoring, latched or uncertain delivery, and warning text. The latch field, line and text form an enclosed notice rather than a color-only state.
- **Error Rose:** Validation or connection failure, with explicit error language.
- **Light Signal / Light Copper:** Readable counterparts for the adapted light edition.

### Neutral

- **Charcoal / Rail / Panel / Instrument / Field / Popover:** Related but distinct resting surfaces, separated by hairlines.
- **Line / Line Emphasis:** Ordinary structure versus controls and instrument divisions.
- **Ivory / Muted:** Primary reading and secondary operational detail.
- **Selected:** Low-contrast active surface behind navigation and selected segments.
- **Light Canvas / Light Panel / Light Rail / Light Field / Light Instrument / Light Ink / Light Muted / Light Line:** The retained semantic light edition. Use runtime CSS variables so a component changes appearance as a unit.

**The Signal Is State Rule.** Lime is not the primary-button fill. Use it for signal, focus and the approved identity/field treatments; keep primary actions on the semantic text/canvas pair.

**The State Has Words Rule.** Armed, paused, stale, latched, pending and uncertain states require text. Color does not substitute for a state label or delivery outcome.

## Typography

**Display Font:** Geist with Noto Sans SC, Microsoft YaHei and sans-serif fallback.

**Body Font:** The same bilingual stack.

**Label/Mono Font:** Geist Mono with Noto Sans SC and monospace fallback.

**Index Font:** Unbounded for the explicitly approved English page indexes.

Very light, positively tracked headings contrast with stable monospaced measurements. Fonts are self-hosted under public/fonts/breakout/ and declared in web/fonts.css.

### Hierarchy

- **Display:** The desktop login statement uses the display role. It becomes 34px with 1.15 line-height on compact screens.
- **Headline:** Page headings use the headline role, reducing to 28px at the mobile breakpoint. Dialog headings use 28px on desktop and 24px on mobile.
- **Title:** Panel titles use the title role. Notification-card titles use 18px and account/runtime titles use 16px in their final variants.
- **Body:** Interface reading is generally 13–14px; supporting instructions use 12px with comfortable line-height. Small operational labels use the mono label role.
- **Index:** Short English indexes such as “01 — MARKETS · ALERTS” use the index role. Notification subsection indexes use 11px Geist Mono with .12em tracking in the final implementation.
- **Live quote:** The live-quote role has tabular numbers and an inline currency unit. It becomes 48px on mobile; compact desktop variants use 48px or 44px. Long quotes shrink further to fit their real value.
- **Threshold:** Saved rule thresholds use the threshold role; mobile rule rows use 21px.

**The Measurement Type Rule.** Prices, timestamps, quotas and market metadata remain legible and stable. Display formatting bounds quote precision without changing saved thresholds or backend evaluation values. User-authored names and account identities wrap rather than disappear.

The compact boot signature currently uses a 9px index. This exception in the shipped source is not a reusable minimum-size rule; new operational labels should follow the 11px label role.

## Layout

Desktop has a fixed rail (232px), a fluid main area with 24px vertical and 32px horizontal padding, and a compact page header. The rail contains brand, routes, one runtime-status line and an account chip. The account chip opens an upward menu with identity, account/notification links, appearance, language and sign-out.

The first dashboard instrument is 248px high. Its columns are 330px, a fluid trace, and 264px telemetry. Beneath it, the reference chart and alert list form a fluid column plus a 380px alert column with a 16px gap. The chart shell uses clamp(330px, calc(100dvh - 490px), 520px). Alert rows scroll inside their desktop panel.

At desktop widths through 1250px, main padding becomes 24px, instrument edge columns become 280px and 220px, and the alert column becomes 340px. Through 1100px the instrument edge columns become 260px and 190px.

At 900px and below, the fixed rail becomes a 64px top bar. A 64px floating dock, inset 20px from either side, provides Markets, Alerts, Notifications and Account. Main content reserves 112px below content. The instrument stacks market/price, a 120px trace and three telemetry cells. The trace reserves an 84px right gutter, with current-price labels bounded to 78px. Markets shows compact current-market alert summaries and an explicit chart expander; the chart is closed initially. The /alerts route supplies the full list and actions. Mobile chart height is 380px.

Settings use two-column desktop panels and a single mobile column. Account puts identity and textual preferences beside runtime health; mobile leads directly with identity, hides the branded top rail, starts content at 24px and reserves 128px bottom clearance. All account panels stretch to the full available width. The runtime heading is the mobile details toggle above five compact status rows; it does not add a separate disclosure row. Notifications uses separate channel and delivery cards on desktop, with summary-first mobile cards and reachable edit forms. Admin begins with three summary cells plus five health indicators; secondary diagnostics are expandable.

Desktop login uses a full-height split with a 520px form region, reducing it to 460px on compact desktop. At 1440px, its 56px gutters place the statement at y160 and the 407px form card at x977/y174. The form uses 30px/28px padding, 16px spacing, 48px controls, and a 20px radius; help and privacy sit below the card. Dots cover the introductory column while the trace has an independent 260px band at y420. Mobile stacks the 34px statement, compact exchange caption and full-width form, with scrolling for OTP, errors and expanded help. Dialogs are centered at 560px maximum on desktop and become bottom sheets with safe-area padding on mobile.

## Elevation & Depth

Resting content is flat: tonal layers, hairlines, a restrained dotted field and a one-pixel instrument top highlight establish depth. The trace has a narrow bright head over a fading area. It does not use a broad ambient glow to create hierarchy.

Floating surfaces use purposeful shadows: the account menu uses 0 24px 60px #0009, the dialog uses 0 32px 100px #0008, and the mobile dock uses 0 12px 40px #0004. Inherited toast/menu primitives retain semantic soft/deep shadows appropriate to their appearance. Focus uses a visible signal outline; focused fields add a three-pixel low-opacity signal ring.

**The Tick Owns Motion Rule.** A distinct exchange trade advances the trace, updates its current-price guide and releases one endpoint ripple. Repeated polling snapshots do not invent a new trade. Changed quote digits flash toward lime or copper for 0.9s. The guide follows over 0.6s and the ripple completes once over 1.4s. Resting status pips are static; no decorative sweep or orbit loop belongs to this world.

The claim-driven GSAP boot sequence reveals the dotted field, offsets the mark halves, focuses the wordmark, presents three lifecycle log rows, expands a fine exit line and fades the curtain. A completed claimed stage may produce one mark ripple. Unclaimed stages remain WAIT or finish as SKIP rather than pretending a successful request. Initial route claims and keyed generations retain their lifecycle protection.

Loading can use a one-pixel indeterminate panel segment while work is pending; skeleton rows stay static and reduce opacity by row. Buttons use the existing braille spinner only while busy. Reduced motion removes the trace ripple, digit flash, guide transition and loading-segment animation, and settles boot formation without the decorative wait. Shared control/route transitions stay interruptible and never delay a mutation.

## Shapes

The supplied mark uses a 48-unit SVG grid. A circle is split at the horizontal threshold: the upper path is translated right and up, the lower path left and down. Preserve its path geometry and the lowercase openalert wordmark; do not substitute the previous angular identity.

Instrument and dialog surfaces use the instrument radius; ordinary desktop panels use the panel radius. Compact cards use the compact-panel radius, controls and desktop navigation use the control radius, and primary actions, state chips and direction segments use the pill radius. The floating mobile dock uses a 20px outer radius and 14px item radius. Hairlines and restrained dividers carry grouping; avoid decorative framing around every row.

## Components

### Buttons

Primary actions are ivory pills in dark appearance and invert in light appearance. They have dark ink, medium/semibold text, no resting shadow and a 44px minimum target. Desktop create-alert uses 18px horizontal padding. Hover changes the neutral fill without a lift. Secondary controls use a fine control border; inline row actions use quiet text. Disabled state retains the shared primitive's semantics and visible reduced opacity.

### Inputs / Fields

Inputs and market selectors use the field surface, a control hairline and the control radius. Inputs are at least 44px high; the target-price input grows to 56px and uses 26px display numerals. Focus changes the border to signal and adds the restrained ring. Keep desktop labels, validation text, exact market identity and keyboard access. Compact mobile fields retain accessible labels while the selected value and placeholder carry the visible context. Market selection leads with the pair, then venue and product; search and venue/type filters remain available.

### Navigation

The desktop active route is a selected fill with a measured 3px signal stripe. Existing indicator motion moves the full measured box. Mobile routes use the dock's selected item fill. Preferences have icon segments in the desktop account menu and explicit text segments on the account page. Theme and language are persisted preferences; automatic defaults do not write explicit choices.

### Chips / State Notices

State chips are compact mono pills. Armed state uses signal; latch and uncertainty use copper. A triggered row adds an enclosed copper latch notice and exposes rearm. Keep pending, failed and uncertain delivery language visible with its current action restrictions. Rule editing does not release a latch.

### Cards / Containers

Cards group content with tonal fill, a hairline and the established radius. Settings panels normally use 24px internal padding; mobile settings use 20px unless a compact summary establishes 16px side padding. Account identity and notification connection information use bordered subgrids. Runtime health displays five labelled rows; diagnostics disclose detail without replacing the summary.

### Signal Instrument

The left region holds the exact market selector, real quote and trade time; the middle contains the session trace and enabled thresholds; the right contains the sole global-monitoring control, armed/latched counts and notification usage. The monitoring label and switch share one control area. Pausing retains the existing confirmation path.

The trace accumulates at most 90 observations in the current page session and resets when the market changes. It deduplicates non-increasing exchange timestamps; when timestamps are absent, an unchanged price does not create another point. It is not a historical-price endpoint. Up to six enabled thresholds are plotted. Empty state stays “ACQUIRING SIGNAL”; no fabricated history is drawn.

### Alert List / Mobile Summary

Desktop combines scope segments, count, identity, threshold, distance, outcome and text actions in one panel. Full edit/delete/rearm actions live on alert rows. Mobile Markets keeps a compact summary leading to /alerts; the full alert route retains all operations and uncertainty text. Queue/sending locks, tenant ownership and revision/CAS behavior stay preserved by the existing model and dialogs.

### Login / Boot / Loading

The login signal illustration is a static, aria-hidden identity treatment, not a live price claim. Its broad trace uses 90 densely sampled, low-amplitude schematic points and a 1.4px non-scaling stroke. Its three exchange quote slots use labelled placeholders because /api/quote requires a session. Email-code and Google paths retain capability checks, retry/uncertainty copy and safe session lifecycle.

Boot rows describe session, workspace and price claims. Route output is gated by the existing entrance mechanism; completion follows the timeline and active claims. Background polling retains content rather than replaying a full-screen entrance. Initial failures become stable retry states, and loading never supplies invented values.

### Reference Chart

TradingView remains the display-only official embed, with native controls and attribution. The app owns its surrounding panel, supported market mapping, effective-theme configuration, loading/fallback language and mobile disclosure. Preserve the established 4-hour default and mounted lifecycle across settings navigation.

**The Native Chart Rule.** Do not hide attribution, restyle inside the iframe, or imply that chart drawings create server-side alerts.

## Do's and Don'ts

### Do:

- Do use the supplied Breakout split-circle SVG, final font roles, explicit English indexes and dotted signal field.
- Do keep primary actions on the semantic text/canvas pair and reserve signal/copper for their established meanings.
- Do show actual market identity, freshness, monitoring state and delivery uncertainty in words.
- Do drive the trace from distinct observed trades and label its current-session scope.
- Do retain complete mobile, keyboard and reduced-motion paths, including /alerts and notification edit forms.
- Do use semantic CSS variables so retained light/system appearances remain coherent.

### Don't:

- Don't restore Sora headings, the angular mark, lime primary-button fills or orbit decoration from Signal Almanac.
- Don't add idle signal loops, timed fake ticks, invented login prices or prefilled historical trace data.
- Don't round or alter saved thresholds and backend prices to fit a display.
- Don't clear latches on edit, bypass queued/sending restrictions, or describe uncertain delivery as confirmed success.
- Don't let a mobile summary hide the route or form needed to complete an operation.
- Don't replace or obscure the official TradingView controls and attribution.

## Final handoff alignment

At 1440×900, the desktop rail is 232px wide; the workspace starts at x264. The chart and alerts form 748px / 16px / 380px columns and finish at y876. Chart status and reconnect share the attribution footer. Settings panels fill the same bottom edge. Admin uses equal columns, an inline invitation field and a diagnostic disclosure anchored in the account-list area.

Mobile uses 12px page and dock insets, a 52px market header and a 64px dock. Settings and full-alert routes lead with their own heading. The mobile monitor switch has a 36×20px track and a 16px thumb inside a 44px touch target. Mobile trace labels compact the threshold, while exact thresholds remain visible in the rule list and editable form; the desktop trace retains the full current-price guide.

The alert editor has a full-width market selector, compact desktop shortcuts inside the price field, four mobile shortcuts and an unboxed distance gauge. The current-price mark is fixed at 69%; positive target distances map to its right and negative distances to its left. Numeric values are never rounded to fit the reference.

Desktop login keeps its 920px / 520px split and 407×484px access card at x977/y174. Mobile moves the schematic trace below the venue line and removes redundant visual label/divider space while preserving email, OTP, error, help and reduced-motion flows.
