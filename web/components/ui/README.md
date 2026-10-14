# Shared UI

These are actual shadcn/ui `new-york` registry components, imported from
`https://ui.shadcn.com/r/styles/new-york/<component>.json`, using Radix UI,
cmdk, Sonner, Lucide, class-variance-authority and Tailwind CSS 4.

`components.json` defines the component location. `web/ui.css` maps the
existing workbench tokens to shadcn and styles the actual component states.
Tailwind Preflight is omitted to preserve the established document layout.

Local adaptations: relative ESM imports; stable data-slot attributes; neutral
outline buttons by default; localized dialog close action with a busy lock;
fixed dark Sonner theme (the app supports one theme and zh-CN/en languages).
Dialog centering and switch-thumb movement use one transform each; Tailwind 4's
independent translate property must not be combined with a second CSS transform.
Dialogs, selects, checkboxes and switches retain Radix focus and keyboard
behavior. MarketPicker composes Popover + Command, preserving canonical market
identity, disabled results, search limits and server-side availability checks.

Upstream shadcn/ui code is MIT licensed: https://github.com/shadcn-ui/ui.
