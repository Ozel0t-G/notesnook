# VeyraN macOS visual audit

## Before

The packaged Electron window used a web style navigation column, flat editor controls, and inconsistent button sizes. Selecting Tasks kept a narrow Task dashboard beside the unrelated Notes editor. Task Favorites used large cards and exposed up, down, and remove buttons in edit mode. List creation and overflow actions appeared as large light rectangles in Dark Mode. Notes, Tasks, and Settings lacked a shared Mac surface hierarchy. Narrow and wide windows left either cramped controls or unused space.

## Implementation

- The existing Electron `BrowserWindow` uses a native hidden titlebar, inset traffic lights, sidebar vibrancy, and `followWindow` visual effects. The Mac renderer uses a matching titlebar region; it does not draw substitute window controls.
- `veyran-mac-shell.css` defines the semantic light and dark surfaces, text colors, separators, selection, focus, radii, spacing, and shadows. Mac styling is gated by the desktop platform class. The official Web App retains its own presentation.
- The global sidebar has a full height source list, selection capsules, hover and focus states, a 50 px collapsed rail, resizable width, a View menu command, and a toolbar action for expansion. Pane dimensions are persisted after resize settles.
- Notes uses a denser list header, Mac search field, row selection, empty state, and grouped editor controls. Editor initialization, schema, command wiring, content save, and note loading were not changed.
- Tasks uses its own source pane, list, and conditional detail inspector. The Notes editor remains mounted for lifecycle safety but is visually covered by the Task workspace. The Notes status footer is hidden in Task mode.
- Favorites are compact source rows with drag ordering and menu alternatives for keyboard users. List and Task actions use context menus. Task rows use separate completion and details buttons. Quick Add and search remain compact on wide displays. Task creation and editing use the existing data model and dialogs with Mac-specific presentation.
- Settings has a Mac-scoped panel, source list, content surface, and control styling. Domain and settings behavior remain unchanged.
- The Mac account screen uses VeyraN product copy instead of the old Notesnook testimonials; official Web App testimonials and service terms remain unchanged.

## Design principles

The sidebar, native titlebar, toolbar, and transient menus carry the depth cues. Task rows, note rows, the editor body, and settings content use opaque, legible content surfaces. List colors remain user choices; global controls use the app accent semantics. Light and Dark Mode have separate surface values. Reduced transparency receives solid surfaces. Motion is limited to hover and state transitions.

The decisions follow Apple's current [Designing for macOS](https://developer.apple.com/design/human-interface-guidelines/designing-for-macos/), [Materials](https://developer.apple.com/design/human-interface-guidelines/materials), [Sidebars](https://developer.apple.com/design/human-interface-guidelines/sidebars), and [Toolbars](https://developer.apple.com/design/human-interface-guidelines/toolbars) guidance. The iPhone/iPad reference informed hierarchy and product identity; Mac layout, density, pointer states, menus, and pane behavior were designed separately.

## Validation and limits

See the September 24 macOS redesign section in `NOTESNOOK_APPLE_HANDOFF.md` for exact build, packaged test, screenshot, and review results. The final packaged TestHarness passed 15 workflow and visual checks. Screenshots are stored under `artifacts/macos-redesign/` and are excluded from the product package. The last visual pass reduced toolbar overflow, reserved the traffic-light gutter only for the inset native titlebar, and presented Task editing as a compact top-attached sheet.

macOS Task reminders still require the Electron process to remain running. There is no AlarmKit integration on Mac. The Task and List data model, encrypted sync, backup, migration, and the Notes editor lifecycle were not changed by this presentation work. An authenticated live Web App compatibility session and physical multi-device sync are separate validation items.

Electron requests native sidebar vibrancy, but the app retains an opaque startup canvas to avoid a launch flash and native window shadow/resize artifacts. The shipped renderer therefore does not claim full wallpaper-sampling Liquid Glass in every sidebar region; its depth is primarily the Mac-scoped material palette and translucent chrome controls. Electron documents that transparent windows are not resizable and lose the native shadow on macOS. A future native-material pass can revisit the tradeoff with device-level visual and performance testing.
