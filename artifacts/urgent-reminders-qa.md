# Urgent Reminders QA — 2026-10-08

This report supersedes historical milestone results for this task. Worktree: branch `test`, HEAD `5b39107621b2edaa84f6a543b317bae450829671`. Nothing committed, pushed, released or uploaded. Only synthetic local tasks were used for screenshots.

## Environment

macOS with Xcode release `/Applications/Xcode.app` (27A266a); commands explicitly select this SDK. The globally selected Xcode is beta 27A5252f. Simulator runtime: iOS/iPadOS 27.0 (24A5408d). Fresh dedicated devices:

- iPhone 17 Pro: `ABB51741-44A1-4EC2-8527-27C5B17ADE8F`, `VeyraN Urgent Parity QA 20261008`.
- iPad Pro 13-inch M5: `8FCF02D0-86DE-45C3-B29E-0C24EE200AA4`, `VeyraN Urgent Parity iPad QA 20261008`.

The listed physical iPhone was unavailable. **PHYSICAL_QA_PENDING** applies to every real-device scenario. iOS 26.2 execution was not available; SDK availability guards were compiled, not runtime-tested there.

## Automated checks

Coordinator-run final candidate13 results:

| Check | Result | Evidence |
|---|---|---|
| Focused Urgent suites | PASS: 8 suites, 130 tests | `/tmp/veyran-urgent-final13-focus-jest.log` |
| Entire mobile Jest run | 49 suites / 501 tests PASS; 2 existing suite-load failures, command exit 1 | `/tmp/veyran-urgent-final13-jest.log` |
| Mobile TypeScript | PASS, exit 0 | `/tmp/veyran-urgent-final13-tsc.log` |
| Swift lifecycle harness | PASS: 28 checks against final Surface source | `/tmp/veyran-urgent-lifecycle-final.log` |
| Core regressions | PASS: 54 files, 849 tests, 1 TODO; Core unchanged afterward | `/tmp/veyran-urgent-core.log` |
| iPhone/iPad Simulator build | PASS, exit 0 | `/tmp/veyran-urgent-final13-simulator-build.log` |
| iPhone/iPad device SDK build | PASS, exit 0; unsigned | `/tmp/veyran-urgent-final13-device-build.log` |
| Mac Catalyst build | PASS, exit 0 | `/tmp/veyran-urgent-final13-catalyst-build.log` |
| Final translation catalog | PASS: Apple xcstringstool emitted EN/DE/NB, exit 0 | `/tmp/veyran-urgent-final-catalog.log` |
| Whitespace / patch integrity | PASS | `git diff --check` |

After the candidate13 native builds, candidate14 changed only 15 translation-catalog lines (Bokmål coverage and German wording). That exact final catalog passed Apple `xcstringstool compile`; the full native builds were not repeated for text-only changes. The prior built app and widget both contain `en.lproj`, `de.lproj`, and `nb.lproj`, disproving a reviewer concern about `knownRegions` suppressing those resources. Runtime translated layout QA is still pending.

The full Jest command is deliberately reported as a failure overall, even though no new failing suite/test was introduced. Final native failure-recovery guards were code-reviewed and compiled; AlarmKit silent-cancel fault injection was not performed.

Baseline before implementation: mobile TypeScript passed; 48 mobile Jest suites passed and 2 failed to load (466 tests passed). The existing failures are `logout.test.ts` (RNDeviceInfo undefined) and `account-section.test.tsx` (FingerprintScanner/dependency parse). Core: 54 files passed, 849 tests passed, 1 TODO. Core code is unchanged by this task.

### Exact commands

From `apps/mobile`:

```sh
BROWSERSLIST='node 20' ./node_modules/.bin/jest app/ --runInBand \
  --moduleNameMapper '{"^@notifee/react-native$":"<rootDir>/node_modules/@ammarahmed/notifee-react-native"}'
./node_modules/.bin/tsc --noEmit
```

Focused command from `apps/mobile`:

