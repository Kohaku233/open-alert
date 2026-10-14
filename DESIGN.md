---
name: Open Alert
description: A compact dark workbench for personal price monitoring.
colors:
  bg: "#111111"
  surface: "#171717"
  field: "#202020"
  line: "#333333"
  text: "#ededed"
  muted: "#a3a3a3"
  accent: "#b6f36a"
  amber: "#f1bd72"
  danger: "#ffb4b4"
  control-border: "#555555"
  secondary-hover: "#292929"
  primary-hover: "#ccc"
  selected-language: "#303030"
  dialog: "#1c1c1c"
  warning-bg: "#211d17"
  warning-border: "#705932"
typography:
  display:
    fontSize: "42px"
    fontWeight: 600
    lineHeight: 1.45
    letterSpacing: "-.03em"
  headline:
    fontSize: "26px"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "-.025em"
  title:
    fontSize: "18px"
    fontWeight: 600
    lineHeight: 1.4
  body:
    fontFamily: '"Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif'
    fontSize: "14px"
    fontWeight: 400
  english-interface:
    fontFamily: 'Sora, "Segoe UI", sans-serif'
    fontSize: "14px"
  label:
    fontSize: "12px"
  small:
    fontSize: "12px"
    lineHeight: 1.7
  quote:
    fontFamily: 'Consolas, "SFMono-Regular", monospace'
    fontSize: "27px"
    fontWeight: 600
    lineHeight: 1.1
    letterSpacing: "-.03em"
  threshold:
    fontFamily: "Consolas, monospace"
    fontSize: "20px"
    fontWeight: 600
rounded:
  standard: "6px"
  chip: "4px"
  overlay: "8px"
  switch-track: "14px"
spacing:
  label-gap: "8px"
  action-gap: "10px"
  field-inline: "12px"
  compact-gutter: "16px"
  row-padding: "18px"
  workspace-gap: "20px"
  tablet-gutter: "22px"
  desktop-gutter: "36px"
components:
  button-primary:
    backgroundColor: "{colors.text}"
    textColor: "{colors.bg}"
    rounded: "{rounded.standard}"
    padding: "8px 12px"
  button-primary-hover:
    backgroundColor: "{colors.primary-hover}"
    textColor: "{colors.bg}"
  button-secondary:
    backgroundColor: "transparent"
    textColor: "{colors.text}"
    rounded: "{rounded.standard}"
    padding: "8px 12px"
  button-secondary-hover:
    backgroundColor: "{colors.secondary-hover}"
  button-text:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    padding: "6px 0"
  input:
    backgroundColor: "{colors.field}"
    textColor: "{colors.text}"
    rounded: "{rounded.standard}"
    padding: "10px 12px"
  nav-active:
    textColor: "{colors.text}"
  status-pill:
    backgroundColor: "transparent"
    textColor: "{colors.amber}"
    rounded: "{rounded.chip}"
    padding: "5px 9px"
  settings-panel:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.standard}"
    padding: "25px"
  switch:
    backgroundColor: "{colors.control-border}"
    rounded: "{rounded.switch-track}"
    width: "44px"
    height: "28px"
  switch-enabled:
    backgroundColor: "{colors.accent}"
  dialog:
    backgroundColor: "{colors.dialog}"
    textColor: "{colors.text}"
    rounded: "{rounded.overlay}"
    padding: "26px"
---

# Design System: Open Alert

## Overview

**Creative North Star: "The Black-White Workbench"**

A familiar, compact developer workbench puts precise prices and rule actions ahead of decoration. The user selected the black-white direction and Vercel as its sole visual reference. Near-black canvas, flat charcoal panels, quiet separators and white primary actions define the implemented system.

The original threshold-pulse SVG supplies identity. Restrained lime communicates activity and focus; amber communicates locked states, uncertainty and warnings. Chinese uses the system sans-serif stack, English uses self-hosted Sora, and tabular monospace keeps numeric values stable.

**Key Characteristics:**

- Compact dark surfaces with clear separators.
- White primary actions with restrained semantic accents.
- Self-hosted English type, readable Chinese copy and tabular prices.
- Equal Chinese and English functionality and mobile actions.

## Colors

Neutral tones carry the workbench; semantic colors communicate state. The frontmatter is normative and uses the final application cascade, not the earlier preview palette.

### Primary

- **Workbench White** (`text`): Main text, primary action fills and SVG outline. Primary hover uses the existing softer white.

### Secondary

- **Armed Lime** (`accent`): Armed status, enabled monitoring track, live indicator, active navigation underline and keyboard focus.

### Tertiary

- **Uncertainty Amber** (`amber`): Locked or uncertain states, warning copy and unfinished configuration.
- **Error Rose** (`danger`): Validation and connection errors and destructive emphasis.

### Neutral

- **Canvas Black** (`bg`): Page and chart surround.
- **Panel Charcoal** (`surface`): Alert, settings and login panels.
- **Field Graphite** (`field`): Inputs and selects.
- **Hairline Gray** (`line`): Panel boundaries and row dividers.
- **Quiet Gray** (`muted`): Supporting copy, timestamps and inactive navigation.
- **Control Gray** (`control-border`): Field borders and off switch track.
- **Hover Charcoal / Hover White**: Secondary and primary hover treatments.
- **Selected Charcoal** (`selected-language`): Selected language segment.
- **Dialog Charcoal** (`dialog`): Native modal surface.
- **Warning Charcoal / Warning Edge**: Existing warning container fill and border.

**The State Has Words Rule.** Pair monitoring and delivery colors with readable status labels.

## Typography

