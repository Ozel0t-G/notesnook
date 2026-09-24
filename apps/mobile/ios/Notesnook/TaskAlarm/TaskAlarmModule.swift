import CryptoKit
import Foundation
import React

#if canImport(AlarmKit)
import AlarmKit
import SwiftUI
#endif

@objc(TaskAlarmModule)
final class TaskAlarmModule: NSObject {
  private static let fingerprintKey = "notesnook.taskAlarms.fingerprints.v1"
  private static let ownedIdsKey = "notesnook.taskAlarms.ownedIds.v1"
  private static let namespace = "com.ozel0t.notesnook.taskAlarm.v1"

  @objc static func requiresMainQueueSetup() -> Bool { false }

  @objc(status:rejecter:)
  func status(_ resolve: @escaping RCTPromiseResolveBlock,
              rejecter reject: @escaping RCTPromiseRejectBlock) {
    #if canImport(AlarmKit)
    if #available(iOS 26.0, *) {
      resolve(Self.statusName(AlarmManager.shared.authorizationState))
      return
    }
    #endif
    resolve("unsupported")
  }

  @objc(requestAuthorization:rejecter:)
  func requestAuthorization(_ resolve: @escaping RCTPromiseResolveBlock,
                            rejecter reject: @escaping RCTPromiseRejectBlock) {
    #if canImport(AlarmKit)
    if #available(iOS 26.0, *) {
      Task {
        do {
          let manager = AlarmManager.shared
          let current = manager.authorizationState
          let result = current == .notDetermined
            ? try await manager.requestAuthorization() : current
          resolve(Self.statusName(result))
        } catch {
          reject("task_alarm_authorization", error.localizedDescription, error)
        }
      }
      return
    }
    #endif
    resolve("unsupported")
  }

  @objc(replaceAlarms:alarms:resolver:rejecter:)
  func replaceAlarms(_ accountId: String,
                     alarms rawAlarms: [NSDictionary],
                     resolver resolve: @escaping RCTPromiseResolveBlock,
                     rejecter reject: @escaping RCTPromiseRejectBlock) {
    #if canImport(AlarmKit)
    if #available(iOS 26.0, *) {
      Task {
        do {
          let wanted = try rawAlarms.map { try Self.parse($0, accountId: accountId) }
          let result = try await Self.replace(wanted)
          resolve(result)
        } catch {
          reject("task_alarm_reconcile", error.localizedDescription, error)
        }
      }
      return
    }
    #endif
    resolve(["status": "unsupported", "failedTaskIds": []])
  }

  @objc(cancelAll:rejecter:)
  func cancelAll(_ resolve: @escaping RCTPromiseResolveBlock,
                 rejecter reject: @escaping RCTPromiseRejectBlock) {
    #if canImport(AlarmKit)
    if #available(iOS 26.0, *) {
      do {
        let manager = AlarmManager.shared
        let owned = Set(UserDefaults.standard.stringArray(forKey: Self.ownedIdsKey) ?? [])
        for alarm in try manager.alarms where owned.contains(alarm.id.uuidString) {
          try Self.remove(alarm, manager: manager)
        }
        UserDefaults.standard.removeObject(forKey: Self.fingerprintKey)
        UserDefaults.standard.removeObject(forKey: Self.ownedIdsKey)
        resolve(nil)
      } catch {
        reject("task_alarm_cancel", error.localizedDescription, error)
      }
      return
    }
    #endif
    resolve(nil)
  }
}

#if canImport(AlarmKit)
@available(iOS 26.0, *)
private struct TaskAlarmMetadata: AlarmMetadata {}

@available(iOS 26.0, *)
private struct WantedAlarm {
  let id: UUID
  let taskId: String
  let timestamp: TimeInterval
  let title: String
  let fingerprint: String
}

@available(iOS 26.0, *)
private extension TaskAlarmModule {
  static func statusName(_ state: AlarmManager.AuthorizationState) -> String {
    switch state {
    case .authorized: return "authorized"
    case .denied: return "denied"
    case .notDetermined: return "notDetermined"
    @unknown default: return "unsupported"
    }
  }

  static func parse(_ value: NSDictionary, accountId: String) throws -> WantedAlarm {
    guard !accountId.isEmpty,
          let taskId = value["taskId"] as? String, !taskId.isEmpty,
          let timestamp = value["timestamp"] as? NSNumber,
          timestamp.doubleValue.isFinite,
          let title = value["title"] as? String,
          let updatedAt = value["updatedAt"] as? NSNumber,
          let privacyHidden = value["privacyHidden"] as? Bool,
          let alarmKey = value["alarmKey"] as? String, !alarmKey.isEmpty
    else { throw TaskAlarmError.invalidInput }

    let id = alarmId(accountId: accountId, alarmKey: alarmKey)
    let safeTitle = privacyHidden ? "Notesnook Task" : String(title.prefix(120))
    let input = "\(timestamp.doubleValue)|\(privacyHidden)|\(safeTitle)"
    let fingerprint = SHA256.hash(data: Data(input.utf8))
      .map { String(format: "%02x", $0) }.joined()
    return WantedAlarm(id: id, taskId: taskId,
                       timestamp: timestamp.doubleValue / 1000,
                       title: safeTitle, fingerprint: fingerprint)
  }