```sh
BROWSERSLIST='node 20' ./node_modules/.bin/jest \
  app/services/task-alarm-plan.test.ts app/services/task-alarms.test.ts \
  app/services/task-notifications.test.ts app/services/task-notification-actions.test.ts \
  app/services/task-navigation.test.ts app/services/reminder-widget-links.test.ts \
  app/services/reminder-widget-completion.test.ts app/services/reminder-widget-writer.test.ts \
  --runInBand \
  --moduleNameMapper '{"^@notifee/react-native$":"<rootDir>/node_modules/@ammarahmed/notifee-react-native"}'
```

From `packages/core`:

```sh
npm test -- --reporter=dot
```

From repository root (app plus widget extension):

```sh
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild \
  -workspace apps/mobile/ios/Notesnook.xcworkspace -scheme NotesnookRelease \
  -configuration Release -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath /tmp/VeyraNUrgentParitySimulator \
  CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- ARCHS=arm64 build

DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild \
  -workspace apps/mobile/ios/Notesnook.xcworkspace -scheme NotesnookRelease \
  -configuration Release -sdk iphoneos -destination 'generic/platform=iOS' \
  -derivedDataPath /tmp/VeyraNUrgentParityDevice \
  CODE_SIGNING_ALLOWED=NO ARCHS=arm64 build

DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild \
  -workspace apps/mobile/ios/Notesnook.xcworkspace -scheme NotesnookRelease \
  -configuration Release -destination 'generic/platform=macOS,variant=Mac Catalyst' \
  -derivedDataPath /tmp/VeyraNUrgentParityCatalyst \
  CODE_SIGNING_ALLOWED=NO ARCHS=arm64 build

DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer swiftc \
  -sdk /Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk \
  -target arm64-apple-ios18.0-macabi \
  apps/mobile/ios/Notesnook/TaskAlarm/TaskAlarmSurface.swift \
  apps/mobile/ios/Notesnook/TaskAlarm/Tests/TaskAlarmLifecycleStoreHarness.swift \
  -o /tmp/veyran-urgent-lifecycle-final
/tmp/veyran-urgent-lifecycle-final

mkdir -p /tmp/veyran-urgent-final-catalog
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcrun xcstringstool compile \
  apps/mobile/ios/NotesWidget/Localizable.xcstrings \
  --output-directory /tmp/veyran-urgent-final-catalog

git diff --check
```

The unsigned iPhoneOS build covers iPhone/iPad target compilation; it is not an installation or physical validation. Catalyst is a build smoke test, not a new account/editor runtime certification. Existing local dependencies were reused; do not reinstall packages merely to reproduce these commands.

## Observed simulator behavior

Baseline synthetic `Urgent Parity Migration`: 08:00 native alarm while locked; Snooze displayed 9:59 (old ten minutes); re-alert observed 08:11; system Stop dismissed alarm without completing Task. Opening app afterward produced the old red incrementing overdue Island. This confirms the reported defect. The baseline list already happened to be blue: no claim that every old alarm was green/red.

Candidate6, before final review fixes:

- Native blue full-screen alarm delivered at 08:35.
- Stop invoked `TaskAlarmStopIntent` in the app process. Before separate Live Activity authorization, `liveactivitiesd` refused the request for lack of an activity request assertion/foreground state. The durable Stop was saved, no successful-attempt marker was fabricated.
- Foreground reconciliation recovered the calm card; compact Island showed only blue symbols and no overdue timer. Separate Live Activity Allow prompt was accepted at 08:40.
- Reschedule from the card opened the correct existing Task and expanded its date picker. Saving 08:49 removed the prior card and kept the same Task.
- A real regression was found in this subsequent Stop: a one-off alarm's stable UUID caused the old occurrence's lifecycle markers to be reused after changing its due time. The candidate12 correction and successful retest are recorded below; this failed candidate6 attempt is not evidence of a system API limitation.
- Fresh `Urgent Snooze QA` delivered at 08:54. Snooze showed 9:00 then counted down normally. At 08:56 Stop from its countdown card ran in the background and created the calm reminder card without opening VeyraN.
- At 08:57 the card's checkbox invoked `TaskAlarmCompleteIntent`; the card disappeared. Opening the app showed 2 instead of 3 open Tasks, with the tested Task removed from the open list. The intent finished after the existing completion host ran. There were 0 pending/delivered standard notifications in the native logs for this test.
- iPad fresh local onboarding and two-pane Task-screen launch passed.

