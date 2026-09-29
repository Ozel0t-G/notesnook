# Urgent reminders + notification routing — QA report

Current milestone: **bounded alarm-correctness** (per-occurrence delivery exclusivity, honest
unknown native state, independent + generation-guarded account cleanup, documented ActivityKit
conditions), stacked on the earlier **routing/focus hardening + Urgent-only overdue cleanup**.

Source base: `17def76c1e069a72c4b74e9c035a847ff66c286b` (branch `test`), carrying the partial
urgent-reminders feature/test-harness work plus this later bounded milestone. This is **not** the
older `5dc366a0` candidate — that candidate's pass is kept below as HISTORICAL only.

See `docs/urgent-reminders-architecture.md` for behavior and the architecture-recorded overdue
Activity limits; `artifacts/urgent-reminders-qa/` holds the exact re-run commands.

## This milestone's changes (new bytes — NOT covered by the 296/296 result)

| Area | Change | New/changed tests |
|---|---|---|
| Tap routing (`services/task-navigation.ts`) | Minimal intents (`taskId`, `accountId?`, `occurrenceKey?`, `source`); readiness gate over `isAppInitialized`/`isAppLoading`/`appLocked`/`isLoggingOut`; bounded pending-intent queue consumed once after unlock and cleared on logout/account change; wrong-account rejection **before** any Task lookup; accountless legacy policy documented; moved/completed(`includeCompleted`)/missing/stale handling; last-accepted-tap-wins generation; unique `focusRequestId` nonce; never completes/edits/opens the editor. | `services/task-navigation.test.ts` (rewritten, exercises the real exported helpers/handlers) |
| Tasks focus (`screens/tasks/index.tsx`, new `screens/tasks/task-focus.ts`) | `TaskFocusSession`: viewability-gated highlight, bounded retry, bounded deadline, cancel on new intent/list change/unmount; no captured stale index; keyboard dismissed on arrival; `focusTaskId`/`focusRequestId`/`includeCompleted` route params. | `screens/tasks/task-focus.test.ts` (exercises the real session/helpers) |
| Overdue planner (`services/task-alarm-plan.ts`) | `overdueTaskSurfaces()` restricted to incomplete **Urgent** timed Tasks; desired set empties on Urgent-off/reminder-removed/completion/deletion/reschedule so the native reconcile clears the surface; ordinary reminders can no longer consume a surface slot. | `services/task-alarm-plan.test.ts` (updated: normal-reminder expectations corrected, cleanup cases added) |
| Producer payload (`services/task-notifications.ts`) | Every Task notification now carries the owning `accountId` and the `occurrenceKey` so a tap can be validated before any Task read. | covered by `task-navigation.test.ts#taskNotificationIntent` + `task-alarm-plan.test.ts` |

Wiring: `services/notifications.ts` (warm `PRESS`) and `hooks/use-app-events.tsx`
(cold-start initial notification, widget link, legacy `open_reminder` link, unlock consumption,
logout/account-change clearing).

## Bounded alarm-correctness milestone (per-occurrence exclusivity, honest unknown, independent cleanup)

| Area | Change | New/changed tests |
|---|---|---|
| Per-occurrence identity (`services/task-alarm-plan.ts`) | New `taskAlarmKey(task, occurrenceKey)` is the one stable occurrence identity (`series:<seriesId\|id>:<occurrenceKey>` / `task:<id>`) shared by the alarm and the notification fallback; `desiredTaskAlarms()` uses it. | `task-alarm-plan.test.ts` |
| Per-occurrence fallback (`services/task-notification-plan.ts`) | `planTaskNotifications()` now takes `UrgentAlarmFallback` whose `needsFallback(alarmKey)` is asked **per occurrence**; a recurring series with a missing alarm falls back only for that occurrence. A `preserveExisting` mode keeps an existing trigger (and adds none) when the native state is unknown instead of cancelling a working fallback into silence. | `task-notification-plan.test.ts` |
| Native contract (`TaskAlarmModule.swift`, `TaskAlarmModule.m`) | `replaceAlarms` returns `scheduledAlarmKeys` (the per-occurrence truth; `failedTaskIds` is gone). New `verifyAlarms(accountId, alarmKeys)` reports what the system still holds; new `cancelScheduledAlarms(accountId, alarmKeys)` cancels **only `.scheduled`** alarms (never alerting/snoozed/paused). `WantedAlarm` carries `alarmKey`. | `task-alarms.test.ts` |
| Bridge (`services/task-alarms.ts`) | `reconcileTaskAlarmDelivery()` returns `{status, scheduledAlarmKeys: Set, verified}` and resolves an unknown reconcile in tiers: replace → verify → verified cancellation → unverified. New `runIndependentCleanup()` runs every attempt even when one rejects. | `task-alarms.test.ts` |
| Producer/orchestrator (`services/task-notifications.ts`) | Wires the per-occurrence decision; fallback notifications use `strings.tasksUrgentFallbackBody()`; an account-generation guard aborts a stale async pass; account-change/logout cleanup attempts notifications, native alarms and overdue activities independently and logs the failing mechanisms; an already-displayed Task notification created with the real title is withdrawn once App Lock is on. | decision logic covered by `task-alarms.test.ts` + `task-notification-plan.test.ts`; the notifee-side withdrawal and cleanup orchestration are **not** Jest-covered here |

