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

/// Surfaces shared between the app target and the NotesWidget extension target.
///
/// AlarmKit hands the widget extension the same `AlarmAttributes` the app used to
/// schedule the alarm, and a Live Activity view must agree with the app on the
/// attributes' Codable shape, so everything in this file is compiled into both
/// binaries. It therefore must stay free of React Native and other app-only
/// imports. See `docs/urgent-reminders-architecture.md`.

// AlarmKit/ActivityKit import on Mac Catalyst but their types are unavailable there.
#if canImport(ActivityKit) && !targetEnvironment(macCatalyst)
import ActivityKit
#endif

import AppIntents
import Foundation

// MARK: - Native operation gate

/// One process-wide async gate that serializes every whole native Task-alarm
/// mutation: the Stop intent's stop/claim/card request and the host module's
/// replace, cancel, cancelAll, sync and end passes. All of them run in the
/// same app process, and AlarmKit/Live Activity surfaces are not serialized by
/// the stores' per-file locks -- two passes that each suspend at an await would
/// interleave, both could snapshot "no card" and then each create one.
///
/// An actor alone is reentrant, so the gate also chains each operation behind
/// the previous one's completion. No lock is ever held across an `await`; the
/// stores' own NSLocks stay local to their synchronous file reads and writes,
/// and a gated operation never calls another gated operation.
actor TaskAlarmOperationGate {
  static let shared = TaskAlarmOperationGate()
  private var tail: Task<Void, Never>?
  private var generation: UInt64 = 0

  /// Runs `operation` after every operation already queued has finished.
  func run<T>(_ operation: @escaping () async throws -> T) async throws -> T {
    generation &+= 1
    let mine = generation
    let previous = tail
    let current = Task<T, Error> {
      await previous?.value
      return try await operation()
    }
    tail = Task { _ = try? await current.value }
    // Release the chain once the last queued operation is done, so finished
    // passes are not retained for the rest of the app session.
    Task { [weak self] in
      _ = try? await current.value
      await self?.release(generation: mine)
    }
    return try await current.value
  }

  private func release(generation: UInt64) {
    if self.generation == generation { tail = nil }
  }
}

// MARK: - Prepublished alarm identity

/// The minimal, non-content identity of one Urgent alarm this app scheduled.
///
/// A Stop tap runs inside the app process through a `LiveActivityIntent`, but it
/// must not open the encrypted Task domain or ask the host JavaScript to answer
/// within its short budget, so the few facts a Stop needs are *prepublished* at
/// schedule time: the occurrence instant, the optional occurrence/series
/// identity, the Task revision and the opaque account scope. Task titles, List
/// names and account ids never enter this store -- only the App Lock placeholder
/// (which is derived from the occurrence time, not from user content).
///
/// Every field is optional or has a legacy-compatible default: an identity
/// written by an older build still decodes, and an alarm with no identity at all
/// simply leaves no stopped card.
struct TaskAlarmIdentity: Codable {
  let taskId: String
  /// Occurrence instant, seconds since the epoch.
  let due: TimeInterval
  var occurrenceKey: String?
  var seriesId: String?
  var updatedAt: Int?
  /// The opaque `taskWidgetAccountScope` token; the same identity the widget
  /// snapshot and the overdue Live Activity are keyed by.
  var scope: String?
  /// The App Lock placeholder, e.g. "Urgent Task due (13:20)". Never user
  /// content.
  var redactedTitle: String?
}

/// A small, bounded, file-protected App Group store of prepublished alarm
/// identities, keyed by the alarm's UUID string.
///
/// It is deliberately tiny and non-identifying: it exists so a Stop tap can
/// leave a generic "stopped" card behind without the host running. It is
/// bounded (oldest identities are dropped), validated on every read (a
/// hand-edited file can only ever yield valid ids and instants), excluded from
/// backup and protected, and every access is serialized by one lock.
enum TaskAlarmIdentityStore {
  static let folder = "task-alarm-identities-v1"
  static let maximumEntries = 64
  private static let lock = NSLock()

  private static func fileURL() throws -> URL {
    guard let group = Bundle.main.object(forInfoDictionaryKey: "appGroupId") as? String,
          let container = FileManager.default.containerURL(
            forSecurityApplicationGroupIdentifier: group) else {
      throw CocoaError(.fileNoSuchFile)
    }
    return container
      .appendingPathComponent(folder, isDirectory: true)
      .appendingPathComponent("identities.json")
  }

  private static func isValid(_ identity: TaskAlarmIdentity) -> Bool {
    guard identity.taskId.range(
      of: "^(?:[0-9a-f]{24}|[0-9a-f]{32})$", options: .regularExpression) != nil,
      identity.due.isFinite, identity.due > 0
    else { return false }
    if let updatedAt = identity.updatedAt, updatedAt <= 0 { return false }
    if let scope = identity.scope,
       scope.range(of: "^[0-9a-f]{32}$", options: .regularExpression) == nil {
      return false
    }
    if let occurrenceKey = identity.occurrenceKey,
       occurrenceKey.range(of: "^[0-9A-Za-z:+-]{1,64}$",
                           options: .regularExpression) == nil {
      return false
    }
    if let seriesId = identity.seriesId,
       seriesId.range(of: "^[0-9A-Za-z:_-]{1,64}$",
                      options: .regularExpression) == nil {
      return false
    }
    return true
  }

  /// Reads the whole store. A damaged or unreadable file is treated as empty --
  /// never as an instruction -- and is not rewritten here.
  static func all() -> [String: TaskAlarmIdentity] {
    lock.lock()
    defer { lock.unlock() }
    return readUnlocked()
  }

