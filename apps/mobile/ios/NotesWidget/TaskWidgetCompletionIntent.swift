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

import AppIntents
import CryptoKit
import Foundation
import WidgetKit

// This file is compiled into both the app and the widget extension, because the
// same intent type has to exist in whichever process the system chooses to run
// it in. Everything here is Foundation and WidgetKit only: the encrypted Task
// domain belongs to the host's React Native code and is never opened natively.

struct WidgetCompletionAction: Codable {
  let id: String
  let scope: String
  let updatedAt: Int
  let enqueuedAt: Int
}

/// The durable record of a tap, surviving a crash, a locked device and sign-out.
enum WidgetCompletionQueue {
  static let folder = "task-widget-actions-v1"
  static let maximumPending = 50
  static let maximumAge = 7 * 24 * 60 * 60 * 1000
  // The pending/retry split only deduplicates quick repeat taps in `enqueue`.
  static let retryAfter = 40 * 1000

  enum Status { case none, pending, retry, expired }

  static func directory() throws -> URL {
    guard let group = Bundle.main.object(forInfoDictionaryKey: "appGroupId") as? String,
          let container = FileManager.default.containerURL(
            forSecurityApplicationGroupIdentifier: group) else {
      throw CocoaError(.fileNoSuchFile)
    }
    return container.appendingPathComponent(folder, isDirectory: true)
  }

  static func filename(id: String, scope: String, updatedAt: Int) -> String {
    let input = Data("\(scope):\(id):\(updatedAt)".utf8)
    return SHA256.hash(data: input).map { String(format: "%02x", $0) }.joined() + ".json"
  }

  private static func storedAction(
    id: String, scope: String, updatedAt: Int
  ) -> WidgetCompletionAction? {
    guard let directory = try? directory(),
          let data = try? Data(contentsOf: directory.appendingPathComponent(
            filename(id: id, scope: scope, updatedAt: updatedAt))),
          let action = try? JSONDecoder().decode(WidgetCompletionAction.self, from: data) else {
      return nil
    }
    guard action.id == id && action.scope == scope &&
      action.updatedAt == updatedAt else { return nil }
    return action
  }

  static func status(
    id: String, scope: String, updatedAt: Int, at date: Date = Date()
  ) -> Status {
    guard let action = storedAction(id: id, scope: scope, updatedAt: updatedAt) else {
      return .none
    }
    let now = Int(date.timeIntervalSince1970 * 1000)
    guard action.enqueuedAt <= now else { return .none }
    if action.enqueuedAt < now - maximumAge { return .expired }
    return action.enqueuedAt > now - retryAfter ? .pending : .retry
  }

  static func isQueued(
    id: String, scope: String, updatedAt: Int, at date: Date = Date()
  ) -> Bool {
    switch status(id: id, scope: scope, updatedAt: updatedAt, at: date) {
    case .pending, .retry: return true
    case .none, .expired: return false
    }
  }

