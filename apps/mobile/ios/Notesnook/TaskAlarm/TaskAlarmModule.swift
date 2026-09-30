import CryptoKit
import Foundation
import React

// AlarmKit/ActivityKit import on Mac Catalyst but their types are unavailable there.
#if canImport(ActivityKit) && !targetEnvironment(macCatalyst)
import ActivityKit
#endif

#if canImport(AlarmKit) && !targetEnvironment(macCatalyst)
import AlarmKit
import SwiftUI
#endif

@objc(TaskAlarmModule)
final class TaskAlarmModule: NSObject {
  private static let fingerprintKey = "notesnook.taskAlarms.fingerprints.v2"
  private static let ownedIdsKey = "notesnook.taskAlarms.ownedIds.v1"
  /// Alarm ids whose presentation was created with the App Lock placeholder, so
  /// turning App Lock on can tell which held presentations still show the real
  /// Task title. Ids only: never a title, an account or any other content.
  private static let redactedIdsKey = "notesnook.taskAlarms.redactedIds.v1"
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
    #if canImport(AlarmKit) && !targetEnvironment(macCatalyst)
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
    #if canImport(AlarmKit) && !targetEnvironment(macCatalyst)
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

  /// Reconciles the Urgent alarms and answers per occurrence: every alarm key
  /// this app holds for the account after the pass. An occurrence missing from
  /// `scheduledAlarmKeys` is not scheduled (unsupported/denied, malformed input
  /// or an individual scheduling failure), so JS gives exactly that occurrence a
  /// notification fallback and never duplicates an alarm that did schedule.
  @objc(replaceAlarms:alarms:resolver:rejecter:)
  func replaceAlarms(_ accountId: String,
                     alarms rawAlarms: [NSDictionary],
                     resolver resolve: @escaping RCTPromiseResolveBlock,
                     rejecter reject: @escaping RCTPromiseRejectBlock) {
    #if canImport(AlarmKit) && !targetEnvironment(macCatalyst)
    if #available(iOS 26.0, *) {
      Task {
        do {
          var wanted = [WantedAlarm]()
          for raw in rawAlarms {
            if let alarm = try? Self.parse(raw, accountId: accountId) {
              wanted.append(alarm)
            }
          }
          resolve(try await Self.replace(wanted))
        } catch {
          reject("task_alarm_reconcile", error.localizedDescription, error)
        }
      }
      return
    }
    #endif
    resolve(["status": "unsupported", "scheduledAlarmKeys": [String](),
             "unredactedAlarmKeys": [String]()])
  }

  /// Reports which of `alarmKeys` the system currently holds for the account,
  /// and which of those are presenting right now (alerting, counting down after
  /// a Snooze, or paused). Used before a reconcile writes anything -- so an
  /// unknown native state keeps every existing fallback instead of guessing --
  /// and again after a failed one, to resolve the truth.
  @objc(verifyAlarms:alarmKeys:resolver:rejecter:)
  func verifyAlarms(_ accountId: String,
                    alarmKeys rawKeys: [String],
                    resolver resolve: @escaping RCTPromiseResolveBlock,
                    rejecter reject: @escaping RCTPromiseRejectBlock) {
    #if canImport(AlarmKit) && !targetEnvironment(macCatalyst)
    if #available(iOS 26.0, *) {
      do {
        let manager = AlarmManager.shared
        let owned = Set(UserDefaults.standard.stringArray(forKey: Self.ownedIdsKey) ?? [])
        var keyByAlarmId = [UUID: String]()
        for key in rawKeys where !key.isEmpty {
          keyByAlarmId[Self.alarmId(accountId: accountId, alarmKey: key)] = key
        }
        var held = [String]()
        var active = [String]()
        for alarm in try manager.alarms
        where Self.isOwnedAlarm(alarm.id, legacyOwned: owned) {
          guard let key = keyByAlarmId[alarm.id] else { continue }
          held.append(key)
          if alarm.state != .scheduled { active.append(key) }
        }
        resolve(["status": Self.statusName(manager.authorizationState),
                 "scheduledAlarmKeys": held,
                 "activeAlarmKeys": active])
      } catch {
        reject("task_alarm_verify", error.localizedDescription, error)
      }
      return
    }
    #endif
    resolve(["status": "unsupported", "scheduledAlarmKeys": [String](),
             "activeAlarmKeys": [String]()])
  }

  /// Cancels only alarms that have not started alerting (`.scheduled`). An alarm
  /// that is alerting, counting down (Snooze) or paused is a choice the person
  /// just made and is never cancelled to make room for a notification fallback;
  /// it is reported back as retained so the caller can be honest about which
  /// occurrences are still held.
  @objc(cancelScheduledAlarms:alarmKeys:resolver:rejecter:)
  func cancelScheduledAlarms(_ accountId: String,
                             alarmKeys rawKeys: [String],
                             resolver resolve: @escaping RCTPromiseResolveBlock,
                             rejecter reject: @escaping RCTPromiseRejectBlock) {
    #if canImport(AlarmKit) && !targetEnvironment(macCatalyst)
    if #available(iOS 26.0, *) {
      do {
        let manager = AlarmManager.shared
        var owned = Set(UserDefaults.standard.stringArray(forKey: Self.ownedIdsKey) ?? [])
        var fingerprints = UserDefaults.standard.dictionary(forKey: Self.fingerprintKey) as? [String: String] ?? [:]
        var redacted = Set(UserDefaults.standard.stringArray(forKey: Self.redactedIdsKey) ?? [])
        var keyByAlarmId = [UUID: String]()
        var requested = [String]()
        for key in rawKeys where !key.isEmpty {
          keyByAlarmId[Self.alarmId(accountId: accountId, alarmKey: key)] = key
          if !requested.contains(key) { requested.append(key) }
        }
        let alarms = try manager.alarms
        let initiallyHeldIds = Set(alarms.map { $0.id.uuidString })
        var cancelled = [String]()
        var retained = [String]()
        for alarm in alarms {
          guard let key = keyByAlarmId[alarm.id],
                Self.isOwnedAlarm(alarm.id, legacyOwned: owned)
          else { continue }
          guard alarm.state == .scheduled else {
            retained.append(key)
            continue
          }
          do {
            try manager.cancel(id: alarm.id)
            fingerprints.removeValue(forKey: alarm.id.uuidString)
            redacted.remove(alarm.id.uuidString)
            owned.remove(alarm.id.uuidString)
            cancelled.append(key)
          } catch {
            // The alarm is still held, so it is reported as retained rather than
            // as a clean cancellation the caller could fall back on.
            retained.append(key)
          }
        }
        // Every requested key is accounted for: one the system does not hold at
        // all is *provably* not scheduled, which is a different (and safe) fact
        // from "not answered", so the caller can fall back for it.
        var notFound = [String]()
        for key in requested {
          let id = Self.alarmId(accountId: accountId, alarmKey: key)
          if !initiallyHeldIds.contains(id.uuidString) { notFound.append(key) }
        }
        // Bookkeeping for an owned alarm the system no longer holds (it ended,
        // was dismissed, or was cancelled from elsewhere) is stale and is
        // pruned here, so it can never make a later pass believe it still owns
        // a presentation that is gone.
        let remainingHeldIds = Set((try manager.alarms).map { $0.id.uuidString })
        owned = owned.filter { remainingHeldIds.contains($0) }
        fingerprints = fingerprints.filter { remainingHeldIds.contains($0.key) }
        redacted = redacted.filter { remainingHeldIds.contains($0) }
        UserDefaults.standard.set(fingerprints, forKey: Self.fingerprintKey)
        UserDefaults.standard.set(Array(redacted), forKey: Self.redactedIdsKey)
        UserDefaults.standard.set(Array(owned), forKey: Self.ownedIdsKey)
        resolve(["status": Self.statusName(manager.authorizationState),
                 "cancelledAlarmKeys": cancelled,
                 "retainedAlarmKeys": retained,
                 "notFoundAlarmKeys": notFound])
      } catch {
        reject("task_alarm_cancel_scheduled", error.localizedDescription, error)
      }
      return
    }
    #endif
    resolve(["status": "unsupported", "cancelledAlarmKeys": [String](),
             "retainedAlarmKeys": [String](), "notFoundAlarmKeys": [String]()])
  }

  @objc(cancelAll:rejecter:)
  func cancelAll(_ resolve: @escaping RCTPromiseResolveBlock,
                 rejecter reject: @escaping RCTPromiseRejectBlock) {
    #if canImport(AlarmKit) && !targetEnvironment(macCatalyst)
    if #available(iOS 26.0, *) {
      do {
        let manager = AlarmManager.shared
        var owned = Set(UserDefaults.standard.stringArray(forKey: Self.ownedIdsKey) ?? [])
        var fingerprints = UserDefaults.standard.dictionary(forKey: Self.fingerprintKey) as? [String: String] ?? [:]
        var redacted = Set(UserDefaults.standard.stringArray(forKey: Self.redactedIdsKey) ?? [])
        var failed = 0
        // Every owned alarm is attempted, so one stubborn presentation cannot
        // stop the rest of the account's surfaces from being removed.
        for alarm in try manager.alarms where Self.isOwnedAlarm(alarm.id, legacyOwned: owned) {
          do {
            try Self.remove(alarm, manager: manager)
            fingerprints.removeValue(forKey: alarm.id.uuidString)
            redacted.remove(alarm.id.uuidString)
            owned.remove(alarm.id.uuidString)
          } catch {
            failed += 1
          }
        }
        // Persist the pruned bookkeeping even on a partial failure, so a retry
        // only has to consider what the system really still holds.
        UserDefaults.standard.set(fingerprints, forKey: Self.fingerprintKey)
        UserDefaults.standard.set(Array(redacted), forKey: Self.redactedIdsKey)
        UserDefaults.standard.set(Array(owned), forKey: Self.ownedIdsKey)
        guard failed == 0 else {
          // Something is still held: reject rather than report a clean sweep, so
          // the caller keeps the cleanup obligation and retries it later.
          reject("task_alarm_cancel",
                 "\(failed) Task alarm(s) could not be removed.",
                 nil)
          return
        }
        // Confirmed clear: drop every trace of the bookkeeping.
        UserDefaults.standard.removeObject(forKey: Self.fingerprintKey)
        UserDefaults.standard.removeObject(forKey: "notesnook.taskAlarms.fingerprints.v1")
        UserDefaults.standard.removeObject(forKey: Self.ownedIdsKey)
        UserDefaults.standard.removeObject(forKey: Self.redactedIdsKey)
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
    #if canImport(ActivityKit) && !targetEnvironment(macCatalyst)
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
    #if canImport(ActivityKit) && !targetEnvironment(macCatalyst)
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

#if canImport(AlarmKit) && !targetEnvironment(macCatalyst)
@available(iOS 26.0, *)
private struct WantedAlarm {
  let id: UUID
  let taskId: String
  /// The stable per-occurrence identity the caller used, echoed back so the
  /// reconcile answer names the exact occurrence (not the whole Task).
  let alarmKey: String
  let timestamp: TimeInterval
  let title: String
  let fingerprint: String
  /// Whether the presentation was built with the App Lock placeholder. Held so
  /// App Lock turning on can tell a presentation that still shows the real Task
  /// title from one that is already redacted.
  let privacyHidden: Bool
  /// The Task's List color; the alarm is tinted with it.
  var tint: Color? = nil
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
    // Under App Lock the alarm says what is due and when ("Urgent Task due
    // (13:20)"), never the Task itself.
    let redactedTitle = (value["redactedTitle"] as? String)
      .map { String($0.prefix(60)) } ?? "VeyraN Task"
    let safeTitle = privacyHidden ? redactedTitle : String(cleanedTitle.prefix(120))
    let tint = (value["tint"] as? String).flatMap(Self.color(hex:))
    let input = "\(timestamp.doubleValue)|\(privacyHidden)|\(updatedAt.doubleValue)"
    let fingerprint = SHA256.hash(data: Data(input.utf8))
      .map { String(format: "%02x", $0) }.joined()
    return WantedAlarm(id: id, taskId: taskId, alarmKey: alarmKey,
                       timestamp: timestamp.doubleValue / 1000,
                       title: safeTitle, fingerprint: fingerprint,
                       privacyHidden: privacyHidden, tint: tint)
  }

  static func color(hex: String) -> Color? {
    var value = hex.trimmingCharacters(in: .whitespaces)
    guard value.hasPrefix("#") else { return nil }
    value.removeFirst()
    if value.count == 3 { value = value.map { "\($0)\($0)" }.joined() }
    guard value.count == 6 || value.count == 8,
          let number = UInt64(value, radix: 16) else { return nil }
    let rgb = value.count == 8 ? number >> 8 : number
    return Color(red: Double((rgb >> 16) & 0xff) / 255,
                 green: Double((rgb >> 8) & 0xff) / 255,
                 blue: Double(rgb & 0xff) / 255)
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
    // De-duplicated rather than trapped: the JS planner already collapses two
    // occurrences onto one alarm key, but a malformed/duplicated call must never
    // crash the app mid-reconcile (which would abort the bookkeeping below).
    let desired = Dictionary(wanted.map { ($0.id, $0) }, uniquingKeysWith: { _, last in last })
    var owned = Set(UserDefaults.standard.stringArray(forKey: ownedIdsKey) ?? [])
    var fingerprints = UserDefaults.standard.dictionary(forKey: fingerprintKey) as? [String: String] ?? [:]
    var redacted = Set(UserDefaults.standard.stringArray(forKey: redactedIdsKey) ?? [])
    // The per-occurrence truth handed back to JS: keys this app holds after the
    // pass. Anything absent is not scheduled, so exactly those occurrences get
    // the notification fallback. `active` is the subset presenting right now.
    var scheduled = [String]()
    var active = [String]()
    // Occurrences whose live alarm still shows the real Task title although App
    // Lock is on. Reported separately so privacy is never silently claimed: the
    // occurrence is still *held* (so JS adds no duplicate fallback for it), but
    // the caller must not treat the pass as a clean redaction.
    var unredacted = [String]()
    guard state == .authorized else {
      // Nothing new can be scheduled, but alarms that were scheduled while the
      // app *was* authorized can still be held and still sound. They are cleaned
      // up here -- except a presentation the person is engaged with -- and
      // reported back, so JS never grants a duplicate fallback for an occurrence
      // whose alarm is still there.
      for alarm in try manager.alarms where isOwnedAlarm(alarm.id, legacyOwned: owned) {
        let key = desired[alarm.id]?.alarmKey
        if alarm.state == .scheduled {
          do {
            try manager.cancel(id: alarm.id)
            fingerprints.removeValue(forKey: alarm.id.uuidString)
            redacted.remove(alarm.id.uuidString)
            owned.remove(alarm.id.uuidString)
          } catch {
            // Still held and not presenting: it is reported as held (so no
            // fallback duplicates it) but never as `active`, because a
            // `.scheduled` alarm is not presenting.
            if let key {
              scheduled.append(key)
              if desired[alarm.id]?.privacyHidden == true &&
                 !redacted.contains(alarm.id.uuidString) {
                unredacted.append(key)
              }
            }
          }
        } else if let key {
          // A presentation the person is engaged with (alerting, counting down
          // after a Snooze, or paused) is retained, and it *is* presenting now.
          scheduled.append(key)
          active.append(key)
          if desired[alarm.id]?.privacyHidden == true &&
             !redacted.contains(alarm.id.uuidString) {
            unredacted.append(key)
          }
        }
      }
      UserDefaults.standard.set(fingerprints, forKey: fingerprintKey)
      UserDefaults.standard.set(Array(redacted), forKey: redactedIdsKey)
      UserDefaults.standard.set(Array(owned), forKey: ownedIdsKey)
      return ["status": statusName(state),
              "scheduledAlarmKeys": scheduled,
              "activeAlarmKeys": active,
              "unredactedAlarmKeys": unredacted]
    }
    let current = try manager.alarms.filter { isOwnedAlarm($0.id, legacyOwned: owned) }
    UserDefaults.standard.removeObject(forKey: "notesnook.taskAlarms.fingerprints.v1")

    for alarm in current where desired[alarm.id] == nil {
      try remove(alarm, manager: manager)
      fingerprints.removeValue(forKey: alarm.id.uuidString)
      redacted.remove(alarm.id.uuidString)
      owned.remove(alarm.id.uuidString)
    }

    let currentById = Dictionary(current.map { ($0.id, $0) },
                                uniquingKeysWith: { first, _ in first })
    let now = Date().timeIntervalSince1970
    for item in wanted {
      let existing = currentById[item.id]
      // 0. App Lock is on and this held presentation was created with a real
      //    Task title. AlarmKit has no in-place presentation update, so a
      //    *future* `.scheduled` alarm is removed with the supported cancel call
      //    and re-created below from the placeholder -- its alert time is
      //    preserved exactly, so nothing is dropped and nothing is duplicated.
      //    A presentation that has already started (`.alerting`/`.countdown`/
      //    `.paused`) or that is due now is **never** torn down and never
      //    re-scheduled on a past instant: that would either duplicate an alert
      //    the person is already being shown or silently drop a live one. Such
      //    an occurrence is reported in `unredactedAlarmKeys` instead, so the
      //    caller stays honest about a real title App Lock cannot hide in place.
      var privacyRemoval = false
      if let existing, item.privacyHidden,
         !redacted.contains(existing.id.uuidString) {
        if existing.state == .scheduled, item.timestamp > now {
          do {
            try remove(existing, manager: manager)
            fingerprints.removeValue(forKey: existing.id.uuidString)
            redacted.remove(existing.id.uuidString)
            owned.remove(existing.id.uuidString)
            privacyRemoval = true
          } catch {
            // The unredacted presentation could not be removed with the call
            // its state asked for. Try the other supported call once before
            // giving up; either way the failure is never reported as a clean
            // redaction.
            do {
              try manager.stop(id: existing.id)
              fingerprints.removeValue(forKey: existing.id.uuidString)
              redacted.remove(existing.id.uuidString)
              owned.remove(existing.id.uuidString)
              // The leaking presentation is gone, so this occurrence is no
              // longer held: it stays out of `scheduled` and JS may give it the
              // redacted notification fallback instead of a missed alert.
              continue
            } catch {
              // Still shown with the real title: report the occurrence as held
              // (so JS adds no fallback that would duplicate it) *and* as
              // unredacted, so the failure is surfaced rather than swallowed.
              scheduled.append(item.alarmKey)
              if existing.state != .scheduled { active.append(item.alarmKey) }
              unredacted.append(item.alarmKey)
              continue
            }
          }
        } else {
          // Cannot be redacted in place (already presenting, or due now). It is
          // deliberately left running and reported honestly; it is never
          // re-scheduled on a past timestamp and never duplicated.
          unredacted.append(item.alarmKey)
          scheduled.append(item.alarmKey)
          if existing.state != .scheduled { active.append(item.alarmKey) }
          continue
        }
      }
      // 1. A presentation the person is already engaged with at this exact
      //    occurrence is never torn down. `.alerting` is the alarm sounding
      //    (Stop stays a separate user action, so reconciliation must not
      //    silence or complete the Task); `.countdown` is their Snooze and
      //    `.paused` is their Pause. Removing either would silently throw away
      //    a choice the person just made, on the next background reconcile.
      if !privacyRemoval, let existing,
         matchesFixedSchedule(existing, timestamp: item.timestamp),
         existing.state != .scheduled {
        scheduled.append(item.alarmKey)
        active.append(item.alarmKey)
        continue
      }
      // 2. A Snooze/Pause that is still running is never cancelled, whatever
      //    the desired schedule now says; the alarm re-alerts when the countdown
      //    ends and the reconcile after that picks up any newer occurrence.
      if !privacyRemoval, let existing,
         existing.state == .countdown || existing.state == .paused {
        scheduled.append(item.alarmKey)
        active.append(item.alarmKey)
        continue
      }
      // 3. An unchanged future alarm is left exactly as it is.
      if !privacyRemoval, let existing,
         matchesFixedSchedule(existing, timestamp: item.timestamp),
         fingerprints[item.id.uuidString] == item.fingerprint,
         redacted.contains(item.id.uuidString) == item.privacyHidden {
        scheduled.append(item.alarmKey)
        continue
      }
      // 4. Never drop an occurrence that is due now or in the past. The system
      //    may be about to present it, and removing it here would mean neither
      //    an alarm nor a notification fallback (JS only falls back for the
      //    occurrences missing from `scheduledAlarmKeys`), i.e. a silently
      //    missed alert. A content-only change is applied to the next
      //    occurrence instead. (A redaction change never reaches here: it is
      //    handled by block 0 above, which only re-creates a strictly future
      //    occurrence and reports a past/presenting one as unredacted.)
      if !privacyRemoval, let existing,
         matchesFixedSchedule(existing, timestamp: item.timestamp),
         item.timestamp <= now {
        scheduled.append(item.alarmKey)
        continue
      }
      if !privacyRemoval, let existing {
        do { try remove(existing, manager: manager) }
        catch {
          // The old alarm could not be removed, so it still exists and may
          // still sound: report the occurrence as held rather than letting JS
          // add a second, duplicate audible fallback for it.
          scheduled.append(item.alarmKey)
          continue
        }
      }
      fingerprints.removeValue(forKey: item.id.uuidString)
      // A redaction change is only ever re-created for a strictly future
      // occurrence (block 0), so it never lands on this past-instant guard;
      // everything stopped here stays stopped.
      if !privacyRemoval, item.timestamp <= now { continue } // Stopped one-time alarms remain stopped.

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
          tintColor: item.tint ?? .green)
        let config = AlarmManager.AlarmConfiguration<TaskAlarmMetadata>(
          countdownDuration: Alarm.CountdownDuration(preAlert: nil,
                                                     postAlert: Self.snoozeInterval),
          schedule: .fixed(Date(timeIntervalSince1970: item.timestamp)),
          attributes: attributes,
          secondaryIntent: TaskAlarmRepeatIntent(alarmID: item.id.uuidString))
        _ = try await manager.schedule(id: item.id, configuration: config)
        fingerprints[item.id.uuidString] = item.fingerprint
        if item.privacyHidden { redacted.insert(item.id.uuidString) }
        else { redacted.remove(item.id.uuidString) }
        scheduled.append(item.alarmKey)
      } catch {
        // The occurrence stays absent from `scheduled`, so it becomes a
        // notification fallback rather than a silently missed alert.
      }
    }

    // The fingerprint uses schedule metadata; Task titles never enter
    // UserDefaults -- only ids, digests and the App Lock flag per alarm id.
    UserDefaults.standard.set(fingerprints, forKey: fingerprintKey)
    UserDefaults.standard.set(Array(redacted), forKey: redactedIdsKey)
    UserDefaults.standard.set(Array(owned), forKey: ownedIdsKey)
    return ["status": "authorized", "scheduledAlarmKeys": scheduled,
            "activeAlarmKeys": active,
            "unredactedAlarmKeys": unredacted]
  }

  enum TaskAlarmError: LocalizedError {
    case invalidInput
    var errorDescription: String? { "Invalid Task alarm input." }
  }
}
#endif

#if canImport(ActivityKit) && !targetEnvironment(macCatalyst)
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
