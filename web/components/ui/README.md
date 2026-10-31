# Shared UI

These are actual shadcn/ui `new-york` registry components, imported from
`https://ui.shadcn.com/r/styles/new-york/<component>.json`, using Radix UI,
cmdk, Sonner, Lucide, class-variance-authority and Tailwind CSS 4.

`components.json` defines the component location. These are locally owned
registry source files, with the adaptations below; they are not an opaque npm
component package. Radix still owns selection, keyboard behavior and focus scopes.
`web/ui.css` maps canonical shadcn tokens to Tailwind utilities.
`web/appearance.css` defines light/dark tokens. `web/app.css` puts legacy product
layouts in a lower CSS layer than shadcn states/variants. Never add a fixed
surface/text color inside a product page, or style raw buttons globally.
Tailwind Preflight is omitted to preserve the established document layout.

Local adaptations: relative ESM imports; stable data-slot attributes; neutral
outline buttons by default; localized dialog close action with a busy lock;
theme-aware Sonner. Card and Alert support Radix Slot composition, retaining
semantic section/aside/paragraph elements without extra wrappers. Spinner is
decorative inside a translated status region. Surface and interactive roots
expose stable data-slot attributes. Upstream source and local adaptations stay
in this folder.
Dialog centering and switch-thumb movement use one transform each; Tailwind 4's
independent translate property must not be combined with a second CSS transform.
Dialogs, selects, checkboxes and switches retain Radix focus and keyboard
behavior. MarketPicker composes Popover + Command, preserving canonical market
identity, disabled results, search limits and server-side availability checks.

Floating components expose their open state to GSAP, retain the actual subtree
for a short reversible exit, and then unmount. Select retains Radix's detached
collection while closed so SelectValue never loses its label. Dropdown focus
returns on semantic close; a delayed animation cannot steal focus later.
DialogPresence retains whole dialogs (including externally controlled editors)
through exit. Outside-click behavior, busy locks and focus traps remain intact.

Shared product patterns in `../Surface.tsx`:

| Pattern | Composition | Use |
| --- | --- | --- |
| Panel | Card + semantic element | Login, chart, alerts and settings panels |
| Notice / FormError | Alert | Inline information and actionable errors |
| EmptyState | Empty | Missing data, empty rules, initial connection failures |
| Disclosure | Collapsible + Button | Monitoring notes and deployment help |
| PageError / ListSkeleton | Card + Empty + Skeleton | Failed first loads and record-list loads |
| PageHeader | Semantic header layout | Consistent titles and actions |

First paint is owned by `../BootStage.tsx`: a full-screen curtain that assembles
the brand mark and holds a localized `role="status"` label until the session
handshake, the first workspace snapshot and sign-in capabilities report ready.
The provider mounts routes immediately so requests can start, while
`useBootVisible` withholds visible product output until the entire entrance timeline
completes and the assembled brand rests for 240ms. This includes the localized word
stagger, subtitle, lock line, note and status, not just the SVG mark. Claims register
before paint (`useBootClaim`); a new claim during an exit creates a fresh keyed stage,
and stale timeline callbacks cannot dismiss it. The entrance plays once per page load:
claims after it has lifted are ignored, so sign-in, retries and market switches use
inline loading states instead of replaying the curtain. The exit is a single transform-only curtain lift, and reduced
motion keeps the resting state without any tween or formation wait.

Use these patterns before adding a page-specific equivalent. Standard text,
links, forms, fieldsets, lists and definition lists retain HTML semantics;
interactive inputs/buttons/selects/toggles/dialogs use shadcn/Radix components.
The external TradingView iframe uses the provider's official embed, with its
documented light/dark theme, locale and 4-hour interval.

Theme preference defaults to the operating system; users can select Light,
Dark or System in the shared header. Browser language defaults to the first
supported zh/en language in navigator.languages, with English fallback.
Only manual preferences are saved. Authentication never uses localStorage.
Canonical theme tokens include background/foreground, card/card-foreground,
popover/popover-foreground, primary/primary-foreground, muted/muted-foreground,
accent/accent-foreground, border, input and ring. `signal` is reserved for
functional green states; it must not be confused with shadcn's neutral accent.
Theme updates suppress color transitions for the changed frame, preventing
old backgrounds from appearing behind new foreground text. Sonner shares the
same popup tokens, including its inline theme variables.

`web/motion.tsx` owns GSAP + @gsap/react hooks. Pages use one bounded readiness
sequence, navigation/tabs use a measured shared indicator, floating surfaces use
reversible timelines, disclosures animate one measured region, and loaders
pause when hidden or outside the viewport. Hooks use scoped useGSAP contexts
and matchMedia cleanup. MatchMedia callbacks use their own context-safe wrapper;
wrapping them in their parent hook's context would create a cyclic context graph.
`web/motion.css` defines resting geometry only. Reduced motion changes state
immediately, keeps feedback text and focus, and disables looping animation.

Upstream shadcn/ui code is MIT licensed: https://github.com/shadcn-ui/ui.