  private static func readUnlocked() -> [String: TaskAlarmIdentity] {
    guard let url = try? fileURL(),
          let data = try? Data(contentsOf: url),
          let decoded = try? JSONDecoder().decode([String: TaskAlarmIdentity].self,
                                                  from: data)
    else { return [:] }
    return decoded.filter { UUID(uuidString: $0.key) != nil && isValid($0.value) }
  }

  /// Writes the whole store, throwing when it could not be persisted. The file
  /// protection class is applied by the atomic write itself (and the directory
  /// is created protected first), so a new file never exists for even an
  /// instant with the default protection class.
  private static func writeUnlocked(_ identities: [String: TaskAlarmIdentity]) throws {
    let url = try fileURL()
    let manager = FileManager.default
    try manager.createDirectory(
      at: url.deletingLastPathComponent(), withIntermediateDirectories: true,
      attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
    let data = try JSONEncoder().encode(identities)
    try data.write(to: url, options: [.atomic,
      .completeFileProtectionUntilFirstUserAuthentication])
    var resourceValues = URLResourceValues()
    resourceValues.isExcludedFromBackup = true
    var mutableURL = url
    try? mutableURL.setResourceValues(resourceValues)
  }

  static func identity(alarmId: String) -> TaskAlarmIdentity? {
    guard UUID(uuidString: alarmId) != nil else { return nil }
    return all()[alarmId]
  }

  /// Adds or replaces one identity, keeping the store bounded. Past the cap the
  /// dictionary's own (unspecified) order decides which entries are dropped;
  /// the store only ever holds the app's currently owned alarms, so this is a
  /// safety net rather than an eviction policy.
  static func upsert(alarmId: String, identity: TaskAlarmIdentity) {
    guard UUID(uuidString: alarmId) != nil, isValid(identity) else { return }
    lock.lock()
    defer { lock.unlock() }
    var stored = readUnlocked()
    stored.removeValue(forKey: alarmId)
    stored[alarmId] = identity
    if stored.count > maximumEntries {
      let excess = stored.count - maximumEntries
      for key in Array(stored.keys.prefix(excess)) {
        stored.removeValue(forKey: key)
      }
    }
    try? writeUnlocked(stored)
  }

  static func remove(alarmIds: [String]) {
    guard !alarmIds.isEmpty else { return }
    lock.lock()
    defer { lock.unlock() }
    var stored = readUnlocked()
    let before = stored.count
    for alarmId in alarmIds { stored.removeValue(forKey: alarmId) }
    if stored.count != before { try? writeUnlocked(stored) }
  }

  static func removeAll() {
    lock.lock()
    defer { lock.unlock() }
    try? writeUnlocked([String: TaskAlarmIdentity]())
  }

  /// Drops identities whose alarm is no longer owned, so a later Stop tap can
  /// never address an alarm this app no longer holds (and never leaves a ghost
  /// card for one).
  static func prune(keeping ownedAlarmIds: Set<String>) {
    lock.lock()
    defer { lock.unlock() }
    let stored = readUnlocked()
    let kept = stored.filter { ownedAlarmIds.contains($0.key) }
    if kept.count != stored.count { try? writeUnlocked(kept) }
  }
}

// MARK: - Durable alarm lifecycle

/// The durable, minimal lifecycle of one Urgent alarm occurrence.
///
/// A Stop tap must leave a durable "stopped, still incomplete" fact behind
/// *before* it asks the system for a card: the extension can be killed between
/// stopping the alarm and requesting the card, and a Stop that left no trace
/// would be answered by the next reconciliation with the ordinary overdue card
/// -- resurrecting an occurrence the person already silenced. The same record
/// makes two concurrent Stop taps safe, because claiming it is the only
/// transition into the stopped state.
///
/// It carries no Task title, no List name and no account id: only the
/// occurrence identity the card itself needs, the App Lock flag the plan chose,
/// and the two markers. Titles never enter this store.
struct TaskAlarmLifecycle: Codable {
  let taskId: String
  /// Occurrence instant, seconds since the epoch.
  let due: TimeInterval
  var occurrenceKey: String?
  var seriesId: String?
  var updatedAt: Int?
  /// The opaque `taskWidgetAccountScope` token, stored before the plan runs so
  /// a card answered without the host can still match its account.
  var scope: String?
  /// Whether the presentation was planned while App Lock was on. Stored with
  /// the plan so a later reconciliation can never upgrade a redacted card to a
  /// real title merely because the app happened to run unlocked afterwards.
  var privacyHidden: Bool?
  /// Durable "this occurrence was stopped and is still incomplete".
  var stoppedAt: TimeInterval?
  /// A stopped card was successfully requested/updated. The next reconciliation
  /// must never re-create a card the person has since dismissed.
  var attemptedAt: TimeInterval?
}

/// A small, bounded, file-protected App Group store of alarm lifecycles, keyed
/// by the alarm's UUID string and serialized by one lock.
///
/// It is the single place the Stop intent (request) and the app's reconciliation
/// both read and write, so a claim, a card request and a later reconcile can
/// never disagree about whether an occurrence was stopped. Like the identity
/// store it treats a damaged file as empty -- never as an instruction.
enum TaskAlarmLifecycleStore {
  static let folder = "task-alarm-lifecycle-v1"
  static let maximumEntries = 64
  /// Two occurrence instants within this many seconds are the *same*
  /// occurrence. The JS planner and the native side both round to whole
  /// milliseconds, so an exact `==` would be fragile; every occurrence
  /// comparison in this file uses the same bound.
  static let occurrenceTolerance: TimeInterval = 0.5
  private static let lock = NSLock()