  static func alarmId(accountId: String, alarmKey: String) -> UUID {
    let input = "\(namespace):\(accountId):\(alarmKey)"
    let digest = SHA256.hash(data: Data(input.utf8))
    var bytes = Array(digest.prefix(16))
    bytes[6] = (bytes[6] & 0x0f) | 0x80 // RFC 9562 custom UUID version 8.
    bytes[8] = (bytes[8] & 0x3f) | 0x80
    return UUID(uuid: (bytes[0], bytes[1], bytes[2], bytes[3],
                       bytes[4], bytes[5], bytes[6], bytes[7],
                       bytes[8], bytes[9], bytes[10], bytes[11],
                       bytes[12], bytes[13], bytes[14], bytes[15]))
  }

  static func remove(_ alarm: Alarm, manager: AlarmManager) throws {
    if alarm.state == .alerting {
      try manager.stop(id: alarm.id)
    } else {
      try manager.cancel(id: alarm.id)
    }
  }

  static func replace(_ wanted: [WantedAlarm]) async throws -> [String: Any] {
    let manager = AlarmManager.shared
    let state = manager.authorizationState
    guard state == .authorized else {
      UserDefaults.standard.removeObject(forKey: fingerprintKey)
      return ["status": statusName(state), "failedTaskIds": wanted.map(\.taskId)]
    }
    let desired = Dictionary(uniqueKeysWithValues: wanted.map { ($0.id, $0) })
    var owned = Set(UserDefaults.standard.stringArray(forKey: ownedIdsKey) ?? [])
    let current = try manager.alarms.filter { owned.contains($0.id.uuidString) }
    var fingerprints = UserDefaults.standard.dictionary(forKey: fingerprintKey) as? [String: String] ?? [:]

    for alarm in current where desired[alarm.id] == nil {
      try remove(alarm, manager: manager)
      fingerprints.removeValue(forKey: alarm.id.uuidString)
      owned.remove(alarm.id.uuidString)
    }

    let currentById = Dictionary(uniqueKeysWithValues: current.map { ($0.id, $0) })
    var failures = [String]()
    let now = Date().timeIntervalSince1970
    for item in wanted {
      let existing = currentById[item.id]
      if let existing, existing.state == .alerting,
         existing.schedule == .fixed(Date(timeIntervalSince1970: item.timestamp)) {
        continue // Stop is a separate user action; never complete or silence the Task here.
      }
      if let existing,
         existing.state == .scheduled,
         existing.schedule == .fixed(Date(timeIntervalSince1970: item.timestamp)),
         fingerprints[item.id.uuidString] == item.fingerprint {
        continue
      }
      if let existing {
        do { try remove(existing, manager: manager) }
        catch { failures.append(item.taskId); continue }
      }
      fingerprints.removeValue(forKey: item.id.uuidString)
      if item.timestamp <= now { continue } // Stopped one-time alarms remain stopped.

      do {
        // Persist ownership before scheduling so a crash cannot orphan this alarm.
        owned.insert(item.id.uuidString)
        UserDefaults.standard.set(Array(owned), forKey: ownedIdsKey)
        let label = LocalizedStringResource(stringLiteral: item.title)
        let alert: AlarmPresentation.Alert
        if #available(iOS 26.1, *) {
          alert = AlarmPresentation.Alert(title: label)
        } else {
          alert = AlarmPresentation.Alert(
            title: label,
            stopButton: AlarmButton(text: "Stop", textColor: .white,
                                    systemImageName: "stop.fill"))
        }
        let attributes = AlarmAttributes<TaskAlarmMetadata>(
          presentation: AlarmPresentation(alert: alert),
          tintColor: .green)
        let config = AlarmManager.AlarmConfiguration<TaskAlarmMetadata>.alarm(
          schedule: .fixed(Date(timeIntervalSince1970: item.timestamp)),
          attributes: attributes)
        _ = try await manager.schedule(id: item.id, configuration: config)
        fingerprints[item.id.uuidString] = item.fingerprint
      } catch {
        failures.append(item.taskId)
      }
    }

    // A Task title never enters UserDefaults; only its one-way configuration fingerprint does.
    UserDefaults.standard.set(fingerprints, forKey: fingerprintKey)
    UserDefaults.standard.set(Array(owned), forKey: ownedIdsKey)
    return ["status": "authorized", "failedTaskIds": failures]
  }

  enum TaskAlarmError: LocalizedError {
    case invalidInput
    var errorDescription: String? { "Invalid Task alarm input." }
  }
}
#endif
