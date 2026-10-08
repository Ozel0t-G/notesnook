/*
This file is part of the Notesnook project (https://notesnook.com/)

Copyright (C) 2023 Streetwriters (Private) Limited

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with this program.  If not, see <http://www.gnu.org/licenses/>.
*/

// Standalone regression harness for `TaskAlarmLifecycleStore`'s pure merge,
// claim and Stop-guard transitions -- the fix for the simulator bug where a
// rescheduled one-off Task (its alarm id is `SHA-256(account + alarmKey)` and a
// one-off key is task-only, so the id is *reused* across a reschedule)
// inherited the previous occurrence's `stoppedAt`/`attemptedAt` and the
// person's next Stop became a no-op.
//
// It deliberately exercises only the pure helpers (`sameOccurrence`, `merging`,
// `claimingStop` and `stopMayClaimOccurrence`), never the App Group file I/O, so it needs no app, no
// entitlements and no simulator. It is *not* referenced by
// `Notesnook.xcodeproj`; the coordinator compiles and runs it directly.
//
// Mac Catalyst is used because it is the one target where `TaskAlarmSurface`
// compiles with every AlarmKit/ActivityKit section gated out, so the harness
// can link the real production file and run natively:
//
//   swiftc -sdk "$(xcrun --sdk macosx --show-sdk-path)" \
//     -target arm64-apple-ios18.0-macabi \
//     apps/mobile/ios/Notesnook/TaskAlarm/TaskAlarmSurface.swift \
//     apps/mobile/ios/Notesnook/TaskAlarm/Tests/TaskAlarmLifecycleStoreHarness.swift \
//     -o "$TMPDIR/task-alarm-lifecycle-harness" \
//   && "$TMPDIR/task-alarm-lifecycle-harness"

import Foundation

@main
struct TaskAlarmLifecycleStoreHarness {
  private static var failures = 0
  private static var checks = 0

  private static func expect(_ condition: Bool, _ message: String) {
    checks += 1
    if condition {
      print("  ok   \(message)")
    } else {
      failures += 1
      print("  FAIL \(message)")
    }
  }

  private static let taskA = "0123456789abcdef01234567"
  private static let taskB = "fedcba9876543210fedcba98"
  private static let scopeA = String(repeating: "a", count: 32)
  private static let scopeB = String(repeating: "b", count: 32)
  private static let due08_35: TimeInterval = 1_700_000_000
  private static let due08_49: TimeInterval = due08_35 + 14 * 60

  private static func record(
    taskId: String = taskA,
    due: TimeInterval = due08_35,
    occurrenceKey: String? = "2026-10-08T08:35",
    seriesId: String? = "series-1",
    updatedAt: Int? = 100,
    scope: String? = scopeA,
    privacyHidden: Bool? = false,
    stoppedAt: TimeInterval? = nil,
    attemptedAt: TimeInterval? = nil
  ) -> TaskAlarmLifecycle {
    TaskAlarmLifecycle(taskId: taskId, due: due, occurrenceKey: occurrenceKey,
                       seriesId: seriesId, updatedAt: updatedAt, scope: scope,
                       privacyHidden: privacyHidden, stoppedAt: stoppedAt,
                       attemptedAt: attemptedAt)
  }

