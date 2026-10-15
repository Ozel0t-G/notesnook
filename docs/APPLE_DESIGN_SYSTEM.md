# VeyraN Apple Design System — permanent single source of truth

Version: 2026-10-12. Status: REQUIRED development standard after the 2026 redesign. This is a design *contract*, not a static mockup. Source of truth for current behavior remains the actual repo and approved tests. On disagreements between image pixels and preserving functional, native, accessible behavior, choose the latter and document the variance. Do not assume screenshots contain production values or real app states.

## 1. Objectives and non-negotiable principles
- Apple-native, restrained, content-first productivity experience; readable and delightful because interactions are responsive, predictable and consistent — not because the interface has extra translucency.
- Shared identity across iPhone, iPad and current Mac Catalyst, **not identical geometry**: phone touch density, iPad adaptive workspace, Mac pointer/keyboard density.
- Preserve every prior capability and accessible path; hide secondary tools behind relevant **discoverable** menus instead of silently removing them.
- Design changes never modify stored rich-text document styles without explicit user action. Existing custom appearance themes remain supported.
- Light Mode and Dark Mode must be developed and reviewed as a pair from first frame through transient states.

## 2. Visual role taxonomy — no blind hex constants
The live semantic token resolver MUST own these roles, in both appearance modes and each platform:
- `windowBackground` (window root, neutral), `sidebarSurface`, `listSurface`, `documentSurface`, `elevatedSurface`, `fieldSurface`, `toolbarSurface`, `popoverSurface`, `sheetSurface`, `separator`, `selectionFill`, `hoverFill`, `pressedFill`, `focusRing`.
- `primaryText`, `secondaryText`, `tertiaryText`, `placeholderText`, `linkText`, `disabledText`, `accentOnAccent`, `warning`, `success`, `danger`, `information`.
- `appAccent` (interactive affordances ONLY), `editorHighlight` (persisted mark for selected text only), `editorTextColor` (selected text only), `notebookColor`, `taskListColor`.
- Separate optional `systemAccent`, active/inactive Mac selection states, reduced-transparency override, high-contrast override.

### Reference palette — calibrate on device, don't hardcode everywhere
LIGHT suggested neutrals: sidebar `#ECEDEF`, list `#F6F6F8`, document `#FFFFFF`, primary text `#18181B`, secondary text `#64646B`, thin separators `#DDDDE3`. DARK suggested neutrals: sidebar `#252527`, list `#202023`, document `#18181B`, primary text `#F2F2F4`, secondary text `#ACACB4`, separators `#36363A`. Mint app accent example: light `#087C3E`, dark `#86DBA2`. These are design tokens, not magic literals to copy into 30 components. Use appropriate platform semantic/system colors when availability/contrast/appearance calls for them.

**Accent isolation:** recoloring the accent must NOT tint the entire window, list, document, white reading canvas or app surfaces. Avoid the earlier 4–8% accent mixing in neutral surfaces as the default. Custom user-imported themes may have their own authored surfaces; retain them unless the user explicitly chooses the new VeyraN standard appearance.

**Editor text highlight:** separate from app accent. Provide warm, non-fluorescent ORANGE, e.g. a light marker `#F7C88B` or `#FFD39A`, with foreground contrast checked; a suitable dark-mode marker variant selected for readability. Keep existing custom color choices and add user-defined swatches if supported. A color chosen in `Aa > Highlight` only marks the selected text range. A selected app accent in `Settings > Appearance` only modifies UI action/highlight states. These are separate persistence keys and separate APIs. A semantic error color is never overridden by either.

## 3. Platform layout
### iPhone
- Three persistent destinations: Notes, Tasks, Search. Settings opened contextually from account/gear as a sheet; new note/task as contextual action.
- Native-like large titles only at top-level, restrained stack headers on detail screens. Content scrolls under/above system navigation correctly. No keyboard blocking last editable row. Rounded list groups, minimal separators, clearly differentiated titles and previews.
- Editor opens in reading-oriented presentation without auto-keyboard on existing note; direct tap-to-edit must still work. A new note focuses editing. Compact keyboard accessory and contextual Aa/Insert/list actions. Full toolbox discoverable via format and insert menus.

### iPad
- Width-responsive 3-pane layout at wide widths (sidebar → list → document), 2-pane at medium width and 1-pane with true navigation at narrow widths. Decide on **actual window width**, not hardware model or `.isPad` alone.
- Collapsible sidebar, preserved selected notebook/note and scroll positions across widths/orientation/multitasking. Touch minimum targets; pencil interactions supported; hardware keyboard must not cause disappearing toolbar. No phantom bottom inset when tabbar is at top.
- Note content readable at an intentional measure (do not let documents span full screen width). Selected notebook and selected note have distinct hierarchical states.

### macOS (ACTIVE client = Mac Catalyst)
- One compact native NSToolbar, small row densities appropriate to pointer/keyboard, subtle hover/focus/active/inactive window states. Do not re-add a web/editor header underneath native toolbar.
- Sidebar/list/editor have distinguishable semantic surfaces in BOTH appearances; collapsible/resizable columns, no unusably narrow editor. Mac settings use bounded content widths and compact coherent forms; do not inherit giant iPad row metrics.
- Familiar keyboard shortcuts, accessible native menus, context menus and discoverable toolbar customization. Never position a second enormous formatting shelf over document text. User-selected toolbar preset should be respected, not shadowed by permanent hardcoding.
- Current macOS app is Catalyst, NOT the historic Electron client. Existing Notesnook core remains shared; do not rewrite rich-text engine to achieve styling.