Chinese inherits the body stack. English switches the document to Sora, with Segoe UI fallback; the local variable font supports weights 100–800 and uses `font-display: swap`. The font and SIL OFL 1.1 license ship in `public/fonts/Sora-Variable.ttf` and `public/fonts/OFL.txt`. Typography inside TradingView remains native.

The frontmatter records the real role sizes. Display is the login headline; headline is a page heading; title is a section heading. Rule names use body size with medium weight (500). Paragraphs use line height 1.8; small copy uses its separate compact token. Supporting dashboard labels often use 11px rather than the form label size. Quotes and thresholds use tabular numbers; result timestamps use Consolas.

Login display sizes step to 34px at 900px and 30px at 600px. Page headings become 22px at 600px. Quotes remain 27px and thresholds 20px on mobile. Explanatory settings copy caps at 65ch, while login copy caps at 52ch. Preserve wrapping room for English labels and user-written names.

## Layout

The centered application container caps at 1600px with 36px desktop side gutters. The workspace uses `minmax(0, 2.2fr) minmax(340px, 1fr)` and a 20px gap. At 1200px the ratio becomes 1.7fr with a 320px rules minimum. At 900px the workspace and settings/admin grids become single columns, alerts precede the chart, the header navigation occupies a second row, and side gutters become 22px. At 600px gutters become 16px and the quote strip becomes a compact two-column grid. The header navigation scrolls horizontally when needed.

Chart heights step from 510px to 480px at 1200px, 460px at 900px and 400px at 600px. Alerts stop using a capped scrolling list once stacked. Settings/admin layouts retain their 24px desktop gap; the inherited narrow layout uses an 18px gap. Forms use two columns with a 14px gap, then 10px on narrow screens and one column at 380px. Read both stylesheets in import order: `web/styles.css`, then `web/workbench.css`; specific base selectors can still outrank later general rules.

At 600px, buttons have minimum width and height of 44px and fields have minimum height of 44px. The switch uses a 44px square interactive area around a 44px by 24px visible track. Desktop inputs retain a 43px minimum height and buttons a 38px minimum height.

## Elevation & Depth

Flat panels use tonal separation and one-pixel borders rather than shadows. Temporary toasts use `0 6px 32px #0006`; dialogs use `0 20px 80px #0007` with a `#000a` backdrop. These overlays carry depth while the persistent workbench remains flat.

Buttons transition background and border color over 0.16s. The workspace enters with an 8px vertical translation over 0.32s using `cubic-bezier(.16,1,.3,1)`. Reduced-motion preferences remove animation and transitions.

## Shapes

The standard radius governs buttons, form fields, panels and the language-control outline. Status pills use the tighter chip radius; dialogs and toasts use the overlay radius. Dots and switch thumbs are circular. The desktop switch has the extracted track radius; the mobile pseudo-element track uses 20px rounding. The SVG brand is an open angular frame with a threshold pulse and small lime square; the favicon uses the same identity. No raster assets ship in the product.

## Components

- **Buttons:** White primary, outlined secondary and muted text actions. Primary hover softens the white; secondary hover adds a dark fill; text hover brightens and underlines. Disabled buttons use opacity 0.45. Interactive focus is a 2px lime outline with a 3px offset. The primary and secondary padding is recorded in frontmatter; row actions use `4px 0` and chart text actions use the separate text-button padding.
- **Inputs and selects:** Graphite fill, control-gray border, standard rounding, visible labels and explicit errors. Placeholder copy remains muted. Form fieldsets dim when disabled; checkboxes use the existing amber accent and are not rendered as decorative switches.
- **Navigation and language:** Muted inactive links, white active text and a lime underline. The segmented language control fills its selected segment. It exposes only zh-CN and en, uses `aria-pressed`, and saves the language preference while leaving the application state intact.
- **Status pills and rule states:** Compact outline pills summarize settings configuration. Rule states pair a small colored dot with a label; status copy must remain explicit.
- **Panels and rule rows:** Charcoal alert/settings/login panels have hairline edges. Settings padding is 25px on desktop, 22px at 1100px, `21px 18px` in the inherited 760px layout and `22px 18px` at 600px. Alert rows use 20px side margins on desktop, 18px on mobile, and `18px 0` internal padding. Threshold, market, status and last delivery result/time remain attached to each alert. Editing and rearming are distinct actions.
- **Monitoring switch:** Gray off track and lime enabled track, with `role="switch"`, a readable label and `aria-checked`. Desktop dimensions differ from the mobile hit area; keep the mobile track inside its square button rather than stretching the visible track.
- **Dialogs:** Native modal surface for editing and confirmations, 26px desktop padding and 22px at 600px. The close control is inline SVG. Closing restores the prior focus; warning copy explains locked state and immediate trigger conditions.
- **Chart and feedback:** Official external TradingView embed retains native toolbars and attribution. App-level reconnect, fallback and status copy sit outside the iframe. Toasts announce action results using a polite live region.

**The Native Chart Rule.** Preserve TradingView controls and attribution when adapting the surrounding workbench.

## Do's and Don'ts

### Do:

- Do use neutral surfaces and white primary actions.
- Do pair state colors with explicit Chinese and English labels.
- Do preserve prominent tabular prices and readable supporting copy.
- Do retain visible keyboard focus and the implemented mobile touch targets.
- Do retain the original SVG identity and native chart affordances.

### Don't:

- Don't reintroduce the discarded plum or circuit palettes.
- Don't use color as the only explanation of monitoring or delivery state.
- Don't load raster replacements for the shipped SVG identity.
- Don't apply the app font or custom controls inside the external TradingView iframe.