  // Keep valid actions for every account for their full retry window. Only
  // malformed and expired records are removed before enforcing the queue cap.
  private static func prune(_ directory: URL, now: Int) throws -> Int {
    let manager = FileManager.default
    let files = try manager.contentsOfDirectory(at: directory,
      includingPropertiesForKeys: [.isRegularFileKey])
    var validCount = 0
    for file in files where file.pathExtension == "json" {
      let isRegular = (try? file.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true
      guard isRegular else { continue }
      // A protected file can be temporarily unreadable before first unlock.
      // Preserve it and count its slot; only inspect records we can read.
      guard let data = try? Data(contentsOf: file) else {
        validCount += 1
        continue
      }
      let action = try? JSONDecoder().decode(WidgetCompletionAction.self, from: data)
      let valid = action.map {
        $0.id.range(of: "^(?:[0-9a-f]{24}|[0-9a-f]{32})$", options: .regularExpression) != nil &&
        $0.scope.range(of: "^[0-9a-f]{32}$", options: .regularExpression) != nil &&
        $0.updatedAt > 0 &&
        $0.enqueuedAt <= now && $0.enqueuedAt >= now - maximumAge &&
        file.lastPathComponent == filename(id: $0.id, scope: $0.scope,
          updatedAt: $0.updatedAt)
      } ?? false
      if valid { validCount += 1 }
      else { try? manager.removeItem(at: file) }
    }
    return validCount
  }

  static func enqueue(id: String, scope: String, updatedAt: Int) throws {
    let directory = try directory()
    let manager = FileManager.default
    // The directory is created protected first, so the action file never
    // exists for even an instant with the default protection class.
    try manager.createDirectory(
      at: directory, withIntermediateDirectories: true,
      attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
    let name = filename(id: id, scope: scope, updatedAt: updatedAt)
    let url = directory.appendingPathComponent(name)
    let current = status(id: id, scope: scope, updatedAt: updatedAt)
    if current == .pending { return }
    let validCount = try prune(directory, now: Int(Date().timeIntervalSince1970 * 1000))
    // A retry refreshes the same deterministic action file. It is a new tap,
    // so the temporary pending indicator starts again without using another
    // queue slot or changing the Task/occurrence identity.
    guard validCount < maximumPending || current == .retry else {
      throw CocoaError(.fileWriteOutOfSpace)
    }
    let action = WidgetCompletionAction(id: id, scope: scope,
      updatedAt: updatedAt, enqueuedAt: Int(Date().timeIntervalSince1970 * 1000))
    let data = try JSONEncoder().encode(action)
    do {
      // Protection is applied by the atomic write itself: there is no window
      // in which the file exists unprotected.
      try data.write(to: url, options: [.atomic,
        .completeFileProtectionUntilFirstUserAuthentication])
      var resourceValues = URLResourceValues()
      resourceValues.isExcludedFromBackup = true
      var mutableURL = url
      try? mutableURL.setResourceValues(resourceValues)
    } catch {
      try? manager.removeItem(at: url)
      throw error
    }
  }
}

/// Implemented by the app target only. Looking it up at runtime is also the
/// capability check: in the widget extension there is no such class, no host
/// React Native instance and therefore no way to commit, so the tap stays a
/// queued action there.
protocol TaskWidgetCompletionCommitting: AnyObject {
  static func commitWidgetCompletion(
    taskId: String, scope: String, updatedAt: Int, filename: String
  ) async -> String
}

/// The host's reply. Only `completed` means the Task is persisted, projected
/// into the snapshot and acknowledged.
enum TaskWidgetCompletionFailure: LocalizedError {
  case locked
  case accountMismatch
  case stale
  case unavailable
  case notSaved

  var errorDescription: String? {
    switch self {
    case .locked:
      return "Unlock VeyraN to complete this Task."
    case .accountMismatch:
      return "Sign back in to the account that owns this Task."
    case .stale:
      return "This Task changed. Open VeyraN to see it."
    case .unavailable:
      return "VeyraN could not open your Tasks. Open the app and try again."
    case .notSaved:
      return "VeyraN could not save this completion. It will retry."
    }
  }

  static func from(_ outcome: String) -> Self? {
    switch outcome {
    case "completed": return nil
    case "locked": return .locked
    case "accountMismatch": return .accountMismatch
    case "stale": return .stale
    case "unavailable": return .unavailable
    default: return .notSaved
    }
  }
}

/// Any list can show a ring, so snapshot membership, not the Today-only filter, validates a tap.
///
/// `due`, when supplied, additionally requires the snapshot's own due instant
/// for that Task to agree: a completion is only ever accepted for the exact
/// occurrence the caller described, never for whichever occurrence the Task
/// happens to be on now (or for a future one that is not materialized yet).
/// (Internal, not private: the alarm card's completion control validates the
/// same approved snapshot, and both files are compiled into both targets.)
func snapshotListsTask(id: String, scope: String, updatedAt: Int,
                       due: TimeInterval? = nil, at now: Date) -> Bool {
  matchingSnapshotTask(id: id, scope: scope, updatedAt: updatedAt,
                       due: due, at: now) != nil
}

/// The app's own approved record of the exact occurrence, read from the
/// protected widget snapshot. Strict: the snapshot must be unredacted and agree
/// on account scope, Task id, revision and (when given) due instant, so a
/// sibling occurrence or another account's Task can never match.
func matchingSnapshotTask(id: String, scope: String, updatedAt: Int,
                          due: TimeInterval? = nil,
                          at now: Date) -> ReminderSnapshotItem? {
  guard id.range(of: "^(?:[0-9a-f]{24}|[0-9a-f]{32})$",
                 options: .regularExpression) != nil,
        scope.range(of: "^[0-9a-f]{32}$", options: .regularExpression) != nil,
        updatedAt > 0,
        case let .available(snapshot) = ReminderSnapshotStore.load(at: now),
        snapshot.privacyHidden != true,
        snapshot.accountScope == scope else { return nil }
  return snapshot.tasks.first(where: { task in
    guard task.id == id,
          task.updatedAt.flatMap({ Int(exactly: $0) }) == updatedAt else {
      return false
    }
    guard let due else { return true }
    guard let instant = TaskWidgetClock.dueInstant(task) else { return false }
    return abs(instant.timeIntervalSince1970 - due) < 0.5
  })
}

/// The display title the app may show for the exact occurrence a card
/// describes, or `nil` when the snapshot does not agree (or privacy hides it).
/// It is never written to the identity/lifecycle stores.
///
/// Deliberately **not** used by the Stop card any more: a Stop tap runs without
/// the host, so the snapshot it could read is a stale projection and cannot
/// prove the *current* App Lock state. A card that must decide between a real
/// title and the placeholder needs the live, hydrated App Lock state, which only
/// the app's own reconciliation has. Callers must therefore be able to vouch for
/// "unlocked right now" beyond a plan-time flag plus a snapshot age check.
func snapshotApprovedTitle(id: String, scope: String, updatedAt: Int,
                           due: TimeInterval? = nil, at now: Date) -> String? {
  matchingSnapshotTask(id: id, scope: scope, updatedAt: updatedAt,
                       due: due, at: now)?.title
}

@available(iOS 17.0, iOSApplicationExtension 17.0, *)
struct CompleteTaskWidgetIntent: AppIntent {
  static var title: LocalizedStringResource = "Complete Task"
  static var openAppWhenRun: Bool { false }

  // Widget plumbing, not a user-facing action: its parameters are a raw Task
  // id, an account scope and a revision. Shortcuts already offers "Complete
  // Task" by title through VeyraNCompleteTaskIntent.
  static var isDiscoverable: Bool { false }

  // iOS 26 gained explicit modes; before that `openAppWhenRun == false` already
  // meant "do not bring the app forward", which is the same promise.
  @available(iOS 26.0, iOSApplicationExtension 26.0, *)
  static var supportedModes: IntentModes { .background }

  // iOS 27 is the first release that can route an intent to the main app
  // process. Older widgets show Tasks without a completion control because
  // their extension cannot open the encrypted Task domain.
  @available(iOS 27.0, iOSApplicationExtension 27.0, *)
  static var allowedExecutionTargets: IntentExecutionTargets { .main }

  @Parameter(title: "Task") var id: String
  @Parameter(title: "Account Scope") var scope: String
  @Parameter(title: "Task Revision") var updatedAt: Int

  init() {}
  init(id: String, scope: String, updatedAt: Int) {
    self.id = id
    self.scope = scope
    self.updatedAt = updatedAt
  }

  func perform() async throws -> some IntentResult {
    guard #available(iOS 27.0, iOSApplicationExtension 27.0, *) else {
      throw TaskWidgetCompletionFailure.unavailable
    }
    guard snapshotListsTask(id: id, scope: scope, updatedAt: updatedAt, at: Date()) else {
      throw CocoaError(.fileReadUnknown)
    }
    // Durable first. A repeat tap finds the same deterministic filename, and a
    // crash anywhere after this point leaves an action the host will still
    // finish, so the completion is never silently lost or applied twice.
    try WidgetCompletionQueue.enqueue(id: id, scope: scope, updatedAt: updatedAt)
    WidgetCenter.shared.reloadTimelines(ofKind: "ReminderWidget")

    guard let host = NSClassFromString("TaskWidgetCompletionBridge")
            as? TaskWidgetCompletionCommitting.Type else {
      // Routing unexpectedly stayed in the extension. Preserve the action for
      // recovery, but never report that the Task was completed there.
      throw TaskWidgetCompletionFailure.unavailable
    }
    let outcome = await host.commitWidgetCompletion(
      taskId: id,
      scope: scope,
      updatedAt: updatedAt,
      filename: WidgetCompletionQueue.filename(id: id, scope: scope, updatedAt: updatedAt)
    )
    if let failure = TaskWidgetCompletionFailure.from(outcome) {
      // Nothing here reports success on the host's behalf: the snapshot the
      // widget redraws from is written by the host from the persisted Task, so
      // a failed action cannot leave a completed-looking row.
      throw failure
    }
    return .result()
  }
}

/// Queues a completion durably in the App Group; the app commits it later.
@available(iOS 27.0, iOSApplicationExtension 27.0, *)
struct QueueTaskCompletionWidgetIntent: AppIntent {
  static var title: LocalizedStringResource = "Complete Task"
  static var isDiscoverable: Bool { false }
  static var openAppWhenRun: Bool { false }
  static var supportedModes: IntentModes { .background }

  @Parameter(title: "Task") var id: String
  @Parameter(title: "Account Scope") var scope: String
  @Parameter(title: "Task Revision") var updatedAt: Int

  init() {}
  init(id: String, scope: String, updatedAt: Int) {
    self.id = id
    self.scope = scope
    self.updatedAt = updatedAt
  }

  func perform() async throws -> some IntentResult {
    guard snapshotListsTask(id: id, scope: scope, updatedAt: updatedAt, at: Date()) else {
      throw CocoaError(.fileReadUnknown)
    }
    try WidgetCompletionQueue.enqueue(id: id, scope: scope, updatedAt: updatedAt)
    WidgetCenter.shared.reloadTimelines(ofKind: "ReminderWidget")
    // The app can be active before this runs, so its own drain may have missed the new file.
    await MainActor.run {
      NotificationCenter.default.post(name: .taskWidgetActionQueued, object: nil)
    }
    return .result()
  }
}

extension Notification.Name {
  /// Posted in-process after a widget tap has been written to the App Group queue.
  static let taskWidgetActionQueued = Notification.Name("veyran.taskWidget.actionQueued")
}
