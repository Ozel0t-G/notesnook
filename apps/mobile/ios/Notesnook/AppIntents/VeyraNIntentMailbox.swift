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

private struct PendingIntentRequest {
  let id: String
  let action: String
  let payload: [String: String]
}

private struct IntentReply {
  let status: String
  let value: String
}

enum VeyraNIntentFailure: LocalizedError {
  case unavailable
  case locked
  case invalidInput
  case notFound
  case ambiguous
  case alreadyCompleted
  case failed

  var errorDescription: String? {
    switch self {
    case .unavailable: return "VeyraN could not finish this action. Open the app and try again."
    case .locked: return "Unlock VeyraN before using this shortcut."
    case .invalidInput: return "Check the shortcut inputs and try again."
    case .notFound:
      return "That Task or List is no longer in VeyraN, or it belongs to another account."
    case .ambiguous: return "More than one List has that name. Use a unique List name."
    case .alreadyCompleted: return "That Task is already completed."
    case .failed: return "VeyraN could not save this action."
    }
  }

  static func from(_ status: String) -> Self {
    switch status {
    case "locked": return .locked
    case "unavailable": return .unavailable
    case "invalid": return .invalidInput
    case "notFound": return .notFound
    case "ambiguous": return .ambiguous
    case "alreadyCompleted": return .alreadyCompleted
    default: return .failed
    }
  }
}

/// Starts this process's React Native host without mounting a UI surface.
///
/// `TaskWidgetReactHost` is the application target's only React Native boot
/// helper and is not widget specific; it is idempotent and returns immediately
/// when a host already exists. An action that does not open the app can be
/// running in a process that has no host yet, and the encrypted Task domain
/// lives entirely in that host.
enum VeyraNReactHost {
  static func ensureStarted() async -> Bool {
    await withCheckedContinuation { continuation in
      TaskWidgetReactHost.ensureStarted { started in
        continuation.resume(returning: started)
      }
    }
  }
}

// Requests contain private user input, so they remain in the host process's
// memory. The host React Native bridge acknowledges domain writes after they
// finish. No extension or custom URL can write Tasks or Notes.
final class VeyraNIntentMailbox {
  static let shared = VeyraNIntentMailbox()
  static let pendingNotification = Notification.Name("veyran.intent.pending")

  private let lock = NSLock()
  private var pending: [String: PendingIntentRequest] = [:]
  private var replies: [String: IntentReply] = [:]

  /// - Parameters:
  ///   - requiresHost: For an action that does not open the app. That process
  ///     may have no React Native instance at all, and the encrypted Task
  ///     domain lives only there, so it is asked to start before this waits.
  ///     A foreground action does not need it: the app is being brought up
  ///     anyway, and its App component starts the host.
  ///   - timeout: How long a definitive answer is worth waiting for. A cold
  ///     start has to load the bundle and open the encrypted database.
  func submit(
    action: String,
    payload: [String: String],
    requiresHost: Bool = false,
    timeout: TimeInterval = 30
  ) async throws -> String {
    let id = UUID().uuidString
    lock.lock()
    pending[id] = PendingIntentRequest(id: id, action: action, payload: payload)
    lock.unlock()
    defer {
      // Cancellation and timeout must not leave private input pending for a
      // later app launch or a different signed-in account.
      lock.lock()
      pending.removeValue(forKey: id)
      replies.removeValue(forKey: id)
      lock.unlock()
    }
    // Registered first, so the host's drain-on-start finds this request even
    // when the bundle finishes loading before the notification below is posted.
    if requiresHost, await VeyraNReactHost.ensureStarted() == false {
      throw VeyraNIntentFailure.unavailable
    }
    DispatchQueue.main.async {
      NotificationCenter.default.post(name: Self.pendingNotification, object: nil)
    }

    for _ in 0..<max(1, Int(timeout * 10)) {
      if let reply = takeReply(id) {
        guard reply.status == "ok" else {
          throw VeyraNIntentFailure.from(reply.status)
        }
        return reply.value
      }
      try await Task.sleep(nanoseconds: 100_000_000)
    }
    throw VeyraNIntentFailure.unavailable
  }

  func requests() -> [[String: Any]] {
    lock.lock()
    defer { lock.unlock() }
    return pending.values.map { request in
      ["id": request.id, "action": request.action, "payload": request.payload]
    }
  }

  func acknowledge(id: String, status: String, value: String) {
    lock.lock()
    defer { lock.unlock() }
    guard pending.removeValue(forKey: id) != nil else { return }
    replies[id] = IntentReply(status: status, value: value)
  }

  private func takeReply(_ id: String) -> IntentReply? {
    lock.lock()
    defer { lock.unlock() }
    return replies.removeValue(forKey: id)
  }
}

@objc(VeyraNIntentModule)
final class VeyraNIntentModule: RCTEventEmitter {
  private var observers: [NSObjectProtocol] = []

  @objc override class func requiresMainQueueSetup() -> Bool { false }
  override func supportedEvents() -> [String]! {
    ["pendingIntent", "pendingCapture"]
  }

  override func startObserving() {
    let intent = NotificationCenter.default.addObserver(
      forName: VeyraNIntentMailbox.pendingNotification,
      object: nil,
      queue: .main
    ) { [weak self] _ in
      self?.sendEvent(withName: "pendingIntent", body: nil)
    }
    let capture = NotificationCenter.default.addObserver(
      forName: Notification.Name("veyran.control.pending"),
      object: nil,
      queue: .main
    ) { [weak self] _ in
      self?.sendEvent(withName: "pendingCapture", body: nil)
    }
    observers = [intent, capture]
  }

  override func stopObserving() {
    observers.forEach { NotificationCenter.default.removeObserver($0) }
    observers = []
  }

  @objc(pendingRequests:rejecter:)
  func pendingRequests(
    _ resolve: RCTPromiseResolveBlock,
    rejecter reject: RCTPromiseRejectBlock
  ) {
    resolve(VeyraNIntentMailbox.shared.requests())
  }

  @objc(acknowledge:status:value:resolver:rejecter:)
  func acknowledge(
    _ id: String,
    status: String,
    value: String,
    resolver resolve: RCTPromiseResolveBlock,
    rejecter reject: RCTPromiseRejectBlock
  ) {
    VeyraNIntentMailbox.shared.acknowledge(id: id, status: status, value: value)
    resolve(nil)
  }

  @objc(consumeCaptureTarget:rejecter:)
  func consumeCaptureTarget(
    _ resolve: RCTPromiseResolveBlock,
    rejecter reject: RCTPromiseRejectBlock
  ) {
    if #available(iOS 18.0, *) {
      resolve(VeyraNControlCapture.consume())
    } else {
      resolve(nil)
    }
  }
}
