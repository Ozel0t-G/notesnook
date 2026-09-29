import CryptoKit
import Foundation
import React

#if canImport(ActivityKit)
import ActivityKit
#endif

#if canImport(AlarmKit)
import AlarmKit
import SwiftUI
#endif

@objc(TaskAlarmModule)
final class TaskAlarmModule: NSObject {
  private static let fingerprintKey = "notesnook.taskAlarms.fingerprints.v2"
  private static let ownedIdsKey = "notesnook.taskAlarms.ownedIds.v1"
  private static let namespace = "com.streetwriters.notesnook.taskAlarm.v1"
  /// How long Snooze postpones the next alert. The Task's own reminder is never
  /// modified, so the occurrence the alarm belongs to stays intact.
  private static let snoozeInterval: TimeInterval = 9 * 60
  /// Result shape shared by every overdue-activity call. `status` mirrors the
  /// alarm authorization names so JS can be honest about unsupported devices
  /// without a second failure channel.
  private static let unsupportedActivityResult: [String: Any] = [
    "status": "unsupported",
    "created": 0,
    "updated": 0,
    "ended": 0,
    "failedTaskIds": [String]()
  ]

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
          var wanted = [WantedAlarm]()
          var invalidTaskIds = [String]()
          for raw in rawAlarms {
            do {
              wanted.append(try Self.parse(raw, accountId: accountId))
            } catch {
              if let taskId = raw["taskId"] as? String { invalidTaskIds.append(taskId) }
            }
          }
          var result = try await Self.replace(wanted)
          if !invalidTaskIds.isEmpty {
            result["failedTaskIds"] = (result["failedTaskIds"] as? [String] ?? []) + invalidTaskIds
          }
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
        for alarm in try manager.alarms where Self.isOwnedAlarm(alarm.id, legacyOwned: owned) {
          try Self.remove(alarm, manager: manager)
        }
        UserDefaults.standard.removeObject(forKey: Self.fingerprintKey)
        UserDefaults.standard.removeObject(forKey: "notesnook.taskAlarms.fingerprints.v1")
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

  /// Reconciles the "Task is overdue and still incomplete" Live Activities with
  /// the caller's desired set. Content is intentionally minimal: an opaque Task
  /// id plus a title the caller has already redacted when App Lock is enabled.
  @objc(syncOverdueActivities:activities:privacyHidden:resolver:rejecter:)
  func syncOverdueActivities(_ accountId: String,
                             activities rawActivities: [NSDictionary],
                             privacyHidden: Bool,
                             resolver resolve: @escaping RCTPromiseResolveBlock,
                             rejecter reject: @escaping RCTPromiseRejectBlock) {
    #if canImport(ActivityKit)
    if #available(iOS 16.2, *) {
      Task {
        do {
          resolve(try await Self.syncOverdueActivities(
            accountId: accountId,
            raw: rawActivities,
            privacyHidden: privacyHidden))
        } catch {
          reject("task_activity_sync", error.localizedDescription, error)
        }
      }
      return
    }
    #endif
    resolve(Self.unsupportedActivityResult)
  }

  /// Ends every overdue Live Activity this app owns. Called on completion, Task
  /// deletion, a removed reminder, a reschedule, Urgent being switched off,
  /// logout and account change, so no surface is left behind.
  @objc(endOverdueActivities:rejecter:)
  func endOverdueActivities(_ resolve: @escaping RCTPromiseResolveBlock,
                            rejecter reject: @escaping RCTPromiseRejectBlock) {
    #if canImport(ActivityKit)
    if #available(iOS 16.2, *) {
      Task {
        do {
          resolve(try await Self.endOverdueActivities())
        } catch {
          reject("task_activity_end", error.localizedDescription, error)
        }
      }
      return
    }
    #endif
    resolve(nil)
  }
}

