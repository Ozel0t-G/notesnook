# Urgent reminder delivery and notification tap routing

> **Status (2026-09-29, later bounded milestone).** This describes the change as it exists on
> `test` on top of `17def76c1e069a72c4b74e9c035a847ff66c286b`. Three milestones are stacked here:
>
> 1. The original partial worktree imported from a gzipped patch plus three small Swift fixes
>    (the `due:` label corrections, `TaskAlarmModule.swift:492`/`:535`, and a paused-countdown
>    formatter fix in `NotesWidget/NotesWidget.swift`). Its mobile Jest result — **296/296 tests,
>    33/33 suites**, against tested mobile-source diff `sha256 5502e4bc8e9ed8ac925ba8ed20885f99f8f727f60d43dd2eae355c7713f7dc68`
>    — is recorded here as **PRIOR JS** evidence only.
> 2. A later bounded milestone that hardens **notification/deep-link Task routing**, the
>    **Tasks-list focus/highlight**, and restricts the **overdue Live Activity to Urgent
>    Tasks**. It adds/changes `task-navigation.ts`, `screens/tasks/task-focus.ts`,
>    `screens/tasks/index.tsx`, the producer payload in `task-notifications.ts`, and the
>    `overdueTaskSurfaces()` filter, with focused unit tests for each.
> 3. **This** bounded milestone fixes **per-occurrence delivery exclusivity** (one failed
>    recurring occurrence no longer falls a whole Task back to an audible notification while its
>    other alarms also sound), makes an **unknown native reconcile** honest (verify, then cancel
>    only not-yet-alerting alarms, then stay unverified), makes **account-change/logout cleanup
>    independent per mechanism** and **generation-guarded** against stale async passes, and states
>    the real **foreground/cold/background ActivityKit conditions and public-API limits**.
>
> Because milestones 2–3 are **new** bytes, the prior 296/296 result does **not** cover them; a
> fresh mobile Jest run, the native Swift build re-run, and interactive/device QA are **pending**
> and remain the authoritative checks. The product logic of the changed planning/bridge modules
> **was** executed locally through an ad-hoc Node type-stripping harness on byte-identical copies
> (27 assertions for this milestone, plus 34 + 21 + 14 for milestone 2) — see
> `artifacts/urgent-reminders-qa.md` — and the two `TaskAlarm` Swift files were
> `swiftc -typecheck`ed **clean** against the installed iPhoneOS27 SDK (which ships AlarmKit and
> ActivityKit, so those bodies were compiled; only `React` was stubbed with the real promise
> typedefs). That is a module-level type-check, not the full app/target build or the `.m` ObjC
> expansion. The Jest test files themselves and React/native behaviour are still unverified.
> Full-app `tsc --noEmit` still has unresolved dependency/setup/baseline errors. No code is
> committed here.

## Original regressions and root cause

Two regressions shipped independently of each other despite the native AlarmKit module
(`apps/mobile/ios/Notesnook/TaskAlarm/TaskAlarmModule.swift`) and its JS bridge
(`task-alarms.ts`) already existing in the codebase (`a335a08ac`, 2026-09-24):

- **Urgent behaved like an ordinary notification.** `task-notifications.ts`'s `reconcileNow()`
  unconditionally called `cancelAllTaskAlarms()` and always scheduled a Notifee
  `TimestampTrigger` notification for every Urgent Task, labeled `time-sensitive` but never a
  real alarm. The reconcile function that actually calls `Native.replaceAlarms()` (then
  `reconcileTaskAlarms()`, now `reconcileTaskAlarmDelivery()`) was never called from anywhere in
  the app.
- **Notification/widget/link taps opened the Task editor.** Every existing entry point
  (`notifications.ts`'s `PRESS` handler, `use-app-events.tsx`'s cold-start initial-notification
  handler, the widget deep link, the legacy reminder-migration link) pushed `TaskDetail` — a
  fully editable form (`autoFocus`, keyboard-submitting `TextInput`s) reused for both creating
  and "viewing" a Task — with no read-only/list-context alternative.

Both were finish-wiring gaps, not missing features: the native alarm module and Task List UI
already existed; the JS reconciliation loop and the tap handlers simply never used them.