  private static func fileURL() throws -> URL {
    guard let group = Bundle.main.object(forInfoDictionaryKey: "appGroupId") as? String,
          let container = FileManager.default.containerURL(
            forSecurityApplicationGroupIdentifier: group) else {
      throw CocoaError(.fileNoSuchFile)
    }
    return container
      .appendingPathComponent(folder, isDirectory: true)
      .appendingPathComponent("lifecycle.json")
  }

  static func isValid(_ record: TaskAlarmLifecycle) -> Bool {
    guard record.taskId.range(
      of: "^(?:[0-9a-f]{24}|[0-9a-f]{32})$", options: .regularExpression) != nil,
      record.due.isFinite, record.due > 0
    else { return false }
    if let updatedAt = record.updatedAt, updatedAt <= 0 { return false }
    if let scope = record.scope,
       scope.range(of: "^[0-9a-f]{32}$", options: .regularExpression) == nil {
      return false
    }
    if let occurrenceKey = record.occurrenceKey,
       occurrenceKey.range(of: "^[0-9A-Za-z:+-]{1,64}$",
                           options: .regularExpression) == nil {
      return false
    }
    if let seriesId = record.seriesId,
       seriesId.range(of: "^[0-9A-Za-z:_-]{1,64}$",
                      options: .regularExpression) == nil {
      return false
    }
    for marker in [record.stoppedAt, record.attemptedAt] {
      if let marker, !marker.isFinite || marker <= 0 { return false }
    }
    return true
  }

  static func all() -> [String: TaskAlarmLifecycle] {
    lock.lock()
    defer { lock.unlock() }
    return readUnlocked()
  }

  private static func readUnlocked() -> [String: TaskAlarmLifecycle] {
    guard let url = try? fileURL(),
          let data = try? Data(contentsOf: url),
          let decoded = try? JSONDecoder().decode([String: TaskAlarmLifecycle].self,
                                                  from: data)
    else { return [:] }
    return decoded.filter { UUID(uuidString: $0.key) != nil && isValid($0.value) }
  }

  private static func trimUnlocked(_ stored: inout [String: TaskAlarmLifecycle]) {
    guard stored.count > maximumEntries else { return }
    // Oldest first: a record knows when it was last touched, and a record that
    // was never touched is ordered by its occurrence instant.
    let ordered = stored.sorted {
      ($0.value.attemptedAt ?? $0.value.stoppedAt ?? $0.value.due)
        < ($1.value.attemptedAt ?? $1.value.stoppedAt ?? $1.value.due)
    }
    for (key, _) in ordered.prefix(stored.count - maximumEntries) {
      stored.removeValue(forKey: key)
    }
  }