#if canImport(AlarmKit)
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
    let cleanedTitle = title.unicodeScalars.map { scalar in
      CharacterSet.controlCharacters.contains(scalar) || scalar.value == 0x2028 || scalar.value == 0x2029
        ? " " : String(scalar)
    }.joined()
    let safeTitle = privacyHidden ? "VeyraN Task" : String(cleanedTitle.prefix(120))
    let input = "\(timestamp.doubleValue)|\(privacyHidden)|\(updatedAt.doubleValue)"
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
    bytes.replaceSubrange(0..<5, with: [0x4e, 0x4e, 0x54, 0x41, 0x53])
    bytes[6] = (bytes[6] & 0x0f) | 0x80 // RFC 9562 custom UUID version 8.
    bytes[8] = (bytes[8] & 0x3f) | 0x80
    return UUID(uuid: (bytes[0], bytes[1], bytes[2], bytes[3],
                       bytes[4], bytes[5], bytes[6], bytes[7],
                       bytes[8], bytes[9], bytes[10], bytes[11],
                       bytes[12], bytes[13], bytes[14], bytes[15]))
  }

  static func isOwnedAlarm(_ id: UUID, legacyOwned: Set<String>) -> Bool {
    let bytes = id.uuid
    return (bytes.0 == 0x4e && bytes.1 == 0x4e && bytes.2 == 0x54 &&
            bytes.3 == 0x41 && bytes.4 == 0x53) || legacyOwned.contains(id.uuidString)
  }

  static func remove(_ alarm: Alarm, manager: AlarmManager) throws {
    if alarm.state == .alerting {
      try manager.stop(id: alarm.id)
    } else {
      try manager.cancel(id: alarm.id)
    }
  }

  static func matchesFixedSchedule(_ alarm: Alarm, timestamp: TimeInterval) -> Bool {
    guard case .some(.fixed(let date)) = alarm.schedule else { return false }
    return abs(date.timeIntervalSince1970 - timestamp) < 0.001
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
    let current = try manager.alarms.filter { isOwnedAlarm($0.id, legacyOwned: owned) }
    UserDefaults.standard.removeObject(forKey: "notesnook.taskAlarms.fingerprints.v1")
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
      // 1. A presentation the person is already engaged with at this exact
      //    occurrence is never torn down. `.alerting` is the alarm sounding
      //    (Stop stays a separate user action, so reconciliation must not
      //    silence or complete the Task); `.countdown` is their Snooze and
      //    `.paused` is their Pause. Removing either would silently throw away
      //    a choice the person just made, on the next background reconcile.
      if let existing,
         matchesFixedSchedule(existing, timestamp: item.timestamp),
         existing.state != .scheduled {
        continue
      }
      // 2. A Snooze/Pause that is still running is never cancelled, whatever
      //    the desired schedule now says; the alarm re-alerts when the countdown
      //    ends and the reconcile after that picks up any newer occurrence.
      if let existing,
         existing.state == .countdown || existing.state == .paused {
        continue
      }
      // 3. An unchanged future alarm is left exactly as it is.
      if let existing,
         matchesFixedSchedule(existing, timestamp: item.timestamp),
         fingerprints[item.id.uuidString] == item.fingerprint {
        continue
      }
      // 4. Never drop an occurrence that is due now or in the past. The system
      //    may be about to present it, and removing it here would mean neither
      //    an alarm nor a notification fallback (JS only falls back for the
      //    Task ids reported in `failedTaskIds`), i.e. a silently missed alert.
      //    A content-only change is applied to the next occurrence instead.
      if let existing,
         matchesFixedSchedule(existing, timestamp: item.timestamp),
         item.timestamp <= now {
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
        let snoozeButton = AlarmButton(text: "Snooze", textColor: .white,
                                       systemImageName: "zzz")
        let alert: AlarmPresentation.Alert
        if #available(iOS 26.1, *) {
          alert = AlarmPresentation.Alert(
            title: label,
            secondaryButton: snoozeButton,
            secondaryButtonBehavior: .countdown)
        } else {
          alert = AlarmPresentation.Alert(
            title: label,
            stopButton: AlarmButton(text: "Stop", textColor: .white,
                                    systemImageName: "stop.fill"),
            secondaryButton: snoozeButton,
            secondaryButtonBehavior: .countdown)
        }
        // Snooze is AlarmKit's countdown secondary button: tapping it re-alerts
        // after `postAlert`. `preAlert` stays nil so the alarm is never turned
        // into a timer that fires immediately -- only the schedule decides when
        // it alerts. AlarmKit requires the widget extension to render
        // `AlarmAttributes` whenever a countdown presentation is used, otherwise
        // the system may drop the alarm (see NotesWidget's ActivityConfiguration).
        let countdown = AlarmPresentation.Countdown(
          title: label,
          pauseButton: AlarmButton(text: "Pause", textColor: .white,
                                   systemImageName: "pause.fill"))
        let paused = AlarmPresentation.Paused(
          title: "Paused",
          resumeButton: AlarmButton(text: "Resume", textColor: .white,
                                    systemImageName: "play.fill"))
        let attributes = AlarmAttributes<TaskAlarmMetadata>(
          presentation: AlarmPresentation(alert: alert,
                                         countdown: countdown,
                                         paused: paused),
          tintColor: .green)
        let config = AlarmManager.AlarmConfiguration<TaskAlarmMetadata>(
          countdownDuration: Alarm.CountdownDuration(preAlert: nil,
                                                     postAlert: Self.snoozeInterval),
          schedule: .fixed(Date(timeIntervalSince1970: item.timestamp)),
          attributes: attributes,
          secondaryIntent: TaskAlarmRepeatIntent(alarmID: item.id.uuidString))
        _ = try await manager.schedule(id: item.id, configuration: config)
        fingerprints[item.id.uuidString] = item.fingerprint
      } catch {
        failures.append(item.taskId)
      }
    }

    // The fingerprint uses schedule metadata; Task titles never enter UserDefaults.
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

