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

import Foundation
import React

private struct PendingCompletionRequest {
  let requestId: String
  let taskId: String
  let scope: String
  let updatedAt: Int
  let filename: String
}

/// Carries one widget tap to the host JavaScript and waits for its verdict.
///
/// Requests stay in this process's memory: the durable part of a tap is the App
/// Group action file, and the host only replies here once that file has been
/// acknowledged, so a reply is always a statement about persisted state. A
/// crash before the reply loses nothing but the reply.
final class TaskWidgetCompletionMailbox {
  static let shared = TaskWidgetCompletionMailbox()
  static let pendingNotification = Notification.Name("veyran.taskWidget.completionPending")

  private let lock = NSLock()
  private var pending: [String: PendingCompletionRequest] = [:]
  private var replies: [String: String] = [:]

  func submit(
    taskId: String, scope: String, updatedAt: Int, filename: String, timeout: TimeInterval
  ) async -> String {
    let requestId = register(
      taskId: taskId, scope: scope, updatedAt: updatedAt, filename: filename)
    // Cancellation and a timeout must not leave a request for a later, possibly
    // differently signed-in, run of this process to answer.
    defer { discard(requestId) }
    DispatchQueue.main.async {
      NotificationCenter.default.post(name: Self.pendingNotification, object: nil)
    }

    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
      if let reply = takeReply(requestId) { return reply }
      do {
        try await Task.sleep(nanoseconds: 100_000_000)
      } catch {
        return "failed"
      }
    }
    // A cold start that never got as far as a verdict. The action is still
    // queued, so reporting a failure keeps the widget honest and recoverable.
    return "failed"
  }

  private func register(
    taskId: String, scope: String, updatedAt: Int, filename: String
  ) -> String {
    let requestId = UUID().uuidString
    lock.lock()
    defer { lock.unlock() }
    pending[requestId] = PendingCompletionRequest(
      requestId: requestId, taskId: taskId, scope: scope,
      updatedAt: updatedAt, filename: filename)
    return requestId
  }

  private func discard(_ requestId: String) {
    lock.lock()
    defer { lock.unlock() }
    pending.removeValue(forKey: requestId)
    replies.removeValue(forKey: requestId)
  }

  func requests() -> [[String: Any]] {
    lock.lock()
    defer { lock.unlock() }
    return pending.values.map { request in
      [
        "requestId": request.requestId,
        "taskId": request.taskId,
        "scope": request.scope,
        "updatedAt": request.updatedAt,
        "filename": request.filename
      ]
    }
  }

  func resolve(requestId: String, outcome: String) {
    lock.lock()
    defer { lock.unlock() }
    guard pending.removeValue(forKey: requestId) != nil else { return }
    replies[requestId] = outcome
  }

  private func takeReply(_ requestId: String) -> String? {
    lock.lock()
    defer { lock.unlock() }
    return replies.removeValue(forKey: requestId)
  }
}

/// The app target's implementation of the shared intent's commit hook. The
/// widget extension has no such class, which is how the intent detects that it
/// cannot commit there.
@objc(TaskWidgetCompletionBridge)
final class TaskWidgetCompletionBridge: NSObject, TaskWidgetCompletionCommitting {
  /// Long enough for a cold start to load the bundle, open the encrypted
  /// database and run its migrations check, and short enough to answer the
  /// system within the background execution the intent is given.
  private static let timeout: TimeInterval = 25

  static func commitWidgetCompletion(
    taskId: String, scope: String, updatedAt: Int, filename: String
  ) async -> String {
    guard await startReactNative() else { return "unavailable" }
    return await TaskWidgetCompletionMailbox.shared.submit(
      taskId: taskId, scope: scope, updatedAt: updatedAt,
      filename: filename, timeout: timeout)
  }

  private static func startReactNative() async -> Bool {
    await withCheckedContinuation { continuation in
      TaskWidgetReactHost.ensureStarted { started in
        continuation.resume(returning: started)
      }
    }
  }
}

@objc(TaskWidgetCompletionModule)
final class TaskWidgetCompletionModule: RCTEventEmitter {
  private var observer: NSObjectProtocol?

  @objc override class func requiresMainQueueSetup() -> Bool { false }

  override func supportedEvents() -> [String]! { ["pendingTaskWidgetCompletion"] }

  override func startObserving() {
    observer = NotificationCenter.default.addObserver(
      forName: TaskWidgetCompletionMailbox.pendingNotification,
      object: nil,
      queue: .main
    ) { [weak self] _ in
      self?.sendEvent(withName: "pendingTaskWidgetCompletion", body: nil)
    }
    // On the cold start the intent itself triggered, the request is submitted
    // while the bundle is still loading, so its notification can be posted
    // before this observer exists. Anything still waiting is announced now.
    if !TaskWidgetCompletionMailbox.shared.requests().isEmpty {
      sendEvent(withName: "pendingTaskWidgetCompletion", body: nil)
    }
  }

  override func stopObserving() {
    if let observer { NotificationCenter.default.removeObserver(observer) }
    observer = nil
  }

  @objc(pendingRequests:rejecter:)
  func pendingRequests(
    _ resolve: RCTPromiseResolveBlock,
    rejecter reject: RCTPromiseRejectBlock
  ) {
    resolve(TaskWidgetCompletionMailbox.shared.requests())
  }

  @objc(resolveRequest:outcome:resolver:rejecter:)
  func resolveRequest(
    _ requestId: String,
    outcome: String,
    resolver resolve: RCTPromiseResolveBlock,
    rejecter reject: RCTPromiseRejectBlock
  ) {
    TaskWidgetCompletionMailbox.shared.resolve(requestId: requestId, outcome: outcome)
    resolve(nil)
  }
}
