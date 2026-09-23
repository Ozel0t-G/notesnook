# Apple-like visual refresh: Notes pilot audit

## Major iPhone and iPad pass on `test`

The 23 September mockup is the visual reference. The iPhone treatment now
separates the large page title from the rounded search field, places note rows
on a contrasting grouped background, and gives title, preview and date a clear
reading order. iPad keeps the existing three functional panes while the sidebar,
content list and editor shell receive separate surfaces and quiet boundaries.
Notebook, reminder, search, settings, selection and common sheets use the same
expanded semantic tokens in `apple-visual-tokens.ts`. The iOS styles are gated
from Android in shared components.

The reference image includes home tabs, notebook shortcuts and an editor toolbar
layout that do not exist in the current navigation. They were not introduced:
the route order, actions, editor WebView and PencilKit remain unchanged. This
pass changes presentation only and intentionally does not include a TestFlight
upload. Device screenshots and interaction checks remain pending after the
owner's request to omit tests for this iteration.

### Local visual capture limits

The iPhone 18 Pro and iPad Pro 13-inch simulators launched the redesigned
Debug build. Their local state has no authenticated Notes data: iPhone remains
on onboarding and iPad shows an empty Notes pane with an empty editor. The
simulators also display pseudo-localized strings, making typography comparisons
unreliable. The available captures are stored outside the repository at
`/Users/ozel0t/Notesnook/apple-design-iphone-signed.png` and
`/Users/ozel0t/Notesnook/apple-design-ipad.png`. They verify launch and the
empty-state shell, but cannot demonstrate note cards, notebook rows, Settings,
or a before/after comparison. No account or sample production notes were made.

This pass is presentation-only. Routes, actions, menu ordering, editor
lifecycle, data models, sync, and PencilKit integration are out of scope.

## Render-path evidence

| Visible iPhone area | Rendered component path | Style source | Apple token usage after this pass |
| --- | --- | --- | --- |
| Main Notes screen | `screens/home/index.tsx` → shared `Header` + `List` | `components/header/index.tsx`, `components/list/index.tsx` | Header material/surface/shadow; list background and grouped spacing |
| Notebook, tag, color and monograph notes | `screens/notes/index.tsx` → shared `Header` + `List` | Same shared components | Same visual treatment, with existing accent passed through unchanged |
| Notes list implementation | `List` → `LegendList` → `ListItemWrapper` | `components/list/index.tsx`, `components/list/list-item.wrapper.tsx` | The list shell now owns the visible screen surface; no alternative phone/tablet list implementation is selected here |
| Note row | `ListItemWrapper` → `NoteWrapper` → `SelectionWrapper` + `NoteItem` | `list-items/selection-wrapper/index.tsx`, `list-items/note/index.tsx` | `cardRadius`, `rowInset`, spacing, semantic secondary text and quieter chips |
| Group / section header | `ListItemWrapper` → `SectionHeader` | `list-items/headers/section-header.tsx` | `sectionRadius`, elevated surface, soft separator and shadow |
| Selection state | `SelectionWrapper` plus `useIsSelected` | `list-items/selection-wrapper/index.tsx` | Existing selection state now receives the semantic selected surface; selection actions are unchanged |
| Bottom selection shell | `SelectionHeader` | `components/selection-header/index.tsx` | Elevated surface, soft separator and existing control geometry |
| Top shell / search header | shared `Header` | `components/header/index.tsx` | `materialOpacity`, `buttonRadius`, soft scroll separator and shadow |

## Why build 11 was barely visible

The prior token file was compiled, but its values did not reach the actual
list shell: `List` had no token-driven surface, normal `SelectionWrapper`
rows remained transparent and square, and `rowInset`, `cardRadius`,
`materialOpacity`, and `subtleShadow` were mostly unused by visible iPhone
Notes content. The selection wrapper also only used the selected color for
press feedback and the currently edited note, not the persisted selection
state. This pilot applies the tokens at those real render points.

## Scope guard

No navigation, route, control ordering or geometry, menu trigger/order,
swipe/long-press behavior, list virtualization/scrolling, editor behavior,
save/sync/crypto, Pencil, reminder, or widget code is changed. Existing icon
buttons retain their components and hit slop; row hit slop expands to cover
the new visual insets.
