# Apple-like visual refresh: Notes pilot audit

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
