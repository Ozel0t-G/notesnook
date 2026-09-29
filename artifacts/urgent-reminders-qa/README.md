# Urgent reminders — routing/focus/overdue re-run evidence

This directory holds instructions and (once a host run happens) the machine-readable output for
the bounded milestone that hardened notification/deep-link Task routing, the Tasks-list
focus/highlight, and the Urgent-only overdue Live Activity.

## Why this directory is empty of Jest results

The isolated coding sandbox that produced these changes had **no `node_modules`, no npm cache,
and no TypeScript/Jest tooling**, so it could not run the mobile Jest suite or `tsc --noEmit`.
The new Jest test bytes are therefore **not yet executed**; the routing/focus/overdue changes
must be re-run in the host QA tree that has dependencies installed.

### What *was* executed locally (not Jest)

Node 24's `--experimental-transform-types` ran byte-identical copies of the three product modules
with stubbed dependencies in a TMPDIR harness (the harness itself is deliberately **not** added to
this repository). All assertions passed:

- `services/task-navigation.ts` — **34/34**: readiness gating with no protected-domain read before
  ready; pending intent queued while locked/cold and consumed exactly once after unlock, cleared on
  logout/account change; wrong-account rejection before any Task lookup; accountless legacy policy
  with no account read; payload parsing; pure target resolution (moved / completed-in-List /
  completed-fallback / missing / stale); no complete/update/remove; last-accepted-tap-wins ordering;
  unique focus nonce per repeat.
- `screens/tasks/task-focus.ts` — **21/21**: scrolls immediately but highlights only on
  viewability; bounded retries then release; bounded deadline give-up; cancel ends highlight and
  aborts retries; new request aborts the old target; adopts a later-resolvable index; settled
  redelivery is a no-op.
- `services/task-alarm-plan.ts` `overdueTaskSurfaces()` — **14/14**: Urgent-only; ordinary
  reminders never take a surface slot; empty desired set on Urgent-off/reminder-removed/completion/
  deletion/reschedule; 8h lifetime bound; newest-first cap of five; title sanitisation.

This harness executes the real product logic but **does not replace** running the Jest test files
in the project (React rendering, FlatList callbacks and native behaviour are still unverified).

## Exact commands (run from `apps/mobile` in a checkout with `node_modules`)

```bash
# Whole mobile Jest suite, machine-readable
npx --no-install jest app/ --runInBand --json --outputFile=/tmp/veyran-routing-tests.json

# Focused suites added/changed by this milestone
npx --no-install jest \
  app/services/task-navigation.test.ts \
  app/services/task-alarm-plan.test.ts \
  app/screens/tasks/task-focus.test.ts \
  --runInBand

# Full-app type-check (known dependency/setup/baseline errors remain; diff against baseline)
npx --no-install tsc --noEmit
```

## Bytes under test (recorded from the coding checkout; recompute in the host tree)

- `sha256(git diff HEAD -- apps/mobile/app) = 72429f30d3ca12bc4c8364ba2bfd388550195fdcb788dc13bf581faf95adabaa`
  (excludes the two new untracked files below).
- `apps/mobile/app/screens/tasks/task-focus.ts`
  `sha256 c3937b6387f6e75c62c936f440d6788bcb365e9327a7b563440db8711fa3f198`
- `apps/mobile/app/screens/tasks/task-focus.test.ts`
  `sha256 f49104362c843ced7b57eaa89c7bbf58056ccca8e0c5de2f68339c9f691b44b7`

The prior **296/296 tests, 33/33 suites** result was bound to the prior `apps/mobile/app` bytes
(`sha256 5502e4bc8e9ed8ac925ba8ed20885f99f8f727f60d43dd2eae355c7713f7dc68`) and does **not**
cover these new/changed files.

## What the re-run must confirm

1. `task-navigation.test.ts` — readiness gating (no domain read before ready), bounded pending
   queue consumed once after unlock and cleared on logout/account change, wrong-account rejection
   before any Task lookup, accountless legacy policy, moved/completed/missing/stale targets,
   last-accepted-tap-wins ordering, unique focus nonce, and that nothing routes into the editor or
   completes/edits a Task.
2. `task-focus.test.ts` — highlight starts only from viewability, bounded retries + bounded
   deadline, cancel on new intent/unmount, no stale captured index, no re-arm from mere visibility.
3. `task-alarm-plan.test.ts` — `overdueTaskSurfaces()` is Urgent-only, ordinary reminders never
   take a surface slot, and the desired set empties on Urgent-off/reminder-removed/completion/
   deletion/reschedule.