  /// Writes the whole store, throwing when it could not be persisted. The file
  /// protection class is applied by the atomic write itself (and the directory
  /// is created protected first), so a new file never exists for even an
  /// instant with the default protection class.
  private static func writeUnlocked(_ stored: [String: TaskAlarmLifecycle]) throws {
    let url = try fileURL()
    let manager = FileManager.default
    try manager.createDirectory(
      at: url.deletingLastPathComponent(), withIntermediateDirectories: true,
      attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
    let data = try JSONEncoder().encode(stored)
    try data.write(to: url, options: [.atomic,
      .completeFileProtectionUntilFirstUserAuthentication])
    var resourceValues = URLResourceValues()
    resourceValues.isExcludedFromBackup = true
    var mutableURL = url
    try? mutableURL.setResourceValues(resourceValues)
  }

  /// The record of one alarm id. A legacy alarm (scheduled before this store
  /// existed) has only the prepublished identity; it is adopted on demand so an
  /// upgrade never loses a Stop that is already on screen.
  static func record(alarmId: String) -> TaskAlarmLifecycle? {
    guard UUID(uuidString: alarmId) != nil else { return nil }
    lock.lock()
    defer { lock.unlock() }
    if let existing = readUnlocked()[alarmId] { return existing }
    return legacyRecord(alarmId: alarmId)
  }

  private static func legacyRecord(alarmId: String) -> TaskAlarmLifecycle? {
    guard let identity = TaskAlarmIdentityStore.identity(alarmId: alarmId) else {
      return nil
    }
    return TaskAlarmLifecycle(taskId: identity.taskId, due: identity.due,
                              occurrenceKey: identity.occurrenceKey,
                              seriesId: identity.seriesId,
                              updatedAt: identity.updatedAt,
                              scope: identity.scope,
                              privacyHidden: identity.redactedTitle != nil)
  }

  /// Adds or replaces a record (used when an alarm is scheduled, so scope and
  /// the privacy decision are stored with the plan). The previous record's
  /// durable markers survive only when it names the *same* occurrence -- see
  /// `merging` -- so a rescheduled occurrence never inherits an old Stop.
  static func upsert(alarmId: String, record: TaskAlarmLifecycle) {
    guard UUID(uuidString: alarmId) != nil, isValid(record) else { return }
    lock.lock()
    defer { lock.unlock() }
    var stored = readUnlocked()
    let previous = stored[alarmId] ?? legacyRecord(alarmId: alarmId)
    stored[alarmId] = merging(previous: previous, into: record)
    trimUnlocked(&stored)
    try? writeUnlocked(stored)
  }

  /// Whether two records describe the same occurrence.
  ///
  /// The alarm id an occurrence is keyed by is `TaskAlarmModule.alarmId`:
  /// SHA-256 of the signed-in account and the occurrence's `alarmKey`. A
  /// recurring key carries the occurrence, so sibling occurrences get different
  /// ids; a one-off key is only `task:<id>` with no instant, so a *rescheduled*
  /// one-off reuses the same id -- this predicate, not the id, is what tells the
  /// occurrences apart. Two records are the same occurrence only when the Task
  /// ids are equal, the due instants agree within `occurrenceTolerance`, and --
  /// when *both* sides know them -- the account scope and the occurrence/series
  /// identity agree. A missing optional field on either side is
  /// legacy-compatible and matches on that dimension, exactly like the
  /// Stop/adoption matching elsewhere.
  static func sameOccurrence(_ previous: TaskAlarmLifecycle,
                             as next: TaskAlarmLifecycle) -> Bool {
    guard previous.taskId == next.taskId,
          abs(previous.due - next.due) < occurrenceTolerance else { return false }
    if let a = previous.scope, let b = next.scope, a != b { return false }
    if let a = previous.occurrenceKey, let b = next.occurrenceKey, a != b {
      return false
    }
    if let a = previous.seriesId, let b = next.seriesId, a != b { return false }
    return true
  }

  /// Merges a freshly planned record with the durable markers the **same**
  /// occurrence already carried, and repairs an already-corrupted one.
  ///
  /// Copying the previous markers by alarm id alone would carry an old
  /// occurrence's `stoppedAt`/`attemptedAt` onto a new due -- and a stale
  /// "stopped" marker makes the person's next Stop a no-op. Markers therefore
  /// carry over only for the same occurrence (see `sameOccurrence`). A
  /// same-occurrence revision or title edit preserves them, which is what keeps
  /// a re-planned, still-stopped occurrence stopped.
  ///
  /// Repair: a Stop can only happen once its occurrence is due and presenting,
  /// so a `stoppedAt` *earlier* than the record's own due (beyond the normal
  /// tolerance) cannot describe this occurrence -- e.g. the old 08:35 marker
  /// copied onto a rescheduled 08:49 occurrence by an earlier build. Such a
  /// marker is dropped rather than carried forward, and `attemptedAt` goes with
  /// it because an attempt only ever follows a real stop.
  static func merging(previous: TaskAlarmLifecycle?,
                      into record: TaskAlarmLifecycle) -> TaskAlarmLifecycle {
    guard let previous, sameOccurrence(previous, as: record) else { return record }
    var merged = record
    if let stoppedAt = previous.stoppedAt,
       stoppedAt >= record.due - occurrenceTolerance {
      merged.stoppedAt = stoppedAt
      if let attemptedAt = previous.attemptedAt,
         attemptedAt.isFinite, attemptedAt > 0 {
        merged.attemptedAt = attemptedAt
      }
    }
    return merged
  }

  /// Atomically claims the stopped card of one alarm. Returns the claimed
  /// record exactly once: a second (possibly concurrent) Stop finds the marker
  /// and does nothing, so two taps can never stack two cards. The stopped state
  /// is durable even if the process dies before the card is requested.
  /// The pure transition of one Stop claim, factored out of `claimStopped` so
  /// the "claim exactly once" guarantee is testable without the App Group file.
  ///
  /// It returns `nil` when the occurrence has no plan at all (this app never
  /// scheduled it, so a Stop may silence it but may not leave a card naming it)
  /// or when it was already claimed. A second, possibly-concurrent Stop
  /// therefore finds the marker and returns `nil`, which is exactly what makes
  /// two taps unable to stack two cards.
  static func claimingStop(_ plan: TaskAlarmLifecycle?,
                           at now: TimeInterval) -> TaskAlarmLifecycle? {
    guard now.isFinite, now > 0,
          var record = plan, record.stoppedAt == nil else { return nil }
    record.stoppedAt = now
    return record
  }

  /// Whether a Stop tap may claim (and thus card) the occurrence `plan`
  /// describes. A Stop is only ever offered once the occurrence is due and
  /// presenting, so a plan whose occurrence is still in the future is never
  /// claimed: a one-off Task's alarm id is reused across a reschedule, and a
  /// stale Stop naming that id would otherwise card (and stop) the *next*
  /// occurrence. Pure, so the rule is testable without AlarmKit or the App
  /// Group.
  static func stopMayClaimOccurrence(_ plan: TaskAlarmLifecycle,
                                     at now: TimeInterval) -> Bool {
    guard now.isFinite, now > 0 else { return false }
    return plan.due <= now + occurrenceTolerance
  }

  static func claimStopped(alarmId: String,
                           at now: TimeInterval = Date().timeIntervalSince1970) -> TaskAlarmLifecycle? {
    guard UUID(uuidString: alarmId) != nil else { return nil }
    lock.lock()
    defer { lock.unlock() }
    var stored = readUnlocked()
    let plan = stored[alarmId] ?? legacyRecord(alarmId: alarmId)
    guard let claimed = claimingStop(plan, at: now) else { return nil }
    stored[alarmId] = claimed
    trimUnlocked(&stored)
    // A claim is only returned once it is really durable: if the write fails,
    // the transition did not happen and the caller must not leave a card for
    // it. The record stays unclaimed, so a later Stop can retry.
    do {
      try writeUnlocked(stored)
    } catch {
      return nil
    }
    return claimed
  }

  /// Records that the card was really requested/updated. Until this is set, the
  /// app's reconciliation knows a claimed Stop may never have reached the
  /// screen and may safely try once more.
  static func markAttempt(alarmId: String,
                          at now: TimeInterval = Date().timeIntervalSince1970) {
    guard UUID(uuidString: alarmId) != nil, now.isFinite, now > 0 else { return }
    lock.lock()
    defer { lock.unlock() }
    var stored = readUnlocked()
    guard var record = stored[alarmId] else { return }
    record.attemptedAt = now
    stored[alarmId] = record
    try? writeUnlocked(stored)
  }

  static func remove(alarmIds: [String]) {
    guard !alarmIds.isEmpty else { return }
    lock.lock()
    defer { lock.unlock() }
    var stored = readUnlocked()
    let before = stored.count
    for alarmId in alarmIds { stored.removeValue(forKey: alarmId) }
    if stored.count != before { try? writeUnlocked(stored) }
  }

  static func removeAll() {
    lock.lock()
    defer { lock.unlock() }
    try? writeUnlocked([String: TaskAlarmLifecycle]())
  }

  /// Drops records whose alarm this app no longer owns, except the durable
  /// stopped state of a still-recent occurrence: that fact belongs to the Task,
  /// not to the alarm handle, and the app's reconciliation still needs it.
  static func prune(keeping ownedAlarmIds: Set<String>, now: TimeInterval = Date().timeIntervalSince1970) {
    lock.lock()
    defer { lock.unlock() }
    let stored = readUnlocked()
    let kept = stored.filter { alarmId, record in
      ownedAlarmIds.contains(alarmId) ||
        (record.stoppedAt != nil && record.due >= now - overdueSurfaceLifetime)
    }
    if kept.count != stored.count { try? writeUnlocked(kept) }
  }
}

/// How long an Urgent occurrence surface may live. Apple ends a Live Activity
/// after roughly eight hours, so an occurrence older than this is never
/// re-surfaced; the app's reconcile and the shared stores agree on one bound.
let overdueSurfaceLifetime: TimeInterval = 8 * 60 * 60

/// True when a UUID was minted by this app's own alarm namespace
/// (`TaskAlarmModule.alarmId`: a SHA-256 digest whose first five bytes are
/// "NNTAS").
///
/// These intents are `LiveActivityIntent`s, so the system runs them in the
/// app's own process (`TaskAlarmCompleteIntent` relies on exactly that); the
/// types are also compiled into the widget extension because the extension has
/// to render the same alarm/activity presentation. Even so, every one of them
/// re-checks the id it was handed instead of trusting it: the id travels as an
/// intent *parameter*, so a hand-written Shortcut or a foreign caller can name
/// anything, and an id minted by another app is always a no-op. No cross-process
/// coordination is involved -- the operation gate is process-wide because all of
/// these mutations run in the app process.
func isVeyranTaskAlarmId(_ id: UUID) -> Bool {
  let bytes = id.uuid
  return bytes.0 == 0x4e && bytes.1 == 0x4e && bytes.2 == 0x54 &&
    bytes.3 == 0x41 && bytes.4 == 0x53
}

/// The same check including the app's legacy owned-alarm bookkeeping. The app
/// target writes that key; the widget extension's standard defaults are its
/// own, so an extension-side intent can only ever vouch for the namespace.
func isVeyranOwnedTaskAlarmId(_ id: UUID) -> Bool {
  if isVeyranTaskAlarmId(id) { return true }
  let legacy = UserDefaults.standard.stringArray(
    forKey: "notesnook.taskAlarms.ownedIds.v1") ?? []
  return legacy.contains(id.uuidString)
}

#if canImport(AlarmKit) && !targetEnvironment(macCatalyst)
import AlarmKit

/// Metadata for an Urgent Task alarm. Deliberately empty: Task titles and every
/// other piece of user content stay on the app side and never reach the widget
/// extension or the system's alarm store through AlarmKit.
@available(iOS 26.0, *)
struct TaskAlarmMetadata: AlarmMetadata {}

/// The intents behind the alarm Live Activity's controls. They carry only the
/// alarm's UUID (a SHA-256-derived value, never user content) and forward the
/// tap to `AlarmManager`, so Stop/Pause/Resume keep exactly the same meaning as
/// the system alert's own buttons. Stop only silences the alert; it never
/// completes the Task.
@available(iOS 26.0, *)
struct TaskAlarmStopIntent: LiveActivityIntent {
  static var title: LocalizedStringResource = "Stop"
  static var description = IntentDescription("Silence a Task alarm.")
  // Plumbing for the alarm's own control, never a user-facing action offered by
  // Shortcuts (which already has the app's real Task actions).
  static var isDiscoverable: Bool { false }