## Urgent alarm lifecycle (AlarmKit)

Public APIs used: `AlarmKit` (`import AlarmKit`, `#available(iOS 26.0, *)`), gated behind a
runtime availability check with a `resolve("unsupported")` fallback on earlier OS versions or
if the framework can't be imported at all (e.g. simulator runtimes/SDKs that predate it).

- **Authorization**: `AlarmManager.shared.authorizationState` / `requestAuthorization()`,
  surfaced to JS as `unsupported | notDetermined | denied | authorized`
  (`task-alarms.ts#urgentStatus`, `#requestUrgentPermission`). Requested only from the Urgent
  switch (`detail.tsx`, `app-intent-requests.ts`'s Shortcuts path) — never from background
  reconciliation, matching the existing code comment's intent.
- **Scheduling**: `reconcileTaskAlarmDelivery(tasks, privacyHidden, withdrawal)` computes the
  desired alarm set via `desiredTaskAlarms()` (`task-alarm-plan.ts`; current occurrence plus up to
  5 future RRULE occurrences, deduplicated and identified by `taskAlarmKey()` —
  `series:<seriesId|taskId>:<occurrenceKey>` for a recurring occurrence, `task:<id>` for a
  one-off), then:
  1. **reads the current native state** (`verifyAlarms`), so nothing is written and no fallback is
     withdrawn while the state is unknown;
  2. **withdraws the competing fallback before introducing an alarm.** For every desired
     occurrence the system does *not* hold, `task-notifications.ts#withdrawCompetingFallbacks()`
     cancels the matching pending notification trigger and re-reads the trigger store to confirm
     it is gone. An occurrence whose withdrawal cannot be confirmed is **left out of the write
     entirely**, so it keeps exactly one audible delivery (its notification) instead of gaining a
     second one;
  3. calls `Native.replaceAlarms(accountId, desired)` for the rest. The Swift side (`replace()`)
     fully reconciles: alarms not in the desired set are removed; an alarm already `.alerting` or
     correctly `.scheduled` (matched by timestamp + a stored fingerprint) is left untouched
     (**"Stop is a separate user action; never complete or silence the Task here"**); everything
     else is recreated. It returns `{status, scheduledAlarmKeys, activeAlarmKeys}` — the
     **per-occurrence** truth: exactly the alarm keys this app holds for the account after the
     pass, and which of them are presenting right now. An occurrence absent from the list
     (unsupported/denied, malformed input, or an individual scheduling failure) is simply not
     scheduled; an alarm that could not be **removed** is reported as held, so JS never adds a
     duplicate fallback alongside an alarm that still exists. The signed-in account is folded into
     each native alarm id (`sha256("…:\(accountId):\(alarmKey)")`-derived UUIDv8), so one key is
     only ever meaningful with the account that reconciled it.
  4. **resolves a failed write honestly**: `verifyAlarms` first, then a verified cancellation of
     only the not-yet-alerting alarms. The answer is per occurrence — `held`, `absent` (proven not
     held, so a fallback is safe and cannot duplicate), or neither (unknown: keep the existing
     fallback, add none) — never a Task-wide guess.
  A **lost replacement acknowledgement** (the device applied the pass but the promise was lost)
  therefore cannot leave an alarm *and* a pending fallback for the same occurrence: the fallback
  was already withdrawn before the alarm was introduced, and an unknown outcome never re-creates
  it.
- **Fallback routing**: `planTaskNotifications()` (`task-notification-plan.ts`) takes an
  `UrgentAlarmFallback` decision whose `needsFallback(alarmKey)` and `isUnknown(alarmKey)` are
  asked **per occurrence**, not per Task. `reconcileNow()` wires `needsFallback` to
  `absentAlarmKeys` and `isUnknown` to "in neither `held` nor `absent`", so in a partially
  successful recurring series only the occurrences whose own alarm is provably missing get a
  Notifee notification, the occurrences whose alarm did schedule get **no** duplicate, and a
  single unknown occurrence does not drag the rest of the plan into the same treatment. Normal
  (non-Urgent) reminders are unaffected and keep their existing Notifee `TimestampTrigger` path.
  The fallback notification's body is `strings.tasksUrgentFallbackBody()` ("Alarm unavailable.
  This is a standard notification."), so a denied/unsupported/individually-failed Urgent
  occurrence is clearly identified as a fallback rather than mistaken for the alarm.
- **Denied / unsupported is not "nothing scheduled".** Alarms scheduled while the app *was*
  authorized can still be held and still sound after authorization is revoked, so a
  `denied`/`notDetermined`/`unsupported` read is followed by a cleanup of the alarms this app owns
  (never a presentation the person is engaged with) and a truthful report: `cancelScheduledAlarms`
  returns `cancelledAlarmKeys` **and** `retainedAlarmKeys`, and the retained/presenting occurrences
  are kept out of the fallback path so no notification duplicates them. If that cleanup itself
  fails, the owned alarms are reported as still held and the failure travels with the answer.
- **Account change / logout cleanup is independent per mechanism and durable.** The signed-in
  account change and `userLoggedOut` handlers bump a generation counter immediately (so an
  in-flight pass refuses to write old-account alarms/notifications/surfaces once it differs) and
  then run `runIndependentCleanup` over the four mechanisms — scheduled Task notifications, native
  Urgent alarms, overdue Live Activities, and already-displayed unredacted Task notifications. A
  rejection from one (`Promise.allSettled`) cannot skip the others. **A failure is not just
  logged:** the failing mechanism labels are persisted as a minimal obligation
  (`notesnook.taskSurfaces.pendingCleanup.v1` — labels + timestamp, no content, no account id) and
  retried at the next launch/foreground **before** any new planning, even when the Task domain is
  not initialized or the app is mid-logout — every mechanism cancels surfaces by ownership rather
  than by reading the account that created them. The iOS Task widget snapshot is cleared by its own
  independent `ReminderWidget` logout/account-change subscriptions, and a user-id change now also
  re-projects the snapshot so the widget cannot sit on the previous account's Tasks.
- **Stop / Snooze / Complete semantics** (enforced natively, unchanged by this work): Stop
  silences the alert without completing the Task (state machine stays `OVERDUE_INCOMPLETE`
  until the user completes it through the normal Task-domain operation). Completion always
  goes through `db.tasks.complete()` — there is no second Task database, no duplicated
  recurrence logic, and no parallel crypto implementation; the AlarmKit module only tracks
  alarm-to-Task identity (`taskId`, `alarmKey`, a UUID fingerprint) in `UserDefaults`, never
  Task content.
- **Reconciliation never destroys a live presentation.** Snooze is AlarmKit's countdown
  secondary button (`TaskAlarmRepeatIntent` + `AlarmPresentation.Countdown`, `postAlert =
  9 minutes`) and Pause is `TaskAlarmPauseIntent`; both are `LiveActivityIntent`s that only
  call `AlarmManager.countdown(id:)` / `pause(id:)` / `resume(id:)` with an opaque alarm UUID,
  so the Task's own reminder occurrence is never modified and no user content is involved.
  `replace()` explicitly leaves alone any alarm that is `.alerting`, `.countdown` (snoozed) or
  `.paused` at the wanted occurrence, and never removes a wanted occurrence whose fire time is
  now or in the past. Without those two guards a background reconcile would cancel a Snooze or
  Pause the person had just chosen, and a title/App-Lock change in the seconds around the fire
  time would silently drop the alarm *and* suppress the notification fallback — i.e. a missed
  alert with no signal. When those guarded alarms are kept they are reported in
  `scheduledAlarmKeys`, so the notification planner still never duplicates them.
- **App Lock redaction, alarms included.** A future `.scheduled` alarm's fingerprint includes
  `privacyHidden`, so enabling App Lock re-creates it with the `"VeyraN Task"` placeholder, and
  the overdue Live Activity's title is updated in place from `ContentState` on the next
  reconcile. An already-*displayed* Task notification (Notification Center / Lock Screen) whose
  payload was not created redacted (`data.privacyHidden !== "1"`) is **withdrawn** on the next
  reconcile while App Lock is on, so the real title does not linger there. **Honest limit:** once
  an alarm is already `.alerting`, `.countdown` (snoozed) or
  `.paused`, AlarmKit exposes no public API to change its presentation attributes in place, and
  the app never silences a live alarm to redact it — so such an alarm keeps the title it was
  created with until it ends. No Task title is ever written to `UserDefaults` (the fingerprint
  is a SHA-256 of `timestamp|privacyHidden|updatedAt`; the overdue index stores only the opaque
  Task id, due instant and a truncated account hash), so there is no unredacted metadata on disk
  to preserve; the exposure is limited to an alarm the person is already being shown.
- **Overdue Live Activity (`OVERDUE_INCOMPLETE` device presentation)**: implemented with
  public ActivityKit (`Activity<OverdueTaskActivityAttributes>`, `#available(iOS 16.2, *)`,
  `NSSupportsLiveActivities` in `Info.plist`). `overdueTaskSurfaces()`
  (`task-alarm-plan.ts`) selects incomplete **Urgent** Tasks with a *timed* reminder that has
  already fired, within `OVERDUE_SURFACE_LIFETIME_MS` (8h — the system ends a Live Activity
  after roughly eight hours), newest first, capped at `MAX_OVERDUE_SURFACES` (5, Apple's
  `ActivityAuthorizationError.globalMaximumExceeded`/`targetMaximumExceeded` bound). These
  surfaces belong to the Urgent alarm feature: an ordinary (non-Urgent) reminder never owns
  one, so switching Urgent off — or completing, deleting, removing the reminder from, or
  rescheduling the Task — makes the desired set empty and the native reconcile ends the
  associated activity instead of leaving an unsolicited Live Activity behind, and ordinary
  overdue reminders can never consume the shared five-surface budget ahead of Urgent ones.
  Normal reminder delivery is unchanged. Rendering is
  `Text(timerInterval:countsDown:)` in the widget extension, so the elapsed time counts without
  any JavaScript timer and without the app running. The alarm surface's paused state similarly
  renders its frozen remainder with a system format style over a `Duration` — never a hand-rolled
  timer or a JS clock. The app reconciles the set on the same
  cadence as alarms and notifications; the native side is authoritative (creates, refreshes in
  place, ends surfaces that no longer apply or belong to another account) and remembers
  occurrences the person dismissed or that expired, so a ghost is never re-created.
  **Honest limits:** an alarm firing or a notification arriving cannot start one of these
  activities — neither can run app code — so the surface appears from the next reconcile
  (app launch/foreground/sync/settings change) and only for occurrences still inside the
  system's Live Activity lifetime. Lock Screen and Notification Center are different surfaces;
  this work only claims the former.
- **Privacy**: `desiredTaskAlarms()` carries `privacyHidden` per alarm, and the overdue path passes
  it to `syncOverdueActivities()` (`task-notifications.ts`) alongside the surfaces — the App Lock
  placeholder (`"VeyraN Task"`) is then chosen in exactly one place per platform —
  `TaskAlarmModule.swift`'s `parse()` for alarms and `syncOverdueActivities` for activities —
  so the real title is never what a hidden surface displays. Live-activity bookkeeping stores
  only an opaque Task id, the due instant and a truncated SHA-256 of the account id (never
  Task titles, never a raw account id). `Info.plist` gained only `NSSupportsLiveActivities`.

## Notification tap routing (List + highlight, never the editor)

The single shared resolver is `task-navigation.ts#openTaskInContext(intent)`. A bare
`string` is still accepted (an explicit open), but every entry point now passes a **minimal
intent**: `{ taskId, accountId?, occurrenceKey?, source }` — `source` is one of
`notification`, `cold-initial-notification`, `widget`, `legacy-link`, `explicit`. The intent
carries no title, no List ID and no other Task content, so a queued or rejected request can
never disclose what it addressed.

Readiness and account policy (enforced before any Task read):

1. **Readiness.** The protected domain is not read until `db.isInitialized && !isAppLoading &&
   !appLocked && !isLoggingOut` — the same live store/bootstrap signals the widget completion
   queue already uses (`canRouteTaskNavigation`). A tap that arrives while the app is cold,
   still hydrating, or App Locked queues the minimal intent (`pendingTaskNavigation`, bounded,
   last-wins) and `consumePendingTaskNavigation()` consumes it exactly once when App Lock/loading
   clears (the existing unlock effect in `use-app-events.tsx`). The queue is cleared on logout
   and on any account change, so it can never be replayed against another account.
2. **Account.** A payload that claims an account (`notification`/`cold-initial-notification`
   producers attach the owning account id) is rejected before any Task lookup if a different
   account is signed in, or if nobody is signed in. An **accountless** payload — the widget deep
   link and the legacy `open_reminder` migration link, which carry only an ID — is resolved
   against the **current** account's data only, and can never open another account, because no
   other account is ever opened (`decideTaskIntentAccount`). There is no silent account switch.
3. **Target.** The Task is re-read fresh (`db.tasks.get(taskId)`); a stale List ID in old payload
   data is never trusted.
   - moved → opens the Task's **current** canonical List.
   - completed → stays visible **in its current List** (`includeCompleted`) when that List still
     exists (its real context, without resurrecting it); otherwise the `completed` smart list.
   - missing/deleted → a safe `Tasks` destination plus a deliberately generic, non-identifying
     notice (`TASK_UNAVAILABLE_MESSAGE`).
   - a payload whose occurrence identity (`occurrenceKey`) disagrees with the stored record is
     `stale`: it is never treated as the following occurrence. The router never completes, edits
     or reopens a Task, so a stale recurring occurrence can never be applied to the next one.
4. **Ordering.** A generation counter makes the **last accepted tap win** even when the async
   lookups resolve out of order; each delivered request carries a **unique `focusRequestId`
   nonce**, so re-focusing the same Task after the highlight expired re-arms it instead of being
   ignored by a stable `highlightTaskId`.

The Tasks screen (`screens/tasks/index.tsx`) resolves the row index from the loaded list and
drives a `TaskFocusSession` (`screens/tasks/task-focus.ts`), which:

- Scrolls the target row into view (`scrollToIndex`, `viewPosition: 0.4`) as soon as the screen
  is not loading, with a bounded (max 5), increasing-backoff retry via `onScrollToIndexFailed`
  for the unmeasured-row case — never an unbounded loop and no arbitrary initial delay. A new
  intent, a list change, or unmount cancels every pending timer and any running highlight, so an
  old target is never scrolled or highlighted after a newer tap, and no stale captured index is
  reused.
- Starts the restrained, temporary (2.2s) background highlight **only from the FlatList
  viewability callback** once the row is actually on screen, with a bounded deadline that
  releases a target that never becomes viewable. It never re-arms the highlight from mere
  visibility after it ended.
- Never opens `TaskDetail`, never focuses a `TextInput`. It dismisses any keyboard on arrival so
  a notification tap cannot land on a focused input, and touches no editor internals (unsaved
  Notes state is preserved).

Wired into all "open an existing Task" entry points: `notifications.ts`'s `PRESS` handler
(warm), `use-app-events.tsx`'s cold-start initial-notification handler, the widget
`"task"`/`"complete"` deep-link actions, and the legacy `open_reminder` migration link. The
`task-notifications.ts` producer attaches the owning account id and the occurrence key to every
Task notification so the tap can be validated. The widget `"complete"` action specifically still
requires an explicit in-app action (per its existing comment, since a URL can be invoked by
another app) — it now opens the List with the existing completion checkbox available, instead of
opening the editor. "Create a new Task" flows (widget `"create"`, `new_reminder` link, the App
Intent Shortcuts "task" target) are unchanged and still open `TaskDetail` with no `taskId`,
since there is no existing Task to view.

## ActivityKit / AlarmKit conditions and public-API limits

These are the actual platform conditions, not a promise of more than the public API allows:

- **Foreground / `active`.** `reconcileNow()` runs on app launch, on `AppState` returning to
  `active`, on a completed sync, and on an App Lock / settings change. Only then can the app
  create, refresh or end an overdue Live Activity or schedule an alarm. The system executes the
  SwiftUI timer in the activity's own view, so the card's elapsed time updates with the app
  suspended.
- **Background / suspended.** A suspended app runs no JavaScript: it cannot start, update or end
  a Live Activity, and cannot schedule or reconcile an alarm. An already-started Live Activity
  keeps rendering (system-owned) until the person dismisses it or it expires; an already-
  scheduled alarm still fires because AlarmKit owns it. Nothing here claims a background wake-up.
- **Cold start.** `Activity<…>.activities` is readable once the app process is running, so the
  first reconcile after the database is initialized (and, when App Lock is on, after unlock)
  adopts the current truth: it creates missing surfaces, refreshes existing ones and ends ones
  that no longer apply. There is **no** cold-start automatic Live Activity and **no** "an alarm
  or a notification starts one" behaviour — neither an alarm firing nor a notification arriving
  can run app code, so neither can start a surface.
- **Public-API limits.** ActivityKit is iOS 16.2+ (`#available(iOS 16.2, *)`) and AlarmKit is
  iOS 26+ (`#available(iOS 26.0, *)`); older OSes (or a build whose SDK can't import the
  framework) report `unsupported` and Android reports `unsupported` for alarms. Live Activities
  are capped (this app keeps 5 concurrent overdue surfaces and the system enforces
  `globalMaximumExceeded`/`targetMaximumExceeded`) and the system ends one after roughly eight
  hours (`OVERDUE_SURFACE_LIFETIME_MS`). There is no public API to update an AlarmKit alarm's
  presentation attributes in place, and none to run app code from an alarm or a notification.
- **Snooze / Pause / Stop are system intents, not app callbacks.** `TaskAlarmRepeatIntent`,
  `TaskAlarmPauseIntent`, `TaskAlarmResumeIntent` and `TaskAlarmStopIntent` are
  `LiveActivityIntent`s the system runs; each only calls `AlarmManager.countdown/pause/resume/stop`
  with the alarm's opaque UUID. Stop silences the alert and never completes the Task; Snooze is
  AlarmKit's `postAlert` countdown and never edits the Task's reminder occurrence, so recurrence
  is preserved. No "alarm callback" runs application logic.

## What this explicitly did not change

No second Task database, no duplicated recurrence/crypto, no Notes editor changes (schema,
bridge, initialization, save lifecycle, WebView), no App Lock behavior changes beyond what
already existed, no Widget snapshot/completion-queue changes, no account/backend/theme work.

## Known limitations (honest, not yet closed)

- The overdue Live Activity is **app-reconciled, not guaranteed**. An alarm firing and a
  notification arriving each cannot run app code, so neither can *start* one of these surfaces;
  the surface appears only on the next reconcile (app launch, foreground return, a completed
  sync, or an App Lock setting change) and only while the occurrence is still inside the
  system's ~8-hour Live Activity lifetime. A Task that becomes overdue entirely in the
  background with the app cold is therefore not surfaced until the app next runs. This is the
  Lock Screen / Dynamic Island surface only — it is not the Notification Center and it is not a
  second notification.
- Live Activities are capped at 5 concurrent surfaces (`MAX_OVERDUE_SURFACES` /
  `OverdueActivity.maxConcurrent`), newest overdue first; older overdue Tasks beyond the cap get
  no surface (they are reported in `failedTaskIds`, not assumed shown).
- Alarm delivery is answered **per occurrence**, not per failure reason: `scheduledAlarmKeys`
  says *which* occurrence is or is not scheduled (and `status` says whether the device is
  authorized at all), but not *why* one occurrence failed (simulator vs. real denial vs. an
  individual scheduling error). `verifyAlarms`/`cancelScheduledAlarms` make the unknown path
  honest; they do not add finer failure diagnostics than that.
- Snooze is an AlarmKit countdown (`postAlert` = 9 minutes) driven by the alarm's own
  `secondaryIntent`; it never edits the Task's reminder occurrence and never persists as Task
  state. Stop only silences the alert through `AlarmManager.stop(id:)` — it never completes the
  Task; completion stays a separate Task-domain action.
- Interactive simulator QA (visually confirming the highlight/scroll and the Urgent
  authorization prompt) and physical device QA (real sound/haptics/locked-device alarm
  behavior) had not been performed as of this document's last update — see
  `artifacts/urgent-reminders-qa.md` for current status.
- Swift compilation of this worktree has **not** been re-run after the 2026-09-29 label fix
  (Xcode cannot run inside the worker sandbox); the *only* errors a prior host type-check
  reported were the two `occurrenceKey` labels fixed here, but that is not a substitute for a
  fresh host build.
