# Notesnook Apple fork handoff — Tasks & Reminders

Updated 2026-09-24 on branch `test`. Do not merge to `main`, push upstream, or upload to TestFlight without a later instruction. The pre-existing untracked `AGENTS.md` is user work and was not included in this implementation.

## Important history and editor boundary

The earlier Todo Widget approach stored tasks inside the Notes editor and caused a black-editor regression. It was rolled back. This implementation has an independent Task domain. It does not use Note IDs, Note bodies, TipTap nodes, ProseMirror positions, or editor bridge actions. Navigation and old Reminder affordances can open Task screens, but editor internals remain untouched. The ARM64 libsodium XCFramework remains in use; no simulator x86_64 exclusion or Rosetta workaround was introduced.

## Implemented architecture

`packages/core/src/collections/tasks.ts` owns Task and List records, stable IDs, validation, smart queries, RRULE recurrence, completion history, and migration. Each record is a versioned JSON `settingitem` carrier in the existing encrypted sync and backup path. Due dates are local calendar strings (`YYYY-MM-DD`), optional due times are wall times (`HH:mm`), and reminder timestamps are independent. The Task record is authoritative. The official Web App ignores fork Task settings; no bidirectional legacy Reminder projection exists. Normal Notes, Notebooks, attachments, login, crypto, and wire item types are unchanged. Details and compatibility boundaries are in `docs/tasks-architecture.md`.

Legacy Reminders migrate to a deterministic default List and deterministic Task ID. The Task is durably written before the source Reminder is disabled and retained with its original payload. Description and snooze time are preserved; unsupported recurrence modes remain in the legacy store. A stale recurring Reminder rolls forward to its first scheduled occurrence at or after migration while retaining its original series anchor; a future snooze remains active. The migration is versioned, retryable, and invoked at startup, after sync, and after backup import. Completed recurring occurrences remain in history; the next occurrence uses a deterministic schedule-relative ID and is reconciled after interruption. Persisted completion wall date/time makes late-completion catch-up stable after cross-timezone sync.

iPhone and iPad have standalone Task navigation, Today/Scheduled/All/Flagged/Completed, custom Lists, quick add, detail editing, completion, priority, flag, due date and time, separate reminder, and recurrence. iPad uses its own two-pane layout. macOS uses the existing Electron app and renderer, with matching Task navigation, Lists, editor, and actions. It has an in-memory main-process notification schedule so notifications continue while the app is running with its last window closed. With App Lock enabled, desktop and browser Task alerts use a generic localized title; an already scheduled desktop payload is redacted on lock changes and at locked renderer startup.

The iOS WidgetKit extension reads a small Task snapshot from the App Group. Completion opens the app through a validated Task link, persists a narrow account-scoped intent in MMKV, waits for database readiness and App Lock release, and applies the idempotent Task operation. Queued intents expire after 24 hours. App Lock replaces the snapshot with a redacted privacy placeholder containing no Task IDs or titles; logout and account changes clear it. The extension never accesses the encrypted database or Notes editor.

## Validation performed

- Core full suite: 38 files, 578 passed, 1 todo. Includes stale daily/weekly/monthly/yearly migration, interruption/retry, recurrence, date-only/DST, encrypted collector/receiver round trip, and encrypted Task backup/restore.
- Crypto: 23 passed. Editor: 134 passed. Editor-mobile build passed. The editor-mobile Jest suite could not start because its existing environment lacks `@testing-library/jest-dom`.
- Mobile TypeScript passed. Focused Task notification, widget, link, and pending-action Jest suites: 25 passed.
- Final iPhone and iPad `NotesnookRelease` Release ARM64 simulator builds passed with host, Widget, and Make Note extensions; `file` confirmed all three binaries are arm64.
- Packaged Electron Playwright Task and launch smoke: 4 passed. Desktop main-process scheduler Vitest: 3 passed. Web App Lock notification privacy Vitest: 2 passed. Desktop package, renderer, and bundle builds passed.
- iPhone Detox Task smoke passed: Quick Add, completion, and Completed history. iPad Detox Task smoke passed with the two-pane layout and the same Task flow.
- iPhone Detox regression passed on the final ARM64 build: create a new Note, enter content, leave, reopen, and confirm the editor and content remain visible. A simulator screenshot also confirmed the New Note editor is visible rather than black. The existing Note history case passed when rerun alone. The broader legacy Note suite was stopped after two failures; rerunning its Duplicate Note case confirmed the duplicate exists but the test expects `Test note (Copy)` while the app created its current auto-generated timestamp title with `(Copy)`.

## Independent reviews

Claude architecture, migration, security, core/mobile/desktop/widget diff, and mandatory final review gates were performed. Findings led to deterministic IDs, safer migration recovery, Task record isolation, mobile deep-link/App Lock protections, desktop List and legacy-route fixes, widget freshness checks, iOS notification-capacity handling, and removal of redundant Task reconciliation calls. The final review prompted source Reminder retention, description/snooze preservation, recurrence anchor and late-completion fixes, widget privacy placeholder, foreground notification reconciliation, desktop view refresh, and row actions. A follow-up final review found stale recurring legacy migration and desktop App Lock alert exposure; both were fixed with regression tests. Claude confirmed the two blockers closed; its remaining startup privacy hardening suggestion was implemented and tested. Persistent macOS delivery after fully quitting the app and authenticated live Web sync remain unverified limitations.

## Known validation and product limits

- A fully quit macOS app has no OS-level persistent Task reminder delivery. Notifications work while the Electron process remains running, including after its last window closes.
- The Today widget shows a refresh prompt after local midnight or timezone/UTC-offset change until the main app writes a new snapshot. It does not show a stale previous-day list.
- Live server multi-device sync and an authenticated official Web App session were not available for end-to-end testing. Two local encrypted databases passed collector/receiver sync coverage. The official Web App is expected to ignore fork-only settings based on the unchanged wire type and static compatibility audit.
- Generic per-record last-write-wins sync still applies to simultaneous edits of the same Task. Field-level conflict merging is not implemented.
- Notification permission and delivery smoke on a physical device remains unverified; planner tests and ARM64 native builds pass.
- The older Duplicate Note E2E title assertion does not match the current generated-title behavior. It is outside this Task subsystem; Note content save/reopen, history, and duplication creation were observed on the simulator, but the broad Note E2E suite is not green.