  @Parameter(title: "alarmID")
  var alarmID: String

  init(alarmID: String) {
    self.alarmID = alarmID
  }

  init() {
    self.alarmID = ""
  }

  func perform() async throws -> some IntentResult {
    // Only a UUID this app minted in its own alarm namespace is ever addressed;
    // a foreign id (another app's alarm, a hand-written Shortcut) is a no-op.
    guard let id = UUID(uuidString: alarmID), isVeyranOwnedTaskAlarmId(id) else {
      return .result()
    }
    // The whole stop/claim/card flow runs inside the shared gate, so a
    // reconcile that is mid-pass (or a cancel/end that follows it) can never
    // interleave between the stop and the card request and stack a duplicate.
    try? await TaskAlarmOperationGate.shared.run {
      await Self.stop(id: id, alarmID: alarmID)
    }
    return .result()
  }

  private static func stop(id: UUID, alarmID: String) async {
    // The prepublished lifecycle is this app's own plan for the occurrence the
    // callback names, and it is the authority the stopped card is built from.
    // Its identity/scope/due are re-read here, at the moment of the tap, rather
    // than trusted from the callback.
    let plan = TaskAlarmLifecycleStore.record(alarmId: alarmID)
    // A Stop is only ever offered once an occurrence is due and presenting, so
    // a plan whose occurrence is still in the future is never claimed. A
    // one-off Task's alarm id (`task:<id>`) is reused across a reschedule, and
    // a stale Stop naming that reused id would otherwise stop and card a *new*,
    // future occurrence. A planless occurrence is silenced below but leaves no
    // card.
    let mayClaim = plan.map {
      TaskAlarmLifecycleStore.stopMayClaimOccurrence(
        $0, at: Date().timeIntervalSince1970)
    } ?? false
    let manager = AlarmManager.shared
    let alarm: Alarm?
    do {
      // The alarm may already be gone: the system can run this Stop *after*
      // AlarmKit removed a spent one-shot alarm, so a missing alarm must never
      // short-circuit the claim and the stopped card below.
      alarm = try manager.alarms.first(where: { $0.id == id })
    } catch {
      // The presentation's state cannot be read, so it cannot be confirmed
      // stopped. Nothing is claimed and no card is left: the durable record
      // stays pending, and a later Stop or reconciliation retries.
      return
    }
    if let alarm {
      // `.scheduled` has not alerted, so the system never offered a Stop for
      // it; because the id is reused across a one-off reschedule, a Stop that
      // names it now is stale and must never silence a pending alarm.
      guard alarm.state != .scheduled else { return }
      // The call the presentation's own state asks for. `.alerting` is silenced
      // in place; a legacy countdown/paused alarm is cancelled.
      do {
        if alarm.state == .alerting {
          try manager.stop(id: id)
        } else {
          try manager.cancel(id: id)
        }
      } catch {
        // Fall through to verification below: a failed call is not evidence
        // either way.
      }
      // `stop`/`cancel` returning is not proof the alarm is gone. Re-enumerate
      // the system's own list; an unreadable list means "cannot confirm gone",
      // so nothing is claimed and no card is left. A stopped card for an alarm
      // the system still holds would be a forbidden competing surface.
      guard let remaining = try? manager.alarms,
            !remaining.contains(where: { $0.id == id }) else { return }
    }
    // Confirmed gone: silenced now, or already removed by the system.
    // Durable first: the stopped state is written *before* the card is
    // requested, so a crash between the two is recovered by the next
    // reconciliation instead of resurrecting the occurrence as an ordinary
    // overdue card. The claim is atomic, idempotent and only reported once it
    // is really persisted, so a concurrent second Stop can never stack a
    // second card and a failed write leaves no card. An occurrence this app
    // never planned has no identity to name, so it is silenced above but
    // leaves no card.
    guard mayClaim,
          let claim = TaskAlarmLifecycleStore.claimStopped(alarmId: alarmID) else {
      return
    }
    // Revalidate immediately before the request: a reconcile that completed or
    // revoked the occurrence between the read and the claim must never get a
    // resurrected card for it.
    guard TaskAlarmLifecycleStore.record(alarmId: alarmID) != nil else {
      return
    }
    // The prepublished identity is deliberately *not* removed here: it is what
    // a later reconciliation (and the prune against the alarms this app still
    // owns) uses to tell a stopped occurrence from one that simply vanished.
    await Self.presentStoppedCard(claim, alarmId: alarmID)
  }

