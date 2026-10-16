# Shared UI

These are actual shadcn/ui `new-york` registry components, imported from
`https://ui.shadcn.com/r/styles/new-york/<component>.json`, using Radix UI,
cmdk, Sonner, Lucide, class-variance-authority and Tailwind CSS 4.

`components.json` defines the component location. `web/ui.css` maps the
workbench tokens to shadcn and styles the actual component states.
`web/appearance.css` owns semantic light/dark tokens, shared loading layouts,
and motion. Never add a fixed surface/text color inside a product page.
Tailwind Preflight is omitted to preserve the established document layout.

Local adaptations: relative ESM imports; stable data-slot attributes; neutral
outline buttons by default; localized dialog close action with a busy lock;
theme-aware Sonner. Card and Alert support Radix Slot composition, retaining
semantic section/aside/paragraph elements without extra wrappers. Spinner is
decorative inside a translated status region. Every primitive has a stable
data-slot. Upstream registry versions and local adaptations stay in this folder.
Dialog centering and switch-thumb movement use one transform each; Tailwind 4's
independent translate property must not be combined with a second CSS transform.
Dialogs, selects, checkboxes and switches retain Radix focus and keyboard
behavior. MarketPicker composes Popover + Command, preserving canonical market
identity, disabled results, search limits and server-side availability checks.

Shared product patterns in `../Surface.tsx`:

| Pattern | Composition | Use |
| --- | --- | --- |
| Panel | Card + semantic element | Login, chart, alerts and settings panels |
| Notice / FormError | Alert | Inline information and actionable errors |
| EmptyState | Empty | Missing data, empty rules, initial connection failures |
| Disclosure | Collapsible + Button | Monitoring notes and deployment help |
| PageSkeleton / ListSkeleton | Card + Skeleton + Spinner | Session, workspace, settings and record loads |
| PageHeader | Semantic header layout | Consistent titles and actions |

Use these patterns before adding a page-specific equivalent. Standard text,
links, forms, fieldsets, lists and definition lists retain HTML semantics;
interactive inputs/buttons/selects/toggles/dialogs use shadcn/Radix components.
The external TradingView iframe uses the provider's official embed, with its
documented light/dark theme, locale and 4-hour interval.

Theme preference defaults to the operating system; users can select Light,
Dark or System in the shared header. Browser language defaults to the first
supported zh/en language in navigator.languages, with English fallback.
Only manual preferences are saved. Authentication never uses localStorage.
Motion is 120–220ms for feedback/entrances, with quieter skeleton breathing;
prefers-reduced-motion disables looping motion and hidden pages pause loaders.

Upstream shadcn/ui code is MIT licensed: https://github.com/shadcn-ui/ui.