## Current evidence (this milestone — base `17def76c1`)

| Check | Result | Notes |
|---|---|---|
| This milestone's focused Jest suites (`task-alarms.test.ts`, `task-notification-plan.test.ts`, `task-alarm-plan.test.ts`) | **NOT RUN in the worker sandbox** | The isolated checkout has **no `node_modules`** and no npm cache, and no TypeScript/Jest tooling is installed, so the project's Jest suite or `tsc` could not execute here. The new Jest bytes are therefore **not yet run**; every prior result below is bound to older bytes. |
| Local behavioral harness on the **real module bytes** (ad-hoc, not Jest) | **69/69 assertions pass** | Node 24 `--experimental-transform-types` executed byte-identical copies of the product modules with stubbed dependencies in a TMPDIR harness: `task-navigation.ts` **34/34** (readiness gating, no domain read before ready, queue consume-once + clear-on-logout, wrong-account rejection before lookup, accountless policy, payload parsing, pure target resolution, moved/completed/`includeCompleted`/missing/stale, no mutation/editor, last-tap-wins ordering, unique focus nonce), `task-focus.ts` **21/21** (viewability-gated highlight, bounded retry + deadline, cancel on new intent, no stale index, no re-visible re-arm), `task-alarm-plan.ts` `overdueTaskSurfaces()` **14/14** (Urgent-only, ordinary reminders never take a slot, empty desired set on Urgent-off/reminder-removed/completion/deletion/reschedule, lifetime/cap/title). Verified digests: `task-navigation.ts sha256 79b10d12…80eb56`, `task-focus.ts c3937b63…1fa3f198`, `task-alarm-plan.ts d31c7bc7…e5b9fec`. **This is not a substitute** for the project Jest suite (the test files themselves were not executed), and it cannot exercise React rendering, the FlatList, or native code. |
| Mobile jest suite, supervisor-run (PRIOR JS) | **296/296 tests, 33/33 suites, 0 failed, 0 pending** | Command: `npx --no-install jest app/ --runInBand --json --outputFile=<json>` executed from the retained prior checkout's `apps/mobile`. Verified at `/Users/ozel0t/Notesnook/qa/veyran-urgent-reminders/mobile-current-tests.json`. This covers only the **prior** `apps/mobile/app` bytes (`sha256 5502e4bc…3f7dc68`), **not** this milestone's new/changed files. |
| Local behavioral harness on the **alarm-correctness bytes** (ad-hoc, not Jest) | **27/27 assertions pass** | Node 24 `--experimental-transform-types` (with a resolver shim that only appends the missing `.ts`/`.js` extension — the module **bytes are unchanged**, digests below) executed byte-identical copies of `task-alarm-plan.ts`, `task-notification-plan.ts` and `task-alarms.ts` with stubbed `@notesnook/core`, `rrule`, `react-native` and `use-user-store`. Coverage: distinct per-occurrence keys; a mixed recurring series falling back for **only** the missing occurrence; unknown state keeping an existing fallback and adding none; a verified answer cancelling a stale fallback; normal reminders unchanged; `reconcileTaskAlarmDelivery` replace→verify→cancel→unverified tiers and the denied-is-verified case; `runIndependentCleanup` running every step past a rejection. **Not a substitute** for Jest (the test files themselves were not executed). |
| Swift **type-check** of `TaskAlarm/TaskAlarmSurface.swift` + `TaskAlarmModule.swift` | **clean (0 errors)** | `swiftc -typecheck -target arm64-apple-ios26.0 -sdk <iPhoneOS27.0.sdk> -I <React typedef stub> -module-cache-path <TMPDIR>`. The SDK ships `AlarmKit.framework`/`ActivityKit.framework`, so `#if canImport(AlarmKit)`/`canImport(ActivityKit)` **were** compiled: the dumped AST contains 258 matches for `cancelScheduledAlarms`/`OverdueActivity`/`TaskAlarmRepeatIntent`/`alarmId`. Only `React` was stubbed, with the exact `RCTPromiseResolveBlock`/`RCTPromiseRejectBlock` typedefs (`void (^)(id)` / `void (^)(NSString *, NSString *, NSError *)`). This type-checks the new `scheduledAlarmKeys`/`verifyAlarms`/`cancelScheduledAlarms` code against the real SDK, but is **not** a full app/target build (no Pods, no `TaskAlarmModule.m` ObjC expansion, no link). |
| Prior tested mobile source diff | `sha256 5502e4bc8e9ed8ac925ba8ed20885f99f8f727f60d43dd2eae355c7713f7dc68` | Prior JS only; does not cover the routing/focus/overdue changes made in this milestone. |
| Previously failing account suites (`account-logout`, `account-session`) | **repaired, assertions unchanged** | Hoist/mock-initialization fixes; account **production** code unchanged. |
| Mobile TypeScript, full app (`tsc --noEmit`) | **not clean — unresolved** | Remaining errors are dependency/setup/baseline issues (`clipboard.setHTML`, a null ref, swiper, Orama generics). Not run in this milestone (no toolchain). |
| Native iOS build (host, iPhone ARM64) | **NOT PASSED / not re-run** | **This milestone changed native code** (`TaskAlarmModule.swift`/`.m`: `scheduledAlarmKeys`, `verifyAlarms`, `cancelScheduledAlarms`, `WantedAlarm.alarmKey`). A targeted `swiftc -typecheck` against the iPhoneOS27 SDK came back clean (row above), but the full app/target build (Pods, the `.m` ObjC expansion, link, widget target) is **pending** and remains the authoritative check. |
| Physical device QA | **`PHYSICAL_QA_PENDING`** | No physical phone available. |
| Interactive simulator QA | **not yet performed** | Highlights/scroll and the highlight-only-when-viewable behavior are **not** yet visually confirmed; the unit tests exercise the session's decisions, not pixels. |
| Independent candidate review (security / domain / diff) | **pending** | Not performed in this pass. |

