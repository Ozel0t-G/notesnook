# Urgent reminders — routing/focus/overdue/delivery re-run evidence

This directory holds the re-run instructions for the bounded milestone that hardened
notification/deep-link Task routing, the Tasks-list focus/highlight, the Urgent-only overdue Live
Activity, and per-occurrence delivery exclusivity. The machine-readable results are produced by the
host run; the summary lives in `../urgent-reminders-qa.md`.

## Status

The **mobile Jest suite and `tsc --noEmit` now execute in the coding checkout** (workspace packages
built, `patch-package` applied):

- `npx jest app/ --runInBand` → **356/356 tests, 35/35 suites** (the 34-suites/333-tests digest
  recorded earlier does not cover this round's new/changed files).
- `npx tsc --noEmit` (from `apps/mobile`) → **0 errors**.
- Combined digest of this round's changed bytes (recipe below) →
  `6c411dd505c673223bdf18489d8d06d022aa0372476ff5d69dd3286232a62fff`.

Not run anywhere yet: the native iOS build for the current bytes, simulator/computer-use QA, and
physical-device QA (`PHYSICAL_QA_PENDING`).

## Exact commands (run from `apps/mobile` in a checkout with `node_modules` + `patch-package`)

```bash
# Whole mobile Jest suite, machine-readable. The module mapper is required: metro/rspack alias
# @notifee/react-native -> @ammarahmed/notifee-react-native and the repo has no Jest config.
BROWSERSLIST="node 20" npx --no-install jest app/ --runInBand \
  --moduleNameMapper '{"^@notifee/react-native$":"<rootDir>/node_modules/@ammarahmed/notifee-react-native"}' \
  --json --outputFile="$TMPDIR/veyran-routing-tests.json"

# Focused suites added/changed by this milestone
BROWSERSLIST="node 20" npx --no-install jest \
  app/services/task-navigation.test.ts \
  app/services/task-alarm-plan.test.ts \
  app/services/task-notification-plan.test.ts \
  app/services/task-alarms.test.ts \
  app/services/task-notifications.test.ts \
  app/screens/tasks/task-focus.test.ts \
  --runInBand --moduleNameMapper '{"^@notifee/react-native$":"<rootDir>/node_modules/@ammarahmed/notifee-react-native"}'

# Full-app type-check (0 errors on this round's bytes)
BROWSERSLIST="node 20" npx --no-install tsc --noEmit
```

## Bytes under test

```bash
# from the repository root
{ git diff HEAD -- apps/mobile/app packages/core; \
  for f in $(git ls-files -o --exclude-standard -- apps/mobile/app); do cat "$f"; done; } | shasum -a 256
```

Per-file hashes and the host QA action list are in `../urgent-reminders-qa.md`.

## What the re-run must confirm

1. `task-notifications.test.ts` — the production pass withdraws a competing fallback **before** an
   alarm is introduced; a lost replace acknowledgement leaves exactly one audible delivery; a
   verified cancellation grants fallbacks only to the occurrences it cancelled; a snoozed alarm is
   never traded for a fallback; alarms held from before a denied authorization are cleaned up and
   the presenting one is not duplicated; per-occurrence payload identity; App Lock redaction from
   the persisted setting; pending cleanup obligations retried before planning.
2. `task-alarms.test.ts` — read-first reconcile, the withdrawal gate, denied/unsupported cleanup and
   the truthful `cancelled`/`retained`/`active` reporting, plus `runIndependentCleanup`.
3. `task-navigation.test.ts` — readiness gating, wrong-account rejection before any Task read,
   occurrence-accurate resolution (completed occurrence shows its own record; a future occurrence
   shows the series' current record; a missing one shows the generic message), no mutation, no
   editor, last-accepted-tap-wins.
4. `task-focus.test.ts` — highlight only from viewability, bounded retries + deadline, cancel on new
   intent/unmount.
5. `task-alarm-plan.test.ts` — Urgent-only overdue surfaces, empty set on Urgent-off/reminder
   removed/completion/deletion/reschedule, newest-first cap, and no surface for an occurrence whose
   alarm is presenting.