  /// Leaves the silent "stopped, still incomplete" card behind.
  ///
  /// The card a Stop tap creates is *always* labelled with the neutral
  /// placeholder. A Stop runs without the host, so the only "current" App Lock
  /// fact available here is the plan-time `privacyHidden` flag plus whatever the
  /// App Group snapshot happens to hold -- and a snapshot is a stale projection
  /// that may predate App Lock being turned on. Neither can *guarantee* the lock
  /// state right now, so publishing a real Task title from them would be a
  /// privacy decision taken on unverified data. The title is therefore
  /// conditional by design: neutral on the card the tap itself leaves, and the
  /// ordinary app reconciliation (which does know the current, hydrated App Lock
  /// state) may later publish the approved title for the same card. That is a
  /// deliberate, conservative ordering -- never a claim that App Lock hid a
  /// title it did not, and never a real title shown because a stale snapshot
  /// happened to agree. No title is persisted here, and the card never re-arms
  /// the alarm on a past instant.
  private static func presentStoppedCard(_ claim: TaskAlarmLifecycle,
                                        alarmId: String) async {
    #if canImport(ActivityKit) && !targetEnvironment(macCatalyst)
    guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
    let due = Date(timeIntervalSince1970: claim.due)
    let content = ActivityContent(
      state: OverdueTaskActivityAttributes.ContentState(
        dueDate: due,
        title: OverdueTaskActivityAttributes.redactedTitle,
        stopped: true,
        scope: claim.scope,
        updatedAt: claim.updatedAt,
        occurrenceKey: claim.occurrenceKey,
        seriesId: claim.seriesId),
      staleDate: due.addingTimeInterval(overdueSurfaceLifetime))
    // Crash recovery and duplicate safety: enumerate this app's cards first and
    // adopt the occurrence's own card instead of stacking a second one. A card
    // of a *different* occurrence of the same Task is stale for this occurrence
    // and is ended, exactly as an overwritten occurrence's card would be.
    let live = Activity<OverdueTaskActivityAttributes>.activities.filter {
      $0.activityState != .ended && $0.activityState != .dismissed
    }
    if let existing = live.first(where: {
      OverdueTaskActivityAttributes.matches($0, taskId: claim.taskId,
        due: claim.due, scope: claim.scope, occurrenceKey: claim.occurrenceKey)
    }) {
      await existing.update(content)
      TaskAlarmLifecycleStore.markAttempt(alarmId: alarmId)
      return
    }
    for stale in live where stale.attributes.taskId == claim.taskId {
      await stale.end(nil, dismissalPolicy: .immediate)
    }
    do {
      _ = try Activity.request(
        attributes: OverdueTaskActivityAttributes(taskId: claim.taskId),
        content: content,
        pushType: nil)
      // The attempt marker is only set once the system really holds the card, so
      // a refused request stays honest and the app's next reconciliation may
      // safely try once more.
      TaskAlarmLifecycleStore.markAttempt(alarmId: alarmId)
    } catch {
      // Not retried here: the occurrence keeps its durable stopped state and the
      // app answers for it on the next pass.
    }
    #endif
  }
}

@available(iOS 26.0, *)
struct TaskAlarmPauseIntent: LiveActivityIntent {
  static var title: LocalizedStringResource = "Pause"
  static var description = IntentDescription("Pause a Task alarm countdown.")
  static var isDiscoverable: Bool { false }