## 4. Typography, iconography, spacing and materials
- Use SF-style system UI fonts and SF Symbols/native equivalent where available; editor respects user-defined document font and saved paragraph styles. Dynamic Type and keyboard focus must work. Strong title/body/secondary hierarchy; don't shrink everything indiscriminately.
- Centralize spacing scale and density variants. Reuse safe-area and keyboard inset sources, avoid double padding.
- Layered material only in navigation and overlays, not per row/card and not over long-form reading content. Support Reduce Transparency and Increase Contrast.
- All tappable buttons must have adequate hit target (generally >= 44x44pt on touch); on Mac prioritize compact pointer geometry with sufficient accessibility target.
- Native pressed/hover/focus/selected/disabled/loading/error/success states, not just default screenshots. Use distinct iconography for destructive/urgent statuses.

## 5. Editor accessibility and function parity
- UI MUST expose actions documented in `docs/UI_FEATURE_PARITY_MATRIX.md`: internal note link, external link, editing/removing/opening links; highlights and text colors; lists; headings; inline formats; math/code; table creation/editing/import CSV; images/attachments/handwriting/templates, etc.
- Primary bar intentionally compact. Full documented tool set must be in contextual Aa, Insert, More, toolbar customization or native Format menus with discoverable labels. Platform-specific unavailable tools must be explained rather than silently missing.
- Selected text and caret stay stable across opening popovers, switching format, keyboard show/hide, and undo/redo. One test is not enough; include links to notes with duplicate titles and changed notebook names, plus editor reopen and sync.
- Toolbar customization must either (a) reliably control the visible toolbar on the target platform incl. Mac, with preview/reset/default/minimal/custom, or (b) explicitly explain which independent native toolbar controls cannot be customized and still allow a **working** customization surface for supported actions. No UI inviting users to configure controls that are ignored.

## 6. Assistant panel contract
Mac Assistant is part of the writing workspace, not an unrelated admin dashboard. It must:
- Use semantic Sidebar/Inspector surfaces and consistent text styles, separators and icon roles. Width can be changed/collapsed; must not compress the editor beyond a readable minimum. Persist visibility/width per app policy; keyboard shortcut and menu entry reachable.
- Display AI account as a simple status row. Collapse/mask internal subject/client IDs and do not display secrets or raw tokens. Detailed diagnostics only behind an explicit debug/reveal action, not by default; redact logs/screenshots.
- Present model selection as truthful availability (loading, available, unavailable/error + retry), never falsely promise subscription coverage. Disabled send actions explain why.
- Render notes as sanitized rich text/structured previews, **not serialized HTML source in a tiny text box**. Never execute untrusted HTML. Enforce bounded previews, length indicators, scrolling and copy affordances.
- Separate: current note, prompt/action input, response, and explicit write-back actions; permission/consent scope clear. No note content auto-transmitted. Sending and modifying notes requires user action and confirmation according to capabilities. Large responses must be readable, selectable and scrollable; never expose user document data in logs.
- Follow AGENTS.md security/bridge review gates, test auth failure, network offline, no model, invalid pairing, denied permission, stale note, tool error, cancel and re-login.

## 7. Components + settings: design drift gate
Every new UI feature or edit MUST list its screens and cross-platform states before implementation. Build from shared tokens and existing Apple components. Every setting has a read and write path, runtime consumer, persistence and tests. If nonfunctional, fix or remove with explicit documented migration. Never leave a visible switch that does nothing.

## 8. Required checks for every UI modification
- At least one real build and screenshot for every affected platform, both Light/Dark and app/system opposing appearance combinations.
- Visual comparison to approved references, **with actual data and interaction states**. No synthetic code-rendered screenshots passed off as app runtime.
- Smoke checks for opening an item, editing/saving, returning, selecting in another pane, using keyboard, global search, sync status, list/tasks where touched, a representative settings save/restart.
- Feature parity matrix updated. If a tool has been moved, note the new actual user route (e.g. Editor > Aa > Highlight) and verify it works.
- Tests prove editor highlight doesn't alter chrome, app accent doesn't alter stored note marks, and changing theme doesn't rewrite rich-text content.
- Document implementation exceptions in the design-system file, justify by runtime constraints, and request review if they affect user-visible behavior.

## D2 bounded editor-marker exception (2026-10-13, runtime acceptance pending)
The warm marker uses a single content semantic token pair from `packages/editor/src/extensions/highlight/editor-highlight-tokens.ts`: background #F7C88B, view foreground #18181B. It deliberately uses the SAME authored background in Light and Dark so switching appearance does not rewrite saved rich-text. The foreground is a transient editor-view decoration ONLY when a text run has that exact ordinary opaque hex/RGB marker and no authored foreground. Commands, textStyle attrs, saved HTML/JSON and clipboard serialization retain existing formats; explicit user text colors and custom theme styles are preserved. The editor package has no live semantic content-color resolver for this role: this small dependency-free pair is the one source for its palette and view plugin, rather than adding an appearance/persistence dependency. Any future semantic role resolver must reconcile this pair centrally; never duplicate the literals into tool UI. The fixed foreground/background contrast is approximately 11.5:1; real Light/Dark screenshots remain mandatory before UI acceptance. Marked runs remain readable after caret/selection moves, including quiet reading on the same editor instance. Static HTML/export and readers without the plugin keep inherited foreground CSS, and equivalent rgba/8-digit encodings currently retain baseline behavior; their readability is explicitly OPEN. The initial plugin rebuilds decorations on document-changing transactions and reuses the set for selection-only transactions; large-note incremental optimization is a named performance followup, not a claim of large-document runtime acceptance.
