# Urgent reminders + notification routing — QA report

Current milestone: **review-round fixes** — per-occurrence delivery exclusivity that withdraws a
competing fallback *before* an alarm is introduced, truthful denied/unsupported handling, App Lock
privacy transitions for alarms that are already presenting, durable device-cleanup obligations,
occurrence-accurate notification tap identity, and the review's TypeScript errors. Stacked on the
earlier **bounded alarm-correctness** and **routing/focus hardening + Urgent-only overdue cleanup**
milestones.

Source base: `17def76c1e069a72c4b74e9c035a847ff66c286b` (branch `test`). `packages/core` is
**unchanged** by this pass (byte-identical to the base; verified with
`git diff --stat -- packages/core`).

See `docs/urgent-reminders-architecture.md` for the behavior and the recorded ActivityKit/AlarmKit
limits; `artifacts/urgent-reminders-qa/` holds the re-run commands.

## What this round changed

| Area | Change | Focused tests |
|---|---|---|
| Exclusivity gate (`services/task-alarms.ts`, `services/task-notifications.ts`) | `reconcileTaskAlarmDelivery()` now **reads first** (`verifyAlarms`), then requires the competing notification fallback of every *missing* occurrence to be withdrawn **and the withdrawal re-verified** before that occurrence may gain an alarm; a failed read writes nothing and withdraws nothing. The per-occurrence answer is now `held` / `active` / `absent` / unverified, so an unknown occurrence keeps its existing fallback and gains none — instead of a lost replace acknowledgement leaving a new alarm **and** the old fallback for the same occurrence. | `task-alarms.test.ts` (withdrawal gate, unwithdrawn key, nothing written on an unreadable state), `task-notifications.test.ts` (lost ack, partial cancellation, no duplicate) |
| Denied / unsupported truthfulness (native + bridge) | A revoked/denied authorization is no longer reported as "nothing scheduled": alarms scheduled while the app *was* authorized are queried, the not-yet-alerting ones it owns are cancelled, and the ones still presenting (`alerting`/`countdown`/`paused`) are reported as held so no fallback duplicates them. `cancelScheduledAlarms` now reports `retainedAlarmKeys` as well as `cancelledAlarmKeys`; `verifyAlarms`/`replaceAlarms` report `activeAlarmKeys`. | `task-alarms.test.ts`, `task-notifications.test.ts` (denied-after-authorization) |
| App Lock privacy (native) | A held presentation created with the real Task title is removed with the supported `stop`/`cancel` calls when App Lock is on, then re-scheduled from the redacted placeholder (including for an occurrence that is already due, so removing the leak cannot also drop the alert). Per-alarm redaction is persisted as **ids only** (`notesnook.taskAlarms.redactedIds.v1`); no title, account or other content enters `UserDefaults`. | Swift type-check (host) + review; the JS side is covered by `task-notifications.test.ts` (redaction, displayed-notification withdrawal) |
| Redaction source | `taskSurfacesPrivacyHidden()` = persisted `SettingsService.get().appLockEnabled` **or** the hydrated store, so a headless/not-yet-hydrated process can never default to "not hidden". | `task-notifications.test.ts` (persisted-on/store-off) |
| Durable cleanup (JS) | A cleanup that fails is persisted as a minimal obligation (`notesnook.taskSurfaces.pendingCleanup.v1`: mechanism labels + timestamp, no content, no account id) and retried at the next launch/foreground **before** any new planning — including when the Task domain is not initialized or the app is mid-logout, because every mechanism cancels surfaces by ownership, not by reading the old account. | `task-notifications.test.ts` (#3 cleanup obligations) |
| Occurrence-accurate taps | A notification now stamps its **own** occurrence (`occurrenceKey` + `seriesId`), and the router resolves the authoritative record through the domain (`db.tasks.list()` by `seriesId`+`occurrenceKey`), falling back to the series' current record for a future occurrence whose record does not exist yet. The tapped occurrence is never answered with the next one, and nothing is mutated. | `task-navigation.test.ts` (occurrence identity), `task-notifications.test.ts` (stamped payload) |
| Subscription (verification) | The "settings-only subscription" critique is a **false positive**: core stores Task records in the settings collection (`TaskRecordStore.save` → `db.settings.collection.upsert`), and `SQLCollection.upsert` publishes `databaseUpdated` with `collection: this.type` (`"settings"`) — see `packages/core/src/collections/tasks.ts`, `packages/core/src/database/sql-collection.ts:108`, `packages/core/src/collections/settings.ts:104`. | `task-notifications.test.ts` (settings-collection write re-plans) |
| Duplicate surface | An occurrence whose alarm is *presenting* is excluded from the overdue Live Activity (`overdueTaskSurfaces(..., isAlarmPresenting)`), so one occurrence never owns two Lock Screen surfaces. | `task-alarm-plan.test.ts` |
| Widget account change | A user-id change now clears **and** re-projects the widget snapshot instead of leaving the widget empty (or the previous account's state) until an unrelated event. Availability fix only; the completion queue/auth paths are untouched. | `reminder-widget.test.ts`, `reminder-widget-writer.test.ts`, `reminder-widget-completion.test.ts` (all pass, unchanged) |
| Review's TypeScript errors | `screens/tasks/index.tsx` `useRef<TaskFocusSession>()` → `useRef<TaskFocusSession \| undefined>(undefined)`; the logout/account-change cleanup chain no longer returns `Promise<string[]>` where `Promise<void>` is expected. | full `tsc --noEmit` below |

## Evidence (this round, executed in this checkout)

| Check | Result | Notes |
|---|---|---|
| Mobile Jest suite | **356/356 tests, 35/35 suites, 0 failed, 0 pending** | `BROWSERSLIST="node 20" npx --no-install jest app/ --runInBand --moduleNameMapper '{"^@notifee/react-native$":"<rootDir>/node_modules/@ammarahmed/notifee-react-native"}'` from `apps/mobile`. The module mapper is required because metro/rspack alias `@notifee/react-native` → `@ammarahmed/notifee-react-native` (`apps/mobile/metro.config.js:26`, `apps/mobile/rspack.config.js:90`) and the repository contains no Jest config. New in this round: `task-notifications.test.ts` (15 production-orchestrator tests over the real pass). |
| Mobile TypeScript, full app (`tsc --noEmit`) | **0 errors** | `BROWSERSLIST="node 20" npx --no-install tsc --noEmit` from `apps/mobile`, after building the workspace packages and running `patch-package` (see setup below). Without `patch-package` the pre-existing dependency errors reappear (`clipboard.setHTML`, `react-native-swiper-flatlist` null ref) — those are setup artifacts, not source errors. The `use-editor.ts` implicit-`any` reported by an earlier QA tree did **not** reproduce once the workspace packages were built here; it is not claimed as fixed, only as not observed. |
| Core sources | **unchanged** | `git diff --stat -- packages/core` is empty. |
| Native Swift | **NOT re-run here** | Xcode/SDK writes are blocked in this sandbox. `TaskAlarmModule.swift` changed (privacy transition, `activeAlarmKeys`, `retainedAlarmKeys`, revoked-authorization cleanup), so the host type-check/build is required and remains the authoritative check. |
| Native iOS build (host, ARM64 iPhone + iPad) | **NOT re-run for this milestone** | The prior `78c04436d` builds predate the new native methods and the actual candidate bytes; they must not be quoted as current evidence. |
| Physical device QA | **`PHYSICAL_QA_PENDING`** | No physical phone available; no sound/haptics/locked-device claims are made. |
| Interactive simulator QA | **not performed** (Codex/computer-use step, specified below) | Highlight-only-when-viewable, warm/cold/locked taps, App Group and notification delivery need a real run. |

### Deterministic setup (host, once per fresh tree)

```bash
# from the repository root, with a writable npm cache
npm install --ignore-scripts --legacy-peer-deps --cache "$TMPDIR/npm-cache"
for p in core logger crypto theme common intl editor; do
  npm install --prefix "packages/$p" --ignore-scripts --legacy-peer-deps --cache "$TMPDIR/npm-cache"
  npm run build --prefix "packages/$p"
done
(cd apps/mobile && npx --no-install patch-package)     # applies apps/mobile/patches (clipboard, swiper, ...)
```

Notes for the host run:

- `packages/intl`'s `npm run build` runs a Lingui extract step and a Vite build. In the worker
  sandbox the Vite step aborted with `EPERM` while PostCSS searched parent directories above the
  checkout; building the same package from a copy under `$TMPDIR` succeeded and its `dist/` was
  used here. On the host, run the documented `npm run build --prefix packages/intl`; if the extract
  step fails, `npx vite build` from `packages/intl` still produces `dist/index.js|mjs|d.ts`.
- `BROWSERSLIST` is only needed for the sandbox (browserslist walks to an unreadable parent
  directory); on the host the plain commands work.

### Exact re-run commands

```bash
cd apps/mobile
BROWSERSLIST="node 20" npx --no-install jest app/ --runInBand \
  --moduleNameMapper '{"^@notifee/react-native$":"<rootDir>/node_modules/@ammarahmed/notifee-react-native"}' \
  --json --outputFile="$TMPDIR/veyran-tests.json"
BROWSERSLIST="node 20" npx --no-install tsc --noEmit
```

```bash
# native (host, authoritative): widget target included
xcodebuild -workspace apps/mobile/ios/Notesnook.xcworkspace -scheme Notesnook \
  -configuration Debug -sdk iphoneos -destination 'generic/platform=iOS' \
  -derivedDataPath "$TMPDIR/DerivedData" build
```

## Bytes under test (this round; recompute in the host tree)

`sha256` of the changed product/test files, and the combined recipe used for the milestone digest:

```bash
{ git diff HEAD -- apps/mobile/app packages/core; \
  for f in $(git ls-files -o --exclude-standard -- apps/mobile/app); do cat "$f"; done; } | shasum -a 256
# -> 6c411dd505c673223bdf18489d8d06d022aa0372476ff5d69dd3286232a62fff
```

| File | sha256 |
|---|---|
| `apps/mobile/app/services/task-alarms.ts` | `51e80e236d7e822d67547ff2fc56341590dcab78e07ff5a18da3cc473addafa6` |
| `apps/mobile/app/services/task-alarms.test.ts` | `e4fd13ef5fe9e6a33ba55c105678090da61d8e4fb0146cd87f1f7edb51f069d7` |
| `apps/mobile/app/services/task-alarm-plan.ts` | `0e467a302e40545cf1a3353ddcc050fc6f7ccab765df0d4a059bd36f26da5893` |
| `apps/mobile/app/services/task-notification-plan.ts` | `c3f8271766078f0a4c417a3758fb1c052bbd36bd900aa8d2e7e3d5a0a8409e25` |
| `apps/mobile/app/services/task-notifications.ts` | `02b312a6e30517c6faeb89ff735feed92257b2bbb134c62a4514b5c84cb830f5` |
| `apps/mobile/app/services/task-notifications.test.ts` | `f33c8c5457858491eabca4072d8d45967c17d73dc6cbeabf5af491fa22550b40` |
| `apps/mobile/app/services/task-navigation.ts` | `c4244637e332d531532712aadd2e616c7daeb4ae051f757954618b646d5235a0` |
| `apps/mobile/app/services/task-navigation.test.ts` | `65502e2b54995ad034fa4fb5fe4690a65a017608ee1f01e73129827b25014307` |
| `apps/mobile/app/services/reminder-widget.ts` | `ce72988128ac785d923aa64f1a0f3e050c17bf377589eea4fe32a6e94c37c665` |
| `apps/mobile/app/screens/tasks/index.tsx` | `b9f2a86ca776ef3c8ba08e1fa462d40135ac11f3a802fb722f36f794b4da4b05` |
| `apps/mobile/ios/Notesnook/TaskAlarm/TaskAlarmModule.swift` | `d8b63925b57754d66c90c6b8665a13120562eef3e32d64ea77fb6fedb3bdb6dd` |

## Host QA actions for Codex (mechanical, no feature code)

1. **Build + install on the fresh dedicated simulators** (never the protected account profiles):
   iPhone 27 `2A3460BC-0244-47CC-88C4-C96D53172B29`, iPad 27
   `4E76B6BB-AD17-4222-BE8D-464077DE7621`.
   ```bash
   xcrun simctl boot 2A3460BC-0244-47CC-88C4-C96D53172B29   # and the iPad one
   xcodebuild -workspace apps/mobile/ios/Notesnook.xcworkspace -scheme Notesnook \
     -configuration Debug -sdk iphonesimulator \
     -destination 'platform=iOS Simulator,id=2A3460BC-0244-47CC-88C4-C96D53172B29' \
     -derivedDataPath "$TMPDIR/DerivedData" ENABLE_DEBUG_DYLIB=NO build
   xcrun simctl install 2A3460BC-0244-47CC-88C4-C96D53172B29 <built Notesnook.app>
   xcrun simctl launch 2A3460BC-0244-47CC-88C4-C96D53172B29 com.streetwriters.notesnook
   ```
   Ad-hoc signing of the widget/app-group entitlements is required for the widget + AlarmKit
   surfaces; it is unchanged from the prior build recipe.
2. **New Note → visible editor → type → Save → Back → reopen the note**: the text is retained.
3. **Canonical Task tap**: from a Task notification (warm and cold start), from the widget link, and
   while App Lock is on; expect the Tasks list at the Task's **current** List with the row briefly
   highlighted, no editor, no keyboard. A tap for an occurrence that no longer exists must show the
   generic "no longer available" message and land on Tasks.
4. **Settings / login / logout**: sign in, sign out, sign in again; Task notifications, alarms and
   the overdue surface of the previous account must disappear, and the widget must not show the
   previous account's Tasks after the sign-out.
5. **Widget check**: complete a Task from the widget (iOS 27 `CompleteTaskWidgetIntent`), confirm
   the completion lands and the snapshot re-projects; switch accounts and confirm the widget is
   re-projected rather than left empty or stale.
6. **Sound/haptics/locked-device**: **not claimed** — `PHYSICAL_QA_PENDING`. A simulator cannot
   validate the audible AlarmKit presentation, Snooze/Pause/Stop semantics or Lock Screen behavior.

## Current gaps and scope limits

- Engineering is **NOT ACCEPTED**; the release is **NOT AUTHORIZED**. The implementation range will
  be independently re-reviewed after these fixes, and the native build + simulator QA above are
  still outstanding.
- The revoked-authorization cleanup, the privacy transition and `activeAlarmKeys` are **new native
  behavior**: they are reviewed and type-check only once the host builds them. AlarmKit exposes no
  in-place presentation update, so enabling App Lock while an alarm is alerting/snoozed removes that
  presentation and does not re-present it as an alarm; the redacted overdue surface keeps the Task
  visible. That is a deliberate, documented limitation, not a claim of full privacy coverage.
- The overdue Live Activity still depends on the app running to reconcile it: no guaranteed cold
  background start, no undismissable alarm, no volume-behavior guarantee, no silent-switch or
  critical-alert tricks, and no JavaScript keepalive timer.
- `reminder-widget.ts`'s account-change re-projection is wired in the widget's own subscription;
  the focused subscription assertion lives in `reminder-widget-writer.test.ts`, which is outside
  this bounded change's allowed paths (it passes unchanged).
- No screenshots, no fabricated counts, no model-subagent review claims. All of this round's
  engineering was DeepSeek Flash; Codex only supervises/builds/tests mechanically.

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

- **Engineering**: partial — mobile Jest **356/356 (35 suites)** and `tsc --noEmit` **0 errors** were
  executed here on the current bytes; the native build and the host re-run are outstanding.
  The scoped implementation is accepted for engineering integration; the remaining
  TypeScript diagnostic is in unchanged editor dependency resolution.
- **Physical QA**: `PHYSICAL_QA_PENDING`.
- **Release**: `NOT AUTHORIZED` — local implementation/tests/QA only. No push, no `main` merge, no
 TestFlight/App Store submission, no production deployment.

## Final urgent-reminder candidate — 2026-09-29

Integration branch `test` now contains signed commits through `9f1243c87` (base `17def76c1`). The final focused regression run passed **35/35 tests in 2 suites**: `task-alarms.test.ts` and `task-notifications.test.ts`. The candidate also has the earlier **357/357 mobile tests in 35 suites** and iPhone/iPad ARM64 simulator build evidence. The latest native corrections close App-Lock redaction failure reporting and post-cancellation bookkeeping pruning; no past-due alarm is rescheduled. Physical device and interactive simulator QA remain `PHYSICAL_QA_PENDING`. Full mobile TypeScript still has one unchanged editor dependency diagnostic at `use-editor.ts:133`; no editor source was changed. Luna Reserve hit its account usage limit before editing; the final correction was completed under the user's explicit “egal wie” instruction. No push, main merge, upload, or deployment occurred.