  static func main() {
    print("sameOccurrence")
    expect(
      TaskAlarmLifecycleStore.sameOccurrence(record(), as: record()),
      "identical occurrence matches")
    expect(
      TaskAlarmLifecycleStore.sameOccurrence(
        record(), as: record(updatedAt: 200)),
      "a revision/title edit is still the same occurrence")
    expect(
      !TaskAlarmLifecycleStore.sameOccurrence(
        record(), as: record(due: due08_49)),
      "a rescheduled (changed due) record is a different occurrence")
    expect(
      !TaskAlarmLifecycleStore.sameOccurrence(
        record(), as: record(scope: scopeB)),
      "an account-scope change is a different occurrence")
    expect(
      !TaskAlarmLifecycleStore.sameOccurrence(
        record(taskId: taskB), as: record(taskId: taskA)),
      "a different Task is a different occurrence")
    expect(
      !TaskAlarmLifecycleStore.sameOccurrence(
        record(occurrenceKey: "k1"), as: record(occurrenceKey: "k2")),
      "a different occurrence key is a different occurrence")
    expect(
      TaskAlarmLifecycleStore.sameOccurrence(
        record(occurrenceKey: nil, seriesId: nil, scope: nil),
        as: record(occurrenceKey: nil, seriesId: nil, scope: nil)),
      "legacy records with no optional identity still match")
    expect(
      TaskAlarmLifecycleStore.sameOccurrence(
        record(occurrenceKey: nil, seriesId: nil, scope: nil), as: record()),
      "a missing optional on either side matches on that dimension")

    print("merging")
    let stopped = record(stoppedAt: due08_35 + 60,
                         attemptedAt: due08_35 + 61)
    let preserved = TaskAlarmLifecycleStore.merging(
      previous: stopped, into: record(updatedAt: 200))
    expect(preserved.stoppedAt == due08_35 + 60,
           "same occurrence keeps stoppedAt")
    expect(preserved.attemptedAt == due08_35 + 61,
           "same occurrence keeps attemptedAt")
    expect(preserved.updatedAt == 200,
           "the fresh plan's revision wins")

    let rescheduled = TaskAlarmLifecycleStore.merging(
      previous: stopped, into: record(due: due08_49))
    expect(rescheduled.stoppedAt == nil, "changed due clears stoppedAt")
    expect(rescheduled.attemptedAt == nil, "changed due clears attemptedAt")

    let accountChanged = TaskAlarmLifecycleStore.merging(
      previous: stopped, into: record(scope: scopeB))
    expect(accountChanged.stoppedAt == nil, "account change clears stoppedAt")

    let fresh = TaskAlarmLifecycleStore.merging(previous: nil, into: record())
    expect(fresh.stoppedAt == nil && fresh.attemptedAt == nil,
           "a record with no previous plan has no markers")

    let legacyPrevious = record(occurrenceKey: nil, seriesId: nil, scope: nil,
                                stoppedAt: due08_35 + 60)
    let legacyMerged = TaskAlarmLifecycleStore.merging(
      previous: legacyPrevious, into: record())
    expect(legacyMerged.stoppedAt == due08_35 + 60,
           "a legacy (optional-free) previous record still carries its markers")

    print("migration repair of an already-corrupted record")
    // The bug wrote `due = 08:49` together with the old `stoppedAt = 08:36`.
    let corrupted = record(due: due08_49, stoppedAt: due08_35 + 60,
                           attemptedAt: due08_35 + 61)
    let repaired = TaskAlarmLifecycleStore.merging(
      previous: corrupted, into: record(due: due08_49))
    expect(repaired.stoppedAt == nil,
           "a stop earlier than its own due is repaired away")
    expect(repaired.attemptedAt == nil,
           "its attempt marker is repaired away too")

    // But a real Stop *after* the due instant (the ordinary case) is kept.
    let legitimate = record(due: due08_49, stoppedAt: due08_49 + 0.4)
    let kept = TaskAlarmLifecycleStore.merging(
      previous: legitimate, into: record(due: due08_49))
    expect(kept.stoppedAt == due08_49 + 0.4,
           "a stop within tolerance of its due is kept")

    print("claimingStop idempotency")
    expect(TaskAlarmLifecycleStore.claimingStop(nil, at: due08_35 + 60) == nil,
           "an occurrence with no plan is never claimed")
    expect(TaskAlarmLifecycleStore.claimingStop(record(), at: 0) == nil,
           "an invalid clock never claims")
    let first = TaskAlarmLifecycleStore.claimingStop(record(), at: due08_35 + 60)
    expect(first?.stoppedAt == due08_35 + 60, "the first Stop claims")
    expect(first?.taskId == taskA && first?.due == due08_35,
           "the claim keeps the occurrence identity")
    expect(TaskAlarmLifecycleStore.claimingStop(first, at: due08_35 + 61) == nil,
           "a second Stop on the same occurrence is a no-op")

    print("Stop occurrence guard")
    expect(!TaskAlarmLifecycleStore.stopMayClaimOccurrence(
             record(due: due08_49), at: due08_35),
           "a future occurrence is never claimed by a Stop")
    expect(TaskAlarmLifecycleStore.stopMayClaimOccurrence(
             record(due: due08_35), at: due08_35 + 30),
           "a due/presenting occurrence may be claimed")
    expect(TaskAlarmLifecycleStore.stopMayClaimOccurrence(
             record(due: due08_35), at: due08_35 - 0.4),
           "an occurrence within tolerance of due may be claimed")
    expect(!TaskAlarmLifecycleStore.stopMayClaimOccurrence(
             record(due: due08_35), at: 0),
           "an invalid clock never claims")

    print("")
    if failures == 0 {
      print("PASS: \(checks) checks")
    } else {
      print("FAIL: \(failures) of \(checks) checks failed")
      exit(1)
    }
  }
}
