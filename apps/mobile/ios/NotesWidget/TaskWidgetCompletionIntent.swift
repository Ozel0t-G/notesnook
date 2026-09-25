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

/// The durable record of a tap. It survives a process crash, a locked device
/// and a signed-out account, and it is what keeps the widget row visibly
/// pending until the host has actually persisted the completion.
enum WidgetCompletionQueue {
  static let folder = "task-widget-actions-v1"
  static let maximumPending = 50
  static let maximumAge = 7 * 24 * 60 * 60 * 1000

  enum Status { case none, pending, expired }

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

  static func status(id: String, scope: String, updatedAt: Int) -> Status {
    guard let directory = try? directory(),
          let data = try? Data(contentsOf: directory.appendingPathComponent(
            filename(id: id, scope: scope, updatedAt: updatedAt))),
          let action = try? JSONDecoder().decode(WidgetCompletionAction.self, from: data) else {
      return .none
    }
    let age = Int(Date().timeIntervalSince1970 * 1000) - action.enqueuedAt
    guard action.id == id && action.scope == scope &&
      action.updatedAt == updatedAt && age >= 0 else { return .none }
    return age <= maximumAge ? .pending : .expired
  }

  static func enqueue(id: String, scope: String, updatedAt: Int) throws {
    let directory = try directory()
    let manager = FileManager.default
    try manager.createDirectory(at: directory, withIntermediateDirectories: true)
    let name = filename(id: id, scope: scope, updatedAt: updatedAt)
    let url = directory.appendingPathComponent(name)
    if status(id: id, scope: scope, updatedAt: updatedAt) == .pending { return }
    let pending = try manager.contentsOfDirectory(at: directory,
      includingPropertiesForKeys: nil).filter {
        $0.pathExtension == "json" && $0.lastPathComponent != name
      }
    guard pending.count < maximumPending else { throw CocoaError(.fileWriteOutOfSpace) }
    let action = WidgetCompletionAction(id: id, scope: scope,
      updatedAt: updatedAt, enqueuedAt: Int(Date().timeIntervalSince1970 * 1000))
    let data = try JSONEncoder().encode(action)
    do {
      try data.write(to: url, options: .atomic)
      try manager.setAttributes(
        [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
        ofItemAtPath: url.path)
      var resourceValues = URLResourceValues()
      resourceValues.isExcludedFromBackup = true
      var mutableURL = url
      try mutableURL.setResourceValues(resourceValues)
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
  // process. That process owns the encrypted Task domain, so this is what makes
  // a tap commit instead of only queueing. On iOS 17 to 26 the intent still
  // runs inside the widget extension, which cannot open that domain: the action
  // is durably queued there and the row stays "Completion pending" until the
  // app next runs. No UI is shown in either case.
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
    let now = Date()
    guard id.range(of: "^(?:[0-9a-f]{24}|[0-9a-f]{32})$",
                   options: .regularExpression) != nil,
          scope.range(of: "^[0-9a-f]{32}$", options: .regularExpression) != nil,
          updatedAt > 0,
          case let .available(snapshot) = ReminderSnapshotStore.load(at: now),
          snapshot.privacyHidden != true,
          snapshot.accountScope == scope,
          TaskWidgetClock.visibleTasks(snapshot, at: now).contains(where: {
            $0.id == id && $0.updatedAt.map(Int.init) == updatedAt
          }) else {
      throw CocoaError(.fileReadUnknown)
    }
    // Durable first. A repeat tap finds the same deterministic filename, and a
    // crash anywhere after this point leaves an action the host will still
    // finish, so the completion is never silently lost or applied twice.
    try WidgetCompletionQueue.enqueue(id: id, scope: scope, updatedAt: updatedAt)
    WidgetCenter.shared.reloadTimelines(ofKind: "ReminderWidget")

    guard let host = NSClassFromString("TaskWidgetCompletionBridge")
            as? TaskWidgetCompletionCommitting.Type else {
      // The widget extension cannot reach the encrypted database. The queued
      // action is the honest result there, and the row shows it as pending.
      return .result()
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