#if canImport(ActivityKit)
/// The ongoing "Task is overdue and still incomplete" surface.
///
/// This is the only public mechanism that keeps an overdue Task visible on the
/// Lock Screen / Dynamic Island *after* an alarm has been stopped, and it is
/// the only one that can render continuously-updating elapsed time without a
/// JavaScript timer. It is deliberately reconciled from the app (never assumed
/// to be started by an alarm or a notification -- neither can run arbitrary app
/// code), so a surface appears as soon as the app next runs and the occurrence
/// is still within the system's Live Activity lifetime.
@available(iOS 16.2, *)
private extension TaskAlarmModule {
  enum OverdueActivity {
    static let indexKey = "notesnook.taskActivities.index.v1"
    static let suppressedKey = "notesnook.taskActivities.suppressed.v1"
    /// `ActivityAuthorizationError.globalMaximumExceeded` / `.targetMaximumExceeded`
    /// bound how many Live Activities can be live at once: keep a small,
    /// documented cap and prefer the newest overdue Tasks.
    static let maxConcurrent = 5
    /// The system ends a Live Activity after roughly eight hours, so an older
    /// occurrence is never resurrected.
    static let lifetime: TimeInterval = 8 * 60 * 60
    /// How long a per-occurrence "the person dismissed this" marker is kept.
    static let suppressionLifetime: TimeInterval = 7 * 24 * 60 * 60
    /// Shown instead of the Task title while App Lock is on. Matches the alarm
    /// path's placeholder so one decision covers every Urgent/overdue surface.
    static let redactedTitle = "VeyraN Task"
  }

  static var areOverdueActivitiesEnabled: Bool {
    ActivityAuthorizationInfo().areActivitiesEnabled
  }

  /// Raw account ids never enter UserDefaults; a short digest is enough to tell
  /// one signed-in account's surfaces from another's.
  static func accountScope(_ accountId: String) -> String {
    SHA256.hash(data: Data(accountId.utf8)).prefix(8)
      .map { String(format: "%02x", $0) }.joined()
  }

  static func occurrenceKey(_ taskId: String, due: TimeInterval) -> String {
    "\(taskId)\u{1F}\(due)"
  }

  static func activityRecord(_ taskId: String,
                             due: TimeInterval,
                             scope: String) -> String {
    "\(taskId)\u{1F}\(due)\u{1F}\(scope)"
  }

  static func parseActivityRecord(
    _ value: String
  ) -> (taskId: String, due: TimeInterval, scope: String)? {
    let parts = value.split(separator: "\u{1F}", omittingEmptySubsequences: false)
    guard parts.count == 3, let due = TimeInterval(parts[1]) else { return nil }
    return (String(parts[0]), due, String(parts[2]))
  }

  static func activityTitle(_ title: String) -> String {
    let cleaned = title.unicodeScalars.map { scalar in
      CharacterSet.controlCharacters.contains(scalar) ||
        scalar.value == 0x2028 || scalar.value == 0x2029
        ? " " : String(scalar)
    }.joined()
    return String(cleaned.prefix(120))
  }

  static func activityContent(
    due: Date,
    title: String
  ) -> ActivityContent<OverdueTaskActivityAttributes.ContentState> {
    ActivityContent(
      state: OverdueTaskActivityAttributes.ContentState(dueDate: due,
                                                        title: title),
      staleDate: due.addingTimeInterval(OverdueActivity.lifetime))
  }