  @Parameter(title: "alarmID")
  var alarmID: String

  init(alarmID: String) {
    self.alarmID = alarmID
  }

  init() {
    self.alarmID = ""
  }

  func perform() throws -> some IntentResult {
    guard let id = UUID(uuidString: alarmID), isVeyranOwnedTaskAlarmId(id) else {
      return .result()
    }
    try AlarmManager.shared.pause(id: id)
    return .result()
  }
}

@available(iOS 26.0, *)
struct TaskAlarmResumeIntent: LiveActivityIntent {
  static var title: LocalizedStringResource = "Resume"
  static var description = IntentDescription("Resume a paused Task alarm.")
  static var isDiscoverable: Bool { false }

  @Parameter(title: "alarmID")
  var alarmID: String

  init(alarmID: String) {
    self.alarmID = alarmID
  }

  init() {
    self.alarmID = ""
  }

  func perform() throws -> some IntentResult {
    guard let id = UUID(uuidString: alarmID), isVeyranOwnedTaskAlarmId(id) else {
      return .result()
    }
    try AlarmManager.shared.resume(id: id)
    return .result()
  }
}

/// Snooze. The system runs this when somebody taps the alert's secondary button;
/// it starts a countdown (the `CountdownDuration.postAlert` interval) and then
/// re-alerts. The Task's own reminder occurrence is never modified.
@available(iOS 26.0, *)
struct TaskAlarmRepeatIntent: LiveActivityIntent {
  static var title: LocalizedStringResource = "Snooze"
  static var description = IntentDescription("Postpone the next Task alert.")
  static var isDiscoverable: Bool { false }

  @Parameter(title: "alarmID")
  var alarmID: String

  init(alarmID: String) {
    self.alarmID = alarmID
  }

  init() {
    self.alarmID = ""
  }

  func perform() throws -> some IntentResult {
    guard let id = UUID(uuidString: alarmID), isVeyranOwnedTaskAlarmId(id) else {
      return .result()
    }
    try AlarmManager.shared.countdown(id: id)
    return .result()
  }
}
#endif

#if canImport(ActivityKit) && !targetEnvironment(macCatalyst)
/// Attributes for the "Task is overdue and still incomplete" Live Activity.
///
/// Only the opaque Task id is static. The Task title lives in `ContentState` so
/// an App Lock change (which swaps the title for its redacted placeholder) can
/// update the existing activity instead of ending and recreating it. The title
/// is already redacted by the app before it is handed over.
@available(iOS 16.2, *)
struct OverdueTaskActivityAttributes: ActivityAttributes {
  struct ContentState: Codable, Hashable {
    /// The local instant the Task's reminder was due. The card renders this as
    /// a plain, static time -- never a running counter -- so nothing on screen
    /// implies an unattended process is still ticking.
    var dueDate: Date
    /// Task title, redacted by the app whenever App Lock is enabled. It is
    /// always the host's approved title (or the neutral placeholder); the card
    /// never derives, guesses or persists one.
    var title: String
    /// `true` for the generic card an Urgent alarm leaves behind after Stop.
    /// Optional so a card encoded by an older build still decodes, and so the
    /// ordinary overdue path (which never sets it) is unchanged.
    var stopped: Bool?
    /// The opaque account scope and Task revision the card was built from, so a
    /// completion can be validated against the app's own approved snapshot.
    /// Both are optional: a card (or a build) that does not know them offers no
    /// completion at all.
    var scope: String?
    var updatedAt: Int?
    /// The occurrence's own stable key and series, so a tap can be answered by
    /// exactly the occurrence the card describes -- never a sibling occurrence.
    /// Optional: cards written before these fields existed still decode.
    var occurrenceKey: String?
    var seriesId: String?

    init(dueDate: Date, title: String, stopped: Bool? = nil,
         scope: String? = nil, updatedAt: Int? = nil,
         occurrenceKey: String? = nil, seriesId: String? = nil) {
      self.dueDate = dueDate
      self.title = title
      self.stopped = stopped
      self.scope = scope
      self.updatedAt = updatedAt
      self.occurrenceKey = occurrenceKey
      self.seriesId = seriesId
    }

