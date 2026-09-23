# Apple-like visual refresh: UI audit

This pass is presentation-only. Existing routes, actions, menu ordering,
editor lifecycle, data models, sync, and PencilKit integration are out of
scope.

| Area | Classification | Styling scope |
| --- | --- | --- |
| Home, notes, notebook, tags and archive lists | Safe to style | Shared list surfaces, separators, typography hierarchy and selection treatment. |
| Search and reminders lists | Safe to style | Reuse list presentation after the Notes pilot is verified. |
| Settings | Safe to style | Grouped rows, section surfaces and separators; preserve order and navigation. |
| App header, side menu and iPad panes | Safe to style | Backgrounds, separators, icon presentation and pane hierarchy only. |
| Sheets, dialogs and context menus | Safe to style | Corner radius, grabber, padding, surface and button hierarchy only. |
| Editor shell | Touch later | Only surrounding surface/header/toolbar styles after list and settings validation. |
| `packages/editor-mobile` and TipTap internals | High risk / do not touch | No lifecycle, command, WebView bridge or editor-content changes. |
| Native PencilKit, attachment and sync code | High risk / do not touch | Existing unrelated work remains unchanged. |

## Pilot: Notes list

The pilot uses active Notesnook theme colors through a small semantic token
layer. It changes only the visual treatment of the existing header, grouped
section separators, note-row selection and note metadata chips. No layout
coordinates, event handlers, hit targets, routes, menus, or data flow are
changed.