Installing the candidate preserved the existing synthetic Tasks. iOS removed the previously active red Activity during app replacement; the app did not forcibly resurrect it. Therefore this session does **not** prove an uninterrupted in-place legacy-Activity visual migration.

Candidate12, after the lifecycle/security corrections:

- Installed the newly built app over the synthetic data at 09:30. Three existing open Tasks remained; the earlier completed Snooze Task stayed completed.
- Rescheduled the same `Urgent Stop QA` from 08:49 to 09:35. Read-only inspection of its minimal lifecycle record confirmed the new due/occurrence and absence of old Stop/attempt markers.
- Native blue alarm delivered at 09:35; Snooze displayed 8:57 after the initial nine-minute interval began.
- Countdown Stop at 09:35:46 immediately created the calm generic `VeyraN Task` card without foregrounding the app. The persisted stoppedAt and attemptedAt now belong to the new due time. This directly retests the previously observed regression.
- Checkbox at 09:36 completed the Task and removed the card. Unlocking showed `2 open, 2 overdue`, with only Migration and Slider fixtures remaining; the rescheduled Task was absent from the open list.
- Evidence: `veyran-candidate12-rescheduled-alarm.png`, `veyran-candidate12-stop-after-reschedule.png`; native logs `/tmp/veyran-urgent-candidate12-reschedule-stop.log` and `/tmp/veyran-urgent-candidate12-completion.log`.

Independent system-slider check on candidate6 after Live Activity permission: fresh `Urgent Slider QA` delivered at 09:06; slider Stop at 09:07:27 invoked the app intent but ActivityKit rejected the request. Foreground recovery at 09:08 created the card. This test is independent of the repaired occurrence-marker defect. Light/Dark captures and general-card tap to the Task list passed. Candidate13 only hardens failure-recovery/sanitization and completion retry reporting. Its final simulator binary was installed and launched successfully on both dedicated iPhone and iPad simulators at 09:41–09:42. The iPhone was returned to its initial Light appearance. Repeat the complete alarm workflow with this final binary on a physical device before release.

## Visual evidence and reference limit

Actual simulator screenshots are in `../../qa/urgent-parity-20261008/` (outside the repository root), with local paths listed in the final report. No generated mockup is used as proof.

| Surface | VeyraN evidence | Apple reference |
|---|---|---|
| Alarm full screen | Native blue Snooze and system Stop slider observed | Pending exact same-version comparison |
| Snooze | Blue countdown; new nine-minute configuration observed | Apple nine-minute behavior not independently confirmed |
| Lock Screen after Stop | Calm title/static due/round checkbox/Reschedule observed from countdown Stop and foreground recovery | Pending |
| Compact Island | Blue circle/checklist, no red elapsed counter observed | Pending |
| Expanded Island | Implemented in SwiftUI | Runtime/reference capture pending |
| Light/Dark | Semantic styles implemented; actual captures distinguished in final log | Exact reference comparison pending |
| AOD / Dynamic Type / VoiceOver | Implementation uses system styles and labels | Physical/accessibility QA pending |

Fresh Apple Reminders without an iCloud account did not expose Urgent. No private account was used to obtain a reference. **VISUAL_REFERENCE_QA_PENDING**: pixel-level parity, exact spacing/font comparison and Apple Snooze duration are unverified. The large clock, slider, alarm sound/haptics and overall system alert are controlled by Apple; VeyraN retains its own identity.

## Physical and integration release gates

Still required on a real iPhone: locked/unlocked alarm, Focus, Silent Mode, sound/haptics, airplane mode, force quit, cold intent launch, App Lock toggled while alerting/counting/paused, completion when DB unavailable, before first unlock after reboot, multi-account switching/logout, simultaneous urgent tasks, recurring-task completion/next occurrence, and Activity expiry/user dismissal after the allowed lifetime. Verify no duplicate sounds, retained unredacted title, ghost card or stale-account mutation.

Also finish exact Apple reference capture, expanded Island, accessibility sizes/VoiceOver, long titles and German/Bokmål runtime text checks. Compilation/localization catalog checks are not visual acceptance. The unavailable physical QA must be completed before treating this as a reliable TestFlight candidate. No TestFlight upload is authorized by this work.