    /// Explicit decoding, because this state is persisted by the system and
    /// written by whichever build created the card. Every field added after the
    /// first release is decoded with `decodeIfPresent`, so a card from an older
    /// build decodes with those fields absent instead of failing the whole
    /// state; a state whose occurrence instant is missing or not a real instant
    /// is refused rather than rendered.
    init(from decoder: Decoder) throws {
      let container = try decoder.container(keyedBy: CodingKeys.self)
      let due = try container.decode(Date.self, forKey: .dueDate)
      guard due.timeIntervalSince1970.isFinite,
            due.timeIntervalSince1970 > 0 else {
        throw DecodingError.dataCorruptedError(
          forKey: .dueDate, in: container,
          debugDescription: "Task occurrence instant is not a real instant.")
      }
      self.dueDate = due
      self.title = try container.decodeIfPresent(String.self, forKey: .title)
        ?? Self.neutralTitle
      self.stopped = try container.decodeIfPresent(Bool.self, forKey: .stopped)
      self.scope = try container.decodeIfPresent(String.self, forKey: .scope)
      self.updatedAt = try container.decodeIfPresent(Int.self, forKey: .updatedAt)
      self.occurrenceKey = try container.decodeIfPresent(String.self,
                                                         forKey: .occurrenceKey)
      self.seriesId = try container.decodeIfPresent(String.self, forKey: .seriesId)
    }

    static let neutralTitle = "VeyraN Task"
  }

  /// Opaque Task database id: used to route a tap back to the Task's List and
  /// to correlate the activity with its Task. Never user content.
  var taskId: String

  /// The App Lock placeholder and the system's Live Activity lifetime, shared
  /// with the app so the stopped card is created with the same neutral text and
  /// never outlives an ordinary overdue surface.
  static let redactedTitle = "VeyraN Task"
  static let lifetime: TimeInterval = overdueSurfaceLifetime

  /// Whether one live card is the surface of this exact occurrence. Matching
  /// uses the whole occurrence identity -- Task, due instant and, when both
  /// sides know them, account scope and occurrence key -- so a sibling
  /// occurrence's card is never mistaken for this one and a card from another
  /// account is never adopted.
  static func matches(_ activity: Activity<OverdueTaskActivityAttributes>,
                      taskId: String, due: TimeInterval,
                      scope: String?, occurrenceKey: String?) -> Bool {
    guard activity.attributes.taskId == taskId else { return false }
    let state = activity.content.state
    guard abs(state.dueDate.timeIntervalSince1970 - due) < 0.5 else { return false }
    if let scope, let cardScope = state.scope, cardScope != scope { return false }
    if let occurrenceKey, let cardKey = state.occurrenceKey, cardKey != occurrenceKey {
      return false
    }
    return true
  }
}

/// Completion of an overdue occurrence from a card's control.
///
/// The overdue Lock Screen card and its expanded Dynamic Island render the
/// round, tappable completion control this intent backs, alongside the
/// Reschedule link; the general card tap still opens the Task. It is a
/// `LiveActivityIntent`, so the system runs it in the app's process -- the one
/// place the encrypted Task domain can be committed.
///
/// A completion is only accepted for the exact occurrence the card describes:
/// the app's own approved snapshot must name the Task with the same revision,
/// account scope and due instant, and the commit itself goes through the widget
/// ring's durable queue and the host's `completeIfUnchanged` pipeline. A card
/// whose occurrence is not materialized (a future instance of a recurring
/// Task, or a Task that moved on) fails safely instead of completing a
/// different occurrence of the same Task.
@available(iOS 17.0, *)
struct TaskAlarmCompleteIntent: LiveActivityIntent {
  static var title: LocalizedStringResource = "Complete Task"
  static var description = IntentDescription("Complete an overdue Task.")
  static var openAppWhenRun: Bool { false }
  static var isDiscoverable: Bool { false }

  @Parameter(title: "Task") var id: String
  @Parameter(title: "Account Scope") var scope: String
  @Parameter(title: "Task Revision") var updatedAt: Int
  /// The occurrence instant the card describes, seconds since the epoch. `0`
  /// means a card written before the field existed; such a card was only ever
  /// created for the occurrence that was current at the time.
  @Parameter(title: "Due") var due: Double

  init(id: String, scope: String, updatedAt: Int, due: Double = 0) {
    self.id = id
    self.scope = scope
    self.updatedAt = updatedAt
    self.due = due
  }

  init() {
    self.id = ""
    self.scope = ""
    self.updatedAt = 0
    self.due = 0
  }

  func perform() async throws -> some IntentResult {
    guard id.range(of: "^(?:[0-9a-f]{24}|[0-9a-f]{32})$",
                   options: .regularExpression) != nil,
          scope.range(of: "^[0-9a-f]{32}$", options: .regularExpression) != nil,
          updatedAt > 0, due.isFinite, due >= 0
    else { return .result() }
    // Strict: only the app's own approved snapshot -- written by the host from
    // the persisted Task, and never by this process -- can approve a
    // completion, and it must agree on the occurrence instant too when the card
    // carried one. Nothing is completed on a snapshot that merely has the Task.
    guard snapshotListsTask(id: id, scope: scope, updatedAt: updatedAt,
                            due: due > 0 ? due : nil, at: Date()) else {
      throw TaskWidgetCompletionFailure.stale
    }
    // Durable first: a crash anywhere after this leaves an action the host will
    // still finish, and a repeat tap finds the same deterministic file.
    try WidgetCompletionQueue.enqueue(id: id, scope: scope, updatedAt: updatedAt)
    guard let host = NSClassFromString("TaskWidgetCompletionBridge")
            as? TaskWidgetCompletionCommitting.Type else {
      // No host in this process. The action stays queued; never claim success.
      throw TaskWidgetCompletionFailure.unavailable
    }
    let outcome = await host.commitWidgetCompletion(
      taskId: id,
      scope: scope,
      updatedAt: updatedAt,
      filename: WidgetCompletionQueue.filename(id: id, scope: scope, updatedAt: updatedAt))
    if let failure = TaskWidgetCompletionFailure.from(outcome) { throw failure }
    return .result()
  }
}
#endif