## Exact re-run commands (for the host QA tree with dependencies)

```bash
# from apps/mobile, in a checkout with node_modules installed
npx --no-install jest app/ --runInBand --json --outputFile=/tmp/veyran-routing-tests.json
# focused suites only
npx --no-install jest \
  app/services/task-navigation.test.ts \
  app/services/task-alarm-plan.test.ts \
  app/services/task-notification-plan.test.ts \
  app/services/task-alarms.test.ts \
  app/screens/tasks/task-focus.test.ts --runInBand
# full-app type-check (known baseline errors remain; compare against the prior baseline)
npx --no-install tsc --noEmit
```

```bash
# native module type-check (worker-sandbox build; stub only React's promise typedefs)
SDK=$(xcrun --sdk iphoneos --show-sdk-path)      # iPhoneOS27.0.sdk ships AlarmKit + ActivityKit
swiftc -typecheck -target arm64-apple-ios26.0 -sdk "$SDK" -I "$STUB" \
  -module-cache-path "$TMPDIR/vyswiftcache" \
  apps/mobile/ios/Notesnook/TaskAlarm/TaskAlarmSurface.swift \
  apps/mobile/ios/Notesnook/TaskAlarm/TaskAlarmModule.swift
# full native build (host, with Pods) is still required and NOT run here
```

## Bytes under test (alarm-correctness milestone; recompute in the host tree)

`sha256` of the byte-identical copies executed by the local harness (identical to the repository
bytes at the time of the run):

