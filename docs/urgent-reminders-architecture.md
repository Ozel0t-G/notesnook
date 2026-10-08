# VeyraN Urgent Reminders — current architecture

Status: 2026-10-08, uncommitted changes on `test`, base `5b39107621b2edaa84f6a543b317bae450829671`. This replaces historical milestone descriptions. Current evidence and unresolved release gates are in `../artifacts/urgent-reminders-qa.md` and `../artifacts/urgent-reminders-parity-report.md`.

## Ownership and platform boundary

The existing encrypted Core Task collection remains authoritative. This change adds no Task database, schema, sync format, encryption mechanism or background JS timer. Native code owns only delivery/presentation identities. AlarmKit is guarded for iOS/iPadOS 26+, ActivityKit for supported iOS versions; both are excluded from Mac Catalyst. Existing unsupported/denied permission fallbacks remain.

`task-alarm-plan.ts` produces per-occurrence alarm keys and the existing RRULE projection. `task-alarms.ts` translates the native availability and held/active/absent/unknown result. `task-notifications.ts` serializes reconciliation, checks account generations, and preserves per-occurrence alarm/notification exclusivity. It withdraws and verifies a competing notification before creating a previously absent alarm. Unknown native state never authorizes a new audible fallback or a competing new Live Activity.

## State transitions

| State | Behavior |
|---|---|
| SCHEDULED | One AlarmKit identity per account/occurrence; system-blue tint and nine-minute post-alert countdown. No second audible notification after confirmed scheduling. |
| ALERTING | Native AlarmKit alert and native Stop slider where supported. The title follows App Lock policy. A separate reminder card is suppressed while the alarm is presenting. |
| SNOOZED | AlarmKit countdown on the same alarm identity, then re-alert. Task schedule and RRULE remain unchanged. Normal reconciliation preserves countdown/paused state. |
| STOPPED_BUT_INCOMPLETE | `TaskAlarmStopIntent` silences the alarm, durably records Stop, and requests a separate silent ActivityKit reminder. It never completes the Task. OS request refusal leaves the record eligible for recovery during a later app reconciliation. |
| COMPLETED | Snapshot identity validation → durable existing widget queue → existing app-process completion host → Core `completeIfUnchanged`. Only a committed Task change is success. Reconcile ends associated surfaces and plans the next recurrence through existing Core behavior. |
| RESCHEDULED | Scoped link opens the actual Task detail with its date picker expanded. A stale revision falls back to the Task list rather than editing a wrong occurrence. Saving reconciles away the old surfaces and plans the new due instant. |
| REMOVED_OR_DISABLED | Deletion, completion, reminder removal, Urgent off, logout and account changes invalidate surfaces. Cleanup failures are retained as minimal retry obligations. |

## Native Stop and persistence

`AlarmManager.AlarmConfiguration` supplies both `stopIntent` and `secondaryIntent`. The system slider and countdown Stop button use the same `LiveActivityIntent`. Apple runs this intent in the app process without requiring the app UI to open. A shared async operation gate serializes complete Stop/replace/cancel/sync operations across suspension points. A plain actor method alone would permit reentrancy at `await`.

The intent accepts only this app's alarm UUID namespace. It handles a system Stop whose one-shot alarm has already disappeared, without assuming an unreadable alarm list is empty. It never mutates the encrypted database. A successful Stop claim precedes the Activity request; successful Activity creation marks the attempt. Duplicate taps cannot create duplicate cards. A refused request is not reported as a created card.

`TaskAlarmMetadata` intentionally remains empty: task content is not embedded in AlarmKit metadata. Minimal versioned App Group identity/lifecycle stores supply opaque Task ID, account-scope token, due instant, revision, optional occurrence/series identity, privacy decision and stopped/attempt timestamps. There are no keys, tokens, Note contents or real display titles in these stores. They are bounded, atomically written with first-unlock file protection and excluded from backup. They reuse the existing App Group, without changing entitlements.

The immediate Stop card uses the neutral `VeyraN Task` label because a saved snapshot cannot establish the current App Lock decision during an asynchronous privacy transition. A subsequent authorized app reconciliation may supply the permitted display title. App Lock clears/redacts widget projections, blocks completion through the existing host checks, and redacts ordinary reminder cards.

App Lock during an active unredacted alarm requires replacement because AlarmKit exposes no in-place title update. The code reads the public countdown fire date or paused remainder before removal, verifies that the old presentation is gone, and re-arms the same alarm identity with a neutral title. A due/alerting replacement uses a short positive countdown; a paused replacement is paused immediately. If the remaining time cannot be read, a bounded full Snooze interval is used: this can delay the previous re-alert and is a documented approximation. A removal failure stays reported as held/unredacted, so it cannot create a duplicate fallback or falsely promise privacy. Failure to create the replacement after successful removal remains a native failure path requiring physical QA; no immediate past-due notification is fabricated.