  static func syncOverdueActivities(
    accountId: String,
    raw: [NSDictionary],
    privacyHidden: Bool
  ) async throws -> [String: Any] {
    let scope = accountScope(accountId)
    let enabled = areOverdueActivitiesEnabled
    var index = UserDefaults.standard
      .dictionary(forKey: OverdueActivity.indexKey) as? [String: String] ?? [:]
    var suppressed = UserDefaults.standard
      .dictionary(forKey: OverdueActivity.suppressedKey) as? [String: TimeInterval] ?? [:]

    var alive = [String: Activity<OverdueTaskActivityAttributes>]()
    for activity in Activity<OverdueTaskActivityAttributes>.activities {
      let state = activity.activityState
      // `.ended`/`.dismissed` entries can linger briefly after the surface is
      // already gone; they must not count as "shown".
      if state == .ended || state == .dismissed { continue }
      alive[activity.id] = activity
    }

    var created = 0
    var updated = 0
    var ended = 0
    var failures = [String]()
    let now = Date().timeIntervalSince1970

    // Anything recorded but no longer shown was dismissed by the person or
    // expired. Remember the occurrence so it is never re-created as a ghost.
    for (activityId, record) in index where alive[activityId] == nil {
      if let parsed = parseActivityRecord(record) {
        suppressed[occurrenceKey(parsed.taskId, due: parsed.due)] = now
      }
      index.removeValue(forKey: activityId)
    }

    var desired = [(taskId: String, due: Date, title: String)]()
    for rawItem in raw {
      guard let taskId = rawItem["taskId"] as? String, !taskId.isEmpty,
            let timestamp = rawItem["timestamp"] as? NSNumber,
            timestamp.doubleValue.isFinite,
            let title = rawItem["title"] as? String
      else { continue }
      // The App Lock placeholder is chosen here, in one place, exactly like the
      // alarm path: the raw title never reaches a surface that App Lock hides.
      desired.append((taskId,
                      Date(timeIntervalSince1970: timestamp.doubleValue / 1000),
                      privacyHidden ? OverdueActivity.redactedTitle : activityTitle(title)))
    }
    desired.sort { $0.due > $1.due }
    if desired.count > OverdueActivity.maxConcurrent {
      desired = Array(desired.prefix(OverdueActivity.maxConcurrent))
    }
    let desiredTaskIds = Set(desired.map(\.taskId))

    var known = [String: (id: String, due: TimeInterval, scope: String)]()
    for (activityId, record) in index {
      guard let parsed = parseActivityRecord(record) else { continue }
      known[parsed.taskId] = (activityId, parsed.due, parsed.scope)
    }

    // Surfaces that no longer belong to an overdue Task, or that belong to a
    // different signed-in account, are ended rather than left behind.
    for (taskId, entry) in known {
      guard let activity = alive[entry.id] else { continue }
      if entry.scope == scope, desiredTaskIds.contains(taskId) { continue }
      await activity.end(nil, dismissalPolicy: .immediate)
      index.removeValue(forKey: entry.id)
      known.removeValue(forKey: taskId)
      ended += 1
    }

    for item in desired {
      let due = item.due.timeIntervalSince1970
      if suppressed[occurrenceKey(item.taskId, due: due)] != nil { continue }

      if let entry = known[item.taskId], let activity = alive[entry.id],
         entry.scope == scope, abs(entry.due - due) < 0.5 {
        // Same occurrence: refresh the dynamic content (a renamed Task, or a
        // title that just became redacted) without recreating the surface.
        let next = activityContent(due: item.due, title: item.title)
        if activity.content.state != next.state {
          await activity.update(next)
          updated += 1
        }
        continue
      }

      if let entry = known[item.taskId], let activity = alive[entry.id] {
        // The Task moved on to a new occurrence: replace the old surface.
        await activity.end(nil, dismissalPolicy: .immediate)
        index.removeValue(forKey: entry.id)
        known.removeValue(forKey: item.taskId)
        ended += 1
      }

      guard enabled else {
        failures.append(item.taskId)
        continue
      }

      do {
        let activity = try Activity.request(
          attributes: OverdueTaskActivityAttributes(taskId: item.taskId),
          content: activityContent(due: item.due, title: item.title),
          pushType: nil)
        index[activity.id] = activityRecord(item.taskId, due: due, scope: scope)
        known[item.taskId] = (activity.id, due, scope)
        created += 1
      } catch {
        failures.append(item.taskId)
      }
    }

    suppressed = suppressed.filter {
      $0.value >= now - OverdueActivity.suppressionLifetime
    }
    UserDefaults.standard.set(index, forKey: OverdueActivity.indexKey)
    UserDefaults.standard.set(suppressed, forKey: OverdueActivity.suppressedKey)

    return ["status": enabled ? "authorized" : "denied",
            "created": created,
            "updated": updated,
            "ended": ended,
            "failedTaskIds": failures]
  }

  static func endOverdueActivities() async throws -> [String: Any] {
    var ended = 0
    for activity in Activity<OverdueTaskActivityAttributes>.activities {
      await activity.end(nil, dismissalPolicy: .immediate)
      ended += 1
    }
    // These are deliberate ends, not dismissals: clear the bookkeeping so the
    // Task can surface again when it is genuinely overdue next time, and never
    // leave a stale marker behind.
    UserDefaults.standard.removeObject(forKey: OverdueActivity.indexKey)
    UserDefaults.standard.removeObject(forKey: OverdueActivity.suppressedKey)
    return ["status": areOverdueActivitiesEnabled ? "authorized" : "denied",
            "ended": ended]
  }
}
#endif