- `apps/mobile/app/services/task-alarm-plan.ts` — `5e3b869ad2cae948a10b4d526aef410ac6d4968d01b3f2e8ca13d6dfa784ae54`
- `apps/mobile/app/services/task-notification-plan.ts` — `3898db40f5ea378c260382fa6ad822d74c4bcd6ba130768380997e86da7a08c8`
- `apps/mobile/app/services/task-alarms.ts` — `f7e88df03051a8fa56a3b3c9d3f3a4894d6e0bb098dccfcbfddea80b57269333`

The Jest test files, `task-notifications.ts` and `notifications.ts` bytes were **not** executed
here (no Jest); the harness covers only the three planner/bridge modules above.

## Current gaps and scope limits

- Engineering is **NOT ACCEPTED** and the release is **NOT AUTHORIZED** for this milestone.
- No screenshots, model-subagent reviews, or new-agent claims are made here. Earlier sessions did
  include a Sonnet-era review and a real-quota reset/resume; that is history only. All latest
  engineering passes were DeepSeek Flash.
- Overdue Activity behavior keeps the app-reconciled limits recorded in
  `docs/urgent-reminders-architecture.md`. Do not describe future/unimplemented behavior: there is
  no guaranteed cold background start, no undismissable alarm, and no volume-behavior guarantee.
- Root-checkout contributions in this pass were limited to supervisor-run byte copy, Git operations
  and deterministic checks.

## HISTORICAL — prior `5dc366a0` candidate pass (superseded; not current evidence)

Kept verbatim as history. Its claims — including "tsc 0 errors", the simulator builds, and the
independent `urgent-specialist` (claude-sonnet-5) review — describe that older candidate on branch
`agent/claude-urgent-reminders` and must not be read as current status.

> Candidate commit: `5dc366a0531315f2646b4fd1a059027d8cba7dd5` (base
> `17def76c1e069a72c4b74e9c035a847ff66c286b`, branch `agent/claude-urgent-reminders`)
>
> - `tsc --noEmit` (apps/mobile, full app): 0 errors (required building `@notesnook/core`, `theme`,
>   `intl`, `common`, `crypto`, `logger`, `editor` from source first — this worktree had no
>   committed `dist`/workspace-linking).
> - `npx jest app/`: 255/262 pass. Every Task/notification suite passed
>   (`task-notification-plan.test.ts`, `task-alarm-plan.test.ts`, `app-intent-requests.test.ts`,
>   `keyboard-dock.test.ts`). The 7 failures were in `account-logout.test.ts`/`account-session.test.ts`
>   — treated as unrelated to that change; ad-hoc `npx jest` invocation because the worktree had no
>   committed mobile jest config.
> - iPhone ARM64 Debug simulator build (`iPhone 17 Pro`) and iPad ARM64 Debug simulator build
>   (`iPad Pro 13-inch (M5)`): BUILD SUCCEEDED, after one `pod install` and prior builds of
>   `@notesnook/ui` and `packages/editor-mobile`'s `build.bundle` WebView artifact.
> - Independent read-only review of the committed diff by `urgent-specialist` (claude-sonnet-5):
>   no blocking findings; one non-blocking line-length nit in `task-notification-plan.ts`.
> - Not performed then either: interactive simulator QA, account Settings/login/logout regression
>   re-verification, physical device QA (`PHYSICAL_QA_PENDING`), and ActivityKit/Dynamic Island/Lock
>   Screen overdue presentation (out of scope, nothing built yet). No screenshots were taken; the
>   legacy navigation reference images at
>   `/Users/ozel0t/Notesnook/qa/veyran-navigation-2026-09-26/` were not consulted.

## Status summary (kept distinct per policy)

- **Engineering**: partial — TypeScript not clean, the focused Jest suites were not run here, and
  the native Swift build is not re-verified. The alarm-correctness pass changed **native** code
  (`TaskAlarmModule.swift`/`.m`), so a host type-check/build against the iOS 26 SDK is now required
  as well as the Jest re-run. **NOT ACCEPTED.**
- **Physical QA**: `PHYSICAL_QA_PENDING`.
- **Release**: `NOT AUTHORIZED` — local implementation/tests/QA only. No push, no `main` merge, no
  TestFlight/App Store submission, no production deployment.