The lifecycle merge preserves markers only for the same Task, due instant and compatible scope/occurrence/series identity. Revision/title-only changes preserve Stop; a new due instant clears the old markers even when a one-off alarm reuses its UUID. A marker dating from before its own due instant is repaired during merge to recover the intermediate-build corruption found in simulator QA.

## Presentation and actions

The historical `OverdueTaskActivityAttributes` type is retained for decoding compatibility. New optional content fields add identity and state without rewriting Tasks. Lock Screen and expanded Island contain a round completion control, truncated Task title, static localized due time and Reschedule link. Compact/minimal Island uses small blue symbols. There is no red overdue timer, elapsed counter or post-Stop pause/resume/stop control. AlarmKit's own Snooze countdown remains a system-rendered timer.

The localization catalog is shared by the widget and app targets, with English, German and Bokmål labels. SwiftUI semantic fonts/colors, text truncation and accessibility labels provide the implementation basis for Dynamic Type and VoiceOver; these do not replace device accessibility QA.

Completion validates the current approved snapshot's scope, revision and due instant before enqueuing. The existing host rechecks account, App Lock, database readiness and the current revision before the Core write. Core revisions are monotonic and recurrence materializes a new stable Task ID. Queued or failed actions do not cause an optimistic checkmark or removal. If background execution cannot commit, the existing card tap provides an app/open/unlock path.

General card taps use the current Task list plus highlight. Reschedule uses VeyraN's own URL scheme, carries the scoped occurrence/revision context and expands the existing in-app picker. It is not an out-of-process native picker. Legacy inbound widget links remain supported; malformed, ambiguous and duplicate identity parameters are rejected. Unmaterialized future occurrences can open the current series but cannot edit/complete a different sibling.

## Lifetime, migration and public API limits

The native reconcile reconstructs activities by identity, refreshes matching cards, ends stale/account-mismatched ones, and preserves dismissal/attempt markers so opening the app cannot endlessly resurrect dismissed activities. The app selects at most five recent urgent surfaces; iOS may impose a lower concurrent limit. The current eligibility window is eight hours from due time, not eight hours newly granted after every Stop. Apple allows a normal Live Activity up to eight active hours, and may retain its ended Lock Screen content for up to four additional hours. Visibility and Island prominence are controlled by iOS, and user dismissal/disabled Live Activities are respected.

Configuration version 4 refreshes future scheduled alarms to install the new intents/tint/Snooze duration. Existing active Snooze is preserved; an already-active legacy alarm may retain its old duration/configuration until it ends. Existing activities decode through the retained type with optional fields; no bulk Task migration occurs. A dismissed or system-removed legacy activity is not forcibly recreated just to demonstrate an upgrade.

Scheduled ActivityKit APIs were inspected in the installed SDK. Starting a card at the due instant would compete with the alarm and does not solve an unpredictable Stop event. No scheduled-activity workaround, recurring background loop or private entitlement is used. There is no promised indefinitely persistent card or automatic silent notification reissue after Activity expiry: the Task remains overdue in the app. Existing standard notification fallback applies to future occurrences whose AlarmKit delivery is confirmed absent.

Before first device unlock, protected data can be unavailable. Native intent/store reads fail safely, and encrypted completion must wait for allowed authentication/database availability. Actual AlarmKit delivery, sound, Focus, haptics and before-first-unlock behavior remain physical-device test obligations.

## Public references

- [AlarmKit](https://developer.apple.com/documentation/alarmkit/)
- [Scheduling an alarm](https://developer.apple.com/documentation/alarmkit/scheduling-an-alarm-with-alarmkit)
- [WWDC25 AlarmKit](https://developer.apple.com/videos/play/wwdc2025/230/)
- [LiveActivityIntent](https://developer.apple.com/documentation/appintents/liveactivityintent)
- [Displaying live data](https://developer.apple.com/documentation/activitykit/displaying-live-data-with-live-activities)
- [Live Activity design](https://developer.apple.com/design/human-interface-guidelines/live-activities)

Signatures were checked against the installed release Xcode 27A266a SDK. In particular, the native alert initializer that leaves Stop presentation to the system is availability-gated for iOS 26.1; AlarmKit configuration intents are supported from iOS 26.0. An actual iOS 26.2 runtime was not available in this test session.
