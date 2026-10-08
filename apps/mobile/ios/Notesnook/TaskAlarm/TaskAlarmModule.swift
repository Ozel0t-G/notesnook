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
  /// modified, so the occurrence the alarm belongs to stays intact. Nine minutes
  /// is the product decision; the exact physical notification latency is not
  /// separately confirmed, so nothing may assume a stricter bound than this.
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
  @objc(replaceAlarms:accountScope:alarms:resolver:rejecter:)
  func replaceAlarms(_ accountId: String,
                     accountScope rawScope: String,
                     alarms rawAlarms: [NSDictionary],
                     resolver resolve: @escaping RCTPromiseResolveBlock,
                     rejecter reject: @escaping RCTPromiseRejectBlock) {
    #if canImport(AlarmKit) && !targetEnvironment(macCatalyst)
    if #available(iOS 26.0, *) {
      // The same opaque scope token the widget snapshot and the overdue Live
      // Activity are keyed by, so a Stop tap can address the identical identity.
      // A missing/malformed token falls back to the derived digest; it is never
      // trusted as an account claim.
      let scope = Self.normalizedScope(rawScope, accountId: accountId)
      Task {
        do {
          var wanted = [WantedAlarm]()
          for raw in rawAlarms {
            if let alarm = try? Self.parse(raw, accountId: accountId) {
              wanted.append(alarm)
            }
          }
          resolve(try await TaskAlarmOperationGate.shared.run {
            try await Self.replace(wanted, scope: scope)
          })
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
      Task {
        do {
          resolve(try await TaskAlarmOperationGate.shared.run {
            try Self.cancelScheduledOwnedAlarms(accountId: accountId,
                                                alarmKeys: rawKeys)
          })
        } catch {
          reject("task_alarm_cancel_scheduled", error.localizedDescription, error)
        }
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
      Task {
        do {
          try await TaskAlarmOperationGate.shared.run {
            try Self.cancelAllOwnedAlarms()
          }
          resolve(nil)
        } catch {
          reject("task_alarm_cancel", error.localizedDescription, error)
        }
      }
      return
    }
    #endif
    resolve(nil)
  }

  /// Reconciles the "Task is overdue and still incomplete" Live Activities with
  /// the caller's desired set. Content is intentionally minimal: an opaque Task
  /// id plus a title the caller has already redacted when App Lock is enabled.
  @objc(syncOverdueActivities:activities:privacyHidden:accountScope:resolver:rejecter:)
  func syncOverdueActivities(_ accountId: String,
                             activities rawActivities: [NSDictionary],
                             privacyHidden: Bool,
                             accountScope rawScope: String,
                             resolver resolve: @escaping RCTPromiseResolveBlock,
                             rejecter reject: @escaping RCTPromiseRejectBlock) {
    #if canImport(ActivityKit) && !targetEnvironment(macCatalyst)
    if #available(iOS 16.2, *) {
      Task {
        do {
          resolve(try await TaskAlarmOperationGate.shared.run {
            try await Self.syncOverdueActivities(
              accountId: accountId,
              raw: rawActivities,
              privacyHidden: privacyHidden,
              scope: Self.normalizedScope(rawScope, accountId: accountId))
          })
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
          resolve(try await TaskAlarmOperationGate.shared.run {
            try await Self.endOverdueActivities()
          })
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
  /// The Task revision this occurrence was planned from, and the occurrence's
  /// own identity. Kept so the prepublished identity a Stop tap reads can name
  /// the exact occurrence (for the generic stopped card and its Complete
  /// control) without the host running.
  let updatedAt: Int
  let occurrenceKey: String?
  let seriesId: String?
  /// The caller's App Lock placeholder, when it supplied one. Never user
  /// content; used only as the stopped card's neutral title.
  let redactedTitle: String?
  /// The native alarm configuration generation the caller planned with. Folded
  /// into the fingerprint, so bumping `TASK_ALARM_CONFIGURATION_VERSION` in JS
  /// re-creates future alarms (never a live one) with the new presentation.
  let configurationVersion: String?
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
    // (13:20)"), never the Task itself. Sanitized exactly like the real title
    // (controls and U+2028/U+2029 become spaces), and an empty or
    // whitespace-only placeholder falls back to the neutral text, so a
    // malformed caller can never leave a blank or line-breaking Lock Screen
    // alarm title.
    let redactedSource = value["redactedTitle"] as? String ?? ""
    let cleanedRedacted = redactedSource.unicodeScalars.map { scalar in
      CharacterSet.controlCharacters.contains(scalar) ||
        scalar.value == 0x2028 || scalar.value == 0x2029
        ? " " : String(scalar)
    }.joined()
    let cappedRedacted = String(cleanedRedacted.prefix(60))
    let redactedTitle = cappedRedacted.trimmingCharacters(in: .whitespaces).isEmpty
      ? "VeyraN Task" : cappedRedacted
    let safeTitle = privacyHidden ? redactedTitle : String(cleanedTitle.prefix(120))
    let tint = (value["tint"] as? String).flatMap(Self.color(hex:))
    // The alarm configuration generation (bounded, opaque) participates in the
    // fingerprint so a config bump upgrades future alarms only.
    let configurationVersion = (value["configurationVersion"] as? String)
      .flatMap { $0.isEmpty ? nil : String($0.prefix(16)) }
    let input = "\(timestamp.doubleValue)|\(privacyHidden)|\(updatedAt.doubleValue)|\(configurationVersion ?? "")"
    let fingerprint = SHA256.hash(data: Data(input.utf8))
      .map { String(format: "%02x", $0) }.joined()
    // Occurrence/series ids are optional and only ever forwarded to the
    // prepublished identity store, which validates them before persisting.
    let occurrenceKey = (value["occurrenceKey"] as? String)
      .flatMap { $0.isEmpty ? nil : $0 }
    let seriesId = (value["seriesId"] as? String)
      .flatMap { $0.isEmpty ? nil : $0 }
    return WantedAlarm(id: id, taskId: taskId, alarmKey: alarmKey,
                       timestamp: timestamp.doubleValue / 1000,
                       title: safeTitle, fingerprint: fingerprint,
                       privacyHidden: privacyHidden,
                       updatedAt: Int(exactly: updatedAt.doubleValue) ?? 0,
                       occurrenceKey: occurrenceKey, seriesId: seriesId,
                       // Only ever the App Lock placeholder, and only while App
                       // Lock is on: a caller cannot smuggle a real title into
                       // the identity store through the `redactedTitle` field.
                       redactedTitle: privacyHidden ? redactedTitle : nil,
                       configurationVersion: configurationVersion,
                       tint: tint)
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

  /// Prepublishes the minimal, non-content identity and lifecycle a Stop tap
  /// reads, so the generic stopped card can be left behind without the host
  /// running. It is called *before* `schedule` -- an alarm can start sounding
  /// the instant it is scheduled, and its own Stop must never outrun its
  /// identity -- and for an alarm that is merely kept (unchanged or already
  /// presenting), so an upgrade backfills identity for alarms scheduled before
  /// this store existed. Task titles never enter: the App Lock decision is a
  /// flag and the stopped card uses a neutral placeholder.
  static func prepublish(_ item: WantedAlarm, scope: String) {
    TaskAlarmIdentityStore.upsert(alarmId: item.id.uuidString,
      identity: TaskAlarmIdentity(taskId: item.taskId, due: item.timestamp,
        occurrenceKey: item.occurrenceKey, seriesId: item.seriesId,
        updatedAt: item.updatedAt, scope: scope,
        // No title is ever persisted: the stopped card uses the neutral
        // placeholder and the App Lock decision lives in the lifecycle store as
        // a flag. The field stays decodable for identities written by an
        // earlier build.
        redactedTitle: nil))
    TaskAlarmLifecycleStore.upsert(alarmId: item.id.uuidString,
      record: TaskAlarmLifecycle(taskId: item.taskId, due: item.timestamp,
        occurrenceKey: item.occurrenceKey, seriesId: item.seriesId,
        updatedAt: item.updatedAt, scope: scope,
        privacyHidden: item.privacyHidden))
  }

  /// Withdraws a prepublished identity for an occurrence the system never
  /// accepted, so a later reconcile cannot answer for a phantom alarm. A
  /// durable stopped marker belongs to the occurrence, not to the failed
  /// schedule, so it is never discarded.
  static func withdrawPrepublish(_ item: WantedAlarm) {
    TaskAlarmIdentityStore.remove(alarmIds: [item.id.uuidString])
    if TaskAlarmLifecycleStore.record(alarmId: item.id.uuidString)?.stoppedAt == nil {
      TaskAlarmLifecycleStore.remove(alarmIds: [item.id.uuidString])
    }
  }

  static func matchesFixedSchedule(_ alarm: Alarm, timestamp: TimeInterval) -> Bool {
    guard case .some(.fixed(let date)) = alarm.schedule else { return false }
    return abs(date.timeIntervalSince1970 - timestamp) < 0.001
  }

  /// Whether the system really does **not** hold this alarm any more.
  ///
  /// Always answered by re-enumerating the system's own alarm list, never by the
  /// absence of a thrown error: `stop`/`cancel` returning is not evidence, and a
  /// still-held alarm must never be treated as removed (that would hand its
  /// occurrence a second, duplicate audible delivery). An enumeration that
  /// itself fails is unknown, so it fails closed: "still held".
  static func isAlarmGone(_ id: UUID, manager: AlarmManager) -> Bool {
    guard let alarms = try? manager.alarms else { return false }
    return !alarms.contains { $0.id == id }
  }

  /// Removes one presentation with the call its own state asks for, tries the
  /// alternative supported call once, and re-enumerates after each attempt. The
  /// answer is only ever `true` when the system no longer lists the alarm.
  static func removeAndVerifyGone(_ alarm: Alarm, manager: AlarmManager) -> Bool {
    _ = try? remove(alarm, manager: manager)
    if isAlarmGone(alarm.id, manager: manager) { return true }
    if alarm.state == .alerting {
      _ = try? manager.cancel(id: alarm.id)
    } else {
      _ = try? manager.stop(id: alarm.id)
    }
    return isAlarmGone(alarm.id, manager: manager)
  }

  /// The exact time left before a held presentation alerts again, read from the
  /// **public** AlarmKit presentation state.
  ///
  /// `Alarm` itself exposes no current fire date; the activity the system
  /// publishes for it does: a countdown carries its `fireDate`, and a paused one
  /// the total and already-elapsed durations, so the frozen remainder is exact.
  /// `nil` means "not readable right now" -- never "no time left".
  static func remainingAlertInterval(alarmId: UUID) -> TimeInterval? {
    #if canImport(ActivityKit) && !targetEnvironment(macCatalyst)
    // This extension is already iOS 26+; the ActivityKit gate is what keeps
    // Catalyst (where ActivityKit's types are unavailable) compiling.
    for activity in Activity<AlarmAttributes<TaskAlarmMetadata>>.activities
    where activity.content.state.alarmID == alarmId {
      switch activity.content.state.mode {
      case .countdown(let countdown):
        return max(0, countdown.fireDate.timeIntervalSinceNow)
      case .paused(let paused):
        return max(0, paused.totalCountdownDuration
                   - paused.previouslyElapsedDuration)
      default:
        return nil
      }
    }
    #endif
    return nil
  }

  /// The countdown a redacted replacement runs before it alerts.
  ///
  /// - A presentation that is alerting right now (or one of ours the system
  ///   reports as `.scheduled` although it is already due) has no countdown left
  ///   to read, so it is re-armed with a short positive interval: the alert comes
  ///   straight back, redacted, instead of being dropped.
  /// - Otherwise the exact remaining time from the public presentation state is
  ///   used, floored at one second so the replacement is always a real timer.
  /// - When that state cannot be read, the alarm's own configured countdown is
  ///   the bounded `boundedReplacementInterval` fallback: the alert is never
  ///   silently lost, but -- see that method -- the fallback **may delay** the
  ///   re-alert beyond the occurrence's original remaining time (by at most the
  ///   app's own `snoozeInterval`).
  static func replacementCountdown(
    for alarm: Alarm, alerting: Bool
  ) -> TimeInterval {
    if alerting { return 1 }
    if let exact = remainingAlertInterval(alarmId: alarm.id) {
      return max(exact, 1)
    }
    return boundedReplacementInterval(alarm)
  }

  /// The fallback interval of `replacementCountdown`, used only when the exact
  /// remaining time is unreadable.
  ///
  /// It is the alarm's own configured `postAlert` (its snooze interval; a
  /// timer-style alarm's `preAlert` is only ever a last resort), clamped into
  /// `[60s, snoozeInterval]`: the lower bound keeps a corrupt or tiny
  /// configuration from re-alerting destructively soon, and the upper bound caps
  /// how far a corrupt or oversized one can postpone the re-alert.
  ///
  /// Documented limitation: `Alarm` exposes no current fire date, so this
  /// fallback does not know the occurrence's original remaining time and **may
  /// delay the re-alert past it** -- by up to `snoozeInterval` (the app's own
  /// nine-minute promise). It is conservative in the safe direction only: it can
  /// never re-alert earlier than 60 seconds nor drop the alert entirely.
  static func boundedReplacementInterval(_ alarm: Alarm) -> TimeInterval {
    let configured = alarm.countdownDuration
    let candidate = configured?.postAlert ?? configured?.preAlert
      ?? Self.snoozeInterval
    guard candidate.isFinite, candidate > 0 else { return Self.snoozeInterval }
    return min(max(candidate, 60), Self.snoozeInterval)
  }

  /// The gated body of `cancelScheduledAlarms`. Runs inside the shared native
  /// operation gate, so it can never interleave with a Stop's card request.
  static func cancelScheduledOwnedAlarms(
    accountId: String, alarmKeys rawKeys: [String]
  ) throws -> [String: Any] {
    let manager = AlarmManager.shared
    var owned = Set(UserDefaults.standard.stringArray(forKey: ownedIdsKey) ?? [])
    var fingerprints = UserDefaults.standard.dictionary(forKey: fingerprintKey) as? [String: String] ?? [:]
    var redacted = Set(UserDefaults.standard.stringArray(forKey: redactedIdsKey) ?? [])
    var keyByAlarmId = [UUID: String]()
    var requested = [String]()
    for key in rawKeys where !key.isEmpty {
      keyByAlarmId[alarmId(accountId: accountId, alarmKey: key)] = key
      if !requested.contains(key) { requested.append(key) }
    }
    let alarms = try manager.alarms
    let initiallyHeldIds = Set(alarms.map { $0.id.uuidString })
    var cancelled = [String]()
    var retained = [String]()
    for alarm in alarms {
      guard let key = keyByAlarmId[alarm.id],
            isOwnedAlarm(alarm.id, legacyOwned: owned)
      else { continue }
      guard alarm.state == .scheduled else {
        retained.append(key)
        continue
      }
      if Self.removeAndVerifyGone(alarm, manager: manager) {
        fingerprints.removeValue(forKey: alarm.id.uuidString)
        redacted.remove(alarm.id.uuidString)
        owned.remove(alarm.id.uuidString)
        TaskAlarmIdentityStore.remove(alarmIds: [alarm.id.uuidString])
        cancelled.append(key)
      } else {
        // The system still lists this presentation (or its alarm list could not
        // be read at all), so it is retained, never a clean cancellation the
        // caller could fall back from.
        retained.append(key)
      }
    }
    // Every requested key is accounted for: one the system does not hold at
    // all is *provably* not scheduled, which is a different (and safe) fact
    // from "not answered", so the caller can fall back for it.
    var notFound = [String]()
    for key in requested {
      let id = alarmId(accountId: accountId, alarmKey: key)
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
    TaskAlarmIdentityStore.prune(keeping: remainingHeldIds)
    UserDefaults.standard.set(fingerprints, forKey: fingerprintKey)
    UserDefaults.standard.set(Array(redacted), forKey: redactedIdsKey)
    UserDefaults.standard.set(Array(owned), forKey: ownedIdsKey)
    return ["status": statusName(manager.authorizationState),
            "cancelledAlarmKeys": cancelled,
            "retainedAlarmKeys": retained,
            "notFoundAlarmKeys": notFound]
  }

  enum TaskAlarmCancelError: LocalizedError {
    case alarmsRetained(Int)
    var errorDescription: String? {
      switch self {
      case .alarmsRetained(let count):
        return "\(count) Task alarm(s) could not be removed."
      }
    }
  }

  /// The gated body of `cancelAll`. Runs inside the shared native operation
  /// gate, so it can never interleave with a Stop's card request.
  static func cancelAllOwnedAlarms() throws {
    let manager = AlarmManager.shared
    var owned = Set(UserDefaults.standard.stringArray(forKey: ownedIdsKey) ?? [])
    var fingerprints = UserDefaults.standard.dictionary(forKey: fingerprintKey) as? [String: String] ?? [:]
    var redacted = Set(UserDefaults.standard.stringArray(forKey: redactedIdsKey) ?? [])
    var failed = 0
    // Every owned alarm is attempted, so one stubborn presentation cannot
    // stop the rest of the account's surfaces from being removed.
    for alarm in try manager.alarms where isOwnedAlarm(alarm.id, legacyOwned: owned) {
      do {
        try remove(alarm, manager: manager)
        fingerprints.removeValue(forKey: alarm.id.uuidString)
        redacted.remove(alarm.id.uuidString)
        owned.remove(alarm.id.uuidString)
        TaskAlarmIdentityStore.remove(alarmIds: [alarm.id.uuidString])
      } catch {
        failed += 1
      }
    }
    // Persist the pruned bookkeeping even on a partial failure, so a retry
    // only has to consider what the system really still holds.
    UserDefaults.standard.set(fingerprints, forKey: fingerprintKey)
    UserDefaults.standard.set(Array(redacted), forKey: redactedIdsKey)
    UserDefaults.standard.set(Array(owned), forKey: ownedIdsKey)
    TaskAlarmIdentityStore.prune(keeping: owned)
    guard failed == 0 else {
      // Something is still held: reject rather than report a clean sweep, so
      // the caller keeps the cleanup obligation and retries it later.
      throw TaskAlarmCancelError.alarmsRetained(failed)
    }
    // Confirmed clear: drop every trace of the bookkeeping.
    UserDefaults.standard.removeObject(forKey: fingerprintKey)
    UserDefaults.standard.removeObject(forKey: "notesnook.taskAlarms.fingerprints.v1")
    UserDefaults.standard.removeObject(forKey: ownedIdsKey)
    UserDefaults.standard.removeObject(forKey: redactedIdsKey)
    TaskAlarmIdentityStore.removeAll()
    TaskAlarmLifecycleStore.removeAll()
  }

  static func replace(_ wanted: [WantedAlarm], scope: String) async throws -> [String: Any] {
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
        let wanted = desired[alarm.id]
        if alarm.state == .scheduled {
          if Self.removeAndVerifyGone(alarm, manager: manager) {
            fingerprints.removeValue(forKey: alarm.id.uuidString)
            redacted.remove(alarm.id.uuidString)
            owned.remove(alarm.id.uuidString)
            TaskAlarmIdentityStore.remove(alarmIds: [alarm.id.uuidString])
          } else if let wanted {
            // Still held and not presenting: it is reported as held (so no
            // fallback duplicates it) but never as `active`, because a
            // `.scheduled` alarm is not presenting. Its prepublished identity is
            // backfilled so a Stop still has the occurrence to answer with.
            owned.insert(wanted.id.uuidString)
            prepublish(wanted, scope: scope)
            scheduled.append(wanted.alarmKey)
            if wanted.privacyHidden &&
               !redacted.contains(alarm.id.uuidString) {
              unredacted.append(wanted.alarmKey)
            }
          }
        } else if let wanted {
          // A presentation the person is engaged with (alerting, counting down
          // after a Snooze, or paused) is retained, and it *is* presenting now.
          owned.insert(wanted.id.uuidString)
          prepublish(wanted, scope: scope)
          scheduled.append(wanted.alarmKey)
          active.append(wanted.alarmKey)
          if wanted.privacyHidden &&
             !redacted.contains(alarm.id.uuidString) {
            unredacted.append(wanted.alarmKey)
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

    var removalFailures = 0
    for alarm in current where desired[alarm.id] == nil {
      if Self.removeAndVerifyGone(alarm, manager: manager) {
        fingerprints.removeValue(forKey: alarm.id.uuidString)
        redacted.remove(alarm.id.uuidString)
        owned.remove(alarm.id.uuidString)
        TaskAlarmIdentityStore.remove(alarmIds: [alarm.id.uuidString])
      } else {
        // The system still lists a presentation the caller no longer wants (or
        // its alarm list is unreadable). Its bookkeeping and prepublished
        // identity are preserved, and the pass fails closed below: nothing may
        // be reported as reconciled while a presentation this app owns remains
        // unaccounted for.
        removalFailures += 1
      }
    }
    guard removalFailures == 0 else {
      // Record the removals that were verified before giving up (so they are
      // not re-attempted), then fail closed. JS resolves the native truth and
      // keeps the fallback for whatever is still held.
      UserDefaults.standard.set(fingerprints, forKey: fingerprintKey)
      UserDefaults.standard.set(Array(redacted), forKey: redactedIdsKey)
      UserDefaults.standard.set(Array(owned), forKey: ownedIdsKey)
      throw TaskAlarmCancelError.alarmsRetained(removalFailures)
    }

    let currentById = Dictionary(current.map { ($0.id, $0) },
                                uniquingKeysWith: { first, _ in first })
    let now = Date().timeIntervalSince1970
    for item in wanted {
      let existing = currentById[item.id]
      // 0. App Lock is on and this held presentation was created with a real
      //    Task title. AlarmKit has no in-place presentation update, so the
      //    occurrence is migrated to a *redacted* presentation with the **same**
      //    alarm id -- the id is the occurrence's identity, and a new one would
      //    leave the person's live Snooze/Pause tied to an alarm that no longer
      //    exists. The migration keeps the alert alive instead of trading it for
      //    a notification fallback (which a past occurrence never gets, so the
      //    old "report it absent" behavior silently dropped the re-alert):
      //
      //    * A strictly future `.scheduled` alarm has not presented yet, so it is
      //      removed and re-created below with its original fixed instant; its
      //      alert time is preserved exactly.
      //    * An alarm that is already on screen (`.alerting`/`.countdown`/
      //      `.paused`) or that is due now cannot be re-armed on a past instant.
      //      It is removed and re-created as a countdown whose `preAlert` is the
      //      remaining time read from the public presentation state (see
      //      `replacementCountdown`), so it re-alerts redacted. A paused one is
      //      paused again immediately, so the migration never resumes an alert
      //      the person did not start.
      //
      //    Both paths remove first, then **verify against the system's own alarm
      //    list** that the unredacted presentation is gone, and only then create
      //    the single redacted replacement: the person never has two alarms for
      //    one occurrence, and a title that is still up is never claimed hidden.
      //    Only an occurrence the caller still wants -- a valid, incomplete,
      //    Urgent Task's own alarm -- reaches this block, because `wanted` is
      //    exactly the caller's desired set.
      var privacyRemoval = false
      /// The countdown the replacement must run (only ever set for a
      /// presentation that is due now or already presenting).
      var replacement: TimeInterval?
      /// The person had paused this occurrence, so the redacted replacement is
      /// paused again immediately after it is created.
      var pauseReplacement = false
      if let existing, item.privacyHidden,
         !redacted.contains(existing.id.uuidString) {
        // The remaining alert time is read from the alarm's *live* presentation
        // state (`remainingAlertInterval` enumerates the system's countdown
        // activities), and removing the presentation deletes that state. It
        // must therefore be computed *before* the removal, not after.
        if existing.state != .scheduled || item.timestamp <= now {
          pauseReplacement = existing.state == .paused
          // A `.scheduled` alarm whose fixed instant has already passed (its
          // fixed instant is in the past) is treated exactly like one that is
          // alerting: its remaining time is unreadable and re-arming it on the
          // past instant would drop the alert, so it gets the guaranteed short
          // re-arm instead of the bounded fallback.
          replacement = Self.replacementCountdown(
            for: existing,
            alerting: existing.state == .alerting
              || (existing.state == .scheduled && item.timestamp <= now))
        }
        if Self.removeAndVerifyGone(existing, manager: manager) {
          fingerprints.removeValue(forKey: existing.id.uuidString)
          redacted.remove(existing.id.uuidString)
          owned.remove(existing.id.uuidString)
          TaskAlarmIdentityStore.remove(alarmIds: [existing.id.uuidString])
          privacyRemoval = true
        } else {
          // Neither supported call got the unredacted presentation out of the
          // system. The real title is still up, so the occurrence is reported
          // held (no duplicate fallback is added for it) *and* unredacted: the
          // failure is surfaced, never reported as a clean redaction.
          owned.insert(item.id.uuidString)
          prepublish(item, scope: scope)
          scheduled.append(item.alarmKey)
          if existing.state != .scheduled { active.append(item.alarmKey) }
          unredacted.append(item.alarmKey)
          continue
        }
      }
      // 1. A presentation the person is already engaged with at this exact
      //    occurrence is never torn down. `.alerting` is the alarm sounding
      //    (Stop stays a separate user action, so reconciliation must not
      //    silence or complete the Task); `.countdown` is their Snooze and
      //    `.paused` is their Pause. Removing either would silently throw away
      //    a choice the person just made, on the next background reconcile.
      //    A redacted App Lock replacement has no fixed schedule any more, so
      //    its id -- exactly one per occurrence, and only ever minted for a
      //    desired occurrence of this app -- is what identifies it here.
      if !privacyRemoval, let existing,
         (matchesFixedSchedule(existing, timestamp: item.timestamp) ||
          redacted.contains(item.id.uuidString)),
         existing.state != .scheduled {
        // Backfill the identity/lifecycle of an alarm this upgrade did not
        // schedule itself, so its Stop can still leave a card.
        owned.insert(item.id.uuidString)
        prepublish(item, scope: scope)
        scheduled.append(item.alarmKey)
        active.append(item.alarmKey)
        continue
      }
      // 2. A Snooze/Pause that is still running is never cancelled, whatever
      //    the desired schedule now says; the alarm re-alerts when the countdown
      //    ends and the reconcile after that picks up any newer occurrence.
      if !privacyRemoval, let existing,
         existing.state == .countdown || existing.state == .paused {
        owned.insert(item.id.uuidString)
        prepublish(item, scope: scope)
        scheduled.append(item.alarmKey)
        active.append(item.alarmKey)
        continue
      }
      // 3. An unchanged future alarm is left exactly as it is, but its
      //    prepublished identity is backfilled (and refreshed) so a Stop tap
      //    still has the exact occurrence to answer with.
      if !privacyRemoval, let existing,
         matchesFixedSchedule(existing, timestamp: item.timestamp),
         fingerprints[item.id.uuidString] == item.fingerprint,
         redacted.contains(item.id.uuidString) == item.privacyHidden {
        owned.insert(item.id.uuidString)
        prepublish(item, scope: scope)
        scheduled.append(item.alarmKey)
        continue
      }
      // 4. Never drop an occurrence that is due now or in the past. The system
      //    may be about to present it, and removing it here would mean neither
      //    an alarm nor a notification fallback (JS only falls back for
      //    occurrences it plans at a *future* instant), i.e. a silently missed
      //    alert. A content-only change is applied to the next occurrence
      //    instead. (An App Lock redaction never reaches here: block 0 above
      //    handles it, re-creating a strictly future occurrence with its own
      //    instant and a due/presenting one as a redacted countdown.)
      if !privacyRemoval, let existing,
         matchesFixedSchedule(existing, timestamp: item.timestamp),
         item.timestamp <= now {
        owned.insert(item.id.uuidString)
        prepublish(item, scope: scope)
        scheduled.append(item.alarmKey)
        continue
      }
      if !privacyRemoval, let existing {
        if Self.removeAndVerifyGone(existing, manager: manager) {
          TaskAlarmIdentityStore.remove(alarmIds: [existing.id.uuidString])
        } else {
          // Neither supported call got the old presentation out of the system,
          // so re-scheduling this occurrence would stack a second alarm for it.
          // It is reported held (so JS adds no duplicate fallback) and its
          // prepublished identity is backfilled so a Stop still has the
          // occurrence to answer with.
          owned.insert(item.id.uuidString)
          prepublish(item, scope: scope)
          scheduled.append(item.alarmKey)
          continue
        }
      }
      fingerprints.removeValue(forKey: item.id.uuidString)
      // An App Lock redaction (block 0) has already decided how it is re-armed
      // -- a future occurrence keeps its own instant, a due/presenting one is
      // migrated to a redacted countdown -- so it never lands on this
      // past-instant guard; everything stopped here stays stopped.
      if !privacyRemoval, item.timestamp <= now { continue } // Stopped one-time alarms remain stopped.

      do {
        // Persist ownership and the prepublished identity/lifecycle *before*
        // scheduling, so a crash cannot orphan this alarm and an alarm that
        // starts sounding the instant it is scheduled already has its Stop path.
        owned.insert(item.id.uuidString)
        UserDefaults.standard.set(Array(owned), forKey: ownedIdsKey)
        prepublish(item, scope: scope)
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
        // after `postAlert`. An ordinary alarm keeps `preAlert` nil, so it is
        // never turned into a timer that fires immediately -- only the fixed
        // schedule decides when it alerts. (The single exception is the App Lock
        // migration of a presentation that is due now or already on screen: it
        // *must* become a countdown, because re-arming it on a past instant
        // would drop the alert.) AlarmKit requires the widget extension to
        // render `AlarmAttributes` whenever a countdown presentation is used,
        // otherwise the system may drop the alarm (see NotesWidget's
        // ActivityConfiguration).
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
          // The app's own fixed system blue. A List color is deliberately not
          // part of the alarm identity, so the tint is never caller-supplied.
          tintColor: .blue)
        // An ordinary alarm keeps the planned fixed instant and no pre-alert. A
        // privacy replacement for a presentation that is due now or already on
        // screen is the one exception: it is re-armed as a countdown of the
        // remaining time, with exactly the same stop/secondary intents, so the
        // alert continues under the redacted placeholder.
        let replacementCountdown = replacement
        let config = AlarmManager.AlarmConfiguration<TaskAlarmMetadata>(
          countdownDuration: Alarm.CountdownDuration(
            preAlert: replacementCountdown, postAlert: Self.snoozeInterval),
          schedule: replacementCountdown == nil
            ? .fixed(Date(timeIntervalSince1970: item.timestamp)) : nil,
          attributes: attributes,
          // The system's own Stop control is wired to this app's Stop intent, so
          // a Stop tap runs the same prepublished-identity claim and stopped
          // card the Live Activity's Stop button runs. It must come *before*
          // the Snooze secondary intent.
          stopIntent: TaskAlarmStopIntent(alarmID: item.id.uuidString),
          secondaryIntent: TaskAlarmRepeatIntent(alarmID: item.id.uuidString))
        _ = try await manager.schedule(id: item.id, configuration: config)
        if pauseReplacement {
          // The person had paused this occurrence. The redacted replacement is
          // paused again *before* it is reported held, so the migration never
          // resumes a countdown into an alert they did not ask for.
          do {
            try manager.pause(id: item.id)
          } catch {
            // Pausing could not be confirmed, so the replacement is cancelled
            // rather than left counting down: an alert the person paused must
            // not be silently resumed.
            _ = try? manager.cancel(id: item.id)
            // `cancel` returning is not proof the alarm is gone. If the system
            // still holds it, reporting the occurrence absent would let JS add a
            // duplicate fallback while a real alarm is (or may be) still
            // sounding, so the bookkeeping and identity are preserved and the
            // occurrence is reported held *and* active instead.
            if !Self.isAlarmGone(item.id, manager: manager) {
              owned.insert(item.id.uuidString)
              prepublish(item, scope: scope)
              fingerprints[item.id.uuidString] = item.fingerprint
              if item.privacyHidden { redacted.insert(item.id.uuidString) }
              else { redacted.remove(item.id.uuidString) }
              scheduled.append(item.alarmKey)
              active.append(item.alarmKey)
              continue
            }
            // Provably gone: nothing is held for this occurrence, so it is
            // reported absent -- never claimed redacted.
            owned.remove(item.id.uuidString)
            fingerprints.removeValue(forKey: item.id.uuidString)
            redacted.remove(item.id.uuidString)
            withdrawPrepublish(item)
            continue
          }
        }
        fingerprints[item.id.uuidString] = item.fingerprint
        if item.privacyHidden { redacted.insert(item.id.uuidString) }
        else { redacted.remove(item.id.uuidString) }
        scheduled.append(item.alarmKey)
        // A replacement is presenting (alerting now, counting down, or paused):
        // it owns the Lock Screen for this occurrence, so the ongoing overdue
        // surface must not stack a second one. A future `.scheduled` re-create
        // stays scheduled.
        if replacementCountdown != nil { active.append(item.alarmKey) }
      } catch {
        // The system never took this occurrence, so the prepublished identity is
        // withdrawn (a durable stopped marker is kept): a later reconcile must
        // not answer for a phantom alarm. The occurrence stays absent from
        // `scheduled`, so it becomes a notification fallback rather than a
        // silently missed alert.
        owned.remove(item.id.uuidString)
        fingerprints.removeValue(forKey: item.id.uuidString)
        redacted.remove(item.id.uuidString)
        withdrawPrepublish(item)
      }
    }

    // The fingerprint uses schedule metadata; Task titles never enter
    // UserDefaults -- only ids, digests and the App Lock flag per alarm id.
    UserDefaults.standard.set(fingerprints, forKey: fingerprintKey)
    UserDefaults.standard.set(Array(redacted), forKey: redactedIdsKey)
    UserDefaults.standard.set(Array(owned), forKey: ownedIdsKey)
    // Any identity whose alarm is no longer owned is dropped in lockstep, so a
    // Stop tap can never leave a ghost card for a gone alarm.
    TaskAlarmIdentityStore.prune(keeping: owned)
    TaskAlarmLifecycleStore.prune(keeping: owned, now: Date().timeIntervalSince1970)
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

  /// The widget's opaque account-scope token when it is well-formed, else the
  /// derived digest. A malformed value can never become an identity the widget
  /// also uses. Lives with `accountScope` (iOS 16.2) so both the alarm path and
  /// the overdue-activity path can share it.
  static func normalizedScope(_ raw: String, accountId: String) -> String {
    if raw.range(of: "^[0-9a-f]{32}$", options: .regularExpression) != nil {
      return raw
    }
    return accountScope(accountId)
  }

  static func occurrenceKey(_ taskId: String, due: TimeInterval) -> String {
    "\(taskId)\u{1F}\(due)"
  }

  /// One occurrence's identity as a single stable string: the Task id and the
  /// occurrence instant in whole milliseconds. Matching a card to a plan uses
  /// this, so a card created from the app's millisecond timestamp and the same
  /// card read back from its record agree exactly -- while two occurrences of
  /// one recurring Task stay distinct.
  static func surfaceKey(_ taskId: String, due: TimeInterval) -> String {
    "\(taskId)\u{1F}\((due * 1000).rounded())"
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
    title: String,
    scope: String? = nil,
    updatedAt: Int? = nil,
    stopped: Bool = false,
    occurrenceKey: String? = nil,
    seriesId: String? = nil
  ) -> ActivityContent<OverdueTaskActivityAttributes.ContentState> {
    ActivityContent(
      state: OverdueTaskActivityAttributes.ContentState(
        dueDate: due, title: title, stopped: stopped ? true : nil,
        scope: scope, updatedAt: updatedAt,
        occurrenceKey: occurrenceKey, seriesId: seriesId),
      staleDate: due.addingTimeInterval(OverdueActivity.lifetime))
  }

  static func syncOverdueActivities(
    accountId: String,
    raw: [NSDictionary],
    privacyHidden: Bool,
    scope: String
  ) async throws -> [String: Any] {
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

    var desired = [(taskId: String, due: Date, title: String, updatedAt: Int?,
                    occurrenceKey: String?, seriesId: String?, alarmKey: String)]()
    for rawItem in raw {
      guard let taskId = rawItem["taskId"] as? String, !taskId.isEmpty,
            let timestamp = rawItem["timestamp"] as? NSNumber,
            timestamp.doubleValue.isFinite,
            let title = rawItem["title"] as? String
      else { continue }
      // The App Lock placeholder is chosen below, in one place, exactly like the
      // alarm path: the raw title never reaches a surface that App Lock hides.
      let revision = (rawItem["updatedAt"] as? NSNumber)
        .flatMap { Int(exactly: $0.int64Value) }
      desired.append((taskId,
                      Date(timeIntervalSince1970: timestamp.doubleValue / 1000),
                      activityTitle(title),
                      revision.flatMap { $0 > 0 ? $0 : nil },
                      (rawItem["occurrenceKey"] as? String)
                        .flatMap { $0.isEmpty ? nil : String($0.prefix(64)) },
                      (rawItem["seriesId"] as? String)
                        .flatMap { $0.isEmpty ? nil : String($0.prefix(64)) },
                      // The per-occurrence alarm key, so a raw desired entry can
                      // be matched against the native AlarmKit truth directly
                      // instead of only through JS's own check.
                      (rawItem["alarmKey"] as? String) ?? ""))
    }
    // Occurrences whose AlarmKit alarm is presenting right now -- alerting,
    // counting down after a Snooze, or paused. Their alarm already owns the Lock
    // Screen, so an ongoing overdue card for the same occurrence would be a
    // second surface: they are dropped before anything is decided, and any
    // existing card for them is ended below. The native enumeration is read
    // first, and an unreadable one fails closed for NEW cards below: JS's own
    // presenting check alone races the reconcile.
    var presenting = Set<String>()
    var alarmStateReadable = true
    #if canImport(AlarmKit) && !targetEnvironment(macCatalyst)
    if #available(iOS 26.0, *) {
      var keyByAlarmId = [UUID: String]()
      for item in desired where !item.alarmKey.isEmpty {
        keyByAlarmId[alarmId(accountId: accountId, alarmKey: item.alarmKey)] =
          item.alarmKey
      }
      do {
        for alarm in try AlarmManager.shared.alarms
        where alarm.state != .scheduled {
          if let key = keyByAlarmId[alarm.id] { presenting.insert(key) }
        }
        // Every raw desired entry is accounted for by the native read, so a
        // presenting alarm is suppressed and an absent one is not.
      } catch {
        // The native alarm state is unknown: no new card may be requested (a
        // card could compete with an alarm this pass cannot see), but existing
        // cards are left exactly as they are.
        alarmStateReadable = false
      }
    }
    #endif
    if !presenting.isEmpty {
      desired.removeAll { presenting.contains($0.alarmKey) }
    }
    desired.sort { $0.due > $1.due }
    if desired.count > OverdueActivity.maxConcurrent {
      desired = Array(desired.prefix(OverdueActivity.maxConcurrent))
    }
    let desiredKeys = Set(desired.map {
      surfaceKey($0.taskId, due: $0.due.timeIntervalSince1970)
    })

    // The app's own record of every occurrence's lifecycle, read once before
    // anything is decided, so a durable stopped marker written by a Stop tap --
    // possibly while the app was not running -- is obeyed in this pass.
    let lifecycles = TaskAlarmLifecycleStore.all()
    func lifecycle(for item: (taskId: String, due: Date, title: String,
                              updatedAt: Int?, occurrenceKey: String?,
                              seriesId: String?, alarmKey: String))
      -> (key: String, value: TaskAlarmLifecycle)? {
      lifecycles.first(where: { pair in
        guard pair.value.taskId == item.taskId,
              abs(pair.value.due - item.due.timeIntervalSince1970) < 0.5
        else { return false }
        // A record from another account's plan never speaks for this card.
        if let recordScope = pair.value.scope, recordScope != scope { return false }
        return true
      })
    }

    // Known surfaces, keyed by the *occurrence* (Task + due instant), never by
    // Task alone: two occurrences of one recurring Task must never be mistaken
    // for one another, and a card's own due/revision is what the app updates.
    var known = [String: (id: String, taskId: String, due: TimeInterval,
                          scope: String)]()
    for (activityId, record) in index {
      guard let parsed = parseActivityRecord(record) else { continue }
      known[surfaceKey(parsed.taskId, due: parsed.due)] =
        (activityId, parsed.taskId, parsed.due, parsed.scope)
    }
    // Adopt any live surface the index does not know about -- most importantly
    // the generic stopped card a Stop tap left behind -- into the authoritative
    // set, so the app refreshes it in place instead of stacking a second card
    // for the same occurrence and instead of ending an occurrence it still needs.
    for (activityId, activity) in alive where index[activityId] == nil {
      let state = activity.content.state
      let due = state.dueDate.timeIntervalSince1970
      let cardScope = state.scope ?? ""
      let key = surfaceKey(activity.attributes.taskId, due: due)
      known[key] = (activityId, activity.attributes.taskId, due, cardScope)
      index[activityId] = activityRecord(activity.attributes.taskId,
                                         due: due, scope: cardScope)
    }

    // Surfaces that no longer belong to a desired occurrence of this account
    // are ended rather than left behind. Matching includes the account scope and
    // the occurrence instant, so a card of another account -- or of an
    // occurrence that has since moved on -- is never kept by mistake.
    for (key, entry) in known {
      guard let activity = alive[entry.id] else { continue }
      if entry.scope == scope, desiredKeys.contains(key) { continue }
      await activity.end(nil, dismissalPolicy: .immediate)
      index.removeValue(forKey: entry.id)
      known.removeValue(forKey: key)
      ended += 1
    }

    for item in desired {
      let due = item.due.timeIntervalSince1970
      let key = occurrenceKey(item.taskId, due: due)
      let surface = surfaceKey(item.taskId, due: due)
      let record = lifecycle(for: item)
      let stopped = record?.value.stoppedAt != nil
      // App Lock is decided from the *stored* plan as well as this pass: a card
      // planned while App Lock was on is never upgraded to the real title merely
      // because the app later ran unlocked.
      let redact = privacyHidden || record?.value.privacyHidden == true
      let title = redact ? OverdueActivity.redactedTitle : item.title
      if suppressed[key] != nil { continue }

      if let entry = known[surface], let activity = alive[entry.id],
         entry.scope == scope {
        // Same occurrence: refresh the dynamic content (a renamed Task, a title
        // that just became redacted, or an ordinary overdue card that is now a
        // stopped one) without recreating the surface.
        let next = activityContent(due: item.due, title: title, scope: scope,
                                   updatedAt: item.updatedAt, stopped: stopped,
                                   occurrenceKey: item.occurrenceKey,
                                   seriesId: item.seriesId)
        if activity.content.state != next.state {
          await activity.update(next)
          updated += 1
        }
        if stopped, let alarmId = record?.key {
          // A stopped occurrence that is really on screen is no longer pending,
          // so a later dismissal is never answered by a resurrected card.
          TaskAlarmLifecycleStore.markAttempt(alarmId: alarmId)
        }
        continue
      }

      if let entry = known[surface], let activity = alive[entry.id] {
        // The same occurrence under a different account: replace the surface.
        await activity.end(nil, dismissalPolicy: .immediate)
        index.removeValue(forKey: entry.id)
        known.removeValue(forKey: surface)
        ended += 1
      }

      // Revalidate the durable lifecycle immediately before a new surface is
      // requested: a completion or reschedule that landed during the awaits
      // above must never be answered by a resurrected card.
      if let alarmId = record?.key,
         TaskAlarmLifecycleStore.record(alarmId: alarmId) == nil {
        continue
      }
      // Re-enumerate the system after the awaits: a Stop tap can have left the
      // generic card for this exact occurrence while this pass was awaiting.
      // Adopt it instead of stacking a second card for the same identity.
      if let live = Activity<OverdueTaskActivityAttributes>.activities.first(where: {
        $0.activityState != .ended && $0.activityState != .dismissed &&
        OverdueTaskActivityAttributes.matches($0, taskId: item.taskId, due: due,
          scope: scope, occurrenceKey: item.occurrenceKey)
      }) {
        let next = activityContent(due: item.due, title: title, scope: scope,
                                   updatedAt: item.updatedAt, stopped: stopped,
                                   occurrenceKey: item.occurrenceKey,
                                   seriesId: item.seriesId)
        if live.content.state != next.state {
          await live.update(next)
          updated += 1
        }
        index[live.id] = activityRecord(item.taskId, due: due, scope: scope)
        known[surface] = (live.id, item.taskId, due, scope)
        if stopped, let alarmId = record?.key {
          TaskAlarmLifecycleStore.markAttempt(alarmId: alarmId)
        }
        continue
      }

      // A stopped occurrence whose card was already requested and is now gone
      // was dismissed by the person or expired. It is never re-created as a
      // ghost; the durable stopped state stays, the surface does not.
      if stopped, record?.value.attemptedAt != nil {
        suppressed[key] = now
        continue
      }

      // An unknown native alarm state fails closed: no NEW card may be
      // requested, because it could compete with an alarm this pass cannot see.
      // Existing surfaces were already refreshed above and are left untouched.
      guard enabled, alarmStateReadable else {
        failures.append(item.taskId)
        continue
      }

      do {
        let activity = try Activity.request(
          attributes: OverdueTaskActivityAttributes(taskId: item.taskId),
          content: activityContent(due: item.due, title: title, scope: scope,
                                   updatedAt: item.updatedAt, stopped: stopped,
                                   occurrenceKey: item.occurrenceKey,
                                   seriesId: item.seriesId),
          pushType: nil)
        index[activity.id] = activityRecord(item.taskId, due: due, scope: scope)
        known[surface] = (activity.id, item.taskId, due, scope)
        if stopped, let alarmId = record?.key {
          // The claimed Stop really reached the screen now.
          TaskAlarmLifecycleStore.markAttempt(alarmId: alarmId)
        }
        created += 1
      } catch {
        // The occurrence is reported honestly. The surface is silent by design,
        // so a refused request is never answered with an audible fallback that
        // would duplicate the alarm path.
        failures.append(item.taskId)
      }
    }

    suppressed = suppressed.filter {
      $0.value >= now - OverdueActivity.suppressionLifetime
    }
    UserDefaults.standard.set(index, forKey: OverdueActivity.indexKey)
    UserDefaults.standard.set(suppressed, forKey: OverdueActivity.suppressedKey)
    // Records whose occurrence this pass no longer wants (completed, deleted,
    // rescheduled, Urgent off) are dropped once they are too old to be
    // re-surfaced; a still-relevant occurrence keeps its durable stopped state.
    let staleBefore = now - overdueSurfaceLifetime
    TaskAlarmLifecycleStore.remove(alarmIds: lifecycles.compactMap { alarmId, record in
      guard !desiredKeys.contains(surfaceKey(record.taskId, due: record.due)),
            record.due < staleBefore else { return nil }
      return alarmId
    })

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
    // leave a stale marker behind. The durable stopped state belongs to the
    // same teardown: logout, an account change or Urgent being switched off
    // must not leave one account's stopped occurrence for the next one.
    UserDefaults.standard.removeObject(forKey: OverdueActivity.indexKey)
    UserDefaults.standard.removeObject(forKey: OverdueActivity.suppressedKey)
    TaskAlarmLifecycleStore.removeAll()
    return ["status": areOverdueActivitiesEnabled ? "authorized" : "denied",
            "ended": ended]
  }
}
#endif
